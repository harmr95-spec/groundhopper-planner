// Standardwerte für die Einstellungen eines neuen Trips
const DEFAULT_SETTINGS = {
  arrivalBufferMin: 30,
  departureBufferMin: 30,
  halfTimeMin: 15,
  stoppageTimeMin: 10,
  maxNightDriveTime: "22:00",
  nextDayStartHour: "08:00",
  maxExtraNightDriveMin: 120,
  groundhopperWeights: { highlight: 40, stage: 30, competition: 20, stadium: 10 }
};

let state = {
  activeTripId: null,
  trips: []   // jeder Trip hat seine eigenen Einstellungen (trip.settings)
};

// Vollständige Einstellungen aus (evtl. unvollständigen) Werten bilden
function completeSettings(raw) {
  const base = JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
  const out = { ...base, ...(raw || {}) };
  out.groundhopperWeights = { ...base.groundhopperWeights, ...((raw && raw.groundhopperWeights) || {}) };
  return out;
}

// Einstellungen des aktiven Trips (lesen und schreiben)
function cfg() {
  const trip = getActiveTrip();
  if (!trip) return DEFAULT_SETTINGS;
  if (!trip.settings) trip.settings = completeSettings();
  return trip.settings;
}

let map, markersLayer, routeLayer;
let travelCache = new Map();
const routeCache = new Map();        // Routen inkl. Geometrie/Steps, nur echte OSRM-Ergebnisse
const reverseGeoCache = new Map();   // Ortsnamen für Übernachtungspunkte
let renderRunId = 0;                 // verwirft veraltete Renderings (Planwechsel während des Ladens)
let calcRunId = 0;                   // verwirft Ergebnisse veralteter Berechnungen
let editingMatchId = null;
let currentOptimizationMode = "most_games";
let lastAutoFilledStadium = "";
let currentHomeTeamData = null;
let currentVenueData = null;
let lastSelectedMatchIds = null; // Speichert die IDs der aktuell berechneten Spiele

// ---------- Trip-Alternativen ----------
let currentPlans = null;     // Array der aktuell berechneten Plan-Alternativen für den Trip
let currentPlanIndex = 0;    // Index des gerade angezeigten Plans in currentPlans

const MAX_DAY_ALTERNATIVES = 3; // Wie viele Ketten-Varianten pro Tag als Zweige verfolgt werden
const BEAM_WIDTH = 6;           // Wie viele Trip-Kandidaten zwischen den Tagen mitgeführt werden
const MAX_PLANS = 4;            // Wie viele Alternativen dem Nutzer am Ende angezeigt werden
const MIN_PLAN_SHARE = 0.5;     // Alternativen mit weniger als 50 % der Spiele der besten Alternative werden ausgeblendet

const LEAGUE_NAMES = {
  de: { 1: "Bundesliga", 2: "2. Bundesliga", 3: "3. Liga", 4: "Regionalliga", 5: "Oberliga", 6: "Landesliga o. niedriger" },
  nl: { 1: "Eredivisie", 2: "Eerste Divisie", 3: "Tweede Divisie", 4: "Derde Divisie", 5: "Vierde Divisie", 6: "Vijfde Divisie o. niedriger" },
  gb: { 1: "Premier League", 2: "Championship", 3: "League One", 4: "League Two", 5: "National League", 6: "National League N/S o. niedriger" },
  be: { 1: "Jupiler Pro League", 2: "Challenger Pro League", 3: "National Division 1", 4: "Division 2 Amateur", 5: "Division 3 Amateur" },
  fr: { 1: "Ligue 1", 2: "Ligue 2", 3: "National", 4: "National 2", 5: "National 3" },
  es: { 1: "La Liga", 2: "La Liga 2", 3: "Primera Federación", 4: "Segunda Federación", 5: "Tercera Federación" },
  it: { 1: "Serie A", 2: "Serie B", 3: "Serie C", 4: "Serie D", 5: "Eccellenza" },
  at: { 1: "Bundesliga (AT)", 2: "2. Liga", 3: "Regionalliga", 4: "Landesliga" },
  ch: { 1: "Super League", 2: "Challenge League", 3: "Promotion League", 4: "1. Liga" },
  pt: { 1: "Primeira Liga", 2: "Liga Portugal 2", 3: "Campeonato de Portugal", 4: "Divisão de Honra" },
  pl: { 1: "Ekstraklasa", 2: "I liga", 3: "II liga", 4: "III liga" },
  dk: { 1: "Superliga", 2: "1. Division", 3: "2. Division" }
};

function getLeagueName(countryCode, level) {
  const cc = (countryCode || "").toLowerCase();
  if (LEAGUE_NAMES[cc] && LEAGUE_NAMES[cc][level]) {
    return LEAGUE_NAMES[cc][level];
  }
  return `Liga-Level ${level}`;
}

// ---------- Initialization ----------
document.addEventListener("DOMContentLoaded", () => {
  initMap();
  loadLocalStorage();
  if (state.trips.length === 0) {
    createNewTrip("Mein erster Groundhopping Trip");
  } else {
    renderTripSelect();
    renderActiveTrip();
  }

  // Event Listener für automatische Wappen-Suche bei Blur
  document.getElementById("homeTeam").addEventListener("blur", () => autoFetchCrest('home'));
  document.getElementById("awayTeam").addEventListener("blur", () => autoFetchCrest('away'));
  document.getElementById("competitionType").addEventListener("change", updateCompetitionFields);
  updateCompetitionFields();

  // Eine manuelle Stadionänderung entkoppelt das Stadion vom Heimverein.
  document.getElementById("stadiumAddress").addEventListener("input", (event) => {
    const value = event.target.value.trim();
    if (value !== lastAutoFilledStadium) {
      lastAutoFilledStadium = "";
      currentVenueData = null;
      renderVenueInfo(null, value ? "Stadioninformationen werden nach Verlassen des Feldes gesucht …" : "");
    }
  });
  document.getElementById("stadiumAddress").addEventListener("blur", searchManualVenueIfNeeded);

  // Manuelle URL-Änderung in der Vorschau spiegeln
  document.getElementById("homeLogo").addEventListener("input", () => updateCrestPreview('home'));
  document.getElementById("awayLogo").addEventListener("input", () => updateCrestPreview('away'));
});

function initMap() {
  map = L.map('map').setView([51.1657, 10.4515], 6);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '© OpenStreetMap contributors'
  }).addTo(map);

  markersLayer = L.layerGroup().addTo(map);
  routeLayer = L.layerGroup().addTo(map);
}

// ---------- LocalStorage ----------
function loadLocalStorage() {
  const raw = localStorage.getItem("groundhopping_data");
  if (!raw) return;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || !Array.isArray(parsed.trips) || parsed.trips.some(t => !t || !Array.isArray(t.matches))) {
      throw new Error("Unerwartetes Datenformat");
    }
    // Früher globale Einstellungen: jeder Trip ohne eigene Einstellungen übernimmt sie einmalig.
    const legacy = parsed.settings;
    delete parsed.settings;
    state = { ...state, ...parsed };
    state.trips.forEach(trip => { trip.settings = completeSettings(trip.settings || legacy); });
    if (legacy) saveLocalStorage(); // Umstellung sofort im neuen Format speichern
    // Gespeicherte Pläne referenzieren Spiele nur per ID: wieder mit den Spielobjekten des Trips verknüpfen.
    state.trips.forEach(trip => {
      if (!Array.isArray(trip.plans)) return;
      const byId = new Map(trip.matches.map(m => [String(m.id), m]));
      const eligible = planningMatches(trip);
      const mustTotal = eligible.filter(m => m.mustAttend).length;
      trip.plans = trip.plans.map(p => rebindImportedPlan(p, byId, eligible.length, mustTotal)).filter(Boolean);
      if (!trip.plans.length) delete trip.plans;
    });
  } catch (err) {
    console.error("Gespeicherte Daten unlesbar:", err);
    try { localStorage.setItem("groundhopping_data_backup_" + Date.now(), raw); } catch (e) { /* Speicher voll */ }
    alert("Die gespeicherten Daten waren beschädigt. Eine Sicherung liegt im Browser-Speicher (groundhopping_data_backup_…). Die App startet mit leeren Daten.");
  }
}

// Pläne werden kompakt gespeichert: Spiele nur als ID, abgeleitete Felder (selected/dropped) entfallen.
// Beim Laden/Import baut rebindImportedPlan die Objektverweise und Kennzahlen wieder auf.
function serializePlan(plan) {
  return {
    dayChains: plan.dayChains.map(dc => ({
      date: dc.date,
      chain: dc.chain.map(m => m.id),
      dropped: dc.dropped.map(d => ({ match: d.match.id, reason: d.reason })),
      overnightAfter: dc.overnightAfter
    })),
    totalTravelMin: plan.totalTravelMin,
    tightNights: plan.tightNights,
    infeasibleNights: plan.infeasibleNights,
    scoreSum: plan.scoreSum,
    optimizationMode: plan.optimizationMode,
    signature: plan.signature,
    description: plan.description,
    changedDates: Array.from(plan.changedDates || []),
    repairNotes: plan.repairNotes || []
  };
}

function serializeTrip(trip) {
  return Array.isArray(trip.plans) ? { ...trip, plans: trip.plans.map(serializePlan) } : trip;
}

function saveLocalStorage() {
  const data = { ...state, trips: state.trips.map(serializeTrip) };
  try {
    localStorage.setItem("groundhopping_data", JSON.stringify(data));
  } catch (err) {
    console.error("Speichern fehlgeschlagen:", err);
    alert("Die Daten konnten nicht im Browser gespeichert werden (Speicher voll?). Bitte den Trip zur Sicherheit exportieren.");
  }
}

function getActiveTrip() {
  return state.trips.find(t => t.id === state.activeTripId);
}

// ---------- Trip-Verwaltung ----------
function createNewTrip(defaultName = null) {
  const name = defaultName || prompt("Name des neuen Trips:", "Neuer Trip");
  if (!name) return;

  const active = getActiveTrip();
  const newTrip = {
    id: "trip_" + Date.now(),
    name: name,
    startAddress: null,
    matches: [],
    overnightOverrides: {},
    // Neuer Trip startet mit den Einstellungen des gerade aktiven Trips
    settings: completeSettings(active && active.settings),
    plans: null
  };

  state.trips.push(newTrip);
  state.activeTripId = newTrip.id;
  resetMatchForm();
  saveLocalStorage();
  renderTripSelect();
  renderActiveTrip();
}

function renameActiveTrip() {
  const trip = getActiveTrip();
  if (!trip) return;
  const newName = prompt("Neuer Name für diesen Trip:", trip.name);
  if (!newName) return;
  trip.name = newName;
  saveLocalStorage();
  renderTripSelect();
}

function deleteActiveTrip() {
  const trip = getActiveTrip();
  if (!trip) return;
  if (!confirm(`Trip "${trip.name}" wirklich löschen? Das kann nicht rückgängig gemacht werden.`)) return;

  state.trips = state.trips.filter(t => t.id !== trip.id);
  resetMatchForm();

  if (state.trips.length === 0) {
    createNewTrip("Mein erster Groundhopping Trip");
  } else {
    state.activeTripId = state.trips[0].id;
    saveLocalStorage();
    renderTripSelect();
    renderActiveTrip();
  }
}

function switchTrip() {
  state.activeTripId = document.getElementById("tripSelect").value;
  saveLocalStorage();
  resetMatchForm();
  renderActiveTrip();
}

function renderTripSelect() {
  const select = document.getElementById("tripSelect");
  select.innerHTML = state.trips.map(t =>
    `<option value="${t.id}" ${t.id === state.activeTripId ? 'selected' : ''}>${escapeHtml(t.name)}</option>`
  ).join('');
}

// ---------- Geocoding (Nominatim) ----------
async function geocodeAddress(address) {
  if (!address || !address.trim()) return null;
  const url = `https://nominatim.openstreetmap.org/search?format=json&addressdetails=1&q=${encodeURIComponent(address)}`;
  try {
    const response = await fetchWithTimeout(url);
    const data = await response.json();
    if (data && data.length > 0) {
      const r = data[0];
      const addr = r.address || {};

      const street = addr.road || addr.pedestrian || addr.street || "";
      const houseNumber = addr.house_number ? ` ${addr.house_number}` : "";
      const streetStr = street ? `${street}${houseNumber}` : "";

      const postcode = addr.postcode || "";
      const city = addr.city || addr.town || addr.village || addr.municipality || addr.county || "";
      const cityStr = [postcode, city].filter(Boolean).join(" ");

      const country = addr.country || "";

      const formattedAddress = [streetStr, cityStr, country].filter(Boolean).join(", ");

      return {
        lat: parseFloat(r.lat),
        lng: parseFloat(r.lon),
        display: formattedAddress || r.display_name,
        countryCode: addr.country_code || null
      };
    }
  } catch (err) {
    console.error("Geocoding Error:", err);
  }
  return null;
}

async function reverseGeocode(lat, lng, zoom = 10) {
  const url = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${lat}&lon=${lng}&zoom=${zoom}`;
  try {
    const res = await fetchWithTimeout(url);
    const data = await res.json();
    const addr = data.address || {};
    return addr.city || addr.town || addr.village || addr.municipality || addr.county || data.display_name || null;
  } catch (err) {
    console.error("Reverse-Geocoding Error:", err);
    return null;
  }
}

// ---------- Iterative Wappen-Suche ----------
function generateSearchCandidates(inputName) {
  const trimmed = inputName.trim();
  if (!trimmed) return [];

  const candidates = [trimmed];
  const words = trimmed
    .split(/\s+/)
    .map(w => w.replace(/^[^\w\u00C0-\u024F]+|[^\w\u00C0-\u024F]+$/g, ''))
    .filter(w => w.length > 1);

  for (const word of words) {
    if (!candidates.includes(word)) {
      candidates.push(word);
    }
  }
  return candidates;
}

function normalizeWebsiteUrl(value) {
  if (!value) return "";
  const cleaned = String(value).trim();
  return /^https?:\/\//i.test(cleaned) ? cleaned : `https://${cleaned}`;
}

function parseCapacity(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = parseInt(String(value).replace(/[^0-9]/g, ""), 10);
  return Number.isFinite(number) && number > 0 ? number : null;
}

async function fetchSoccerTeam(teamName) {
  if (!teamName || !teamName.trim()) return null;
  const candidates = generateSearchCandidates(teamName);
  const wantedName = teamName.trim().toLowerCase();

  for (const candidate of candidates) {
    try {
      const url = `https://www.thesportsdb.com/api/v1/json/3/searchteams.php?t=${encodeURIComponent(candidate)}`;
      const res = await fetchWithTimeout(url);
      const data = await res.json();
      if (!data || !Array.isArray(data.teams)) continue;

      const soccerTeams = data.teams.filter(team =>
        String(team.strSport || "").trim().toLowerCase() === "soccer"
      );
      if (!soccerTeams.length) continue;

      const exactTeam = soccerTeams.find(team => {
        const names = [team.strTeam, ...(team.strTeamAlternate || "").split(",")]
          .map(name => String(name || "").trim().toLowerCase());
        return names.includes(wantedName);
      });
      return exactTeam || soccerTeams[0];
    } catch (err) {
      console.error(`Fußballteam-Suche Fehler für "${candidate}":`, err);
    }
  }
  return null;
}

async function lookupVenueById(idVenue) {
  if (!idVenue) return null;
  try {
    const url = `https://www.thesportsdb.com/api/v1/json/3/lookupvenue.php?id=${encodeURIComponent(idVenue)}`;
    const res = await fetchWithTimeout(url);
    const data = await res.json();
    const venue = data && Array.isArray(data.venues) ? data.venues[0] : null;
    return venue ? {
      id: venue.idVenue || String(idVenue),
      name: venue.strVenue || venue.strStadium || "",
      capacity: parseCapacity(venue.intCapacity),
      source: "team"
    } : null;
  } catch (err) {
    console.error("Venue-Lookup Fehler:", err);
    return null;
  }
}

async function searchVenueByName(venueName) {
  if (!venueName || !venueName.trim()) return null;
  try {
    const url = `https://www.thesportsdb.com/api/v1/json/123/searchvenues.php?v=${encodeURIComponent(venueName.trim())}`;
    const res = await fetchWithTimeout(url);
    const data = await res.json();
    if (!data || !Array.isArray(data.venues) || !data.venues.length) return null;
    const normalizeVenueName = value => String(value || "")
      .trim()
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-z0-9]+/g, " ")
      .trim();

    const wanted = normalizeVenueName(venueName);

    // Anders als bei der Teamsuche nicht nach strSport filtern.
    // Venue-Datensätze sind dort nicht immer einheitlich als "Soccer" klassifiziert.
    const exact = data.venues.find(venue => {
      const names = [venue.strVenue, venue.strVenueAlternate, venue.strStadium]
        .filter(Boolean)
        .map(normalizeVenueName);
      return names.includes(wanted);
    });

    const partial = data.venues.find(venue => {
      const names = [venue.strVenue, venue.strVenueAlternate, venue.strStadium]
        .filter(Boolean)
        .map(normalizeVenueName);
      return names.some(name => name.includes(wanted) || wanted.includes(name));
    });

    const venue = exact || partial || data.venues[0];
    if (!venue) return null;
    return {
      id: venue.idVenue || "",
      name: venue.strVenue || venue.strStadium || venueName.trim(),
      capacity: parseCapacity(venue.intCapacity),
      source: "manual"
    };
  } catch (err) {
    console.error("Stadion-Suche Fehler:", err);
    return null;
  }
}

