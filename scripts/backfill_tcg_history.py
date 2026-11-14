#!/usr/bin/env python3
"""Backfill per-card daily prices from TCGNotify for 2026-10-15..2026-11-13.

The CardTrader series is Near Mint in the target language and does not split
Zero from normal sellers, so the reconstructed price is that minimum. If it is
missing, the Cardmarket minimum is used. A missing day can repeat the last
real price for at most 7 days, the same carry already used for the total.
Longer gaps stay empty. Official daily snapshots from 2026-11-10 onward are
left untouched.
"""
import csv
import json
import os
from datetime import datetime, timedelta

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
START = datetime.strptime("2026-10-15", "%Y-%m-%d").date()
END = datetime.strptime("2026-11-13", "%Y-%m-%d").date()
OFFICIAL_FROM = "2026-11-10"
CARRY = 7
FIELDS = ["date", "card_id", "blueprint_id", "name", "set_code", "number", "price_eur",
          "language", "condition", "listings_count", "source", "kind",
          "price_ctz_eur", "price_ct_eur", "price_avg_eur"]


def load(path):
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def points(series):
    out = {}
    for point in series or []:
        if not isinstance(point, dict) or not point.get("date"):
            continue
        value = point.get("min")
        if isinstance(value, (int, float)) and value > 0:
            out[point["date"][:10]] = point
    return out


def backfill(data_dir):
    cards = load(os.path.join(data_dir, "wishlist.json"))["cards"]
    history = load(os.path.join(data_dir, "tcgnotify_history.json"))
    path = os.path.join(data_dir, "price_history.csv")
    rows = list(csv.DictReader(open(path, encoding="utf-8")))
    official = set()
    kept = []
    for row in rows:
        official_row = (
            row.get("kind") == "daily_snapshot"
            and row.get("date", "") >= OFFICIAL_FROM
            and row.get("source") != "tcgnotify"
        )
        if official_row:
            official.add((row["card_id"], row["date"], row.get("language") or ""))
        drop = (
            row.get("source") == "tcgnotify"
            and row.get("kind") == "daily_snapshot"
            and START.isoformat() <= row.get("date", "") <= END.isoformat()
        )
        if not drop:
            kept.append(row)
    added = 0
    for card in cards:
        lang = card.get("target_language") or "it"
        series = history.get(card["id"]) if isinstance(history.get(card["id"]), dict) else {}
        ct = points(series.get("cardtrader"))
        cm = points(series.get("cardmarket"))
        last = None
        day = START - timedelta(days=CARRY)
        while day <= END:
            key = day.isoformat()
            real = None
            if key in ct:
                point = ct[key]
                real = ("ct", float(point["min"]), point.get("avg"), point.get("copies"))
            elif key in cm:
                point = cm[key]
                real = ("cm", float(point["min"]), point.get("avg"), point.get("copies"))
            chosen = None
            if real:
                last = (day, real)
                chosen = real
            elif last and 0 < (day - last[0]).days <= CARRY:
                chosen = last[1]
            if chosen and START <= day <= END and (card["id"], key, lang) not in official:
                kind, price, avg, copies = chosen
                fresh = bool(real) and last is not None and day == last[0]
                copies_out = ""
                avg_out = ""
                if fresh and isinstance(copies, (int, float)):
                    copies_out = int(copies) if float(copies) == int(copies) else copies
                if fresh and isinstance(avg, (int, float)):
                    avg_out = round(float(avg), 2)
                kept.append({
                    "date": key,
                    "card_id": card["id"],
                    "blueprint_id": card.get("cardtrader_blueprint_id") or "",
                    "name": card.get("name") or "",
                    "set_code": card.get("set_code") or "",
                    "number": card.get("number") or "",
                    "price_eur": round(price, 2),
                    "language": lang,
                    "condition": "Near Mint",
                    "listings_count": copies_out,
                    "source": "tcgnotify",
                    "kind": "daily_snapshot",
                    "price_ctz_eur": "",
                    "price_ct_eur": round(price, 2) if kind == "ct" else "",
                    "price_avg_eur": avg_out,
                })
                added += 1
            day += timedelta(days=1)
    kept.sort(key=lambda r: (r["card_id"], r["date"], r["kind"], r.get("language") or ""))
    with open(path, "w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=FIELDS, extrasaction="ignore")
        writer.writeheader()
        writer.writerows(kept)
    print(data_dir, "backfill rows", added)


if __name__ == "__main__":
    backfill(os.path.join(ROOT, "data"))
    backfill(os.path.join(ROOT, "data", "collections", "gold"))
