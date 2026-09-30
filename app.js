let state = {
  activeTripId: null,
  settings: {
    arrivalBufferMin: 30,
    departureBufferMin: 30,
    halfTimeMin: 15,
    stoppageTimeMin: 10,
    maxNightDriveTime: "22:00",
    nextDayStartHour: "08:00",
    maxExtraNightDriveMin: 120
  },
  trips: []
};

let map, markersLayer, routeLayer;
let travelCache = new Map();
let editingMatchId = null;
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
  const data = localStorage.getItem("groundhopping_data");
  if (data) {
    const parsed = JSON.parse(data);
    state = { ...state, ...parsed, settings: { ...state.settings, ...parsed.settings } };
  }
}

function saveLocalStorage() {
  localStorage.setItem("groundhopping_data", JSON.stringify(state));
}

function getActiveTrip() {
  return state.trips.find(t => t.id === state.activeTripId);
}

// ---------- Trip-Verwaltung ----------
function createNewTrip(defaultName = null) {
  const name = defaultName || prompt("Name des neuen Trips:", "Neuer Trip");
  if (!name) return;

  const newTrip = {
    id: "trip_" + Date.now(),
    name: name,
    startAddress: null,
    matches: [],
    overnightOverrides: {},
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
    const response = await fetch(url);
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
    const res = await fetch(url);
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
      const res = await fetch(url);
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
    const res = await fetch(url);
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
    const res = await fetch(url);
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

// ---------- Match Handling ----------
async function addMatch(e) {
  e.preventDefault();
  const trip = getActiveTrip();
  if (!trip) return;

  const stadiumAddr = document.getElementById("stadiumAddress").value;
  const leagueLevel = parseInt(document.getElementById("leagueLevel").value);

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
    leagueLevel: leagueLevel,
    countryCode: coords.countryCode,
    leagueName: getLeagueName(coords.countryCode, leagueLevel),
    date: document.getElementById("matchDate").value,
    time: document.getElementById("matchTime").value,
    stadium: stadiumAddr,
    resolvedAddress: coords.display,
    lat: coords.lat,
    lng: coords.lng,
    mustAttend: document.getElementById("mustAttend").checked,
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
  document.getElementById("leagueLevel").value = match.leagueLevel || 1;
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
  
  delete trip.plans;
  currentPlans = null;

  saveLocalStorage();
  renderActiveTrip();
}

// ---------- Crest Marker ----------
function createCrestIcon(home, away, homeLogo, awayLogo) {
  const cleanHomeLogo = homeLogo ? homeLogo.replace(/\\/g, '') : '';
  const cleanAwayLogo = awayLogo ? awayLogo.replace(/\\/g, '') : '';

  const homeContent = cleanHomeLogo
    ? `<img src="${cleanHomeLogo}" alt="${escapeHtml(home)}"/>`
    : `<span class="badge">${escapeHtml(home.substring(0, 3).toUpperCase())}</span>`;

  const awayContent = cleanAwayLogo
    ? `<img src="${cleanAwayLogo}" alt="${escapeHtml(away)}"/>`
    : `<span class="badge">${escapeHtml(away.substring(0, 3).toUpperCase())}</span>`;

  return L.divIcon({
    className: 'custom-crest-marker-wrapper',
    html: `<div class="match-crest-marker">${homeContent} <span class="colon">:</span> ${awayContent}</div>`,
    iconSize: [80, 30],
    iconAnchor: [40, 15]
  });
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.innerText = str;
  return div.innerHTML;
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
  if (!m.clubWebsite) return "";
  return `<a class="club-website-link ${className}" href="${escapeHtml(m.clubWebsite)}" target="_blank" rel="noopener noreferrer">🎟️ Vereinswebsite / Tickets</a>`;
}

function capacityHtml(m) {
  return m.stadiumCapacity ? ` · ${Number(m.stadiumCapacity).toLocaleString("de-DE")} Plätze` : "";
}

function matchPopupHtml(m) {
  const fullAddress = m.resolvedAddress ? `<br>📍 <small style="color:#555;">${escapeHtml(m.resolvedAddress)}</small>` : '';

  return `<b>${escapeHtml(m.home)} vs. ${escapeHtml(m.away)}</b>${m.mustAttend ? ' <span class="must-badge">⭐</span>' : ''}<br>
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

      if (totalPlans > 0) {
        const plansWithMatch = [];
        currentPlans.forEach((p, idx) => {
          if (p.selected.some(sm => sm.id === m.id)) {
            plansWithMatch.push(idx + 1);
          }
        });

        if (plansWithMatch.length === totalPlans) {
          // In JEDER Alternative enthalten -> Dunkelgrün
          statusClass = "status-selected";
          reasonHtml = `<div class="reason alt-reason" style="color:#1b4332; font-weight:600;">In allen Alternativen enthalten</div>`;
        } else if (plansWithMatch.length > 0) {
          // Nur in EINZELNEN Alternativen enthalten -> Helles Grün
          statusClass = "status-alternative";
          const isCurrent = plansWithMatch.includes(currentPlanIndex + 1);
          reasonHtml = `<div class="reason alt-reason">In Alternative ${plansWithMatch.join(', ')} enthalten${isCurrent ? ' (in aktiver Ansicht)' : ''}</div>`;
        } else {
          // In KEINER Alternative enthalten -> Aussortiert
          statusClass = "status-dropped";
          const reason = droppedReasons.get(m.id) || "In keiner Alternative enthalten.";
          reasonHtml = `<div class="reason" style="text-decoration:none;">${escapeHtml(reason)}</div>`;
        }
      }

      return `
    <li class="card match-list-item ${statusClass}" style="margin-bottom:0.5rem; padding:0.75rem;">
      <strong>${escapeHtml(m.home)} vs. ${escapeHtml(m.away)}</strong> ${m.mustAttend ? '<span class="must-badge">⭐</span>' : ''}<br>
      ${escapeHtml(m.leagueName || getLeagueName(m.countryCode, m.leagueLevel))}<br>
      📅 ${m.date} - ⏰ ${m.time} Uhr<br>
      📍 ${escapeHtml(m.stadium)}${capacityHtml(m)}
      ${m.clubWebsite ? `<br>${websiteLinkHtml(m)}` : ""}
      ${reasonHtml}
      <div style="margin-top:0.4rem; display:flex; gap:0.4rem;">
        <button onclick="editMatch('${m.id}')" class="btn btn-small">Bearbeiten</button>
        <button onclick="deleteMatch('${m.id}')" class="btn btn-small" style="color:red;">Löschen</button>
      </div>
    </li>
  `;
    }).join('');
}

// ---------- OSRM Routing ----------
async function getOSRMRoute(startLat, startLng, endLat, endLng, withSteps = false) {
  const stepsParam = withSteps ? "&steps=true" : "";
  const url = `https://router.project-osrm.org/route/v1/driving/${startLng},${startLat};${endLng},${endLat}?overview=full&geometries=geojson${stepsParam}`;
  try {
    const res = await fetch(url);
    const data = await res.json();
    if (data.routes && data.routes.length > 0) {
      const route = data.routes[0];
      return {
        durationMin: Math.round(route.duration / 60),
        geometry: route.geometry,
        steps: withSteps && route.legs && route.legs[0] ? route.legs[0].steps : null
      };
    }
  } catch (err) {
    console.error("OSRM Error:", err);
  }
  return { durationMin: 60, geometry: null, steps: null };
}

async function getCachedTravelMin(lat1, lng1, lat2, lng2) {
  const key = `${lat1.toFixed(4)},${lng1.toFixed(4)}|${lat2.toFixed(4)},${lng2.toFixed(4)}`;
  if (travelCache.has(key)) return travelCache.get(key);
  const result = await getOSRMRoute(lat1, lng1, lat2, lng2);
  travelCache.set(key, result.durationMin);
  return result.durationMin;
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
  const depBuffer = match.customDepartureBuffer ?? state.settings.departureBufferMin;
  const totalDurationMin = 90 + state.settings.halfTimeMin + state.settings.stoppageTimeMin + depBuffer;
  return new Date(kickOff.getTime() + totalDurationMin * 60000);
}

function timeToDateOnDay(dateStr, timeStr) {
  const [h, m] = timeStr.split(":").map(Number);
  const d = new Date(`${dateStr}T00:00:00`);
  d.setHours(h, m, 0, 0);
  return d;
}

function priorityScore(m) { return groundhopperScore(m); }
function compareDpStates(candidate,current,ref){
 if(!current)return true;const ca=candidate.count?candidate.score/candidate.count:0,cu=current.count?current.score/current.count:0;
 if(currentOptimizationMode==="groundhopper_score"){if(ca!==cu)return ca>cu;if(candidate.count!==current.count)return candidate.count>current.count;}
 else if(currentOptimizationMode==="balanced"){const cb=.6*(candidate.count/Math.max(1,ref))*100+.4*ca,ub=.6*(current.count/Math.max(1,ref))*100+.4*cu;if(cb!==ub)return cb>ub;if(candidate.count!==current.count)return candidate.count>current.count;}
 else{if(candidate.count!==current.count)return candidate.count>current.count;if(candidate.score!==current.score)return candidate.score>current.score;}return false;
}

// ---------- Dynamic Programming ----------
async function computeDayDP(segment, startLoc, startTime) {
  const n = segment.length;
  const dp = new Array(n).fill(null);

  for (let j = 0; j < n; j++) {
    const m = segment[j];
    const arrBuffer = m.customArrivalBuffer ?? state.settings.arrivalBufferMin;
    const kickoff = new Date(`${m.date}T${m.time}`);
    const requiredArrival = new Date(kickoff.getTime() - arrBuffer * 60000);

    let best = null;

    const travelFromStart = await getCachedTravelMin(startLoc.lat, startLoc.lng, m.lat, m.lng);
    const earliestFromStart = new Date(startTime.getTime() + travelFromStart * 60000);
    if (earliestFromStart <= requiredArrival) {
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
    const isRealMustAttend = !!forcedMatch.mustAttend;
    const segment = dayMatches.slice(cursor, mustIdx + 1);
    const { chain: segChain, usedIndices, reachable } = await bestChainEndingAtLast(segment, currentLoc, currentTime);

    if (!reachable) {
      dropped.push({
        match: forcedMatch,
        reason: isRealMustAttend
          ? "Highlightspiel zeitlich nicht erreichbar – bitte Reisezeit/Puffer oder andere Spiele prüfen."
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
              ? "Zeitlich nicht mit der Tagesauswahl vereinbar (Highlightspiel hat Vorrang)."
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
async function planOvernight(prevMatch, nextMatch) {
  const prevEnd = calculateMatchEndTime(prevMatch);
  const nextKickoff = new Date(`${nextMatch.date}T${nextMatch.time}`);
  const arrBuffer = nextMatch.customArrivalBuffer ?? state.settings.arrivalBufferMin;
  const requiredArrival = new Date(nextKickoff.getTime() - arrBuffer * 60000);

  const osrm = await getOSRMRoute(prevMatch.lat, prevMatch.lng, nextMatch.lat, nextMatch.lng, true);
  const totalTravelMin = osrm.durationMin;

  const nightCutoff = timeToDateOnDay(prevMatch.date, state.settings.maxNightDriveTime);
  const morningStart = timeToDateOnDay(nextMatch.date, state.settings.nextDayStartHour);

  function computeFeasibility(cutoffTime) {
    const availableEveningMin = Math.max(0, (cutoffTime - prevEnd) / 60000);
    const availableMorningMin = Math.max(0, (requiredArrival - morningStart) / 60000);
    const eveningDriveMin = Math.min(availableEveningMin, Math.max(0, totalTravelMin - availableMorningMin));
    const feasible = totalTravelMin <= (availableEveningMin + availableMorningMin);
    const missingMin = Math.max(0, totalTravelMin - (availableEveningMin + availableMorningMin));
    return { eveningDriveMin, feasible, missingMin };
  }

  let result = computeFeasibility(nightCutoff);
  let extraMinutesUsed = 0;

  if (!result.feasible) {
    const maxExtra = state.settings.maxExtraNightDriveMin ?? 120;
    for (let extra = 15; extra <= maxExtra; extra += 15) {
      const extendedCutoff = new Date(nightCutoff.getTime() + extra * 60000);
      const r = computeFeasibility(extendedCutoff);
      result = r;
      extraMinutesUsed = extra;
      if (r.feasible) break;
    }
  }

  let overnightPoint = null;
  if (result.eveningDriveMin > 1) {
    const targetSec = result.eveningDriveMin * 60;
    const coord = findPointAtTime(osrm.steps, targetSec);
    if (coord) {
      const placeName = await reverseGeocode(coord.lat, coord.lng, 10);
      overnightPoint = {
        lat: coord.lat,
        lng: coord.lng,
        suggestedName: placeName || `Ungefähr ${coord.lat.toFixed(3)}, ${coord.lng.toFixed(3)}`
      };
    }
  } else {
    overnightPoint = { lat: prevMatch.lat, lng: prevMatch.lng, suggestedName: prevMatch.stadium };
  }

  return {
    feasible: result.feasible,
    extraMinutesUsed,
    missingMin: Math.round(result.missingMin || 0),
    eveningDriveMin: Math.round(result.eveningDriveMin),
    totalTravelMin,
    overnightPoint
  };
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
  dayMatches.forEach((m, i) => { if (m.mustAttend) trueMustIndices.push(i); });

  const base = await chainWithForcedIndices(dayMatches, trueMustIndices, startLoc, startTime);
  const seen = new Map();
  seen.set(dayChainSignature(base.chain), base);

  for (const d of base.dropped) {
    if (d.match.mustAttend) continue;
    const idx = dayMatches.indexOf(d.match);
    if (idx === -1) continue;
    const alt = await chainWithForcedIndices(dayMatches, [...trueMustIndices, idx], startLoc, startTime);
    const sig = dayChainSignature(alt.chain);
    if (!seen.has(sig)) seen.set(sig, alt);
  }

  for (const m of base.chain) {
    if (m.mustAttend) continue;
    const filtered = dayMatches.filter(x => x.id !== m.id);
    const remappedMust = [];
    filtered.forEach((x, i) => { if (x.mustAttend) remappedMust.push(i); });
    const alt = await chainWithForcedIndices(filtered, remappedMust, startLoc, startTime);
    const sig = dayChainSignature(alt.chain);
    if (!seen.has(sig)) seen.set(sig, alt);
  }

  const candidates = [...seen.values()];

  candidates.sort((a, b) => {
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

function comparePlans(a,b,referenceCount=null){
 if(a.infeasibleNights!==b.infeasibleNights)return a.infeasibleNights-b.infeasibleNights;
 if(a.mustAttendCount!==b.mustAttendCount)return b.mustAttendCount-a.mustAttendCount;
 const ref=Math.max(1,referenceCount||a.availableMatchCount||b.availableMatchCount||a.matchCount||b.matchCount),avgA=a.matchCount?(a.scoreSum||0)/a.matchCount:0,avgB=b.matchCount?(b.scoreSum||0)/b.matchCount:0;
 if(currentOptimizationMode==="groundhopper_score"){if(avgA!==avgB)return avgB-avgA;if(a.matchCount!==b.matchCount)return b.matchCount-a.matchCount;}
 else if(currentOptimizationMode==="balanced"){const A=.6*(a.matchCount/ref)*100+.4*avgA,B=.6*(b.matchCount/ref)*100+.4*avgB;if(A!==B)return B-A;if(a.matchCount!==b.matchCount)return b.matchCount-a.matchCount;}
 else{if(a.matchCount!==b.matchCount)return b.matchCount-a.matchCount;if((a.scoreSum||0)!==(b.scoreSum||0))return (b.scoreSum||0)-(a.scoreSum||0);}
 if(a.tightNights!==b.tightNights)return a.tightNights-b.tightNights;return a.totalTravelMin-b.totalTravelMin;
}

function finalizePlanState(beamState, trip) {
  const selected = [];
  const dropped = [];
  beamState.dayChains.forEach(dc => {
    selected.push(...dc.chain);
    dropped.push(...dc.dropped);
  });
  const mustAttendTotal = trip.matches.filter(m => m.mustAttend).length;
  const signature = beamState.dayChains.map(dc => dayChainSignature(dc.chain)).join('|');

  return {
    dayChains: beamState.dayChains,
    selected,
    dropped,
    totalTravelMin: beamState.totalTravelMin,
    tightNights: beamState.tightNights,
    infeasibleNights: beamState.infeasibleNights,
    matchCount: beamState.matchCount,
    mustAttendCount: beamState.mustAttendCount,
    mustAttendTotal,
    scoreSum: beamState.scoreSum || selected.reduce((sum, match) => sum + groundhopperScore(match), 0),
    averageGroundhopperScore: selected.length ? (beamState.scoreSum || selected.reduce((sum, match) => sum + groundhopperScore(match), 0)) / selected.length : 0,
    availableMatchCount: trip.matches.length,
    optimizationMode: currentOptimizationMode,
    signature
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

// ---------- Gesamten Trip optimieren & Alternativen berechnen ----------
async function buildOptimizedScheduleAlternatives(trip) {
  const byDate = new Map();
  trip.matches.forEach(m => {
    if (!byDate.has(m.date)) byDate.set(m.date, []);
    byDate.get(m.date).push(m);
  });
  const dates = [...byDate.keys()].sort();
  dates.forEach(d => byDate.get(d).sort((a, b) => a.time.localeCompare(b.time)));

  let beam = [{
    dayChains: [],
    currentLoc: { lat: trip.startAddress.lat, lng: trip.startAddress.lng },
    currentTime: new Date(`${dates[0]}T00:00:00`),
    totalTravelMin: 0,
    tightNights: 0,
    infeasibleNights: 0,
    matchCount: 0,
    mustAttendCount: 0,
    scoreSum: 0,
    availableMatchCount: trip.matches.length
  }];

  for (let d = 0; d < dates.length; d++) {
    const date = dates[d];
    const dayMatches = byDate.get(date);
    const nextDate = dates[d + 1];
    const nextDayMatches = nextDate ? byDate.get(nextDate) : null;

    const nextBeamMap = new Map();

    for (const beamState of beam) {
      const dayCandidates = await generateDayCandidates(dayMatches, beamState.currentLoc, beamState.currentTime);

      for (const cand of dayCandidates) {
        const dayTravelMin = await computeDayTravelMin(cand.chain, beamState.currentLoc);

        let overnight = null;
        let nextLoc = beamState.currentLoc;
        let nextTime = beamState.currentTime;
        let transitionTravelMin = 0;
        let tightAdd = 0;
        let infeasibleAdd = 0;

        if (nextDayMatches) {
          const lastOfDay = cand.chain.length > 0 ? cand.chain[cand.chain.length - 1] : null;
          const nextGuess = nextDayMatches[0];

          if (lastOfDay && nextGuess) {
            const override = trip.overnightOverrides[lastOfDay.id];
            const plan = await planOvernight(lastOfDay, nextGuess);
            transitionTravelMin = plan.totalTravelMin;
            if (!plan.feasible) infeasibleAdd = 1;
            else if (plan.extraMinutesUsed > 0) tightAdd = 1;

            if (override) {
              nextLoc = { lat: override.lat, lng: override.lng };
              overnight = { fromMatchId: lastOfDay.id, override: true, lat: override.lat, lng: override.lng, name: override.address };
            } else {
              nextLoc = { lat: plan.overnightPoint.lat, lng: plan.overnightPoint.lng };
              overnight = { fromMatchId: lastOfDay.id, override: false, lat: plan.overnightPoint.lat, lng: plan.overnightPoint.lng, name: plan.overnightPoint.suggestedName };
            }
          }
          nextTime = timeToDateOnDay(nextDate, state.settings.nextDayStartHour);
        }

        const newDayChains = [...beamState.dayChains, { date, chain: cand.chain, dropped: cand.dropped, overnightAfter: overnight }];
        const signature = newDayChains.map(dc => dayChainSignature(dc.chain)).join('|');

        const newState = {
          dayChains: newDayChains,
          currentLoc: nextLoc,
          currentTime: nextTime,
          totalTravelMin: beamState.totalTravelMin + dayTravelMin + transitionTravelMin,
          tightNights: beamState.tightNights + tightAdd,
          infeasibleNights: beamState.infeasibleNights + infeasibleAdd,
          matchCount: beamState.matchCount + cand.chain.length,
          mustAttendCount: beamState.mustAttendCount + cand.chain.filter(m => m.mustAttend).length,
          scoreSum: beamState.scoreSum + cand.chain.reduce((sum, match) => sum + groundhopperScore(match), 0),
          availableMatchCount: trip.matches.length
        };

        const existing = nextBeamMap.get(signature);
        if (!existing || comparePlans(newState, existing, trip.matches.length) < 0) {
          nextBeamMap.set(signature, newState);
        }
      }
    }

    let nextBeam = [...nextBeamMap.values()];
    const nextReferenceCount = Math.max(1, ...nextBeam.map(plan => plan.matchCount));
    nextBeam.sort((a,b) => comparePlans(a,b,nextReferenceCount));
    beam = nextBeam.slice(0, BEAM_WIDTH);
  }

  const finalized = beam.map(b => finalizePlanState(b, trip));
  const finalReferenceCount = Math.max(1, ...finalized.map(plan => plan.matchCount));
  finalized.sort((a,b) => comparePlans(a,b,finalReferenceCount));
  const diverse = finalized.slice(0, MAX_PLANS);

  diverse.forEach((p, i) => {
    if (i === 0) {
      p.description = currentOptimizationMode === "groundhopper_score" ? "Beste gefundene Kombination nach durchschnittlichem Groundhopper Score." : currentOptimizationMode === "balanced" ? "Ausgewogene Kombination aus Spielanzahl (60 %) und Groundhopper Score (40 %)." : "Beste gefundene Kombination nach Highlightspielen, Spielanzahl und Fahrzeit.";
      p.changedDates = [];
    } else {
      p.description = diffDescription(diverse[0], p);
      p.changedDates = Array.from(changedDatesOf(diverse[0], p));
    }
  });

  return diverse;
}

// ---------- Hauptberechnung ----------
async function calculateRoute() {
  const trip = getActiveTrip();
  const timelineEl = document.getElementById("timeline");
  const droppedEl = document.getElementById("droppedSection");
  const switcherEl = document.getElementById("planSwitcher");

  if (!trip.startAddress || trip.matches.length === 0) {
    alert("Bitte gib eine Startadresse und mindestens ein Spiel ein.");
    return;
  }

  currentOptimizationMode = document.getElementById("optimizationMode")?.value || "most_games";
  trip.optimizationMode = currentOptimizationMode;

  timelineEl.innerHTML = "Berechne optimale Route, Spiele-Anzahl und Alternativen...";
  droppedEl.innerHTML = "";
  if (switcherEl) switcherEl.innerHTML = "";
  routeLayer.clearLayers();
  travelCache.clear();

  currentPlans = await buildOptimizedScheduleAlternatives(trip);

  if (!currentPlans || currentPlans.length === 0) {
    timelineEl.innerHTML = '<p class="placeholder-text">Kein Spiel konnte zeitlich eingeplant werden.</p>';
    lastSelectedMatchIds = new Set();
    updateMapMarkers();
    return;
  }

  // Alternativen auch im Trip-Objekt ablegen
  trip.plans = currentPlans;

  let idx = 0;
  if (trip.selectedPlanSignature) {
    const found = currentPlans.findIndex(p => p.signature === trip.selectedPlanSignature);
    if (found !== -1) idx = found;
  }
  currentPlanIndex = idx;
  trip.selectedPlanSignature = currentPlans[currentPlanIndex].signature;
  saveLocalStorage();

  await renderCurrentPlan();
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

  if (!currentPlans || currentPlans.length <= 1) {
    el.innerHTML = `<div class="plan-switcher-single">${planStatsHtml(plan)}</div>`;
    return;
  }

  el.innerHTML = `
    <div class="plan-switcher">
      <button class="btn btn-small" onclick="choosePlan(-1)" aria-label="Vorherige Alternative">←</button>
      <div class="plan-switcher-info">
        <strong>Alternative ${currentPlanIndex + 1} / ${currentPlans.length}</strong>
        <div class="plan-description">${escapeHtml(plan.description)}</div>
        ${planStatsHtml(plan)}
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
  const fallbackSum = (plan.selected || []).reduce((sum, match) => sum + groundhopperScore(match), 0);
  const scoreSum = Number.isFinite(plan.scoreSum) ? plan.scoreSum : fallbackSum;
  const averageScore = Math.round(plan.matchCount ? scoreSum / plan.matchCount : 0);
  const maxCount = Math.max(1, ...currentPlans.map(item => item.matchCount));
  const balanced = Math.round(0.6 * (plan.matchCount / maxCount) * 100 + 0.4 * averageScore);
  const modeExtra = plan.optimizationMode === "balanced" ? ` · ⚖️ Ausgewogen ${balanced}/100` : "";
  return `<div class="plan-stats">⚽ ${plan.matchCount} Spiele${mustLabel} · 🏆 Ø ${averageScore}/100${modeExtra} · 🚗 ca. ${travelStr}${nightWarn}<br><span class="optimization-mode-label">Berechnung: ${optimizationModeLabel(plan.optimizationMode)}</span></div>`;
}

async function renderDayTiles(plan, trip) {
  const timelineEl = document.getElementById("timeline");
  const droppedEl = document.getElementById("droppedSection");
  routeLayer.clearLayers();

  let currentLoc = { lat: trip.startAddress.lat, lng: trip.startAddress.lng, name: trip.startAddress.address };
  let html = "";
  const allDropped = [];

  for (let d = 0; d < plan.dayChains.length; d++) {
    const dc = plan.dayChains[d];
    allDropped.push(...dc.dropped);

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
      const osrm = await getOSRMRoute(currentLoc.lat, currentLoc.lng, match.lat, match.lng);

      if (osrm.geometry) {
        L.geoJSON(osrm.geometry, { style: { color: '#1b4332', weight: 4 } }).addTo(routeLayer);
      }

      const kickOff = new Date(`${match.date}T${match.time}`);
      const arrBuffer = match.customArrivalBuffer ?? state.settings.arrivalBufferMin;
      const targetArrival = new Date(kickOff.getTime() - arrBuffer * 60000);
      const departureTime = new Date(targetArrival.getTime() - osrm.durationMin * 60000);
      const deeplink = generateGoogleDeeplink(currentLoc.lat, currentLoc.lng, match.lat, match.lng);
      const leagueLabel = match.leagueName || getLeagueName(match.countryCode, match.leagueLevel);

      tileBody += `
        <div class="timeline-item">
          <strong>🚗 Fahrt nach ${escapeHtml(match.stadium)}</strong><br>
          Abfahrt: ${departureTime.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} Uhr | Fahrzeit: ca. ${osrm.durationMin} Min.<br>
          Ankunft am Stadion: ${targetArrival.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} Uhr
          <br>
          <a href="${deeplink}" target="_blank" class="deeplink-btn">In Google Maps öffnen</a>
        </div>
        <div class="timeline-item match-item">
          <strong>⚽ ${escapeHtml(match.home)} vs. ${escapeHtml(match.away)}</strong> ${match.mustAttend ? '<span class="must-badge">⭐</span>' : ''} (${matchContextLabel(match)})<br>
          ${scoreHtml(match)}<br>
          ${match.date} | Anstoß: ${match.time} Uhr | Stadion: ${escapeHtml(match.stadium)}${capacityHtml(match)}${match.clubWebsite ? `<br>${websiteLinkHtml(match)}` : ""}
        </div>
      `;

      currentLoc = { lat: match.lat, lng: match.lng, name: match.stadium };
    }

    const nextDc = plan.dayChains[d + 1];
    if (nextDc && dc.chain.length > 0) {
      const lastMatch = dc.chain[dc.chain.length - 1];
      const nextMatchGuess = nextDc.chain.length > 0 ? nextDc.chain[0] : null;

      if (nextMatchGuess) {
        const override = trip.overnightOverrides[lastMatch.id];
        const opPlan = await planOvernight(lastMatch, nextMatchGuess);
        const overnightLoc = override
          ? { lat: override.lat, lng: override.lng, name: override.address }
          : { lat: opPlan.overnightPoint.lat, lng: opPlan.overnightPoint.lng, name: opPlan.overnightPoint.suggestedName };

        let warningHtml = "";
        if (!opPlan.feasible) {
          warningHtml = `<div class="danger-banner">🚫 Zeitlich eng: Auch mit bis zu ${state.settings.maxExtraNightDriveMin} Min. zusätzlicher Nachtfahrt fehlen ca. ${opPlan.missingMin} Minuten, um pünktlich zum nächsten Spiel zu kommen. Ggf. eines der beiden Spiele entfernen.</div>`;
        } else if (opPlan.extraMinutesUsed > 0) {
          warningHtml = `<div class="warning-banner">⚠️ Enges Zeitfenster: benötigt ca. ${opPlan.extraMinutesUsed} Min. mehr Nachtfahrt als in den Einstellungen als Standard hinterlegt.</div>`;
        }

        const legDeeplink1 = generateGoogleDeeplink(lastMatch.lat, lastMatch.lng, overnightLoc.lat, overnightLoc.lng);
        const legDeeplink2 = generateGoogleDeeplink(overnightLoc.lat, overnightLoc.lng, nextMatchGuess.lat, nextMatchGuess.lng);
        const hotelLink = generateHotelSearchLink(overnightLoc.lat, overnightLoc.lng);
        const inputId = `overnightInput_${lastMatch.id}`;

        tileBody += `
          <div class="timeline-item overnight-block">
            <h4>🌙 Übernachtung erforderlich</h4>
            ${warningHtml}
            <p>Vorschlag: ca. ${opPlan.eveningDriveMin} Min. noch am Abend fahren, Rest am nächsten Morgen ab ${state.settings.nextDayStartHour} Uhr.</p>
            ${override ? '' : `<p><em>Automatischer Vorschlag – bitte Verfügbarkeit von Hotels/Unterkünften vor Ort kurz prüfen.</em></p>`}
            <div class="form-row">
              <input type="text" id="${inputId}" placeholder="Übernachtungsadresse" value="${escapeHtml(overnightLoc.name)}" />
              <button class="btn btn-small" onclick="saveOvernightOverride('${lastMatch.id}', '${inputId}')">Übernehmen</button>
              ${override ? `<button class="btn btn-small btn-secondary" onclick="clearOvernightOverride('${lastMatch.id}')">Vorschlag zurücksetzen</button>` : ''}
            </div>
            <a href="${legDeeplink1}" target="_blank" class="deeplink-btn">🗺️ Zur Übernachtung</a>
            <a href="${hotelLink}" target="_blank" class="deeplink-btn hotel-btn">🏨 Unterkünfte hier suchen</a>
            <a href="${legDeeplink2}" target="_blank" class="deeplink-btn">🗺️ Weiter zum nächsten Stadion</a>
          </div>
        `;

        L.marker([overnightLoc.lat, overnightLoc.lng])
          .bindPopup(`<b>🌙 Übernachtung</b><br>${escapeHtml(overnightLoc.name)}`)
          .addTo(routeLayer);

        currentLoc = { lat: overnightLoc.lat, lng: overnightLoc.lng, name: overnightLoc.name };
      }
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
  }

  timelineEl.innerHTML = html || '<p class="placeholder-text">Kein Spiel konnte zeitlich eingeplant werden.</p>';

  if (allDropped.length > 0) {
    droppedEl.innerHTML = `
      <div class="dropped-section">
        <h3>Aussortierte Spiele (${allDropped.length})</h3>
        ${allDropped.map(dd => `
          <div class="dropped-match">
            ${escapeHtml(dd.match.home)} vs. ${escapeHtml(dd.match.away)} –${dd.match.date} ${dd.match.time} Uhr (${escapeHtml(dd.match.leagueName || getLeagueName(dd.match.countryCode, dd.match.leagueLevel))})
            <span class="reason">Grund: ${escapeHtml(dd.reason)}</span>
          </div>
        `).join('')}
      </div>
    `;
  } else {
    droppedEl.innerHTML = '';
  }
}

// ---------- Settings Modal ----------
function toggleSettingsModal() {
  const modal = document.getElementById("settingsModal");
  if (modal.style.display === "flex") {
    modal.style.display = "none";
    return;
  }
  document.getElementById("settingArrivalBuffer").value = state.settings.arrivalBufferMin;
  document.getElementById("settingDepartureBuffer").value = state.settings.departureBufferMin;
  document.getElementById("settingHalfTime").value = state.settings.halfTimeMin;
  document.getElementById("settingStoppageTime").value = state.settings.stoppageTimeMin;
  document.getElementById("settingMaxNightDrive").value = state.settings.maxNightDriveTime;
  document.getElementById("settingNextDayStart").value = state.settings.nextDayStartHour;
  document.getElementById("settingMaxExtraNightDrive").value = state.settings.maxExtraNightDriveMin;
  const weights = state.settings.groundhopperWeights || {highlight:40,stage:30,competition:20,stadium:10};
  document.getElementById("weightHighlight").value = weights.highlight;
  document.getElementById("weightStage").value = weights.stage;
  document.getElementById("weightCompetition").value = weights.competition;
  document.getElementById("weightStadium").value = weights.stadium;
  modal.style.display = "flex";
}

function saveSettings() {
  state.settings.arrivalBufferMin = parseInt(document.getElementById("settingArrivalBuffer").value);
  state.settings.departureBufferMin = parseInt(document.getElementById("settingDepartureBuffer").value);
  state.settings.halfTimeMin = parseInt(document.getElementById("settingHalfTime").value);
  state.settings.stoppageTimeMin = parseInt(document.getElementById("settingStoppageTime").value);
  state.settings.maxNightDriveTime = document.getElementById("settingMaxNightDrive").value;
  state.settings.nextDayStartHour = document.getElementById("settingNextDayStart").value;
  state.settings.maxExtraNightDriveMin = parseInt(document.getElementById("settingMaxExtraNightDrive").value);
  state.settings.groundhopperWeights = {highlight:parseFloat(document.getElementById("weightHighlight").value)||0,stage:parseFloat(document.getElementById("weightStage").value)||0,competition:parseFloat(document.getElementById("weightCompetition").value)||0,stadium:parseFloat(document.getElementById("weightStadium").value)||0};

  saveLocalStorage();
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
    settings: state.settings,
    trip: trip
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
  reader.onload = function(e) {
    try {
      const importedData = JSON.parse(e.target.result);
      let importedTrip = importedData.trip || importedData;

      if (!importedTrip || !importedTrip.name || !Array.isArray(importedTrip.matches)) {
        alert("Ungültiges Dateiformat. Bitte wähle eine gültige Groundhopping JSON-Datei.");
        return;
      }

      // Neue eindeutige ID vergeben (verhindert Überschreiben)
      importedTrip.id = "trip_" + Date.now();
      importedTrip.name = importedTrip.name + " (Importiert)";

      if (!importedTrip.plans && importedData.plans) {
        importedTrip.plans = importedData.plans;
      }

      state.trips.push(importedTrip);
      state.activeTripId = importedTrip.id;

      if (importedData.settings) {
        if (confirm("Möchtest du auch die Trip-Einstellungen (Pufferzeiten, Nachtfahrtsgrenzen) übernehmen?")) {
          state.settings = { ...state.settings, ...importedData.settings };
        }
      }

      saveLocalStorage();
      renderTripSelect();
      resetMatchForm();
      renderActiveTrip();

      alert(`Trip "${importedTrip.name}" wurde erfolgreich importiert!`);
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
      icon: createCrestIcon(m.home, m.away, m.homeLogo, m.awayLogo)
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