function renderVenueInfo(venue, message = "") {
  const box = document.getElementById("venueInfo");
  if (!box) return;
  if (venue && venue.capacity) {
    box.innerHTML = `<span>🏟️ Kapazität: <strong>${venue.capacity.toLocaleString("de-DE")}</strong></span>`;
    box.style.display = "block";
  } else if (message) {
    box.textContent = message;
    box.style.display = "block";
  } else {
    box.textContent = "";
    box.style.display = "none";
  }
}

async function searchManualVenueIfNeeded() {
  const input = document.getElementById("stadiumAddress");
  const value = input.value.trim();
  if (!value || value === lastAutoFilledStadium) return;
  renderVenueInfo(null, "Stadioninformationen werden gesucht …");
  currentVenueData = await searchVenueByName(value);
  renderVenueInfo(currentVenueData);
}

async function fetchCrestForTeam(teamName) {
  const team = await fetchSoccerTeam(teamName);
  const rawBadge = team && (team.strTeamBadge || team.strBadge);
  return rawBadge ? rawBadge.replace(/\\/g, "") : null;
}

async function autoFetchCrest(type) {
  const teamInput = document.getElementById(`${type}Team`);
  const logoInput = document.getElementById(`${type}Logo`);
  const manualGroup = document.getElementById(`${type}LogoGroup`);
  const teamName = teamInput.value.trim();

  if (!teamName) {
    hideCrestPreview(type);
    if (manualGroup) manualGroup.style.display = "none";
    if (type === "home") currentHomeTeamData = null;
    return;
  }

  const team = await fetchSoccerTeam(teamName);
  const rawBadge = team && (team.strTeamBadge || team.strBadge);
  const crestUrl = rawBadge ? rawBadge.replace(/\\/g, "") : null;

  if (crestUrl) {
    logoInput.value = crestUrl;
    showCrestPreview(type, crestUrl);
  } else {
    logoInput.value = "";
    hideCrestPreview(type);
    if (manualGroup) manualGroup.style.display = "block";
  }

  if (type !== "home") return;
  currentHomeTeamData = team ? {
    idTeam: team.idTeam || "",
    website: normalizeWebsiteUrl(team.strWebsite),
    idVenue: team.idVenue || "",
    stadium: team.strStadium || ""
  } : null;

  if (!team) return;
  const stadiumInput = document.getElementById("stadiumAddress");
  const currentValue = stadiumInput.value.trim();
  const mayOverwrite = currentValue === "" || currentValue === lastAutoFilledStadium;

  if (mayOverwrite && team.strStadium) {
    stadiumInput.value = team.strStadium.trim();
    lastAutoFilledStadium = stadiumInput.value.trim();
    currentVenueData = await lookupVenueById(team.idVenue);
    if (!currentVenueData) {
      currentVenueData = await searchVenueByName(lastAutoFilledStadium);
      if (currentVenueData) currentVenueData.source = "team";
    }
    renderVenueInfo(currentVenueData);
  }
}

function showCrestPreview(type, url) {
  const previewContainer = document.getElementById(`${type}CrestPreviewContainer`);
  const img = document.getElementById(`${type}CrestPreviewImg`);
  const manualGroup = document.getElementById(`${type}LogoGroup`);

  if (img && previewContainer) {
    img.src = url;
    previewContainer.style.display = "flex";
  }
  if (manualGroup) {
    manualGroup.style.display = "none";
  }
}

function hideCrestPreview(type) {
  const previewContainer = document.getElementById(`${type}CrestPreviewContainer`);
  if (previewContainer) {
    previewContainer.style.display = "none";
  }
}

function toggleManualLogoInput(type) {
  const manualGroup = document.getElementById(`${type}LogoGroup`);
  if (manualGroup) {
    manualGroup.style.display = "block";
  }
  const logoInput = document.getElementById(`${type}Logo`);
  if (logoInput) logoInput.focus();
}

function updateCrestPreview(type) {
  const url = document.getElementById(`${type}Logo`).value.trim();
  if (url) {
    showCrestPreview(type, url);
  } else {
    hideCrestPreview(type);
  }
}

async function setStartAddress() {
  const address = document.getElementById("startAddress").value;
  if (!address) return;

  const statusEl = document.getElementById("startAddressStatus");
  statusEl.innerText = "Adresse wird gesucht...";

  const coords = await geocodeAddress(address);
  if (coords) {
    const trip = getActiveTrip();
    trip.startAddress = { address, lat: coords.lat, lng: coords.lng, countryCode: coords.countryCode };
    saveLocalStorage();
    statusEl.innerText = "✓ Gespeichert!";
    renderActiveTrip();
  } else {
    statusEl.innerText = "❌ Adresse nicht gefunden.";
  }
}

function isCupCompetition(type) { return type === "national_cup" || type === "international_cup"; }
function updateCompetitionFields() {
  const type = document.getElementById("competitionType")?.value || "league";
  const leagueGroup = document.getElementById("leagueLevelGroup");
  const cupGroup = document.getElementById("cupStageGroup");
  if (leagueGroup) leagueGroup.style.display = type === "league" ? "flex" : "none";
  if (cupGroup) cupGroup.style.display = isCupCompetition(type) ? "flex" : "none";
  const leagueLevel = document.getElementById("leagueLevel");
  const cupStage = document.getElementById("cupStage");
  if (leagueLevel) leagueLevel.required = type === "league";
  if (cupStage) cupStage.required = isCupCompetition(type);
}
function competitionLabel(type) {
  const labels = {
    league: "Liga", national_cup: "Pokal national", international_cup: "Pokal international",
    friendly: "Freundschaftsspiel", other: "Sonstiges"
  };
  return labels[type || "league"] || "Liga";
}

function cupStageLabel(stage) {
  const labels = {
    final: "Finale", semifinal: "Halbfinale", knockout: "KO-Runde",
    group: "Gruppenphase", qualification: "Qualifikationsphase"
  };
  return labels[stage] || "";
}

const DEFAULT_WEIGHTS = { highlight: 40, stage: 30, competition: 20, stadium: 10 };

function normalizedWeights() {
  const raw = cfg().groundhopperWeights || DEFAULT_WEIGHTS;
  const values = {};
  for (const key of Object.keys(DEFAULT_WEIGHTS)) values[key] = Math.max(0, +raw[key] || 0);
  const sum = Object.values(values).reduce((a, b) => a + b, 0);
  const base = sum ? values : DEFAULT_WEIGHTS;
  const total = sum || 100;
  return Object.fromEntries(Object.entries(base).map(([key, value]) => [key, value / total]));
}

const LEAGUE_STAGE_SCORE = { 1: 100, 2: 83, 3: 67, 4: 50, 5: 33, 6: 17 };
const CUP_STAGE_SCORE = { final: 100, semifinal: 80, knockout: 60, group: 40, qualification: 20 };
const COMPETITION_SCORE = { international_cup: 100, national_cup: 75, league: 50, other: 25, friendly: 10 };

function stadiumScore(capacity) {
  if (capacity >= 60000) return 100;
  if (capacity >= 40000) return 80;
  if (capacity >= 20000) return 60;
  if (capacity >= 10000) return 40;
  if (capacity >= 5000) return 20;
  return capacity > 0 ? 10 : 0;
}

function matchScoreDetails(match) {
  const type = match.competitionType || "league";
  const weights = normalizedWeights();
  const highlight = match.mustAttend ? 100 : 0;
  const stage = type === "league"
    ? (LEAGUE_STAGE_SCORE[match.leagueLevel] || 0)
    : isCupCompetition(type) ? (CUP_STAGE_SCORE[match.cupStage] || 0) : 0;
  const competition = COMPETITION_SCORE[type] || 0;
  const stadium = stadiumScore(Number(match.stadiumCapacity) || 0);
  const score = Math.round(
    highlight * weights.highlight + stage * weights.stage +
    competition * weights.competition + stadium * weights.stadium
  );
  return { score, highlight, stage, competition, stadium };
}

function groundhopperScore(match) { return matchScoreDetails(match).score; }

function scoreHtml(match) {
  const d = matchScoreDetails(match);
  return `<span class="groundhopper-score" title="Highlight ${d.highlight}% · Liga-Level/Pokalphase ${d.stage}% · Wettbewerbsart ${d.competition}% · Stadion ${d.stadium}%">🏆 Groundhopper Score: <strong>${d.score}/100</strong></span>`;
}

function matchContextLabel(match) {
  const type = match.competitionType || "league";
  if (type === "league") return `${escapeHtml(match.leagueName || getLeagueName(match.countryCode, match.leagueLevel))} · Liga`;
  if (isCupCompetition(type)) return `${competitionLabel(type)}${match.cupStage ? ` · ${cupStageLabel(match.cupStage)}` : ""}`;
  return competitionLabel(type);
}

function optimizationModeLabel(mode = currentOptimizationMode) {
  return ({ most_games: "Meiste Spiele", groundhopper_score: "Groundhopper Score", balanced: "Ausgewogen" })[mode] || "Meiste Spiele";
}

// Einheitlicher Vergleich zweier Kandidaten nach der aktiven Berechnungsmethode.
// count = Anzahl Spiele, scoreSum = Summe der Groundhopper Scores, ref = Referenzanzahl für "Ausgewogen".
// Rückgabe < 0: a ist besser, > 0: b ist besser, 0: gleichwertig.
function compareByMode(a, b, ref) {
  const avgA = a.count ? a.scoreSum / a.count : 0;
  const avgB = b.count ? b.scoreSum / b.count : 0;
  if (currentOptimizationMode === "groundhopper_score") {
    if (avgA !== avgB) return avgB - avgA;
    return b.count - a.count;
  }
  if (currentOptimizationMode === "balanced") {
    const r = Math.max(1, ref || 1);
    const balA = 0.6 * (a.count / r) * 100 + 0.4 * avgA;
    const balB = 0.6 * (b.count / r) * 100 + 0.4 * avgB;
    if (balA !== balB) return balB - balA;
    return b.count - a.count;
  }
  if (a.count !== b.count) return b.count - a.count;
  return b.scoreSum - a.scoreSum;
}

function chainScoreSum(chain) { return chain.reduce((sum, m) => sum + groundhopperScore(m), 0); }

function compareOptimizationMetrics(a, b, referenceCount) {
  return compareByMode(
    { count: a.length, scoreSum: chainScoreSum(a) },
    { count: b.length, scoreSum: chainScoreSum(b) },
    referenceCount
  );
}

// ---------- Ticketstatus ----------
// ticketStatus: null (offen) | "purchased" (Tickets gekauft) | "no_tickets" (keine Tickets bekommen)
const TICKET_STATUSES = ["purchased", "no_tickets"];
const hasNoTickets = m => m.ticketStatus === "no_tickets";
const hasTickets = m => m.ticketStatus === "purchased";
// Spiele, die zwingend eingeplant werden sollen: gekaufte Tickets oder Highlightspiele.
const isForced = m => hasTickets(m) || !!m.mustAttend;
// Spiele, die überhaupt in die Berechnung eingehen.
function planningMatches(trip) { return trip.matches.filter(m => !hasNoTickets(m)); }

// ---------- Match Handling ----------
async function addMatch(e) {
  e.preventDefault();
  const trip = getActiveTrip();
  if (!trip) return;

  const stadiumAddr = document.getElementById("stadiumAddress").value;
  const competitionType = document.getElementById("competitionType").value || "league";
  const leagueLevel = competitionType === "league" ? parseInt(document.getElementById("leagueLevel").value) : null;
  const cupStage = isCupCompetition(competitionType) ? document.getElementById("cupStage").value : null;

  // Falls direkt auf Speichern geklickt wird, die manuelle Stadionsuche abwarten.
  if (stadiumAddr.trim() && stadiumAddr.trim() !== lastAutoFilledStadium && !currentVenueData) {
    currentVenueData = await searchVenueByName(stadiumAddr.trim());
    renderVenueInfo(currentVenueData);
  }

  const coords = await geocodeAddress(stadiumAddr);

  if (!coords) {
    alert("Stadion-Adresse konnte nicht gefunden werden.");
    return;
  }

  const homeTeam = document.getElementById("homeTeam").value.trim();
  const awayTeam = document.getElementById("awayTeam").value.trim();
  let homeLogo = document.getElementById("homeLogo").value.trim().replace(/\\/g, '');
  let awayLogo = document.getElementById("awayLogo").value.trim().replace(/\\/g, '');

  if (!homeLogo) {
    homeLogo = await fetchCrestForTeam(homeTeam) || "";
  }
  if (!awayLogo) {
    awayLogo = await fetchCrestForTeam(awayTeam) || "";
  }

  const matchData = {
    id: editingMatchId || ("m_" + Date.now()),
    home: homeTeam,
    away: awayTeam,
    homeLogo: homeLogo,
    awayLogo: awayLogo,
    clubWebsite: currentHomeTeamData?.website || "",
    homeTeamId: currentHomeTeamData?.idTeam || "",
    stadiumVenueId: currentVenueData?.id || "",
    stadiumCapacity: currentVenueData?.capacity || null,
    stadiumSource: lastAutoFilledStadium && stadiumAddr.trim() === lastAutoFilledStadium ? "auto-team" : "manual",
    competitionType,
    cupStage,
    leagueLevel: leagueLevel,
    countryCode: coords.countryCode,
    leagueName: competitionType === "league" ? getLeagueName(coords.countryCode, leagueLevel) : null,
    date: document.getElementById("matchDate").value,
    time: document.getElementById("matchTime").value,
    stadium: stadiumAddr,
    resolvedAddress: coords.display,
    lat: coords.lat,
    lng: coords.lng,
    mustAttend: document.getElementById("mustAttend").checked,
    // Ticketstatus beim Bearbeiten erhalten
    ticketStatus: (editingMatchId && trip.matches.find(m => m.id === editingMatchId)?.ticketStatus) || null,
    customArrivalBuffer: document.getElementById("customArrivalBuffer").value ? parseInt(document.getElementById("customArrivalBuffer").value) : null,
    customDepartureBuffer: document.getElementById("customDepartureBuffer").value ? parseInt(document.getElementById("customDepartureBuffer").value) : null
  };

  if (editingMatchId) {
    const index = trip.matches.findIndex(m => m.id === editingMatchId);
    if (index !== -1) {
      trip.matches[index] = matchData;
    }
  } else {
    trip.matches.push(matchData);
  }

  // Bei Änderung des Spielplans alte Alternativen verwerfen
  delete trip.plans;
  currentPlans = null;

  saveLocalStorage();
  resetMatchForm();
  renderActiveTrip();
}

function editMatch(matchId) {
  const trip = getActiveTrip();
  if (!trip) return;

  const match = trip.matches.find(m => m.id === matchId);
  if (!match) return;

  editingMatchId = match.id;

  document.getElementById("homeTeam").value = match.home || "";
  document.getElementById("awayTeam").value = match.away || "";
  document.getElementById("homeLogo").value = match.homeLogo || "";
  document.getElementById("awayLogo").value = match.awayLogo || "";
  document.getElementById("competitionType").value = match.competitionType || "league";
  document.getElementById("leagueLevel").value = match.leagueLevel || 1;
  document.getElementById("cupStage").value = match.cupStage || "knockout";
  updateCompetitionFields();
  document.getElementById("matchDate").value = match.date || "";
  document.getElementById("matchTime").value = match.time || "";
  document.getElementById("stadiumAddress").value = match.stadium || "";
  lastAutoFilledStadium = "";
  currentHomeTeamData = {
    idTeam: match.homeTeamId || "",
    website: match.clubWebsite || "",
    idVenue: match.stadiumVenueId || "",
    stadium: match.stadium || ""
  };
  currentVenueData = match.stadiumVenueId || match.stadiumCapacity ? {
    id: match.stadiumVenueId || "",
    name: match.stadium || "",
    capacity: match.stadiumCapacity || null,
    source: match.stadiumSource || "manual"
  } : null;
  renderVenueInfo(currentVenueData);
  document.getElementById("customArrivalBuffer").value = match.customArrivalBuffer ?? "";
  document.getElementById("customDepartureBuffer").value = match.customDepartureBuffer ?? "";
  document.getElementById("mustAttend").checked = !!match.mustAttend;

  if (match.homeLogo) {
    showCrestPreview('home', match.homeLogo);
  } else {
    autoFetchCrest('home');
  }

  if (match.awayLogo) {
    showCrestPreview('away', match.awayLogo);
  } else {
    autoFetchCrest('away');
  }

  const submitBtn = document.querySelector("#matchForm button[type='submit']");
  if (submitBtn) submitBtn.textContent = "Spiel speichern";

  const formEl = document.getElementById("matchForm");
  if (formEl) formEl.scrollIntoView({ behavior: 'smooth' });
}

