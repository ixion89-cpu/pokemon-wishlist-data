# Pokémon Wishlist – modern · backend dati

Backend statico (GitHub Pages) con la buying list della wishlist "Wishlist - modern" di Leopoldo Montini
(67 carte), ordinata per prezzo. Pensato per essere collegato a ChatGPT Sites o a qualsiasi interfaccia.

**Prezzo di riferimento:** minimo CardTrader per copia **italiana, Near Mint, non gradata** (spedizione esclusa).
Per le carte che esistono solo in giapponese (`target_language = "jp"`) si usa il minimo NM in giapponese.

**Prezzo CardTrader Zero:** stesso filtro (lingua target, Near Mint, non gradata, spedizione esclusa), solo annunci di venditori CardTrader Zero. Nel JSON pubblico sono i prodotti con `user.can_sell_via_hub = true` (il venditore spedisce tramite l'hub CardTrader). Non sostituisce il prezzo di riferimento: ordinamento, `buy_price_eur` e tier restano sul minimo di tutti i venditori.

## URL pubblici (dopo l'attivazione di GitHub Pages)
| File | URL |
|---|---|
| Wishlist JSON | https://ixion89-cpu.github.io/pokemon-wishlist-data/data/wishlist.json |
| Wishlist CSV | https://ixion89-cpu.github.io/pokemon-wishlist-data/data/wishlist.csv |
| Storico prezzi CSV | https://ixion89-cpu.github.io/pokemon-wishlist-data/data/price_history.csv |
| Snapshot del giorno | https://ixion89-cpu.github.io/pokemon-wishlist-data/data/history/YYYY-MM-DD.json |
| Anagrafica carte | https://ixion89-cpu.github.io/pokemon-wishlist-data/data/cards.json |

GitHub Pages risponde con `Access-Control-Allow-Origin: *`, quindi i file si possono leggere da qualsiasi sito.

## Schema `data/wishlist.json`
```
{ generated_at, currency: "EUR", price_definition, zero_definition,
  summary: { cards, priced, total_eur, zero_priced, zero_total_eur,
             tiers: {"A: <50€", "B: 50-150€", "C: >150€", "n/d"} },
  cards: [ ... ]   // già ordinate dal prezzo più alto al più basso (minimo non-Zero)
}
```
`zero_priced` è il numero di carte con almeno una copia Near Mint di un venditore Zero nella lingua target. `zero_total_eur` è la somma di quei minimi. `zero_definition` ripete il criterio del prezzo di riferimento limitato ai venditori Zero.

Campi di ogni carta:
| campo | significato |
|---|---|
| `id` | id stabile `p<pagina>-<posizione>` nell'app (ordine di inserimento) |
| `order` | posizione d'inserimento (1–67) |
| `rank_by_price` | posizione nella classifica per prezzo (1 = più cara) |
| `name`, `set`, `set_code`, `number`, `rarity` | identificazione carta |
| `target_language` | `it` (oppure `jp` per carte solo giapponesi) |
| `italian_edition_exists` | false = la carta non esiste in italiano |
| `price_min_ita_nm_eur` | **prezzo minimo ITA NM** (null se nessuna copia ITA NM in vendita o carta non ITA) |
| `price_min_target_lang_nm_eur` / `buy_price_eur` | minimo NM nella lingua target (usato per ordinare e per i tier) |
| `price_2nd_target_lang_nm_eur` | seconda offerta più bassa (utile per capire se il minimo è un'occasione isolata) |
| `listings_target_lang_nm` | quante copie NM nella lingua target sono in vendita |
| `price_min_ita_nm_zero_eur` | minimo ITA NM solo venditori CardTrader Zero (null se non c'è nessuna copia Zero, o se la lingua target non è l'italiano) |
| `price_min_target_lang_nm_zero_eur` | minimo NM nella lingua target solo venditori CardTrader Zero (null se non c'è nessuna copia Zero) |
| `listings_target_lang_nm_zero` | quante copie NM nella lingua target sono in vendita da venditori CardTrader Zero (`0` se non ce ne sono) |
| `price_min_any_lang_nm_eur` | minimo NM in qualsiasi lingua (riferimento / fallback) |
| `ct_market_all_lang_eur` | "CT market" CardTrader (tutte le lingue), ultimo valore del grafico |
| `tier` | `A: <50€`, `B: 50-150€`, `C: >150€` |
| `price_source`, `last_updated` | provenienza e timestamp del prezzo |
| `confidence` | affidabilità dell'identificazione (`alta`/`media`) |
| `notes` | avvertenze (carte JP, identificazioni da verificare…) |
| `cardtrader_link`, `cardtrader_blueprint_id`, `image_url` | link e immagine CardTrader |

## Schema `data/price_history.csv` (append-only)
`date, card_id, blueprint_id, name, set_code, number, price_eur, language, condition, listings_count, source, kind`
- `kind = daily_snapshot`: minimo del giorno da annunci CardTrader, condizione Near Mint.
  - `language = it` o `jp`: lingua target, tutti i venditori, `source = cardtrader_listings_min`.
  - `language = it_zero` o `jp_zero`: stesso minimo ma solo venditori CardTrader Zero, `source = cardtrader_zero_listings_min`. La riga c'è anche se non c'è nessuna copia Zero (`price_eur` vuoto, `listings_count = 0`).
  - `language = any`: qualsiasi lingua, `source = cardtrader_listings_min` (solo se esiste almeno un annuncio NM).
- `kind = backfill`: storico recuperato a ritroso. CardTrader pubblica solo il grafico "CT market" **per tutte le lingue** (~40 giorni), salvato con `source = cardtrader_ct_market_graph_all_languages`, `language = all`. Non è uno storico ITA: lo storico ITA NM vero parte dagli snapshot giornalieri.

## Aggiornamento
```
python3 scripts/update_prices.py --commit
```
Il workflow `.github/workflows/daily.yml` lo esegue ogni giorno alle 06:00 UTC (07:00 a Roma) e fa il commit.
Per aggiungere/togliere carte modificare `data/cards.json` (serve `cardtrader_blueprint_id`).
