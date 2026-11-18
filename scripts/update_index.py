#!/usr/bin/env python3
"""Archivio append-only dell'indice di ogni collezione.

Ogni collezione in data/collections.json è trattata come un indice: una riga
al giorno, mai riscritta. Le carte segnate come acquistate restano nel calcolo.
L'acquisto è solo un filtro dell'app e questo script non legge purchases.json.

  python3 scripts/update_index.py

La riga di un giorno si scrive solo se esiste lo snapshot history/YYYY-MM-DD.json
(dal 2026-11-10). Un prezzo mancante resta vuoto: niente riporto e niente zero
inventato. Se lo snapshot non ha il prezzo e TCGNotify ha un minimo proprio quel
giorno, si usa quel minimo (CardTrader, altrimenti Cardmarket).

index_value_eur è la somma dei prezzi unitari. index_base100 parte da 100 il
primo giorno e da lì si muove solo con il rendimento delle carte presenti in
entrambi i giorni. Il divisor assorbe le carte aggiunte o tolte, così il livello
non salta quando cambia la composizione. link_factor è divisor_oggi / divisor_ieri.

volume, ct_it e cm_it sommano solo le carte in italiano. volume è la somma dei
total (CT+CM) già presenti in pop_history: se una carta non ha il totale, non
entra e non viene completata. ct_it e cm_it sono le somme dei valori presenti.
"""
from __future__ import annotations

import csv
import json
import os
from datetime import datetime, timedelta, timezone

try:
    from zoneinfo import ZoneInfo
    TZ = ZoneInfo("Europe/Rome")
except Exception:  # pragma: no cover
    TZ = timezone(timedelta(hours=1))

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, "data")
REAL_FROM = "2026-11-10"
FIELDS = [
    "date", "n_cards", "n_priced", "index_value_eur", "index_base100",
    "divisor", "link_factor", "daily_return_pct",
    "volume", "ct_it", "cm_it", "n_pop", "constituents",
]
HORIZONS = (
    ("1G", 1),
    ("7G", 7),
    ("30G", 30),
    ("90G", 90),
    ("1Y", 365),
)


def load_json(path):
    if not os.path.exists(path):
        return None
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def collection_dir(meta):
    history = meta.get("history") or "history/index.json"
    hist_dir = os.path.join(DATA, os.path.dirname(history))
    parent = os.path.dirname(hist_dir)
    return parent or DATA


def num(value):
    return float(value) if isinstance(value, (int, float)) else None


def cell(value, places):
    if value is None:
        return ""
    return f"{value:.{places}f}"


def parse_num(text):
    if text is None or str(text).strip() == "":
        return None
    try:
        return float(text)
    except ValueError:
        return None


def notify_price(series, day):
    """Minimo TCGNotify di quel giorno esatto. Nessun riporto dai giorni vicini."""
    if not isinstance(series, dict):
        return None, None
    for key, source in (("cardtrader", "tcgnotify_ct"), ("cardmarket", "tcgnotify_cm")):
        for point in series.get(key) or []:
            if not isinstance(point, dict) or str(point.get("date") or "")[:10] != day:
                continue
            value = num(point.get("min"))
            if value is not None and value > 0:
                return value, source
    return None, None


def pop_point(series, day):
    if not isinstance(series, list):
        return None
    for point in series:
        if isinstance(point, dict) and str(point.get("date") or "")[:10] == day:
            return point
    return None


def is_italian(card):
    lang = str(card.get("target_language") or "it").lower()
    return lang not in ("en", "jp", "ja")


def constituents_for(cards, day, pop, notify):
    rows = []
    for card in cards:
        cid = card.get("id")
        if not cid:
            continue
        price = num(card.get("price_final_eur"))
        source = card.get("price_final_source") if price is not None else None
        if price is None:
            price = num(card.get("buy_price_eur"))
            if price is not None:
                source = card.get("buy_price_source") or card.get("price_final_source")
        if price is None:
            price, source = notify_price(notify.get(cid), day)
        point = pop_point(pop.get(cid), day) or {}
        ct = num(point.get("ct_it"))
        cm = num(point.get("cm_it"))
        total = num(point.get("total"))
        rows.append({
            "id": cid,
            "price": None if price is None else round(price, 2),
            "source": source or None,
            "pop": None if total is None else round(total, 2),
            "ct_it": None if ct is None else round(ct, 2),
            "cm_it": None if cm is None else round(cm, 2),
            "condition": card.get("price_condition") or None,
            "ita": is_italian(card),
        })
    rows.sort(key=lambda row: row["id"])
    return rows