function resetMatchForm() {
  editingMatchId = null;
  document.getElementById("matchForm").reset();
  document.getElementById("competitionType").value = "league";
  updateCompetitionFields();
  lastAutoFilledStadium = "";
  currentHomeTeamData = null;
  currentVenueData = null;
  renderVenueInfo(null);
  
  hideCrestPreview('home');
  hideCrestPreview('away');

  const homeGroup = document.getElementById("homeLogoGroup");
  const awayGroup = document.getElementById("awayLogoGroup");
  if (homeGroup) homeGroup.style.display = "none";
  if (awayGroup) awayGroup.style.display = "none";

  const submitBtn = document.querySelector("#matchForm button[type='submit']");
  if (submitBtn) submitBtn.textContent = "Spiel hinzufügen";
}

function deleteMatch(matchId) {
  if (editingMatchId === matchId) {
    resetMatchForm();
  }
  const trip = getActiveTrip();
  trip.matches = trip.matches.filter(m => m.id !== matchId);
  delete trip.overnightOverrides[matchId];
  Object.keys(trip.overnightOverrides).forEach(k => {
    if (k.startsWith(`${matchId}@`)) delete trip.overnightOverrides[k];
  });
  
  delete trip.plans;
  currentPlans = null;

  saveLocalStorage();
  renderActiveTrip();
}

// ---------- Crest Marker ----------
function createCrestIcon(home, away, homeLogo, awayLogo) {
  const cleanHomeLogo = safeHttpUrl(homeLogo);
  const cleanAwayLogo = safeHttpUrl(awayLogo);

  const homeContent = cleanHomeLogo
    ? `<img src="${escapeHtml(cleanHomeLogo)}" alt="${escapeHtml(home)}"/>`
    : `<span class="badge">${escapeHtml(home.substring(0, 3).toUpperCase())}</span>`;

  const awayContent = cleanAwayLogo
    ? `<img src="${escapeHtml(cleanAwayLogo)}" alt="${escapeHtml(away)}"/>`
    : `<span class="badge">${escapeHtml(away.substring(0, 3).toUpperCase())}</span>`;

  return L.divIcon({
    className: 'custom-crest-marker-wrapper',
    html: `<div class="match-crest-marker">${homeContent} <span class="colon">:</span> ${awayContent}</div>`,
    iconSize: [80, 30],
    iconAnchor: [40, 15]
  });
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, ch =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
}

function safeHttpUrl(value) {
  const cleaned = String(value ?? "").trim().replace(/\\/g, "");
  try {
    const url = new URL(cleaned);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : "";
  } catch (err) { return ""; }
}

// ---------- Import-Validierung ----------
const SAFE_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const COMPETITION_TYPES = ["league", "national_cup", "international_cup", "friendly", "other"];
const CUP_STAGES = ["final", "semifinal", "knockout", "group", "qualification"];
const OPT_MODES = ["most_games", "groundhopper_score", "balanced"];

function toNum(v, fallback = null) { const n = typeof v === "number" ? v : parseFloat(v); return Number.isFinite(n) ? n : fallback; }
function toText(v, max = 300) { return String(v ?? "").slice(0, max); }
function isValidDate(v) { return DATE_RE.test(String(v)) && !Number.isNaN(new Date(`${v}T00:00:00`).getTime()); }

function sanitizeSettings(raw) {
  if (!raw || typeof raw !== "object") return {};
  const out = {};
  ["arrivalBufferMin", "departureBufferMin", "halfTimeMin", "stoppageTimeMin", "maxExtraNightDriveMin"].forEach(key => {
    const v = toNum(raw[key]);
    if (v !== null && v >= 0 && v <= 600) out[key] = Math.round(v);
  });
  ["maxNightDriveTime", "nextDayStartHour"].forEach(key => {
    if (TIME_RE.test(String(raw[key]))) out[key] = raw[key];
  });
  const w = raw.groundhopperWeights;
  if (w && typeof w === "object") {
    out.groundhopperWeights = {
      highlight: Math.max(0, toNum(w.highlight, 0)), stage: Math.max(0, toNum(w.stage, 0)),
      competition: Math.max(0, toNum(w.competition, 0)), stadium: Math.max(0, toNum(w.stadium, 0))
    };
  }
  return out;
}

