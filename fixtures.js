/* =========================================================================
   Spielplan-Import und Anstoßzeit-Wächter über API-Football (api-sports.io)
   - Schlüssel nur gerätelokal (localStorage), nie im Trip/Export/Code.
   - Import: pro Tag EINE Anfrage (/fixtures?date=…) für alle Länder;
     gefiltert wird im Browser. Ergebnisse werden pro Sitzung zwischengespeichert.
   - Wächter: bei bestätigten Trips werden die eingeplanten Spiele höchstens
     alle 6 Stunden auf verlegte/abgesagte Termine geprüft (/fixtures?ids=…).
     Manuell angelegte Spiele werden dabei automatisch anhand von Datum und
     Teamnamen mit API-Football verknüpft.
   ========================================================================= */
(function () {
  "use strict";

  const KEY_STORAGE = "groundhopping_apifootball";
  const API = "https://v3.football.api-sports.io";
  const MAX_DAYS = 10;                       // Zeitraum-Grenze pro Import (= max. 10 Anfragen)
  const CHECK_INTERVAL_MS = 6 * 3600 * 1000; // Wächter: höchstens alle 6 Stunden
  const dayCache = new Map();                // Datum -> Fixtures (nur diese Sitzung)

  // API-Ländername -> [Ländercode, deutscher Name]
  const COUNTRIES = [
    ["Germany", "de", "Deutschland"], ["England", "gb", "England"], ["Spain", "es", "Spanien"], ["Italy", "it", "Italien"],
    ["France", "fr", "Frankreich"], ["Netherlands", "nl", "Niederlande"], ["Belgium", "be", "Belgien"], ["Portugal", "pt", "Portugal"],
    ["Austria", "at", "Österreich"], ["Switzerland", "ch", "Schweiz"], ["Scotland", "gb", "Schottland"], ["Wales", "gb", "Wales"],
    ["Northern-Ireland", "gb", "Nordirland"], ["Ireland", "ie", "Irland"], ["Denmark", "dk", "Dänemark"], ["Sweden", "se", "Schweden"],
    ["Norway", "no", "Norwegen"], ["Finland", "fi", "Finnland"], ["Iceland", "is", "Island"], ["Poland", "pl", "Polen"],
    ["Czech-Republic", "cz", "Tschechien"], ["Slovakia", "sk", "Slowakei"], ["Hungary", "hu", "Ungarn"], ["Slovenia", "si", "Slowenien"],
    ["Croatia", "hr", "Kroatien"], ["Serbia", "rs", "Serbien"], ["Bosnia", "ba", "Bosnien"], ["Romania", "ro", "Rumänien"],
    ["Bulgaria", "bg", "Bulgarien"], ["Greece", "gr", "Griechenland"], ["Turkey", "tr", "Türkei"], ["Ukraine", "ua", "Ukraine"],
    ["Luxembourg", "lu", "Luxemburg"], ["Cyprus", "cy", "Zypern"], ["World", "", "International"]
  ];
  const COUNTRY_BY_API = Object.fromEntries(COUNTRIES.map(([api, cc, de]) => [api, { cc, de }]));

  // Ligastufe für bekannte API-Football-Liga-IDs
  const LEAGUE_LEVEL = {
    78: 1, 79: 2, 80: 3, 39: 1, 40: 2, 41: 3, 42: 4, 43: 5, 140: 1, 141: 2, 135: 1, 136: 2, 61: 1, 62: 2, 63: 3,
    88: 1, 89: 2, 144: 1, 145: 2, 94: 1, 95: 2, 218: 1, 219: 2, 207: 1, 208: 2, 179: 1, 180: 2, 119: 1, 120: 2,
    203: 1, 204: 2, 106: 1, 107: 2, 197: 1, 345: 1, 113: 1, 103: 1
  };

  // ---------- Schlüssel ----------
  const apiKey = () => { try { return String(localStorage.getItem(KEY_STORAGE) || ""); } catch (e) { return ""; } };
  window.loadFootballKeyIntoForm = function () {
    const el = document.getElementById("apiFootballKey");
    if (el) el.value = apiKey();
    setStatus("apiFootballStatus", apiKey() ? "Schlüssel gespeichert." : "", apiKey() ? "ok" : "");
  };
  window.saveFootballKeyFromForm = function () {
    const el = document.getElementById("apiFootballKey");
    if (!el) return;
    try { localStorage.setItem(KEY_STORAGE, el.value.trim()); } catch (e) { /* voll */ }
  };
  function setStatus(id, text, kind) {
    const el = document.getElementById(id);
    if (!el) return;
    el.className = `ai-key-status ${kind || ""}`;
    el.innerHTML = text ? `${icon(kind === "ok" ? "circle-check" : kind === "error" ? "circle-x" : "loader-circle", kind === "busy" ? "spin" : "")} ${escapeHtml(text)}` : "";
  }

  // ---------- API-Aufruf ----------
  class FootballError extends Error {}

  async function apiGet(path, key = apiKey()) {
    if (!key) throw new FootballError("Bitte zuerst einen API-Football-Schlüssel in den Einstellungen eintragen.");
    let res;
    try {
      res = await fetchWithTimeout(`${API}${path}`, 20000, { headers: { "x-apisports-key": key } });
    } catch (err) {
      throw new FootballError("API-Football ist nicht erreichbar (Netzwerk, Werbeblocker oder Zeitüberschreitung).");
    }
    let data = null;
    try { data = await res.json(); } catch (e) { /* kein JSON */ }
    if (!res.ok) throw new FootballError(`API-Football-Fehler: HTTP ${res.status}`);
    // API-Football meldet Fehler mit HTTP 200 im Feld "errors"
    const errors = data && data.errors;
    const errList = Array.isArray(errors) ? errors : errors && typeof errors === "object" ? Object.entries(errors) : [];
    if (errList.length) {
      const text = errList.map(e => (Array.isArray(e) ? `${e[0]}: ${e[1]}` : String(e))).join(" · ");
      if (/token|key/i.test(text)) throw new FootballError("Der API-Football-Schlüssel ist ungültig.");
      if (/request|limit/i.test(text)) throw new FootballError("Das Tageslimit von API-Football ist erreicht (kostenlos: 100 Anfragen/Tag, Reset um 01:00 Uhr deutscher Zeit).");
      if (/plan|season/i.test(text)) throw new FootballError(`Der kostenlose API-Football-Tarif erlaubt diese Daten nicht: ${text}`);
      throw new FootballError(`API-Football: ${text}`);
    }
    return data;
  }

  window.testFootballKey = async function () {
    const key = document.getElementById("apiFootballKey").value.trim();
    if (!key) { setStatus("apiFootballStatus", "Bitte zuerst einen Schlüssel eintragen.", "error"); return; }
    setStatus("apiFootballStatus", "Teste Verbindung …", "busy");
    try {
      const data = await apiGet("/status", key);
      const r = (data && data.response) || {};
      const req = r.requests || {};
      const plan = (r.subscription && r.subscription.plan) || "?";
      setStatus("apiFootballStatus", `Verbindung klappt – Tarif ${plan}, heute ${req.current ?? "?"} von ${req.limit_day ?? "?"} Anfragen genutzt.`, "ok");
    } catch (err) {
      setStatus("apiFootballStatus", err.message, "error");
    }
  };

  async function fixturesForDate(date) {
    if (dayCache.has(date)) return dayCache.get(date);
    const data = await apiGet(`/fixtures?date=${date}`);
    const list = Array.isArray(data && data.response) ? data.response : [];
    dayCache.set(date, list);
    return list;
  }

  // ---------- Umrechnung API-Fixture -> Spiel ----------
  function localDateTime(tsSec, tz) {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23"
    }).formatToParts(new Date(tsSec * 1000));
    const v = Object.fromEntries(parts.map(p => [p.type, p.value]));
    return { date: `${v.year}-${v.month}-${v.day}`, time: `${v.hour}:${v.minute}` };
  }

  function competitionOf(f) {
    const lg = f.league || {}, name = String(lg.name || ""), round = String(lg.round || "");
    if (/friendl/i.test(name)) return { competitionType: "friendly" };
    const isCup = String(lg.type || "").toLowerCase() === "cup" || lg.country === "World";
    if (isCup) {
      const stage = /final/i.test(round) && !/semi|quarter|1\/2|1\/4/i.test(round) ? "final"
        : /semi|1\/2/i.test(round) ? "semifinal"
        : /group/i.test(round) ? "group"
        : /qualif|preliminary/i.test(round) ? "qualification" : "knockout";
      return { competitionType: lg.country === "World" ? "international_cup" : "national_cup", cupStage: stage };
    }
    let level = LEAGUE_LEVEL[lg.id];
    if (!level) level = /\b(2\.|II|2)\b|second|segunda|serie b|ligue 2|championship|eerste/i.test(name) ? 2
      : /\b(3\.|III|3)\b|third|tercera|national|league one/i.test(name) ? 3 : 3;
    return { competitionType: "league", leagueLevel: level };
  }

  const tz = cc => zoneFor(cc);

  function fixtureLocal(f) {
    const country = COUNTRY_BY_API[(f.league || {}).country] || { cc: "" };
    return localDateTime((f.fixture || {}).timestamp, tz(country.cc));
  }

  // ---------- Import-Dialog ----------
  let lastResults = [];        // geladene Fixtures (gefiltert nach Ländern)
  let selectedCountries = null;

  function ensureModal() {
    let el = document.getElementById("importModal");
    if (el) return el;
    document.body.insertAdjacentHTML("beforeend", `
      <div id="importModal" class="modal" onclick="if (event.target === this) closeFixtureImport()">
        <div class="modal-content import-modal" role="dialog" aria-modal="true" aria-label="Spielplan importieren"></div>
      </div>`);
    el = document.getElementById("importModal");
    document.addEventListener("keydown", e => { if (e.key === "Escape" && el.style.display === "flex") closeFixtureImport(); });
    return el;
  }
  window.closeFixtureImport = function () {
    const el = document.getElementById("importModal");
    if (el) el.style.display = "none";
  };

  window.openFixtureImport = function () {
    if (typeof frozenGuard === "function" && frozenGuard()) return;
    const trip = getActiveTrip();
    if (!trip) return;
    const dates = trip.matches.map(m => m.date).sort();
    const today = new Date().toISOString().slice(0, 10);
    const from = dates[0] || today;
    const to = dates[dates.length - 1] || addDaysIso(from, 3);
    if (!selectedCountries) {
      const ccs = new Set(trip.matches.map(m => m.countryCode).filter(Boolean));
      selectedCountries = new Set(COUNTRIES.filter(([, cc]) => cc && ccs.has(cc) && cc !== "gb").map(([api]) => api));
      if (ccs.has("gb")) selectedCountries.add("England");
      if (!selectedCountries.size) selectedCountries.add("Germany");
    }
    const box = ensureModal().querySelector(".modal-content");
    box.innerHTML = `
      <div class="modal-header">
        <div><h2>Spielplan importieren</h2><p class="settings-hint">Spiele aus API-Football für einen Zeitraum und ausgewählte Länder laden.</p></div>
        <button type="button" class="modal-close" onclick="closeFixtureImport()" aria-label="Schließen">${icon("x")}</button>
      </div>
      <div class="modal-body">
        ${apiKey() ? "" : bannerHtml("warning", `Dafür wird ein kostenloser API-Football-Schlüssel benötigt (100 Anfragen/Tag) – <a href="https://dashboard.api-football.com/register" target="_blank" rel="noopener">hier registrieren</a> und unter ⚙️ Einstellungen eintragen.`)}
        <div class="field-pair">
          <label class="setting-field">Von<input type="date" id="impFrom" value="${from}"></label>
          <label class="setting-field">Bis<input type="date" id="impTo" value="${to}"></label>
        </div>
        <p class="settings-hint">Pro Tag wird eine Anfrage gestellt (max. ${MAX_DAYS} Tage). Bereits geladene Tage kosten keine weitere Anfrage.</p>
        <div class="country-chips">${COUNTRIES.map(([api, , de]) => `
          <label class="chip-toggle"><input type="checkbox" value="${api}" ${selectedCountries.has(api) ? "checked" : ""} onchange="toggleImportCountry(this)"><span>${de}</span></label>`).join("")}
        </div>
        <button class="btn btn-soft btn-block" onclick="loadFixtures()">${icon("download")} Spiele laden</button>
        <div id="impStatus" class="ai-key-status"></div>
        <div id="impResults" class="imp-results"></div>
      </div>
      <div class="modal-actions">
        <span id="impCount" class="muted imp-count"></span>
        <button class="btn btn-ghost" onclick="closeFixtureImport()">Schließen</button>
        <button class="btn btn-primary" id="impAddBtn" onclick="addSelectedFixtures()" disabled>${icon("plus")} Hinzufügen</button>
      </div>`;
    ensureModal().style.display = "flex";
    if (lastResults.length) renderResults();
  };

  window.toggleImportCountry = function (el) {
    if (el.checked) selectedCountries.add(el.value); else selectedCountries.delete(el.value);
    if (lastResults.length) renderResults();
  };

  window.loadFixtures = async function () {
    const from = document.getElementById("impFrom").value, to = document.getElementById("impTo").value;
    if (!from || !to || to < from) { setStatus("impStatus", "Bitte einen gültigen Zeitraum wählen.", "error"); return; }
    const days = daysBetween(from, to) + 1;
    if (days > MAX_DAYS) { setStatus("impStatus", `Bitte höchstens ${MAX_DAYS} Tage auf einmal laden.`, "error"); return; }
    const dates = Array.from({ length: days }, (_, i) => addDaysIso(from, i));
    const all = [];
    try {
      for (let i = 0; i < dates.length; i++) {
        setStatus("impStatus", `Lade ${formatDateShort(dates[i])} (${i + 1}/${dates.length}) …`, "busy");
        all.push(...await fixturesForDate(dates[i]));
      }
    } catch (err) {
      setStatus("impStatus", err.message, "error");
      if (!all.length) return;
    }
    lastResults = all;
    setStatus("impStatus", "", "");
    renderResults();
  };

  function renderResults() {
    const trip = getActiveTrip();
    const inTrip = new Set(trip.matches.map(m => m.apiFixtureId).filter(Boolean));
    const list = lastResults
      .filter(f => selectedCountries.has((f.league || {}).country))
      .filter(f => !["FT", "AET", "PEN", "CANC", "ABD", "AWD", "WO"].includes(((f.fixture || {}).status || {}).short))
      .sort((a, b) => a.fixture.timestamp - b.fixture.timestamp);
    const el = document.getElementById("impResults");
    if (!el) return;
    if (!list.length) {
      el.innerHTML = `<p class="muted">Keine anstehenden Spiele für die gewählten Länder im Zeitraum gefunden.</p>`;
      updateCount();
      return;
    }
    // Gruppieren: Tag -> Liga
    const groups = new Map();
    list.forEach(f => {
      const { date } = fixtureLocal(f);
      const key = `${date}|${f.league.country}|${f.league.id}`;
      if (!groups.has(key)) groups.set(key, { date, league: f.league, fixtures: [] });
      groups.get(key).fixtures.push(f);
    });
    let lastDate = "";
    el.innerHTML = [...groups.values()].sort((a, b) => a.date.localeCompare(b.date)).map(g => {
      const dayHead = g.date !== lastDate ? `<h4 class="imp-day">${formatDateLong(g.date)}</h4>` : "";
      lastDate = g.date;
      const country = COUNTRY_BY_API[g.league.country] || { de: g.league.country };
      return `${dayHead}
        <div class="imp-league">
          <label class="imp-league-head"><input type="checkbox" onchange="toggleImportLeague(this)">
            ${g.league.logo ? `<img src="${escapeHtml(safeHttpUrl(g.league.logo))}" alt="" class="crest" loading="lazy" onerror="this.remove()">` : ""}
            <strong>${escapeHtml(g.league.name)}</strong> <span class="muted">${escapeHtml(country.de)}</span></label>
          ${g.fixtures.map(f => {
            const { time } = fixtureLocal(f);
            const done = inTrip.has(f.fixture.id);
            const venue = f.fixture.venue || {};
            return `<label class="imp-fixture${done ? " done" : ""}">
              <input type="checkbox" value="${f.fixture.id}" ${done ? "disabled" : ""} onchange="updateImportCount()">
              <span class="imp-time">${time}</span>
              <span class="imp-teams">${crestImg(f.teams.home.logo, f.teams.home.name)}${escapeHtml(f.teams.home.name)} – ${escapeHtml(f.teams.away.name)}${crestImg(f.teams.away.logo, f.teams.away.name)}</span>
              <span class="muted imp-venue">${done ? "bereits im Trip" : escapeHtml([venue.name, venue.city].filter(Boolean).join(", "))}</span>
            </label>`;
          }).join("")}
        </div>`;
    }).join("");
    updateCount();
  }

  window.toggleImportLeague = function (el) {
    el.closest(".imp-league").querySelectorAll(".imp-fixture input:not(:disabled)").forEach(cb => { cb.checked = el.checked; });
    updateCount();
  };
  function updateCount() {
    const n = document.querySelectorAll("#impResults .imp-fixture input:checked").length;
    const btn = document.getElementById("impAddBtn");
    if (btn) { btn.disabled = !n; btn.innerHTML = `${icon("plus")} ${n ? `${n} Spiel${n === 1 ? "" : "e"} hinzufügen` : "Hinzufügen"}`; }
    const c = document.getElementById("impCount");
    if (c) c.textContent = "";
  }
  window.updateImportCount = updateCount;

  // Ausgewählte Spiele anlegen (Stadion wird über Nominatim verortet – max. 1 Anfrage/s)
  window.addSelectedFixtures = async function () {
    if (typeof frozenGuard === "function" && frozenGuard()) return;
    const trip = getActiveTrip();
    const ids = [...document.querySelectorAll("#impResults .imp-fixture input:checked")].map(cb => Number(cb.value));
    const chosen = lastResults.filter(f => ids.includes(f.fixture.id));
    const btn = document.getElementById("impAddBtn");
    if (btn) btn.disabled = true;
    let added = 0, failed = [];
    for (let i = 0; i < chosen.length; i++) {
      const f = chosen[i];
      setStatus("impStatus", `Verorte Stadion ${i + 1}/${chosen.length}: ${f.fixture.venue && f.fixture.venue.name || f.teams.home.name} …`, "busy");
      const match = await fixtureToMatch(f);
      if (match) { trip.matches.push(match); added++; } else failed.push(`${f.teams.home.name} – ${f.teams.away.name}`);
    }
    if (added) {
      delete trip.plans;
      currentPlans = null;
      saveLocalStorage();
      renderActiveTrip();
    }
    setStatus("impStatus", `${added} Spiel(e) hinzugefügt.${failed.length ? ` Nicht gefunden: ${failed.join(", ")} – bitte manuell anlegen.` : ""}`, failed.length ? "error" : "ok");
    renderResults();
  };

  async function fixtureToMatch(f) {
    const venue = f.fixture.venue || {};
    const country = COUNTRY_BY_API[f.league.country] || { cc: "", de: f.league.country };
    const countryName = f.league.country === "World" ? "" : country.de;
    const queries = [
      [venue.name, venue.city, countryName].filter(Boolean).join(", "),
      [venue.city, countryName].filter(Boolean).join(", "),
      [f.teams.home.name, "Stadion", countryName].filter(Boolean).join(" ")
    ].filter(q => q.trim());
    let coords = null;
    for (const q of queries) {
      coords = await geocodeAddress(q);
      if (coords) break;
    }
    if (!coords) return null;
    const cc = coords.countryCode || country.cc;
    const { date, time } = localDateTime(f.fixture.timestamp, zoneFor(cc, coords.lat, coords.lng));
    const comp = competitionOf(f);
    return {
      id: `m_${Date.now()}_${f.fixture.id}`,
      apiFixtureId: f.fixture.id,
      home: f.teams.home.name, away: f.teams.away.name,
      homeLogo: safeHttpUrl(f.teams.home.logo), awayLogo: safeHttpUrl(f.teams.away.logo),
      clubWebsite: "", homeTeamId: "", stadiumVenueId: "", stadiumCapacity: null, stadiumSource: "manual",
      competitionType: comp.competitionType, cupStage: comp.cupStage || null, leagueLevel: comp.leagueLevel || null,
      countryCode: cc, leagueName: f.league.name || null,
      date, time,
      stadium: venue.name ? `${venue.name}${venue.city ? `, ${venue.city}` : ""}` : (venue.city || f.teams.home.name),
      resolvedAddress: coords.display, lat: coords.lat, lng: coords.lng,
      mustAttend: false, ticketStatus: null, customArrivalBuffer: null, customDepartureBuffer: null
    };
  }

  // ---------- Anstoßzeit-Wächter ----------
  const norm = v => String(v || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
  const STOP = new Set(["fc", "sc", "sv", "afc", "cf", "ac", "rc", "us", "as", "club", "royal", "fk", "sk", "vfl", "vfb", "tsv", "1", "de", "the", "real", "sporting", "united", "city"]);
  const words = v => norm(v).split(" ").filter(w => w.length > 2 && !STOP.has(w));
  function teamMatches(a, b) {
    const na = norm(a), nb = norm(b);
    if (na === nb || na.includes(nb) || nb.includes(na)) return true;
    const wa = words(a), wb = words(b);
    return wa.some(w => wb.includes(w));
  }

  let checking = false;

  async function linkUnlinkedMatches(matches) {
    const byDate = new Map();
    matches.filter(m => !m.apiFixtureId).forEach(m => {
      if (!byDate.has(m.date)) byDate.set(m.date, []);
      byDate.get(m.date).push(m);
    });
    for (const [date, ms] of byDate) {
      const list = await fixturesForDate(date);
      ms.forEach(m => {
        const f = list.find(x => teamMatches(x.teams.home.name, m.home) && teamMatches(x.teams.away.name, m.away));
        if (f) m.apiFixtureId = f.fixture.id;
      });
    }
  }

  // Prüft die Spiele der bestätigten Alternative auf geänderte Termine.
  window.checkKickoffs = async function (force = false) {
    const trip = getActiveTrip();
    if (!trip || !trip.confirmed || !apiKey() || checking) return;
    if (!force && trip.kickoffCheckedAt && Date.now() - new Date(trip.kickoffCheckedAt).getTime() < CHECK_INTERVAL_MS) return;
    const plan = currentPlans && currentPlans[currentPlanIndex];
    if (!plan) return;
    const matches = plan.selected.map(s => trip.matches.find(m => m.id === s.id)).filter(Boolean);
    if (!matches.length) return;
    checking = true;
    if (force) { pendingPlanMessage = { type: "info", text: "Prüfe Anstoßzeiten …" }; renderPlanSwitcher(plan); }
    try {
      await linkUnlinkedMatches(matches);
      const ids = matches.map(m => m.apiFixtureId).filter(Boolean);
      const fixtures = [];
      for (let i = 0; i < ids.length; i += 20) {
        const data = await apiGet(`/fixtures?ids=${ids.slice(i, i + 20).join("-")}`);
        fixtures.push(...((data && data.response) || []));
      }
      const alerts = trip.kickoffAlerts || {};
      matches.forEach(m => {
        const f = fixtures.find(x => x.fixture.id === m.apiFixtureId);
        if (!f) return;
        const status = (f.fixture.status || {}).short;
        const { date, time } = localDateTime(f.fixture.timestamp, matchTz(m));
        let type = null;
        if (["CANC", "ABD", "AWD", "WO"].includes(status)) type = "cancelled";
        else if (status === "PST") type = "postponed";
        else if (date !== m.date || time !== m.time) type = status === "TBD" ? "tbd" : "moved";
        const prev = alerts[m.id];
        if (!type) { delete alerts[m.id]; return; }
        const sig = `${type}|${date}|${time}`;
        alerts[m.id] = { type, newDate: date, newTime: time, oldDate: m.date, oldTime: m.time, dismissed: !!(prev && prev.sig === sig && prev.dismissed), sig };
      });
      trip.kickoffAlerts = alerts;
      trip.kickoffCheckedAt = new Date().toISOString();
      saveLocalStorage();
      const open = Object.values(alerts).filter(a => !a.dismissed).length;
      const unlinked = matches.filter(m => !m.apiFixtureId).length;
      if (force) {
        pendingPlanMessage = open
          ? { type: "warning", text: `${open} Terminänderung(en) gefunden – siehe Hinweise.` }
          : { type: "success", text: `Alle Anstoßzeiten aktuell.${unlinked ? ` (${unlinked} Spiel(e) konnten nicht bei API-Football gefunden werden.)` : ""}` };
      }
    } catch (err) {
      console.error("Anstoßzeit-Prüfung:", err);
      if (force) pendingPlanMessage = { type: "danger", text: err instanceof FootballError ? err.message : "Prüfung fehlgeschlagen." };
    } finally {
      checking = false;
    }
    renderCurrentPlan();
  };

  // Hinweise oberhalb des Plans
  window.kickoffAlertsHtml = function (trip) {
    if (!trip || !trip.kickoffAlerts) return "";
    return Object.entries(trip.kickoffAlerts).filter(([, a]) => !a.dismissed).map(([id, a]) => {
      const m = trip.matches.find(x => x.id === id);
      if (!m) return "";
      const label = `${escapeHtml(m.home)} – ${escapeHtml(m.away)}`;
      const was = `${formatDateShort(a.oldDate)} ${a.oldTime}`;
      const text = a.type === "cancelled" ? `<strong>Abgesagt/abgebrochen:</strong> ${label} (${was})`
        : a.type === "postponed" ? `<strong>Verschoben, neuer Termin offen:</strong> ${label} (bisher ${was})`
        : a.type === "tbd" ? `<strong>Anstoß noch nicht final:</strong> ${label} – vorläufig ${formatDateShort(a.newDate)} ${a.newTime} (bisher ${was})`
        : `<strong>Anstoß verlegt:</strong> ${label} – neu <strong>${formatDateShort(a.newDate)} ${a.newTime} Uhr</strong> (bisher ${was})`;
      const canApply = a.type === "moved" || a.type === "tbd";
      return bannerHtml(a.type === "cancelled" ? "danger" : "warning", `${text}
        <div class="alert-actions">
          ${canApply ? `<button class="btn btn-soft btn-sm" onclick="applyKickoffChange('${id}')">Übernehmen</button>` : ""}
          <button class="btn btn-ghost btn-sm" onclick="dismissKickoffAlert('${id}')">Ausblenden</button>
        </div>`, "clock");
    }).join("");
  };

  window.kickoffStatusHtml = function (trip) {
    if (!trip || !trip.confirmed) return "";
    if (!apiKey()) return ` · <span class="muted" title="Für den Anstoßzeit-Wächter einen API-Football-Schlüssel in den Einstellungen eintragen">Anstoß-Wächter aus</span>`;
    const when = trip.kickoffCheckedAt ? new Date(trip.kickoffCheckedAt).toLocaleString("de-DE", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }) : "noch nie";
    return ` · <button class="link-inline" onclick="checkKickoffs(true)" title="Anstoßzeiten jetzt bei API-Football prüfen">${icon("clock")} Anstoß geprüft: ${when}</button>`;
  };

  window.dismissKickoffAlert = function (id) {
    const trip = getActiveTrip();
    if (trip && trip.kickoffAlerts && trip.kickoffAlerts[id]) { trip.kickoffAlerts[id].dismissed = true; saveLocalStorage(); renderCurrentPlan(); }
  };

  // Neue Anstoßzeit übernehmen. Gleicher Tag: Plan bleibt (Warnungen zeigen, ob es noch passt).
  // Anderer Tag: Plan passt strukturell nicht mehr -> Bestätigung wird aufgehoben, bitte neu berechnen.
  window.applyKickoffChange = function (id) {
    const trip = getActiveTrip();
    const a = trip && trip.kickoffAlerts && trip.kickoffAlerts[id];
    const m = trip && trip.matches.find(x => x.id === id);
    if (!a || !m) return;
    const dateChanged = a.newDate !== m.date;
    m.date = a.newDate;
    m.time = a.newTime;
    delete trip.kickoffAlerts[id];
    if (dateChanged) {
      delete trip.confirmed;
      delete trip.plans;
      currentPlans = null;
      saveLocalStorage();
      renderActiveTrip();
      alert("Das Spiel findet an einem anderen Tag statt. Die Bestätigung wurde aufgehoben – bitte die Route neu berechnen und den Trip erneut bestätigen.");
      return;
    }
    saveLocalStorage();
    pendingPlanMessage = { type: "success", text: `Neue Anstoßzeit für ${m.home} – ${m.away} übernommen. Bitte die Hinweise im Ablaufplan prüfen.` };
    renderCurrentPlan();
  };

  // Automatisch prüfen: beim Start und danach regelmäßig (die 6-Stunden-Grenze gilt trotzdem)
  document.addEventListener("DOMContentLoaded", () => setTimeout(() => window.checkKickoffs(false), 3000));
  setInterval(() => window.checkKickoffs(false), 30 * 60 * 1000);
})();
