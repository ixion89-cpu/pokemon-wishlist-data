#!/usr/bin/env python3
"""eu_fetch.py wrapper for Collezione personale.

Reads /workspace/pokemon-owned/owned_wishlist.json
Writes /workspace/pokemon-owned/cardtrader_eu_raw.json (raw, all conditions)
and /workspace/pokemon-owned/cardtrader_graded_raw.json (PSA 10 graded listings).

Extends eu_fetch with first_edition and bidirectional reverse filtering.
Then applies prices onto owned_wishlist.json:

Raw cards:
  - cheapest Italian (or card language) non-graded listing in the card's own
    condition (Near Mint->NM, Lightly Played->SP, Moderately Played->MP,
    Heavily Played->PL).
  - For NM: CardTrader Zero, unless missing or >20% higher than normal CT.
  - If the own condition has no listing, fall back to NM (fallback=true).

Graded PSA 10:
  - cheapest CardTrader graded listing whose description identifies PSA 10,
    same language; never the raw NM price.

Cards with fallback_to_purchase_price=true use purchase_price_eur when no
CardTrader market listing is found (price_final_source=purchase_fallback).
A real market price always wins over the purchase fallback.
"""
from __future__ import annotations

import importlib.util
import json
import re
import sys
import time
import urllib.parse
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OWNED = ROOT / "data" / "collections" / "owned"
EU_CANDIDATES = [ROOT / "scripts" / "eu_fetch.py", Path("/workspace/pokemon-wishlist/eu_fetch.py")]
eu_path = next((p for p in EU_CANDIDATES if p.exists()), None)
if eu_path is None:
    raise SystemExit("eu_fetch.py non è in questo repo (né in scripts/ né in /workspace/pokemon-wishlist). Il fetch gira sul box EU.")
spec = importlib.util.spec_from_file_location("eu", eu_path)
eu = importlib.util.module_from_spec(spec)
spec.loader.exec_module(eu)

WISHLIST = OWNED / "wishlist.json"
OUT_RAW = OWNED / "cardtrader_eu_raw.json"
OUT_GRADED = OWNED / "cardtrader_graded_raw.json"

eu.OUT_PATH = OUT_RAW
eu.load_wishlist = lambda: json.load(open(WISHLIST, encoding="utf-8"))["cards"]

TRUE = {True, "true", "True", 1, "1"}
FALSE = {False, "false", "False", 0, "0", None}

# Collectr -> eu_fetch condition codes already stored as condition_code.
# CardTrader listing condition_code is NM/SP/MP/PL/PO.

PSA10_RE = re.compile(
    r"(?<![a-z0-9])psa\s*[:\-#]?\s*10(?:\.0+)?(?![0-9])",
    re.IGNORECASE,
)
# Reject obvious non-10 (the regex already requires 10, but guard PSA 100 etc.)
PSA_NOT10_RE = re.compile(r"(?<![a-z0-9])psa\s*[:\-#]?\s*(?:[1-9](?:\.[0-9]+)?|10\d)(?![0-9])", re.IGNORECASE)


def wants_first_edition(card: dict) -> bool:
    return card.get("pokemon_first_edition") in TRUE


def is_first_edition_listing(product: dict) -> bool:
    props = product.get("properties_hash") or {}
    return isinstance(props, dict) and props.get("first_edition") in TRUE


def wants_reverse(card: dict) -> bool:
    return card.get("pokemon_reverse") in TRUE


# Patch eu.card_url / keep / listing_row / products_for / wants_reverse
eu.wants_reverse = wants_reverse


_orig_card_url = eu.card_url


def card_url(bid, lang: str | None, page: int, want_reverse: bool = False, want_first: bool | None = None, graded: bool = False) -> str:
    query: list[tuple[str, str]] = [("page", str(page))]
    if lang:
        query.append(("q[terms][properties_hash.pokemon_language.keyword][]", lang))
    if want_reverse:
        query.append(("q[terms][properties_hash.pokemon_reverse][]", "true"))
    else:
        # bidirectional: exclude reverse when the owned copy is not reverse
        query.append(("q[terms][properties_hash.pokemon_reverse][]", "false"))
    if want_first is True:
        query.append(("q[terms][properties_hash.first_edition][]", "true"))
    elif want_first is False:
        query.append(("q[terms][properties_hash.first_edition][]", "false"))
    if graded:
        query.append(("q[terms][graded][]", "true"))
    return eu.BASE.format(bid=bid) + "?" + urllib.parse.urlencode(query)


