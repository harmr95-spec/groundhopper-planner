/* =========================================================================
   KI-One-Pager pro Spiel (Google Gemini)
   - Der API-Schlüssel wird NUR im Browser gespeichert (localStorage), nie im
     Trip, nie im Export und nie im Code.
   - "Trip bestätigen" erzeugt für alle Spiele der gewählten Alternative einen
     One-Pager (Stadion, Vereine, Begegnung & Historie, Groundhopper-Tipps).
   - Die One-Pager werden im Trip gespeichert (trip.briefings[matchId]).
   ========================================================================= */
(function () {
  "use strict";

  const AI_STORAGE_KEY = "groundhopping_ai";
  const DEFAULT_MODEL = "gemini-flash-latest";
  const API_BASE = "https://generativelanguage.googleapis.com/v1beta/models/";
  const PAUSE_BETWEEN_REQUESTS_MS = 1500;  // schont das kostenlose Kontingent
  const MAX_RETRY_WAIT_MS = 65000;         // so lange wird bei "Kontingent kurz erschöpft" max. gewartet
  const REQUEST_TIMEOUT_MS = 180000;       // neuere Modelle "denken" vor der Antwort – großzügiges Zeitlimit
  let thinkingUnsupported = false;         // ältere Modelle kennen thinkingLevel nicht

  let progress = null; // { done, total, current } während der Erstellung

  // ---------- KI-Einstellungen (gerätelokal, gelten für alle Trips) ----------
  function aiSettings() {
    try {
      const raw = JSON.parse(localStorage.getItem(AI_STORAGE_KEY) || "{}");
      return { apiKey: String(raw.apiKey || ""), model: String(raw.model || DEFAULT_MODEL) };
    } catch (e) {
      return { apiKey: "", model: DEFAULT_MODEL };
    }
  }
  function saveAiSettings(values) {
    try { localStorage.setItem(AI_STORAGE_KEY, JSON.stringify(values)); } catch (e) { /* Speicher voll */ }
  }

  window.loadAiSettingsIntoForm = function () {
    const ai = aiSettings();
    const key = document.getElementById("geminiApiKey");
    const model = document.getElementById("geminiModel");
    if (key) key.value = ai.apiKey;
    if (model) model.value = ai.model === DEFAULT_MODEL ? "" : ai.model;
    setKeyStatus(ai.apiKey ? "Schlüssel gespeichert." : "", ai.apiKey ? "ok" : "");
  };
  window.saveAiSettingsFromForm = function () {
    const key = document.getElementById("geminiApiKey");
    const model = document.getElementById("geminiModel");
    if (!key) return;
    saveAiSettings({
      apiKey: key.value.trim(),
      model: (model && model.value.trim()) || DEFAULT_MODEL
    });
  };
  window.toggleApiKeyVisibility = function () {
    const key = document.getElementById("geminiApiKey");
    if (key) key.type = key.type === "password" ? "text" : "password";
  };
  function setKeyStatus(text, kind) {
    const el = document.getElementById("geminiKeyStatus");
    if (!el) return;
    el.className = `ai-key-status ${kind || ""}`;
    el.innerHTML = text ? `${icon(kind === "ok" ? "circle-check" : kind === "error" ? "circle-x" : "loader-circle", kind === "busy" ? "spin" : "")} ${escapeHtml(text)}` : "";
  }
  window.testGeminiKey = async function () {
    const apiKey = document.getElementById("geminiApiKey").value.trim();
    const model = document.getElementById("geminiModel").value.trim() || DEFAULT_MODEL;
    if (!apiKey) { setKeyStatus("Bitte zuerst einen Schlüssel eintragen.", "error"); return; }
    setKeyStatus("Teste Verbindung …", "busy");
    try {
      await callGemini({ apiKey, model }, "Antworte nur mit dem Wort OK.", null, { json: false, retries: 0 });
      setKeyStatus(`Verbindung klappt (Modell: ${model}).`, "ok");
    } catch (err) {
      setKeyStatus(err.message, "error");
    }
  };

  // ---------- Gemini-Aufruf ----------
  class GeminiError extends Error {}

  async function callGemini(ai, prompt, systemText, { json = true, retries = 1 } = {}) {
    const buildBody = () => {
      const generationConfig = { temperature: 0.4, ...(json ? { responseMimeType: "application/json" } : {}) };
      // Kurz "nachdenken" lassen: deutlich schnellere Antworten bei Fakten-Texten
      if (!thinkingUnsupported) generationConfig.thinkingConfig = { thinkingLevel: "low" };
      const body = { contents: [{ role: "user", parts: [{ text: prompt }] }], generationConfig };
      if (systemText) body.systemInstruction = { parts: [{ text: systemText }] };
      return JSON.stringify(body);
    };

    for (let attempt = 0; ; attempt++) {
      let res;
      const started = Date.now();
      try {
        res = await fetchWithTimeout(`${API_BASE}${encodeURIComponent(ai.model)}:generateContent`, REQUEST_TIMEOUT_MS, {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-goog-api-key": ai.apiKey },
          body: buildBody()
        });
      } catch (err) {
        console.error("Gemini-Anfrage fehlgeschlagen:", err);
        if (err && err.name === "AbortError") {
          throw new GeminiError(`Gemini hat nach ${Math.round((Date.now() - started) / 1000)} Sekunden nicht geantwortet. Bitte erneut versuchen oder in den Einstellungen ein schnelleres Modell (z. B. ein „flash-lite“-Modell) eintragen.`);
        }
        if (typeof navigator !== "undefined" && navigator.onLine === false) {
          throw new GeminiError("Keine Internetverbindung.");
        }
        throw new GeminiError("Die Verbindung zu Gemini wurde blockiert (generativelanguage.googleapis.com). Häufige Ursache: ein Werbe-/Tracking-Blocker oder eine Firewall – bitte für diese Seite deaktivieren und erneut versuchen.");
      }
      let data = null;
      try { data = await res.json(); } catch (e) { /* kein JSON */ }

      // Modell kennt die Denk-Einstellung nicht -> ohne erneut versuchen
      if (res.status === 400 && !thinkingUnsupported && /thinking/i.test((data && data.error && data.error.message) || "")) {
        thinkingUnsupported = true;
        attempt--;
        continue;
      }

      if (res.ok) {
        const parts = data && data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts;
        const text = parts ? parts.filter(p => !p.thought).map(p => p.text || "").join("") : "";
        if (!text) throw new GeminiError("Gemini hat keine Antwort geliefert (evtl. vom Inhaltsfilter blockiert).");
        return text;
      }

      const msg = (data && data.error && data.error.message) || `HTTP ${res.status}`;
      if (res.status === 429) {
        const wait = retryDelayMs(data);
        if (attempt < retries && wait <= MAX_RETRY_WAIT_MS) {
          await sleep(wait);
          continue;
        }
        throw new GeminiError("Das kostenlose Gemini-Kontingent ist gerade aufgebraucht. Bitte später erneut versuchen.");
      }
      if (res.status === 400 && /api key/i.test(msg)) throw new GeminiError("Der Gemini-Schlüssel ist ungültig. Bitte in den Einstellungen prüfen.");
      if (res.status === 403) throw new GeminiError("Zugriff verweigert – ist der Schlüssel richtig und die Gemini API aktiviert?");
      if (res.status === 404) throw new GeminiError(`Das Modell „${ai.model}“ wurde nicht gefunden. Bitte in den Einstellungen ein anderes Modell eintragen.`);
      if (res.status >= 500 && attempt < retries) { await sleep(3000); continue; }
      throw new GeminiError(`Gemini-Fehler: ${msg}`);
    }
  }

  function retryDelayMs(data) {
    const details = (data && data.error && data.error.details) || [];
    const info = details.find(d => d && d.retryDelay);
    const seconds = info ? parseFloat(String(info.retryDelay)) : NaN;
    return Number.isFinite(seconds) ? Math.ceil(seconds * 1000) + 500 : 20000;
  }
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  // ---------- Prompt ----------
  const SYSTEM_TEXT = `Du bist ein erfahrener Groundhopper und Fußballhistoriker und schreibst kompakte, unterhaltsame One-Pager auf Deutsch.
Regeln:
- Schreibe nur, was du mit hoher Sicherheit weißt. Erfinde keine Zahlen, Daten, Ergebnisse, Namen oder Zitate.
- Wenn du dir bei etwas nicht sicher bist, lass es weg oder formuliere es vorsichtig ("angeblich", "nach Fan-Erzählungen").
- Ist das Stadion oder ein Verein kaum bekannt (z. B. unterklassig), sag das offen und halte den Abschnitt kurz.
- Antworte ausschließlich mit gültigem JSON im vorgegebenen Format, ohne Markdown.`;

  function buildPrompt(m) {
    const competition = typeof matchContextLabel === "function" ? matchContextLabel(m).replace(/<[^>]+>/g, "") : "";
    return `Erstelle einen One-Pager für dieses Fußballspiel:
- Heim: ${m.home}
- Gast: ${m.away}
- Wettbewerb: ${competition}
- Datum/Anstoß: ${m.date} ${m.time} Uhr
- Stadion: ${m.stadium}${m.resolvedAddress ? ` (${m.resolvedAddress})` : ""}${m.stadiumCapacity ? `, ca. ${m.stadiumCapacity} Plätze` : ""}
- Land: ${(m.countryCode || "").toUpperCase()}

Gib JSON in genau diesem Format zurück (Texte auf Deutsch, je 1–4 Sätze, Listen max. 5 Einträge):
{
  "intro": "2–3 Sätze, worauf man sich bei diesem Spiel freuen kann",
  "stadium": {
    "name": "offizieller Name",
    "facts": [{"label": "z. B. Eröffnet", "value": "..."}],
    "highlights": ["Besonderheit/Architektur/Atmosphäre"],
    "stories": [{"title": "kurzer Titel", "text": "wissenswerte Geschichte oder Anekdote"}]
  },
  "clubs": [
    {"name": "Heimverein", "facts": [{"label": "z. B. Gegründet", "value": "..."}], "portrait": "Kurzporträt", "fans": "Fanszene/Spitznamen/Farben"},
    {"name": "Gastverein", "facts": [], "portrait": "...", "fans": "..."}
  ],
  "fixture": {
    "summary": "Einordnung der Begegnung",
    "rivalry": "Rivalität/Derby-Charakter oder leer",
    "history": "bisherige Duelle / Historie",
    "memorable": [{"title": "legendäres Spiel", "text": "..."}]
  },
  "tips": [{"title": "Tipp", "text": "Anreise, Stimmung/Kurve, Essen & Trinken, was man nicht verpassen sollte"}],
  "caveats": ["Hinweise, wo die Angaben unsicher sind"]
}`;
  }

  // ---------- Antwort prüfen & bereinigen (Ausgabe wird nur escaped angezeigt) ----------
  const txt = (v, max = 800) => (typeof v === "string" ? v.trim().slice(0, max) : "");
  const list = (v, n = 6) => (Array.isArray(v) ? v.slice(0, n) : []);
  const facts = v => list(v, 8).map(f => ({ label: txt(f && f.label, 60), value: txt(f && f.value, 160) })).filter(f => f.label && f.value);
  const stories = v => list(v).map(s => ({ title: txt(s && s.title, 120), text: txt(s && s.text) })).filter(s => s.text);

  function sanitizeBriefingContent(raw) {
    const r = raw && typeof raw === "object" ? raw : {};
    const st = r.stadium || {}, fx = r.fixture || {};
    return {
      intro: txt(r.intro),
      stadium: { name: txt(st.name, 120), facts: facts(st.facts), highlights: list(st.highlights).map(h => txt(h, 300)).filter(Boolean), stories: stories(st.stories) },
      clubs: list(r.clubs, 2).map(c => ({ name: txt(c && c.name, 120), facts: facts(c && c.facts), portrait: txt(c && c.portrait), fans: txt(c && c.fans) })).filter(c => c.name),
      fixture: { summary: txt(fx.summary), rivalry: txt(fx.rivalry), history: txt(fx.history, 1200), memorable: stories(fx.memorable) },
      tips: stories(r.tips),
      caveats: list(r.caveats).map(c => txt(c, 300)).filter(Boolean)
    };
  }

  // Für Import: gespeicherte One-Pager prüfen
  window.sanitizeStoredBriefing = function (raw) {
    if (!raw || typeof raw !== "object" || !raw.content) return null;
    return {
      createdAt: txt(raw.createdAt, 40),
      model: txt(raw.model, 80),
      content: sanitizeBriefingContent(raw.content)
    };
  };

  function parseJsonLoose(text) {
    try { return JSON.parse(text); } catch (e) { /* weiter */ }
    const start = text.indexOf("{"), end = text.lastIndexOf("}");
    if (start !== -1 && end > start) return JSON.parse(text.slice(start, end + 1));
    throw new GeminiError("Die Antwort von Gemini war kein gültiges JSON.");
  }

  async function generateBriefing(trip, match, ai) {
    const text = await callGemini(ai, buildPrompt(match), SYSTEM_TEXT);
    const content = sanitizeBriefingContent(parseJsonLoose(text));
    if (!trip.briefings) trip.briefings = {};
    trip.briefings[match.id] = { createdAt: new Date().toISOString(), model: ai.model, content };
    saveLocalStorage();
  }

  // ---------- Trip bestätigen ----------
  const activePlan = () => (currentPlans && currentPlans[currentPlanIndex]) || null;

  window.confirmTrip = async function () {
    const trip = getActiveTrip(), plan = activePlan();
    if (!trip || !plan) return;
    trip.confirmed = { at: new Date().toISOString(), planSignature: plan.signature };
    saveLocalStorage();
    await generateMissingBriefings();
  };

  window.unconfirmTrip = function () {
    const trip = getActiveTrip();
    if (!trip) return;
    delete trip.confirmed;
    saveLocalStorage();
    renderCurrentPlan();
  };

  // Erstellt One-Pager für alle Spiele der aktiven Alternative, die noch keinen haben.
  window.generateMissingBriefings = async function () {
    const trip = getActiveTrip(), plan = activePlan();
    if (!trip || !plan || progress) return;
    const ai = aiSettings();
    if (!ai.apiKey) {
      pendingPlanMessage = { type: "warning", text: "Für die One-Pager wird ein kostenloser Gemini-Schlüssel benötigt. Bitte in den Einstellungen (Zahnrad am Trip) eintragen." };
      renderCurrentPlan();
      toggleSettingsModal();
      return;
    }
    const todo = plan.selected.filter(m => !(trip.briefings && trip.briefings[m.id]));
    if (!todo.length) { renderCurrentPlan(); return; }

    progress = { done: 0, total: todo.length, current: "" };
    let error = null;
    try {
      for (const m of todo) {
        progress.current = shortMatchLabel(m);
        renderPlanSwitcher(plan);
        await generateBriefing(trip, m, ai);
        progress.done++;
        if (progress.done < progress.total) await sleep(PAUSE_BETWEEN_REQUESTS_MS);
      }
    } catch (err) {
      console.error("One-Pager-Fehler:", err);
      error = err instanceof GeminiError ? err.message : "Beim Erstellen der One-Pager ist ein Fehler aufgetreten.";
    }
    const done = progress.done, total = progress.total;
    progress = null;
    pendingPlanMessage = error
      ? { type: "danger", text: `${error}${done ? ` (${done} von ${total} One-Pagern wurden erstellt.)` : ""}` }
      : { type: "success", text: `${done} One-Pager erstellt – zu finden am jeweiligen Spiel im Ablaufplan.` };
    renderCurrentPlan();
  };

  window.regenerateBriefing = async function (matchId) {
    const trip = getActiveTrip();
    const match = trip && trip.matches.find(m => m.id === matchId);
    if (!match || progress) return;
    const ai = aiSettings();
    if (!ai.apiKey) { toggleSettingsModal(); return; }
    progress = { done: 0, total: 1, current: shortMatchLabel(match) };
    renderBriefingModal(matchId, true);
    try {
      await generateBriefing(trip, match, ai);
    } catch (err) {
      console.error("One-Pager-Fehler:", err);
      progress = null;
      renderBriefingModal(matchId, false, err instanceof GeminiError ? err.message : "Unbekannter Fehler.");
      return;
    }
    progress = null;
    renderBriefingModal(matchId);
    renderCurrentPlan();
  };

  // ---------- Bausteine für app.js ----------
  window.confirmationHtml = function (trip) {
    const plan = activePlan();
    if (!trip || !plan) return "";
    if (progress) {
      return bannerHtml("info", `Erstelle One-Pager ${progress.done + 1} von ${progress.total}: ${escapeHtml(progress.current)} …`, "loader-circle")
        .replace('class="icon', 'class="icon spin');
    }
    if (!trip.confirmed) {
      return `<div class="confirm-bar">
        <div class="confirm-text">${icon("sparkles", "tone-violet")} <span><strong>Passt der Plan?</strong> Bestätige den Trip – dann schreibt die KI zu jedem Spiel einen One-Pager mit Stadion, Vereinen, Historie und Tipps.</span></div>
        <button class="btn btn-primary" onclick="confirmTrip()">${icon("badge-check")} Trip bestätigen</button>
      </div>`;
    }
    const total = plan.selected.length;
    const have = plan.selected.filter(m => trip.briefings && trip.briefings[m.id]).length;
    const date = new Date(trip.confirmed.at).toLocaleDateString("de-DE");
    return `<div class="confirm-bar confirmed">
      <div class="confirm-text">${icon("badge-check", "tone-green")} <span><strong>Trip bestätigt</strong> am ${date} · ${icon("book-open")} ${have}/${total} One-Pager</span></div>
      <div class="confirm-actions">
        ${have < total ? `<button class="btn btn-soft" onclick="generateMissingBriefings()">${icon("sparkles")} Fehlende erstellen</button>` : ""}
        <button class="btn btn-ghost" onclick="unconfirmTrip()" title="Bestätigung aufheben (One-Pager bleiben erhalten)">Aufheben</button>
      </div>
    </div>`;
  };

  window.briefingButtonHtml = function (match) {
    const trip = getActiveTrip();
    if (!trip || !(trip.briefings && trip.briefings[match.id])) return "";
    return `<button class="link-btn link-violet" onclick="openBriefing('${match.id}')">${icon("book-open")} One-Pager</button>`;
  };

  // Nach "Keine Tickets" in einem bestätigten Trip: One-Pager für Ersatzspiele nachziehen
  window.afterPlanRepaired = function () {
    const trip = getActiveTrip();
    if (trip && trip.confirmed && aiSettings().apiKey) generateMissingBriefings();
  };

  // ---------- One-Pager-Ansicht ----------
  function ensureModal() {
    let el = document.getElementById("briefingModal");
    if (el) return el;
    document.body.insertAdjacentHTML("beforeend", `
      <div id="briefingModal" class="modal" onclick="if (event.target === this) closeBriefing()">
        <div class="modal-content briefing-modal" role="dialog" aria-modal="true" aria-label="One-Pager"></div>
      </div>`);
    el = document.getElementById("briefingModal");
    document.addEventListener("keydown", e => { if (e.key === "Escape" && el.style.display === "flex") closeBriefing(); });
    return el;
  }

  window.openBriefing = function (matchId) {
    renderBriefingModal(matchId);
    ensureModal().style.display = "flex";
  };
  window.closeBriefing = function () {
    const el = document.getElementById("briefingModal");
    if (el) el.style.display = "none";
  };

  function renderBriefingModal(matchId, busy = false, error = "") {
    const trip = getActiveTrip();
    const match = trip && trip.matches.find(m => m.id === matchId);
    if (!match) return;
    const b = trip.briefings && trip.briefings[matchId];
    const box = ensureModal().querySelector(".modal-content");
    box.innerHTML = `
      <div class="modal-header">
        <div><h2>${escapeHtml(match.home)} – ${escapeHtml(match.away)}</h2>
          <p class="settings-hint">${formatDateLong(match.date)} · ${match.time} Uhr · ${escapeHtml(match.stadium)}</p></div>
        <button type="button" class="modal-close" onclick="closeBriefing()" aria-label="Schließen">${icon("x")}</button>
      </div>
      <div class="modal-body">
        ${error ? bannerHtml("danger", escapeHtml(error)) : ""}
        ${busy ? `<div class="empty-state loading">${icon("sparkles", "tone-violet")}<p>Gemini schreibt den One-Pager …</p></div>`
          : b ? briefingHtml(match, b) : `<div class="empty-state">${icon("book-open", "tone-violet")}<p>Noch kein One-Pager vorhanden.</p></div>`}
      </div>
      <div class="modal-actions">
        <button class="btn btn-ghost" onclick="regenerateBriefing('${match.id}')" ${busy ? "disabled" : ""}>${icon("refresh-cw")} Neu erstellen</button>
        <button class="btn btn-primary" onclick="printBriefing('${match.id}')" ${busy || !b ? "disabled" : ""}>${icon("printer")} Drucken</button>
      </div>`;
  }

  const factsHtml = fs => fs.length ? `<dl class="facts">${fs.map(f => `<div><dt>${escapeHtml(f.label)}</dt><dd>${escapeHtml(f.value)}</dd></div>`).join("")}</dl>` : "";
  const storiesHtml = ss => ss.map(s => `<div class="story">${s.title ? `<h5>${escapeHtml(s.title)}</h5>` : ""}<p>${escapeHtml(s.text)}</p></div>`).join("");
  const para = t => t ? `<p>${escapeHtml(t)}</p>` : "";

  function briefingHtml(match, b) {
    const c = b.content;
    const section = (tone, iconName, title, body) => body.trim()
      ? `<section class="bp-section"><h4><span class="chip chip-${tone}">${icon(iconName)}</span> ${title}</h4>${body}</section>` : "";
    return `<article class="briefing">
      ${c.intro ? `<p class="bp-intro">${escapeHtml(c.intro)}</p>` : ""}
      ${section("blue", "landmark", `Stadion${c.stadium.name ? ` · ${escapeHtml(c.stadium.name)}` : ""}`,
        factsHtml(c.stadium.facts) +
        (c.stadium.highlights.length ? `<ul class="bp-list">${c.stadium.highlights.map(h => `<li>${escapeHtml(h)}</li>`).join("")}</ul>` : "") +
        storiesHtml(c.stadium.stories))}
      ${section("green", "shield", "Die Vereine",
        c.clubs.length ? `<div class="bp-clubs">${c.clubs.map(cl => `<div class="bp-club"><h5>${escapeHtml(cl.name)}</h5>${factsHtml(cl.facts)}${para(cl.portrait)}${cl.fans ? `<p class="muted">${icon("users")} ${escapeHtml(cl.fans)}</p>` : ""}</div>`).join("")}</div>` : "")}
      ${section("amber", "history", "Begegnung & Historie",
        para(c.fixture.summary) + (c.fixture.rivalry ? `<p><strong>Rivalität:</strong> ${escapeHtml(c.fixture.rivalry)}</p>` : "") +
        para(c.fixture.history) + storiesHtml(c.fixture.memorable))}
      ${section("violet", "lightbulb", "Groundhopper-Tipps", storiesHtml(c.tips))}
      <footer class="bp-footer">
        ${icon("sparkles")} KI-generiert mit ${escapeHtml(b.model || "Gemini")} am ${new Date(b.createdAt).toLocaleDateString("de-DE")} – Angaben ohne Gewähr, bitte vor Ort nichts blind glauben.
        ${c.caveats.length ? `<br><span class="muted">Unsicher: ${c.caveats.map(escapeHtml).join(" · ")}</span>` : ""}
      </footer>
    </article>`;
  }

  // ---------- Druck ----------
  // Einzelner One-Pager
  window.printBriefing = function (matchId) {
    const trip = getActiveTrip();
    const match = trip && trip.matches.find(m => m.id === matchId);
    if (!match || !trip.briefings || !trip.briefings[matchId]) return;
    fillPrintArea([match], trip);
    document.body.classList.add("printing-briefing");
    window.addEventListener("afterprint", () => document.body.classList.remove("printing-briefing"), { once: true });
    setTimeout(() => window.print(), 50);
  };

  // Für den Trip-Druck: alle One-Pager der aktiven Alternative anhängen
  window.prepareBriefingsPrint = function () {
    const trip = getActiveTrip(), plan = activePlan();
    if (!trip || !plan) { fillPrintArea([], trip); return; }
    fillPrintArea(plan.selected.filter(m => trip.briefings && trip.briefings[m.id]), trip);
  };

  function fillPrintArea(matches, trip) {
    let area = document.getElementById("briefingsPrint");
    if (!area) {
      document.body.insertAdjacentHTML("beforeend", '<div id="briefingsPrint" class="briefings-print"></div>');
      area = document.getElementById("briefingsPrint");
    }
    area.innerHTML = matches.map(m => `
      <div class="print-onepager">
        <h2>${escapeHtml(m.home)} – ${escapeHtml(m.away)}</h2>
        <p class="muted">${formatDateLong(m.date)} · ${m.time} Uhr · ${escapeHtml(m.stadium)}</p>
        ${briefingHtml(m, trip.briefings[m.id])}
      </div>`).join("");
  }
})();
