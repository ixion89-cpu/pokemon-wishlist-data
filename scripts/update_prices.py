#!/usr/bin/env python3
"""Aggiorna i prezzi minimi CardTrader (lingua target, Near Mint, non gradate) della wishlist.

Registra anche il minimo dei soli venditori CardTrader Zero (nel JSON pubblico:
user.can_sell_via_hub, cioè chi spedisce tramite l'hub CardTrader).

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
               "language", "condition", "listings_count", "source", "kind",
               "price_ctz_eur", "price_ct_eur", "price_avg_eur"]
SET_YEARS_PATH = os.path.join(DATA, "set_years.json")
PRICE_DEFINITION = (
    "price_final_eur è un solo prezzo Near Mint in lingua target (ITA, JP solo per Togepi), "
    "non gradato, spedizione esclusa. Il prezzo è price.cents/100, già con la fee di CardTrader. "
    "Default: minimo Zero (price_ctz_eur). Si usa il minimo CardTrader normale (price_ct_eur) "
    "se non c'è nessuno Zero, oppure se lo Zero costa più del 20% del normale "
    "(price_ctz_eur > price_ct_eur * 1.20). Se mancano entrambi, si usa price_cm_eur da Cardmarket. "
    "price_final_source vale ctz, ct o cm. buy_price_eur è uguale a price_final_eur."
)
ZERO_DEFINITION = (
    "zero_total_eur somma solo i minimi Near Mint in lingua target dei venditori CardTrader Zero. "
    "Una carta senza copia Zero non entra in quel totale, ma resta in total_eur se ha un minimo CardTrader."
)


def load_set_years():
    try:
        with open(SET_YEARS_PATH, encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return {}


def year_from_raw(raw):
    if raw is None:
        return None
    text = str(raw)
    if len(text) >= 4 and text[:4].isdigit():
        year = int(text[:4])
        if 1990 <= year <= 2100:
            return year
    return None


def release_year_for(card, blueprint, years):
    """Anno di uscita dell'espansione: data CardTrader, poi data/set_years.json."""
    if card.get("release_year"):
        try:
            return int(card["release_year"])
        except (TypeError, ValueError):
            pass
    bp = blueprint or {}
    exp = bp.get("expansion") or {}
    for raw in (exp.get("released_at"), exp.get("release_date"), bp.get("released_at"), bp.get("release_date")):
        year = year_from_raw(raw)
        if year:
            return year
    sets = years.get("sets") if isinstance(years.get("sets"), dict) else years
    info = None
    if isinstance(sets, dict):
        info = sets.get(card.get("set_code") or "") or sets.get(card.get("set") or "")
    if isinstance(info, dict) and info.get("year"):
        return int(info["year"])
    return None


def choose_final(ctz, ct, cm):
    """Zero, salvo se manca o se costa più del 20% rispetto al CardTrader normale."""
    if ctz is not None and ct is not None and ctz > ct * 1.20:
        return ct, "ct"
    if ctz is not None:
        return ctz, "ctz"
    if ct is not None:
        return ct, "ct"
    if cm is not None:
        return cm, "cm"
    return None, None


def parse_day(text):
    try:
        return datetime.strptime(str(text or "")[:10], "%Y-%m-%d").date()
    except ValueError:
        return None


def load_named_json(name):
    path = os.path.join(DATA, name)
    if not os.path.exists(path):
        return None
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return None


def eu_listings(today):
    """Listini NM visti da un IP europeo. Usati solo se la data è oggi o ieri."""
    raw = load_named_json("cardtrader_eu_raw.json")
    if not isinstance(raw, dict):
        return {}
    file_day, today_day = parse_day(raw.get("date")), parse_day(today)
    if not file_day or not today_day or (today_day - file_day).days not in (0, 1):
        return {}
    listings = raw.get("listings")
    return listings if isinstance(listings, dict) else {}


def cardmarket_table():
    raw = load_named_json("cardmarket.json")
    return raw if isinstance(raw, dict) else {}