def products_for(bid, lang: str, want_reverse: bool = False, want_first: bool | None = None, graded: bool = False) -> list[dict]:
    out: list[dict] = []
    seen: set[int] = set()
    page = 1
    while page <= eu.MAX_PAGES:
        data = eu.fetch_json(card_url(bid, lang, page, want_reverse=want_reverse, want_first=want_first, graded=graded))
        batch = data.get("products") or []
        for product in batch:
            pid = product.get("id")
            if pid is not None:
                if pid in seen:
                    continue
                seen.add(pid)
            out.append(product)
        if data.get("products_last_page_reached", True):
            break
        page += 1
        eu.pause()
    return out


def keep(product: dict, lang: str, want_reverse: bool = False, want_first: bool | None = None) -> bool:
    if eu.is_graded(product):
        return False
    props = product.get("properties_hash") or {}
    if not isinstance(props, dict):
        return False
    if props.get("pokemon_language") != lang:
        return False
    if eu.condition_code(props.get("condition")) is None:
        return False
    is_rev = eu.is_reverse_listing(product)
    if want_reverse and not is_rev:
        return False
    if (not want_reverse) and is_rev:
        return False
    if want_first is True and not is_first_edition_listing(product):
        return False
    if want_first is False and is_first_edition_listing(product):
        return False
    return eu.price_eur(product) is not None


def listing_row(product: dict) -> dict:
    row = eu.listing_row(product)
    row["first_edition"] = is_first_edition_listing(product)
    return row


def is_psa10(product: dict) -> bool:
    fields = [
        product.get("description"),
        product.get("tag"),
        product.get("name_en"),
        product.get("translated_name"),
        product.get("name"),
    ]
    props = product.get("properties_hash") or {}
    if isinstance(props, dict):
        for key, value in props.items():
            fields.append(f"{key} {value}")
    text = " ".join(str(f) for f in fields if f)
    if not text.strip():
        return False
    if PSA10_RE.search(text):
        # if the text also clearly states a different PSA grade and not 10, reject
        return True
    return False


def graded_row(product: dict) -> dict:
    props = product.get("properties_hash") or {}
    user = product.get("user") or {}
    return {
        "price_eur": eu.price_eur(product),
        "condition": eu.condition_code(props.get("condition")),
        "graded": True,
        "grader": "PSA",
        "grade": 10,
        "language": props.get("pokemon_language"),
        "qty": eu.quantity(product),
        "zero": isinstance(user, dict) and user.get("can_sell_via_hub") is True,
        "seller_country": user.get("country_code") if isinstance(user, dict) else None,
        "description": product.get("description"),
        "product_id": product.get("id"),
    }


def target_language(card: dict) -> str:
    lang = (card.get("target_language") or "it")
    if lang in ("ja", "jp"):
        return "jp"
    if lang in ("cn", "zh", "zhs", "chi"):
        return lang
    return lang


def fetch_raw_cards(cards: list[dict]) -> dict:
    listings: dict[str, list[dict]] = {}
    errors: list[str] = []
    raw_cards = [c for c in cards if not c.get("graded") and c.get("cardtrader_blueprint_id")]
    print(f"fetching {len(raw_cards)} raw cards from CardTrader (EU)", flush=True)
    for index, card in enumerate(raw_cards, 1):
        bid = card["cardtrader_blueprint_id"]
        key = str(bid)
        lang = target_language(card)
        want_rev = wants_reverse(card)
        # Only force first_edition filter when the card explicitly cares
        # (1st edition or clearly unlimited vintage). Modern cards leave None
        # unless pokemon_first_edition is a boolean on the row.
        if card.get("pokemon_first_edition") in TRUE:
            want_first = True
        elif card.get("pokemon_first_edition") in (False, "false", "False", 0, "0"):
            want_first = False
        else:
            want_first = None
        cid, name = card.get("id"), card.get("name") or ""
        try:
            rows = [
                listing_row(product)
                for product in products_for(bid, lang, want_reverse=want_rev, want_first=want_first, graded=False)
                if keep(product, lang, want_reverse=want_rev, want_first=want_first)
            ]
            rows.sort(key=lambda row: (row["price_eur"], not row["zero"], row["qty"]))
            listings[card["id"]] = rows
            listings[key] = rows  # last writer for this bid; card-id key is authoritative
            n_zero = sum(1 for row in rows if row["zero"])
            conds = {}
            for row in rows:
                conds[row["condition"]] = conds.get(row["condition"], 0) + 1
            print(
                f"{index:3}/{len(raw_cards)} {cid:6} {name[:32]:32} bid={key} "
                f"lang={lang} rev={want_rev} fe={want_first} listings={len(rows)} "
                f"zero={n_zero} conds={conds}",
                flush=True,
            )
        except Exception as exc:
            errors.append(f"{cid} bid={key}: {exc}")
            print(f"{index:3}/{len(raw_cards)} {cid} {name}: FAILED {exc}", flush=True)
        if index < len(raw_cards):
            eu.pause()
    payload = {"date": eu.today_rome(), "listings": listings, "errors": errors}
    OUT_RAW.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n")
    print(f"wrote {OUT_RAW} bids={len(listings)} errors={len(errors)}", flush=True)
    return payload


