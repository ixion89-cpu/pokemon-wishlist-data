#!/usr/bin/env python3
"""Archivio giornaliero della "pop" (copie italiane in vendita) per Wishlist e Gold.

TCGNotify mostra la popolazione solo per gli ultimi 30 giorni, quindi la salviamo ogni giorno.

  python3 scripts/update_pop.py                      # oggi, tutte le collezioni, fetch CardTrader dal box EU
  python3 scripts/update_pop.py --tcgnotify DUMP.json # unisce anche un dump TCGNotify (formato raw, vedi sotto)
  python3 scripts/update_pop.py --collection gold --no-fetch --eu-raw data/collections/gold/cardtrader_eu_raw.json

File scritti (per collezione, nella cartella dati della collezione):
  pop_history.json  {card_id: [{date, ct_it, ct_it_src, ct_it_all, ct_it_all_src, cm_it, total, total_all}]}
  pop_summary.json  {generated_at, definition, cards: {card_id: {pop_total_now, pop_date, ct_it_now, cm_it_now,
                      pop_change_30d_pct, pop_base_date, pop_base_total, ct_change_30d_pct, ct_base_date}}}

Definizioni
  ct_it      copie CardTrader in italiano (jp per carte solo giapponesi), Near Mint, non gradate.
             Fonte "tcgnotify" = population di TCGNotify per la lingua (coincide con la population NM);
             fonte "cardtrader_box" = somma delle quantità degli annunci CardTrader visti dal box EU.
  ct_it_all  come sopra ma tutte le condizioni (TCGNotify: somma delle cond_prices[*].population).
  cm_it      copie Cardmarket in italiano, tutte le condizioni (population di TCGNotify). Solo da dump TCGNotify:
             Cardmarket risponde 403 al box e l'API TCGNotify richiede il login.
  total      ct_it + cm_it (come la pop mostrata da TCGNotify). null se manca uno dei due quel giorno.
  total_all  ct_it_all + cm_it.

Regole: nessun valore inventato o interpolato; un giorno mancante resta mancante.
Idempotente per data: rieseguire lo stesso giorno sostituisce solo i valori della stessa fonte.
Priorità per ct_it / ct_it_all: tcgnotify > cardtrader_box (la serie storica viene da TCGNotify).
Variazione 30 gg: ultimo giorno con total vs total di 30 giorni prima; se quel giorno manca si usa il
giorno disponibile più vicino entro ±3 giorni (a parità, il più vecchio); altrimenti null.

Formato dump TCGNotify accettato (--tcgnotify, ripetibile):
  A) wishlist: {card_id: {"cm": {...language_data, current_data...}, "ct": {...language_data, current_data...}}}
  B) gold:     {"chosen": {"1": pid, ...}, "products": {pid: cm}, "cardtrader": {pid: ct}}  (indice = ordine in cards.json)
"""
from __future__ import annotations

import argparse
import json
import os
import random
import re
import sys
import time
import urllib.parse
import urllib.request
from datetime import date, datetime, timedelta, timezone

try:
    from zoneinfo import ZoneInfo
    TZ = ZoneInfo("Europe/Rome")
except Exception:  # pragma: no cover
    TZ = timezone(timedelta(hours=1))

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
COLLECTIONS = {"wishlist": "data", "gold": os.path.join("data", "collections", "gold")}
BASE = "https://www.cardtrader.com/en-EU/cards/{bid}.json"
UA = ("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36")
PRIORITY = {"tcgnotify": 2, "cardtrader_box": 1}
GRADED_TEXT = re.compile(r"\b(graded|grading|slab|slabbed|slabbato|gradat[aoie]|psa|cgc|bgs|sgc|"
                         r"beckett|ags|hga|cga|pca|gma)\b", re.I)
GRADED_KEY = re.compile(r"grad|slab|certifi", re.I)
EMPTY_GRADE = {None, False, "", 0, "0", "false", "False", "no", "No", "none", "None"}
DEFINITION = ("ct_it = copie CardTrader lingua target NM non gradate; ct_it_all = tutte le condizioni; "
              "cm_it = copie Cardmarket lingua target, tutte le condizioni (TCGNotify); total = ct_it + cm_it; "
              "total_all = ct_it_all + cm_it. Nessuna interpolazione.")


