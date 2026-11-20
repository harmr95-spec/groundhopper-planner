/* =========================================================================
   Trip per Link teilen – ganz ohne Server.
   Der Trip wird komprimiert (deflate) und Base64url-kodiert in den Teil des
   Links hinter "#" geschrieben. Dieser Teil wird vom Browser nie an einen
   Server geschickt. Beim Öffnen des Links wird der Trip als neuer Trip
   importiert (über dieselbe Prüfung wie beim Datei-Import).
   One-Pager werden nicht mitgeschickt (zu groß für einen Link).
   ========================================================================= */
(function () {
  "use strict";

  const HASH_PREFIX = "#trip=";

  // ---------- Kodierung ----------
  const toB64url = bytes => {
    let bin = "";
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  };
  const fromB64url = str => {
    const bin = atob(str.replace(/-/g, "+").replace(/_/g, "/"));
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  };
  const canCompress = typeof CompressionStream === "function" && typeof DecompressionStream === "function";

  async function pipe(bytes, stream) {
    const out = await new Response(new Blob([bytes]).stream().pipeThrough(stream)).arrayBuffer();
    return new Uint8Array(out);
  }

  // ---------- Base62: nur Buchstaben und Ziffern ----------
  // Messenger formatieren z. B. "_text_" kursiv oder brechen Links an "-" um. Base62 enthält
  // keine solchen Zeichen. Je 5 Bytes -> 7 Zeichen; der Rest (1–4 Bytes) -> 2/3/5/6 Zeichen.
  const B62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
  const TAIL_CHARS = { 1: 2, 2: 3, 3: 5, 4: 6 };
  const TAIL_BYTES = { 2: 1, 3: 2, 5: 3, 6: 4 };
  function toB62(bytes) {
    let out = "";
    for (let i = 0; i < bytes.length; i += 5) {
      const n = Math.min(5, bytes.length - i);
      let v = 0;
      for (let k = 0; k < n; k++) v = v * 256 + bytes[i + k];
      const len = n === 5 ? 7 : TAIL_CHARS[n];
      let chunk = "";
      for (let k = 0; k < len; k++) { chunk = B62[v % 62] + chunk; v = Math.floor(v / 62); }
      out += chunk;
    }
    return out;
  }
  function fromB62(str) {
    const full = Math.floor(str.length / 7), rest = str.length % 7;
    if (rest && !TAIL_BYTES[rest]) throw new LinkError("damaged");
    const bytes = new Uint8Array(full * 5 + (rest ? TAIL_BYTES[rest] : 0));
    let pos = 0;
    const take = (s, nBytes) => {
      let v = 0;
      for (const ch of s) { const d = B62.indexOf(ch); if (d < 0) throw new LinkError("damaged"); v = v * 62 + d; }
      for (let k = nBytes - 1; k >= 0; k--) { bytes[pos + k] = v % 256; v = Math.floor(v / 256); }
      pos += nBytes;
    };
    for (let i = 0; i < full; i++) take(str.slice(i * 7, i * 7 + 7), 5);
    if (rest) take(str.slice(full * 7), TAIL_BYTES[rest]);
    return bytes;
  }

  class LinkError extends Error {
    constructor(kind, info = {}) { super(kind); this.kind = kind; this.info = info; }
  }

  // Format: "b.<Länge in Base36>.<Base62-Daten>" – die Länge verrät, ob der Link gekürzt wurde.
  // Ältere Links: "z." (Base64url, komprimiert) bzw. "j." (unkomprimiert) werden weiter gelesen.
  async function encode(obj) {
    let bytes = new TextEncoder().encode(JSON.stringify(obj));
    const compressed = canCompress;
    if (compressed) bytes = await pipe(bytes, new CompressionStream("deflate-raw"));
    const data = toB62(bytes);
    return `${compressed ? "b" : "c"}.${data.length.toString(36)}.${data}`;
  }
  async function decode(str) {
    let bytes, compressed;
    const m = /^([bc])\.([0-9a-z]+)\.(.*)$/s.exec(str);
    if (m) {
      compressed = m[1] === "b";
      const expected = parseInt(m[2], 36);
      const data = m[3].replace(/[^0-9A-Za-z]/g, ""); // eingefügte Leer-/Formatierungszeichen entfernen
      if (data.length < expected) throw new LinkError("truncated", { got: data.length, expected });
      bytes = fromB62(data.slice(0, expected));
    } else if (str.startsWith("z.") || str.startsWith("j.")) {
      compressed = str.startsWith("z.");
      try { bytes = fromB64url(str.slice(2)); } catch (e) { throw new LinkError("damaged"); }
    } else {
      throw new LinkError("damaged");
    }
    if (compressed) {
      if (!canCompress) throw new LinkError("browser");
      try { bytes = await pipe(bytes, new DecompressionStream("deflate-raw")); } catch (e) { throw new LinkError("damaged"); }
    }
    try { return JSON.parse(new TextDecoder().decode(bytes)); } catch (e) { throw new LinkError("damaged"); }
  }

  // ---------- Link erzeugen ----------
  async function buildShareLink(trip) {
    // Nur was der Empfänger braucht: One-Pager, interne Zwischenstände und nicht gewählte
    // Alternativen bleiben weg (der Empfänger kann jederzeit neu berechnen).
    const { briefings, routeCountries, plansSettingsKey, ...shared } = serializeTrip(trip); // eslint-disable-line no-unused-vars
    if (Array.isArray(shared.plans) && shared.plans.length) {
      const chosen = shared.plans.find(p => p.signature === trip.selectedPlanSignature) || shared.plans[0];
      shared.plans = [{ ...chosen, description: "", changedDates: [], repairNotes: chosen.repairNotes || [] }];
    }
    const payload = { type: "groundhopping_trip", version: 2, trip: shared };
    const base = location.href.split("#")[0];
    return base + HASH_PREFIX + await encode(payload);
  }

  function ensureModal() {
    let el = document.getElementById("shareModal");
    if (el) return el;
    document.body.insertAdjacentHTML("beforeend", `
      <div id="shareModal" class="modal" onclick="if (event.target === this) closeShareModal()">
        <div class="modal-content share-modal" role="dialog" aria-modal="true" aria-label="Trip teilen"></div>
      </div>`);
    el = document.getElementById("shareModal");
    document.addEventListener("keydown", e => { if (e.key === "Escape" && el.style.display === "flex") closeShareModal(); });
    return el;
  }
  window.closeShareModal = function () {
    const el = document.getElementById("shareModal");
    if (el) el.style.display = "none";
  };

  window.shareActiveTrip = async function () {
    const trip = getActiveTrip();
    if (!trip) return;
    const modal = ensureModal();
    const box = modal.querySelector(".modal-content");
    let link;
    try {
      link = await buildShareLink(trip);
    } catch (err) {
      console.error("Teilen-Link:", err);
      alert("Der Link konnte nicht erstellt werden.");
      return;
    }
    const kbLen = (link.length / 1024).toLocaleString("de-DE", { maximumFractionDigits: 1 });
    const long = link.length > 6000;
    box.innerHTML = `
      <div class="modal-header">
        <div><h2>Trip teilen</h2><p class="settings-hint">„${escapeHtml(trip.name)}“ – Spiele, Startpunkt, Pläne, Tickets und Einstellungen. One-Pager werden nicht mitgeschickt.</p></div>
        <button type="button" class="modal-close" onclick="closeShareModal()" aria-label="Schließen">${icon("x")}</button>
      </div>
      <div class="modal-body">
        <p class="share-explain">${icon("info", "tone-blue")} Der komplette Trip steckt im Link selbst – es wird nichts auf einen Server hochgeladen. Wer den Link öffnet, bekommt den Trip als Kopie in seinen eigenen Planner.</p>
        <textarea id="shareLinkField" class="share-link" readonly rows="4">${escapeHtml(link)}</textarea>
        <p class="settings-hint">Länge: ${link.length.toLocaleString("de-DE")} Zeichen (${kbLen} KB)${long ? " – ziemlich lang; manche Messenger kürzen sehr lange Links. Im Zweifel als Datei exportieren." : ""}</p>
        <p id="shareStatus" class="ai-key-status"></p>
      </div>
      <div class="modal-actions">
        ${navigator.share ? `<button class="btn btn-ghost" onclick="nativeShareTrip()">${icon("external-link")} Teilen …</button>` : ""}
        <button class="btn btn-primary" onclick="copyShareLink()">${icon("download")} Link kopieren</button>
      </div>`;
    modal.style.display = "flex";
    const field = document.getElementById("shareLinkField");
    field.addEventListener("focus", () => field.select());
  };

  window.copyShareLink = async function () {
    const field = document.getElementById("shareLinkField");
    const status = document.getElementById("shareStatus");
    try {
      await navigator.clipboard.writeText(field.value);
    } catch (e) {
      field.focus(); field.select();
      try { document.execCommand("copy"); } catch (e2) { /* manuell kopieren */ }
    }
    status.className = "ai-key-status ok";
    status.innerHTML = `${icon("circle-check")} Link kopiert – jetzt z. B. in WhatsApp einfügen.`;
  };

  window.nativeShareTrip = async function () {
    const trip = getActiveTrip();
    const field = document.getElementById("shareLinkField");
    try { await navigator.share({ title: `Groundhopping-Trip: ${trip.name}`, url: field.value }); } catch (e) { /* abgebrochen */ }
  };

  // ---------- Link öffnen ----------
  async function importFromHash() {
    if (!location.hash.startsWith(HASH_PREFIX)) return;
    const data = location.hash.slice(HASH_PREFIX.length);
    // Link-Teil sofort entfernen, damit ein Neuladen nicht erneut importiert
    history.replaceState(null, "", location.href.split("#")[0]);
    let payload;
    try {
      payload = await decode(decodeURIComponent(data));
    } catch (err) {
      console.error("Geteilter Link:", err);
      const n = v => v.toLocaleString("de-DE");
      alert(err.kind === "truncated"
        ? `Der geteilte Link ist unvollständig angekommen: nur ${n(err.info.got)} von ${n(err.info.expected)} Zeichen. Wahrscheinlich hat der Messenger ihn gekürzt – bitte den Trip als Datei teilen (☰ → Exportieren).`
        : err.kind === "browser"
          ? "Dieser Browser kann den geteilten Link nicht entpacken. Bitte einen aktuellen Browser verwenden oder den Trip als Datei teilen."
          : "Der geteilte Link ist beschädigt (Zeichen wurden verändert). Bitte den Link erneut kopieren oder den Trip als Datei teilen.");
      return;
    }
    const result = normalizeImportedTrip(payload && payload.trip, payload && payload.plans, payload && (payload.settings || (payload.trip && payload.trip.settings)));
    if (!result) { alert("Der geteilte Link enthält keinen gültigen Trip."); return; }
    const t = result.trip;
    if (!confirm(`Geteilten Trip „${t.name}“ mit ${t.matches.length} Spiel(en) in deinen Planner übernehmen?`)) return;
    t.name += " (geteilt)";
    state.trips.push(t);
    state.activeTripId = t.id;
    saveLocalStorage();
    renderTripSelect();
    resetMatchForm();
    renderActiveTrip();
  }

  // Nach dem Start der App (app.js lädt die gespeicherten Trips bei DOMContentLoaded)
  document.addEventListener("DOMContentLoaded", () => setTimeout(importFromHash, 0));
  window.addEventListener("hashchange", importFromHash);
})();