def eu_groups(rows):
    fake = []
    for row in rows or []:
        if not isinstance(row, dict) or not isinstance(row.get("price_eur"), (int, float)):
            continue
        fake.append({
            "price": {"cents": int(round(float(row["price_eur"]) * 100))},
            "quantity": row.get("qty", row.get("quantity", 0)),
            "user": {"can_sell_via_hub": bool(row.get("zero"))},
        })
    zero = [p for p in fake if is_zero_seller(p)]
    direct = [p for p in fake if not is_zero_seller(p)]
    return group_stats(zero), group_stats(direct), group_stats(fake)


def write_history_index():
    hist = os.path.join(DATA, "history")
    os.makedirs(hist, exist_ok=True)
    dates = sorted(
        name[:-5] for name in os.listdir(hist)
        if len(name) == 15 and name.endswith(".json") and name[0].isdigit()
    )
    with open(os.path.join(hist, "index.json"), "w", encoding="utf-8") as f:
        json.dump(dates, f, ensure_ascii=False, indent=1)
        f.write("\n")


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
    out, page, first, extra = [], 1, None, {}
    while page <= 10:
        d = fetch(bid, lang, cond, page)
        first = first or d
        out += d.get("products") or []
        extra.update(d.get("users_extra_data") or {})
        if d.get("products_last_page_reached", True):
            break
        page += 1
        time.sleep(1)
    return out, first, extra


def is_zero_seller(p):
    user = p.get("user")
    return isinstance(user, dict) and bool(user.get("can_sell_via_hub"))


def listing_qty(p):
    try:
        return int(p.get("quantity") or 0)
    except (TypeError, ValueError):
        return 0


def offer_from(p, extra):
    user = p.get("user") or {}
    uid = user.get("id")
    info = {}
    if isinstance(extra, dict):
        info = extra.get(str(uid)) or extra.get(uid) or {}
        if not isinstance(info, dict):
            info = {}
    cents = (p.get("price") or {}).get("cents")
    row = {
        "user_id": uid,
        "username": user.get("username"),
        "country_code": user.get("country_code"),
        "price_eur": round(cents / 100, 2) if isinstance(cents, (int, float)) else None,
        "quantity": listing_qty(p),
        "avg_rating_percentage": info.get("avg_rating_percentage"),
        "feedbacks_count": info.get("feedbacks_count"),
    }
    if info.get("ct_zero_avg_shipping_days") is not None:
        row["ct_zero_avg_shipping_days"] = info.get("ct_zero_avg_shipping_days")
    return row


def top_offers(listings, extra, want_zero, limit=5):
    chosen = [p for p in listings if is_zero_seller(p) is want_zero and (p.get("price") or {}).get("cents") is not None]
    chosen.sort(key=lambda p: (p["price"]["cents"], (p.get("user") or {}).get("username") or ""))
    return [offer_from(p, extra) for p in chosen[:limit]]


def mint_nm_stock(listings):
    """Quantità complessiva Mint+Near Mint, Zero compreso. Nessuno split per tipo di venditore."""
    qty = 0
    for p in listings:
        qty += listing_qty(p)
    return qty, len(listings)


def ok(p, lang, cond):
    h = p.get("properties_hash", {})
    return (not p.get("graded")) and (lang is None or h.get("pokemon_language") == lang) \
        and (cond is None or h.get("condition") == cond)


def price_eur(p):
    cents = (p.get("price") or {}).get("cents")
    if not isinstance(cents, (int, float)):
        return None
    return round(cents / 100, 2)


def group_stats(listings):
    """Minimo, numero di annunci e copie. La media pesata esclude quantity 0."""
    prices, qty, weighted, weighted_qty = [], 0, 0.0, 0
    for p in listings:
        price = price_eur(p)
        if price is None:
            continue
        prices.append(price)
        q = listing_qty(p)
        qty += max(q, 0)
        if q > 0:
            weighted += price * q
            weighted_qty += q
    prices.sort()
    return {
        "min": prices[0] if prices else None,
        "n": len(prices),
        "qty": qty,
        "avg": round(weighted / weighted_qty, 2) if weighted_qty else None,
    }


def tier(price):
    if price is None:
        return "n/d"
    return "A: <50€" if price < 50 else ("B: 50-150€" if price <= 150 else "C: >150€")


