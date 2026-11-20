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
  const IDLE_TIMEOUT_MS = 60000;           // Abbruch (bzw. Ausweichen), wenn so lange gar keine Daten mehr kommen
  // Ausweich-Modelle, falls das gewünschte überlastet ist, fehlt oder hängt (Reihenfolge = Priorität)
  const FALLBACK_MODELS = ["gemini-flash-lite-latest", "gemini-3.6-flash", "gemini-3.5-flash-lite"];
  const OVERLOAD_RETRY_WAIT_MS = 4000;     // kurze Pause, bevor dasselbe Modell noch einmal versucht wird
  let lastWorkingModel = null;             // zuletzt erfolgreiches Modell (nur für diese Sitzung)
  const TOTAL_TIMEOUT_MS = 360000;         // absolute Obergrenze pro One-Pager
  let thinkingUnsupported = false;         // ältere Modelle kennen thinkingLevel nicht
  const searchUnsupported = new Set();     // Modelle, bei denen die Google-Suche (Grounding) nicht geht

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
    const started = Date.now();
    try {
      await callGemini({ apiKey, model }, "Antworte nur mit dem Wort OK.", null, { json: false, retries: 0, fallback: false });
      setKeyStatus(`Verbindung klappt (Modell: ${model}, Antwort nach ${((Date.now() - started) / 1000).toFixed(1).replace(".", ",")} s).`, "ok");
    } catch (err) {
      setKeyStatus(errorText(err), "error");
    }
  };

  // ---------- Gemini-Aufruf ----------
  // kind: "overloaded" (ausgelastet), "timeout" (hängt), "model_missing" -> anderes Modell versuchen; sonst null
  class GeminiError extends Error {
    constructor(message, diag = null, kind = null) { super(message); this.diag = diag; this.kind = kind; }
  }
  const OVERLOAD_RE = /high demand|overloaded|unavailable|try again later|capacity/i;

  // Diagnose eines Aufrufs – wird live angezeigt und bei Fehlern an die Meldung gehängt
  function newDiag(model) {
    return { model, started: Date.now(), headersAfter: null, status: null, bytes: 0, events: 0, thoughtChars: 0, textChars: 0, finishReason: null, sample: "" };
  }
  function diagText(d) {
    if (!d) return "";
    const secs = s => `${Math.round(s / 1000)} s`;
    const parts = [`Modell ${d.model}`, `Dauer ${secs(Date.now() - d.started)}`];
    parts.push(d.headersAfter === null ? "keine Antwort vom Server" : `HTTP ${d.status} nach ${secs(d.headersAfter)}`);
    parts.push(`${d.events} Datenpakete`, `${d.thoughtChars} Zeichen Gedanken`, `${d.textChars} Zeichen Text`);
    if (d.finishReason) parts.push(`Ende: ${d.finishReason}`);
    return parts.join(" · ");
  }

  function connectionError(err, reason, started) {
    console.error("Gemini-Anfrage fehlgeschlagen:", err);
    const secs = Math.round((Date.now() - started) / 1000);
    if (reason === "idle") return new GeminiError(`Gemini hat ${secs} Sekunden lang keine Daten mehr geschickt.`, null, "timeout");
    if (reason === "total") return new GeminiError(`Abbruch nach ${secs} Sekunden – die Antwort dauert zu lange.`, null, "timeout");
    if (typeof navigator !== "undefined" && navigator.onLine === false) return new GeminiError("Keine Internetverbindung.");
    return new GeminiError("Die Verbindung zu Gemini wurde blockiert (generativelanguage.googleapis.com). Häufige Ursache: ein Werbe-/Tracking-Blocker oder eine Firewall – bitte für diese Seite deaktivieren und erneut versuchen.");
  }

  // Ruft Gemini im Streaming-Modus auf (Server-Sent Events) und liefert den kompletten Antworttext.
  // onProgress(diag) wird bei jedem empfangenen Stück aufgerufen.
  // Bei Überlastung: dasselbe Modell nach kurzer Pause noch einmal, dann die Ausweich-Modelle.
  // onModel(modell, istAusweich) meldet, welches Modell gerade versucht wird. Liefert { text, model }.
  async function callGemini(ai, prompt, systemText, { json = true, retries = 1, onProgress = null, onModel = null, fallback = true, search = false } = {}) {
    const order = fallback
      ? [...new Set([lastWorkingModel, ai.model, ...FALLBACK_MODELS].filter(Boolean))]
      : [ai.model];
    const tried = [];
    let lastErr = null;
    for (const model of order) {
      for (let round = 0; round < 2; round++) {
        if (onModel) onModel(model, model !== ai.model);
        try {
          const result = await callGeminiInner({ ...ai, model }, prompt, systemText, { json, retries, onProgress, search });
          if (fallback) lastWorkingModel = model;
          return { ...result, model };
        } catch (err) {
          if (err instanceof GeminiError && err.diag) console.warn("Gemini-Diagnose:", diagText(err.diag), err.diag.sample);
          lastErr = err;
          if (!(err instanceof GeminiError) || !fallback) throw err;
          if (err.kind === "overloaded" && round === 0) {
            await sleep(OVERLOAD_RETRY_WAIT_MS); // kurze Spitze? Einmal neu versuchen
            continue;
          }
          if (["overloaded", "timeout", "model_missing"].includes(err.kind)) break; // nächstes Modell
          throw err; // z. B. Schlüssel ungültig, Kontingent aufgebraucht
        }
      }
      tried.push(model);
      if (lastWorkingModel === model) lastWorkingModel = null;
    }
    if (lastErr && lastErr.kind === "model_missing" && tried.length === 1) throw lastErr;
    throw new GeminiError(`Alle Gemini-Modelle sind gerade ausgelastet (versucht: ${tried.join(", ")}). Das liegt bei Google und ist meist nach ein paar Minuten vorbei – bitte später erneut versuchen.`, lastErr && lastErr.diag);
  }

  async function callGeminiInner(ai, prompt, systemText, { json, retries, onProgress, search }) {
    // Google-Suche (Grounding) für aktuelle Infos; JSON-Modus ist zusammen mit Tools nicht überall erlaubt,
    // daher wird das JSON-Format dann nur per Prompt verlangt und tolerant geparst.
    const useSearch = () => search && !searchUnsupported.has(ai.model);
    const buildBody = () => {
      const generationConfig = { temperature: 0.4, ...(json && !useSearch() ? { responseMimeType: "application/json" } : {}) };
      // Kurz "nachdenken" lassen: deutlich schnellere Antworten bei Fakten-Texten
      // Gedanken mitschicken lassen: so sieht man den Fortschritt und die Verbindung bleibt aktiv
      if (!thinkingUnsupported) generationConfig.thinkingConfig = { thinkingLevel: "low", includeThoughts: true };
      const body = { contents: [{ role: "user", parts: [{ text: prompt }] }], generationConfig };
      if (systemText) body.systemInstruction = { parts: [{ text: systemText }] };
      if (useSearch()) body.tools = [{ google_search: {} }];
      return JSON.stringify(body);
    };

    for (let attempt = 0; ; attempt++) {
      const ctrl = new AbortController();
      const started = Date.now();
      const diag = newDiag(ai.model);
      if (onProgress) onProgress(diag);
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
          const e = connectionError(err, reason, started); e.diag = diag; throw e;
        }
        diag.headersAfter = Date.now() - started;
        diag.status = res.status;
        if (onProgress) onProgress(diag);

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
          // Google-Suche nicht verfügbar (Modell/Kontingent) -> ohne Suche erneut versuchen
          if (useSearch() && (res.status === 400 || res.status === 403 || res.status === 429) && /search|grounding|tool/i.test(msg)) {
            searchUnsupported.add(ai.model);
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
          if (res.status === 404) throw new GeminiError(`Das Modell „${ai.model}“ wurde nicht gefunden. Bitte in den Einstellungen ein anderes Modell eintragen.`, diag, "model_missing");
          if (res.status >= 500 || OVERLOAD_RE.test(msg)) throw new GeminiError(`Das Modell ${ai.model} ist gerade ausgelastet.`, diag, "overloaded");
          throw new GeminiError(`Gemini-Fehler: ${msg}`, diag);
        }

        // Stream lesen: Zeilen "data: {...}"
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "", text = "", finishReason = null, blockReason = null;
        const searchRequested = useSearch();
        const grounding = { used: false, sources: [], entryPoint: "", queries: [] };
        const handleLine = line => {
          line = line.trim();
          if (!line.startsWith("data:")) return;
          let ev;
          try { ev = JSON.parse(line.slice(5).trim()); } catch (e) { return; }
          diag.events++;
          if (diag.sample.length < 600) diag.sample += line.slice(0, 600 - diag.sample.length);
          if (ev.error) {
            const m = ev.error.message || "unbekannt";
            const overloaded = ev.error.code >= 500 || OVERLOAD_RE.test(m) || ev.error.status === "UNAVAILABLE";
            throw new GeminiError(overloaded ? `Das Modell ${ai.model} ist gerade ausgelastet.` : `Gemini-Fehler: ${m}`, diag, overloaded ? "overloaded" : null);
          }
          if (ev.promptFeedback && ev.promptFeedback.blockReason) blockReason = ev.promptFeedback.blockReason;
          const cand = ev.candidates && ev.candidates[0];
          if (!cand) return;
          const parts = (cand.content && cand.content.parts) || [];
          parts.forEach(p => {
            if (!p.text) return;
            if (p.thought) diag.thoughtChars += p.text.length;
            else text += p.text;
          });
          diag.textChars = text.length;
          if (cand.finishReason) finishReason = diag.finishReason = cand.finishReason;
          const gm = cand.groundingMetadata;
          if (gm) {
            (gm.groundingChunks || []).forEach(c => {
              const w = c && c.web;
              if (w && w.uri && !grounding.sources.some(x => x.uri === w.uri)) grounding.sources.push({ uri: w.uri, title: w.title || w.uri });
            });
            if (gm.searchEntryPoint && gm.searchEntryPoint.renderedContent) grounding.entryPoint = gm.searchEntryPoint.renderedContent;
            (gm.webSearchQueries || []).forEach(q => { if (!grounding.queries.includes(q)) grounding.queries.push(q); });
          }
        };
        for (;;) {
          let chunk;
          try { chunk = await reader.read(); } catch (err) { const e = connectionError(err, reason, started); e.diag = diag; throw e; }
          if (chunk.done) break;
          armIdle();
          diag.bytes += chunk.value.length;
          buffer += decoder.decode(chunk.value, { stream: true });
          let nl;
          while ((nl = buffer.indexOf("\n")) >= 0) {
            handleLine(buffer.slice(0, nl));
            buffer = buffer.slice(nl + 1);
          }
          if (onProgress) onProgress(diag);
        }
        handleLine(buffer);

        if (!text) {
          throw new GeminiError(blockReason
            ? "Gemini hat die Anfrage blockiert (Inhaltsfilter)."
            : "Gemini hat keine Antwort geliefert. Bitte erneut versuchen.", diag);
        }
        if (finishReason === "MAX_TOKENS" && json) {
          try { parseJsonLoose(text); } catch (e) { throw new GeminiError("Die Antwort von Gemini wurde abgeschnitten. Bitte erneut versuchen.", diag); }
        }
        grounding.used = searchRequested && (grounding.sources.length > 0 || grounding.queries.length > 0);
        grounding.requested = searchRequested;
        return { text, grounding };
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
  const SYSTEM_TEXT = `Du bist ein erfahrener Groundhopper und Fußballjournalist und schreibst prägnante One-Pager auf Deutsch – mit vielen konkreten Fakten und wenig Floskeln.
Regeln:
- Nutze die Google-Suche für alles Aktuelle (Tabelle, Form, direkte Duelle, News, Fanszene). Übernimm nur, was die Suchergebnisse belegen.
- Erfinde keine Zahlen, Ergebnisse, Daten, Namen oder Zitate. Fehlt eine Info, lass das Feld leer bzw. die Liste leer.
- Keine allgemeinen Füllsätze ("packendes Spiel", "tolle Atmosphäre"). Lieber kurz und konkret.
- Antworte ausschließlich mit einem einzigen gültigen JSON-Objekt im vorgegebenen Format, ohne Markdown und ohne Text davor oder danach.`;

  function buildPrompt(m) {
    const competition = typeof matchContextLabel === "function" ? matchContextLabel(m).replace(/<[^>]+>/g, "") : "";
    const today = new Date().toISOString().slice(0, 10);
    return `Heute ist der ${today}. Erstelle einen One-Pager für dieses Fußballspiel:
- Heim: ${m.home}
- Gast: ${m.away}
- Wettbewerb: ${competition}
- Termin: ${formatDateLong(m.date)}, Anstoß ${m.time} Uhr (Wochentag bitte genau so übernehmen)
- Stadion: ${m.stadium}${m.resolvedAddress ? ` (${m.resolvedAddress})` : ""}
- Land: ${(m.countryCode || "").toUpperCase()}

Recherchiere per Google-Suche:
1. Aktueller Tabellenplatz, Punkte, Spiele und die letzten 5 Ligaspiele (Form) beider Teams.
2. Die letzten bis zu 10 Pflichtspiel-Begegnungen der beiden Teams gegeneinander (neueste zuerst) mit Datum, Wettbewerb, Heim-/Gastteam und Ergebnis.
3. Aktuelle News beider Clubs aus den letzten 4 Wochen: Trainer, Verletzte/Sperren, Transfers, Vereinspolitik – und besonders die Fanszene (Stimmungsboykott, Streik, Proteste, Choreos, Stadionverbote, Auswärtsverbote, Ticketpreise).
4. Trivia: überraschende, konkrete Fakten zu Stadion, Vereinen und Begegnung (Rekorde, Kuriositäten, berühmte Spieler, Ursprung von Spitznamen, Anekdoten).

Gib JSON in genau diesem Format zurück:
{
  "asOf": "Datum des neuesten verwendeten Infostands (YYYY-MM-DD)",
  "intro": "1–2 Sätze: Worum geht es sportlich in diesem Spiel konkret?",
  "clubs": [
    {
      "name": "${m.home}",
      "color": "#RRGGBB Hauptvereinsfarbe",
      "table": {"league": "Liga", "position": 0, "points": 0, "played": 0},
      "form": "z. B. SSUNS (S=Sieg, U=Unentschieden, N=Niederlage; ältestes zuerst)",
      "news": [{"date": "YYYY-MM-DD", "title": "Schlagzeile", "text": "1–2 Sätze"}],
      "fanScene": "Aktueller Stand der Fanszene in 1–2 Sätzen (leer, wenn nichts bekannt)",
      "fanAlert": false
    },
    { "name": "${m.away}", "color": "#RRGGBB", "table": {}, "form": "", "news": [], "fanScene": "", "fanAlert": false }
  ],
  "h2h": [{"date": "YYYY-MM-DD", "competition": "Wettbewerb", "home": "Heimteam", "away": "Gastteam", "homeGoals": 0, "awayGoals": 0}],
  "stadium": {"name": "offizieller Name", "opened": "Jahr", "capacity": "Plätze", "trivia": ["konkreter Fakt"]},
  "trivia": ["6–10 konkrete, überraschende Fakten zu Vereinen und Begegnung"],
  "tips": [{"title": "kurz", "text": "konkreter Tipp für Groundhopper (Anreise, Block/Kurve, Essen/Trinken vor Ort)"}],
  "caveats": ["was du nicht sicher finden konntest"]
}
"fanAlert" nur auf true setzen, wenn die Fanszene aktuell etwas Außergewöhnliches macht (Boykott, Streik, Protest, Spiel unter Ausschluss/Teilausschluss).`;
  }

  // ---------- Antwort prüfen & bereinigen (Ausgabe wird nur escaped angezeigt) ----------
  const txt = (v, max = 800) => (typeof v === "string" ? v.trim().slice(0, max) : (typeof v === "number" ? String(v) : ""));
  const list = (v, n = 6) => (Array.isArray(v) ? v.slice(0, n) : []);
  const int = v => { const n = parseInt(v, 10); return Number.isFinite(n) && n >= 0 && n < 1000 ? n : null; };
  const isoDate = v => (typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v.trim()) ? v.trim() : "");
  const hexColor = v => (typeof v === "string" && /^#[0-9a-f]{6}$/i.test(v.trim()) ? v.trim() : "");
  const facts = v => list(v, 8).map(f => ({ label: txt(f && f.label, 60), value: txt(f && f.value, 160) })).filter(f => f.label && f.value);
  const stories = v => list(v).map(s => ({ title: txt(s && s.title, 120), text: txt(s && s.text) })).filter(s => s.text);
  const FORM_MAP = { S: "S", W: "S", U: "U", D: "U", N: "N", L: "N" };

  function sanitizeV2(raw) {
    const r = raw && typeof raw === "object" ? raw : {};
    const st = r.stadium || {};
    return {
      v: 2,
      asOf: isoDate(r.asOf),
      intro: txt(r.intro, 500),
      clubs: list(r.clubs, 2).map(c => {
        const t = (c && c.table) || {};
        return {
          name: txt(c && c.name, 80),
          color: hexColor(c && c.color),
          table: { league: txt(t.league, 60), position: int(t.position), points: int(t.points), played: int(t.played) },
          form: String((c && c.form) || "").toUpperCase().split("").map(ch => FORM_MAP[ch]).filter(Boolean).slice(-5).join(""),
          news: list(c && c.news, 5).map(n => ({ date: isoDate(n && n.date), title: txt(n && n.title, 160), text: txt(n && n.text, 400) })).filter(n => n.title || n.text),
          fanScene: txt(c && c.fanScene, 400),
          fanAlert: !!(c && c.fanAlert === true)
        };
      }).filter(c => c.name),
      h2h: list(r.h2h, 10).map(g => ({
        date: isoDate(g && g.date), competition: txt(g && g.competition, 60),
        home: txt(g && g.home, 80), away: txt(g && g.away, 80),
        homeGoals: int(g && g.homeGoals), awayGoals: int(g && g.awayGoals)
      })).filter(g => g.home && g.away && g.homeGoals !== null && g.awayGoals !== null),
      stadium: { name: txt(st.name, 120), opened: txt(st.opened, 40), capacity: txt(st.capacity, 40), trivia: list(st.trivia, 6).map(t => txt(t, 300)).filter(Boolean) },
      trivia: list(r.trivia, 10).map(t => txt(t, 350)).filter(Boolean),
      tips: stories(r.tips).slice(0, 5),
      caveats: list(r.caveats, 6).map(c => txt(c, 300)).filter(Boolean)
    };
  }

  // Ältere One-Pager (Version 1) weiterhin anzeigen können
  function sanitizeV1(raw) {
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
  const sanitizeBriefingContent = raw => (raw && raw.v === 2 ? sanitizeV2(raw) : sanitizeV1(raw));

  function sanitizeSources(v) {
    return list(v, 12).map(x => ({ uri: safeHttpUrl(x && x.uri), title: txt(x && x.title, 160) })).filter(x => x.uri);
  }

  // Für Import: gespeicherte One-Pager prüfen
  window.sanitizeStoredBriefing = function (raw) {
    if (!raw || typeof raw !== "object" || !raw.content) return null;
    return {
      createdAt: txt(raw.createdAt, 40),
      model: txt(raw.model, 80),
      searchUsed: !!raw.searchUsed,
      sources: sanitizeSources(raw.sources),
      entryPoint: typeof raw.entryPoint === "string" ? raw.entryPoint.slice(0, 30000) : "",
      content: sanitizeBriefingContent(raw.content)
    };
  };

  function parseJsonLoose(text) {
    const cleaned = text.replace(/```(?:json)?/gi, "");
    try { return JSON.parse(cleaned); } catch (e) { /* weiter */ }
    const start = cleaned.indexOf("{"), end = cleaned.lastIndexOf("}");
    if (start !== -1 && end > start) {
      try { return JSON.parse(cleaned.slice(start, end + 1)); } catch (e) { /* unten */ }
    }
    throw new GeminiError("Die Antwort von Gemini war kein gültiges JSON. Bitte erneut versuchen.");
  }

  async function generateBriefing(trip, match, ai) {
    busy = { matchId: match.id, started: Date.now(), diag: null };
    updateBusyIndicators();
    try {
      const { text, model, grounding } = await callGemini(ai, buildPrompt(match), SYSTEM_TEXT, {
        search: true,
        onProgress: diag => { if (busy) { busy.diag = diag; updateBusyIndicators(); } },
        onModel: (m, isFallback) => { if (busy) { busy.model = m; busy.fallback = isFallback; busy.diag = null; updateBusyIndicators(); } }
      });
      const parsed = parseJsonLoose(text);
      const content = sanitizeV2({ ...parsed, v: 2 });
      if (!trip.briefings) trip.briefings = {};
      trip.briefings[match.id] = {
        createdAt: new Date().toISOString(), model, content,
        searchUsed: !!(grounding && grounding.used),
        sources: sanitizeSources(grounding && grounding.sources),
        entryPoint: (grounding && grounding.entryPoint) || ""
      };
      saveLocalStorage();
    } finally {
      busy = null;
    }
  }

  // Fortschritt live in Buttons/Modal schreiben, ohne alles neu zu zeichnen
  function busyLabel() {
    if (!busy) return "";
    const d = busy.diag;
    const secs = `${Math.round((Date.now() - busy.started) / 1000)} s`;
    const k = n => (n >= 1000 ? (n / 1000).toFixed(1).replace(".", ",") + "k" : String(n));
    const via = busy.fallback ? ` (weiche aus auf ${busy.model})` : "";
    if (!d || d.headersAfter === null) return `Warte auf Gemini … ${secs}${via}`;
    if (d.textChars) return `Schreibt … ${k(d.textChars)} Zeichen`;
    if (d.thoughtChars) return `Denkt nach … ${secs} · ${k(d.thoughtChars)} Zeichen Gedanken${via}`;
    return `Verbunden, wartet auf Antwort … ${secs}${via}`;
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
  const errorText = err => (err instanceof GeminiError
    ? err.message + (err.diag ? ` [Details: ${diagText(err.diag)}]` : "")
    : "Beim Erstellen des One-Pagers ist ein Fehler aufgetreten.");

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
  const fmtDay = iso => { const d = new Date(`${iso}T12:00:00`); return isNaN(d) ? "" : d.toLocaleDateString("de-DE", { day: "2-digit", month: "2-digit", year: "2-digit" }); };

  // Lesbare Textfarbe auf einer Vereinsfarbe
  function onColor(hex) {
    const n = parseInt(hex.slice(1), 16), r = n >> 16, g = (n >> 8) & 255, b = n & 255;
    return (0.299 * r + 0.587 * g + 0.114 * b) > 160 ? "#111" : "#fff";
  }
  const DEFAULT_CLUB_COLORS = ["#2563eb", "#dc2626"];
  const norm = v => String(v || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
  // Welcher der beiden Vereine ist gemeint? (tolerant: "FC Metz" vs. "Metz")
  function clubIndex(name, clubs) {
    const n = norm(name);
    const words = s => norm(s).split(" ").filter(w => w.length > 2 && !["fc", "sc", "sv", "usl", "afc", "cf", "ac", "rc", "us", "as", "club", "royal"].includes(w));
    let best = -1, bestScore = 0;
    clubs.forEach((c, i) => {
      const cn = norm(c.name);
      let score = cn === n ? 100 : (cn.includes(n) || n.includes(cn)) ? 50 : 0;
      score += words(c.name).filter(w => n.includes(w)).length * 10;
      if (score > bestScore) { bestScore = score; best = i; }
    });
    return best;
  }

  function clubStyle(c, i) {
    const color = c.color || DEFAULT_CLUB_COLORS[i] || "#64748b";
    return { color, text: onColor(color) };
  }

  function tableHtml(clubs) {
    const rows = clubs.map((c, i) => {
      const st = clubStyle(c, i), t = c.table;
      const pos = t.position ? `<span class="tb-pos">${t.position}.</span>` : `<span class="tb-pos muted">–</span>`;
      const meta = [t.points !== null ? `${t.points} Pkt.` : "", t.played !== null ? `${t.played} Sp.` : "", t.league].filter(Boolean).join(" · ");
      const form = c.form ? `<span class="form-strip">${c.form.split("").map(f => `<span class="form-${f}" title="${({ S: "Sieg", U: "Unentschieden", N: "Niederlage" })[f]}">${f}</span>`).join("")}</span>` : "";
      return `<div class="tb-row">${pos}<span class="club-dot" style="background:${st.color}"></span><strong>${escapeHtml(c.name)}</strong><span class="muted tb-meta">${escapeHtml(meta)}</span>${form}</div>`;
    }).join("");
    return rows ? `<div class="tb">${rows}</div>` : "";
  }

  function h2hHtml(games, clubs) {
    if (!games.length) return `<p class="muted">Keine verlässlichen Daten zu früheren Duellen gefunden.</p>`;
    const tally = [0, 0, 0]; // Siege Verein 0, Remis, Siege Verein 1
    const rows = games.map(g => {
      const draw = g.homeGoals === g.awayGoals;
      const winnerName = draw ? null : (g.homeGoals > g.awayGoals ? g.home : g.away);
      const wi = draw ? -1 : clubIndex(winnerName, clubs);
      if (draw) tally[1]++; else if (wi === 0) tally[0]++; else if (wi === 1) tally[2]++;
      const st = wi >= 0 ? clubStyle(clubs[wi], wi) : null;
      const badge = draw
        ? `<span class="res res-draw" title="Unentschieden">${icon("scale")}</span>`
        : `<span class="res" style="background:${st ? st.color : "#475569"};color:${st ? st.text : "#fff"}" title="Sieg ${escapeHtml(winnerName)}">${icon("trophy")}</span>`;
      const team = (name, won) => `<span class="${won ? "h2h-win" : ""}">${escapeHtml(name)}</span>`;
      return `<div class="h2h-row">${badge}<span class="h2h-date muted">${fmtDay(g.date)}</span>
        <span class="h2h-match">${team(g.home, !draw && g.homeGoals > g.awayGoals)} <b class="h2h-score">${g.homeGoals}:${g.awayGoals}</b> ${team(g.away, !draw && g.awayGoals > g.homeGoals)}</span>
        <span class="h2h-comp muted">${escapeHtml(g.competition)}</span></div>`;
    }).join("");
    const total = tally[0] + tally[1] + tally[2] || 1;
    const seg = (n, color, label) => n ? `<span style="flex:${n};background:${color}" title="${label}: ${n}">${n}</span>` : "";
    const c0 = clubs[0] ? clubStyle(clubs[0], 0) : { color: DEFAULT_CLUB_COLORS[0] };
    const c1 = clubs[1] ? clubStyle(clubs[1], 1) : { color: DEFAULT_CLUB_COLORS[1] };
    const bar = `<div class="h2h-bar">${seg(tally[0], c0.color, clubs[0] ? `Siege ${clubs[0].name}` : "Siege")}${seg(tally[1], "#9ca3af", "Unentschieden")}${seg(tally[2], c1.color, clubs[1] ? `Siege ${clubs[1].name}` : "Siege")}</div>
      <div class="h2h-legend"><span>${clubs[0] ? escapeHtml(clubs[0].name) : ""} <b>${tally[0]}</b></span><span class="muted">Remis <b>${tally[1]}</b></span><span>${clubs[1] ? escapeHtml(clubs[1].name) : ""} <b>${tally[2]}</b></span></div>`;
    return (total > 0 ? bar : "") + `<div class="h2h-list">${rows}</div>`;
  }

  function newsHtml(clubs) {
    const alerts = clubs.filter(c => c.fanAlert && c.fanScene)
      .map(c => bannerHtml("warning", `<strong>Fanszene ${escapeHtml(c.name)}:</strong> ${escapeHtml(c.fanScene)}`, "users")).join("");
    const items = [];
    clubs.forEach((c, i) => {
      const st = clubStyle(c, i);
      c.news.forEach(n => items.push({ ...n, club: c.name, st }));
      if (c.fanScene && !c.fanAlert) items.push({ date: "", title: "Fanszene", text: c.fanScene, club: c.name, st });
    });
    items.sort((a, b) => (b.date || "").localeCompare(a.date || ""));
    const list = items.map(n => `<li class="news-item">
        <span class="club-tag" style="background:${n.st.color};color:${n.st.text}">${escapeHtml(n.club)}</span>
        ${n.date ? `<span class="muted news-date">${fmtDay(n.date)}</span>` : ""}
        <div><strong>${escapeHtml(n.title)}</strong>${n.text ? ` – ${escapeHtml(n.text)}` : ""}</div></li>`).join("");
    return alerts + (list ? `<ul class="news">${list}</ul>` : `<p class="muted">Keine aktuellen News gefunden.</p>`);
  }

  function sourcesHtml(b) {
    const src = (b.sources || []).slice(0, 8);
    const links = src.map(x => `<a href="${escapeHtml(x.uri)}" target="_blank" rel="noopener noreferrer">${escapeHtml(x.title)}</a>`).join(" · ");
    // Von Google vorgeschriebene Suchvorschläge – isoliert in einem Sandbox-iframe (ohne Skripte)
    const entry = b.entryPoint
      ? `<iframe class="search-entry" sandbox="allow-popups allow-popups-to-escape-sandbox" srcdoc="${escapeHtml(b.entryPoint)}" title="Google-Suchvorschläge"></iframe>`
      : "";
    return links || entry ? `<div class="bp-sources">${links ? `<div class="src-links">${icon("search")} <span>Quellen: ${links}</span></div>` : ""}${entry}</div>` : "";
  }

  function briefingHtml(match, b) {
    const c = b.content;
    if (!c || c.v !== 2) return legacyBriefingHtml(match, b);
    const section = (tone, iconName, title, body) => body && body.trim()
      ? `<section class="bp-section"><h4><span class="chip chip-${tone}">${icon(iconName)}</span> ${title}</h4>${body}</section>` : "";
    const stadiumLine = [c.stadium.name, c.stadium.opened && `eröffnet ${c.stadium.opened}`, c.stadium.capacity && `${c.stadium.capacity} Plätze`].filter(Boolean).map(escapeHtml).join(" · ");
    const trivia = [...c.stadium.trivia, ...c.trivia];
    return `<article class="briefing v2">
      ${b.searchUsed ? "" : bannerHtml("info", "Ohne aktuelle Google-Suche erstellt – Tabelle, Duelle und News können veraltet oder lückenhaft sein.")}
      ${c.intro ? `<p class="bp-lead">${escapeHtml(c.intro)}</p>` : ""}
      ${section("blue", "list-checks", `Tabelle &amp; Form${c.asOf ? ` <span class="muted as-of">Stand ${fmtDay(c.asOf)}</span>` : ""}`, tableHtml(c.clubs))}
      ${section("amber", "history", "Direkter Vergleich – letzte Duelle", h2hHtml(c.h2h, c.clubs))}
      ${section("red", "info", "Aktuelles aus den Clubs", newsHtml(c.clubs))}
      ${section("violet", "lightbulb", "Wusstest du schon?",
        (stadiumLine ? `<p class="stadium-line">${icon("landmark")} ${stadiumLine}</p>` : "") +
        (trivia.length ? `<ul class="trivia">${trivia.map(t => `<li>${escapeHtml(t)}</li>`).join("")}</ul>` : ""))}
      ${section("green", "map-pin", "Tipps vor Ort", c.tips.length ? `<ul class="tips">${c.tips.map(t => `<li><strong>${escapeHtml(t.title)}:</strong> ${escapeHtml(t.text)}</li>`).join("")}</ul>` : "")}
      <footer class="bp-footer">
        ${sourcesHtml(b)}
        <div>${icon("sparkles")} KI-generiert mit ${escapeHtml(b.model || "Gemini")}${b.searchUsed ? " und Google-Suche" : ""} am ${new Date(b.createdAt).toLocaleDateString("de-DE")} – Angaben ohne Gewähr.
        ${c.caveats.length ? `<br><span class="muted">Nicht sicher gefunden: ${c.caveats.map(escapeHtml).join(" · ")}</span>` : ""}</div>
      </footer>
    </article>`;
  }

  function legacyBriefingHtml(match, b) {
    const c = b.content;
    const section = (tone, iconName, title, body) => body.trim()
      ? `<section class="bp-section"><h4><span class="chip chip-${tone}">${icon(iconName)}</span> ${title}</h4>${body}</section>` : "";
    return `<article class="briefing">
      ${bannerHtml("info", "Älterer One-Pager ohne Tabelle, Duelle und News – mit „Neu erstellen“ bekommst du die neue Version.")}
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
      <footer class="bp-footer">${icon("sparkles")} KI-generiert mit ${escapeHtml(b.model || "Gemini")} am ${new Date(b.createdAt).toLocaleDateString("de-DE")} – Angaben ohne Gewähr.</footer>
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