def public_constituents(rows):
    return [
        {
            "id": row["id"],
            "price": row["price"],
            "source": row["source"],
            "pop": row["pop"],
            "ct_it": row["ct_it"],
            "cm_it": row["cm_it"],
            "condition": row.get("condition"),
        }
        for row in rows
    ]


def chain(value, rows, prev):
    """Rendimento delle carte in comune. Il divisor assorbe i cambi di composizione."""
    if value is None:
        return None, None, None, None
    if prev is None:
        return 100.0, round(value / 100.0, 8), None, None
    if prev.get("index") is None or prev.get("divisor") in (None, 0):
        return None, None, None, None
    prev_rows = prev["constituents"]
    prev_px = {row["id"]: row["price"] for row in prev_rows if row.get("price") is not None}
    now_px = {row["id"]: row["price"] for row in rows if row.get("price") is not None}
    common = [cid for cid in prev_px if cid in now_px]
    base = sum(prev_px[cid] for cid in common)
    if not common or base <= 0:
        return None, None, None, None
    ratio = sum(now_px[cid] for cid in common) / base
    index = round(prev["index"] * ratio, 6)
    divisor = round(value / index, 8)
    link = round(divisor / prev["divisor"], 8)
    daily = round((index / prev["index"] - 1.0) * 100.0, 6)
    return index, divisor, link, daily


def snapshot_dates(hist_dir):
    if not os.path.isdir(hist_dir):
        return []
    found = []
    for name in os.listdir(hist_dir):
        if len(name) == 15 and name.endswith(".json") and name[:10] >= REAL_FROM and name[0].isdigit():
            found.append(name[:10])
    return sorted(found)


def read_rows(path):
    if not os.path.exists(path):
        return []
    with open(path, newline="", encoding="utf-8") as f:
        return list(csv.DictReader(f))


def prev_state(row):
    if not row:
        return None
    try:
        constituents = json.loads(row.get("constituents") or "[]")
    except json.JSONDecodeError:
        constituents = []
    return {
        "index": parse_num(row.get("index_base100")),
        "divisor": parse_num(row.get("divisor")),
        "constituents": constituents,
    }


def build_row(day, cards, pop, notify, prev):
    detailed = constituents_for(cards, day, pop, notify)
    published = public_constituents(detailed)
    prices = [row["price"] for row in detailed if row["price"] is not None]
    value = round(sum(prices), 2) if prices else None
    index, divisor, link, daily = chain(value, published, prev)
    ita = [row for row in detailed if row["ita"]]
    totals = [row["pop"] for row in ita if row["pop"] is not None]
    cts = [row["ct_it"] for row in ita if row["ct_it"] is not None]
    cms = [row["cm_it"] for row in ita if row["cm_it"] is not None]
    n_pop = sum(1 for row in ita if row["pop"] is not None or row["ct_it"] is not None or row["cm_it"] is not None)
    return {
        "date": day,
        "n_cards": str(len(detailed)),
        "n_priced": str(len(prices)),
        "index_value_eur": cell(value, 2),
        "index_base100": cell(index, 6),
        "divisor": cell(divisor, 8),
        "link_factor": cell(link, 8),
        "daily_return_pct": cell(daily, 6),
        "volume": cell(round(sum(totals), 2) if totals else None, 2),
        "ct_it": cell(round(sum(cts), 2) if cts else None, 2),
        "cm_it": cell(round(sum(cms), 2) if cms else None, 2),
        "n_pop": str(n_pop),
        "constituents": json.dumps(published, ensure_ascii=False, separators=(",", ":")),
    }, {
        "index": index,
        "divisor": divisor,
        "constituents": published,
    }