def today_rome() -> str:
    return datetime.now(TZ).strftime("%Y-%m-%d")


def lang_of(card: dict) -> str:
    lang = (card.get("target_language") or "it").lower()
    return "jp" if lang in ("jp", "ja") else lang


def day(text):
    s = str(text or "")[:10]
    try:
        datetime.strptime(s, "%Y-%m-%d")
        return s
    except ValueError:
        return None


def num(v):
    if v is None or isinstance(v, bool):
        return None
    if isinstance(v, (int, float)):
        return int(v) if float(v).is_integer() else v
    return None


# ---------------------------------------------------------------- CardTrader (box)
def fetch_json(url: str, retries: int = 2):
    err = None
    for attempt in range(retries + 1):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "application/json"})
            with urllib.request.urlopen(req, timeout=40) as r:
                return json.load(r)
        except Exception as exc:
            err = exc
            time.sleep(3 * (attempt + 1))
    raise err


def is_graded(p: dict) -> bool:
    if p.get("graded"):
        return True
    props = p.get("properties_hash") or {}
    for k, v in (props.items() if isinstance(props, dict) else []):
        if GRADED_KEY.search(str(k)) and v not in EMPTY_GRADE:
            return True
    for f in (p.get("name_en"), p.get("translated_name"), p.get("name"), p.get("description"), p.get("tag")):
        if f and GRADED_TEXT.search(str(f)):
            return True
    return False


def ct_box_counts(bid, lang: str):
    """(nm_qty, all_qty) copie in lingua target, non gradate, da tutte le pagine."""
    seen, nm, allq, page = set(), 0, 0, 1
    while page <= 10:
        q = [("page", str(page)), ("q[terms][properties_hash.pokemon_language.keyword][]", lang)]
        data = fetch_json(BASE.format(bid=bid) + "?" + urllib.parse.urlencode(q))
        for p in data.get("products") or []:
            if p.get("id") in seen:
                continue
            seen.add(p.get("id"))
            props = p.get("properties_hash") or {}
            if props.get("pokemon_language") != lang or is_graded(p):
                continue
            if not isinstance((p.get("price") or {}).get("cents"), (int, float)):
                continue
            try:
                qty = int(p.get("quantity") or 0)
            except (TypeError, ValueError):
                qty = 0
            allq += qty
            if props.get("condition") == "Near Mint":
                nm += qty
        if data.get("products_last_page_reached", True):
            break
        page += 1
        time.sleep(random.uniform(1.0, 1.5))
    return nm, allq


# ---------------------------------------------------------------- TCGNotify dump
def tn_points(cm: dict | None, ct: dict | None, lang: str) -> dict:
    """date -> {ct_it, ct_it_all, cm_it} solo dai valori presenti nel dump."""
    out: dict[str, dict] = {}
    keys = ["jp", "ja"] if lang == "jp" else [lang]

    def pick(d):
        if isinstance(d, dict):
            for k in keys:
                if k in d:
                    return d[k]
        return None

    for row in pick((cm or {}).get("language_data")) or []:
        d, pop = day(row.get("date")), num(row.get("population"))
        if d and pop is not None:
            out.setdefault(d, {})["cm_it"] = pop
    cur = pick((cm or {}).get("current_data"))
    if isinstance(cur, dict):
        d, pop = day(cur.get("date")), num(cur.get("population"))
        if d and pop is not None:
            out.setdefault(d, {}).setdefault("cm_it", pop)
    for row in pick((ct or {}).get("language_data")) or []:
        d = day(row.get("date"))
        if not d:
            continue
        cond = row.get("cond_prices") if isinstance(row.get("cond_prices"), dict) else {}
        nm = num((cond.get("Near Mint") or {}).get("population")) if isinstance(cond.get("Near Mint"), dict) else None
        if nm is None:
            nm = num(row.get("population"))
        pops = [num((v or {}).get("population")) for v in cond.values() if isinstance(v, dict)]
        allp = sum(p for p in pops if p is not None) if pops and all(p is not None for p in pops) else None
        if nm is not None:
            out.setdefault(d, {})["ct_it"] = nm
        if allp is not None:
            out.setdefault(d, {})["ct_it_all"] = allp
    # CardTrader current_data non ha data: non lo usiamo (niente date inventate).
    return out