def fetch_graded_cards(cards: list[dict]) -> dict:
    listings: dict[str, list[dict]] = {}
    errors: list[str] = []
    graded_cards = [c for c in cards if c.get("graded") and c.get("cardtrader_blueprint_id")]
    print(f"fetching {len(graded_cards)} graded PSA 10 cards from CardTrader (EU)", flush=True)
    for index, card in enumerate(graded_cards, 1):
        bid = card["cardtrader_blueprint_id"]
        key = str(bid)
        lang = target_language(card)
        cid, name = card.get("id"), card.get("name") or ""
        try:
            products = products_for(bid, lang, want_reverse=False, want_first=None, graded=True)
            # Graded listings often omit pokemon_reverse; do not apply reverse/first filters strictly.
            # Re-fetch without reverse=false if empty, because the false filter may drop them.
            if not products:
                # fetch graded without reverse/first constraints
                products = []
                seen: set[int] = set()
                page = 1
                while page <= eu.MAX_PAGES:
                    query = [
                        ("page", str(page)),
                        ("q[terms][properties_hash.pokemon_language.keyword][]", lang),
                        ("q[terms][graded][]", "true"),
                    ]
                    url = eu.BASE.format(bid=bid) + "?" + urllib.parse.urlencode(query)
                    data = eu.fetch_json(url)
                    batch = data.get("products") or []
                    for product in batch:
                        pid = product.get("id")
                        if pid in seen:
                            continue
                        if pid is not None:
                            seen.add(pid)
                        products.append(product)
                    if data.get("products_last_page_reached", True):
                        break
                    page += 1
                    eu.pause()
            psa = []
            other = []
            for product in products:
                if not product.get("graded") and not eu.is_graded(product):
                    continue
                props = product.get("properties_hash") or {}
                if props.get("pokemon_language") and props.get("pokemon_language") != lang:
                    continue
                if eu.price_eur(product) is None:
                    continue
                if is_psa10(product):
                    psa.append(graded_row(product))
                else:
                    other.append({
                        "price_eur": eu.price_eur(product),
                        "description": product.get("description"),
                        "language": props.get("pokemon_language"),
                        "product_id": product.get("id"),
                    })
            psa.sort(key=lambda row: (row["price_eur"], row["qty"]))
            listings[key] = psa
            print(
                f"{index:3}/{len(graded_cards)} {cid:6} {name[:32]:32} bid={key} "
                f"lang={lang} graded_listings={len(products)} psa10={len(psa)} other_graded={len(other)}",
                flush=True,
            )
            if other and not psa:
                for o in other[:6]:
                    print(f"         other graded €{o['price_eur']} desc={o['description']!r}", flush=True)
        except Exception as exc:
            errors.append(f"{cid} bid={key}: {exc}")
            print(f"{index:3}/{len(graded_cards)} {cid} {name}: FAILED {exc}", flush=True)
        if index < len(graded_cards):
            eu.pause()
    payload = {"date": eu.today_rome(), "listings": listings, "errors": errors}
    OUT_GRADED.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n")
    print(f"wrote {OUT_GRADED} bids={len(listings)} errors={len(errors)}", flush=True)
    return payload


def drop_placeholders(rows: list[dict]) -> list[dict]:
    priced = sorted((r for r in rows if isinstance(r.get("price_eur"), (int, float))), key=lambda r: r["price_eur"])
    if not priced:
        return []
    kept = [priced[0]]
    for row in priced[1:]:
        price = row["price_eur"]
        cheaper = kept[-1]["price_eur"]
        if price >= 10000 and cheaper < 10000:
            continue
        if cheaper > 0 and price > 10 * cheaper:
            continue
        kept.append(row)
    return kept