def append_collection(meta):
    folder = collection_dir(meta)
    hist_dir = os.path.join(folder, "history")
    path = os.path.join(folder, "index_history.csv")
    pop = load_json(os.path.join(DATA, meta.get("pop_history") or "pop_history.json")) or {}
    notify = load_json(os.path.join(DATA, meta.get("tcgnotify") or "tcgnotify_history.json")) or {}
    if not isinstance(pop, dict):
        pop = {}
    if not isinstance(notify, dict):
        notify = {}
    existing = read_rows(path)
    have = {row["date"] for row in existing}
    prev = prev_state(existing[-1]) if existing else None
    fresh = []
    for day in snapshot_dates(hist_dir):
        if day in have:
            continue
        if existing and day < existing[-1]["date"]:
            # Una riga già archiviata non si riapre per infilarne una più vecchia.
            print(f"[{meta['id']}] {day} precedente all'ultimo archivio: lasciato vuoto")
            continue
        snap = load_json(os.path.join(hist_dir, f"{day}.json")) or {}
        cards = snap.get("cards") or []
        row, prev = build_row(day, cards, pop, notify, prev)
        fresh.append(row)
        have.add(day)
    os.makedirs(folder, exist_ok=True)
    new_file = not os.path.exists(path)
    with open(path, "a", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=FIELDS, lineterminator="\n")
        if new_file:
            writer.writeheader()
        writer.writerows(fresh)
    print(f"[{meta['id']}] +{len(fresh)} righe, archivio {path}")
    return read_rows(path)


def add_days(day, count):
    return (datetime.strptime(day, "%Y-%m-%d").date() + timedelta(days=count)).isoformat()


def level_on(rows, day):
    for row in rows:
        if row["date"] == day:
            return parse_num(row.get("index_base100"))
    return None


def pct(latest, past):
    if latest is None or past in (None, 0):
        return None
    return round((latest / past - 1.0) * 100.0, 6)


def summary_for(meta, rows):
    latest = rows[-1] if rows else None
    returns = {name: None for name, _ in HORIZONS}
    returns["YTD"] = None
    returns["inception"] = None
    if latest:
        last_day = latest["date"]
        last_level = parse_num(latest.get("index_base100"))
        for name, days in HORIZONS:
            returns[name] = pct(last_level, level_on(rows, add_days(last_day, -days)))
        year_end = f"{int(last_day[:4]) - 1}-12-31"
        returns["YTD"] = pct(last_level, level_on(rows, year_end))
        returns["inception"] = pct(last_level, 100.0)
    return {
        "id": meta["id"],
        "name": meta.get("name") or meta["id"],
        "date": latest["date"] if latest else None,
        "n_cards": int(latest["n_cards"]) if latest and latest.get("n_cards") else None,
        "n_priced": int(latest["n_priced"]) if latest and latest.get("n_priced") else None,
        "index_value_eur": parse_num(latest.get("index_value_eur")) if latest else None,
        "index_base100": parse_num(latest.get("index_base100")) if latest else None,
        "divisor": parse_num(latest.get("divisor")) if latest else None,
        "volume": parse_num(latest.get("volume")) if latest else None,
        "ct_it": parse_num(latest.get("ct_it")) if latest else None,
        "cm_it": parse_num(latest.get("cm_it")) if latest else None,
        "n_pop": int(latest["n_pop"]) if latest and latest.get("n_pop") != "" else None,
        "returns_pct": returns,
    }


def main():
    collections = load_json(os.path.join(DATA, "collections.json")) or []
    blocks = []
    for meta in collections:
        rows = append_collection(meta)
        blocks.append(summary_for(meta, rows))
    payload = {
        "generated_at": datetime.now(TZ).isoformat(timespec="seconds"),
        "base": 100,
        "real_from": REAL_FROM,
        "note": (
            "index_value_eur somma i prezzi unitari di tutte le carte dello snapshot, "
            "anche quelle segnate come acquistate. index_base100 è a base 100 e si concatena "
            "sul rendimento delle carte in comune, così un'aggiunta non crea un salto. "
            "volume è la somma dei total CT+CM italiani già noti; un dato mancante resta null. "
            "I rendimenti sono percentuali e sono null se manca il giorno esatto di confronto."
        ),
        "collections": blocks,
    }
    out = os.path.join(DATA, "indices_summary.json")
    with open(out, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, indent=1)
        f.write("\n")
    print(f"scritto {out}")
    for block in blocks:
        print(
            block["id"], block["date"], "value", block["index_value_eur"],
            "base100", block["index_base100"], "returns", block["returns_pct"],
        )


if __name__ == "__main__":
    main()