function sanitizeImportedMatch(raw, usedIds, index) {
  if (!raw || typeof raw !== "object") return null;
  const lat = toNum(raw.lat), lng = toNum(raw.lng);
  const home = toText(raw.home, 100).trim(), away = toText(raw.away, 100).trim();
  if (lat === null || lng === null || Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  if (!home || !away || !isValidDate(raw.date) || !TIME_RE.test(String(raw.time))) return null;
  // IDs landen in onclick-Handlern: nur sichere Zeichen zulassen (Escaping reicht dort nicht).
  let id = String(raw.id ?? "");
  if (!SAFE_ID_RE.test(id) || usedIds.has(id)) id = `m_${Date.now()}_${index}`;
  usedIds.add(id);
  const type = COMPETITION_TYPES.includes(raw.competitionType) ? raw.competitionType : "league";
  const level = toNum(raw.leagueLevel), capacity = toNum(raw.stadiumCapacity);
  const buffer = v => { const n = toNum(v); return n !== null && n >= 0 && n <= 600 ? Math.round(n) : null; };
  return {
    id, home, away,
    homeLogo: safeHttpUrl(raw.homeLogo), awayLogo: safeHttpUrl(raw.awayLogo),
    clubWebsite: safeHttpUrl(raw.clubWebsite),
    homeTeamId: toText(raw.homeTeamId, 40), stadiumVenueId: toText(raw.stadiumVenueId, 40),
    stadiumCapacity: capacity !== null && capacity > 0 ? Math.round(capacity) : null,
    stadiumSource: ["auto-team", "manual", "team"].includes(raw.stadiumSource) ? raw.stadiumSource : "manual",
    competitionType: type,
    cupStage: isCupCompetition(type) && CUP_STAGES.includes(raw.cupStage) ? raw.cupStage : null,
    leagueLevel: type === "league" && level >= 1 && level <= 6 ? Math.round(level) : null,
    countryCode: /^[a-z]{2}$/i.test(String(raw.countryCode)) ? String(raw.countryCode).toLowerCase() : null,
    leagueName: raw.leagueName ? toText(raw.leagueName, 80) : null,
    date: raw.date, time: raw.time,
    stadium: toText(raw.stadium, 200), resolvedAddress: toText(raw.resolvedAddress, 300),
    lat, lng, mustAttend: !!raw.mustAttend,
    ticketStatus: TICKET_STATUSES.includes(raw.ticketStatus) ? raw.ticketStatus : null,
    customArrivalBuffer: buffer(raw.customArrivalBuffer), customDepartureBuffer: buffer(raw.customDepartureBuffer)
  };
}

// Baut einen importierten Plan ausschließlich aus bereits bereinigten Spielen neu auf.
function rebindImportedPlan(raw, byOldId, availableCount, mustTotal) {
  if (!raw || !Array.isArray(raw.dayChains)) return null;
  const find = ref => byOldId.get(String(ref && typeof ref === "object" ? ref.id : ref)) || null;
  const dayChains = [];
  for (const dc of raw.dayChains) {
    if (!dc || !isValidDate(dc.date) || !Array.isArray(dc.chain)) return null;
    const chain = dc.chain.map(find);
    const dropped = (Array.isArray(dc.dropped) ? dc.dropped : []).map(d => ({ match: find(d && d.match), reason: toText(d && d.reason) }));
    if (chain.includes(null) || dropped.some(d => !d.match)) return null;
    const o = dc.overnightAfter, oLat = o && toNum(o.lat), oLng = o && toNum(o.lng), from = o && find(o.fromMatchId);
    dayChains.push({
      date: dc.date, chain, dropped,
      overnightAfter: o && oLat !== null && oLng !== null
        ? { fromMatchId: from ? from.id : "", override: !!o.override, lat: oLat, lng: oLng, name: toText(o.name) } : null
    });
  }
  const selected = dayChains.flatMap(dc => dc.chain), dropped = dayChains.flatMap(dc => dc.dropped);
  const scoreSum = toNum(raw.scoreSum, chainScoreSum(selected));
  return {
    dayChains, selected, dropped,
    totalTravelMin: toNum(raw.totalTravelMin, 0), tightNights: toNum(raw.tightNights, 0), infeasibleNights: toNum(raw.infeasibleNights, 0),
    matchCount: selected.length, mustAttendCount: selected.filter(m => m.mustAttend).length, mustAttendTotal: mustTotal,
    purchasedCount: selected.filter(hasTickets).length,
    scoreSum, averageGroundhopperScore: selected.length ? scoreSum / selected.length : 0,
    availableMatchCount: availableCount,
    optimizationMode: OPT_MODES.includes(raw.optimizationMode) ? raw.optimizationMode : "most_games",
    signature: toText(raw.signature, 2000), description: toText(raw.description, 500),
    changedDates: Array.isArray(raw.changedDates) ? raw.changedDates.filter(d => isValidDate(d)) : [],
    repairNotes: Array.isArray(raw.repairNotes) ? raw.repairNotes.slice(0, 20).map(n => toText(n, 300)) : []
  };
}

function normalizeImportedTrip(rawTrip, fallbackPlans, fallbackSettings) {
  if (!rawTrip || typeof rawTrip !== "object" || !Array.isArray(rawTrip.matches)) return null;
  const name = toText(rawTrip.name, 120).trim();
  if (!name) return null;

  const usedIds = new Set(), byOldId = new Map(), matches = [];
  rawTrip.matches.forEach((raw, i) => {
    const clean = sanitizeImportedMatch(raw, usedIds, i);
    if (clean) { matches.push(clean); byOldId.set(String(raw.id), clean); }
  });
  if (rawTrip.matches.length > 0 && matches.length === 0) return null;

  const sa = rawTrip.startAddress, saLat = sa && toNum(sa.lat), saLng = sa && toNum(sa.lng);
  const startAddress = sa && saLat !== null && saLng !== null && Math.abs(saLat) <= 90 && Math.abs(saLng) <= 180
    ? { address: toText(sa.address), lat: saLat, lng: saLng, countryCode: sa.countryCode ? toText(sa.countryCode, 2).toLowerCase() : null }
    : null;

  const overnightOverrides = {};
  const rawOverrides = rawTrip.overnightOverrides && typeof rawTrip.overnightOverrides === "object" ? rawTrip.overnightOverrides : {};
  Object.entries(rawOverrides).forEach(([oldKey, o]) => {
    const [oldId, date] = String(oldKey).split("@");
    if (date !== undefined && !isValidDate(date)) return;
    const lat = o && toNum(o.lat), lng = o && toNum(o.lng);
    if (oldKey === `${ARRIVAL_STOP_PREFIX}${date}` && o && lat !== null && lng !== null) {
      overnightOverrides[oldKey] = { address: toText(o.address), lat, lng };
      return;
    }
    const target = byOldId.get(oldId);
    if (target && o && lat !== null && lng !== null) {
      overnightOverrides[date !== undefined ? `${target.id}@${date}` : target.id] = { address: toText(o.address), lat, lng };
    }
  });

  const eligible = matches.filter(m => !hasNoTickets(m));
  const mustTotal = eligible.filter(m => m.mustAttend).length;
  const rawPlans = Array.isArray(rawTrip.plans) ? rawTrip.plans : (Array.isArray(fallbackPlans) ? fallbackPlans : []);
  const plans = rawPlans.map(p => rebindImportedPlan(p, byOldId, eligible.length, mustTotal)).filter(Boolean);

  const trip = {
    id: "trip_" + Date.now(), name, startAddress, matches, overnightOverrides,
    settings: completeSettings(sanitizeSettings(rawTrip.settings || fallbackSettings || cfg())),
    optimizationMode: OPT_MODES.includes(rawTrip.optimizationMode) ? rawTrip.optimizationMode : "most_games"
  };
  if (plans.length) {
    trip.plans = plans;
    if (rawTrip.selectedPlanSignature) trip.selectedPlanSignature = toText(rawTrip.selectedPlanSignature, 2000);
  }
  return { trip, skipped: rawTrip.matches.length - matches.length };
}

function renderActiveTrip() {
  const trip = getActiveTrip();
  if (!trip) return;
  if (!trip.overnightOverrides) trip.overnightOverrides = {};

  document.getElementById("matchCount").innerText = trip.matches.length;
  document.getElementById("startAddress").value = trip.startAddress ? trip.startAddress.address : "";
  const modeSelect = document.getElementById("optimizationMode");
  if (modeSelect) modeSelect.value = trip.optimizationMode || "most_games";

  // Falls gespeicherte Alternativen im Trip vorhanden sind (aus Storage oder Import), diese wiederherstellen
  if (trip.plans && trip.plans.length > 0) {
    currentPlans = trip.plans;
    let idx = 0;
    if (trip.selectedPlanSignature) {
      const found = currentPlans.findIndex(p => p.signature === trip.selectedPlanSignature);
      if (found !== -1) idx = found;
    }
    currentPlanIndex = idx;
    renderCurrentPlan();
  } else {
    currentPlans = null;
    currentPlanIndex = 0;
    lastSelectedMatchIds = null;

    renderMatchList();
    updateMapMarkers();

    document.getElementById("timeline").innerHTML = '<p class="placeholder-text">Füge Spiele hinzu und klicke auf "Route berechnen".</p>';
    document.getElementById("droppedSection").innerHTML = '';
    const switcherEl = document.getElementById("planSwitcher");
    if (switcherEl) switcherEl.innerHTML = '';
    routeLayer.clearLayers();
  }
}

function websiteLinkHtml(m, className = "") {
  const url = safeHttpUrl(m.clubWebsite);
  if (!url) return "";
  const label = className.includes("compact") ? "🔗 Tickets-Website" : "🔗 Vereinswebsite / Tickets";
  return `<a class="club-website-link ${className}" href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${label}</a>`;
}

// Ticket-Umschalter: initial nichts gewählt; ein Klick setzt "Tickets" bzw. "Keine",
// ein erneuter Klick auf die aktive Option setzt wieder zurück.
function ticketToggleHtml(m, extraClass = "") {
  const yes = hasTickets(m), no = hasNoTickets(m);
  return `<div class="ticket-toggle ${extraClass}" role="group" aria-label="Ticketstatus">
      <button type="button" class="tt-opt tt-yes${yes ? ' active' : ''}" aria-pressed="${yes}" onclick="toggleTicket('${m.id}', 'purchased')" title="${yes ? 'Markierung entfernen' : 'Tickets gekauft – Spiel wird fest eingeplant'}">🎟️ Tickets</button>
      <button type="button" class="tt-opt tt-no${no ? ' active' : ''}" aria-pressed="${no}" onclick="toggleTicket('${m.id}', 'no_tickets')" title="${no ? 'Markierung entfernen' : 'Keine Tickets bekommen – Spiel fliegt raus, Ersatz wird gesucht'}">🚫 Keine</button>
    </div>`;
}

function toggleTicket(matchId, status) {
  const trip = getActiveTrip();
  const match = trip && trip.matches.find(m => m.id === matchId);
  if (!match) return;
  if (match.ticketStatus === status) setTicketStatus(matchId, null);
  else if (status === "no_tickets") markNoTickets(matchId);
  else setTicketStatus(matchId, status);
}

// Selten benötigte Aktionen eines Spiels im ⋯-Menü
function matchMenuHtml(m) {
  return `<details class="menu match-menu">
      <summary class="menu-trigger" title="Weitere Aktionen" aria-label="Weitere Aktionen">⋯</summary>
      <div class="menu-list">
        <button type="button" onclick="closeMenus(); editMatch('${m.id}')">✏️ Bearbeiten</button>
        <button type="button" class="menu-danger" onclick="closeMenus(); deleteMatch('${m.id}')">🗑️ Löschen</button>
      </div>
    </details>`;
}

function closeMenus(except = null) {
  document.querySelectorAll("details.menu[open]").forEach(d => { if (d !== except) d.open = false; });
}

// Offene Menüs bei Klick außerhalb bzw. Escape schließen
document.addEventListener("click", e => closeMenus(e.target.closest("details.menu")));
document.addEventListener("keydown", e => { if (e.key === "Escape") closeMenus(); });

function ticketBadgeHtml(m) {
  if (hasTickets(m)) return ' <span class="ticket-badge ticket-badge-ok" title="Tickets gekauft">🎟️ Tickets</span>';
  if (hasNoTickets(m)) return ' <span class="ticket-badge ticket-badge-none" title="Keine Tickets bekommen">🚫 Keine Tickets</span>';
  return "";
}

function capacityHtml(m) {
  return m.stadiumCapacity ? ` · ${Number(m.stadiumCapacity).toLocaleString("de-DE")} Plätze` : "";
}

function matchPopupHtml(m) {
  const fullAddress = m.resolvedAddress ? `<br>📍 <small style="color:#555;">${escapeHtml(m.resolvedAddress)}</small>` : '';

  return `<b>${escapeHtml(m.home)} vs. ${escapeHtml(m.away)}</b>${m.mustAttend ? ' <span class="must-badge">⭐</span>' : ''}${ticketBadgeHtml(m)}<br>
    ${escapeHtml(m.leagueName || getLeagueName(m.countryCode, m.leagueLevel))}<br>
    🏟️ <b>${escapeHtml(m.stadium)}</b>${capacityHtml(m)}${fullAddress}<br>
    📅 ${m.date} um ${m.time} Uhr${m.clubWebsite ? `<br>${websiteLinkHtml(m)}` : ""}`;
}

// Rendert die Match-Liste in der Sidebar mit Berücksichtigung der Alternativen (Dunkelgrün / Helles Grün)
function renderMatchList() {
  const trip = getActiveTrip();
  const matchList = document.getElementById("matchList");
  if (!trip || !matchList) return;

  const totalPlans = currentPlans ? currentPlans.length : 0;
  const activePlan = (currentPlans && currentPlans[currentPlanIndex]) ? currentPlans[currentPlanIndex] : null;

  const droppedReasons = activePlan
    ? new Map(activePlan.dropped.map(d => [d.match.id, d.reason]))
    : new Map();

  matchList.innerHTML = trip.matches
    .slice()
    .sort((a, b) => new Date(`${a.date}T${a.time}`) - new Date(`${b.date}T${b.time}`))
    .map(m => {
      let statusClass = "";
      let reasonHtml = "";
    
      if (hasNoTickets(m)) {
        statusClass = "status-no-tickets";
        reasonHtml = `<div class="reason">Wird bei der Berechnung nicht berücksichtigt.</div>`;
      } else if (totalPlans > 0) {
        const plansWithMatch = [];
        currentPlans.forEach((p, idx) => {
          if (p.selected.some(sm => sm.id === m.id)) {
            plansWithMatch.push(idx + 1);
          }
        });

        if (plansWithMatch.length === totalPlans) {
          // In JEDER Alternative enthalten -> Dunkelgrün
          statusClass = "status-selected";
          reasonHtml = `<div class="reason alt-reason">✓ In allen Alternativen enthalten</div>`;
        } else if (plansWithMatch.length > 0) {
          // Nur in EINZELNEN Alternativen enthalten -> Helles Grün
          statusClass = "status-alternative";
          const isCurrent = plansWithMatch.includes(currentPlanIndex + 1);
          reasonHtml = `<div class="reason alt-reason">In Alternative ${plansWithMatch.join(', ')} enthalten${isCurrent ? ' (in aktiver Ansicht)' : ''}</div>`;
        } else {
          // In KEINER Alternative enthalten -> Aussortiert
          statusClass = "status-dropped";
          const reason = droppedReasons.get(m.id) || "In keiner Alternative enthalten.";
          reasonHtml = `<div class="reason">${escapeHtml(reason)}</div>`;
        }
      }

      const leagueLabel = escapeHtml(m.leagueName || getLeagueName(m.countryCode, m.leagueLevel));
      return `
    <li class="match-list-item ${statusClass}">
      <div class="match-card-head">
        <div class="match-card-title">
          <strong>${escapeHtml(m.home)} – ${escapeHtml(m.away)}</strong>${m.mustAttend ? ' <span class="must-badge" title="Highlightspiel">⭐</span>' : ''}
        </div>
        ${matchMenuHtml(m)}
      </div>
      <div class="match-card-meta">📅 ${formatDateShort(m.date)} · ${m.time} Uhr · ${leagueLabel}</div>
      <div class="match-card-meta">📍 ${escapeHtml(m.stadium)}${capacityHtml(m)}</div>
      ${reasonHtml}
      <div class="match-card-foot">
        ${ticketToggleHtml(m)}
        ${m.clubWebsite ? websiteLinkHtml(m, "compact") : ""}
      </div>
    </li>
  `;
    }).join('');
}

// ---------- OSRM Routing ----------
let routingEstimated = false; // true, sobald Fahrzeiten geschätzt werden mussten

function estimateTravelMin(lat1, lng1, lat2, lng2) {
  const rad = d => d * Math.PI / 180;
  const a = Math.sin(rad(lat2 - lat1) / 2) ** 2 +
    Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(rad(lng2 - lng1) / 2) ** 2;
  const km = 6371 * 2 * Math.asin(Math.sqrt(a)) * 1.3; // Luftlinie × 1,3
  return Math.max(1, Math.round(km / 75 * 60));        // ca. 75 km/h
}

async function getOSRMRoute(startLat, startLng, endLat, endLng, withSteps = false) {
  const stepsParam = withSteps ? "&steps=true" : "";
  const url = `https://router.project-osrm.org/route/v1/driving/${startLng},${startLat};${endLng},${endLat}?overview=full&geometries=geojson${stepsParam}`;
  try {
    const res = await fetchWithTimeout(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (data.routes && data.routes.length > 0) {
      const route = data.routes[0];
      return {
        durationMin: Math.round(route.duration / 60),
        geometry: route.geometry,
        steps: withSteps && route.legs && route.legs[0] ? route.legs[0].steps : null,
        estimated: false
      };
    }
  } catch (err) {
    console.error("OSRM Error:", err);
  }
  routingEstimated = true;
  return { durationMin: estimateTravelMin(startLat, startLng, endLat, endLng), geometry: null, steps: null, estimated: true };
}

const travelKey = (lat1, lng1, lat2, lng2) =>
  `${lat1.toFixed(4)},${lng1.toFixed(4)}|${lat2.toFixed(4)},${lng2.toFixed(4)}`;

async function getCachedTravelMin(lat1, lng1, lat2, lng2) {
  const key = travelKey(lat1, lng1, lat2, lng2);
  if (travelCache.has(key)) return travelCache.get(key);
  const result = await getOSRMRoute(lat1, lng1, lat2, lng2);
  if (!result.estimated) travelCache.set(key, result.durationMin); // Schätzwerte nie cachen
  return result.durationMin;
}

// Holt die Fahrzeit-Matrix für alle Punkte mit EINEM OSRM-Table-Request statt n² Einzelrequests.
// Schlägt der Request fehl, greifen die Einzelabfragen (inkl. Schätzung und Warnbanner) wie bisher.
async function prefetchTravelMatrix(points) {
  const seen = new Set(), unique = [];
  for (const p of points) {
    const k = `${p.lat.toFixed(4)},${p.lng.toFixed(4)}`;
    if (!seen.has(k)) { seen.add(k); unique.push(p); }
  }
  if (unique.length < 2 || unique.length > 60) return;
  const missing = unique.some((a, i) => unique.some((b, j) =>
    i !== j && !travelCache.has(travelKey(a.lat, a.lng, b.lat, b.lng))));
  if (!missing) return;
  const coords = unique.map(p => `${p.lng},${p.lat}`).join(";");
  try {
    const res = await fetchWithTimeout(`https://router.project-osrm.org/table/v1/driving/${coords}?annotations=duration`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (data.code !== "Ok" || !Array.isArray(data.durations)) return;
    unique.forEach((a, i) => unique.forEach((b, j) => {
      const sec = data.durations[i] && data.durations[i][j];
      if (i !== j && Number.isFinite(sec)) travelCache.set(travelKey(a.lat, a.lng, b.lat, b.lng), Math.round(sec / 60));
    }));
  } catch (err) {
    console.error("OSRM Table Error:", err);
  }
}

// Route mit Geometrie (und optional Steps) – nur echte Ergebnisse werden gecacht.
async function getCachedRoute(lat1, lng1, lat2, lng2, withSteps = false) {
  const key = travelKey(lat1, lng1, lat2, lng2);
  const hit = routeCache.get(key);
  if (hit && (!withSteps || hit.steps)) return hit;
  const result = await getOSRMRoute(lat1, lng1, lat2, lng2, withSteps);
  if (!result.estimated) {
    routeCache.set(key, result);
    travelCache.set(key, result.durationMin);
  }
  return result;
}

async function cachedReverseGeocode(lat, lng) {
  const key = `${lat.toFixed(2)},${lng.toFixed(2)}`;
  if (reverseGeoCache.has(key)) return reverseGeoCache.get(key);
  const name = await reverseGeocode(lat, lng, 10);
  if (name) reverseGeoCache.set(key, name);
  return name;
}

const DAILY_DRIVE_MIN = 12 * 60; // angenommene Fahrzeit pro freiem Tag

// fetch mit Zeitlimit, damit ein hängender Dienst die Berechnung nie blockiert
async function fetchWithTimeout(url, ms = 10000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

function addDaysIso(dateStr, delta) {
  const d = new Date(`${dateStr}T12:00:00`); // Mittag: unempfindlich gegen Zeitumstellung
  d.setDate(d.getDate() + delta);
  const pad = v => String(v).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// Verteilt die Anreise bei freien Tagen auf Fahrtage mit Zwischenstopps.
// Vom aktuellen Ort aus wird jeweils neu gerechnet: Was am Spieltag morgens noch passt, wird dort gefahren,
// der Rest gleichmäßig auf die letzten freien Tage davor. Gesetzte Stopps (Overrides) ersetzen den Vorschlag,
// die Tage danach rechnen ab dort weiter.
async function planDrivingDays(originLoc, lastMatch, nextMatch, trip) {
  const arrBuffer = nextMatch.customArrivalBuffer ?? cfg().arrivalBufferMin;
  const requiredArrival = new Date(new Date(`${nextMatch.date}T${nextMatch.time}`).getTime() - arrBuffer * 60000);
  const morningStart = timeToDateOnDay(nextMatch.date, cfg().nextDayStartHour);
  const lastDayMin = Math.max(0, (requiredArrival - morningStart) / 60000);

  const days = [];
  let cur = { lat: originLoc.lat, lng: originLoc.lng, name: originLoc.name };
  let curDate = lastMatch.date;

  for (let guard = 0; guard < 14; guard++) {
    const freeDays = daysBetween(curDate, nextMatch.date) - 1;
    if (freeDays <= 0) break;
    const route = await getCachedRoute(cur.lat, cur.lng, nextMatch.lat, nextMatch.lng, true);
    const earlierMin = Math.max(0, route.durationMin - lastDayMin);
    if (earlierMin <= 0) break; // der Rest passt in den Spieltag

    const k = Math.max(1, Math.min(freeDays, Math.ceil(earlierMin / DAILY_DRIVE_MIN)));
    const perDay = Math.ceil(earlierMin / k);
    const date = addDaysIso(nextMatch.date, -k); // frühester der noch nötigen Fahrtage
    const key = `${lastMatch.id}@${date}`;
    const ov = trip.overnightOverrides[key];

    let to;
    if (ov) {
      to = { lat: ov.lat, lng: ov.lng, name: ov.address };
    } else {
      const cum = Math.min(route.durationMin, perDay);
      const fraction = Math.min(1, cum / Math.max(1, route.durationMin));
      const p = findPointAtTime(route.steps, cum * 60) || {
        lat: cur.lat + (nextMatch.lat - cur.lat) * fraction,
        lng: cur.lng + (nextMatch.lng - cur.lng) * fraction
      };
      const name = (await cachedReverseGeocode(p.lat, p.lng)) || `Ungefähr ${p.lat.toFixed(3)}, ${p.lng.toFixed(3)}`;
      to = { lat: p.lat, lng: p.lng, name };
    }
    days.push({ date, key, override: !!ov, from: cur, to });
    cur = to;
    curDate = date;
  }
  return days;
}

// Zeichnet die Fahrtage auf der Karte und liefert das HTML der Tageskacheln (null = Lauf veraltet).
async function renderJourneyTiles(days, myRun) {
  const fmt = d => d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  let out = "";
  for (const day of days) {
    const leg = await getCachedRoute(day.from.lat, day.from.lng, day.to.lat, day.to.lng);
    if (myRun !== renderRunId) return null;
    if (leg.geometry) L.geoJSON(leg.geometry, { style: { color: '#1b4332', weight: 4 } }).addTo(routeLayer);
    L.marker([day.to.lat, day.to.lng]).bindPopup(`<b>🌙 Übernachtung</b><br>${escapeHtml(day.to.name)}`).addTo(routeLayer);

    const driveMin = leg.durationMin;
    const dep = timeToDateOnDay(day.date, cfg().nextDayStartHour);
    const arr = new Date(dep.getTime() + driveMin * 60000);
    const inputId = `driveStopInput_${day.key.replace(/[^A-Za-z0-9_-]/g, "_")}`;
    const longWarning = driveMin > DAILY_DRIVE_MIN
      ? `<div class="warning-banner">⚠️ Mehr als ${DAILY_DRIVE_MIN / 60} Stunden Fahrzeit an diesem Tag – ggf. einen früheren Stopp wählen.</div>`
      : '';

    out += `
      <div class="day-tile">
        <div class="day-tile-header">
          <h3>${formatDateLong(day.date)}</h3>
          <span class="tile-changed-badge">${day.label || "🚗 Fahrtag"}</span>
        </div>
        <div class="day-tile-body">
          <div class="timeline-item">
            <strong>🚗 Fahrt nach ${escapeHtml(day.to.name)}</strong><br>
            Abfahrt: ${fmt(dep)} Uhr | Fahrzeit: ca. ${driveMin} Min.<br>
            Ankunft: ca. ${fmt(arr)} Uhr
            ${longWarning}
            <br><a href="${generateGoogleDeeplink(day.from.lat, day.from.lng, day.to.lat, day.to.lng)}" target="_blank" class="deeplink-btn">In Google Maps öffnen</a>
          </div>
          <div class="timeline-item overnight-block">
            <h4>🌙 Übernachtung</h4>
            <p class="print-only"><strong>Adresse:</strong> ${escapeHtml(day.to.name)}</p>
            ${day.override ? '' : `<p><em>Automatischer Vorschlag – bitte Verfügbarkeit von Hotels/Unterkünften vor Ort kurz prüfen.</em></p>`}
            <p class="settings-hint">Andere Adresse eintragen (z. B. weiter fahren): Die Tage danach rechnen ab dort neu.</p>
            <div class="form-row">
              <input type="text" id="${inputId}" placeholder="Übernachtungsadresse" value="${escapeHtml(day.to.name)}" />
              <button class="btn btn-small" onclick="saveOvernightOverride('${day.key}', '${inputId}')">Übernehmen</button>
              ${day.override ? `<button class="btn btn-small btn-secondary" onclick="clearOvernightOverride('${day.key}')">Vorschlag zurücksetzen</button>` : ''}
            </div>
            <a href="${generateHotelSearchLink(day.to.lat, day.to.lng)}" target="_blank" class="deeplink-btn hotel-btn">🏨 Unterkünfte hier suchen</a>
          </div>
        </div>
      </div>
    `;
  }
  return out;
}

function findPointAtTime(steps, targetSec) {
  if (!steps || steps.length === 0) return null;
  let cumulative = 0;
  for (const step of steps) {
    if (cumulative + step.duration >= targetSec) {
      const coords = step.geometry ? step.geometry.coordinates : null;
      if (coords && coords.length > 1 && step.duration > 0) {
        const fraction = (targetSec - cumulative) / step.duration;
        const idx = Math.min(coords.length - 1, Math.max(0, Math.round(fraction * (coords.length - 1))));
        const [lng, lat] = coords[idx];
        return { lat, lng };
      }
      const [lng, lat] = step.maneuver.location;
      return { lat, lng };
    }
    cumulative += step.duration;
  }
  const last = steps[steps.length - 1];
  const [lng, lat] = last.maneuver.location;
  return { lat, lng };
}

function generateGoogleDeeplink(originLat, originLng, destLat, destLng) {
  return `https://www.google.com/maps/dir/?api=1&origin=${originLat},${originLng}&destination=${destLat},${destLng}&travelmode=driving`;
}

function generateHotelSearchLink(lat, lng) {
  return `https://www.google.com/maps/search/Hotels+Unterk%C3%BCnfte/@${lat},${lng},13z`;
}

function calculateMatchEndTime(match) {
  const kickOff = new Date(`${match.date}T${match.time}`);
  const depBuffer = match.customDepartureBuffer ?? cfg().departureBufferMin;
  const totalDurationMin = 90 + cfg().halfTimeMin + cfg().stoppageTimeMin + depBuffer;
  return new Date(kickOff.getTime() + totalDurationMin * 60000);
}

function timeToDateOnDay(dateStr, timeStr) {
  const [h, m] = timeStr.split(":").map(Number);
  const d = new Date(`${dateStr}T00:00:00`);
  d.setHours(h, m, 0, 0);
  return d;
}

function priorityScore(m) { return groundhopperScore(m); }

// true, wenn der DP-Zustand `candidate` besser ist als `current` (fehlender current zählt als schlechter).
function compareDpStates(candidate, current, ref) {
  if (!current) return true;
  return compareByMode(
    { count: candidate.count, scoreSum: candidate.score },
    { count: current.count, scoreSum: current.score },
    ref
  ) < 0;
}

// ---------- Dynamic Programming ----------
async function computeDayDP(segment, startLoc, startTime) {
  const n = segment.length;
  const dp = new Array(n).fill(null);
  await prefetchTravelMatrix([startLoc, ...segment]);

  for (let j = 0; j < n; j++) {
    const m = segment[j];
    const arrBuffer = m.customArrivalBuffer ?? cfg().arrivalBufferMin;
    const kickoff = new Date(`${m.date}T${m.time}`);
    const requiredArrival = new Date(kickoff.getTime() - arrBuffer * 60000);

    let best = null;

    if (await canStartWith(startLoc, startTime, m, requiredArrival)) {
    best = { count: 1, score: priorityScore(m), prev: -1 };
    }

    for (let i = 0; i < j; i++) {
      if (!dp[i]) continue;
      const prevMatch = segment[i];
      const prevEnd = calculateMatchEndTime(prevMatch);
      const travel = await getCachedTravelMin(prevMatch.lat, prevMatch.lng, m.lat, m.lng);
      const earliest = new Date(prevEnd.getTime() + travel * 60000);
      if (earliest <= requiredArrival) {
        const candCount = dp[i].count + 1;
        const candScore = dp[i].score + priorityScore(m);
        const candidate = { count: candCount, score: candScore, prev: i };
        if (compareDpStates(candidate, best, n)) best = candidate;
      }
    }
    dp[j] = best;
  }
  return dp;
}

function reconstructChain(dp, segment, endIndex) {
  const idxChain = [];
  let cur = endIndex;
  while (cur !== -1) {
    idxChain.push(cur);
    cur = dp[cur].prev;
  }
  idxChain.reverse();
  return idxChain.map(i => segment[i]);
}

async function bestChainUnconstrained(segment, startLoc, startTime) {
  if (segment.length === 0) return { chain: [], usedIndices: new Set() };
  const dp = await computeDayDP(segment, startLoc, startTime);
  let bestIdx = -1;
  for (let j = 0; j < dp.length; j++) {
    if (!dp[j]) continue;
    if (bestIdx === -1 || compareDpStates(dp[j], dp[bestIdx], segment.length)) bestIdx = j;
  }
  if (bestIdx === -1) return { chain: [], usedIndices: new Set() };
  const chain = reconstructChain(dp, segment, bestIdx);
  return { chain, usedIndices: new Set(chain.map(m => m.id)) };
}

async function bestChainEndingAtLast(segment, startLoc, startTime) {
  if (segment.length === 0) return { chain: [], usedIndices: new Set(), reachable: true };
  const dp = await computeDayDP(segment, startLoc, startTime);
  const lastIdx = segment.length - 1;
  if (!dp[lastIdx]) return { chain: [], usedIndices: new Set(), reachable: false };
  const chain = reconstructChain(dp, segment, lastIdx);
  return { chain, usedIndices: new Set(chain.map(m => m.id)), reachable: true };
}

async function chainWithForcedIndices(dayMatches, forcedIndicesInput, startLoc, startTime) {
  const chain = [];
  const dropped = [];
  const mustIndices = [...new Set(forcedIndicesInput)].sort((a, b) => a - b);

  let cursor = 0;
  let currentLoc = startLoc;
  let currentTime = startTime;

  for (const mustIdx of mustIndices) {
    if (mustIdx < cursor) continue;
    const forcedMatch = dayMatches[mustIdx];
    const isRealMustAttend = isForced(forcedMatch);
    const forcedLabel = hasTickets(forcedMatch) ? "Spiel mit gekauften Tickets" : "Highlightspiel";
    const segment = dayMatches.slice(cursor, mustIdx + 1);
    const { chain: segChain, usedIndices, reachable } = await bestChainEndingAtLast(segment, currentLoc, currentTime);

    if (!reachable) {
      dropped.push({
        match: forcedMatch,
        reason: isRealMustAttend
          ? `${forcedLabel} zeitlich nicht erreichbar – bitte Reisezeit/Puffer oder andere Spiele prüfen.`
          : "In dieser Alternative zeitlich nicht erreichbar."
      });
      const fallbackSegment = dayMatches.slice(cursor, mustIdx);
      const { chain: fbChain, usedIndices: fbUsed } = await bestChainUnconstrained(fallbackSegment, currentLoc, currentTime);
      chain.push(...fbChain);
      fallbackSegment.forEach(m => {
        if (!fbUsed.has(m.id)) dropped.push({ match: m, reason: "Zeitlich nicht mit der Tagesauswahl vereinbar." });
      });
      if (fbChain.length > 0) {
        const last = fbChain[fbChain.length - 1];
        currentLoc = { lat: last.lat, lng: last.lng };
        currentTime = calculateMatchEndTime(last);
      }
    } else {
      chain.push(...segChain);
      segment.forEach(m => {
        if (!usedIndices.has(m.id)) {
          dropped.push({
            match: m,
            reason: isRealMustAttend
              ? `Zeitlich nicht mit der Tagesauswahl vereinbar (${forcedLabel} hat Vorrang).`
              : "Zeitlich nicht mit dieser Alternative vereinbar."
          });
        }
      });
      const last = segChain[segChain.length - 1];
      currentLoc = { lat: last.lat, lng: last.lng };
      currentTime = calculateMatchEndTime(last);
    }
    cursor = mustIdx + 1;
  }

  const tail = dayMatches.slice(cursor);
  if (tail.length > 0) {
    const { chain: tailChain, usedIndices } = await bestChainUnconstrained(tail, currentLoc, currentTime);
    chain.push(...tailChain);
    tail.forEach(m => {
      if (!usedIndices.has(m.id)) dropped.push({ match: m, reason: "Zeitlich nicht mit der Tagesauswahl vereinbar – Auswahl maximiert stattdessen die Anzahl möglicher Spiele." });
    });
  }

  return { chain, dropped };
}

// ---------- Übernachtungslogik ----------
// Reine Machbarkeitsprüfung der Übernachtung zwischen zwei Spielen (ohne Netzwerkzugriff).
function overnightFeasibility(prevMatch, nextMatch, totalTravelMin, fromOvernight = false) {
  const prevEnd = calculateMatchEndTime(prevMatch);
  const arrBuffer = nextMatch.customArrivalBuffer ?? cfg().arrivalBufferMin;
  const requiredArrival = new Date(new Date(`${nextMatch.date}T${nextMatch.time}`).getTime() - arrBuffer * 60000);
  const nightCutoff = timeToDateOnDay(prevMatch.date, cfg().maxNightDriveTime);
  const morningStart = timeToDateOnDay(nextMatch.date, cfg().nextDayStartHour);
  const gapDays = Math.max(0, Math.round(
    (new Date(`${nextMatch.date}T00:00:00`) - new Date(`${prevMatch.date}T00:00:00`)) / 86400000));
   const freeDayMin = Math.max(0, gapDays - 1) * DAILY_DRIVE_MIN; // pro freiem Tag konservativ 12 h Fahrzeit

  function compute(cutoff) {
    const eveningMin = fromOvernight ? 0 : Math.max(0, (cutoff - prevEnd) / 60000);
    const morningMin = Math.max(0, (requiredArrival - morningStart) / 60000);
    const availableMin = eveningMin + morningMin + freeDayMin;
    return {
      feasible: totalTravelMin <= availableMin,
      missingMin: Math.max(0, totalTravelMin - availableMin),
      eveningDriveMin: gapDays >= 2 ? 0 : Math.min(eveningMin, Math.max(0, totalTravelMin - morningMin))
    };
  }

  let result = compute(nightCutoff);
  let extraMinutesUsed = 0;
  if (!result.feasible && !fromOvernight) {
    const maxExtra = cfg().maxExtraNightDriveMin ?? 120;
    for (let extra = 15; extra <= maxExtra; extra += 15) {
      result = compute(new Date(nightCutoff.getTime() + extra * 60000));
      extraMinutesUsed = extra;
      if (result.feasible) break;
    }
  }
  return { ...result, extraMinutesUsed, gapDays };
}

// Darf das Spiel m der erste Programmpunkt dieses Segments sein?
// Startet das Segment an einem Stadion eines früheren Tages (origin.fromMatch), gilt die Nacht-Logik,
// sonst die einfache Prüfung "Startzeit + Fahrzeit <= Ankunft".
async function canStartWith(origin, startTime, m, requiredArrival) {
  const from = origin.fromMatch;
  if (from && from.date !== m.date) return (await nightCheck(origin, m)).feasible;
  const travel = await getCachedTravelMin(origin.lat, origin.lng, m.lat, m.lng);
  const base = from ? calculateMatchEndTime(from) : startTime;
  if (new Date(base.getTime() + travel * 60000) <= requiredArrival) return true;
  // Start von zu Hause: ggf. mit Anreise am Vortag
  if (!from && origin.arrivalDay && (origin.arrivalDay === "all" || isForced(m))) {
    return arrivalDayFeasible(origin, m);
  }
  return false;
}

// ---------- Anreisetag (Anreise am Vortag von zu Hause) ----------
// Gilt nur für das erste Spiel ab der Startadresse:
//  - Highlightspiele und Spiele mit gekauften Tickets dürfen immer einen Anreisetag nutzen,
//  - ist an einem Tag KEIN Spiel am selben Tag von zu Hause erreichbar, gilt der Anreisetag für alle Spiele des Tages.
const ARRIVAL_STOP_PREFIX = "__start@";
const arrivalDayKey = matchDate => `${ARRIVAL_STOP_PREFIX}${addDaysIso(matchDate, -1)}`;

function morningWindowMin(m) {
  return Math.max(0, (requiredArrivalTime(m) - timeToDateOnDay(m.date, cfg().nextDayStartHour)) / 60000);
}

// Machbar mit Anreisetag? Am Vortag bis zu DAILY_DRIVE_MIN fahren, Rest am Spieltag morgens.
// Ist für den Anreisetag eine eigene Übernachtungsadresse gesetzt, zählt die Fahrt ab dort.
async function arrivalDayFeasible(home, m) {
  const trip = getActiveTrip();
  const stop = trip && trip.overnightOverrides[arrivalDayKey(m.date)];
  if (stop) return (await getCachedTravelMin(stop.lat, stop.lng, m.lat, m.lng)) <= morningWindowMin(m);
  return (await getCachedTravelMin(home.lat, home.lng, m.lat, m.lng)) <= DAILY_DRIVE_MIN + morningWindowMin(m);
}

// Am selben Tag (ab Morgen-Startzeit) von zu Hause erreichbar?
async function reachableSameDayFromHome(home, m) {
  return (await getCachedTravelMin(home.lat, home.lng, m.lat, m.lng)) <= morningWindowMin(m);
}

// Startpunkt "zu Hause" für einen Spieltag, inkl. Anreisetag-Regel.
async function homeStartLoc(trip, dayMatches) {
  const home = { lat: trip.startAddress.lat, lng: trip.startAddress.lng };
  await prefetchTravelMatrix([home, ...dayMatches]);
  let anySameDay = false;
  for (const m of dayMatches) {
    if (await reachableSameDayFromHome(home, m)) { anySameDay = true; break; }
  }
  return { ...home, arrivalDay: anySameDay ? "forced" : "all" };
}

async function planOvernight(prevMatch, nextMatch, withName = true) {
  const osrm = await getCachedRoute(prevMatch.lat, prevMatch.lng, nextMatch.lat, nextMatch.lng, true);
  const totalTravelMin = osrm.durationMin;
  const f = overnightFeasibility(prevMatch, nextMatch, totalTravelMin);

  let overnightPoint;
  if (f.eveningDriveMin > 1) {
    const fraction = Math.min(1, f.eveningDriveMin / Math.max(1, totalTravelMin));
    const coord = findPointAtTime(osrm.steps, f.eveningDriveMin * 60) || {
      lat: prevMatch.lat + (nextMatch.lat - prevMatch.lat) * fraction,
      lng: prevMatch.lng + (nextMatch.lng - prevMatch.lng) * fraction
    };
    const placeName = withName ? await cachedReverseGeocode(coord.lat, coord.lng) : null;
    overnightPoint = {
      lat: coord.lat,
      lng: coord.lng,
      suggestedName: placeName || `Ungefähr ${coord.lat.toFixed(3)}, ${coord.lng.toFixed(3)}`
    };
  } else {
    overnightPoint = { lat: prevMatch.lat, lng: prevMatch.lng, suggestedName: prevMatch.stadium };
  }

  return {
    feasible: f.feasible,
    extraMinutesUsed: f.extraMinutesUsed,
    missingMin: Math.round(f.missingMin || 0),
    eveningDriveMin: Math.round(f.eveningDriveMin),
    gapDays: f.gapDays,
    totalTravelMin,
    overnightPoint
  };
}

const daysBetween = (a, b) =>
  Math.round((new Date(`${b}T12:00:00`) - new Date(`${a}T12:00:00`)) / 86400000);

// Letzter vom Nutzer gesetzter Fahrtag-Stopp zwischen Spiel `from` und Spiel `m` (oder null)
function latestDrivingOverride(from, m) {
  const trip = getActiveTrip();
  const prefix = `${from.id}@`;
  let best = null;
  for (const [key, o] of Object.entries((trip && trip.overnightOverrides) || {})) {
    if (!key.startsWith(prefix)) continue;
    const date = key.slice(prefix.length);
    if (date > from.date && date < m.date && (!best || date > best.date)) best = { date, lat: o.lat, lng: o.lng };
  }
  return best;
}

// Nacht-/Anreise-Prüfung zwischen dem Ausgangspunkt (Stadion, Übernachtung oder gesetzter Fahrtag-Stopp)
// und dem ersten Spiel m eines späteren Tages.
async function nightCheck(origin, m) {
  const from = origin.fromMatch;
  const stop = latestDrivingOverride(from, m);
  const src = stop || origin;
  const travel = await getCachedTravelMin(src.lat, src.lng, m.lat, m.lng);
  const prev = stop ? { ...from, date: stop.date } : from;
  return overnightFeasibility(prev, m, travel, !!stop || !!origin.viaOvernight);
}

async function saveOvernightOverride(matchId, inputElId) {
  const trip = getActiveTrip();
  const address = document.getElementById(inputElId).value;
  if (!address) return;
  const coords = await geocodeAddress(address);
  if (!coords) {
    alert("Adresse konnte nicht gefunden werden.");
    return;
  }
  trip.overnightOverrides[matchId] = { address, lat: coords.lat, lng: coords.lng };
  saveLocalStorage();
  calculateRoute();
}

function clearOvernightOverride(matchId) {
  const trip = getActiveTrip();
  delete trip.overnightOverrides[matchId];
  saveLocalStorage();
  calculateRoute();
}

// ---------- Tages-Alternativen erzeugen ----------
function dayChainSignature(chain) {
  return chain.map(m => m.id).sort().join(',');
}

async function generateDayCandidates(dayMatches, startLoc, startTime, maxAlternatives = MAX_DAY_ALTERNATIVES) {
  const trueMustIndices = [];
  dayMatches.forEach((m, i) => { if (isForced(m)) trueMustIndices.push(i); });

  const base = await chainWithForcedIndices(dayMatches, trueMustIndices, startLoc, startTime);
  const seen = new Map();
  seen.set(dayChainSignature(base.chain), base);

  for (const d of base.dropped) {
    if (isForced(d.match)) continue;
    const idx = dayMatches.indexOf(d.match);
    if (idx === -1) continue;
    const alt = await chainWithForcedIndices(dayMatches, [...trueMustIndices, idx], startLoc, startTime);
    const sig = dayChainSignature(alt.chain);
    if (!seen.has(sig)) seen.set(sig, alt);
  }

  for (const m of base.chain) {
    if (isForced(m)) continue;
    const filtered = dayMatches.filter(x => x.id !== m.id);
    const remappedMust = [];
    filtered.forEach((x, i) => { if (isForced(x)) remappedMust.push(i); });
    const alt = await chainWithForcedIndices(filtered, remappedMust, startLoc, startTime);
    const sig = dayChainSignature(alt.chain);
    if (!seen.has(sig)) seen.set(sig, alt);
  }

  const candidates = [...seen.values()];

  candidates.sort((a, b) => {
    const ticketDroppedA = a.dropped.filter(x => hasTickets(x.match)).length;
    const ticketDroppedB = b.dropped.filter(x => hasTickets(x.match)).length;
    if (ticketDroppedA !== ticketDroppedB) return ticketDroppedA - ticketDroppedB;
    const mustDroppedA = a.dropped.filter(x => x.match.mustAttend).length;
    const mustDroppedB = b.dropped.filter(x => x.match.mustAttend).length;
    if (mustDroppedA !== mustDroppedB) return mustDroppedA - mustDroppedB;
    return compareOptimizationMetrics(a.chain, b.chain, dayMatches.length);
  });

  return candidates.slice(0, Math.max(1, maxAlternatives));
}

async function computeDayTravelMin(chain, startLoc) {
  let total = 0;
  let loc = startLoc;
  for (const m of chain) {
    total += await getCachedTravelMin(loc.lat, loc.lng, m.lat, m.lng);
    loc = { lat: m.lat, lng: m.lng };
  }
  return total;
}

function comparePlans(a, b, referenceCount = null) {
  if (a.infeasibleNights !== b.infeasibleNights) return a.infeasibleNights - b.infeasibleNights;
  const ticketsA = a.purchasedCount || 0, ticketsB = b.purchasedCount || 0;
  if (ticketsA !== ticketsB) return ticketsB - ticketsA;
  if (a.mustAttendCount !== b.mustAttendCount) return b.mustAttendCount - a.mustAttendCount;
  const ref = Math.max(1, referenceCount || a.availableMatchCount || b.availableMatchCount || a.matchCount || b.matchCount);
  const byMode = compareByMode(
    { count: a.matchCount, scoreSum: a.scoreSum || 0 },
    { count: b.matchCount, scoreSum: b.scoreSum || 0 },
    ref
  );
  if (byMode !== 0) return byMode;
  if (a.tightNights !== b.tightNights) return a.tightNights - b.tightNights;
  return a.totalTravelMin - b.totalTravelMin;
}

function planSignature(dayChains) {
  return dayChains.map(dc => dayChainSignature(dc.chain)).join('|');
}

function finalizePlanState(beamState, trip) {
  const selected = beamState.dayChains.flatMap(dc => dc.chain);
  const dropped = beamState.dayChains.flatMap(dc => dc.dropped);
  const eligible = planningMatches(trip);
  const scoreSum = chainScoreSum(selected);

  return {
    dayChains: beamState.dayChains,
    selected,
    dropped,
    totalTravelMin: beamState.totalTravelMin,
    tightNights: beamState.tightNights,
    infeasibleNights: beamState.infeasibleNights,
    matchCount: selected.length,
    mustAttendCount: selected.filter(m => m.mustAttend).length,
    mustAttendTotal: eligible.filter(m => m.mustAttend).length,
    purchasedCount: selected.filter(hasTickets).length,
    scoreSum,
    averageGroundhopperScore: selected.length ? scoreSum / selected.length : 0,
    availableMatchCount: eligible.length,
    optimizationMode: currentOptimizationMode,
    signature: planSignature(beamState.dayChains)
  };
}

function shortMatchLabel(m) {
  return `${m.home}–${m.away}`;
}

function formatDateShort(dateStr) {
  const d = new Date(`${dateStr}T00:00:00`);
  return d.toLocaleDateString('de-DE', { weekday: 'short', day: '2-digit', month: '2-digit' });
}

function formatDateLong(dateStr) {
  const d = new Date(`${dateStr}T00:00:00`);
  return d.toLocaleDateString('de-DE', { weekday: 'long', day: '2-digit', month: '2-digit', year: 'numeric' });
}

function changedDatesOf(basePlan, plan) {
  const changed = new Set();
  const baseByDate = new Map(basePlan.dayChains.map(dc => [dc.date, dc]));
  plan.dayChains.forEach(dc => {
    const baseDc = baseByDate.get(dc.date);
    const baseSig = baseDc ? dayChainSignature(baseDc.chain) : '';
    if (baseSig !== dayChainSignature(dc.chain)) changed.add(dc.date);
  });
  return changed;
}

function diffDescription(basePlan, plan) {
  const parts = [];
  const baseByDate = new Map(basePlan.dayChains.map(dc => [dc.date, dc]));

  plan.dayChains.forEach(dc => {
    const baseDc = baseByDate.get(dc.date);
    const baseIds = new Set(baseDc ? baseDc.chain.map(m => m.id) : []);
    const ids = new Set(dc.chain.map(m => m.id));

    const added = dc.chain.filter(m => !baseIds.has(m.id));
    const removed = (baseDc ? baseDc.chain : []).filter(m => !ids.has(m.id));
    if (added.length === 0 && removed.length === 0) return;

    const label = formatDateShort(dc.date);
    if (added.length && removed.length) {
      parts.push(`${label}: ${removed.map(shortMatchLabel).join(', ')} → ${added.map(shortMatchLabel).join(', ')}`);
    } else if (added.length) {
      parts.push(`${label}: zusätzlich ${added.map(shortMatchLabel).join(', ')}`);
    } else {
      parts.push(`${label}: ohne ${removed.map(shortMatchLabel).join(', ')}`);
    }
  });

  const travelDelta = Math.round(plan.totalTravelMin - basePlan.totalTravelMin);
  if (travelDelta !== 0) {
    parts.push(`${travelDelta > 0 ? '+' : ''}${travelDelta} Min. Fahrt`);
  }

  const nightDelta = plan.tightNights - basePlan.tightNights;
  if (nightDelta !== 0) {
    parts.push(`${nightDelta > 0 ? '+' : ''}${nightDelta} enge Nachtfahrt${Math.abs(nightDelta) === 1 ? '' : 'en'}`);
  }

  return parts.join(' · ') || 'Gleiche Spiele, andere Reihenfolge/Route.';
}

// ---------- Planzustand Tag für Tag fortschreiben ----------
// Wird von der Optimierung und von der Reparatur ("Keine Tickets") gemeinsam genutzt.
function initialPlanState(trip, firstDate) {
  return {
    dayChains: [],
    currentLoc: { lat: trip.startAddress.lat, lng: trip.startAddress.lng },
    // Abfahrt von zu Hause frühestens zur eingestellten Morgen-Startzeit des ersten Spieltags
    currentTime: timeToDateOnDay(firstDate, cfg().nextDayStartHour),
    totalTravelMin: 0,
    tightNights: 0,
    infeasibleNights: 0,
    matchCount: 0,
    mustAttendCount: 0,
    purchasedCount: 0,
    scoreSum: 0
  };
}

// Ausgangspunkt für den Folgetag: letztes Stadion des Tages bzw. die dafür eingetragene Übernachtung.
function overnightOrigin(trip, lastOfDay) {
  const override = trip.overnightOverrides[lastOfDay.id];
  return override
    ? { lat: override.lat, lng: override.lng, fromMatch: lastOfDay, viaOvernight: true }
    : { lat: lastOfDay.lat, lng: lastOfDay.lng, fromMatch: lastOfDay };
}

function requiredArrivalTime(match) {
  const arrBuffer = match.customArrivalBuffer ?? cfg().arrivalBufferMin;
  return new Date(new Date(`${match.date}T${match.time}`).getTime() - arrBuffer * 60000);
}

// Hängt einen Tag (gewählte Spielkette) an einen Planzustand an und liefert den neuen Zustand.
async function appendDay(planState, trip, date, chain, dropped, nextDate) {
  // Fahrzeit ab dem Ausgangspunkt (bei Folgetagen: ab dem letzten Stadion, inkl. Übernachtungsfahrt)
  const dayTravelMin = await computeDayTravelMin(chain, planState.currentLoc);

  // Nacht-Bewertung für das TATSÄCHLICH gewählte erste Spiel dieses Tages
  let tightAdd = 0, infeasibleAdd = 0;
  const origin = planState.currentLoc, from = origin.fromMatch;
  if (from && chain.length > 0 && from.date !== chain[0].date) {
    const f = await nightCheck(origin, chain[0]);
    if (!f.feasible) infeasibleAdd = 1;
    else if (f.extraMinutesUsed > 0) tightAdd = 1;
  }

  let nextLoc = planState.currentLoc, overnight = null;
  const lastOfDay = chain.length > 0 ? chain[chain.length - 1] : null;
  if (lastOfDay) {
    nextLoc = overnightOrigin(trip, lastOfDay);
    const override = trip.overnightOverrides[lastOfDay.id];
    overnight = {
      fromMatchId: lastOfDay.id, override: !!override,
      lat: nextLoc.lat, lng: nextLoc.lng, name: override ? override.address : lastOfDay.stadium
    };
  }

  return {
    dayChains: [...planState.dayChains, { date, chain, dropped, overnightAfter: overnight }],
    currentLoc: nextLoc,
    currentTime: nextDate ? timeToDateOnDay(nextDate, cfg().nextDayStartHour) : planState.currentTime,
    totalTravelMin: planState.totalTravelMin + dayTravelMin,
    tightNights: planState.tightNights + tightAdd,
    infeasibleNights: planState.infeasibleNights + infeasibleAdd,
    matchCount: planState.matchCount + chain.length,
    mustAttendCount: planState.mustAttendCount + chain.filter(m => m.mustAttend).length,
    purchasedCount: planState.purchasedCount + chain.filter(hasTickets).length,
    scoreSum: planState.scoreSum + chainScoreSum(chain)
  };
}

function primaryPlanDescription() {
  if (currentOptimizationMode === "groundhopper_score") return "Beste gefundene Kombination nach durchschnittlichem Groundhopper Score.";
  if (currentOptimizationMode === "balanced") return "Ausgewogene Kombination aus Spielanzahl (60 %) und Groundhopper Score (40 %).";
  return "Beste gefundene Kombination nach Tickets, Highlightspielen, Spielanzahl und Fahrzeit.";
}

// Blendet leere und fast leere Alternativen aus (Liste muss bereits nach Güte sortiert sein):
//  - Alternativen ohne Spiel,
//  - Alternativen mit weniger als MIN_PLAN_SHARE der Spiele der besten Alternative,
//  - Alternativen, deren Spiele komplett in einer besser bewerteten Alternative mit mehr Spielen enthalten sind.
// `keep` (z. B. der gerade ausgewählte Plan) bleibt immer erhalten.
function filterUsefulPlans(plans, keep = null) {
  const best = Math.max(0, ...plans.map(p => p.matchCount));
  const minCount = Math.ceil(best * MIN_PLAN_SHARE);
  const result = [];
  for (const p of plans) {
    const ids = p.selected.map(m => m.id);
    const dominated = result.some(q =>
      q.matchCount > p.matchCount && ids.every(id => q.selected.some(s => s.id === id)));
    const useful = p.matchCount > 0 && p.matchCount >= minCount && !dominated;
    if (useful || p === keep) result.push(p);
  }
  return result;
}

// Beschreibt Alternative 2..n als Unterschied zu Alternative 1.
function annotatePlanDiffs(plans) {
  plans.forEach((p, i) => {
    if (i === 0) {
      p.changedDates = [];
    } else {
      p.description = diffDescription(plans[0], p);
      p.changedDates = Array.from(changedDatesOf(plans[0], p));
    }
  });
}

// ---------- Gesamten Trip optimieren & Alternativen berechnen ----------
async function buildOptimizedScheduleAlternatives(trip) {
  const myRun = calcRunId;
  const eligible = planningMatches(trip);
  const byDate = new Map();
  eligible.forEach(m => {
    if (!byDate.has(m.date)) byDate.set(m.date, []);
    byDate.get(m.date).push(m);
  });
  const dates = [...byDate.keys()].sort();
  dates.forEach(d => byDate.get(d).sort((a, b) => a.time.localeCompare(b.time)));

  let beam = [initialPlanState(trip, dates[0])];

  for (let d = 0; d < dates.length; d++) {
    const date = dates[d];
    const dayMatches = byDate.get(date);
    const nextDate = dates[d + 1];
    const nextBeamMap = new Map();

    for (const beamState of beam) {
      if (myRun !== calcRunId) throw new Error("abgebrochen");
      const startLoc = beamState.currentLoc.fromMatch ? beamState.currentLoc : await homeStartLoc(trip, dayMatches);
      const dayCandidates = await generateDayCandidates(dayMatches, startLoc, beamState.currentTime);

      for (const cand of dayCandidates) {
        if (myRun !== calcRunId) throw new Error("abgebrochen");
        const newState = await appendDay(beamState, trip, date, cand.chain, cand.dropped, nextDate);
        const signature = planSignature(newState.dayChains);
        const existing = nextBeamMap.get(signature);
        if (!existing || comparePlans(newState, existing, eligible.length) < 0) {
          nextBeamMap.set(signature, newState);
        }
      }
    }

    const nextBeam = [...nextBeamMap.values()];
    const nextReferenceCount = Math.max(1, ...nextBeam.map(plan => plan.matchCount));
    nextBeam.sort((a, b) => comparePlans(a, b, nextReferenceCount));
    beam = nextBeam.slice(0, BEAM_WIDTH);
  }

  const finalized = beam.map(b => finalizePlanState(b, trip));
  const finalReferenceCount = Math.max(1, ...finalized.map(plan => plan.matchCount));
  finalized.sort((a, b) => comparePlans(a, b, finalReferenceCount));
  const diverse = filterUsefulPlans(finalized).slice(0, MAX_PLANS);

  if (diverse.length) diverse[0].description = primaryPlanDescription();
  annotatePlanDiffs(diverse);
  return diverse;
}

// ---------- Keine Tickets: Spiel aus einem Plan nehmen und nur die Lücke neu füllen ----------
// Alle übrigen Spiele des Plans bleiben unverändert. In die Lücke kommt die beste Kombination
// noch nicht eingeplanter Spiele desselben Tages, die zeitlich zwischen Vorgänger und Nachfolger
// passt (inkl. Übernachtungs-/Nachtfahrt-Prüfung zum nächsten Spieltag). Passt nichts, bleibt der Slot frei.
async function repairPlanWithoutMatch(plan, trip, removed, transferOverrides) {
  const dayChains = plan.dayChains.map(dc => ({
    ...dc,
    chain: [...dc.chain],
    dropped: dc.dropped.filter(d => d.match.id !== removed.id)
  }));
  const dayIdx = dayChains.findIndex(dc => dc.chain.some(m => m.id === removed.id));
  let note = null, replacement = [];

  if (dayIdx !== -1) {
    const dc = dayChains[dayIdx];
    const pos = dc.chain.findIndex(m => m.id === removed.id);
    const prev = dc.chain[pos - 1] || null;
    const next = dc.chain[pos + 1] || null;
    const morning = timeToDateOnDay(dc.date, cfg().nextDayStartHour);

    // Ausgangspunkt der Lücke: vorheriges Spiel desselben Tages, sonst Übernachtung des Vortags, sonst Start
    let startLoc, startTime;
    if (prev) {
      startLoc = { lat: prev.lat, lng: prev.lng };
      startTime = calculateMatchEndTime(prev);
    } else {
      const prevDc = dayChains.slice(0, dayIdx).reverse().find(x => x.chain.length > 0);
      startLoc = prevDc
        ? overnightOrigin(trip, prevDc.chain[prevDc.chain.length - 1])
        : await homeStartLoc(trip, planningMatches(trip).filter(m => m.date === dc.date));
      startTime = morning;
    }

    const nextDayFirst = next ? null
      : (dayChains.slice(dayIdx + 1).find(x => x.chain.length > 0) || { chain: [] }).chain[0] || null;
    const inPlan = new Set(dayChains.flatMap(x => x.chain.map(m => m.id)));
    const pool = planningMatches(trip)
      .filter(m => m.date === dc.date && !inPlan.has(m.id))
      .filter(m => (!prev || m.time > prev.time) && (!next || m.time < next.time))
      .sort((a, b) => a.time.localeCompare(b.time));

    // Eine für das entfernte Spiel eingetragene Übernachtung gilt (im aktiven Plan) für den Ersatz weiter.
    const removedOverride = !next && transferOverrides ? trip.overnightOverrides[removed.id] : null;

    // Lässt sich nach `last` der Rest des Plans noch erreichen?
    const fitsBefore = async last => {
      if (next) {
        const travel = await getCachedTravelMin(last.lat, last.lng, next.lat, next.lng);
        return new Date(calculateMatchEndTime(last).getTime() + travel * 60000) <= requiredArrivalTime(next);
      }
      if (!nextDayFirst) return true;
      const own = trip.overnightOverrides[last.id] || removedOverride;
      const origin = own
        ? { lat: own.lat, lng: own.lng, fromMatch: last, viaOvernight: true }
        : { lat: last.lat, lng: last.lng, fromMatch: last };
      return (await nightCheck(origin, nextDayFirst)).feasible;
    };

    if (pool.length > 0) {
      const dp = await computeDayDP(pool, startLoc, startTime);
      let bestIdx = -1;
      for (let j = 0; j < dp.length; j++) {
        if (!dp[j] || !(await fitsBefore(pool[j]))) continue;
        if (bestIdx === -1 || compareDpStates(dp[j], dp[bestIdx], pool.length)) bestIdx = j;
      }
      if (bestIdx !== -1) replacement = reconstructChain(dp, pool, bestIdx);
    }

    dc.chain.splice(pos, 1, ...replacement);
    const replacementIds = new Set(replacement.map(m => m.id));
    dc.dropped = dc.dropped.filter(d => !replacementIds.has(d.match.id));

    const label = `${formatDateShort(dc.date)}: ${shortMatchLabel(removed)} (keine Tickets)`;
    note = replacement.length
      ? `${label} → ersetzt durch ${replacement.map(shortMatchLabel).join(', ')}`
      : `${label} – kein passendes Ersatzspiel, der Slot bleibt frei`;

    // Übernachtungs-/Fahrtag-Adressen des entfernten Spiels auf das neue letzte Spiel des Tages übertragen
    const newLast = dc.chain[dc.chain.length - 1];
    if (transferOverrides && !next && newLast) {
      Object.entries({ ...trip.overnightOverrides }).forEach(([key, value]) => {
        let target = null;
        if (key === removed.id) target = newLast.id;
        else if (key.startsWith(`${removed.id}@`)) target = `${newLast.id}${key.slice(removed.id.length)}`;
        if (target && !trip.overnightOverrides[target]) trip.overnightOverrides[target] = { ...value };
      });
    }
  }

  // Kennzahlen (Fahrzeit, Nächte, Anzahl, Score) für den geänderten Plan neu berechnen
  let st = initialPlanState(trip, dayChains[0].date);
  for (let i = 0; i < dayChains.length; i++) {
    const dc = dayChains[i];
    st = await appendDay(st, trip, dc.date, dc.chain, dc.dropped, dayChains[i + 1] && dayChains[i + 1].date);
  }
  const repaired = finalizePlanState(st, trip);
  repaired.optimizationMode = plan.optimizationMode || currentOptimizationMode;
  repaired.description = plan.description;
  repaired.repairNotes = [...(plan.repairNotes || []), ...(note ? [note] : [])];
  return { plan: repaired, note, replacement, wasInPlan: dayIdx !== -1 };
}

let pendingPlanMessage = null; // einmalige Rückmeldung über dem Plan (z. B. nach "Keine Tickets")

async function markNoTickets(matchId) {
  const trip = getActiveTrip();
  const match = trip && trip.matches.find(m => m.id === matchId);
  if (!match) return;
  const hasPlans = !!(currentPlans && currentPlans.length && trip.startAddress);
  if (editingMatchId === matchId) resetMatchForm();
  match.ticketStatus = "no_tickets";
  saveLocalStorage();

  if (!hasPlans) {
    renderActiveTrip();
    return;
  }

  // Eine evtl. laufende Berechnung abbrechen – sie würde auf veralteten Daten beruhen.
  const myRun = ++calcRunId;
  const button = document.getElementById("calculateRouteButton");
  if (button) button.textContent = "Route berechnen";
  const switcherEl = document.getElementById("planSwitcher");
  if (switcherEl) switcherEl.insertAdjacentHTML("afterbegin", '<div class="info-banner">🔎 Suche Ersatz für das Spiel ohne Tickets …</div>');
  routingEstimated = false;

  try {
    const active = currentPlans[currentPlanIndex];
    const results = new Map();
    // Aktiver Plan zuerst: nur dort werden eingetragene Übernachtungen auf den Ersatz übertragen.
    for (const p of [active, ...currentPlans.filter(p => p !== active)]) {
      currentOptimizationMode = p.optimizationMode || trip.optimizationMode || "most_games";
      results.set(p, await repairPlanWithoutMatch(p, trip, match, p === active));
      if (myRun !== calcRunId) return; // neuere Berechnung hat übernommen
    }

    // Reihenfolge der Alternativen beibehalten, zusammengefallene Alternativen entfernen
    const activeSignature = results.get(active).plan.signature;
    const seen = new Set(), plans = [];
    for (const p of currentPlans) {
      const repaired = results.get(p).plan;
      if (seen.has(repaired.signature)) continue;
      seen.add(repaired.signature);
      plans.push(repaired);
    }
    currentOptimizationMode = active.optimizationMode || "most_games";
    const activeRepaired = plans.find(p => p.signature === activeSignature);
    plans.splice(0, plans.length, ...filterUsefulPlans(plans, activeRepaired));
    annotatePlanDiffs(plans);

    currentPlans = plans;
    trip.plans = plans;
    currentPlanIndex = Math.max(0, plans.findIndex(p => p.signature === activeSignature));
    trip.selectedPlanSignature = plans[currentPlanIndex].signature;
    saveLocalStorage();

    const activeResult = results.get(active);
    pendingPlanMessage = activeResult.wasInPlan
      ? (activeResult.replacement.length
        ? { type: "success", text: `✅ ${activeResult.note}` }
        : { type: "info", text: `ℹ️ ${activeResult.note}` })
      : { type: "info", text: `ℹ️ ${shortMatchLabel(match)} war in der aktiven Alternative nicht eingeplant – dort ändert sich nichts.` };
    await renderCurrentPlan();
  } catch (err) {
    console.error("Fehler bei der Ersatzsuche:", err);
    if (myRun === calcRunId) {
      pendingPlanMessage = { type: "danger", text: "❌ Bei der Ersatzsuche ist ein Fehler aufgetreten. Bitte „Route berechnen“ ausführen." };
      renderCurrentPlan();
    }
  }
}

// Kennzahlen, die vom Ticketstatus abhängen, ohne Neuberechnung aktualisieren.
function refreshPlanTicketCounts(trip) {
  if (!currentPlans) return;
  const eligible = planningMatches(trip);
  currentPlans.forEach(p => {
    p.purchasedCount = p.selected.filter(hasTickets).length;
    p.availableMatchCount = eligible.length;
    p.mustAttendTotal = eligible.filter(m => m.mustAttend).length;
  });
}

function setTicketStatus(matchId, status) {
  const trip = getActiveTrip();
  const match = trip && trip.matches.find(m => m.id === matchId);
  if (!match) return;
  match.ticketStatus = TICKET_STATUSES.includes(status) ? status : null;
  refreshPlanTicketCounts(trip);
  saveLocalStorage();
  if (currentPlans && currentPlans.length) renderCurrentPlan();
  else renderActiveTrip();
}

// ---------- Hauptberechnung ----------
async function calculateRoute() {
  const trip = getActiveTrip();
  const timelineEl = document.getElementById("timeline");
  const droppedEl = document.getElementById("droppedSection");
  const switcherEl = document.getElementById("planSwitcher");
  const button = document.getElementById("calculateRouteButton");

  if (!trip.startAddress || trip.matches.length === 0) {
    alert("Bitte gib eine Startadresse und mindestens ein Spiel ein.");
    return;
  }
  if (planningMatches(trip).length === 0) {
    alert("Alle Spiele sind als „Keine Tickets“ markiert – es gibt nichts zu berechnen.");
    return;
  }

  currentOptimizationMode = document.getElementById("optimizationMode")?.value || "most_games";
  trip.optimizationMode = currentOptimizationMode;

  const runId = ++calcRunId;
  if (button) button.textContent = "Berechne … (Klick = neu starten)";

  timelineEl.innerHTML = "Berechne optimale Route, Spiele-Anzahl und Alternativen...";
  droppedEl.innerHTML = "";
  if (switcherEl) switcherEl.innerHTML = "";
  routeLayer.clearLayers();
  routingEstimated = false;

  try {
    const plans = await buildOptimizedScheduleAlternatives(trip);
    if (runId !== calcRunId) return; // eine neuere Berechnung hat übernommen
    currentPlans = plans;

    if (!currentPlans || currentPlans.length === 0) {
      timelineEl.innerHTML = '<p class="placeholder-text">Kein Spiel konnte zeitlich eingeplant werden.</p>';
      lastSelectedMatchIds = new Set();
      updateMapMarkers();
      return;
    }

    // Alternativen auch im Trip-Objekt ablegen (inkl. Stand der Einstellungen für den Veraltet-Hinweis)
    trip.plans = currentPlans;
    trip.plansSettingsKey = JSON.stringify(cfg());

    let idx = 0;
    if (trip.selectedPlanSignature) {
      const found = currentPlans.findIndex(p => p.signature === trip.selectedPlanSignature);
      if (found !== -1) idx = found;
    }
    currentPlanIndex = idx;
    trip.selectedPlanSignature = currentPlans[currentPlanIndex].signature;
    saveLocalStorage();

    await renderCurrentPlan();
  } catch (err) {
    if (err && err.message === "abgebrochen") return; // neuere Berechnung läuft
    console.error("Berechnungsfehler:", err);
    if (runId === calcRunId) {
      timelineEl.innerHTML = '<div class="danger-banner">❌ Bei der Berechnung ist ein Fehler aufgetreten. Details stehen in der Browser-Konsole.</div>';
    }
  } finally {
    if (runId === calcRunId && button) button.textContent = "Route berechnen";
  }
}

function choosePlan(delta) {
  if (!currentPlans || currentPlans.length === 0) return;
  currentPlanIndex = (currentPlanIndex + delta + currentPlans.length) % currentPlans.length;

  const trip = getActiveTrip();
  if (trip) {
    trip.selectedPlanSignature = currentPlans[currentPlanIndex].signature;
    saveLocalStorage();
  }

  renderCurrentPlan();
}

async function renderCurrentPlan() {
  const trip = getActiveTrip();
  if (!trip || !currentPlans || currentPlans.length === 0) return;
  const plan = currentPlans[currentPlanIndex];

  lastSelectedMatchIds = new Set(plan.selected.map(m => m.id));
  updateMapMarkers();

  renderPlanSwitcher(plan);
  renderMatchList();
  await renderDayTiles(plan, trip);
}

function renderPlanSwitcher(plan) {
  const el = document.getElementById("planSwitcher");
  if (!el) return;

  const trip = getActiveTrip();
  const stale = trip && trip.plansSettingsKey && trip.plansSettingsKey !== JSON.stringify(cfg())
    ? '<div class="warning-banner">⚠️ Die Einstellungen wurden seit der letzten Berechnung geändert. Dieser Plan ist möglicherweise veraltet – bitte „Route berechnen" erneut ausführen.</div>'
    : '';

  let message = "";
  if (pendingPlanMessage) {
    const cls = { success: "success-banner", info: "info-banner", danger: "danger-banner" }[pendingPlanMessage.type] || "info-banner";
    message = `<div class="${cls}">${escapeHtml(pendingPlanMessage.text)}</div>`;
    pendingPlanMessage = null;
  }
  const header = stale + message;
  const notes = plan.repairNotes && plan.repairNotes.length
    ? `<details class="repair-notes"><summary>🎟️ Angepasst wegen fehlender Tickets (${plan.repairNotes.length})</summary><ul>${plan.repairNotes.map(n => `<li>${escapeHtml(n)}</li>`).join('')}</ul></details>`
    : '';

  if (!currentPlans || currentPlans.length <= 1) {
    el.innerHTML = header + `<div class="plan-switcher-single">${planStatsHtml(plan)}${notes}</div>`;
    return;
  }

  el.innerHTML = header + `
    <div class="plan-switcher">
      <button class="btn btn-small" onclick="choosePlan(-1)" aria-label="Vorherige Alternative">←</button>
      <div class="plan-switcher-info">
        <strong>Alternative ${currentPlanIndex + 1} / ${currentPlans.length}</strong>
        <div class="plan-description">${escapeHtml(plan.description)}</div>
        ${planStatsHtml(plan)}
        ${notes}
      </div>
      <button class="btn btn-small" onclick="choosePlan(1)" aria-label="Nächste Alternative">→</button>
    </div>
  `;
}

function planStatsHtml(plan) {
  const hrs = Math.floor(plan.totalTravelMin / 60);
  const mins = Math.round(plan.totalTravelMin % 60);
  const travelStr = `${hrs > 0 ? hrs + ' h ' : ''}${mins} Min.`;
  let nightWarn = "";
  if (plan.infeasibleNights > 0) {
    nightWarn = ` · <span style="color:#dc3545;">${plan.infeasibleNights} Übernachtung(en) eng/nicht machbar</span>`;
  } else if (plan.tightNights > 0) {
    nightWarn = ` · ${plan.tightNights} enge Nachtfahrt(en)`;
  }
  const mustLabel = plan.mustAttendTotal > 0 ? ` (${plan.mustAttendCount}/${plan.mustAttendTotal} ⭐)` : '';
  const trip = getActiveTrip();
  const ticketTotal = trip ? trip.matches.filter(hasTickets).length : 0;
  const ticketLabel = ticketTotal > 0 ? ` · 🎟️ ${plan.purchasedCount || 0}/${ticketTotal} mit Tickets` : '';
  const fallbackSum = (plan.selected || []).reduce((sum, match) => sum + groundhopperScore(match), 0);
  const scoreSum = Number.isFinite(plan.scoreSum) ? plan.scoreSum : fallbackSum;
  const averageScore = Math.round(plan.matchCount ? scoreSum / plan.matchCount : 0);
  const maxCount = Math.max(1, ...currentPlans.map(item => item.matchCount));
  const balanced = Math.round(0.6 * (plan.matchCount / maxCount) * 100 + 0.4 * averageScore);
  const modeExtra = plan.optimizationMode === "balanced" ? ` · ⚖️ Ausgewogen ${balanced}/100` : "";
  return `<div class="plan-stats">⚽ ${plan.matchCount} Spiele${mustLabel}${ticketLabel} · 🏆 Ø ${averageScore}/100${modeExtra} · 🚗 ca. ${travelStr}${nightWarn}<br><span class="optimization-mode-label">Berechnung: ${optimizationModeLabel(plan.optimizationMode)}</span></div>`;
}

async function renderDayTiles(plan, trip) {
  const timelineEl = document.getElementById("timeline");
  const droppedEl = document.getElementById("droppedSection");
  const myRun = ++renderRunId;
  routeLayer.clearLayers();

  let currentLoc = { lat: trip.startAddress.lat, lng: trip.startAddress.lng, name: trip.startAddress.address };
  let html = "";
  const allDropped = [];
  const drivenDates = new Set(); // Tage, die als Fahrtag gezeigt werden

  // Anreisetag: Ist das erste eingeplante Spiel nicht am selben Tag von zu Hause erreichbar,
  // wird am Vortag angereist (Übernachtung in Stadionnähe bzw. nach max. 12 h Fahrt).
  let arrivalDay = null;
  const firstDc = plan.dayChains.find(x => x.chain.length > 0);
  if (firstDc && !(await reachableSameDayFromHome(currentLoc, firstDc.chain[0]))) {
    const first = firstDc.chain[0];
    const date = addDaysIso(first.date, -1);
    const key = arrivalDayKey(first.date);
    const ov = trip.overnightOverrides[key];
    let to;
    if (ov) {
      to = { lat: ov.lat, lng: ov.lng, name: ov.address };
    } else {
      const route = await getCachedRoute(currentLoc.lat, currentLoc.lng, first.lat, first.lng, true);
      if (myRun !== renderRunId) return;
      if (route.durationMin <= DAILY_DRIVE_MIN) {
        to = { lat: first.lat, lng: first.lng, name: `Nähe ${first.stadium}` };
      } else {
        const p = findPointAtTime(route.steps, DAILY_DRIVE_MIN * 60) || {
          lat: currentLoc.lat + (first.lat - currentLoc.lat) * (DAILY_DRIVE_MIN / route.durationMin),
          lng: currentLoc.lng + (first.lng - currentLoc.lng) * (DAILY_DRIVE_MIN / route.durationMin)
        };
        const name = (await cachedReverseGeocode(p.lat, p.lng)) || `Ungefähr ${p.lat.toFixed(3)}, ${p.lng.toFixed(3)}`;
        to = { lat: p.lat, lng: p.lng, name };
      }
    }
    arrivalDay = { date, key, override: !!ov, from: { ...currentLoc }, to, label: "🧳 Anreisetag" };
    drivenDates.add(date);
  }
  let arrivalRendered = false;

  for (let d = 0; d < plan.dayChains.length; d++) {
    const dc = plan.dayChains[d];
    allDropped.push(...dc.dropped);

    if (arrivalDay && !arrivalRendered && dc.date >= arrivalDay.date) {
      const arrivalHtml = await renderJourneyTiles([arrivalDay], myRun);
      if (arrivalHtml === null) return;
      html += arrivalHtml;
      currentLoc = { ...arrivalDay.to };
      arrivalRendered = true;
    }
    if (dc.chain.length === 0 && drivenDates.has(dc.date)) continue;

    const dateLabel = formatDateLong(dc.date);
    const isChanged = currentPlanIndex !== 0 && plan.changedDates && (
      Array.isArray(plan.changedDates) ? plan.changedDates.includes(dc.date) : plan.changedDates.has(dc.date)
    );
    const changedBadge = isChanged
      ? '<span class="tile-changed-badge" title="Unterscheidet sich von Alternative 1">◆ geändert</span>'
      : '';

    let tileBody = "";

    if (dc.chain.length === 0) {
      tileBody = '<p class="placeholder-text">Kein Spiel eingeplant.</p>';
    }

    for (let i = 0; i < dc.chain.length; i++) {
      const match = dc.chain[i];
      const osrm = await getCachedRoute(currentLoc.lat, currentLoc.lng, match.lat, match.lng);
      if (myRun !== renderRunId) return;

      if (osrm.geometry) {
        L.geoJSON(osrm.geometry, { style: { color: '#1b4332', weight: 4 } }).addTo(routeLayer);
      }

      const kickOff = new Date(`${match.date}T${match.time}`);
      const arrBuffer = match.customArrivalBuffer ?? cfg().arrivalBufferMin;
      const targetArrival = new Date(kickOff.getTime() - arrBuffer * 60000);
      const departureTime = new Date(targetArrival.getTime() - osrm.durationMin * 60000);
      const depPrefix = departureTime.toDateString() !== kickOff.toDateString()
        ? departureTime.toLocaleDateString('de-DE', { weekday: 'short', day: '2-digit', month: '2-digit' }) + ', '
        : '';
      const deeplink = generateGoogleDeeplink(currentLoc.lat, currentLoc.lng, match.lat, match.lng);
      const leagueLabel = match.leagueName || getLeagueName(match.countryCode, match.leagueLevel);

      tileBody += `
        <div class="timeline-item">
          <strong>🚗 Fahrt nach ${escapeHtml(match.stadium)}</strong><br>
          Abfahrt: ${depPrefix}${departureTime.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} Uhr | Fahrzeit: ca. ${osrm.durationMin} Min.<br>
          Ankunft am Stadion: ${targetArrival.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} Uhr
          <br>
          <a href="${deeplink}" target="_blank" class="deeplink-btn">In Google Maps öffnen</a>
        </div>
        <div class="timeline-item match-item">
          <strong>⚽ ${escapeHtml(match.home)} vs. ${escapeHtml(match.away)}</strong> ${match.mustAttend ? '<span class="must-badge">⭐</span>' : ''}<span class="print-only-inline">${ticketBadgeHtml(match)}</span> (${matchContextLabel(match)})<br>
          ${scoreHtml(match)}<br>
          ${match.date} | Anstoß: ${match.time} Uhr | Stadion: ${escapeHtml(match.stadium)}${capacityHtml(match)}${match.clubWebsite ? `<br>${websiteLinkHtml(match)}` : ""}
          <div class="match-actions no-print">${ticketToggleHtml(match)}</div>
        </div>
      `;

      currentLoc = { lat: match.lat, lng: match.lng, name: match.stadium };
    }

    let journeyHtml = "";
    const nextDc = plan.dayChains.slice(d + 1).find(x => x.chain.length > 0);
    if (nextDc && dc.chain.length > 0) {
      const lastMatch = dc.chain[dc.chain.length - 1];
      const nextMatchGuess = nextDc.chain[0];

      const override = trip.overnightOverrides[lastMatch.id];
      const opPlan = await planOvernight(lastMatch, nextMatchGuess);
      // Machbarkeit wie in der Optimierung prüfen – inkl. eigener Übernachtungsadresse und gesetzter Fahrtag-Stopps
      const night = await nightCheck(overnightOrigin(trip, lastMatch), nextMatchGuess);
      if (myRun !== renderRunId) return;
      opPlan.feasible = night.feasible;
      opPlan.extraMinutesUsed = night.extraMinutesUsed;
      opPlan.missingMin = Math.round(night.missingMin || 0);
      const overnightLoc = override
        ? { lat: override.lat, lng: override.lng, name: override.address }
        : { lat: opPlan.overnightPoint.lat, lng: opPlan.overnightPoint.lng, name: opPlan.overnightPoint.suggestedName };

      // Abendfahrt zum Übernachtungsort auf der Karte einzeichnen
      if (overnightLoc.lat !== lastMatch.lat || overnightLoc.lng !== lastMatch.lng) {
        const evening = await getCachedRoute(lastMatch.lat, lastMatch.lng, overnightLoc.lat, overnightLoc.lng);
        if (myRun !== renderRunId) return;
        if (evening.geometry) L.geoJSON(evening.geometry, { style: { color: '#1b4332', weight: 4 } }).addTo(routeLayer);
      }

      // Freie Tage zwischen den Spielen: Anreise auf Fahrtage mit Zwischenstopps verteilen
      let drivingDays = [];
      if (opPlan.gapDays >= 2) {
        drivingDays = await planDrivingDays(overnightLoc, lastMatch, nextMatchGuess, trip);
        if (myRun !== renderRunId) return;
        journeyHtml = await renderJourneyTiles(drivingDays, myRun);
        if (journeyHtml === null) return;
        drivingDays.forEach(day => drivenDates.add(day.date));
      }
      const nextStop = drivingDays.length ? drivingDays[0].to : { lat: nextMatchGuess.lat, lng: nextMatchGuess.lng };

      let warningHtml = "";
      if (!opPlan.feasible) {
        warningHtml = `<div class="danger-banner">🚫 Zeitlich eng: Auch mit bis zu ${cfg().maxExtraNightDriveMin} Min. zusätzlicher Nachtfahrt fehlen ca. ${opPlan.missingMin} Minuten, um pünktlich zum nächsten Spiel zu kommen. Ggf. eines der beiden Spiele entfernen.</div>`;
      } else if (opPlan.extraMinutesUsed > 0) {
        warningHtml = `<div class="warning-banner">⚠️ Enges Zeitfenster: benötigt ca. ${opPlan.extraMinutesUsed} Min. mehr Nachtfahrt als in den Einstellungen als Standard hinterlegt.</div>`;
      }

      const legDeeplink1 = generateGoogleDeeplink(lastMatch.lat, lastMatch.lng, overnightLoc.lat, overnightLoc.lng);
      const legDeeplink2 = generateGoogleDeeplink(overnightLoc.lat, overnightLoc.lng, nextStop.lat, nextStop.lng);
      const hotelLink = generateHotelSearchLink(overnightLoc.lat, overnightLoc.lng);
      const inputId = `overnightInput_${lastMatch.id}`;

      const free = opPlan.gapDays - 1;
      const nightText = opPlan.gapDays >= 2
        ? `Zwischen den Spielen ${free === 1 ? "liegt 1 freier Tag" : `liegen ${free} freie Tage`} – ${drivingDays.length
            ? `die Anreise ist auf ${drivingDays.length} Fahrtag${drivingDays.length === 1 ? "" : "e"} verteilt (siehe unten).`
            : "die Anreise ist ohne Nachtfahrt möglich."}`
        : override
          ? `Eigene Übernachtungsadresse – Weiterfahrt am nächsten Morgen ab ${cfg().nextDayStartHour} Uhr.`
          : `Vorschlag: ca. ${opPlan.eveningDriveMin} Min. noch am Abend fahren, Rest am nächsten Morgen ab ${cfg().nextDayStartHour} Uhr.`;

      tileBody += `
        <div class="timeline-item overnight-block">
          <h4>🌙 Übernachtung erforderlich</h4>
          <p class="print-only"><strong>Adresse:</strong> ${escapeHtml(overnightLoc.name)}</p>
          ${warningHtml}
          <p>${nightText}</p>
          ${override ? '' : `<p><em>Automatischer Vorschlag – bitte Verfügbarkeit von Hotels/Unterkünften vor Ort kurz prüfen.</em></p>`}
          <div class="form-row">
            <input type="text" id="${inputId}" placeholder="Übernachtungsadresse" value="${escapeHtml(overnightLoc.name)}" />
            <button class="btn btn-small" onclick="saveOvernightOverride('${lastMatch.id}', '${inputId}')">Übernehmen</button>
            ${override ? `<button class="btn btn-small btn-secondary" onclick="clearOvernightOverride('${lastMatch.id}')">Vorschlag zurücksetzen</button>` : ''}
          </div>
          <a href="${legDeeplink1}" target="_blank" class="deeplink-btn">🗺️ Zur Übernachtung</a>
          <a href="${hotelLink}" target="_blank" class="deeplink-btn hotel-btn">🏨 Unterkünfte hier suchen</a>
          <a href="${legDeeplink2}" target="_blank" class="deeplink-btn">🗺️ ${drivingDays.length ? "Weiter zum ersten Stopp" : "Weiter zum nächsten Stadion"}</a>
        </div>
      `;

      L.marker([overnightLoc.lat, overnightLoc.lng])
        .bindPopup(`<b>🌙 Übernachtung</b><br>${escapeHtml(overnightLoc.name)}`)
        .addTo(routeLayer);

      currentLoc = drivingDays.length
        ? { ...drivingDays[drivingDays.length - 1].to }
        : { lat: overnightLoc.lat, lng: overnightLoc.lng, name: overnightLoc.name };
    }

    html += `
      <div class="day-tile">
        <div class="day-tile-header">
          <h3>${dateLabel}</h3>
          ${changedBadge}
        </div>
        <div class="day-tile-body">${tileBody}</div>
      </div>
    `;
    html += journeyHtml;
  }

  if (myRun !== renderRunId) return;
  const routingWarning = routingEstimated
    ? '<div class="warning-banner">⚠️ Der Routing-Dienst war nicht erreichbar oder lieferte keine Route – einige Fahrzeiten sind geschätzt (Luftlinie × 1,3, ca. 75 km/h). Bitte später neu berechnen.</div>'
    : '';
  timelineEl.innerHTML = routingWarning + (html || '<p class="placeholder-text">Kein Spiel konnte zeitlich eingeplant werden.</p>');

  // Spiele ohne Tickets sind nicht Teil der Berechnung; sie werden separat aufgeführt.
  const visibleDropped = allDropped.filter(dd => !hasNoTickets(dd.match));
  const noTickets = trip.matches.filter(hasNoTickets);
  const droppedLine = (m, reasonHtml) => `
          <div class="dropped-match">
            ${escapeHtml(m.home)} vs. ${escapeHtml(m.away)} – ${m.date} ${m.time} Uhr (${escapeHtml(m.leagueName || getLeagueName(m.countryCode, m.leagueLevel))})
            ${reasonHtml}
          </div>`;
  let droppedHtml = "";
  if (visibleDropped.length > 0) {
    droppedHtml += `
      <div class="dropped-section">
        <h3>Aussortierte Spiele (${visibleDropped.length})</h3>
        ${visibleDropped.map(dd => droppedLine(dd.match, `<span class="reason">Grund: ${escapeHtml(dd.reason)}</span>`)).join('')}
      </div>`;
  }
  if (noTickets.length > 0) {
    droppedHtml += `
      <div class="dropped-section no-tickets-section">
        <h3>🚫 Keine Tickets bekommen (${noTickets.length})</h3>
        ${noTickets.map(m => droppedLine(m, `<div class="no-print">${ticketToggleHtml(m)}</div>`)).join('')}
      </div>`;
  }
  droppedEl.innerHTML = droppedHtml;
}

// ---------- Settings Modal ----------
function toggleSettingsModal() {
  const modal = document.getElementById("settingsModal");
  if (modal.style.display === "flex") {
    modal.style.display = "none";
    return;
  }
  const settings = cfg();
  const set = (id, value) => { document.getElementById(id).value = value; };
  set("settingArrivalBuffer", settings.arrivalBufferMin);
  set("settingDepartureBuffer", settings.departureBufferMin);
  set("settingHalfTime", settings.halfTimeMin);
  set("settingStoppageTime", settings.stoppageTimeMin);
  set("settingMaxNightDrive", settings.maxNightDriveTime);
  set("settingNextDayStart", settings.nextDayStartHour);
  set("settingMaxExtraNightDrive", settings.maxExtraNightDriveMin);
  const weights = settings.groundhopperWeights || DEFAULT_WEIGHTS;
  set("weightHighlight", weights.highlight);
  set("weightStage", weights.stage);
  set("weightCompetition", weights.competition);
  set("weightStadium", weights.stadium);
  updateWeightShares();
  modal.style.display = "flex";
  modal.querySelector(".modal-body").scrollTop = 0;
}

// Zeigt neben jeder Gewichtung den tatsächlichen Anteil in Prozent
function updateWeightShares() {
  const ids = ["weightHighlight", "weightStage", "weightCompetition", "weightStadium"];
  const values = ids.map(id => Math.max(0, parseFloat(document.getElementById(id).value) || 0));
  const sum = values.reduce((a, b) => a + b, 0);
  ids.forEach((id, i) => {
    const el = document.querySelector(`[data-share-for="${id}"]`);
    if (el) el.textContent = sum ? `${Math.round(values[i] / sum * 100)} %` : "–";
  });
}

document.addEventListener("keydown", e => {
  const modal = document.getElementById("settingsModal");
  if (e.key === "Escape" && modal && modal.style.display === "flex") toggleSettingsModal();
});

function saveSettings() {
  const settings = cfg(); // Einstellungen des aktiven Trips
  const num = (id, fallback) => { const v = parseInt(document.getElementById(id).value, 10); return Number.isFinite(v) && v >= 0 ? v : fallback; };
  const time = (id, fallback) => document.getElementById(id).value || fallback;
  const weight = id => Math.max(0, parseFloat(document.getElementById(id).value) || 0);

  settings.arrivalBufferMin = num("settingArrivalBuffer", settings.arrivalBufferMin);
  settings.departureBufferMin = num("settingDepartureBuffer", settings.departureBufferMin);
  settings.halfTimeMin = num("settingHalfTime", settings.halfTimeMin);
  settings.stoppageTimeMin = num("settingStoppageTime", settings.stoppageTimeMin);
  settings.maxNightDriveTime = time("settingMaxNightDrive", settings.maxNightDriveTime);
  settings.nextDayStartHour = time("settingNextDayStart", settings.nextDayStartHour);
  settings.maxExtraNightDriveMin = num("settingMaxExtraNightDrive", settings.maxExtraNightDriveMin);
  settings.groundhopperWeights = {
    highlight: weight("weightHighlight"), stage: weight("weightStage"),
    competition: weight("weightCompetition"), stadium: weight("weightStadium")
  };

  saveLocalStorage();
  if (currentPlans && currentPlans[currentPlanIndex]) renderPlanSwitcher(currentPlans[currentPlanIndex]);
  toggleSettingsModal();
}

// ---------- Export & Import ----------

// 1. Aktiven Trip inkl. aller Trip-Alternativen als JSON-Datei herunterladen
function exportActiveTrip() {
  const trip = getActiveTrip();
  if (!trip) {
    alert("Kein aktiver Trip zum Exportieren vorhanden.");
    return;
  }

  // Aktuell berechnete Alternativen am Trip verankern
  if (currentPlans && currentPlans.length > 0) {
    trip.plans = currentPlans;
  }

  const exportData = {
    type: "groundhopping_trip",
    version: 1,
    exportedAt: new Date().toISOString(),
    settings: cfg(), // zusätzlich auf oberster Ebene für ältere Versionen der App
    trip: serializeTrip(trip) // Pläne kompakt (Spiele als ID-Verweise); der Import versteht beide Formate
  };

  const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(exportData, null, 2));
  const downloadAnchor = document.createElement('a');
  const safeFileName = trip.name.replace(/[^a-z0-9]/gi, '_').toLowerCase();

  downloadAnchor.setAttribute("href", dataStr);
  downloadAnchor.setAttribute("download", `${safeFileName}_trip.json`);
  document.body.appendChild(downloadAnchor);
  downloadAnchor.click();
  downloadAnchor.remove();
}

// 2. Datei-Auswahldialog öffnen
function triggerImportTrip() {
  const fileInput = document.getElementById("importTripInput");
  if (fileInput) fileInput.click();
}

// 3. JSON-Datei einlesen und Trip inkl. Alternativen importieren
function importTrip(event) {
  const file = event.target.files[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = function (e) {
    try {
      const importedData = JSON.parse(e.target.result);
      const result = normalizeImportedTrip(
        importedData && importedData.trip ? importedData.trip : importedData,
        importedData && importedData.plans,
        importedData && importedData.settings
      );
      if (!result) {
        alert("Ungültiges Dateiformat oder keine gültigen Spiele. Bitte wähle eine gültige Groundhopping JSON-Datei.");
        return;
      }

      const importedTrip = result.trip;
      importedTrip.name += " (Importiert)";
      state.trips.push(importedTrip);
      state.activeTripId = importedTrip.id;


      saveLocalStorage();
      renderTripSelect();
      resetMatchForm();
      renderActiveTrip();

      alert(`Trip "${importedTrip.name}" wurde erfolgreich importiert!` +
        (result.skipped ? `\n${result.skipped} Spiel(e) mit ungültigen Daten wurden übersprungen.` : ""));
    } catch (err) {
      console.error("Import-Fehler:", err);
      alert("Fehler beim Importieren. Die Datei ist beschädigt oder kein gültiges JSON.");
    } finally {
      event.target.value = "";
    }
  };

  reader.readAsText(file);
}

function updateMapMarkers() {
  const trip = getActiveTrip();
  if (!trip) return;

  markersLayer.clearLayers();

  if (trip.startAddress) {
    L.marker([trip.startAddress.lat, trip.startAddress.lng])
      .bindPopup(`<b>Startpunkt:</b> ${escapeHtml(trip.startAddress.address)}`)
      .addTo(markersLayer);
  }

  const toggleEl = document.getElementById("showOnlySelectedToggle");
  const filterActive = toggleEl ? toggleEl.checked : false;

  trip.matches.forEach(m => {
    if (filterActive && lastSelectedMatchIds && !lastSelectedMatchIds.has(m.id)) {
      return;
    }

    const marker = L.marker([m.lat, m.lng], {
      icon: createCrestIcon(m.home, m.away, m.homeLogo, m.awayLogo),
      opacity: hasNoTickets(m) ? 0.4 : 1 // Spiele ohne Tickets abgeschwächt darstellen
    }).addTo(markersLayer);

    marker.bindPopup(matchPopupHtml(m));

    marker.on('popupopen', async () => {
      if (!m.resolvedAddress && m.stadium) {
        const coords = await geocodeAddress(m.stadium);
        if (coords && coords.display) {
          m.resolvedAddress = coords.display;
          saveLocalStorage();
          marker.getPopup().setContent(matchPopupHtml(m));
        }
      }
    });
  });
}
