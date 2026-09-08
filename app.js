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
});

function initMap() {
  map = L.map('map').setView([51.1657, 10.4515], 6); // Deutschland-Zentrum
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
    // Merge, damit neue Settings-Felder bei alten gespeicherten Daten nicht fehlen
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
    overnightOverrides: {} // { [matchId]: {address, lat, lng} }
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
  const url = `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(address)}`;
  try {
    const response = await fetch(url);
    const data = await response.json();
    if (data && data.length > 0) {
      return { lat: parseFloat(data[0].lat), lng: parseFloat(data[0].lon), display: data[0].display_name };
    }
  } catch (err) {
    console.error("Geocoding Error:", err);
  }
  return null;
}

// zoom ~10 liefert eher eine Stadt/Ortschaft statt einer exakten Hausadresse -
// das ist gewollt, damit der Übernachtungsvorschlag ein Ort mit Unterkünften ist,
// keine zufällige Stelle auf freier Strecke.
async function reverseGeocode(lat, lng, zoom = 10) {
  const url = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${lat}&lon=${lng}&zoom=${zoom}`;
  try {
    const res = await fetch(url);
    const data = await res.json();
    const addr = data.address || {};
    const name = addr.city || addr.town || addr.village || addr.municipality || addr.county || data.display_name;
    return name || null;
  } catch (err) {
    console.error("Reverse-Geocoding Error:", err);
    return null;
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
    trip.startAddress = { address, lat: coords.lat, lng: coords.lng };
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
  const coords = await geocodeAddress(stadiumAddr);

  if (!coords) {
    alert("Stadion-Adresse konnte nicht gefunden werden.");
    return;
  }

  const match = {
    id: "m_" + Date.now(),
    home: document.getElementById("homeTeam").value,
    away: document.getElementById("awayTeam").value,
    homeLogo: document.getElementById("homeLogo").value,
    awayLogo: document.getElementById("awayLogo").value,
    leagueLevel: parseInt(document.getElementById("leagueLevel").value),
    date: document.getElementById("matchDate").value,
    time: document.getElementById("matchTime").value,
    stadium: stadiumAddr,
    lat: coords.lat,
    lng: coords.lng,
    customArrivalBuffer: document.getElementById("customArrivalBuffer").value ? parseInt(document.getElementById("customArrivalBuffer").value) : null,
    customDepartureBuffer: document.getElementById("customDepartureBuffer").value ? parseInt(document.getElementById("customDepartureBuffer").value) : null
  };

  trip.matches.push(match);
  saveLocalStorage();
  document.getElementById("matchForm").reset();
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
  const homeContent = homeLogo
    ? `<img src="${homeLogo}" alt="${escapeHtml(home)}"/>`
    : `<span class="badge">${escapeHtml(home.substring(0, 3).toUpperCase())}</span>`;

  const awayContent = awayLogo
    ? `<img src="${awayLogo}" alt="${escapeHtml(away)}"/>`
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

  const matchList = document.getElementById("matchList");
  matchList.innerHTML = trip.matches
    .slice()
    .sort((a, b) => new Date(`${a.date}T${a.time}`) - new Date(`${b.date}T${b.time}`))
    .map(m => `
    <li class="card" style="margin-bottom:0.5rem; padding:0.75rem;">
      <strong>${escapeHtml(m.home)} vs. ${escapeHtml(m.away)}</strong> (L${m.leagueLevel})<br>
      📅 ${m.date} - ⏰ ${m.time} Uhr<br>
      📍 ${escapeHtml(m.stadium)}
      <button onclick="deleteMatch('${m.id}')" class="btn btn-small" style="color:red; margin-top:0.4rem;">Löschen</button>
    </li>
  `).join('');

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
      .bindPopup(`<b>${escapeHtml(m.home)} vs. ${escapeHtml(m.away)}</b><br>Liga Level: ${m.leagueLevel}<br>${m.date} um ${m.time}`)
      .addTo(markersLayer);
  });

  document.getElementById("timeline").innerHTML = '<p class="placeholder-text">Füge Spiele hinzu und klicke auf "Route berechnen".</p>';
  document.getElementById("droppedSection").innerHTML = '';
  routeLayer.clearLayers();
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
  return { durationMin: 60, geometry: null, steps: null }; // Fallback bei Netzwerkfehler
}

// Findet die ungefähre Koordinate, die nach "targetSec" Sekunden Fahrzeit
// entlang der Route erreicht wird (für den Übernachtungsvorschlag).
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

// ---------- Konflikt-Auflösung (gleicher Tag) ----------
async function resolveConflicts(sortedMatches) {
  const selected = []; // { match, travelMin, slackMin }
  const dropped = [];

  for (const match of sortedMatches) {
    if (selected.length === 0) {
      selected.push({ match, travelMin: 0, slackMin: Infinity });
      continue;
    }

    const prevEntry = selected[selected.length - 1];
    const prev = prevEntry.match;

    if (match.date !== prev.date) {
      // Anderer Tag -> kein direkter Zeitkonflikt, Übernachtungslogik übernimmt später
      selected.push({ match, travelMin: null, slackMin: null });
      continue;
    }

    const prevEnd = calculateMatchEndTime(prev);
    const osrm = await getOSRMRoute(prev.lat, prev.lng, match.lat, match.lng);
    const arrBuffer = match.customArrivalBuffer ?? state.settings.arrivalBufferMin;
    const kickoff = new Date(`${match.date}T${match.time}`);
    const requiredArrival = new Date(kickoff.getTime() - arrBuffer * 60000);
    const earliestArrival = new Date(prevEnd.getTime() + osrm.durationMin * 60000);
    const slackMin = (requiredArrival - earliestArrival) / 60000;

    if (slackMin < 0) {
      // Konflikt: nicht rechtzeitig erreichbar
      let keepNew;
      if (match.leagueLevel < prev.leagueLevel) {
        keepNew = true;
      } else if (match.leagueLevel > prev.leagueLevel) {
        keepNew = false;
      } else {
        // Gleiches Level: mehr Zeitpuffer gewinnt, sonst kürzere Fahrzeit
        if (slackMin > prevEntry.slackMin) keepNew = true;
        else if (slackMin < prevEntry.slackMin) keepNew = false;
        else keepNew = osrm.durationMin < (prevEntry.travelMin ?? Infinity);
      }

      if (keepNew) {
        selected.pop();
        dropped.push({
          match: prev,
          reason: `Zeitkonflikt mit ${match.home} vs. ${match.away} (Liga-Level ${match.leagueLevel}) – nicht rechtzeitig zu beiden Spielen möglich.`
        });
        selected.push({ match, travelMin: osrm.durationMin, slackMin });
      } else {
        dropped.push({
          match,
          reason: `Zeitkonflikt mit ${prev.home} vs. ${prev.away} (Liga-Level ${prev.leagueLevel}) – Anfahrt reicht zeitlich nicht.`
        });
      }
    } else {
      selected.push({ match, travelMin: osrm.durationMin, slackMin });
    }
  }

  return { selected: selected.map(s => s.match), dropped };
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
      if (r.feasible) {
        result = r;
        extraMinutesUsed = extra;
        break;
      }
      result = r; // letzte (schlechteste) Berechnung merken, falls gar nichts reicht
      extraMinutesUsed = extra;
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

// ---------- Übernachtungs-Override speichern ----------
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

// ---------- Hauptberechnung ----------
async function calculateRoute() {
  const trip = getActiveTrip();
  const timelineEl = document.getElementById("timeline");
  const droppedEl = document.getElementById("droppedSection");

  if (!trip.startAddress || trip.matches.length === 0) {
    alert("Bitte gib eine Startadresse und mindestens ein Spiel ein.");
    return;
  }

  timelineEl.innerHTML = "Berechne optimale Route und Fahrzeiten...";
  droppedEl.innerHTML = "";
  routeLayer.clearLayers();

  const sortedMatches = [...trip.matches].sort((a, b) => new Date(`${a.date}T${a.time}`) - new Date(`${b.date}T${b.time}`));
  const { selected: selectedMatches, dropped } = await resolveConflicts(sortedMatches);

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

    html += `
      <div class="timeline-item">
        <strong>🚗 Fahrt nach ${escapeHtml(match.stadium)}</strong><br>
        Abfahrt: ${departureTime.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} Uhr | Fahrzeit: ca. ${osrm.durationMin} Min.<br>
        Ankunft am Stadion: ${targetArrival.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} Uhr
        <br>
        <a href="${deeplink}" target="_blank" class="deeplink-btn">🗺️ Teilstrecke in Google Maps öffnen</a>
      </div>
      <div class="timeline-item match-item">
        <strong>⚽ ${escapeHtml(match.home)} vs. ${escapeHtml(match.away)}</strong> (Liga Level ${match.leagueLevel})<br>
        📅 ${match.date} | Anstoß: ${match.time} Uhr | Stadion: ${escapeHtml(match.stadium)}
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
          ${override ? '' : `<p><em>Automatischer Vorschlag – bei Reverse-Geocoding kann der Ortsname ungenau sein, bitte vor Ort/online prüfen.</em></p>`}
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
      // Zweite Teilstrecke (Übernachtung -> nächstes Stadion) wird in der nächsten
      // Schleifeniteration automatisch von currentLoc aus berechnet und gezeichnet.
    } else {
      currentLoc = { lat: match.lat, lng: match.lng, name: match.stadium };
    }
  }

  timelineEl.innerHTML = html;

  if (dropped.length > 0) {
    droppedEl.innerHTML = `
      <div class="dropped-section">
        <h3>Aussortierte Spiele (${dropped.length})</h3>
        ${dropped.map(d => `
          <div class="dropped-match">
            ${escapeHtml(d.match.home)} vs. ${escapeHtml(d.match.away)} – ${d.match.date} ${d.match.time} Uhr (Liga-Level ${d.match.leagueLevel})
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
