/* =========================================================================
   KI-One-Pager pro Spiel (Google Gemini)
   - Der API-Schlüssel wird NUR im Browser gespeichert (localStorage), nie im
     Trip, nie im Export und nie im Code.
   - "Trip bestätigen" schaltet die One-Pager frei; erstellt wird pro Spiel
     (Button am Spiel) oder auf Wunsch für alle fehlenden nacheinander.
   - Antworten werden gestreamt: Fortschritt live, Abbruch nur bei Funkstille.
   - Die One-Pager werden im Trip gespeichert (trip.briefings[matchId]).
   ========================================================================= */
(function () {
  "use strict";

  const AI_STORAGE_KEY = "groundhopping_ai";
  const DEFAULT_MODEL = "gemini-flash-latest";
  const API_BASE = "https://generativelanguage.googleapis.com/v1beta/models/";
  const PAUSE_BETWEEN_REQUESTS_MS = 1500;  // schont das kostenlose Kontingent
  const MAX_RETRY_WAIT_MS = 65000;         // so lange wird bei "Kontingent kurz erschöpft" max. gewartet
  const IDLE_TIMEOUT_MS = 90000;           // Abbruch, wenn so lange gar keine Daten mehr kommen
  const TOTAL_TIMEOUT_MS = 360000;         // absolute Obergrenze pro One-Pager
  let thinkingUnsupported = false;         // ältere Modelle kennen thinkingLevel nicht

  // Laufende Erstellung: { matchId, chars, started } bzw. Sammel-Lauf { done, total }
  let busy = null;
  let batch = null;

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

  function connectionError(err, reason, started) {
    console.error("Gemini-Anfrage fehlgeschlagen:", err);
    const secs = Math.round((Date.now() - started) / 1000);
    if (reason === "idle") return new GeminiError(`Gemini hat ${secs} Sekunden lang keine Daten mehr geschickt. Bitte erneut versuchen oder in den Einstellungen ein schnelleres Modell (z. B. ein „flash-lite“-Modell) eintragen.`);
    if (reason === "total") return new GeminiError(`Abbruch nach ${secs} Sekunden – die Antwort dauert zu lange. Bitte ein schnelleres Modell eintragen.`);
    if (typeof navigator !== "undefined" && navigator.onLine === false) return new GeminiError("Keine Internetverbindung.");
    return new GeminiError("Die Verbindung zu Gemini wurde blockiert (generativelanguage.googleapis.com). Häufige Ursache: ein Werbe-/Tracking-Blocker oder eine Firewall – bitte für diese Seite deaktivieren und erneut versuchen.");
  }

  // Ruft Gemini im Streaming-Modus auf (Server-Sent Events) und liefert den kompletten Antworttext.
  // onProgress(zeichen) wird bei jedem empfangenen Stück aufgerufen.
  async function callGemini(ai, prompt, systemText, { json = true, retries = 1, onProgress = null } = {}) {
    const buildBody = () => {
      const generationConfig = { temperature: 0.4, ...(json ? { responseMimeType: "application/json" } : {}) };
      // Kurz "nachdenken" lassen: deutlich schnellere Antworten bei Fakten-Texten
      if (!thinkingUnsupported) generationConfig.thinkingConfig = { thinkingLevel: "low" };
      const body = { contents: [{ role: "user", parts: [{ text: prompt }] }], generationConfig };
      if (systemText) body.systemInstruction = { parts: [{ text: systemText }] };
      return JSON.stringify(body);
    };

    for (let attempt = 0; ; attempt++) {
      const ctrl = new AbortController();
      const started = Date.now();
      let reason = null, idleTimer = null;
      const armIdle = () => {
        clearTimeout(idleTimer);
        idleTimer = setTimeout(() => { reason = "idle"; ctrl.abort(); }, IDLE_TIMEOUT_MS);
      };
      const totalTimer = setTimeout(() => { reason = "total"; ctrl.abort(); }, TOTAL_TIMEOUT_MS);
      armIdle();

      try {
        let res;
        try {
          res = await fetch(`${API_BASE}${encodeURIComponent(ai.model)}:streamGenerateContent?alt=sse`, {
            method: "POST",
            headers: { "Content-Type": "application/json", "x-goog-api-key": ai.apiKey },
            body: buildBody(),
            signal: ctrl.signal
          });
        } catch (err) {
          throw connectionError(err, reason, started);
        }

        if (!res.ok) {
          let data = null;
          try { data = JSON.parse(await res.text()); if (Array.isArray(data)) data = data[0]; } catch (e) { /* kein JSON */ }
          const msg = (data && data.error && data.error.message) || `HTTP ${res.status}`;
          // Modell kennt die Denk-Einstellung nicht -> ohne erneut versuchen
          if (res.status === 400 && !thinkingUnsupported && /thinking/i.test(msg)) {
            thinkingUnsupported = true;
            attempt--;
            continue;
          }
          if (res.status === 429) {
            const wait = retryDelayMs(data);
            if (attempt < retries && wait <= MAX_RETRY_WAIT_MS) { await sleep(wait); continue; }
            throw new GeminiError("Das kostenlose Gemini-Kontingent ist gerade aufgebraucht. Bitte später erneut versuchen.");
          }
          if (res.status === 400 && /api key/i.test(msg)) throw new GeminiError("Der Gemini-Schlüssel ist ungültig. Bitte in den Einstellungen prüfen.");
          if (res.status === 403) throw new GeminiError("Zugriff verweigert – ist der Schlüssel richtig und die Gemini API aktiviert?");
          if (res.status === 404) throw new GeminiError(`Das Modell „${ai.model}“ wurde nicht gefunden. Bitte in den Einstellungen ein anderes Modell eintragen.`);
          if (res.status >= 500 && attempt < retries) { await sleep(3000); continue; }
          throw new GeminiError(`Gemini-Fehler: ${msg}`);
        }

        // Stream lesen: Zeilen "data: {...}"
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "", text = "", finishReason = null, blockReason = null;
        const handleLine = line => {
          line = line.trim();
          if (!line.startsWith("data:")) return;
          let ev;
          try { ev = JSON.parse(line.slice(5).trim()); } catch (e) { return; }
          if (ev.error) throw new GeminiError(`Gemini-Fehler: ${ev.error.message || "unbekannt"}`);
          if (ev.promptFeedback && ev.promptFeedback.blockReason) blockReason = ev.promptFeedback.blockReason;
          const cand = ev.candidates && ev.candidates[0];
          if (!cand) return;
          const parts = (cand.content && cand.content.parts) || [];
          parts.forEach(p => { if (!p.thought && p.text) text += p.text; });
          if (cand.finishReason) finishReason = cand.finishReason;
        };
        for (;;) {
          let chunk;
          try { chunk = await reader.read(); } catch (err) { throw connectionError(err, reason, started); }
          if (chunk.done) break;
          armIdle();
          buffer += decoder.decode(chunk.value, { stream: true });
          let nl;
          while ((nl = buffer.indexOf("\n")) >= 0) {
            handleLine(buffer.slice(0, nl));
            buffer = buffer.slice(nl + 1);
          }
          if (onProgress) onProgress(text.length);
        }
        handleLine(buffer);

        if (!text) {
          throw new GeminiError(blockReason
            ? "Gemini hat die Anfrage blockiert (Inhaltsfilter)."
            : "Gemini hat keine Antwort geliefert. Bitte erneut versuchen.");
        }
        if (finishReason === "MAX_TOKENS" && json) {
          try { JSON.parse(text); } catch (e) { throw new GeminiError("Die Antwort von Gemini wurde abgeschnitten. Bitte erneut versuchen."); }
        }
        return text;
      } finally {
        clearTimeout(idleTimer);
        clearTimeout(totalTimer);
      }
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
    busy = { matchId: match.id, chars: 0, started: Date.now() };
    updateBusyIndicators();
    try {
      const text = await callGemini(ai, buildPrompt(match), SYSTEM_TEXT, {
        onProgress: chars => { if (busy) { busy.chars = chars; updateBusyIndicators(); } }
      });
      const content = sanitizeBriefingContent(parseJsonLoose(text));
      if (!trip.briefings) trip.briefings = {};
      trip.briefings[match.id] = { createdAt: new Date().toISOString(), model: ai.model, content };
      saveLocalStorage();
    } finally {
      busy = null;
    }
  }

  // Fortschritt live in Buttons/Modal schreiben, ohne alles neu zu zeichnen
  function busyLabel() {
    if (!busy) return "";
    if (!busy.chars) return `Denkt nach … ${Math.round((Date.now() - busy.started) / 1000)} s`;
    return `Schreibt … ${busy.chars >= 1000 ? (busy.chars / 1000).toFixed(1).replace(".", ",") + "k" : busy.chars} Zeichen`;
  }
  function updateBusyIndicators() {
    if (!busy) return;
    document.querySelectorAll(`[data-brief-progress="${busy.matchId}"]`).forEach(el => { el.textContent = busyLabel(); });
  }
  setInterval(updateBusyIndicators, 1000); // Sekunden beim Nachdenken weiterzählen

  function requireKey() {
    const ai = aiSettings();
    if (ai.apiKey) return ai;
    pendingPlanMessage = { type: "warning", text: "Für die One-Pager wird ein kostenloser Gemini-Schlüssel benötigt. Bitte in den Einstellungen (Zahnrad am Trip) eintragen." };
    renderCurrentPlan();
    toggleSettingsModal();
    return null;
  }
  const errorText = err => (err instanceof GeminiError ? err.message : "Beim Erstellen des One-Pagers ist ein Fehler aufgetreten.");

  // ---------- Trip bestätigen ----------
  const activePlan = () => (currentPlans && currentPlans[currentPlanIndex]) || null;

  window.confirmTrip = function () {
    const trip = getActiveTrip(), plan = activePlan();
    if (!trip || !plan) return;
    trip.confirmed = { at: new Date().toISOString(), planSignature: plan.signature };
    saveLocalStorage();
    pendingPlanMessage = aiSettings().apiKey
      ? { type: "success", text: "Trip bestätigt. Am jeweiligen Spiel kannst du jetzt den One-Pager erstellen lassen." }
      : { type: "info", text: "Trip bestätigt. Für die One-Pager bitte noch einen kostenlosen Gemini-Schlüssel in den Einstellungen eintragen." };
    renderCurrentPlan();
  };

  window.unconfirmTrip = function () {
    const trip = getActiveTrip();
    if (!trip) return;
    delete trip.confirmed;
    saveLocalStorage();
    renderCurrentPlan();
  };

  // One-Pager für ein einzelnes Spiel erstellen (Button am Spiel)
  window.createBriefing = async function (matchId) {
    const trip = getActiveTrip();
    const match = trip && trip.matches.find(m => m.id === matchId);
    if (!match || busy) return;
    const ai = requireKey();
    if (!ai) return;
    const run = generateBriefing(trip, match, ai);
    renderCurrentPlan(); // Button zeigt Fortschritt
    try {
      await run;
      pendingPlanMessage = { type: "success", text: `One-Pager für ${shortMatchLabel(match)} ist fertig.` };
      await renderCurrentPlan();
      openBriefing(matchId);
    } catch (err) {
      console.error("One-Pager-Fehler:", err);
      pendingPlanMessage = { type: "danger", text: `${shortMatchLabel(match)}: ${errorText(err)}` };
      renderCurrentPlan();
    }
  };

  // Alle fehlenden One-Pager der aktiven Alternative nacheinander erstellen
  window.generateMissingBriefings = async function () {
    const trip = getActiveTrip(), plan = activePlan();
    if (!trip || !plan || busy || batch) return;
    const ai = requireKey();
    if (!ai) return;
    const todo = plan.selected.filter(m => !(trip.briefings && trip.briefings[m.id]));
    if (!todo.length) return;

    batch = { done: 0, total: todo.length };
    let error = null;
    try {
      for (const m of todo) {
        const run = generateBriefing(trip, m, ai);
        renderCurrentPlan();
        await run;
        batch.done++;
        if (batch.done < batch.total) await sleep(PAUSE_BETWEEN_REQUESTS_MS);
      }
    } catch (err) {
      console.error("One-Pager-Fehler:", err);
      error = errorText(err);
    }
    const { done, total } = batch;
    batch = null;
    pendingPlanMessage = error
      ? { type: "danger", text: `${error}${done ? ` (${done} von ${total} One-Pagern wurden erstellt.)` : ""}` }
      : { type: "success", text: `${done} One-Pager erstellt – zu finden am jeweiligen Spiel im Ablaufplan.` };
    renderCurrentPlan();
  };

  window.regenerateBriefing = async function (matchId) {
    const trip = getActiveTrip();
    const match = trip && trip.matches.find(m => m.id === matchId);
    if (!match || busy) return;
    const ai = requireKey();
    if (!ai) return;
    const run = generateBriefing(trip, match, ai);
    renderBriefingModal(matchId);
    try {
      await run;
    } catch (err) {
      console.error("One-Pager-Fehler:", err);
      renderBriefingModal(matchId, errorText(err));
      return;
    }
    renderBriefingModal(matchId);
    renderCurrentPlan();
  };

  // ---------- Bausteine für app.js ----------
  window.confirmationHtml = function (trip) {
    const plan = activePlan();
    if (!trip || !plan) return "";
    if (!trip.confirmed) {
      return `<div class="confirm-bar">
        <div class="confirm-text">${icon("sparkles", "tone-violet")} <span><strong>Passt der Plan?</strong> Bestätige den Trip – dann kannst du zu jedem Spiel einen KI-One-Pager mit Stadion, Vereinen, Historie und Tipps erstellen lassen.</span></div>
        <button class="btn btn-primary" onclick="confirmTrip()">${icon("badge-check")} Trip bestätigen</button>
      </div>`;
    }
    const total = plan.selected.length;
    const have = plan.selected.filter(m => trip.briefings && trip.briefings[m.id]).length;
    const date = new Date(trip.confirmed.at).toLocaleDateString("de-DE");
    const batchInfo = batch ? ` · erstelle ${batch.done + 1} von ${batch.total} …` : "";
    return `<div class="confirm-bar confirmed">
      <div class="confirm-text">${icon("badge-check", "tone-green")} <span><strong>Trip bestätigt</strong> am ${date} · ${icon("book-open")} ${have}/${total} One-Pager${batchInfo}</span></div>
      <div class="confirm-actions">
        ${have < total && !batch ? `<button class="btn btn-soft" onclick="generateMissingBriefings()" ${busy ? "disabled" : ""}>${icon("sparkles")} Alle fehlenden erstellen</button>` : ""}
        <button class="btn btn-ghost" onclick="unconfirmTrip()" title="Bestätigung aufheben (One-Pager bleiben erhalten)" ${busy ? "disabled" : ""}>Aufheben</button>
      </div>
    </div>`;
  };

  window.briefingButtonHtml = function (match) {
    const trip = getActiveTrip();
    if (!trip) return "";
    if (busy && busy.matchId === match.id) {
      return `<button class="link-btn link-violet is-busy" disabled>${icon("loader-circle", "spin")} <span data-brief-progress="${match.id}">${busyLabel()}</span></button>`;
    }
    if (trip.briefings && trip.briefings[match.id]) {
      return `<button class="link-btn link-violet" onclick="openBriefing('${match.id}')">${icon("book-open")} One-Pager</button>`;
    }
    if (!trip.confirmed) return "";
    return `<button class="link-btn link-violet" onclick="createBriefing('${match.id}')" ${busy ? "disabled title=\"Es wird gerade ein anderer One-Pager erstellt\"" : ""}>${icon("sparkles")} One-Pager erstellen</button>`;
  };

  // Nach "Keine Tickets": Ersatzspiele bekommen einfach den Button "One-Pager erstellen"
  window.afterPlanRepaired = function () {};

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

  function renderBriefingModal(matchId, error = "") {
    const isBusy = !!(busy && busy.matchId === matchId);
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
        ${isBusy ? `<div class="empty-state loading">${icon("sparkles", "tone-violet")}<p>Gemini schreibt den One-Pager …</p><p class="muted" data-brief-progress="${match.id}">${busyLabel()}</p></div>`
          : b ? briefingHtml(match, b) : `<div class="empty-state">${icon("book-open", "tone-violet")}<p>Noch kein One-Pager vorhanden.</p></div>`}
      </div>
      <div class="modal-actions">
        <button class="btn btn-ghost" onclick="regenerateBriefing('${match.id}')" ${busy ? "disabled" : ""}>${icon("refresh-cw")} Neu erstellen</button>
        <button class="btn btn-primary" onclick="printBriefing('${match.id}')" ${isBusy || !b ? "disabled" : ""}>${icon("printer")} Drucken</button>
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