def choose_nm(zero_rows: list[dict], ct_rows: list[dict]) -> tuple[float | None, str | None]:
    z = drop_placeholders(zero_rows)
    c = drop_placeholders(ct_rows)
    zt = z[0]["price_eur"] if z else None
    ct = c[0]["price_eur"] if c else None
    if zt is not None and ct is not None and zt > ct * 1.20:
        return ct, "ct"
    if zt is not None:
        return zt, "ctz"
    if ct is not None:
        return ct, "ct"
    return None, None


def rows_for(listings: dict, card: dict) -> list[dict]:
    if card.get("id") in listings:
        return listings.get(card["id"]) or []
    bid = card.get("cardtrader_blueprint_id")
    if bid is None:
        return []
    return listings.get(str(bid)) or []


def apply_purchase_fallback(card: dict) -> None:
    """Use purchase_price_eur when a flagged card has no market listing.

    A real CardTrader/Cardmarket price always wins. If the next daily run
    finds a listing, price_final_eur becomes that market price. If it does
    not, the paid price is shown again (gain 0) until a useful reference
    exists.
    """
    if not card.get("fallback_to_purchase_price"):
        return
    if isinstance(card.get("price_final_eur"), (int, float)):
        return
    paid = card.get("purchase_price_eur")
    if not isinstance(paid, (int, float)):
        return
    card["price_final_eur"] = paid
    card["price_final_source"] = "purchase_fallback"
    if not card.get("price_condition"):
        if card.get("graded"):
            card["price_condition"] = f"PSA{card.get('grade') or 10}"
        else:
            card["price_condition"] = card.get("condition_code") or "NM"


def apply_prices(cards: list[dict], raw: dict, graded: dict) -> None:
    raw_map = raw.get("listings") or {}
    grd_map = graded.get("listings") or {}
    now = datetime.now(eu.TZ).isoformat(timespec="seconds")
    for card in cards:
        # reset
        card["price_final_eur"] = None
        card["price_final_source"] = None
        card["price_condition"] = None
        card["fallback"] = False
        card["price_date"] = now
        if not card.get("cardtrader_blueprint_id"):
            card["notes"] = (card.get("notes") or "").rstrip() + (" " if card.get("notes") else "") + "Senza blueprint, non prezzata."
            apply_purchase_fallback(card)
            continue
        if card.get("graded"):
            psa = drop_placeholders(grd_map.get(str(card["cardtrader_blueprint_id"])) or [])
            if psa:
                card["price_final_eur"] = psa[0]["price_eur"]
                card["price_final_source"] = "ct_psa10"
                card["price_condition"] = "PSA10"
                card["listings_psa10"] = len(psa)
            else:
                card["price_final_eur"] = None
                card["price_final_source"] = None
                card["price_condition"] = "PSA10"
                card["listings_psa10"] = 0
                # never fall back to raw
            apply_purchase_fallback(card)
            continue

        rows = rows_for(raw_map, card)
        want = card.get("condition_code") or "NM"
        same = [r for r in rows if r.get("condition") == want]
        nm = [r for r in rows if r.get("condition") == "NM"]

        def split(rs):
            return [r for r in rs if r.get("zero")], [r for r in rs if not r.get("zero")]

        used_cond = want
        fallback = False
        if want == "NM":
            price, source = choose_nm(*split(nm))
        else:
            same_kept = drop_placeholders(same)
            if same_kept:
                price, source = same_kept[0]["price_eur"], "ct_condition"
            else:
                price, source = choose_nm(*split(nm))
                if price is not None:
                    fallback = True
                    used_cond = "NM"
        card["price_final_eur"] = price
        card["price_final_source"] = source
        card["price_condition"] = used_cond if price is not None else None
        card["fallback"] = fallback
        # helpful stock counts
        card["listings_same_condition"] = len(same)
        card["listings_nm"] = len(nm)
        z, c = split(nm)
        card["price_ctz_eur"] = drop_placeholders(z)[0]["price_eur"] if drop_placeholders(z) else None
        card["price_ct_eur"] = drop_placeholders(c)[0]["price_eur"] if drop_placeholders(c) else None
        apply_purchase_fallback(card)