def load_tn_dump(path: str, cards: list[dict]) -> dict[str, dict]:
    raw = json.load(open(path, encoding="utf-8"))
    res: dict[str, dict] = {}
    if isinstance(raw, dict) and "chosen" in raw and "products" in raw:
        for i, card in enumerate(cards, 1):
            pid = raw["chosen"].get(str(i))
            if pid is None:
                continue
            pid = str(pid)
            res[card["id"]] = tn_points(raw["products"].get(pid), (raw.get("cardtrader") or {}).get(pid), lang_of(card))
    else:
        ids = {c["id"]: c for c in cards}
        for cid, v in raw.items():
            if cid in ids and isinstance(v, dict):
                res[cid] = tn_points(v.get("cm"), v.get("ct"), lang_of(ids[cid]))
    return res


# ---------------------------------------------------------------- merge + summary
def set_field(pt: dict, field: str, value, src: str | None):
    if value is None:
        return
    if src is None:  # cm_it: unica fonte
        pt[field] = value
        return
    cur_src = pt.get(field + "_src")
    if pt.get(field) is None or cur_src is None or PRIORITY.get(src, 0) >= PRIORITY.get(cur_src, 0):
        pt[field] = value
        pt[field + "_src"] = src


def finalize(pt: dict) -> dict:
    ct, cta, cm = pt.get("ct_it"), pt.get("ct_it_all"), pt.get("cm_it")
    pt["total"] = ct + cm if ct is not None and cm is not None else None
    pt["total_all"] = cta + cm if cta is not None and cm is not None else None
    order = ["date", "ct_it", "ct_it_src", "ct_it_all", "ct_it_all_src", "cm_it", "total", "total_all"]
    return {k: pt.get(k) for k in order}


def base_point(series: list[dict], now_day: str, field: str):
    target = date.fromisoformat(now_day) - timedelta(days=30)
    best = None
    for p in series:
        if p.get(field) is None:
            continue
        dd = abs((date.fromisoformat(p["date"]) - target).days)
        if dd <= 3 and (best is None or dd < best[0] or (dd == best[0] and p["date"] < best[1]["date"])):
            best = (dd, p)
    return best[1] if best else None


def change(series, field):
    have = [p for p in series if p.get(field) is not None]
    if not have:
        return None, None, None, None
    now = have[-1]
    base = base_point(series, now["date"], field)
    pct = None
    if base and base[field]:
        pct = round((now[field] - base[field]) / base[field] * 100, 1)
    return now, base, pct, (base or {}).get("date")


def summarize(hist: dict[str, list]) -> dict:
    out = {}
    for cid, series in hist.items():
        now, base, pct, bdate = change(series, "total")
        ctn, ctb, ctpct, ctbdate = change(series, "ct_it")
        out[cid] = {
            "pop_total_now": now["total"] if now else None,
            "pop_date": now["date"] if now else None,
            "ct_it_now": now["ct_it"] if now else None,
            "cm_it_now": now["cm_it"] if now else None,
            "pop_change_30d_pct": pct,
            "pop_base_date": bdate,
            "pop_base_total": base["total"] if base else None,
            "ct_latest": ctn["ct_it"] if ctn else None,
            "ct_latest_date": ctn["date"] if ctn else None,
            "ct_change_30d_pct": ctpct,
            "ct_base_date": ctbdate,
        }
    return out


