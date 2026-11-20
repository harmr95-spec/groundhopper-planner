/* =========================================================================
   Kosten pro Fahrt, Spiel und Übernachtung
   - Jede Station im Ablaufplan hat rechts ihren Betrag; aufgeklappt lassen
     sich Zeilen (Ticket, Zimmer, Maut …) eintragen – jeweils "geteilt"
     (einmal für alle) oder "pro Person".
   - Sprit wird automatisch berechnet: km pro durchfahrenem Land (Route über
     Ländergrenzen von Natural Earth) × Verbrauch × Spritpreis des Landes,
     immer geteilt durch die Zahl der Mitfahrer.
   - Gespeichert im Trip: trip.costs[key] = [{ id, label, amount, mode }]
     key: "match:<id>", "night:<Übernachtungs-Key>", "drive:<Fahrt-Key>"
   ========================================================================= */
(function () {
  "use strict";

  const FUEL_TYPES = {
    petrol: { label: "Benzin", unit: "l", priceUnit: "€/l", consumptionUnit: "l/100 km" },
    diesel: { label: "Diesel", unit: "l", priceUnit: "€/l", consumptionUnit: "l/100 km" },
    electric: { label: "Strom", unit: "kWh", priceUnit: "€/kWh", consumptionUnit: "kWh/100 km" }
  };
  const COUNTRY_NAMES = {
    ad: "Andorra", al: "Albanien", am: "Armenien", at: "Österreich", az: "Aserbaidschan", ba: "Bosnien", be: "Belgien",
    bg: "Bulgarien", by: "Belarus", ch: "Schweiz", cy: "Zypern", cz: "Tschechien", de: "Deutschland", dk: "Dänemark",
    ee: "Estland", es: "Spanien", fi: "Finnland", fo: "Färöer", fr: "Frankreich", gb: "Großbritannien", ge: "Georgien",
    gr: "Griechenland", hr: "Kroatien", hu: "Ungarn", ie: "Irland", is: "Island", it: "Italien", li: "Liechtenstein",
    lt: "Litauen", lu: "Luxemburg", lv: "Lettland", mc: "Monaco", md: "Moldau", me: "Montenegro", mk: "Nordmazedonien",
    mt: "Malta", nl: "Niederlande", no: "Norwegen", pl: "Polen", pt: "Portugal", ro: "Rumänien", rs: "Serbien",
    se: "Schweden", si: "Slowenien", sk: "Slowakei", sm: "San Marino", tr: "Türkei", ua: "Ukraine", xk: "Kosovo"
  };
  const PRESETS = {
    match: [["Ticket", "person"], ["Verpflegung", "person"], ["Parken", "shared"], ["Fanartikel", "person"], ["Programmheft", "person"]],
    night: [["Zimmer", "shared"], ["Frühstück", "person"], ["Kurtaxe", "person"], ["Parken", "shared"]],
    drive: [["Maut", "shared"], ["Vignette", "shared"], ["Parken", "shared"]]
  };
  const KIND_TITLE = { match: "Kosten Spiel", night: "Kosten Übernachtung", drive: "Kosten Fahrt" };

  // ---------- Einstellungen ----------
  const costCfg = () => {
    const c = (cfg().costs) || {};
    return {
      persons: Math.max(1, Math.round(+c.persons || 1)),
      fuelType: FUEL_TYPES[c.fuelType] ? c.fuelType : "petrol",
      consumption: Number.isFinite(+c.consumption) && +c.consumption >= 0 ? +c.consumption : 7,
      defaultFuelPrice: Number.isFinite(+c.defaultFuelPrice) && +c.defaultFuelPrice >= 0 ? +c.defaultFuelPrice : 1.8,
      fuelPrices: c.fuelPrices && typeof c.fuelPrices === "object" ? c.fuelPrices : {}
    };
  };
  const priceFor = (cc, c = costCfg()) => (Number.isFinite(+c.fuelPrices[cc]) && c.fuelPrices[cc] !== "" ? +c.fuelPrices[cc] : c.defaultFuelPrice);

  const eur = (v, digits = 0) => `${(Math.round(v * 100) / 100).toLocaleString("de-DE", { minimumFractionDigits: digits, maximumFractionDigits: digits })} €`;
  const parseAmount = v => { const n = parseFloat(String(v).replace(/[^\d,.-]/g, "").replace(/\.(?=\d{3}(\D|$))/g, "").replace(",", ".")); return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) / 100 : 0; };

  // ---------- Ländergrenzen (lazy) ----------
  let countriesPromise = null;
  function ensureCountries() {
    if (window.COUNTRY_SHAPES) return Promise.resolve(window.COUNTRY_SHAPES);
    if (!countriesPromise) {
      countriesPromise = new Promise(resolve => {
        const s = document.createElement("script");
        s.src = "./countries.js?v=20261120-1";
        s.onload = () => resolve(window.COUNTRY_SHAPES || []);
        s.onerror = () => resolve([]);
        document.head.appendChild(s);
      });
    }
    return countriesPromise;
  }

  function inRing(x, y, r) {
    let inside = false;
    for (let i = 0, j = r.length - 2; i < r.length; j = i, i += 2) {
      const xi = r[i], yi = r[i + 1], xj = r[j], yj = r[j + 1];
      if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  }
  let lastHit = null; // Routen bleiben meist lange im selben Land
  function countryAt(lng, lat, shapes) {
    const test = c => c.bbox[0] <= lng && lng <= c.bbox[2] && c.bbox[1] <= lat && lat <= c.bbox[3]
      && c.polys.some(rings => inRing(lng, lat, rings[0]) && !rings.slice(1).some(h => inRing(lng, lat, h)));
    if (lastHit && test(lastHit)) return lastHit.cc;
    const hit = shapes.find(test);
    if (hit) { lastHit = hit; return hit.cc; }
    return null;
  }

  const hav = (a, b) => {
    const R = d => d * Math.PI / 180;
    const x = Math.sin(R(b[1] - a[1]) / 2) ** 2 + Math.cos(R(a[1])) * Math.cos(R(b[1])) * Math.sin(R(b[0] - a[0]) / 2) ** 2;
    return 6371 * 2 * Math.asin(Math.sqrt(x));
  };

  // km pro Land für eine Strecke (Routenlinie, sonst Luftlinie), skaliert auf die Routen-km
  const kmCache = new Map();
  function kmByCountry(leg, shapes) {
    const key = `${leg.from.lat.toFixed(4)},${leg.from.lng.toFixed(4)}|${leg.to.lat.toFixed(4)},${leg.to.lng.toFixed(4)}`;
    if (kmCache.has(key)) return kmCache.get(key);
    let coords = leg.route && leg.route.geometry && Array.isArray(leg.route.geometry.coordinates) ? leg.route.geometry.coordinates : null;
    if (!coords || coords.length < 2) {
      coords = Array.from({ length: 21 }, (_, i) => [leg.from.lng + (leg.to.lng - leg.from.lng) * i / 20, leg.from.lat + (leg.to.lat - leg.from.lat) * i / 20]);
    }
    // Für die Länderzuordnung reichen Stützpunkte alle ~2 km
    const per = {};
    let sum = 0, carry = 0, start = coords[0];
    for (let i = 1; i < coords.length; i++) {
      const d = hav(coords[i - 1], coords[i]);
      carry += d;
      if (carry < 2 && i < coords.length - 1) continue;
      const mid = [(start[0] + coords[i][0]) / 2, (start[1] + coords[i][1]) / 2];
      const cc = countryAt(mid[0], mid[1], shapes) || "??";
      per[cc] = (per[cc] || 0) + carry;
      sum += carry; carry = 0; start = coords[i];
    }
    const total = leg.route && Number.isFinite(leg.route.distanceKm) ? leg.route.distanceKm : sum * (leg.route && leg.route.geometry ? 1 : 1.3);
    const scale = sum > 0 ? total / sum : 0;
    Object.keys(per).forEach(cc => { per[cc] *= scale; });
    // Unbekannte Stücke (z. B. Fähre/Küste) dem häufigsten Land zuschlagen
    if (per["??"]) {
      const main = Object.keys(per).filter(c => c !== "??").sort((a, b) => per[b] - per[a])[0];
      if (main) { per[main] += per["??"]; delete per["??"]; }
    }
    const result = { total, per };
    kmCache.set(key, result);
    return result;
  }

  // ---------- Registrierung während des Zeichnens ----------
  let reg = null; // { run, items: Map(key -> {key, kind, tile, legs}), tiles: Map(tile -> [keys]) }
  const openEditors = new Set();

  window.beginCostRender = function (run) { reg = { run, items: new Map(), tiles: new Map(), fuel: new Map() }; };

  window.registerCost = function ({ key, kind, tile, legs = [] }) {
    if (!reg) return;
    reg.items.set(key, { key, kind, tile, legs: legs.filter(l => l && l.from && l.to) });
    if (!reg.tiles.has(tile)) reg.tiles.set(tile, []);
    reg.tiles.get(tile).push(key);
  };

  // HTML für den Kostenbereich innerhalb einer Kachel
  window.costCellHtml = function (key) {
    const open = openEditors.has(key);
    return `<div class="cost-cell">
        <button type="button" class="cost-btn${open ? " open" : ""}" data-cost-btn="${escapeHtml(key)}" onclick="toggleCostEditor('${escapeHtml(key)}')" aria-expanded="${open}">
          <span class="cost-amount">…</span>${icon("chevron-right", "cost-chevron")}
        </button>
        <span class="cost-sub" data-cost-sub="${escapeHtml(key)}"></span>
      </div>
      <div class="cost-editor" data-cost-editor="${escapeHtml(key)}" ${open ? "" : "hidden"}></div>`;
  };

  window.dayTotalHtml = function (tile) {
    return `<span class="day-total" data-day-total="${escapeHtml(tile)}"></span>`;
  };

  // Nach dem Einfügen ins DOM: Sprit berechnen und alle Beträge setzen
  window.finishCostRender = async function (run) {
    if (!reg || reg.run !== run) return;
    const shapes = await ensureCountries();
    if (!reg || reg.run !== run) return;
    const countries = {};
    reg.items.forEach(item => {
      const legs = item.legs.map(l => kmByCountry(l, shapes));
      reg.fuel.set(item.key, legs);
      legs.forEach(l => Object.entries(l.per).forEach(([cc, km]) => { countries[cc] = (countries[cc] || 0) + km; }));
    });
    const trip = getActiveTrip();
    if (trip) {
      trip.routeCountries = Object.fromEntries(Object.entries(countries).map(([cc, km]) => [cc, Math.round(km)]));
      saveLocalStorage();
    }
    refreshCosts();
  };

  // ---------- Berechnung ----------
  function fuelOf(key, c = costCfg()) {
    const legs = (reg && reg.fuel.get(key)) || [];
    const per = {};
    let km = 0;
    legs.forEach(l => { km += l.total; Object.entries(l.per).forEach(([cc, k]) => { per[cc] = (per[cc] || 0) + k; }); });
    let cost = 0, units = 0;
    Object.entries(per).forEach(([cc, k]) => {
      const u = k / 100 * c.consumption;
      units += u;
      cost += u * priceFor(cc, c);
    });
    return { km, per, cost, units };
  }

  const linesOf = key => { const t = getActiveTrip(); return (t && t.costs && t.costs[key]) || []; };

  function totalsOf(key, c = costCfg()) {
    const item = reg && reg.items.get(key);
    const fuel = item && item.legs.length ? fuelOf(key, c) : { km: 0, per: {}, cost: 0, units: 0 };
    let shared = 0, person = 0;
    linesOf(key).forEach(l => { if (l.mode === "person") person += l.amount; else shared += l.amount; });
    const total = fuel.cost + shared + person * c.persons;
    const perPerson = (fuel.cost + shared) / c.persons + person;
    return { fuel, shared, person, total, perPerson, hasAny: fuel.cost > 0 || linesOf(key).length > 0 };
  }

  function subText(key, t) {
    const lines = linesOf(key);
    const parts = [];
    if (t.fuel.cost > 0) parts.push(`Sprit ${eur(t.fuel.cost)}`);
    lines.slice(0, t.fuel.cost > 0 ? 1 : 2).forEach(l => parts.push(l.label || "Posten"));
    if (lines.length > (t.fuel.cost > 0 ? 1 : 2)) parts.push(`+${lines.length - (t.fuel.cost > 0 ? 1 : 2)}`);
    return parts.join(" · ");
  }

  // Alle Anzeigen (Buttons, Tagessummen, Plan) aktualisieren
  function refreshCosts() {
    if (!reg || !reg.items.size) return;
    const c = costCfg();
    const totals = new Map();
    reg.items.forEach((item, key) => totals.set(key, totalsOf(key, c)));

    totals.forEach((t, key) => {
      document.querySelectorAll(`[data-cost-btn="${CSS.escape(key)}"]`).forEach(btn => {
        btn.querySelector(".cost-amount").textContent = t.hasAny ? eur(t.total) : "+ Kosten";
        btn.classList.toggle("empty", !t.hasAny);
      });
      document.querySelectorAll(`[data-cost-sub="${CSS.escape(key)}"]`).forEach(el => { el.textContent = t.hasAny ? subText(key, t) : ""; });
      if (openEditors.has(key)) renderEditor(key, t, c);
    });

    reg.tiles.forEach((keys, tile) => {
      const sum = keys.reduce((a, k) => a + totals.get(k).total, 0);
      const pp = keys.reduce((a, k) => a + totals.get(k).perPerson, 0);
      document.querySelectorAll(`[data-day-total="${CSS.escape(tile)}"]`).forEach(el => {
        el.innerHTML = sum > 0 ? `${eur(sum)}${c.persons > 1 ? `<small>· ${eur(pp)} p. P.</small>` : ""}` : "";
      });
    });

    // Plan-Übersicht
    const cat = { fuel: 0, units: 0, km: 0, driveExtra: 0, match: 0, night: 0, total: 0, pp: 0 };
    reg.items.forEach((item, key) => {
      const t = totals.get(key);
      cat.fuel += t.fuel.cost; cat.units += t.fuel.units; cat.km += t.fuel.km;
      const extra = t.total - t.fuel.cost;
      if (item.kind === "drive") cat.driveExtra += extra; else cat[item.kind] += extra;
      cat.total += t.total; cat.pp += t.perPerson;
    });
    const pill = document.getElementById("planCostPill");
    if (pill) {
      pill.hidden = false;
      pill.innerHTML = `${icon("calculator")} ≈ <strong>${eur(cat.total)}</strong>${c.persons > 1 ? ` · ${eur(cat.pp)} p. P.` : ""}`;
    }
    const km = document.getElementById("planKm");
    if (km && cat.km) km.textContent = ` · ${Math.round(cat.km).toLocaleString("de-DE")} km`;
    const sum = document.getElementById("planCostSummary");
    if (sum) {
      const ft = FUEL_TYPES[c.fuelType];
      const row = (label, v, note = "") => `<tr><td>${label}</td><td class="num">${eur(v)}</td><td class="muted num">${note}</td></tr>`;
      sum.hidden = false;
      sum.querySelector(".cost-table").innerHTML =
        row(`Sprit (${Math.round(cat.km).toLocaleString("de-DE")} km, ${Math.round(cat.units).toLocaleString("de-DE")} ${ft.unit})`, cat.fuel, c.persons > 1 ? "geteilt" : "") +
        row("Fahrt-Extras (Maut, Vignetten, Parken …)", cat.driveExtra) +
        row("Spiele (Tickets, Verpflegung …)", cat.match) +
        row("Übernachtungen", cat.night) +
        `<tr class="sum"><td>Gesamt</td><td class="num">${eur(cat.total)}</td><td class="num">${c.persons > 1 ? `${eur(cat.pp)} p. P.` : ""}</td></tr>`;
    }
  }
  window.refreshCosts = refreshCosts;

  // Wird nur die Plan-Kopfzeile neu gezeichnet (z. B. Hinweis), Kosten-Etikett wieder befüllen
  const originalRenderPlanSwitcher = window.renderPlanSwitcher;
  if (typeof originalRenderPlanSwitcher === "function") {
    window.renderPlanSwitcher = function (plan) {
      originalRenderPlanSwitcher(plan);
      refreshCosts();
    };
  }

  // ---------- Editor ----------
  function renderEditor(key, t = totalsOf(key), c = costCfg()) {
    const el = document.querySelector(`[data-cost-editor="${CSS.escape(key)}"]`);
    const item = reg && reg.items.get(key);
    if (!el || !item) return;
    const k = escapeHtml(key);
    const ft = FUEL_TYPES[c.fuelType];
    const shareToggle = (line) => `<span class="share-toggle" role="group" aria-label="Aufteilung">
        <button type="button" class="${line.mode !== "person" ? "on" : ""}" onclick="costSetMode('${k}','${line.id}','shared')" title="Betrag fällt einmal an und wird geteilt">${icon("users")} geteilt</button>
        <button type="button" class="${line.mode === "person" ? "on" : ""}" onclick="costSetMode('${k}','${line.id}','person')" title="Betrag fällt für jede Person an">${icon("ticket")} pro Person</button>
      </span>`;
    const fuelRow = item.legs.length ? `
      <div class="ce-row ce-auto">
        <span class="ce-label">${icon("sparkles", "tone-sky")}<span>Sprit (automatisch)<br><small>${Object.entries(t.fuel.per).sort((a, b) => b[1] - a[1]).map(([cc, km]) =>
          `<span class="flag">${cc.toUpperCase()}</span> ${Math.round(km)} km × ${priceFor(cc, c).toLocaleString("de-DE", { minimumFractionDigits: 2 })} ${ft.priceUnit.replace("€/", "€/")}`).join(" · ") || "–"}</small></span></span>
        <span class="ce-amount num"><strong>${eur(t.fuel.cost, 2)}</strong></span>
        <span class="muted ce-note">${c.persons > 1 ? `geteilt durch ${c.persons}` : ""}</span><span></span>
      </div>` : "";
    const rows = linesOf(key).map(line => `
      <div class="ce-row">
        <input type="text" value="${escapeHtml(line.label)}" placeholder="Bezeichnung" oninput="costUpdateLabel('${k}','${line.id}',this.value)" aria-label="Bezeichnung">
        <input type="text" inputmode="decimal" class="num" value="${line.amount ? line.amount.toLocaleString("de-DE", { minimumFractionDigits: 2 }) : ""}" placeholder="0,00 €" onchange="costUpdateAmount('${k}','${line.id}',this.value)" aria-label="Betrag">
        ${shareToggle(line)}
        <button type="button" class="icon-btn ce-del" onclick="costDeleteLine('${k}','${line.id}')" title="Zeile löschen" aria-label="Zeile löschen">${icon("trash-2")}</button>
      </div>`).join("");
    el.innerHTML = `
      <div class="ce-head"><span>${KIND_TITLE[item.kind]}</span><span class="muted">${item.legs.length ? `${c.consumption.toLocaleString("de-DE")} ${ft.consumptionUnit} ${ft.label} · ` : ""}${c.persons} Person${c.persons === 1 ? "" : "en"}</span></div>
      ${fuelRow}${rows}
      <div class="ce-presets">${PRESETS[item.kind].map(([label], i) => `<button type="button" class="preset" onclick="costAddLine('${k}',${i})">${icon("plus")} ${label}</button>`).join("")}
        <button type="button" class="preset" onclick="costAddLine('${k}',-1)">${icon("plus")} Eigene Zeile</button></div>
      <div class="ce-foot"><span>Summe für alle: <strong>${eur(t.total, 2)}</strong></span>${c.persons > 1 ? `<span>pro Person: <strong>${eur(t.perPerson, 2)}</strong></span>` : ""}</div>`;
  }

  window.toggleCostEditor = function (key) {
    const open = !openEditors.has(key);
    if (open) openEditors.add(key); else openEditors.delete(key);
    document.querySelectorAll(`[data-cost-editor="${CSS.escape(key)}"]`).forEach(el => { el.hidden = !open; });
    document.querySelectorAll(`[data-cost-btn="${CSS.escape(key)}"]`).forEach(b => { b.classList.toggle("open", open); b.setAttribute("aria-expanded", open); });
    if (open) renderEditor(key);
  };

  function mutate(key, fn, rerenderEditor = true) {
    const trip = getActiveTrip();
    if (!trip) return;
    if (!trip.costs) trip.costs = {};
    const lines = trip.costs[key] ? [...trip.costs[key]] : [];
    const next = fn(lines);
    if (next.length) trip.costs[key] = next; else delete trip.costs[key];
    saveLocalStorage();
    if (rerenderEditor) refreshCosts();
    else { // nur Zahlen/Texte außerhalb des Editors aktualisieren (Eingabefokus bleibt erhalten)
      const was = openEditors.has(key);
      openEditors.delete(key); refreshCosts(); if (was) openEditors.add(key);
    }
  }
  const newId = () => `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

  window.costAddLine = function (key, presetIdx) {
    const item = reg && reg.items.get(key);
    const preset = presetIdx >= 0 && item ? PRESETS[item.kind][presetIdx] : ["", "shared"];
    mutate(key, lines => [...lines, { id: newId(), label: preset[0], amount: 0, mode: preset[1] }]);
    // Fokus direkt ins Betragsfeld der neuen Zeile
    setTimeout(() => {
      const ed = document.querySelector(`[data-cost-editor="${CSS.escape(key)}"]`);
      const inputs = ed ? ed.querySelectorAll(".ce-row:not(.ce-auto) input.num") : [];
      if (inputs.length) inputs[inputs.length - 1].focus();
    }, 0);
  };
  window.costUpdateLabel = (key, id, value) => mutate(key, lines => lines.map(l => (l.id === id ? { ...l, label: String(value).slice(0, 80) } : l)), false);
  window.costUpdateAmount = (key, id, value) => mutate(key, lines => lines.map(l => (l.id === id ? { ...l, amount: parseAmount(value) } : l)));
  window.costSetMode = (key, id, mode) => mutate(key, lines => lines.map(l => (l.id === id ? { ...l, mode: mode === "person" ? "person" : "shared" } : l)));
  window.costDeleteLine = (key, id) => mutate(key, lines => lines.filter(l => l.id !== id));

  // ---------- Einstellungen: Spritpreise pro durchfahrenem Land ----------
  window.loadCostSettingsIntoForm = function () {
    const c = costCfg();
    const set = (id, v) => { const el = document.getElementById(id); if (el) el.value = v; };
    set("costPersons", c.persons);
    set("costFuelType", c.fuelType);
    set("costConsumption", String(c.consumption).replace(".", ","));
    set("costDefaultPrice", c.defaultFuelPrice.toLocaleString("de-DE", { minimumFractionDigits: 2 }));
    updateFuelUnits();
    const trip = getActiveTrip();
    const countries = Object.entries((trip && trip.routeCountries) || {}).sort((a, b) => b[1] - a[1]);
    const box = document.getElementById("costCountryPrices");
    if (!box) return;
    box.innerHTML = countries.length
      ? countries.map(([cc, km]) => `
        <div class="fuel-row">
          <span><span class="flag">${cc.toUpperCase()}</span> ${escapeHtml(COUNTRY_NAMES[cc] || cc.toUpperCase())} <span class="muted">· ${km.toLocaleString("de-DE")} km</span></span>
          <span class="input-unit"><input type="text" inputmode="decimal" data-fuel-cc="${cc}" value="${c.fuelPrices[cc] !== undefined && c.fuelPrices[cc] !== "" ? (+c.fuelPrices[cc]).toLocaleString("de-DE", { minimumFractionDigits: 2 }) : ""}" placeholder="${c.defaultFuelPrice.toLocaleString("de-DE", { minimumFractionDigits: 2 })}"><em class="fuel-price-unit">${FUEL_TYPES[c.fuelType].priceUnit}</em></span>
        </div>`).join("")
      : `<p class="muted">Die durchfahrenen Länder erscheinen hier, sobald die Route berechnet und angezeigt wurde.</p>`;
  };

  function updateFuelUnits() {
    const type = (document.getElementById("costFuelType") || {}).value || "petrol";
    const ft = FUEL_TYPES[type] || FUEL_TYPES.petrol;
    document.querySelectorAll(".fuel-consumption-unit").forEach(el => { el.textContent = ft.consumptionUnit; });
    document.querySelectorAll(".fuel-price-unit").forEach(el => { el.textContent = ft.priceUnit; });
  }
  window.updateFuelUnits = updateFuelUnits;

  window.saveCostSettingsFromForm = function () {
    const settings = cfg();
    const prev = costCfg();
    const fuelPrices = { ...prev.fuelPrices };
    document.querySelectorAll("[data-fuel-cc]").forEach(inp => {
      if (inp.value.trim() === "") delete fuelPrices[inp.dataset.fuelCc];
      else fuelPrices[inp.dataset.fuelCc] = parseAmount(inp.value);
    });
    const num = (id, fallback) => { const el = document.getElementById(id); if (!el || el.value.trim() === "") return fallback; return parseAmount(el.value); };
    settings.costs = {
      persons: Math.max(1, Math.min(9, Math.round(num("costPersons", prev.persons)) || 1)),
      fuelType: FUEL_TYPES[(document.getElementById("costFuelType") || {}).value] ? document.getElementById("costFuelType").value : prev.fuelType,
      consumption: num("costConsumption", prev.consumption),
      defaultFuelPrice: num("costDefaultPrice", prev.defaultFuelPrice),
      fuelPrices
    };
  };

  // ---------- Import/Export & Aufräumen ----------
  // Kosten-Schlüssel enthalten Spiel-IDs -> beim Import auf die neuen IDs umschlüsseln
  window.sanitizeStoredCosts = function (raw, idMap) {
    if (!raw || typeof raw !== "object") return {};
    const out = {};
    Object.entries(raw).forEach(([key, lines]) => {
      if (!/^(match|night|drive):[A-Za-z0-9_@:-]{1,120}$/.test(key) || !Array.isArray(lines)) return;
      // Aufbau: <art>:<id> | <art>:<id>@<datum> | drive:home:<id> | <art>:__start@<datum> / __home@<datum>
      const [kind, ...restParts] = key.split(":");
      let rest = restParts.join(":"), prefix = "";
      if (rest.startsWith("home:")) { prefix = "home:"; rest = rest.slice(5); }
      let newKey = key;
      if (!rest.startsWith("__")) {
        const [id, ...suffix] = rest.split("@");
        if (!idMap.has(id)) return; // Spiel existiert nicht mehr
        newKey = `${kind}:${prefix}${idMap.get(id)}${suffix.length ? "@" + suffix.join("@") : ""}`;
      }
      const clean = lines.slice(0, 50).map(l => ({
        id: /^[A-Za-z0-9]{1,20}$/.test(String(l && l.id)) ? String(l.id) : newId(),
        label: String((l && l.label) || "").slice(0, 80),
        amount: parseAmount(l && l.amount),
        mode: l && l.mode === "person" ? "person" : "shared"
      }));
      if (clean.length) out[newKey] = clean;
    });
    return out;
  };

  window.removeCostsForMatch = function (trip, matchId) {
    if (!trip || !trip.costs) return;
    Object.keys(trip.costs).forEach(k => { if (k.includes(matchId)) delete trip.costs[k]; });
  };
})();
