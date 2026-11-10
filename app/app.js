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
  cardRange: "1M",
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
  return new Intl.NumberFormat("it-IT", { style: "currency", currency: "EUR" }).format(n);
}
function signedMoney(v) {
  const n = num(v);
  if (n == null) return "";
  const body = new Intl.NumberFormat("it-IT", { style: "currency", currency: "EUR" }).format(Math.abs(n));
  return (n > 0 ? "+" : n < 0 ? "−" : "") + body;
}
function pct(v) {
  const n = num(v);
  if (n == null) return "";
  const body = new Intl.NumberFormat("it-IT", { maximumFractionDigits: 1, minimumFractionDigits: 1 }).format(Math.abs(n));
  return (n > 0 ? "+" : n < 0 ? "−" : "") + body + "%";
}
function quote(card) {
  const zero = num(card.price_min_target_lang_nm_zero_eur);
  const normal = num(card.price_min_target_lang_nm_eur);
  if (zero != null) return { price: zero, source: "zero" };
  if (normal != null) return { price: normal, source: "cardtrader" };
  return { price: null, source: null };
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
    state.filters[id] = { q: "", years: [], sets: [], rarities: [], langs: [], tiers: [], zeroOnly: false };
  }
  return state.filters[id];
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
async function loadCollections() {
  if (state.collections.length) return;
  state.collections = await getJson("collections.json");
}
async function loadPayload(meta) {
  if (state.payloads.has(meta.id)) return state.payloads.get(meta.id);
  const payload = await getJson(meta.file);
  state.payloads.set(meta.id, payload);
  return payload;
}
async function loadHistory() {
  if (state.historyIndex) return;
  state.historyIndex = await getJson("history/index.json");
  await Promise.all(state.historyIndex.map(async (date) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return;
    const payload = await getJson("history/" + date + ".json");
    state.history.set(date, payload);
  }));
}
async function loadCsv() {
  if (state.csv) return state.csv;
  const rows = parseCsv(await getText("price_history.csv"));
  const byCard = new Map();
  rows.forEach((r) => {
    if (!byCard.has(r.card_id)) byCard.set(r.card_id, []);
    byCard.get(r.card_id).push(r);
  });
  state.csv = byCard;
  return byCard;
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
  const q = f.q.trim().toLowerCase();
  return cards.filter((card) => {
    const price = quote(card);
    if (q && !(card.name || "").toLowerCase().includes(q) && !String(card.number || "").toLowerCase().includes(q)) return false;
    if (f.years.length && !f.years.includes(String(card.release_year || ""))) return false;
    if (f.sets.length && !f.sets.includes(card.set)) return false;
    if (f.rarities.length && !f.rarities.includes(card.rarity)) return false;
    if (f.langs.length && !f.langs.includes(card.target_language)) return false;
    if (f.tiers.length && !f.tiers.includes(tierOf(price.price))) return false;
    if (f.zeroOnly && price.source !== "zero") return false;
    return true;
  }).slice().sort((a, b) => {
    const pa = quote(a).price, pb = quote(b).price;
    if (pa == null && pb == null) return a.name.localeCompare(b.name, "it");
    if (pa == null) return 1;
    if (pb == null) return -1;
    return state.sort === "asc" ? pa - pb : pb - pa;
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
  try {
    await loadCollections();
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
async function renderHome() {
  setChrome("Inventario", "Collezioni", "home");
  const blocks = [];
  for (const meta of state.collections) {
    const payload = await loadPayload(meta);
    const sum = collectionTotal(payload.cards || []);
    blocks.push(`<article class="collection">
      ${ring(sum.priced, sum.cards)}
      <div>
        <h2>${esc(meta.name)}</h2>
        <p class="meta">${sum.priced} di ${sum.cards} carte con prezzo · ${sum.zero} Zero</p>
        <p class="total">${money(sum.total)}</p>
        <a class="btn" href="#/c/${encodeURIComponent(meta.id)}">Apri ›</a>
      </div>
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
  const f = filtersFor(id);
  const active = (f.years.length + f.sets.length + f.rarities.length + f.langs.length + f.tiers.length + (f.zeroOnly ? 1 : 0));
  setChrome(meta.name, "Raccoglitore", "home");
  const cells = slice.map((card) => {
    const q = quote(card);
    return `<a class="sleeve" href="#/c/${encodeURIComponent(id)}/card/${encodeURIComponent(card.id)}">
      ${art(card, "art")}
      <p class="name">${esc(card.name)}</p>
      <div class="price-line"><span class="price">${q.price == null ? "n/d" : money(q.price)}</span>${badge(q.source)}</div>
    </a>`;
  }).join("");
  view.innerHTML = `
    <div class="toolbar">
      <input class="search" id="q" type="search" placeholder="Cerca nome o numero" value="${esc(f.q)}" enterkeyhint="search">
      <button class="chip ${state.sort === "desc" ? "on" : ""}" type="button" data-sort="desc">Prezzo ↓</button>
      <button class="chip ${state.sort === "asc" ? "on" : ""}" type="button" data-sort="asc">Prezzo ↑</button>
      <button class="chip" type="button" data-open-filters>Filtri${active ? " · " + active : ""}</button>
    </div>
    <section class="binder" id="binder">
      <div class="holes" aria-hidden="true"><span></span><span></span></div>
      <div class="pager">
        <button class="iconbtn" type="button" data-page="-1" ${state.page === 0 ? "disabled" : ""} aria-label="Pagina precedente">‹</button>
        <p>Pagina ${state.page + 1} di ${pages}</p>
        <button class="iconbtn" type="button" data-page="1" ${state.page >= pages - 1 ? "disabled" : ""} aria-label="Pagina successiva">›</button>
      </div>
      ${cards.length ? `<div class="grid">${cells}</div>` : `<div class="empty"><strong>Nessuna carta</strong><p>Prova a togliere un filtro.</p></div>`}
      <div class="arrows">
        <button class="iconbtn prev" type="button" data-page="-1" ${state.page === 0 ? "disabled" : ""} aria-label="Pagina precedente">‹</button>
        <button class="iconbtn next" type="button" data-page="1" ${state.page >= pages - 1 ? "disabled" : ""} aria-label="Pagina successiva">›</button>
      </div>
    </section>`;
  bindBinder(id, payload);
  if (state.sheet) openFilters(id, payload);
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
  const input = view.querySelector("#q");
  input.addEventListener("input", (e) => {
    filtersFor(id).q = e.target.value;
    state.page = 0;
    state.restoreSearch = true;
    saveFilters();
    renderBinder(id);
  });
  if (state.restoreSearch) {
    input.focus();
    const end = input.value.length;
    input.setSelectionRange(end, end);
    state.restoreSearch = false;
  }
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
    state.filters[id] = { q: f.q, years: [], sets: [], rarities: [], langs: [], tiers: [], zeroOnly: false };
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
    { id: "target", label: card.target_language === "jp" ? "NM giapponese" : "NM italiano", color: "#0f6e68", fill: true, points: target },
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
  const days = { "7G": 7, "1M": 30, "3M": 90, "6M": 180, "12M": 365 }[preset];
  const start = addDays(end, -(days - 1));
  return points.filter((p) => p.date >= start && p.date <= end);
}
function chartSvg(series, dark) {
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
  series.forEach((s) => {
    let seg = [];
    const flush = () => {
      if (!seg.length) return;
      const line = seg.map((p, i) => `${i ? "L" : "M"}${xOf(p.date).toFixed(1)} ${yOf(p.value).toFixed(1)}`).join(" ");
      if (s.fill && seg.length > 1) {
        const base = `L${xOf(seg[seg.length - 1].date).toFixed(1)} ${(h - pad.b).toFixed(1)} L${xOf(seg[0].date).toFixed(1)} ${(h - pad.b).toFixed(1)} Z`;
        parts.push(`<path d="${line} ${base}" fill="${s.color}" opacity="0.16"></path>`);
      }
      parts.push(`<path d="${line}" fill="none" stroke="${s.color}" stroke-width="${s.fill ? 2.4 : 1.7}" ${s.dashed ? 'stroke-dasharray="5 4"' : ""} stroke-linejoin="round" stroke-linecap="round"></path>`);
      seg.forEach((p) => parts.push(`<circle cx="${xOf(p.date).toFixed(1)}" cy="${yOf(p.value).toFixed(1)}" r="${seg.length === 1 ? 4.5 : 2.4}" fill="${s.color}"></circle>`));
      seg = [];
    };
    s.points.forEach((p) => {
      const prev = seg[seg.length - 1];
      if (prev && dateNum(p.date) - dateNum(prev.date) > 1) flush();
      seg.push(p);
    });
    flush();
  });
  const guide = dark ? "rgba(255,255,255,.35)" : "#c4b8a6";
  const label = dark ? "#c9d4d1" : "#6f675e";
  if (max !== min) {
    parts.push(`<line x1="${pad.l}" x2="${w - pad.r}" y1="${yOf(max).toFixed(1)}" y2="${yOf(max).toFixed(1)}" stroke="${guide}" stroke-dasharray="3 4"></line>`);
    parts.push(`<line x1="${pad.l}" x2="${w - pad.r}" y1="${yOf(min).toFixed(1)}" y2="${yOf(min).toFixed(1)}" stroke="${guide}" stroke-dasharray="3 4"></line>`);
    parts.push(`<text x="${w - pad.r}" y="${(yOf(max) - 3).toFixed(1)}" text-anchor="end" fill="${label}" font-size="10">max ${esc(money(max))}</text>`);
    parts.push(`<text x="${w - pad.r}" y="${(yOf(min) - 3).toFixed(1)}" text-anchor="end" fill="${label}" font-size="10">min ${esc(money(min))}</text>`);
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
  const q = quote(card);
  const lang = langOf(card.target_language);
  const full = seriesFor(card);
  const allPoints = full.flatMap((s) => s.points);
  const options = [
    { id: "1M", label: "1M", min: 29 },
    { id: "3M", label: "3M", min: 89 },
    { id: "6M", label: "6M", min: 179 },
    { id: "12M", label: "12M", min: 364 },
    { id: "MAX", label: "MAX", min: 0 },
  ];
  const available = presetsFor(allPoints, options);
  if (!available.some((p) => p.id === state.cardRange)) state.cardRange = available[0] ? available[0].id : "MAX";
  const end = allPoints.map((p) => p.date).sort().pop();
  const shown = full.map((s) => ({ ...s, points: filterPoints(s.points, state.cardRange, end) }));
  const targetChange = changeOver(full[0].points, 30);
  const marketChange = changeOver(full[1].points, 30);
  const updated = dayKey(card.last_updated);
  const today = updated && updated === romeToday();
  setChrome(meta.name, card.name, "home");
  const second = num(card.price_2nd_target_lang_nm_eur);
  const copies = num(card.listings_target_lang_nm);
  const zeroCopies = num(card.listings_target_lang_nm_zero);
  const anyLang = num(card.price_min_any_lang_nm_eur);
  let delta = "";
  if (targetChange && targetChange.start) {
    const cls = targetChange.diff < 0 ? "down" : "up";
    const arrow = targetChange.diff < 0 ? "▼" : "▲";
    delta = `<p class="delta ${cls}">${arrow} ${pct(targetChange.pct)} · ${signedMoney(targetChange.diff)} in ${targetChange.days} giorni</p>`;
  } else {
    delta = `<p class="quiet">Variazione NM: in arrivo. C'è un solo rilevamento in lingua target.</p>`;
  }
  let marketLine = "";
  if (marketChange && marketChange.start) {
    marketLine = `<p class="quiet">Mercato CardTrader, tutte le lingue: ${signedMoney(marketChange.diff)} dal ${formatDay(marketChange.start.date)} al ${formatDay(marketChange.end.date)}. Non è il prezzo in lingua target.</p>`;
  }
  const link = safeUrl(card.cardtrader_link);
  const stockLine = stockText(card);
  const offersHtml = offersSection(card, link);
  view.innerHTML = `
    <p class="kicker"><a href="#/c/${encodeURIComponent(id)}">‹ Raccoglitore</a></p>
    <div class="stage">
      ${prev ? `<button class="peek" type="button" data-goto="${esc(prev.id)}" aria-label="Carta precedente ${esc(prev.name)}">${safeUrl(prev.image_url) ? `<img alt="" src="${esc(safeUrl(prev.image_url))}">` : ""}</button>` : "<span></span>"}
      ${art(card, "hero")}
      ${next ? `<button class="peek" type="button" data-goto="${esc(next.id)}" aria-label="Carta successiva ${esc(next.name)}">${safeUrl(next.image_url) ? `<img alt="" src="${esc(safeUrl(next.image_url))}">` : ""}</button>` : "<span></span>"}
    </div>
    <h2 class="card-name">${esc(card.name)}</h2>
    <p class="sub">${esc(card.set)} · ${esc(card.number)} · ${esc(card.rarity)} · ${lang.flag} ${lang.name} · <span class="dot">●</span> Monitorato${card.release_year ? " · " + esc(card.release_year) : ""}</p>
    <section class="pricebox">
      <p class="label">PREZZO MINIMO · NM · ${lang.flag} ${lang.name.toUpperCase()}</p>
      <div class="row"><p class="big">${q.price == null ? "n/d" : money(q.price)}</p>${badge(q.source)}</div>
      ${delta}
      ${q.price == null ? `<p class="quiet">Nessuna copia Near Mint non gradata nella lingua target.</p>` : ""}
      ${second != null ? `<p class="quiet">2ª offerta ${money(second)}</p>` : `<p class="quiet">2ª offerta non disponibile</p>`}
      <p class="quiet">${copies == null ? "Copie n/d" : copies + " copie in vendita"}${zeroCopies == null ? "" : " · " + zeroCopies + " Zero"}</p>
      ${q.price == null && anyLang != null ? `<p class="quiet">Riferimento NM in altre lingue: ${money(anyLang)}. Non entra nel totale.</p>` : ""}
      ${marketLine}
      <p><span class="pill ${today ? "today" : ""}">${today ? "Aggiornato oggi" : "Aggiornato il " + formatDay(updated)}</span></p>
      ${stockLine}
    </section>
    ${offersHtml}
    <section class="chart-card">
      <div class="ranges">${available.map((p) => `<button class="chip ${p.id === state.cardRange ? "on" : ""}" type="button" data-card-range="${p.id}">${p.label}</button>`).join("")}</div>
      ${chartSvg(shown, false)}
      <div class="legend">
        <span><i class="swatch" style="background:#0f6e68"></i>${esc(full[0].label)}</span>
        <span><i class="swatch market"></i>mercato CardTrader, tutte le lingue</span>
      </div>
    </section>
    ${card.notes ? `<p class="note">${esc(card.notes)}</p>` : ""}
    ${link ? `<p><a class="btn" href="${esc(link)}" target="_blank" rel="noopener">Apri su CardTrader</a></p>` : ""}
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
function snapshotSeries(payloadsByDate) {
  return [...payloadsByDate.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([date, payload]) => ({
    date,
    value: collectionTotal(payload.cards || []).total,
    payload,
  }));
}
async function renderPerformance() {
  setChrome("Portafoglio", "Performance", "performance");
  await loadHistory();
  if (!state.perfId) state.perfId = state.collections[0] ? state.collections[0].id : "";
  const meta = state.collections.find((c) => c.id === state.perfId) || state.collections[0];
  const current = await loadPayload(meta);
  const sum = collectionTotal(current.cards || []);
  const points = snapshotSeries(state.history).filter((p) => p.payload && p.payload.cards);
  const options = [
    { id: "7G", label: "7G", min: 6 },
    { id: "1M", label: "1M", min: 29 },
    { id: "3M", label: "3M", min: 89 },
    { id: "6M", label: "6M", min: 179 },
    { id: "MAX", label: "MAX", min: 0 },
  ];
  const available = presetsFor(points, options);
  if (!available.some((p) => p.id === state.perfRange)) state.perfRange = "MAX";
  const end = points.length ? points[points.length - 1].date : null;
  const shown = filterPoints(points, state.perfRange, end);
  const delta = changeOver(shown, shown.length ? dateNum(shown[shown.length - 1].date) - dateNum(shown[0].date) + 1 : 0);
  let changeHtml = `<p class="quiet">Dati in arrivo. Serve almeno un altro snapshot giornaliero per calcolare la variazione.</p>`;
  if (delta && delta.start) {
    const cls = delta.diff < 0 ? "down" : "up";
    changeHtml = `<p class="${cls}">${signedMoney(delta.diff)} dal ${formatDay(delta.start.date)} al ${formatDay(delta.end.date)}</p>`;
  }
  const contrib = contributionBlock(points);
  view.innerHTML = `
    <div class="ranges" style="margin-bottom:12px">${state.collections.map((c) => `<button class="chip ${c.id === meta.id ? "on" : ""}" type="button" data-perf-id="${esc(c.id)}">${esc(c.name)}</button>`).join("")}</div>
    <section class="perf">
      <p class="label">OVERVIEW</p>
      <h2>${esc(meta.name)}</h2>
      <p class="big">${money(sum.total)}</p>
      ${changeHtml}
      <div class="chart-card">${points.length ? chartSvg([{ id: "tot", label: "Totale", color: "#2dd4bf", fill: true, points: shown }], true) : ""}</div>
      <div class="ranges">${available.map((p) => `<button class="chip ${p.id === state.perfRange ? "on" : ""}" type="button" data-perf-range="${p.id}">${p.label}</button>`).join("")}</div>
    </section>
    <h2 class="section-title">Contributo sul totale</h2>
    ${contrib}
  `;
}
function contributionBlock(points) {
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
    const now = quote(c).price;
    const was = before.has(c.id) ? before.get(c.id) : null;
    if (now == null || was == null) return null;
    return { card: c, diff: now - was };
  }).filter(Boolean).sort((a, b) => b.diff - a.diff);
  if (!rows.length) return `<div class="empty"><strong>Dati in arrivo</strong><p>Gli snapshot non hanno prezzi confrontabili.</p></div>`;
  const top = rows[0], low = rows[rows.length - 1];
  const item = (row, label) => `<article class="contrib"><img alt="" src="${esc(safeUrl(row.card.image_url))}"><div><p class="meta">${label}</p><strong>${esc(row.card.name)}</strong><p class="meta">${formatDay(start.date)} → ${formatDay(end.date)}</p></div><div class="chg ${row.diff < 0 ? "delta down" : "delta up"}">${signedMoney(row.diff)}</div></article>`;
  return `<div class="list">${item(top, "Maggior contributo")}${top.card.id === low.card.id ? "" : item(low, "Minor contributo")}</div>`;
}
async function renderMovers() {
  setChrome("In arrivo", "Movimenti", "movers");
  await loadCsv();
  await loadCollections();
  const meta = state.collections[0];
  const payload = meta ? await loadPayload(meta) : { cards: [] };
  const rows = [];
  (payload.cards || []).forEach((card) => {
    const market = seriesFor(card)[1].points;
    const ch = changeOver(market, 30);
    if (!ch || !ch.start) return;
    rows.push({ card, ...ch });
  });
  rows.sort((a, b) => b.diff - a.diff);
  const list = rows.map((r) => `<a class="mover" href="#/c/${encodeURIComponent(meta.id)}/card/${encodeURIComponent(r.card.id)}">
    <img alt="" src="${esc(safeUrl(r.card.image_url))}">
    <div><strong>${esc(r.card.name)}</strong><p class="meta">${esc(r.card.set)} · ${formatDay(r.start.date)} → ${formatDay(r.end.date)}</p><span class="badge partial">tutte le lingue</span></div>
    <div class="chg ${r.diff < 0 ? "delta down" : "delta up"}">${signedMoney(r.diff)}<br>${pct(r.pct)}</div>
  </a>`).join("");
  view.innerHTML = `
    <div class="empty" style="text-align:left"><strong>Movimenti a 30 giorni — in arrivo</strong>
    <p>Lo storico Near Mint in lingua target parte dal 10 nov 2026 e ha un solo giorno, quindi la variazione ITA/JP non si può ancora calcolare. La lista usa il grafico di mercato CardTrader (tutte le lingue) ed è parziale.</p></div>
    <div class="list" style="margin-top:12px">${list || ""}</div>`;
}
view.addEventListener("click", (e) => {
  const sort = e.target.closest("[data-sort]");
  if (sort) { state.sort = sort.dataset.sort; state.page = 0; saveFilters(); render(); return; }
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
render();
