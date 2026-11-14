# Pokémon Wishlist – modern · backend dati

Backend statico (GitHub Pages) con la buying list della wishlist "Wishlist - modern" di Leopoldo Montini
(74 carte), ordinata per prezzo. Pensato per essere collegato a ChatGPT Sites o a qualsiasi interfaccia.

**Prezzo unico (`price_final_eur`)**, Near Mint in lingua target (italiano, giapponese solo per Togepi), non gradato, spedizione esclusa. Il prezzo è `price.cents / 100`, già con la fee di CardTrader.

1. Default: minimo CardTrader Zero (`price_ctz_eur`).
2. Si usa il CardTrader normale (`price_ct_eur`) se non c'è nessuno Zero, oppure se lo Zero costa più del 20% (`price_ctz_eur > price_ct_eur * 1.20`).
3. Se mancano entrambi, si usa Cardmarket (`price_cm_eur`) quando c'è.

`price_final_source` vale `ctz`, `ct` o `cm`. `buy_price_eur` e `total_eur` sono lo stesso prezzo. `price_avg_eur` resta nei dati e non è un listino dell'app.

L'Action delle 07:00 (Roma) gira su un runner USA: CardTrader da lì nasconde molti venditori diretti italiani. Se `data/cardtrader_eu_raw.json` ha `date` uguale a oggi o a ieri, per quei blueprint i prezzi CTZ/CT/media si calcolano da quel file invece che dal fetch.

```json
{
  "date": "2026-11-11",
  "listings": {
    "127519": [
      {"price_eur": 2700.64, "qty": 1, "zero": true},
      {"price_eur": 1100.64, "qty": 2, "zero": false}
    ]
  }
}
```

`data/cardmarket.json` è un dizionario id carta → `{ "min_eur", "avg_eur", "copies", "date" }`. Vuoto finché non lo riempi. Lo script copia `min_eur` in `price_cm_eur`.

`data/tcgnotify_history.json` è un dizionario id carta → `{ "cardtrader": [{"date","min","avg","copies"}], "cardmarket": [...] }`. CardTrader è solo Near Mint. Cardmarket è la serie per lingua, tutte le condizioni. L'app usa i punti prima del 10 nov 2026 e li segna «storico TCGNotify». Lo script non sovrascrive questi file, come non sovrascrive `purchases.json`.

`data/total_history.json` lo rigenera lo script. Fino al 9 nov 2026 il totale di ogni giorno è il minimo CardTrader NM di TCGNotify, altrimenti il minimo Cardmarket se non supera 3 volte la mediana CardTrader di quella carta, altrimenti l'ultimo prezzo entro 7 giorni. Dal 10 nov 2026 si usa `price_final` degli snapshot. Il tab MAX parte dal primo giorno con almeno 60 carte (o dal primo giorno, se la collezione ne ha meno di 60).

La collezione Gold sta in `data/collections/gold/`. Il file EU da aggiornare ogni giorno prima delle 07:00 è `data/collections/gold/cardtrader_eu_raw.json`, stesso formato della wishlist. `cardmarket.json` e `tcgnotify_history.json` alimentano la pagina carta. `total_history.json` è una ricostruzione a gradini: una carta entra il primo giorno in cui ha un prezzo, e un giorno c'è solo se tutte le carte già uscite hanno un prezzo. Il grafico usa il tratteggio per i giorni ricostruiti e un pallino giallo nei giorni in cui sale il numero di carte. L'aggiornamento quotidiano lascia intatti quei gradini e ricalcola solo lo snapshot. L'Action delle 07:00 aggiorna la wishlist e poi Gold con `--collection gold --eu-only`.

## Pop

`pop_history.json` è l'archivio delle copie italiane in vendita, una serie per carta: `{date, ct_it, ct_it_src, ct_it_all, ct_it_all_src, cm_it, total, total_all}`. `ct_it` sono le copie CardTrader in lingua target, Near Mint e non gradate. `ct_it_all` è lo stesso conteggio su tutte le condizioni. `cm_it` sono le copie Cardmarket in lingua target, tutte le condizioni, prese da TCGNotify. La formula della pop è `total = ct_it + cm_it` (CardTrader ITA NM + Cardmarket ITA). `total_all = ct_it_all + cm_it`. Un valore mancante resta `null` e un giorno mancante non viene riempito.

`pop_summary.json` riassume l'ultimo giorno con un `total` (`pop_total_now`, `pop_date`, `ct_it_now`, `cm_it_now`) e la variazione a 30 giorni (`pop_change_30d_pct`): il totale di quel giorno contro il totale di 30 giorni prima, oppure il giorno più vicino entro ±3 giorni. `ct_latest` è solo CardTrader e si aggiorna dal box EU. `cm_it` cambia solo quando si unisce un dump TCGNotify con `scripts/update_pop.py --tcgnotify`, quindi `total` può restare indietro rispetto a `ct_latest`. Lo script gira sul box in Europa alle 06:30 e non è nell'Action di GitHub: da un IP USA i venditori italiani diretti non si vedono. Rieseguirlo lo stesso giorno sostituisce solo i valori di quella data.

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
| `order` | posizione d'inserimento (1–74) |
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
