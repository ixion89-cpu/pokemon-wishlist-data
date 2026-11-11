# Pokémon Wishlist – modern · backend dati

Backend statico (GitHub Pages) con la buying list della wishlist "Wishlist - modern" di Leopoldo Montini
(67 carte), ordinata per prezzo. Pensato per essere collegato a ChatGPT Sites o a qualsiasi interfaccia.

**Tre listini NM**, lingua target (italiano, oppure giapponese per la carta solo JP), non gradate, spedizione esclusa. Il prezzo è `price.cents / 100`: è già il prezzo mostrato da CardTrader, fee inclusa, senza un'altra fee aggiunta.

| campo | significato |
|---|---|
| `price_ctz_eur` | minimo dei venditori CardTrader Zero (`user.can_sell_via_hub` true) |
| `price_ct_eur` | minimo dei soli venditori normali (`can_sell_via_hub` false). Non è il minimo complessivo |
| `price_avg_eur` | media pesata sulla `quantity` di tutti gli annunci NM validi (Zero e normali) con quantità > 0 |
| `listings_ctz` / `qty_ctz` | annunci e copie Zero |
| `listings_ct` / `qty_ct` | annunci e copie dei venditori normali |
| `listings_nm` / `qty_nm` | annunci e copie di tutti i venditori |

L'app sceglie il listino (CTZ, CT o Media; default CTZ). Se manca quel prezzo usa il successivo disponibile e lo segnala.

**Prezzo di riferimento (`buy_price_eur`):** minimo Zero se c'è almeno una copia, altrimenti il minimo di tutti i venditori. `buy_price_source` vale `zero` oppure `cardtrader`. `total_eur` e tier nel JSON usano questo prezzo. Spedizione esclusa, copie gradate escluse.

**Totale Zero (`zero_total_eur`):** somma dei soli minimi Zero. Una carta senza copia Zero non entra in questo totale, ma resta in `total_eur` se ha un minimo CardTrader.

## URL pubblici (dopo l'attivazione di GitHub Pages)
| File | URL |
|---|---|
| App | https://ixion89-cpu.github.io/pokemon-wishlist-data/app/ |
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
  cards: [ ... ]   // ordinate per buy_price_eur, dal più alto al più basso
}
```
`priced` e `total_eur` contano `buy_price_eur` (Zero se c'è, altrimenti il minimo di tutti i venditori). `zero_priced` e `zero_total_eur` contano solo le carte con una copia Zero.

Campi di ogni carta:
| campo | significato |
|---|---|
| `id` | id stabile `p<pagina>-<posizione>` nell'app (ordine di inserimento) |
| `order` | posizione d'inserimento (1–67) |
| `rank_by_price` | posizione nella classifica per prezzo (1 = più cara) |
| `name`, `set`, `set_code`, `number`, `rarity` | identificazione carta |
| `target_language` | `it` (oppure `jp` per carte solo giapponesi) |
| `release_year` | anno di uscita dell'espansione (da `expansion.released_at` di CardTrader, altrimenti `data/set_years.json`) |
| `italian_edition_exists` | false = la carta non esiste in italiano |
| `price_min_ita_nm_eur` | **prezzo minimo ITA NM** (null se nessuna copia ITA NM in vendita o carta non ITA) |
| `price_min_target_lang_nm_eur` | minimo NM nella lingua target, tutti i venditori |
| `buy_price_eur` | prezzo di riferimento: minimo Zero se esiste, altrimenti `price_min_target_lang_nm_eur` |
| `buy_price_source` | `zero` oppure `cardtrader` (null se nessuno dei due prezzi c'è) |
| `price_2nd_target_lang_nm_eur` | seconda offerta più bassa (utile per capire se il minimo è un'occasione isolata) |
| `listings_target_lang_nm` | quante copie NM nella lingua target sono in vendita |
| `price_min_ita_nm_zero_eur` | minimo ITA NM solo venditori CardTrader Zero (null se non c'è nessuna copia Zero, o se la lingua target non è l'italiano) |
| `price_min_target_lang_nm_zero_eur` | minimo NM nella lingua target solo venditori CardTrader Zero (null se non c'è nessuna copia Zero) |
| `listings_target_lang_nm_zero` | quante copie NM nella lingua target sono in vendita da venditori CardTrader Zero (`0` se non ce ne sono) |
| `offers_zero` / `offers_ct` | fino a 5 annunci Near Mint non gradati più economici, venditori Zero e venditori normali. Ogni riga ha `username`, `user_id`, `country_code`, `price_eur`, `quantity`, `avg_rating_percentage`, `feedbacks_count` e, per Zero, `ct_zero_avg_shipping_days` |
| `qty_mint_nm_target_lang` | copie in vendita in lingua target, Mint o Near Mint, non gradate: un solo totale, venditori Zero compresi |
| `listings_mint_nm_target_lang` | quanti sono quegli annunci |
| `price_min_any_lang_nm_eur` | minimo NM in qualsiasi lingua (riferimento / fallback) |
| `ct_market_all_lang_eur` | "CT market" CardTrader (tutte le lingue), ultimo valore del grafico |
| `tier` | `A: <50€`, `B: 50-150€`, `C: >150€` |
| `price_source`, `last_updated` | provenienza e timestamp del prezzo |
| `confidence` | affidabilità dell'identificazione (`alta`/`media`) |
| `notes` | avvertenze (carte JP, identificazioni da verificare…) |
| `cardtrader_link`, `cardtrader_blueprint_id`, `image_url` | link e immagine CardTrader |

## Schema `data/price_history.csv` (append-only)
`date, card_id, blueprint_id, name, set_code, number, price_eur, language, condition, listings_count, source, kind, price_ctz_eur, price_ct_eur, price_avg_eur`

Le righe già presenti restano. Le colonne nuove sono vuote finché lo snapshot del giorno non le compila. `price_eur` delle righe vecchie non cambia.
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
L'app statica in `app/` legge `data/wishlist.json`, `data/history/index.json` più gli snapshot giornalieri, `data/price_history.csv` e `data/purchases.json`. Una collezione nuova si aggiunge in `data/collections.json`.

## Acquisti `data/purchases.json`

Lista permanente delle carte già comprate. Parte da `[]`. Lo script giornaliero non la scrive e non la cancella.

```json
[{"id": "id come in wishlist.json", "purchased_on": "YYYY-MM-DD", "price_paid_eur": 12.5}]
```

`price_paid_eur` può essere `null`. L'app unisce questo file con gli acquisti segnati nel browser. Quelli del browser restano su quel dispositivo finché non vengono scritti in questo file.