def main():
    commit = "--commit" in sys.argv
    cards = json.load(open(os.path.join(DATA, "cards.json")))
    set_years = load_set_years()
    now = datetime.now(TZ)
    today, stamp = now.strftime("%Y-%m-%d"), now.isoformat(timespec="seconds")
    hist_path = os.path.join(DATA, "price_history.csv")
    existing = list(csv.DictReader(open(hist_path))) if os.path.exists(hist_path) else []
    have_backfill = {r["card_id"] for r in existing if r["kind"] == "backfill"}
    # La serie Zero è uno snapshot distinto (language it_zero/jp_zero): non va
    # soppressa solo perché oggi esiste già lo snapshot della lingua target.
    have_today = {(r["card_id"], r["kind"], r.get("language", "")) for r in existing if r["date"] == today}
    eu_map = eu_listings(today)
    cardmarket = cardmarket_table()
    new_rows, out = [], []
    for c in cards:
        bid, lang = c["cardtrader_blueprint_id"], c.get("target_language", "it")
        rec = dict(c)
        bp = None
        try:
            # CardTrader include nel JSON solo chi spedisce nel paese del client,
            # più i venditori Zero. Da un IP fuori dall'Italia le copie ITA non-Zero
            # (can_sell_via_hub false) possono mancare del tutto: non vanno scartate
            # se invece sono nella risposta.
            nm, d0, nm_extra = products(bid, lang, "Near Mint")
            nm = [p for p in nm if ok(p, lang, "Near Mint")]
            # Il minimo normale include anche i venditori non-Zero (can_sell_via_hub false).
            # Il filtro Zero si applica solo a zprices, mai a questa lista.
            prices = sorted(price_eur(p) for p in nm if price_eur(p) is not None)
            zero_listings = [p for p in nm if is_zero_seller(p)]
            ct_listings = [p for p in nm if not is_zero_seller(p)]
            zstats, cstats, astats = group_stats(zero_listings), group_stats(ct_listings), group_stats(nm)
            zprices = [zstats["min"]] if zstats["min"] is not None else []
            rec["price_ctz_eur"] = zstats["min"]
            rec["listings_ctz"] = zstats["n"]
            rec["qty_ctz"] = zstats["qty"]
            rec["price_ct_eur"] = cstats["min"]
            rec["listings_ct"] = cstats["n"]
            rec["qty_ct"] = cstats["qty"]
            rec["price_avg_eur"] = astats["avg"]
            rec["listings_nm"] = astats["n"]
            rec["qty_nm"] = astats["qty"]
            eu_rows = eu_map.get(str(bid))
            if isinstance(eu_rows, list) and eu_rows:
                zstats, cstats, astats = eu_groups(eu_rows)
                zprices = [zstats["min"]] if zstats["min"] is not None else []
                prices = sorted(p for p in (zstats["min"], cstats["min"]) if p is not None)
                rec["price_ctz_eur"] = zstats["min"]
                rec["listings_ctz"] = zstats["n"]
                rec["qty_ctz"] = zstats["qty"]
                rec["price_ct_eur"] = cstats["min"]
                rec["listings_ct"] = cstats["n"]
                rec["qty_ct"] = cstats["qty"]
                rec["price_avg_eur"] = astats["avg"]
                rec["listings_nm"] = astats["n"]
                rec["qty_nm"] = astats["qty"]
                rec["price_min_target_lang_nm_zero_eur"] = zstats["min"]
                rec["listings_target_lang_nm_zero"] = zstats["n"]
                if lang == "it":
                    rec["price_min_ita_nm_zero_eur"] = zstats["min"]
            rec["offers_zero"] = top_offers(nm, nm_extra, True)
            rec["offers_ct"] = top_offers(nm, nm_extra, False)
            time.sleep(1)
            mint, _, _ = products(bid, lang, "Mint")
            mint = [p for p in mint if ok(p, lang, "Mint")]
            stock_qty, stock_n = mint_nm_stock(nm + mint)
            rec["qty_mint_nm_target_lang"] = stock_qty
            rec["listings_mint_nm_target_lang"] = stock_n
            time.sleep(1)
            anynm, _, _ = products(bid, None, "Near Mint")
            anyp = sorted(p["price"]["cents"] / 100 for p in anynm if ok(p, None, "Near Mint"))
            bp = d0["blueprint"]
            img = (bp.get("image") or {}).get("show", {}).get("url") or bp.get("image_url")
            rec["image_url"] = ("https://www.cardtrader.com" + img) if img and img.startswith("/") else img
            rec["price_min_ita_nm_eur"] = prices[0] if (prices and lang == "it") else None
            rec["price_min_target_lang_nm_eur"] = prices[0] if prices else None
            rec["listings_target_lang_nm"] = len(prices)
            rec["price_2nd_target_lang_nm_eur"] = prices[1] if len(prices) > 1 else None
            rec["price_min_any_lang_nm_eur"] = anyp[0] if anyp else None
            rec["price_min_ita_nm_zero_eur"] = zprices[0] if (zprices and lang == "it") else None
            rec["price_min_target_lang_nm_zero_eur"] = zprices[0] if zprices else None
            rec["listings_target_lang_nm_zero"] = len(zprices)
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
            modes = dict(price_ctz_eur=zstats["min"] if zstats["min"] is not None else "",
                         price_ct_eur=cstats["min"] if cstats["min"] is not None else "",
                         price_avg_eur=astats["avg"] if astats["avg"] is not None else "")
            if (c["id"], "daily_snapshot", lang) not in have_today:
                new_rows.append(dict(date=today, card_id=c["id"], blueprint_id=bid, name=c["name"],
                    set_code=c["set_code"], number=c["number"], price_eur=prices[0] if prices else "",
                    language=lang, condition="Near Mint", listings_count=len(prices),
                    source="cardtrader_listings_min", kind="daily_snapshot", **modes))
            if (c["id"], "daily_snapshot", lang + "_zero") not in have_today:
                new_rows.append(dict(date=today, card_id=c["id"], blueprint_id=bid, name=c["name"],
                    set_code=c["set_code"], number=c["number"], price_eur=zprices[0] if zprices else "",
                    language=lang + "_zero", condition="Near Mint", listings_count=len(zprices),
                    source="cardtrader_zero_listings_min", kind="daily_snapshot", **modes))
            if anyp and (c["id"], "daily_snapshot", "any") not in have_today:
                new_rows.append(dict(date=today, card_id=c["id"], blueprint_id=bid, name=c["name"],
                    set_code=c["set_code"], number=c["number"], price_eur=anyp[0], language="any",
                    condition="Near Mint", listings_count=len(anyp),
                    source="cardtrader_listings_min", kind="daily_snapshot", **modes))
        except Exception as e:
            prev = {}
            try:
                prev = {x["id"]: x for x in json.load(open(os.path.join(DATA, "wishlist.json")))["cards"]}.get(c["id"], {})
            except Exception:
                pass
            rec.update({k: prev.get(k) for k in ("image_url", "price_min_ita_nm_eur", "price_min_target_lang_nm_eur",
                         "listings_target_lang_nm", "price_2nd_target_lang_nm_eur", "price_min_any_lang_nm_eur",
                         "ct_market_all_lang_eur", "price_source", "price_min_ita_nm_zero_eur",
                         "price_min_target_lang_nm_zero_eur", "listings_target_lang_nm_zero",
                         "offers_zero", "offers_ct", "qty_mint_nm_target_lang",
                         "listings_mint_nm_target_lang",
                         "price_ctz_eur", "listings_ctz", "qty_ctz",
                         "price_ct_eur", "listings_ct", "qty_ct",
                         "price_avg_eur", "listings_nm", "qty_nm",
                         "price_cm_eur", "price_cm_avg_eur", "copies_cm", "price_cm_date",
                         "price_final_eur", "price_final_source")})
            rec["fetch_error"] = str(e)[:200]
        rec["release_year"] = release_year_for(c, bp, set_years)
        cm = cardmarket.get(c["id"]) if isinstance(cardmarket.get(c["id"]), dict) else {}
        rec["price_cm_eur"] = cm.get("min_eur") if isinstance(cm.get("min_eur"), (int, float)) else None
        rec["price_cm_avg_eur"] = cm.get("avg_eur") if isinstance(cm.get("avg_eur"), (int, float)) else None
        rec["copies_cm"] = cm.get("copies") if isinstance(cm.get("copies"), (int, float)) else None
        rec["price_cm_date"] = cm.get("date")
        price, source = choose_final(rec.get("price_ctz_eur"), rec.get("price_ct_eur"), rec.get("price_cm_eur"))
        rec["price_final_eur"] = price
        rec["price_final_source"] = source
        rec["buy_price_eur"] = price
        rec["buy_price_source"] = source
        rec["tier"] = tier(price)
        rec["last_updated"] = stamp
        out.append(rec)
        print(f'{c["id"]:6} {c["name"][:32]:32} {price} {source or "-"}', flush=True)
        time.sleep(1.2)

    out.sort(key=lambda r: (r["buy_price_eur"] is None, -(r["buy_price_eur"] or 0)))
    for i, r in enumerate(out, 1):
        r["rank_by_price"] = i
    def mode_sum(key):
        vals = [r[key] for r in out if r.get(key) is not None]
        return len(vals), round(sum(vals), 2)
    ctz_n, ctz_sum = mode_sum("price_ctz_eur")
    ct_n, ct_sum = mode_sum("price_ct_eur")
    avg_n, avg_sum = mode_sum("price_avg_eur")
    priced = [r["buy_price_eur"] for r in out if r["buy_price_eur"] is not None]
    zpriced = [r["price_min_target_lang_nm_zero_eur"] for r in out if r.get("price_min_target_lang_nm_zero_eur") is not None]
    payload = {"generated_at": stamp, "currency": "EUR",
               "price_definition": PRICE_DEFINITION,
               "summary": {"cards": len(out), "priced": len(priced), "total_eur": round(sum(priced), 2),
                           "zero_priced": len(zpriced), "zero_total_eur": round(sum(zpriced), 2),
                           "ctz_priced": ctz_n, "total_ctz_eur": ctz_sum,
                           "ct_priced": ct_n, "total_ct_eur": ct_sum,
                           "avg_priced": avg_n, "total_avg_eur": avg_sum,
                           "final_ctz": sum(1 for r in out if r.get("price_final_source") == "ctz"),
                           "final_ct": sum(1 for r in out if r.get("price_final_source") == "ct"),
                           "final_cm": sum(1 for r in out if r.get("price_final_source") == "cm"),
                           "tiers": {t: sum(1 for r in out if r["tier"] == t) for t in ("A: <50€", "B: 50-150€", "C: >150€", "n/d")}},
               "zero_definition": ZERO_DEFINITION,
               "cards": out}
    # Non riscrivere data/purchases.json, data/cardtrader_eu_raw.json,
    # data/cardmarket.json né data/tcgnotify_history.json.
    json.dump(payload, open(os.path.join(DATA, "wishlist.json"), "w"), ensure_ascii=False, indent=1)
    os.makedirs(os.path.join(DATA, "history"), exist_ok=True)
    json.dump(payload, open(os.path.join(DATA, "history", f"{today}.json"), "w"), ensure_ascii=False, indent=1)
    write_history_index()
    cols = ["rank_by_price", "id", "order", "name", "set", "set_code", "number", "rarity", "target_language",
            "release_year", "price_min_ita_nm_eur", "price_min_target_lang_nm_eur", "price_2nd_target_lang_nm_eur",
            "listings_target_lang_nm", "price_min_ita_nm_zero_eur", "price_min_target_lang_nm_zero_eur",
            "listings_target_lang_nm_zero", "qty_mint_nm_target_lang", "listings_mint_nm_target_lang",
            "price_ctz_eur", "listings_ctz", "qty_ctz", "price_ct_eur", "listings_ct", "qty_ct",
            "price_avg_eur", "listings_nm", "qty_nm",
            "price_cm_eur", "price_final_eur", "price_final_source",
            "price_min_any_lang_nm_eur", "ct_market_all_lang_eur", "tier",
            "buy_price_eur", "buy_price_source", "price_source", "confidence", "notes", "cardtrader_link",
            "image_url", "last_updated"]
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
    s = payload["summary"]
    print(f"OK {len(out)} carte, totale {s['total_eur']} EUR, "
          f"zero {s['zero_priced']}/{len(out)} carte per {s['zero_total_eur']} EUR, +{len(new_rows)} righe storico")
    if commit:
        subprocess.run(["git", "-C", ROOT, "add", "data"], check=True)
        r = subprocess.run(["git", "-C", ROOT, "commit", "-m", f"Aggiornamento prezzi {today}"])
        if r.returncode == 0:
            subprocess.run(["git", "-C", ROOT, "push"], check=False)


if __name__ == "__main__":
    main()
