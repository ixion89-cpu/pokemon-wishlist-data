#!/usr/bin/env python3
"""Aggiorna i prezzi minimi CardTrader (lingua target, Near Mint, non gradate) della wishlist.

Uso:
  python3 scripts/update_prices.py            # aggiorna data/*
  python3 scripts/update_prices.py --commit   # aggiorna e fa git commit + push

Fonte: pagine pubbliche CardTrader (https://www.cardtrader.com/en-EU/cards/<blueprint_id>.json),
filtrate per lingua e condizione. Nessun token richiesto. Se in futuro si usa l'API ufficiale,
impostare CARDTRADER_TOKEN (non ancora usato).
"""
import csv, json, os, subprocess, sys, time, urllib.parse, urllib.request
from datetime import datetime, timezone, timedelta

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, "data")
UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36"
BASE = "https://www.cardtrader.com/en-EU/cards/{bid}.json"
TZ = timezone(timedelta(hours=1))  # Europe/Rome (inverno); solo per la data del file
HIST_FIELDS = ["date", "card_id", "blueprint_id", "name", "set_code", "number", "price_eur",
               "language", "condition", "listings_count", "source", "kind"]


def fetch(bid, lang=None, cond=None, page=1):
    q = [("page", str(page))]
    if lang:
        q.append(("q[terms][properties_hash.pokemon_language.keyword][]", lang))
    if cond:
        q.append(("q[terms][properties_hash.condition.keyword][]", cond))
    url = BASE.format(bid=bid) + "?" + urllib.parse.urlencode(q)
    for attempt in range(4):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "application/json"})
            with urllib.request.urlopen(req, timeout=40) as r:
                return json.load(r)
        except Exception as e:  # rete/rate limit: ritenta
            time.sleep(3 * (attempt + 1))
            err = e
    raise err


def products(bid, lang=None, cond=None):
    out, page, first = [], 1, None
    while page <= 10:
        d = fetch(bid, lang, cond, page)
        first = first or d
        out += d.get("products") or []
        if d.get("products_last_page_reached", True):
            break
        page += 1
        time.sleep(1)
    return out, first


def ok(p, lang, cond):
    h = p.get("properties_hash", {})
    return (not p.get("graded")) and (lang is None or h.get("pokemon_language") == lang) \
        and (cond is None or h.get("condition") == cond)


def tier(price):
    if price is None:
        return "n/d"
    return "A: <50€" if price < 50 else ("B: 50-150€" if price <= 150 else "C: >150€")


