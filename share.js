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

  // "z." = komprimiert, "j." = unkomprimiert (Fallback für alte Browser)
  async function encode(obj) {
    const bytes = new TextEncoder().encode(JSON.stringify(obj));
    if (canCompress) return "z." + toB64url(await pipe(bytes, new CompressionStream("deflate-raw")));
    return "j." + toB64url(bytes);
  }
  async function decode(str) {
    const [kind, data] = [str.slice(0, 2), str.slice(2)];
    let bytes = fromB64url(data);
    if (kind === "z.") {
      if (!canCompress) throw new Error("Dieser Browser kann den Link nicht entpacken.");
      bytes = await pipe(bytes, new DecompressionStream("deflate-raw"));
    } else if (kind !== "j.") {
      throw new Error("Unbekanntes Link-Format.");
    }
    return JSON.parse(new TextDecoder().decode(bytes));
  }

  // ---------- Link erzeugen ----------
  async function buildShareLink(trip) {
    const shared = serializeTrip(trip);
    const { briefings, ...withoutBriefings } = shared; // One-Pager bleiben lokal
    const payload = { type: "groundhopping_trip", version: 1, settings: trip.settings, trip: withoutBriefings };
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
    const long = link.length > 8000;
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
      payload = await decode(data);
    } catch (err) {
      console.error("Geteilter Link:", err);
      alert("Der geteilte Link ist beschädigt oder unvollständig (evtl. vom Messenger gekürzt).");
      return;
    }
    const result = normalizeImportedTrip(payload && payload.trip, payload && payload.plans, payload && payload.settings);
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