def run_collection(name: str, args) -> int:
    data_dir = os.path.join(args.root, COLLECTIONS[name])
    cards_path = args.cards if args.cards else os.path.join(data_dir, "cards.json")
    cards = json.load(open(cards_path, encoding="utf-8"))
    if isinstance(cards, dict):
        cards = cards.get("cards") or []
    hist_path = os.path.join(args.out or data_dir, "pop_history.json")
    hist = json.load(open(hist_path, encoding="utf-8")) if os.path.exists(hist_path) else {}
    by_date = {cid: {p["date"]: dict(p) for p in pts} for cid, pts in hist.items()}
    for c in cards:
        by_date.setdefault(c["id"], {})

    for dump in args.tcgnotify or []:
        try:
            pts = load_tn_dump(dump, cards)
        except Exception as exc:
            print(f"[{name}] dump {dump} non letto: {exc}", flush=True)
            continue
        if not pts:
            continue
        for cid, days in pts.items():
            for d, vals in days.items():
                pt = by_date[cid].setdefault(d, {"date": d})
                set_field(pt, "ct_it", vals.get("ct_it"), "tcgnotify")
                set_field(pt, "ct_it_all", vals.get("ct_it_all"), "tcgnotify")
                set_field(pt, "cm_it", vals.get("cm_it"), None)
        print(f"[{name}] merged TCGNotify dump {dump}: {len(pts)} cards", flush=True)

    today = args.date or today_rome()
    errors = []
    eu_rows = {}
    if args.eu_raw:
        eu = json.load(open(args.eu_raw, encoding="utf-8"))
        if day(eu.get("date")) == today:
            eu_rows = eu.get("listings") or {}
        else:
            print(f"[{name}] {args.eu_raw} ha date={eu.get('date')} != {today}: ignorato", flush=True)
    for i, c in enumerate(cards, 1):
        bid = c.get("cardtrader_blueprint_id")
        if bid is None:
            continue
        nm = allq = None
        if not args.no_fetch:
            try:
                nm, allq = ct_box_counts(bid, lang_of(c))
            except Exception as exc:
                errors.append(f"{c['id']} bid={bid}: {exc}")
            time.sleep(random.uniform(1.0, 1.5))
        if nm is None and str(bid) in eu_rows:
            nm = sum(int(r.get("qty") or 0) for r in eu_rows[str(bid)])
        pt = by_date[c["id"]].setdefault(today, {"date": today})
        set_field(pt, "ct_it", nm, "cardtrader_box")
        set_field(pt, "ct_it_all", allq, "cardtrader_box")
        if not args.quiet:
            print(f"[{name}] {i:3}/{len(cards)} {c['id']:6} bid={bid} nm={nm} all={allq}", flush=True)

    out_hist = {}
    for cid, days in by_date.items():
        series = [finalize(days[d]) for d in sorted(days)]
        out_hist[cid] = [p for p in series if any(p.get(k) is not None for k in ("ct_it", "ct_it_all", "cm_it"))]
    summary = {"generated_at": datetime.now(TZ).isoformat(timespec="seconds"),
               "definition": DEFINITION, "cards": summarize(out_hist)}
    os.makedirs(os.path.dirname(hist_path), exist_ok=True)
    with open(hist_path, "w", encoding="utf-8") as f:
        json.dump(out_hist, f, ensure_ascii=False, indent=1)
        f.write("\n")
    with open(os.path.join(os.path.dirname(hist_path), "pop_summary.json"), "w", encoding="utf-8") as f:
        json.dump(summary, f, ensure_ascii=False, indent=1)
        f.write("\n")
    print(f"[{name}] wrote {hist_path} cards={len(out_hist)} date={today} errors={len(errors)}", flush=True)
    for e in errors:
        print(f"[{name}] ERROR {e}", flush=True)
    return 1 if errors else 0


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--root", default=ROOT, help="root del repo (default: cartella sopra scripts/)")
    ap.add_argument("--collection", choices=["wishlist", "gold", "all"], default="all")
    ap.add_argument("--cards", help="cards.json alternativo (solo con una collezione)")
    ap.add_argument("--out", help="cartella di output alternativa (solo con una collezione)")
    ap.add_argument("--tcgnotify", action="append", help="dump TCGNotify da unire (ripetibile)")
    ap.add_argument("--eu-raw", help="cardtrader_eu_raw.json di oggi: NM qty se il fetch manca")
    ap.add_argument("--no-fetch", action="store_true", help="niente fetch CardTrader")
    ap.add_argument("--date", help="data YYYY-MM-DD per i valori CardTrader (default oggi Europe/Rome)")
    ap.add_argument("--quiet", action="store_true")
    args = ap.parse_args()
    names = ["wishlist", "gold"] if args.collection == "all" else [args.collection]
    if (args.cards or args.out) and len(names) > 1:
        ap.error("--cards/--out richiedono --collection wishlist|gold")
    return max(run_collection(n, args) for n in names)


if __name__ == "__main__":
    sys.exit(main())
