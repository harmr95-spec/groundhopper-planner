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
    overnightOverrides: {}
  };

  state.trips.push(newTrip);
  state.activeTripId = newTrip.id;
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
      return {
        lat: parseFloat(r.lat),
        lng: parseFloat(r.lon),
        display: r.display_name,
        countryCode: r.address ? (r.address.country_code || null) : null
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

// ---------- Iterative Wappen-Suche (ohne Länder-Sperre) ----------
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

async function fetchCrestForTeam(teamName) {
  if (!teamName || !teamName.trim()) return null;

  const candidates = generateSearchCandidates(teamName);

  for (const candidate of candidates) {
    try {
      const url = `https://www.thesportsdb.com/api/v1/json/3/searchteams.php?t=${encodeURIComponent(candidate)}`;
      const res = await fetch(url);
      const data = await res.json();

      if (data && data.teams && data.teams.length > 0) {
        for (const team of data.teams) {
          const rawBadge = team.strTeamBadge || team.strBadge;
          if (rawBadge) {
            return rawBadge.replace(/\\/g, ''); // Backslashes bereinigen
          }
        }
      }
    } catch (err) {
      console.error(`Wappen-Suche Fehler für "${candidate}":`, err);
    }
  }
  return null;
}

// Triggered per Blur-Event im Formular ('home' oder 'away')
async function autoFetchCrest(type) {
  const teamInput = document.getElementById(`${type}Team`);
  const logoInput = document.getElementById(`${type}Logo`);
  const manualGroup = document.getElementById(`${type}LogoGroup`);
  const teamName = teamInput.value.trim();

  // 1. Wenn Feld leer ist: Beide Elemente ausblenden
  if (!teamName) {
    hideCrestPreview(type);
    if (manualGroup) manualGroup.style.display = "none";
    return;
  }

  const crestUrl = await fetchCrestForTeam(teamName);

  if (crestUrl) {
    // 2. Wappen gefunden: Vorschau zeigen, manuelles Feld verbergen
    logoInput.value = crestUrl;
    showCrestPreview(type, crestUrl);
  } else {
    // 3. Kein Wappen gefunden: Vorschau verbergen, manuelles Feld einblenden
    hideCrestPreview(type);
    if (manualGroup) manualGroup.style.display = "block";
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

  const stadiumAddr = document.getElementById("stadiumAddress").value;
  const leagueLevel = parseInt(document.getElementById("leagueLevel").value);
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

  const match = {
    id: "m_" + Date.now(),
    home: homeTeam,
    away: awayTeam,
    homeLogo: homeLogo,
    awayLogo: awayLogo,
    leagueLevel: leagueLevel,
    countryCode: coords.countryCode,
    leagueName: getLeagueName(coords.countryCode, leagueLevel),
    date: document.getElementById("matchDate").value,
    time: document.getElementById("matchTime").value,
    stadium: stadiumAddr,
    lat: coords.lat,
    lng: coords.lng,
    mustAttend: document.getElementById("mustAttend").checked,
    customArrivalBuffer: document.getElementById("customArrivalBuffer").value ? parseInt(document.getElementById("customArrivalBuffer").value) : null,
    customDepartureBuffer: document.getElementById("customDepartureBuffer").value ? parseInt(document.getElementById("customDepartureBuffer").value) : null
  };

  trip.matches.push(match);
  saveLocalStorage();
  
  // Formular zurücksetzen & UI aufräumen
  document.getElementById("matchForm").reset();
  hideCrestPreview('home');
  hideCrestPreview('away');

  renderActiveTrip();
}

function deleteMatch(matchId) {
  const trip = getActiveTrip();
  trip.matches = trip.matches.filter(m => m.id !== matchId);
  delete trip.overnightOverrides[matchId];
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

  renderMatchList(null, null);

  markersLayer.clearLayers();

  if (trip.startAddress) {
    L.marker([trip.startAddress.lat, trip.startAddress.lng])
      .bindPopup(`<b>Startpunkt:</b> ${escapeHtml(trip.startAddress.address)}`)
      .addTo(markersLayer);
  }

  trip.matches.forEach(m => {
    L.marker([m.lat, m.lng], {
      icon: createCrestIcon(m.home, m.away, m.homeLogo, m.awayLogo)
    })
      .bindPopup(matchPopupHtml(m))
      .addTo(markersLayer);
  });

  document.getElementById("timeline").innerHTML = '<p class="placeholder-text">Füge Spiele hinzu und klicke auf "Route berechnen".</p>';
  document.getElementById("droppedSection").innerHTML = '';
  routeLayer.clearLayers();
}

function matchPopupHtml(m) {
  return `<b>${escapeHtml(m.home)} vs. ${escapeHtml(m.away)}</b>${m.mustAttend ? ' <span class="must-badge">⭐</span>' : ''}<br>
    ${escapeHtml(m.leagueName || getLeagueName(m.countryCode, m.leagueLevel))}<br>
    📍 ${escapeHtml(m.stadium)}<br>
    📅 ${m.date} um ${m.time} Uhr`;
}

function renderMatchList(selectedIds, droppedReasons) {
  const trip = getActiveTrip();
  const matchList = document.getElementById("matchList");
  matchList.innerHTML = trip.matches
    .slice()
    .sort((a, b) => new Date(`${a.date}T${a.time}`) - new Date(`${b.date}T${b.time}`))
    .map(m => {
      let statusClass = "";
      let reasonHtml = "";
      if (selectedIds) {
        if (selectedIds.has(m.id)) {
          statusClass = "status-selected";
        } else {
          statusClass = "status-dropped";
          const reason = droppedReasons ? droppedReasons.get(m.id) : null;
          if (reason) reasonHtml = `<div class="reason" style="text-decoration:none;">${escapeHtml(reason)}</div>`;
        }
      }
      return `
    <li class="card match-list-item ${statusClass}" style="margin-bottom:0.5rem; padding:0.75rem;">
      <strong>${escapeHtml(m.home)} vs. ${escapeHtml(m.away)}</strong> ${m.mustAttend ? '<span class="must-badge">⭐</span>' : ''}<br>
      ${escapeHtml(m.leagueName || getLeagueName(m.countryCode, m.leagueLevel))}<br>
      📅 ${m.date} - ⏰ ${m.time} Uhr<br>
      📍 ${escapeHtml(m.stadium)}
      ${reasonHtml}
      <button onclick="deleteMatch('${m.id}')" class="btn btn-small" style="color:red; margin-top:0.4rem;">Löschen</button>
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

function priorityScore(m) {
  return 11 - m.leagueLevel;
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
        if (!best || candCount > best.count || (candCount === best.count && candScore > best.score)) {
          best = { count: candCount, score: candScore, prev: i };
        }
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
    if (bestIdx === -1 || dp[j].count > dp[bestIdx].count || (dp[j].count === dp[bestIdx].count && dp[j].score > dp[bestIdx].score)) {
      bestIdx = j;
    }
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

async function optimizeDayChain(dayMatches, startLoc, startTime) {
  const chain = [];
  const dropped = [];
  const mustIndices = [];
  dayMatches.forEach((m, i) => { if (m.mustAttend) mustIndices.push(i); });

  let cursor = 0;
  let currentLoc = startLoc;
  let currentTime = startTime;

  for (const mustIdx of mustIndices) {
    if (mustIdx < cursor) continue;
    const segment = dayMatches.slice(cursor, mustIdx + 1);
    const { chain: segChain, usedIndices, reachable } = await bestChainEndingAtLast(segment, currentLoc, currentTime);

    if (!reachable) {
      dropped.push({ match: dayMatches[mustIdx], reason: "Highlightspiel zeitlich nicht erreichbar – bitte Reisezeit/Puffer oder andere Spiele prüfen." });
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
        if (!usedIndices.has(m.id)) dropped.push({ match: m, reason: "Zeitlich nicht mit der Tagesauswahl vereinbar (Highlightspiel hat Vorrang)." });
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

// ---------- Gesamten Trip über alle Tage optimieren ----------
async function buildOptimizedSchedule(trip) {
  const byDate = new Map();
  trip.matches.forEach(m => {
    if (!byDate.has(m.date)) byDate.set(m.date, []);
    byDate.get(m.date).push(m);
  });
  const dates = [...byDate.keys()].sort();
  dates.forEach(d => byDate.get(d).sort((a, b) => a.time.localeCompare(b.time)));

  const selected = [];
  const dropped = [];

  let currentLoc = { lat: trip.startAddress.lat, lng: trip.startAddress.lng };
  let currentTime = new Date(`${dates[0]}T00:00:00`);

  for (let d = 0; d < dates.length; d++) {
    const dayMatches = byDate.get(dates[d]);
    const { chain, dropped: dayDropped } = await optimizeDayChain(dayMatches, currentLoc, currentTime);
    selected.push(...chain);
    dropped.push(...dayDropped);

    const nextDate = dates[d + 1];
    if (nextDate) {
      const lastOfDay = chain.length > 0 ? chain[chain.length - 1] : null;
      const nextDayMatches = byDate.get(nextDate);
      const nextGuess = nextDayMatches[0];

      if (lastOfDay && nextGuess) {
        const override = trip.overnightOverrides[lastOfDay.id];
        if (override) {
          currentLoc = { lat: override.lat, lng: override.lng };
        } else {
          const plan = await planOvernight(lastOfDay, nextGuess);
          currentLoc = { lat: plan.overnightPoint.lat, lng: plan.overnightPoint.lng };
        }
        currentTime = timeToDateOnDay(nextDate, state.settings.nextDayStartHour);
      } else {
        currentTime = timeToDateOnDay(nextDate, state.settings.nextDayStartHour);
      }
    }
  }

  return { selected, dropped };
}

// ---------- Hauptberechnung ----------
async function calculateRoute() {
  const trip = getActiveTrip();
  const timelineEl = document.getElementById("timeline");
  const droppedEl = document.getElementById("droppedSection");

  if (!trip.startAddress || trip.matches.length === 0) {
    alert("Bitte gib eine Startadresse und mindestens ein Spiel ein.");
    return;
  }

  timelineEl.innerHTML = "Berechne optimale Route und maximale Spiele-Anzahl pro Tag...";
  droppedEl.innerHTML = "";
  routeLayer.clearLayers();
  travelCache.clear();

  const { selected: selectedMatches, dropped } = await buildOptimizedSchedule(trip);

  const selectedIds = new Set(selectedMatches.map(m => m.id));
  const droppedReasons = new Map(dropped.map(d => [d.match.id, d.reason]));
  renderMatchList(selectedIds, droppedReasons);

  let currentLoc = { lat: trip.startAddress.lat, lng: trip.startAddress.lng, name: trip.startAddress.address };
  let html = "";

  for (let i = 0; i < selectedMatches.length; i++) {
    const match = selectedMatches[i];
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

    html += `
      <div class="timeline-item">
        <strong>🚗 Fahrt nach ${escapeHtml(match.stadium)}</strong><br>
        Abfahrt: ${departureTime.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} Uhr | Fahrzeit: ca. ${osrm.durationMin} Min.<br>
        Ankunft am Stadion: ${targetArrival.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} Uhr
        <br>
        <a href="${deeplink}" target="_blank" class="deeplink-btn">In Google Maps öffnen</a>
      </div>
      <div class="timeline-item match-item">
        <strong>⚽ ${escapeHtml(match.home)} vs. ${escapeHtml(match.away)}</strong> ${match.mustAttend ? '<span class="must-badge">⭐</span>' : ''} (${escapeHtml(leagueLabel)})<br>
        ${match.date} | Anstoß: ${match.time} Uhr | Stadion: ${escapeHtml(match.stadium)}
      </div>
    `;

    const nextMatch = selectedMatches[i + 1];
    if (nextMatch && nextMatch.date !== match.date) {
      const override = trip.overnightOverrides[match.id];
      const plan = await planOvernight(match, nextMatch);
      const overnightLoc = override
        ? { lat: override.lat, lng: override.lng, name: override.address }
        : { lat: plan.overnightPoint.lat, lng: plan.overnightPoint.lng, name: plan.overnightPoint.suggestedName };

      let warningHtml = "";
      if (!plan.feasible) {
        warningHtml = `<div class="danger-banner">🚫 Zeitlich eng: Auch mit bis zu ${state.settings.maxExtraNightDriveMin} Min. zusätzlicher Nachtfahrt fehlen ca. ${plan.missingMin} Minuten, um pünktlich zum nächsten Spiel zu kommen. Ggf. eines der beiden Spiele entfernen.</div>`;
      } else if (plan.extraMinutesUsed > 0) {
        warningHtml = `<div class="warning-banner">⚠️ Enges Zeitfenster: benötigt ca. ${plan.extraMinutesUsed} Min. mehr Nachtfahrt als in den Einstellungen als Standard hinterlegt.</div>`;
      }

      const legDeeplink1 = generateGoogleDeeplink(match.lat, match.lng, overnightLoc.lat, overnightLoc.lng);
      const legDeeplink2 = generateGoogleDeeplink(overnightLoc.lat, overnightLoc.lng, nextMatch.lat, nextMatch.lng);
      const hotelLink = generateHotelSearchLink(overnightLoc.lat, overnightLoc.lng);
      const inputId = `overnightInput_${match.id}`;

      html += `
        <div class="timeline-item overnight-block">
          <h4>🌙 Übernachtung erforderlich</h4>
          ${warningHtml}
          <p>Vorschlag: ca. ${plan.eveningDriveMin} Min. noch am Abend fahren, Rest am nächsten Morgen ab ${state.settings.nextDayStartHour} Uhr.</p>
          ${override ? '' : `<p><em>Automatischer Vorschlag – bitte Verfügbarkeit von Hotels/Unterkünften vor Ort kurz prüfen.</em></p>`}
          <div class="form-row">
            <input type="text" id="${inputId}" placeholder="Übernachtungsadresse" value="${escapeHtml(overnightLoc.name)}" />
            <button class="btn btn-small" onclick="saveOvernightOverride('${match.id}', '${inputId}')">Übernehmen</button>
            ${override ? `<button class="btn btn-small btn-secondary" onclick="clearOvernightOverride('${match.id}')">Vorschlag zurücksetzen</button>` : ''}
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
    } else {
      currentLoc = { lat: match.lat, lng: match.lng, name: match.stadium };
    }
  }

  timelineEl.innerHTML = html || '<p class="placeholder-text">Kein Spiel konnte zeitlich eingeplant werden.</p>';

  if (dropped.length > 0) {
    droppedEl.innerHTML = `
      <div class="dropped-section">
        <h3>Aussortierte Spiele (${dropped.length})</h3>
        ${dropped.map(d => `
          <div class="dropped-match">
            ${escapeHtml(d.match.home)} vs. ${escapeHtml(d.match.away)} – ${d.match.date} ${d.match.time} Uhr (${escapeHtml(d.match.leagueName || getLeagueName(d.match.countryCode, d.match.leagueLevel))})
            <span class="reason">Grund: ${escapeHtml(d.reason)}</span>
          </div>
        `).join('')}
      </div>
    `;
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

  saveLocalStorage();
  toggleSettingsModal();
}
