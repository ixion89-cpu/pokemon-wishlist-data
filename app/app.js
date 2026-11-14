const DATA = new URL("../data/", document.baseURI);
const PAGE_SIZE = 9;
const state = {
  collections: [],
  payloads: new Map(),
  historyIndex: null,
  history: new Map(),
  csv: null,
  filters: loadFilters(),
  page: Number(sessionStorage.getItem("wl-page") || 0),
  sort: sessionStorage.getItem("wl-sort") || "desc",
  cardRange: "30G",
  chartMarket: "cardtrader",
  totalRange: "MAX",
  perfRange: "MAX",
  perfId: sessionStorage.getItem("wl-perf") || "",
  sheet: false,
};

const view = document.getElementById("view");
const titleEl = document.getElementById("title");
const eyebrowEl = document.getElementById("eyebrow");

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}
function num(v) {
  if (v == null || v === "") return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}
function money(v) {
  const n = num(v);
  if (n == null) return "n/d";
  return new Intl.NumberFormat("it-IT", { style: "currency", currency: "EUR", useGrouping: true }).format(n);
}
function signedMoney(v) {
  const n = num(v);
  if (n == null) return "";
  const body = new Intl.NumberFormat("it-IT", { style: "currency", currency: "EUR", useGrouping: true }).format(Math.abs(n));
  return (n > 0 ? "+" : n < 0 ? "−" : "") + body;
}
function pct(v) {
  const n = num(v);
  if (n == null) return "";
  const body = new Intl.NumberFormat("it-IT", { maximumFractionDigits: 1, minimumFractionDigits: 1 }).format(Math.abs(n));
  return (n > 0 ? "+" : n < 0 ? "−" : "") + body + "%";
}
function hasOwn(obj, key) {
  return Object.prototype.hasOwnProperty.call(obj || {}, key);
}
function chooseFinal(ctz, ct, cm) {
  if (ctz != null && ct != null && ctz > ct * 1.2) return { price: ct, source: "ct" };
  if (ctz != null) return { price: ctz, source: "ctz" };
  if (ct != null) return { price: ct, source: "ct" };
  if (cm != null) return { price: cm, source: "cm" };
  return { price: null, source: null };
}
function quote(card) {
  if (hasOwn(card, "price_final_eur")) {
    const price = num(card.price_final_eur);
    if (price != null) return { price, source: card.price_final_source || null };
  }
  const ctz = num(card.price_ctz_eur);
  const ctzLegacy = ctz != null || hasOwn(card, "price_ctz_eur") ? ctz : num(card.price_min_target_lang_nm_zero_eur);
  const picked = chooseFinal(ctzLegacy, num(card.price_ct_eur), num(card.price_cm_eur));
  if (picked.price != null) return picked;
  const buy = num(card.buy_price_eur);
  if (buy == null) return { price: null, source: null };
  return { price: buy, source: card.buy_price_source === "cardtrader" ? "ct" : "ctz" };
}
function sourceName(source) {
  if (source === "cm") return "CARDMARKET";
  if (source === "ct") return "CARDTRADER";
  return "CARDTRADER ZERO";
}
function badge(source) {
  if (source === "zero") return '<span class="badge zero">Zero</span>';
  if (source === "cardtrader") return '<span class="badge ct">CT</span>';
  return "";
}
function langOf(code) {
  if (code === "jp") return { flag: "🇯🇵", name: "Giapponese" };
  return { flag: "🇮🇹", name: "Italiano" };
}
function dayKey(iso) {
  return String(iso || "").slice(0, 10);
}
function dateNum(iso) {
  const [y, m, d] = dayKey(iso).split("-").map(Number);
  return Math.floor(Date.UTC(y, m - 1, d) / 86400000);
}
function addDays(iso, days) {
  const [y, m, d] = dayKey(iso).split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + days));
  return dt.toISOString().slice(0, 10);
}
function formatDay(iso) {
  const [y, m, d] = dayKey(iso).split("-").map(Number);
  if (!y) return "";
  return new Intl.DateTimeFormat("it-IT", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }).format(new Date(Date.UTC(y, m - 1, d)));
}
function romeToday() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Rome", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
}
function safeUrl(url) {
  try {
    const u = new URL(url);
    if (u.protocol === "https:") return u.href;
  } catch (e) { /* ignore */ }
  return "";
}
function loadFilters() {
  try { return JSON.parse(sessionStorage.getItem("wl-filters") || "{}"); }
  catch (e) { return {}; }
}
function saveFilters() {
  sessionStorage.setItem("wl-filters", JSON.stringify(state.filters));
  sessionStorage.setItem("wl-page", String(state.page));
  sessionStorage.setItem("wl-sort", state.sort);
}
function filtersFor(id) {
  if (!state.filters[id]) {
    state.filters[id] = { q: "", years: [], sets: [], rarities: [], langs: [], tiers: [], zeroOnly: false, buy: "todo" };
  }
  if (!state.filters[id].buy) state.filters[id].buy = "todo";
  return state.filters[id];
}
function purchaseStorageKey() {
  const id = state.collectionId || "wishlist-modern";
  return id === "wishlist-modern" ? "wl-purchases" : "wl-purchases-" + id;
}
async function loadPurchaseFile() {
  const meta = activeCollection();
  const id = (meta && meta.id) || "wishlist-modern";
  if (!state.purchaseFiles) state.purchaseFiles = {};
  if (state.purchaseFiles[id]) {
    state.filePurchases = state.purchaseFiles[id];
    return state.filePurchases;
  }
  try {
    const data = await getJson((meta && meta.purchases) || "purchases.json");
    state.filePurchases = Array.isArray(data) ? data : [];
  } catch (e) {
    state.filePurchases = [];
  }
  state.purchaseFiles[id] = state.filePurchases;
  return state.filePurchases;
}
function localPurchaseOverrides() {
  try {
    const raw = JSON.parse(localStorage.getItem(purchaseStorageKey()) || "{}");
    return raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  } catch (e) {
    return {};
  }
}
function normalizePurchase(row) {
  return {
    id: String(row.id),
    purchased_on: dayKey(row.purchased_on) || null,
    price_paid_eur: num(row.price_paid_eur),
  };
}
function purchaseMap() {
  const map = new Map();
  for (const row of state.filePurchases || []) {
    if (row && row.id) map.set(String(row.id), normalizePurchase(row));
  }
  const local = localPurchaseOverrides();
  for (const [id, value] of Object.entries(local)) {
    if (value == null) map.delete(String(id));
    else map.set(String(id), normalizePurchase({ id, ...value }));
  }
  return map;
}
function purchaseOf(id) {
  return purchaseMap().get(String(id)) || null;
}
function setPurchaseOverride(id, value) {
  const all = localPurchaseOverrides();
  all[String(id)] = value;
  localStorage.setItem(purchaseStorageKey(), JSON.stringify(all));
}
function basketOf(cards) {
  const map = purchaseMap();
  let wishlist = 0, remain = 0, spent = 0, fallback = 0, bought = 0;
  for (const card of cards) {
    const price = quote(card).price;
    if (price != null) wishlist += price;
    const boughtRow = map.get(String(card.id));
    if (boughtRow) {
      bought += 1;
      if (boughtRow.price_paid_eur != null) spent += boughtRow.price_paid_eur;
      else if (price != null) { spent += price; fallback += 1; }
    } else if (price != null) remain += price;
  }
  return {
    wishlist, remain, spent, fallback, bought, total: cards.length,
    done: wishlist > 0 ? Math.max(0, Math.min(100, ((wishlist - remain) / wishlist) * 100)) : 0,
  };
}
function basketHtml(cards, generatedAt) {
  const b = basketOf(cards);
  const paidNote = b.fallback ? ` · ${b.fallback} senza prezzo pagato, contato il prezzo attuale` : "";
  return `<section class="basket" aria-label="Totali">
    ${sourceStamp(generatedAt)}
    <div class="tile mint"><p class="k">Totale wishlist</p><b class="nums">${money(b.wishlist)}</b><p class="meta">${b.total} carte</p></div>
    <div class="tile lilac"><p class="k">Già acquistate</p><b class="nums">${b.bought}/${b.total}</b><p class="meta">${money(b.spent)}${esc(paidNote)}</p></div>
    <div class="tile sun"><p class="k">Resta da spendere</p><b class="nums">${money(b.remain)}</b>
      <div class="bar" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.round(b.done)}" aria-label="Quota del valore già acquistata"><span style="width:${b.done.toFixed(1)}%"></span></div>
    </div>
  </section>`;
}
function sourceStamp(generatedAt) {
  const when = generatedAt ? formatDay(generatedAt) : "";
  return "";
}
async function getJson(path) {
  const res = await fetch(new URL(path, DATA));
  if (!res.ok) throw new Error(path + " " + res.status);
  return res.json();
}
async function getText(path) {
  const res = await fetch(new URL(path, DATA));
  if (!res.ok) throw new Error(path + " " + res.status);
  return res.text();
}
function parseCsv(text) {
  const rows = [];
  let row = [], cur = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') {
        if (text[i + 1] === '"') { cur += '"'; i++; }
        else q = false;
      } else cur += c;
    } else if (c === '"') q = true;
    else if (c === ",") { row.push(cur); cur = ""; }
    else if (c === "\n") { row.push(cur); rows.push(row); row = []; cur = ""; }
    else if (c !== "\r") cur += c;
  }
  if (cur.length || row.length) { row.push(cur); rows.push(row); }
  const headers = rows.shift() || [];
  return rows.filter((r) => r.length >= headers.length && r.some(Boolean)).map((r) => {
    const obj = {};
    headers.forEach((h, i) => { obj[h] = r[i] ?? ""; });
    return obj;
  });
}
function collectionFromUrl() {
  const value = new URLSearchParams(location.search).get("c");
  if (!value) return "";
  if (value === "gold" || value === "gold-modern") return "gold-modern";
  if (value === "wishlist" || value === "wishlist-modern") return "wishlist-modern";
  return "";
}
function activeCollection() {
  return state.collections.find((c) => c.id === state.collectionId) || state.collections[0];
}
function pickCollection() {
  const fromUrl = collectionFromUrl();
  if (fromUrl && state.collections.some((c) => c.id === fromUrl)) return fromUrl;
  const saved = localStorage.getItem("wl-collection");
  if (saved && state.collections.some((c) => c.id === saved)) return saved;
  return state.collections[0] ? state.collections[0].id : "";
}
function cardTitle(card) { return card.name_it || card.name || ""; }
function cardSetName(card) { return card.set_it || card.set || ""; }
function cardNumber(card) {
  if (card.number && card.set_total) return card.number + "/" + card.set_total;
  return card.number || "";
}
function sortModeFor(id) {
  const meta = state.collections.find((c) => c.id === id);
  const saved = sessionStorage.getItem("wl-sort-" + id);
  if (saved) return saved;
  if (meta && meta.order === "release") return "release";
  return state.sort || "desc";
}
function renderCollectionSwitch() {
  const el = document.getElementById("collection-switch");
  if (!el || !state.collections.length) return;
  el.innerHTML = state.collections.map((c) =>
    `<button class="chip ${c.id === state.collectionId ? "on" : ""}" type="button" data-collection="${esc(c.id)}">${esc(c.name)}</button>`
  ).join("");
}
function setCollection(id) {
  if (!id || id === state.collectionId) return;
  state.collectionId = id;
  localStorage.setItem("wl-collection", id);
  const url = new URL(location.href);
  url.searchParams.set("c", id === "gold-modern" ? "gold" : "wishlist");
  const here = route();
  if (here.name === "card" || here.name === "binder") url.hash = "#/c/" + encodeURIComponent(id);
  history.replaceState(null, "", url.pathname + url.search + url.hash);
  state.payloads = new Map();
  state.historyIndex = null;
  state.history = new Map();
  state.csv = null;
  state.extra = null;
  state.filePurchases = null;
  state.purchaseFiles = {};
  render();
}
async function loadCollections() {
  if (state.collections.length) return;
  state.collections = await getJson("collections.json");
  state.collectionId = pickCollection();
}
async function loadPayload(meta) {
  if (state.payloads.has(meta.id)) return state.payloads.get(meta.id);
  const payload = await getJson(meta.file);
  state.payloads.set(meta.id, payload);
  return payload;
}
async function loadHistory() {
  if (state.historyIndex) return;
  const meta = activeCollection();
  const indexPath = (meta && meta.history) || "history/index.json";
  state.historyIndex = await getJson(indexPath);
  const prefix = indexPath.replace(/index\.json$/, "");
  await Promise.all(state.historyIndex.map(async (date) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return;
    const payload = await getJson(prefix + date + ".json");
    state.history.set(date, payload);
  }));
}
async function loadCsv() {
  if (state.csv) return state.csv;
  const meta = activeCollection();
  const rows = parseCsv(await getText((meta && meta.csv) || "price_history.csv"));
  const byCard = new Map();
  rows.forEach((r) => {
    if (!byCard.has(r.card_id)) byCard.set(r.card_id, []);
    byCard.get(r.card_id).push(r);
  });
  state.csv = byCard;
  return byCard;
}
function pageValueOf(cards) {
  let total = 0, missing = 0;
  for (const card of cards) {
    const price = quote(card).price;
    if (price == null) missing += 1;
    else total += price;
  }
  return { total: Math.round(total * 100) / 100, missing };
}
function collectionTotal(cards) {
  let total = 0, priced = 0, zero = 0;
  cards.forEach((card) => {
    const q = quote(card);
    if (q.price != null) { total += q.price; priced += 1; }
    if (q.source === "zero") zero += 1;
  });
  return { total, priced, cards: cards.length, zero };
}
function tierOf(price) {
  if (price == null) return "n/d";
  if (price < 50) return "lt50";
  if (price <= 150) return "mid";
  return "gt150";
}
function applyFilters(cards, id) {
  const f = filtersFor(id);
  return cards.filter((card) => {
    const price = quote(card);
    if (f.years.length && !f.years.includes(String(card.release_year || ""))) return false;
    if (f.sets.length && !f.sets.includes(card.set)) return false;
    if (f.rarities.length && !f.rarities.includes(card.rarity)) return false;
    if (f.langs.length && !f.langs.includes(card.target_language)) return false;
    if (f.tiers.length && !f.tiers.includes(tierOf(price.price))) return false;
    if (f.zeroOnly && price.source !== "zero") return false;
    const bought = !!purchaseOf(card.id);
    if (f.buy === "bought" && !bought) return false;
    if ((f.buy || "todo") === "todo" && bought) return false;
    return true;
  }).slice().sort((a, b) => {
    const mode = sortModeFor(id);
    const byName = () => cardTitle(a).localeCompare(cardTitle(b), "it");
    const byPrice = () => {
      const pa = quote(a).price, pb = quote(b).price;
      if (pa == null && pb == null) return byName();
      if (pa == null) return 1;
      if (pb == null) return -1;
      if (pb !== pa) return pb - pa;
      return byName();
    };
    if (mode === "pop-desc" || mode === "pop-asc" || mode === "popchg-desc" || mode === "popchg-asc") {
      const pop = (state.extra && state.extra.pop) || {};
      const field = mode.indexOf("popchg") === 0 ? "pop_change_30d_pct" : "pop_total_now";
      const rawA = pop[a.id] ? pop[a.id][field] : null;
      const rawB = pop[b.id] ? pop[b.id][field] : null;
      const va = typeof rawA === "number" ? rawA : null;
      const vb = typeof rawB === "number" ? rawB : null;
      if (va == null && vb == null) return byPrice();
      if (va == null) return 1;
      if (vb == null) return -1;
      if (va !== vb) return mode.endsWith("asc") ? va - vb : vb - va;
      return byPrice();
    }
    const pa = quote(a).price, pb = quote(b).price;
    if (pa == null && pb == null) return byName();
    if (pa == null) return 1;
    if (pb == null) return -1;
    if (mode === "release") return (a.order || 0) - (b.order || 0) || byName();
    return mode === "asc" ? pa - pb : pb - pa;
  });
}
function art(card, className) {
  const src = safeUrl(card.image_url);
  if (!src) return `<div class="${className}"><span class="fallback">${esc((card.name || "?").slice(0, 1))}</span></div>`;
  return `<div class="${className}"><img src="${esc(src)}" alt="${esc(card.name)}"></div>`;
}
function ring(priced, total) {
  const C = 2 * Math.PI * 15;
  const frac = total ? priced / total : 0;
  return `<svg class="ring" viewBox="0 0 36 36" aria-hidden="true"><circle class="bg" cx="18" cy="18" r="15"></circle><circle class="fg" cx="18" cy="18" r="15" stroke-dasharray="${(C * frac).toFixed(2)} ${(C * (1 - frac)).toFixed(2)}"></circle></svg>`;
}
function setChrome(eyebrow, title, tab) {
  eyebrowEl.textContent = eyebrow;
  titleEl.textContent = title;
  document.querySelectorAll(".tabbar a").forEach((a) => a.classList.toggle("active", a.dataset.tab === tab));
  renderCollectionSwitch();
}
function route() {
  const parts = (location.hash.replace(/^#/, "") || "/").split("/").filter(Boolean);
  if (parts[0] === "performance") return { name: "performance" };
  if (parts[0] === "movers") return { name: "movers" };
  if (parts[0] === "c" && parts[1] && parts[2] === "card" && parts[3]) return { name: "card", id: decodeURIComponent(parts[1]), card: decodeURIComponent(parts[3]) };
  if (parts[0] === "c" && parts[1]) return { name: "binder", id: decodeURIComponent(parts[1]) };
  return { name: "home" };
}
function showError(err) {
  view.innerHTML = `<div class="empty"><strong>Dati non disponibili</strong><p>${esc(err.message || err)}</p></div>`;
}
async function render() {
  const r = route();
  state.sheet = false;
  if (!view.childElementCount) {
    view.innerHTML = `<div class="skeleton" aria-hidden="true"></div><div class="skeleton" aria-hidden="true"></div>`;
  }
  try {
    await loadCollections();
    await loadPurchaseFile();
    await loadExtra();
    if (r.name === "home") await renderHome();
    else if (r.name === "binder") await renderBinder(r.id);
    else if (r.name === "card") await renderCard(r.id, r.card);
    else if (r.name === "performance") await renderPerformance();
    else await renderMovers();
  } catch (err) {
    console.error(err);
    showError(err);
  }
}
function topByPrice(cards, n) {
  return cards.slice().sort((a, b) => {
    const pa = quote(a).price, pb = quote(b).price;
    if (pa == null && pb == null) return a.name.localeCompare(b.name, "it");
    if (pa == null) return 1;
    if (pb == null) return -1;
    if (pb !== pa) return pb - pa;
    return a.name.localeCompare(b.name, "it");
  }).slice(0, n);
}
function popOf(card) {
  const book = state.extra && state.extra.pop;
  return (book && book[card.id]) || {};
}
function popPctText(value, spaced) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "";
  const text = Math.abs(n).toLocaleString("it-IT", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  const arrow = n < 0 ? "▼" : "▲";
  return spaced ? `${arrow} ${text}%` : `${arrow}${text}%`;
}
const SLEEVE_KEY = "wl-binder-view";
function sleeveMode() {
  const saved = localStorage.getItem(SLEEVE_KEY);
  return saved === "expanded" ? "expanded" : "compact";
}
function sourceShort(source) {
  if (source === "cm") return "CM";
  if (source === "ct") return "CT";
  if (source === "ctz") return "CT Zero";
  return "";
}
function sleevePop(card) {
  const pop = popOf(card);
  if (typeof pop.pop_total_now !== "number") return "";
  const pct = pop.pop_change_30d_pct == null ? "" : " " + popPctText(pop.pop_change_30d_pct, false);
  const cls = pop.pop_change_30d_pct == null ? "" : pop.pop_change_30d_pct < 0 ? " down" : " up";
  return `<p class="pop-line nums${cls}">👥 ${pop.pop_total_now}${pct}</p>`;
}
function sleevePriceChange(card) {
  const change = changeOver(marketSeries(card).min, 30);
  if (!(change && change.start && change.days >= 29)) return "";
  const down = change.diff < 0;
  return `<p class="delta ${down ? "down" : "up"}">${down ? "▼" : "▲"} ${pct(change.pct)} · ${signedMoney(change.diff)}</p>`;
}
function popBlock(card) {
  const pop = popOf(card);
  const ctChange = pop.ct_change_30d_pct == null ? "" : ` · ${popPctText(pop.ct_change_30d_pct, true)} in 30 giorni`;
  const ctLine = typeof pop.ct_latest === "number"
    ? `<p class="quiet">Solo CardTrader: ${pop.ct_latest} copie al ${esc(formatDay(pop.ct_latest_date))}${ctChange}</p>`
    : "";
  if (!ctLine && typeof pop.pop_total_now !== "number") return "";
  if (typeof pop.pop_total_now !== "number") {
    return `<section class="popbox"><h2 class="section-title">Popolazione ITA</h2><p>Pop CT+CM non ancora disponibile</p>${ctLine}</section>`;
  }
  const delta = pop.pop_change_30d_pct == null ? "" : `<p class="delta ${pop.pop_change_30d_pct < 0 ? "down" : "up"}">${popPctText(pop.pop_change_30d_pct, true)} in 30 giorni</p>`;
  return `<section class="popbox"><h2 class="section-title">Popolazione ITA</h2>
    <p class="nums">${pop.pop_total_now} copie (CT ${pop.ct_it_now == null ? "n/d" : pop.ct_it_now} + CM ${pop.cm_it_now == null ? "n/d" : pop.cm_it_now}) · ${esc(formatDay(pop.pop_date))}</p>
    ${delta}${ctLine}</section>`;
}
function sleeveHtml(card, collectionId, mode) {
  const q = quote(card);
  const bought = purchaseOf(card.id);
  const src = safeUrl(card.image_url);
  const img = src
    ? `<img src="${esc(src)}" alt="${esc(card.name)}">`
    : `<span class="fallback">${esc((card.name || "?").slice(0, 1))}</span>`;
  const price = `<div class="price-line"><span class="price">${q.price == null ? "n/d" : money(q.price)}</span></div>`;
  if (mode === "compact") {
    return `<a class="sleeve sleeve-compact${bought ? " bought" : ""}" href="#/c/${encodeURIComponent(collectionId)}/card/${encodeURIComponent(card.id)}">
      <div class="art">${img}</div>
      ${price}
    </a>`;
  }
  if (mode !== "expanded") {
    return `<a class="sleeve${bought ? " bought" : ""}" href="#/c/${encodeURIComponent(collectionId)}/card/${encodeURIComponent(card.id)}">
      ${bought ? `<span class="bought-badge" aria-label="Acquistata">✅</span>` : ""}
      <div class="art">${img}</div>
      ${q.badge ? `<span class="src-badge"><span class="badge partial">${esc(q.badge)}</span></span>` : ""}
      ${price}
      <p class="name">${esc(cardTitle(card))}</p>
      <p class="meta num">${esc(cardNumber(card))}</p>
      ${sleevePop(card)}
    </a>`;
  }
  const pop = popOf(card);
  const source = sourceShort(q.source);
  const popLine = typeof pop.pop_total_now === "number"
    ? `<p class="pop-line nums${pop.pop_change_30d_pct == null ? "" : pop.pop_change_30d_pct < 0 ? " down" : " up"}">Pop ${pop.pop_total_now}${pop.pop_change_30d_pct == null ? "" : " " + popPctText(pop.pop_change_30d_pct, false)}</p>`
    : `<p class="meta">Pop CT+CM n/d</p>`;
  const ctOnly = typeof pop.ct_latest === "number" ? `<p class="meta">Solo CT ${pop.ct_latest}</p>` : "";
  const owned = bought ? `<p class="owned">✅ Acquistata${bought.purchased_on ? " · " + esc(formatDay(bought.purchased_on)) : ""}</p>` : "";
  const rarity = card.rarity ? `<p class="meta">${esc(card.rarity)}</p>` : "";
  return `<a class="sleeve sleeve-rich${bought ? " bought" : ""}" href="#/c/${encodeURIComponent(collectionId)}/card/${encodeURIComponent(card.id)}">
    <div class="art">${img}</div>
    ${price}
    ${source ? `<p class="src-label">${esc(source)}</p>` : ""}
    ${sleevePriceChange(card)}
    <p class="name">${esc(cardTitle(card))}</p>
    <p class="meta">${esc(cardSetName(card))}${cardNumber(card) ? " · " + esc(cardNumber(card)) : ""}</p>
    ${rarity}
    ${popLine}
    ${ctOnly}
    ${owned}
  </a>`;
}
function topPreview(collectionId, cards) {
  const top = topByPrice(cards, 3);
  if (!top.length) return "";
  return `<section class="top3" aria-label="Le tre carte più care">
    <p class="k">Le più care</p>
    <div class="grid">${top.map((card) => sleeveHtml(card, collectionId)).join("")}</div>
  </section>`;
}
const TOTAL_RANGES = [
  { id: "7G", label: "7G" },
  { id: "30G", label: "30G" },
  { id: "90G", label: "90G" },
  { id: "1A", label: "1A" },
  { id: "MAX", label: "MAX" },
];
function totalPointMeta(book, day, names, cardsTotal) {
  const events = (book.events || []).filter((event) => event.date === day.date);
  if (events.length) {
    const text = events.map((event) => {
      const who = (event.cards || []).map((id) => names[id] || id).filter(Boolean).join(", ");
      return who ? `${event.label}: ${who}` : event.label;
    }).join(" · ");
    const count = events.reduce((sum, event) => sum + (Number(event.count) || (event.cards || []).length), 0);
    return {
      title: `${formatDay(day.date)} · ${money(day.total_eur)} · ${text}`,
      marker: true,
      markerLabel: "+" + count,
    };
  }
  const included = Array.isArray(day.cards_included) ? day.cards_included.length : day.cards_priced;
  const first = book.card_first_price_day || {};
  const added = Object.keys(first).filter((id) => first[id] === day.date).map((id) => names[id] || id);
  const step = (book.steps || []).some((s) => s.date === day.date);
  const noun = included === 1 ? "carta" : "carte";
  let count = `${included} ${noun}`;
  if (added.length) count += ` · + ${added.join(", ")}`;
  else if (!day.cards_included) count = `carte conteggiate ${day.cards_priced}/${book.cards_total || cardsTotal || day.cards_priced}`;
  return {
    title: `${formatDay(day.date)} · ${money(day.total_eur)} · ${count}`,
    marker: step,
    markerLabel: step ? String(day.cards_count || included) : "",
  };
}
function totalSeries(range, cards) {
  const book = (state.extra && state.extra.totals) || {};
  const names = {};
  (cards || []).forEach((card) => { names[card.id] = cardTitle(card); });
  let pts = (book.days || []).map((d) => {
    const meta = totalPointMeta(book, d, names, (cards || []).length);
    return {
      date: d.date,
      value: d.total_eur,
      reconstructed: d.source !== "snapshot",
      title: meta.title,
      marker: meta.marker,
      markerLabel: meta.markerLabel,
    };
  });
  if (!pts.length) return { pts: [], recon: [], real: [], delta: null, maxFrom: book.max_from };
  if (range === "MAX" && book.max_from) pts = pts.filter((p) => p.date >= book.max_from);
  else if (range !== "MAX") pts = filterPoints(pts, range, pts[pts.length - 1].date);
  const real = pts.filter((p) => !p.reconstructed);
  const recon = pts.filter((p) => p.reconstructed);
  if (recon.length && real.length) recon.push(real[0]);
  const delta = changeOver(pts, pts.length ? dateNum(pts[pts.length - 1].date) - dateNum(pts[0].date) + 1 : 0);
  return { pts, recon, real, delta, maxFrom: book.max_from };
}
function totalChartHtml(cards) {
  if (!TOTAL_RANGES.some((r) => r.id === state.totalRange)) state.totalRange = "MAX";
  const book = (state.extra && state.extra.totals) || {};
  const view = totalSeries(state.totalRange, cards);
  let change = `<p class="quiet">Storico del totale non disponibile.</p>`;
  if (view.delta && view.delta.start) {
    const cls = view.delta.diff < 0 ? "down" : view.delta.diff > 0 ? "up" : "";
    const arrow = view.delta.diff < 0 ? "▼" : view.delta.diff > 0 ? "▲" : "●";
    const pctTxt = view.delta.start.value ? ` (${view.delta.diff >= 0 ? "+" : ""}${((view.delta.diff / view.delta.start.value) * 100).toLocaleString("it-IT", { minimumFractionDigits: 1, maximumFractionDigits: 1 })}%)` : "";
    const added = view.pts.length && (book.events || []).some((event) => event.date > view.pts[0].date && event.date <= view.pts[view.pts.length - 1].date);
    change = `<p class="delta ${cls}">${arrow} ${signedMoney(view.delta.diff)}${pctTxt} dal ${formatDay(view.delta.start.date)}${added ? " · include carte aggiunte" : ""}</p>`;
  } else if (view.pts.length) {
    change = `<p class="quiet">Un solo giorno di storico.</p>`;
  }
  const series = [];
  if (view.recon.length) series.push({ id: "recon", label: "Ricostruito", color: "#111", fill: false, dashed: true, points: view.recon });
  if (view.real.length) series.push({ id: "real", label: "Snapshot", color: "#111", fillColor: "#5ff0c0", fill: true, points: view.real });
  const latest = view.pts[view.pts.length - 1];
  return `<div class="ranges">${TOTAL_RANGES.map((r) => `<button class="chip ${r.id === state.totalRange ? "on" : ""}" type="button" data-total-range="${r.id}">${r.label}</button>`).join("")}</div>
    ${change}
    <div class="chart-card">${series.length ? chartSvg(series, false) : ""}</div>
    ${latest ? `<p class="quiet">${esc(formatDay(latest.date))}</p>` : ""}`;
}
async function renderHome() {
  setChrome("Inventario", "Collezioni", "home");
  const blocks = [];
  const only = activeCollection();
  for (const meta of (only ? [only] : [])) {
    const payload = await loadPayload(meta);
    blocks.push(`<article class="collection">
      <h2>${esc(meta.name)}</h2>
      ${basketHtml(payload.cards || [], payload.generated_at)}
      <section class="perf">
        <p class="label">Resta da spendere</p>
        <h2>${esc(meta.name)}</h2>
        ${totalChartHtml(payload.cards || [])}
      </section>
      ${topPreview(meta.id, payload.cards || [])}
      <a class="btn" href="#/c/${encodeURIComponent(meta.id)}">Apri il raccoglitore</a>
    </article>`);
  }
  view.innerHTML = `<div class="list home-grid">${blocks.join("") || '<div class="empty"><strong>Nessuna collezione</strong></div>'}</div>`;
}
async function renderBinder(id) {
  const meta = state.collections.find((c) => c.id === id);
  if (!meta) throw new Error("Collezione sconosciuta");
  const payload = await loadPayload(meta);
  const cards = applyFilters(payload.cards || [], id);
  const pages = Math.max(1, Math.ceil(cards.length / PAGE_SIZE));
  state.page = Math.min(Math.max(0, state.page), pages - 1);
  saveFilters();
  const slice = cards.slice(state.page * PAGE_SIZE, state.page * PAGE_SIZE + PAGE_SIZE);
  const pageSum = pageValueOf(slice);
  const f = filtersFor(id);
  const active = (f.years.length + f.sets.length + f.rarities.length + f.langs.length + f.tiers.length + (f.zeroOnly ? 1 : 0));
  setChrome(meta.name, "Raccoglitore", "home");
  const rich = sleeveMode() === "expanded";
  if (rich) await loadCsv();
  const cells = slice.map((card) => sleeveHtml(card, id, rich ? "expanded" : "compact")).join("");
  const buy = f.buy || "todo";
  view.innerHTML = `
    ${basketHtml(payload.cards || [], payload.generated_at)}
    <div class="toolbar">
      <div class="toolbar-switch">
        <button class="sleeve-switch ${rich ? "on" : ""}" type="button" data-sleeve-toggle aria-pressed="${rich ? "true" : "false"}">
          <span class="track" aria-hidden="true"><span class="knob"></span></span>
          <span>Espansa</span>
        </button>
      </div>
      <div class="chip-scroller" role="toolbar" aria-label="Filtri e ordinamento">
        <button class="chip ${buy === "all" ? "on" : ""}" type="button" data-buy="all">Tutte</button>
        <button class="chip ${buy === "todo" ? "on" : ""}" type="button" data-buy="todo">Da comprare</button>
        <button class="chip ${buy === "bought" ? "on" : ""}" type="button" data-buy="bought">Acquistate</button>
        <button class="chip ${sortModeFor(id) === "release" ? "on" : ""}" type="button" data-sort="release">Uscita</button>
        <button class="chip ${sortModeFor(id) === "desc" ? "on" : ""}" type="button" data-sort="desc">Prezzo ↓</button>
        <button class="chip ${sortModeFor(id) === "asc" ? "on" : ""}" type="button" data-sort="asc">Prezzo ↑</button>
        ${sortToggle(id, "pop", "Pop")}
        ${sortToggle(id, "popchg", "Pop %")}
        <button class="chip" type="button" data-open-filters>Filtri${active ? " · " + active : ""}</button>
      </div>
    </div>
    <section class="binder" id="binder">
      <div class="holes" aria-hidden="true"><span></span><span></span></div>
      <div class="pager">
        <button class="iconbtn" type="button" data-page="-1" ${state.page === 0 ? "disabled" : ""} aria-label="Pagina precedente">‹</button>
        <p>Pagina ${state.page + 1} di ${pages}</p>
        <button class="iconbtn" type="button" data-page="1" ${state.page >= pages - 1 ? "disabled" : ""} aria-label="Pagina successiva">›</button>
      </div>
      ${slice.length ? `<p class="page-value nums">Valore pagina ${money(pageSum.total)}${pageSum.missing ? ` · ${pageSum.missing} senza prezzo` : ""}</p>` : ""}
      ${cards.length ? `<div class="grid${rich ? " rich" : ""}">${cells}</div>` : (buy === "bought" ? `<div class="empty"><strong>Nessuna carta acquistata</strong><p>Apri una carta e segna l'acquisto. Resta raggiungibile da Tutte.</p></div>` : `<div class="empty"><strong>Nessuna carta</strong><p>Prova a togliere un filtro, oppure guarda Tutte.</p></div>`)}
      <div class="arrows">
        <button class="iconbtn prev" type="button" data-page="-1" ${state.page === 0 ? "disabled" : ""} aria-label="Pagina precedente">‹</button>
        <button class="iconbtn next" type="button" data-page="1" ${state.page >= pages - 1 ? "disabled" : ""} aria-label="Pagina successiva">›</button>
      </div>
    </section>`;
  bindBinder(id, payload);
  if (state.sheet) openFilters(id, payload);
}
function sortToggle(id, base, label) {
  const mode = sortModeFor(id);
  const desc = base + "-desc";
  const asc = base + "-asc";
  const on = mode === desc || mode === asc;
  const next = mode === desc ? asc : desc;
  const arrow = mode === asc ? "↑" : "↓";
  return `<button class="chip ${on ? "on" : ""}" type="button" data-sort="${on ? next : desc}">${label}${on ? " " + arrow : ""}</button>`;
}
function bindBinder(id, payload) {
  const binder = document.getElementById("binder");
  let x0 = null;
  binder.addEventListener("touchstart", (e) => { x0 = e.changedTouches[0].clientX; }, { passive: true });
  binder.addEventListener("touchend", (e) => {
    if (x0 == null) return;
    const dx = e.changedTouches[0].clientX - x0;
    if (Math.abs(dx) > 48) turn(dx < 0 ? 1 : -1);
    x0 = null;
  });
}
function turn(delta) {
  state.page += delta;
  saveFilters();
  render();
}
function unique(cards, key) {
  return [...new Set(cards.map((c) => c[key]).filter((v) => v != null && v !== ""))];
}
function openFilters(id, payload) {
  const cards = payload.cards || [];
  const f = filtersFor(id);
  const years = unique(cards, "release_year").map(String).sort();
  const sets = unique(cards, "set").sort((a, b) => a.localeCompare(b, "it"));
  const rarities = unique(cards, "rarity").sort((a, b) => a.localeCompare(b, "it"));
  const checks = (name, values, selected, labelOf) => values.map((v) =>
    `<label><input type="checkbox" name="${name}" value="${esc(v)}" ${selected.includes(String(v)) ? "checked" : ""}> ${esc(labelOf ? labelOf(v) : v)}</label>`
  ).join("");
  view.insertAdjacentHTML("beforeend", `<div class="sheet" id="sheet"><form>
    <h3>Filtri</h3>
    <fieldset><legend>Anno di uscita</legend><div class="checks">${checks("years", years, f.years.map(String))}</div></fieldset>
    <fieldset><legend>Espansione</legend><div class="checks">${checks("sets", sets, f.sets)}</div></fieldset>
    <fieldset><legend>Rarità</legend><div class="checks">${checks("rarities", rarities, f.rarities)}</div></fieldset>
    <fieldset><legend>Lingua</legend><div class="checks">
      <label><input type="checkbox" name="langs" value="it" ${f.langs.includes("it") ? "checked" : ""}> Italiano</label>
      <label><input type="checkbox" name="langs" value="jp" ${f.langs.includes("jp") ? "checked" : ""}> Giapponese</label>
    </div></fieldset>
    <fieldset><legend>Fascia di prezzo</legend><div class="checks">
      <label><input type="checkbox" name="tiers" value="lt50" ${f.tiers.includes("lt50") ? "checked" : ""}> Sotto 50 €</label>
      <label><input type="checkbox" name="tiers" value="mid" ${f.tiers.includes("mid") ? "checked" : ""}> 50–150 €</label>
      <label><input type="checkbox" name="tiers" value="gt150" ${f.tiers.includes("gt150") ? "checked" : ""}> Oltre 150 €</label>
    </div></fieldset>
    <fieldset><legend>CardTrader Zero</legend><div class="checks">
      <label><input type="checkbox" name="zeroOnly" ${f.zeroOnly ? "checked" : ""}> Solo carte con una copia Zero</label>
    </div></fieldset>
    <div class="row">
      <button class="btn" type="submit">Applica</button>
      <button class="btn ghost" type="button" data-clear>Azzera</button>
      <button class="btn ghost" type="button" data-close>Chiudi</button>
    </div>
  </form></div>`);
  const form = document.querySelector("#sheet form");
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const data = new FormData(form);
    f.years = data.getAll("years");
    f.sets = data.getAll("sets");
    f.rarities = data.getAll("rarities");
    f.langs = data.getAll("langs");
    f.tiers = data.getAll("tiers");
    f.zeroOnly = data.get("zeroOnly") != null;
    state.page = 0;
    state.sheet = false;
    saveFilters();
    render();
  });
  form.querySelector("[data-clear]").addEventListener("click", () => {
    state.filters[id] = { q: f.q, years: [], sets: [], rarities: [], langs: [], tiers: [], zeroOnly: false, buy: f.buy || "todo" };
    state.page = 0;
    saveFilters();
    render();
  });
  form.querySelector("[data-close]").addEventListener("click", () => document.getElementById("sheet").remove());
  document.getElementById("sheet").addEventListener("click", (e) => {
    if (e.target.id === "sheet") e.currentTarget.remove();
  });
}
function countryName(code) {
  if (!code) return "";
  try {
    return new Intl.DisplayNames(["it"], { type: "region" }).of(code) || code;
  } catch (e) {
    return code;
  }
}
function reviewLine(offer) {
  const parts = [];
  if (offer.avg_rating_percentage != null && offer.avg_rating_percentage !== "") {
    parts.push(new Intl.NumberFormat("it-IT", { maximumFractionDigits: 0 }).format(offer.avg_rating_percentage) + "%");
  }
  if (offer.feedbacks_count) {
    parts.push(new Intl.NumberFormat("it-IT", { useGrouping: true }).format(offer.feedbacks_count) + " recensioni");
  }
  return parts.join(" · ");
}
function offerRows(list, link, zero) {
  const rows = Array.isArray(list) ? list : [];
  if (!rows.length) return `<p class="quiet">Nessuna offerta ${zero ? "Zero" : "diretta"} in questo momento.</p>`;
  return `<div class="offer-list">${rows.map((offer) => {
    const bits = [reviewLine(offer), countryName(offer.country_code)].filter(Boolean);
    if (zero && offer.ct_zero_avg_shipping_days != null && offer.ct_zero_avg_shipping_days !== "") {
      bits.push("spedizione media " + offer.ct_zero_avg_shipping_days + " giorni");
    }
    const qty = offer.quantity != null ? "Qtà " + offer.quantity : "";
    if (qty) bits.push(qty);
    const href = link || "#";
    return `<a class="offer-row" href="${esc(href)}" target="_blank" rel="noopener">
      <div><div class="who">${esc(offer.username || "Venditore")}</div><p class="meta">${esc(bits.join(" · "))}</p></div>
      <div class="price">${money(offer.price_eur)}</div>
    </a>`;
  }).join("")}</div>`;
}
function offersSection(card, link) {
  return `<section class="offers">
    <h2>Migliori offerte</h2>
    <p class="quiet">Near Mint, non gradate, ${card.target_language === "jp" ? "giapponese" : "italiano"}. Fino a 5 per lista.</p>
    <h3>CardTrader Zero</h3>
    ${offerRows(card.offers_zero, link, true)}
    <h3>CardTrader</h3>
    ${offerRows(card.offers_ct, link, false)}
  </section>`;
}
function stockText(card) {
  const qty = num(card.qty_mint_nm_target_lang);
  const listings = num(card.listings_mint_nm_target_lang);
  if (qty == null && listings == null) return "";
  const lang = card.target_language === "jp" ? "giapponese" : "italiano";
  let line = `${qty == null ? "n/d" : qty} copie in vendita in ${lang}, condizione Mint o Near Mint`;
  if (listings != null) line += ` · ${listings} annunci`;
  return `<p class="quiet">${esc(line)}</p>`;
}
function seriesFor(card) {
  const rows = (state.csv && state.csv.get(card.id)) || [];
  const target = [];
  const market = [];
  rows.forEach((r) => {
    const value = num(r.price_eur);
    if (value == null || !r.date) return;
    if (r.kind === "daily_snapshot" && r.language === card.target_language && r.source === "cardtrader_listings_min") {
      target.push({ date: r.date, value });
    } else if (r.kind === "backfill" && r.source === "cardtrader_ct_market_graph_all_languages") {
      market.push({ date: r.date, value });
    }
  });
  target.sort((a, b) => a.date.localeCompare(b.date));
  market.sort((a, b) => a.date.localeCompare(b.date));
  return [
    { id: "target", label: card.target_language === "jp" ? "NM giapponese" : "NM italiano", color: "#111", fillColor: "#5ff0c0", fill: true, points: target },
    { id: "market", label: "mercato CardTrader, tutte le lingue", color: "#8d867c", fill: false, dashed: true, points: market },
  ];
}
function presetsFor(points, options) {
  const dates = points.map((p) => p.date).sort();
  const span = dates.length >= 2 ? dateNum(dates[dates.length - 1]) - dateNum(dates[0]) : 0;
  return options.filter((p) => p.id === "MAX" || span >= p.min);
}
function filterPoints(points, preset, end) {
  if (preset === "MAX" || !end) return points;
  const days = { "7G": 7, "30G": 30, "90G": 90, "1A": 365, "1M": 30, "3M": 90, "6M": 180, "12M": 365 }[preset];
  const start = addDays(end, -(days - 1));
  return points.filter((p) => p.date >= start && p.date <= end);
}
function chartSvg(series, dark, asMoney = true) {
  const pts = series.flatMap((s) => s.points);
  if (!pts.length) return `<p class="quiet">Nessun punto in questo periodo.</p>`;
  const w = 360, h = 176, pad = { l: 12, r: 12, t: 18, b: 22 };
  const dates = pts.map((p) => p.date).sort();
  const t0 = dateNum(dates[0]), t1 = dateNum(dates[dates.length - 1]);
  const values = pts.map((p) => p.value);
  const min = Math.min(...values), max = Math.max(...values);
  const span = max - min || Math.max(max * 0.08, 1);
  const y0 = min - span * 0.08, y1 = max + span * 0.12;
  const xOf = (date) => t1 === t0 ? (pad.l + (w - pad.r)) / 2 : pad.l + ((dateNum(date) - t0) / (t1 - t0)) * (w - pad.l - pad.r);
  const yOf = (v) => pad.t + (1 - (v - y0) / (y1 - y0)) * (h - pad.t - pad.b);
  const parts = [];
  let lastMarkerX = -999;
  series.forEach((s) => {
    let seg = [];
    const flush = () => {
      if (!seg.length) return;
      const line = seg.map((p, i) => `${i ? "L" : "M"}${xOf(p.date).toFixed(1)} ${yOf(p.value).toFixed(1)}`).join(" ");
      if (s.fill && seg.length > 1) {
        const base = `L${xOf(seg[seg.length - 1].date).toFixed(1)} ${(h - pad.b).toFixed(1)} L${xOf(seg[0].date).toFixed(1)} ${(h - pad.b).toFixed(1)} Z`;
        parts.push(`<path d="${line} ${base}" fill="${s.fillColor || s.color}" opacity="0.55"></path>`);
      }
      parts.push(`<path d="${line}" fill="none" stroke="${s.color}" stroke-width="${s.fill ? 2.4 : 1.7}" ${s.dashed ? 'stroke-dasharray="5 4"' : ""} stroke-linejoin="round" stroke-linecap="round"></path>`);
      seg.forEach((p) => {
        const x = xOf(p.date), y = yOf(p.value);
        if (p.marker) {
          parts.push(`<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="5.5" fill="#FFE45C" stroke="#111" stroke-width="1.6">${p.title ? `<title>${esc(p.title)}</title>` : ""}</circle>`);
          if (p.markerLabel && x - lastMarkerX > 22) {
            parts.push(`<text x="${x.toFixed(1)}" y="${Math.max(11, y - 8).toFixed(1)}" text-anchor="middle" fill="#111" font-size="10" font-weight="700">${esc(p.markerLabel)}</text>`);
            lastMarkerX = x;
          }
        } else {
          parts.push(`<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${seg.length === 1 ? 4.5 : 2.4}" fill="${s.color}">${p.title ? `<title>${esc(p.title)}</title>` : ""}</circle>`);
        }
      });
      seg = [];
    };
    s.points.forEach((p) => {
      const prev = seg[seg.length - 1];
      if (prev && dateNum(p.date) - dateNum(prev.date) > 1) flush();
      seg.push(p);
    });
    flush();
  });
  const guide = "#111";
  const label = "#111";
  if (max !== min) {
    parts.push(`<line x1="${pad.l}" x2="${w - pad.r}" y1="${yOf(max).toFixed(1)}" y2="${yOf(max).toFixed(1)}" stroke="${guide}" stroke-opacity="0.25" stroke-dasharray="3 4"></line>`);
    parts.push(`<line x1="${pad.l}" x2="${w - pad.r}" y1="${yOf(min).toFixed(1)}" y2="${yOf(min).toFixed(1)}" stroke="${guide}" stroke-opacity="0.25" stroke-dasharray="3 4"></line>`);
    const axis = (v) => asMoney ? money(v) : new Intl.NumberFormat("it-IT", { maximumFractionDigits: 0 }).format(v);
    parts.push(`<text x="${w - pad.r}" y="${(yOf(max) - 3).toFixed(1)}" text-anchor="end" fill="${label}" font-size="10">max ${esc(axis(max))}</text>`);
    parts.push(`<text x="${w - pad.r}" y="${(yOf(min) - 3).toFixed(1)}" text-anchor="end" fill="${label}" font-size="10">min ${esc(axis(min))}</text>`);
  }
  parts.push(`<text x="${pad.l}" y="${h - 6}" fill="${label}" font-size="10">${esc(formatDay(dates[0]))}</text>`);
  if (dates[0] !== dates[dates.length - 1]) {
    parts.push(`<text x="${w - pad.r}" y="${h - 6}" text-anchor="end" fill="${label}" font-size="10">${esc(formatDay(dates[dates.length - 1]))}</text>`);
  }
  return `<svg viewBox="0 0 ${w} ${h}" role="img" aria-label="Andamento del prezzo">${parts.join("")}</svg>`;
}
function changeOver(points, days) {
  if (!points.length) return null;
  const end = points[points.length - 1];
  if (points.length < 2) return { end, start: null, days: 0 };
  const boundary = addDays(end.date, -(days - 1));
  let start = null;
  for (let i = points.length - 1; i >= 0; i--) {
    if (points[i].date <= boundary && points[i].date !== end.date) { start = points[i]; break; }
  }
  if (!start) start = points[0].date === end.date ? null : points[0];
  if (!start || start.date === end.date) return { end, start: null, days: 0 };
  const span = dateNum(end.date) - dateNum(start.date);
  return { start, end, days: span, diff: end.value - start.value, pct: start.value ? ((end.value - start.value) / start.value) * 100 : null };
}
async function loadExtra() {
  if (state.extra) return state.extra;
  const read = async (name) => {
    try { return await getJson(name); }
    catch (e) { return {}; }
  };
  const meta = activeCollection() || {};
  const popFile = await read(meta.pop || "pop_summary.json");
  state.extra = {
    cm: await read(meta.cardmarket || "cardmarket.json"),
    hist: await read(meta.tcgnotify || "tcgnotify_history.json"),
    totals: await read(meta.totals || "total_history.json"),
    pop: (popFile && popFile.cards) || {},
  };
  return state.extra;
}
function finalFromRow(row) {
  const ctz = num(row.price_ctz_eur);
  const ct = num(row.price_ct_eur);
  const picked = chooseFinal(ctz, ct, null);
  if (picked.price != null) return picked.price;
  return num(row.price_eur);
}
function marketSeries(card) {
  const rows = ((state.csv && state.csv.get(card.id)) || []).filter((r) => r.kind === "daily_snapshot" && r.language === card.target_language);
  const min = [], avg = [], copies = [];
  let notify = false;
  rows.forEach((r) => {
    const value = finalFromRow(r);
    if (value != null) min.push({ date: r.date, value, notify: r.source === "tcgnotify" });
    const mid = num(r.price_avg_eur);
    if (mid != null) avg.push({ date: r.date, value: mid });
    const n = num(r.listings_count);
    if (n != null) copies.push({ date: r.date, value: n });
  });
  const extra = (state.extra && state.extra.hist && state.extra.hist[card.id]) || {};
  (extra.cardtrader || []).forEach((p) => {
    if (!p || !p.date || p.date >= "2026-11-10") return;
    notify = true;
    if (num(p.min) != null && !min.some((x) => x.date === p.date)) min.push({ date: p.date, value: num(p.min), notify: true });
    if (num(p.avg) != null && !avg.some((x) => x.date === p.date)) avg.push({ date: p.date, value: num(p.avg), notify: true });
    if (num(p.copies) != null && !copies.some((x) => x.date === p.date)) copies.push({ date: p.date, value: num(p.copies), notify: true });
  });
  const sort = (list) => list.sort((a, b) => a.date.localeCompare(b.date));
  return { min: sort(min), avg: sort(avg), copies: sort(copies), notify };
}
function cardmarketSeries(card) {
  const extra = (state.extra && state.extra.hist && state.extra.hist[card.id]) || {};
  const min = [], avg = [], copies = [];
  (extra.cardmarket || []).forEach((p) => {
    if (!p || !p.date) return;
    if (num(p.min) != null) min.push({ date: p.date, value: num(p.min) });
    if (num(p.avg) != null) avg.push({ date: p.date, value: num(p.avg) });
    if (num(p.copies) != null) copies.push({ date: p.date, value: num(p.copies) });
  });
  const current = state.extra && state.extra.cm && state.extra.cm[card.id];
  if (current && current.date) {
    if (num(current.min_eur) != null && !min.some((x) => x.date === String(current.date).slice(0, 10))) {
      min.push({ date: String(current.date).slice(0, 10), value: num(current.min_eur) });
    }
    if (num(current.avg_eur) != null) avg.push({ date: String(current.date).slice(0, 10), value: num(current.avg_eur) });
    if (num(current.copies) != null) copies.push({ date: String(current.date).slice(0, 10), value: num(current.copies) });
  }
  const sort = (list) => list.sort((a, b) => a.date.localeCompare(b.date));
  return { min: sort(min), avg: sort(avg), copies: sort(copies), notify: min.length + avg.length + copies.length > 0 };
}
async function renderCard(id, cardId) {
  const meta = state.collections.find((c) => c.id === id);
  if (!meta) throw new Error("Collezione sconosciuta");
  const payload = await loadPayload(meta);
  await loadCsv();
  const cards = applyFilters(payload.cards || [], id);
  const index = cards.findIndex((c) => c.id === cardId);
  const card = (payload.cards || []).find((c) => c.id === cardId);
  if (!card) throw new Error("Carta non trovata");
  const list = cards.length ? cards : [card];
  const here = index >= 0 ? index : list.findIndex((c) => c.id === card.id);
  const prev = here > 0 ? list[here - 1] : null;
  const next = here >= 0 && here < list.length - 1 ? list[here + 1] : null;
  await loadExtra();
  const q = quote(card);
  const lang = langOf(card.target_language);
  const pack = state.chartMarket === "cardmarket" ? cardmarketSeries(card) : marketSeries(card);
  const options = [
    { id: "7G", label: "7G", min: 6 },
    { id: "30G", label: "30G", min: 29 },
    { id: "90G", label: "90G", min: 89 },
    { id: "1A", label: "1A", min: 364 },
    { id: "MAX", label: "Max", min: 0 },
  ];
  if (!options.some((p) => p.id === state.cardRange)) state.cardRange = "30G";
  const end = [...pack.min, ...pack.avg, ...pack.copies].map((p) => p.date).sort().pop();
  const minShown = filterPoints(pack.min, state.cardRange, end);
  const avgShown = filterPoints(pack.avg, state.cardRange, end);
  const copiesShown = filterPoints(pack.copies, state.cardRange, end);
  const change30 = changeOver(pack.min, 30);
  const show30 = change30 && change30.start && change30.days >= 29;
  const updated = dayKey(card.last_updated);
  const today = updated && updated === romeToday();
  setChrome(meta.name, cardTitle(card), "home");
  const link = safeUrl(card.cardtrader_link);
  const offersHtml = offersSection(card, link);
  const cm = (state.extra.cm && state.extra.cm[card.id]) || {};
  const ctPrice = q.source === "ct" ? num(card.price_ct_eur) : (num(card.price_ctz_eur) ?? num(card.price_ct_eur) ?? q.price);
  const ctCopies = q.source === "ct" ? (num(card.qty_ct) || num(card.listings_ct)) : (num(card.qty_ctz) || num(card.listings_ctz) || num(card.listings_target_lang_nm));
  const ctWhen = formatDay(updated);
  const cmPrice = num(card.price_cm_eur) ?? num(cm.min_eur);
  const cmCopies = num(card.copies_cm) ?? num(cm.copies);
  const cmWhen = formatDay(card.price_cm_date || cm.date);
  const avgPrice = num(card.price_avg_eur);
  const soldCopies = q.source === "cm" ? cmCopies : (q.source === "ct" ? (num(card.qty_ct) || num(card.listings_ct)) : (num(card.qty_ctz) || num(card.listings_ctz)));
  const period = minShown.length ? minShown : avgShown;
  const values = period.map((p) => p.value);
  const periodMin = values.length ? Math.min(...values) : null;
  const periodMax = values.length ? Math.max(...values) : null;
  const periodChange = changeOver(minShown, minShown.length ? dateNum(minShown[minShown.length - 1].date) - dateNum(minShown[0].date) + 1 : 0);
  const arrow = periodChange && periodChange.diff < 0 ? "▼" : "▲";
  const sideNum = (other, dir) => other ? `<button class="peek" type="button" data-goto="${esc(other.id)}" aria-label="${dir === "prev" ? "Carta precedente" : "Carta successiva"} ${esc(other.name)}"><span>${esc(other.number || "")}</span></button>` : "<span></span>";
  view.innerHTML = `
    <p class="kicker"><a href="#/c/${encodeURIComponent(id)}">‹ Raccoglitore</a></p>
    <div class="stage">
      ${sideNum(prev, "prev")}
      ${art(card, purchaseOf(card.id) ? "hero bought" : "hero")}
      ${sideNum(next, "next")}
    </div>
    <h2 class="card-name">${purchaseOf(card.id) ? "✅ " : ""}${esc(cardTitle(card))}</h2>
    <p class="sub">${esc(cardSetName(card))} · ${esc(cardNumber(card))} · ${esc(card.rarity)} · ${lang.flag} ${lang.name}${card.release_year ? " · " + esc(card.release_year) : ""}</p>
    <section class="pricebox">
      <p class="label">PREZZO MINIMO · NM · ${lang.flag} ${lang.name.toUpperCase()} · ${esc(sourceName(q.source))}</p>
      <p class="big">${q.price == null ? "n/d" : money(q.price)}</p>
      ${show30 ? `<p class="delta ${change30.diff < 0 ? "down" : "up"}">${change30.diff < 0 ? "▼" : "▲"} ${pct(change30.pct)} · ${signedMoney(change30.diff)} in 30 giorni</p>` : ""}
      <p class="quiet">Prezzo medio ${avgPrice == null ? "n/d" : money(avgPrice)}</p>
      <p class="quiet">${soldCopies == null ? "Copie n/d" : soldCopies + " copie in vendita"}${ctWhen ? " · " + esc(ctWhen) : ""}</p>
      <p><span class="pill ${today ? "today" : ""}">${today ? "Aggiornato oggi" : "Aggiornato il " + formatDay(updated)}</span></p>
      ${link ? `<a class="cta-search" href="${esc(link)}" target="_blank" rel="noopener">Apri su CardTrader</a>` : ""}
    </section>
    <h2 class="section-title">Due mercati, mai mescolati</h2>
    <div class="market-list">
      <button class="market-row ${state.chartMarket === "cardtrader" ? "on" : ""}" type="button" data-chart-market="cardtrader">
        <span class="who">CardTrader</span>
        <span class="meta">${q.source === "ct" ? "normale" : "Zero"} · ${ctCopies == null ? "copie n/d" : ctCopies + " copie"}${ctWhen ? " · " + esc(ctWhen) : ""}</span>
        <b class="nums">${ctPrice == null ? "n/d" : money(ctPrice)}</b>
      </button>
      <button class="market-row ${state.chartMarket === "cardmarket" ? "on" : ""}" type="button" data-chart-market="cardmarket">
        <span class="who">Cardmarket</span>
        <span class="meta">tutte le condizioni · ${cmCopies == null ? "copie n/d" : cmCopies + " copie"}${cmWhen ? " · " + esc(cmWhen) : ""}</span>
        <b class="nums">${cmPrice == null ? "n/d" : money(cmPrice)}</b>
      </button>
    </div>
    ${popBlock(card)}
    <section class="chart-card">
      <h2 class="section-title">Storico</h2>
      <div class="ranges">${options.map((p) => `<button class="chip ${p.id === state.cardRange ? "on" : ""}" type="button" data-card-range="${p.id}">${p.label}</button>`).join("")}</div>
      <div class="statgrid">
        <p><span>Minimo</span><b class="nums">${minShown.length ? money(minShown[minShown.length - 1].value) : "n/d"}</b></p>
        <p><span>Medio</span><b class="nums">${avgShown.length ? money(avgShown[avgShown.length - 1].value) : "n/d"}</b></p>
        <p><span>Copie</span><b class="nums">${copiesShown.length ? copiesShown[copiesShown.length - 1].value : "n/d"}</b></p>
      </div>
      ${minShown.length || avgShown.length ? chartSvg(minChartSeries(minShown, avgShown), false) : `<p class="quiet">${state.chartMarket === "cardmarket" ? "Cardmarket: n/d." : "Storico del minimo in arrivo."}</p>`}
      <p class="quiet">Copie in vendita</p>
      ${copiesShown.length ? chartSvg([{ id: "qty", label: "Copie", color: "#111", fillColor: "#c9b6ff", fill: true, points: copiesShown }], false, false) : ""}
      <div class="hist-foot">
        <p><span>MIN</span><b class="nums">${periodMin == null ? "n/d" : money(periodMin)}</b></p>
        <p><span>MAX</span><b class="nums">${periodMax == null ? "n/d" : money(periodMax)}</b></p>
        <p><span>VAR</span><b class="nums ${periodChange && periodChange.diff < 0 ? "down" : "up"}">${periodChange && periodChange.start ? arrow + " " + signedMoney(periodChange.diff) : "n/d"}</b></p>
      </div>
      ${minShown.some((p) => p.notify) ? `<p class="quiet">Tratteggio: storico ricostruito da TCGNotify.</p>` : ""}
      ${state.chartMarket === "cardmarket" ? `<p class="quiet">Cardmarket: tutte le condizioni</p>` : ""}
    </section>
    ${purchaseBox(card, q)}
    ${offersHtml}
    ${card.notes ? `<p class="note">${esc(card.notes)}</p>` : ""}
  `;
  let x0 = null;
  const stage = view.querySelector(".stage");
  stage.addEventListener("touchstart", (e) => { x0 = e.changedTouches[0].clientX; }, { passive: true });
  stage.addEventListener("touchend", (e) => {
    if (x0 == null) return;
    const dx = e.changedTouches[0].clientX - x0;
    if (dx > 48 && prev) location.hash = `#/c/${encodeURIComponent(id)}/card/${encodeURIComponent(prev.id)}`;
    else if (dx < -48 && next) location.hash = `#/c/${encodeURIComponent(id)}/card/${encodeURIComponent(next.id)}`;
  });
}
function purchaseBox(card, q) {
  const bought = purchaseOf(card.id);
  const paidLabel = bought && bought.price_paid_eur == null ? "prezzo attuale, non hai indicato quanto hai pagato" : money(bought && bought.price_paid_eur);
  const form = bought ? `<p class="big" style="font-size:28px">✅ Acquistata</p>
      <p class="meta">${bought.purchased_on ? "Il " + esc(formatDay(bought.purchased_on)) : "Data non indicata"} · ${esc(paidLabel)}</p>
      <button class="btn" type="button" data-unbuy="${esc(card.id)}">Annulla acquisto</button>`
    : `<label>Data acquisto<input id="buy-date" type="date" value="${esc(romeToday())}"></label>
      <label>Prezzo pagato, euro<input id="buy-paid" inputmode="decimal" value="${q.price == null ? "" : String(q.price).replace(".", ",")}" placeholder="opzionale"></label>
      <button class="btn" type="button" data-buy="${esc(card.id)}">Segna come acquistata</button>`;
  return `<section class="buybox${bought ? " bought" : ""}">
    ${form}
    <p class="quiet">Per tenerlo su tutti i dispositivi, dillo al tuo assistente.</p>
  </section>`;
}
function parsePaid(raw) {
  const s = String(raw || "").trim();
  if (!s) return null;
  const norm = s.includes(",") ? s.replace(/\./g, "").replace(",", ".") : s;
  const n = Number(norm);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : null;
}
function basketValue(cards, mode) {
  let total = 0;
  for (const card of cards) {
    const price = quote(card).price;
    if (price == null) continue;
    if (mode === "remain" && purchaseOf(card.id)) continue;
    total += price;
  }
  return Math.round(total * 100) / 100;
}
function snapshotSeries(payloadsByDate, mode) {
  return [...payloadsByDate.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([date, payload]) => ({
    date,
    value: basketValue(payload.cards || [], mode),
    payload,
  }));
}
async function renderPerformance() {
  setChrome("Portafoglio", "Performance", "performance");
  await loadHistory();
  const currentMeta = activeCollection();
  if (!state.perfId || !state.collections.some((c) => c.id === state.perfId)) state.perfId = currentMeta ? currentMeta.id : "";
  if (currentMeta && state.perfId !== currentMeta.id) state.perfId = currentMeta.id;
  const meta = state.collections.find((c) => c.id === state.perfId) || currentMeta;
  const current = await loadPayload(meta);
  const basket = basketOf(current.cards || []);
  if (!state.perfBasket) state.perfBasket = "remain";
  const points = snapshotSeries(state.history, state.perfBasket).filter((p) => p.payload && p.payload.cards);
  const contrib = contributionBlock(points, state.perfBasket);
  const headline = state.perfBasket === "remain" ? basket.remain : basket.wishlist;
  const headlineLabel = state.perfBasket === "remain" ? "Resta da spendere" : "Totale wishlist";
  view.innerHTML = `
    <section class="perf">
      <p class="label">${esc(headlineLabel)}</p>
      <h2>${esc(meta.name)}</h2>
      <p class="big">${money(headline)}</p>
      ${totalChartHtml(current.cards || [])}
    </section>
    <h2 class="section-title">Contributo sul totale</h2>
    ${contrib}
  `;
}
function contributionBlock(points, mode) {
  if (points.length < 2) {
    return `<div class="empty"><strong>Dati in arrivo</strong><p>Il contributo delle singole carte si calcola quando esistono almeno due snapshot giornalieri. Oggi ce n'è ${points.length}.</p></div>`;
  }
  const end = points[points.length - 1];
  const boundary = addDays(end.date, -3);
  let start = null;
  for (let i = points.length - 1; i >= 0; i--) {
    if (points[i].date <= boundary) { start = points[i]; break; }
  }
  if (!start || start.date === end.date) {
    return `<div class="empty"><strong>Dati in arrivo</strong><p>Non c'è ancora uno snapshot di almeno 3 giorni fa.</p></div>`;
  }
  const before = new Map((start.payload.cards || []).map((c) => [c.id, quote(c).price]));
  const rows = (end.payload.cards || []).map((c) => {
    if (mode === "remain" && purchaseOf(c.id)) return null;
    const now = quote(c).price;
    const was = before.has(c.id) ? before.get(c.id) : null;
    if (now == null || was == null) return null;
    return { card: c, diff: now - was };
  }).filter(Boolean).sort((a, b) => b.diff - a.diff);
  if (!rows.length) return `<div class="empty"><strong>Dati in arrivo</strong><p>Gli snapshot non hanno prezzi confrontabili.</p></div>`;
  const top = rows[0], low = rows[rows.length - 1];
  const item = (row, label) => {
    const arrow = row.diff < 0 ? "▼" : row.diff > 0 ? "▲" : "●";
    const cls = row.diff < 0 ? "down" : row.diff > 0 ? "up" : "";
    return `<article class="contrib"><img alt="" src="${esc(safeUrl(row.card.image_url))}"><div><p class="meta">${label}</p><strong>${esc(row.card.name)}</strong><p class="meta">${formatDay(start.date)} → ${formatDay(end.date)}</p></div><div class="chg delta ${cls}">${arrow} ${signedMoney(row.diff)}</div></article>`;
  };
  return `<div class="list">${item(top, "Maggior contributo")}${top.card.id === low.card.id ? "" : item(low, "Minor contributo")}</div>`;
}
const MOVERS_PERIODS = [
  { id: "1G", label: "1G", days: 1 },
  { id: "7G", label: "7G", days: 7 },
  { id: "30G", label: "30G", days: 30 },
];
function moversPeriod() {
  const saved = String(localStorage.getItem("wl-movers-period") || "").toUpperCase();
  return MOVERS_PERIODS.some((p) => p.id === saved) ? saved : "1G";
}
function cardPriceSeries(card) {
  const lang = card.target_language || "it";
  const rows = ((state.csv && state.csv.get(card.id)) || []).filter((r) => r.kind === "daily_snapshot" && r.language === lang);
  const byDate = new Map();
  rows.forEach((r) => {
    const value = finalFromRow(r);
    if (value == null) return;
    const date = String(r.date).slice(0, 10);
    const reconstructed = r.source === "tcgnotify";
    const prev = byDate.get(date);
    if (!prev || (prev.reconstructed && !reconstructed)) byDate.set(date, { date, value, reconstructed });
  });
  const today = dayKey(card.last_updated);
  const now = quote(card).price;
  if (today && now != null && !byDate.has(today)) byDate.set(today, { date: today, value: now, reconstructed: false });
  return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
}
function moverStart(points, end, daysBack) {
  const boundary = addDays(end.date, -daysBack);
  const floor = addDays(boundary, -7);
  let start = null;
  points.forEach((p) => {
    if (p.date >= floor && p.date <= boundary) start = p;
  });
  return start;
}
function minChartSeries(minShown, avgShown) {
  const real = minShown.filter((p) => !p.notify);
  const recon = minShown.filter((p) => p.notify);
  if (recon.length && real.length) {
    const bridge = real.find((p) => p.date >= recon[recon.length - 1].date) || real[0];
    if (bridge && recon[recon.length - 1].date !== bridge.date) recon.push(bridge);
  }
  const series = [];
  if (recon.length) series.push({ id: "recon", label: "Ricostruito", color: "#111", fill: false, dashed: true, points: recon });
  if (real.length) series.push({ id: "min", label: "Minimo", color: "#111", fillColor: "#5ff0c0", fill: true, points: real });
  if (avgShown.length) series.push({ id: "avg", label: "Medio", color: "#111", fill: false, dashed: true, points: avgShown });
  return series;
}
function moverList(rows, key) {
  if (!state.moversMore) state.moversMore = {};
  const open = !!state.moversMore[key];
  const shown = open ? rows : rows.slice(0, 10);
  const items = shown.map((r) => {
    const arrow = r.diff < 0 ? "▼" : "▲";
    const cls = r.diff < 0 ? "down" : "up";
    return `<a class="mover" href="#/c/${encodeURIComponent(r.collectionId)}/card/${encodeURIComponent(r.card.id)}">
      <img alt="" src="${esc(safeUrl(r.card.image_url))}">
      <div><strong>${esc(cardTitle(r.card))}</strong><p class="meta">${formatDay(r.start)} → ${formatDay(r.end)}${r.reconstructed ? " · ricostruito" : ""}</p></div>
      <div class="chg delta ${cls}">${arrow} ${signedMoney(r.diff)}<br>${arrow} ${pct(r.pct)}</div>
    </a>`;
  }).join("");
  const more = !open && rows.length > 10
    ? `<button class="chip" type="button" data-movers-more="${esc(key)}">Mostra tutti · ${rows.length}</button>`
    : "";
  return items + more;
}
async function renderMovers() {
  setChrome("Portafoglio", "Movimenti", "movers");
  await loadCsv();
  const meta = activeCollection();
  const payload = meta ? await loadPayload(meta) : { cards: [] };
  const period = MOVERS_PERIODS.find((p) => p.id === moversPeriod());
  const rows = [];
  (payload.cards || []).forEach((card) => {
    const series = cardPriceSeries(card);
    if (!series.length) return;
    const end = series[series.length - 1];
    const start = moverStart(series, end, period.days);
    if (!start || start.date === end.date) return;
    const diff = Math.round((end.value - start.value) * 100) / 100;
    if (!diff) return;
    rows.push({
      card,
      collectionId: meta.id,
      diff,
      start: start.date,
      end: end.date,
      pct: start.value ? ((end.value - start.value) / start.value) * 100 : null,
      reconstructed: !!start.reconstructed,
    });
  });
  const up = rows.filter((r) => r.diff > 0).sort((a, b) => b.diff - a.diff);
  const down = rows.filter((r) => r.diff < 0).sort((a, b) => a.diff - b.diff);
  const reconstructed = rows.some((r) => r.reconstructed);
  const empty = !rows.length
    ? `<div class="empty"><strong>Nessun movimento</strong><p>Nessuna carta ha un prezzo confrontabile su questo periodo.</p></div>`
    : "";
  view.innerHTML = `
    <div class="ranges">${MOVERS_PERIODS.map((p) => `<button class="chip ${p.id === period.id ? "on" : ""}" type="button" data-movers="${p.id}">${p.label}</button>`).join("")}</div>
    ${reconstructed ? `<p class="quiet">storico ricostruito da TCGNotify</p>` : ""}
    ${empty}
    ${up.length ? `<h2 class="section-title">Rialzi · ${up.length}</h2><div class="list">${moverList(up, period.id + "-up")}</div>` : ""}
    ${down.length ? `<h2 class="section-title">Ribassi · ${down.length}</h2><div class="list">${moverList(down, period.id + "-down")}</div>` : ""}
  `;
}
document.addEventListener("click", (e) => {
  const collectionBtn = e.target.closest("[data-collection]");
  if (collectionBtn) { setCollection(collectionBtn.dataset.collection); return; }
  const totalRange = e.target.closest("[data-total-range]");
  if (totalRange) { state.totalRange = totalRange.dataset.totalRange; render(); return; }
  const chartMarket = e.target.closest("[data-chart-market]");
  if (chartMarket) { state.chartMarket = chartMarket.dataset.chartMarket; render(); return; }
  const buy = e.target.closest("[data-buy]");
  if (buy && buy.dataset.buy && ["all", "todo", "bought"].includes(buy.dataset.buy)) {
    const id = route().id;
    if (id) { filtersFor(id).buy = buy.dataset.buy; state.page = 0; saveFilters(); render(); }
    return;
  }
  const mark = e.target.closest("[data-buy]");
  if (mark && mark.dataset.buy && !["all", "todo", "bought"].includes(mark.dataset.buy)) {
    const date = (document.getElementById("buy-date") || {}).value || romeToday();
    const paid = parsePaid((document.getElementById("buy-paid") || {}).value);
    setPurchaseOverride(mark.dataset.buy, { purchased_on: date, price_paid_eur: paid });
    render();
    return;
  }
  const unbuy = e.target.closest("[data-unbuy]");
  if (unbuy) { setPurchaseOverride(unbuy.dataset.unbuy, null); render(); return; }
  const basketBtn = e.target.closest("[data-basket]");
  if (basketBtn) { state.perfBasket = basketBtn.dataset.basket; render(); return; }
  const sleeveToggle = e.target.closest("[data-sleeve-toggle]");
  if (sleeveToggle) {
    localStorage.setItem(SLEEVE_KEY, sleeveMode() === "expanded" ? "compact" : "expanded");
    render();
    return;
  }
  const moversBtn = e.target.closest("[data-movers]");
  if (moversBtn && MOVERS_PERIODS.some((p) => p.id === moversBtn.dataset.movers)) {
    localStorage.setItem("wl-movers-period", moversBtn.dataset.movers);
    state.moversMore = {};
    render();
    return;
  }
  const moversMore = e.target.closest("[data-movers-more]");
  if (moversMore) {
    if (!state.moversMore) state.moversMore = {};
    state.moversMore[moversMore.dataset.moversMore] = true;
    render();
    return;
  }
  const sort = e.target.closest("[data-sort]");
  if (sort) {
    const id = route().id || state.collectionId;
    sessionStorage.setItem("wl-sort-" + id, sort.dataset.sort);
    state.sort = sort.dataset.sort;
    state.page = 0;
    saveFilters();
    render();
    return;
  }
  const page = e.target.closest("[data-page]");
  if (page && !page.disabled) { turn(Number(page.dataset.page)); return; }
  if (e.target.closest("[data-open-filters]")) {
    const id = route().id;
    const meta = state.collections.find((c) => c.id === id);
    if (meta) openFilters(id, state.payloads.get(id));
    return;
  }
  const goto = e.target.closest("[data-goto]");
  if (goto) {
    const id = route().id;
    location.hash = `#/c/${encodeURIComponent(id)}/card/${encodeURIComponent(goto.dataset.goto)}`;
    return;
  }
  const cr = e.target.closest("[data-card-range]");
  if (cr) { state.cardRange = cr.dataset.cardRange; render(); return; }
  const pr = e.target.closest("[data-perf-range]");
  if (pr) { state.perfRange = pr.dataset.perfRange; render(); return; }
  const pid = e.target.closest("[data-perf-id]");
  if (pid) { state.perfId = pid.dataset.perfId; sessionStorage.setItem("wl-perf", state.perfId); render(); }
});
document.addEventListener("keydown", (e) => {
  const r = route();
  if (e.key === "ArrowRight") {
    if (r.name === "binder") turn(1);
  } else if (e.key === "ArrowLeft") {
    if (r.name === "binder") turn(-1);
  }
});
window.addEventListener("hashchange", render);
try { localStorage.removeItem("wl-price-mode"); } catch (e) { /* ignore */ }
render();