def refresh_purchase(card: dict) -> None:
    """Keep purchase gain aligned with today's market price.

    CardTrader and Collectr costs stay as recorded. A market_fallback cost
    tracks the current Italian price, so its gain stays zero. Cards with
    neither a market price nor a purchase cost are left unset.
    """
    price = card.get("price_final_eur")
    qty = card.get("quantity") or 1
    if card.get("purchase_source") == "market_fallback" and isinstance(price, (int, float)):
        card["purchase_price_eur"] = price
        card["purchase_cost_eur"] = round(price * qty, 2)
        prices = card.get("purchase_prices_eur")
        if isinstance(prices, list) and len(prices) == qty:
            card["purchase_prices_eur"] = [price] * qty
    cost = card.get("purchase_cost_eur")
    if isinstance(price, (int, float)) and isinstance(cost, (int, float)):
        gain = round(price * qty - cost, 2)
        card["gain_eur"] = gain
        card["gain_pct"] = round(gain / cost * 100, 2) if cost else None
    else:
        card["gain_eur"] = None
        card["gain_pct"] = None


def portfolio_totals(cards: list[dict]) -> dict:
    value = spent = 0.0
    for card in cards:
        price = card.get("price_final_eur")
        qty = card.get("quantity") or 1
        line = round(price * qty, 2) if isinstance(price, (int, float)) else None
        cost = card.get("purchase_cost_eur")
        if line is None and not isinstance(cost, (int, float)):
            continue
        if line is not None:
            value += line
        spent += cost if isinstance(cost, (int, float)) else line
    value = round(value, 2)
    spent = round(spent, 2)
    gain = round(value - spent, 2)
    return {
        "value_total_eur": value,
        "spent_total_eur": spent,
        "gain_eur": gain,
        "gain_pct": round(gain / spent * 100, 2) if spent else None,
    }


def update_wishlist(cards: list[dict], date: str) -> None:
    data = json.loads(WISHLIST.read_text())
    idmap = {c["id"]: c for c in cards}
    for rec in data["cards"]:
        rec.update(idmap.get(rec["id"], {}))
        apply_purchase_fallback(rec)
        refresh_purchase(rec)
    priced = [c for c in data["cards"] if isinstance(c.get("price_final_eur"), (int, float))]
    total = round(sum(c["price_final_eur"] * c.get("quantity", 1) for c in priced), 2)
    non_nm = [c for c in data["cards"] if not c.get("graded") and (c.get("condition_code") or "NM") != "NM"]
    same_ok = [c for c in non_nm if c.get("price_final_eur") is not None and not c.get("fallback") and c.get("price_condition") == c.get("condition_code") and c.get("price_final_source") != "purchase_fallback"]
    fell = [c for c in non_nm if c.get("fallback")]
    unpriced_nnm = [c for c in non_nm if c.get("price_final_eur") is None]
    graded = [c for c in data["cards"] if c.get("graded")]
    data["generated_at"] = datetime.now(eu.TZ).isoformat(timespec="seconds")
    data["summary"].update({
        "cards": len(data["cards"]),
        "copies": sum(c.get("quantity", 1) for c in data["cards"]),
        "priced": len(priced),
        "priced_copies": sum(c.get("quantity", 1) for c in priced),
        "total_eur": total,
        "unpriced": sum(1 for c in data["cards"] if c.get("price_final_eur") is None),
        "non_nm_cards": len(non_nm),
        "non_nm_same_condition_priced": len(same_ok),
        "non_nm_fallback_to_nm": len(fell),
        "non_nm_unpriced": len(unpriced_nnm),
        "graded": len(graded),
        "graded_priced": sum(1 for c in graded if c.get("price_final_eur") is not None),
        "date": date,
        **portfolio_totals(data["cards"]),
    })
    WISHLIST.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n")
    print(
        f"updated {WISHLIST} priced={len(priced)}/{len(data['cards'])} total=€{total:.2f} "
        f"non-NM same={len(same_ok)} fallback={len(fell)} unpriced_nnm={len(unpriced_nnm)} "
        f"graded_priced={sum(1 for c in graded if c.get('price_final_eur') is not None)}/{len(graded)}",
        flush=True,
    )


def main() -> int:
    cards = json.loads(WISHLIST.read_text())["cards"]
    # if --prices-only, skip fetch
    prices_only = "--prices-only" in sys.argv
    if prices_only:
        raw = json.loads(OUT_RAW.read_text()) if OUT_RAW.exists() else {"listings": {}}
        graded = json.loads(OUT_GRADED.read_text()) if OUT_GRADED.exists() else {"listings": {}}
    else:
        raw = fetch_raw_cards(cards)
        graded = fetch_graded_cards(cards)
    apply_prices(cards, raw, graded)
    update_wishlist(cards, raw.get("date") or eu.today_rome())
    errors = (raw.get("errors") or []) + (graded.get("errors") or [])
    for line in errors:
        print(f"ERROR {line}", flush=True)
    return 1 if errors else 0


if __name__ == "__main__":
    sys.exit(main())