def main():
    commit = "--commit" in sys.argv
    cards = json.load(open(os.path.join(DATA, "cards.json")))
    now = datetime.now(TZ)
    today, stamp = now.strftime("%Y-%m-%d"), now.isoformat(timespec="seconds")
    hist_path = os.path.join(DATA, "price_history.csv")
    existing = list(csv.DictReader(open(hist_path))) if os.path.exists(hist_path) else []
    have_backfill = {r["card_id"] for r in existing if r["kind"] == "backfill"}
    have_today = {(r["card_id"], r["kind"]) for r in existing if r["date"] == today}
    new_rows, out = [], []
    for c in cards:
        bid, lang = c["cardtrader_blueprint_id"], c.get("target_language", "it")
        rec = dict(c)
        try:
            nm, d0 = products(bid, lang, "Near Mint")
            nm = [p for p in nm if ok(p, lang, "Near Mint")]
            prices = sorted(p["price"]["cents"] / 100 for p in nm)
            time.sleep(1)
            anynm, _ = products(bid, None, "Near Mint")
            anyp = sorted(p["price"]["cents"] / 100 for p in anynm if ok(p, None, "Near Mint"))
            bp = d0["blueprint"]
            img = (bp.get("image") or {}).get("show", {}).get("url") or bp.get("image_url")
            rec["image_url"] = ("https://www.cardtrader.com" + img) if img and img.startswith("/") else img
            rec["price_min_ita_nm_eur"] = prices[0] if (prices and lang == "it") else None
            rec["price_min_target_lang_nm_eur"] = prices[0] if prices else None
            rec["listings_target_lang_nm"] = len(prices)
            rec["price_2nd_target_lang_nm_eur"] = prices[1] if len(prices) > 1 else None
            rec["price_min_any_lang_nm_eur"] = anyp[0] if anyp else None
            g = (bp.get("prices_for_graph") or {}).get("ct_market") or []
            rec["ct_market_all_lang_eur"] = g[-1][1] if g else None
            if prices:
                rec["price_source"] = f"CardTrader min {lang.upper()} Near Mint (non gradata, spedizione esclusa)"
            elif anyp:
                rec["price_source"] = "NESSUNA copia " + lang.upper() + " NM in vendita: vedi price_min_any_lang_nm_eur (fallback, qualsiasi lingua)"
            else:
                rec["price_source"] = "nessuna offerta NM su CardTrader"
            rec["fetch_error"] = None
            # backfill: storico 'CT market' (tutte le lingue) una sola volta per carta
            if c["id"] not in have_backfill:
                for ts, val in g:
                    dt = datetime.fromtimestamp(ts / 1000, timezone.utc).strftime("%Y-%m-%d")
                    new_rows.append(dict(date=dt, card_id=c["id"], blueprint_id=bid, name=c["name"],
                        set_code=c["set_code"], number=c["number"], price_eur=val, language="all",
                        condition="all", listings_count="", source="cardtrader_ct_market_graph_all_languages",
                        kind="backfill"))
            if (c["id"], "daily_snapshot") not in have_today:
                new_rows.append(dict(date=today, card_id=c["id"], blueprint_id=bid, name=c["name"],
                    set_code=c["set_code"], number=c["number"], price_eur=prices[0] if prices else "",
                    language=lang, condition="Near Mint", listings_count=len(prices),
                    source="cardtrader_listings_min", kind="daily_snapshot"))
                if anyp:
                    new_rows.append(dict(date=today, card_id=c["id"], blueprint_id=bid, name=c["name"],
                        set_code=c["set_code"], number=c["number"], price_eur=anyp[0], language="any",
                        condition="Near Mint", listings_count=len(anyp),
                        source="cardtrader_listings_min", kind="daily_snapshot"))
        except Exception as e:
            prev = {}
            try:
                prev = {x["id"]: x for x in json.load(open(os.path.join(DATA, "wishlist.json")))["cards"]}.get(c["id"], {})
            except Exception:
                pass
            rec.update({k: prev.get(k) for k in ("image_url", "price_min_ita_nm_eur", "price_min_target_lang_nm_eur",
                         "listings_target_lang_nm", "price_2nd_target_lang_nm_eur", "price_min_any_lang_nm_eur",
                         "ct_market_all_lang_eur", "price_source")})
            rec["fetch_error"] = str(e)[:200]
        rec["buy_price_eur"] = rec.get("price_min_target_lang_nm_eur")
        rec["tier"] = tier(rec["buy_price_eur"])
        rec["last_updated"] = stamp
        out.append(rec)
        print(f'{c["id"]:6} {c["name"][:32]:32} {rec.get("price_min_target_lang_nm_eur")}', flush=True)
        time.sleep(1.2)

    out.sort(key=lambda r: (r["buy_price_eur"] is None, -(r["buy_price_eur"] or 0)))
    for i, r in enumerate(out, 1):
        r["rank_by_price"] = i
    priced = [r["buy_price_eur"] for r in out if r["buy_price_eur"] is not None]
    payload = {"generated_at": stamp, "currency": "EUR",
               "price_definition": "Prezzo minimo CardTrader per copia in lingua target (ITA, o JP per carte solo giapponesi), Near Mint, non gradata, spedizione esclusa",
               "summary": {"cards": len(out), "priced": len(priced), "total_eur": round(sum(priced), 2),
                           "tiers": {t: sum(1 for r in out if r["tier"] == t) for t in ("A: <50€", "B: 50-150€", "C: >150€", "n/d")}},
               "cards": out}
    json.dump(payload, open(os.path.join(DATA, "wishlist.json"), "w"), ensure_ascii=False, indent=1)
    os.makedirs(os.path.join(DATA, "history"), exist_ok=True)
    json.dump(payload, open(os.path.join(DATA, "history", f"{today}.json"), "w"), ensure_ascii=False, indent=1)
    cols = ["rank_by_price", "id", "order", "name", "set", "set_code", "number", "rarity", "target_language",
            "price_min_ita_nm_eur", "price_min_target_lang_nm_eur", "price_2nd_target_lang_nm_eur",
            "listings_target_lang_nm", "price_min_any_lang_nm_eur", "ct_market_all_lang_eur", "tier",
            "price_source", "confidence", "notes", "cardtrader_link", "image_url", "last_updated"]
    with open(os.path.join(DATA, "wishlist.csv"), "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=cols, extrasaction="ignore")
        w.writeheader()
        w.writerows(out)
    rows = existing + new_rows
    rows.sort(key=lambda r: (r["card_id"], r["date"], r["kind"], r["language"]))
    with open(hist_path, "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=HIST_FIELDS)
        w.writeheader()
        w.writerows(rows)
    print(f"OK {len(out)} carte, totale {payload['summary']['total_eur']} EUR, +{len(new_rows)} righe storico")
    if commit:
        subprocess.run(["git", "-C", ROOT, "add", "data"], check=True)
        r = subprocess.run(["git", "-C", ROOT, "commit", "-m", f"Aggiornamento prezzi {today}"])
        if r.returncode == 0:
            subprocess.run(["git", "-C", ROOT, "push"], check=False)


if __name__ == "__main__":
    main()
