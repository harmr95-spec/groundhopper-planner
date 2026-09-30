/* Print and calendar export features */
(function () {
  "use strict";

  function escapeIcs(value) {
    return String(value || "")
      .replace(/\\/g, "\\\\")
      .replace(/;/g, "\\;")
      .replace(/,/g, "\\,")
      .replace(/\r?\n/g, "\\n");
  }

  const pad = value => String(value).padStart(2, "0");

  // Floating local time (kein Z-Suffix): Kalender-Apps behalten die Wanduhrzeit des Stadions.
  function formatIcsLocal(date) {
    return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
      `T${pad(date.getHours())}${pad(date.getMinutes())}00`;
  }

  // DTSTAMP muss laut RFC 5545 in UTC mit "Z" stehen.
  function formatIcsUtcNow() {
    return new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  }

  // Spielende inkl. Abreisepuffer: eine einzige Definition (app.js), Fallback nur zur Sicherheit.
  function eventEnd(match, kickoff) {
    if (typeof calculateMatchEndTime === "function") return calculateMatchEndTime(match);
    return new Date(kickoff.getTime() + 115 * 60000);
  }

  function download(filename, content, type) {
    const blob = new Blob([content], { type });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function matchIcs(match) {
    const uid = `${match.id || Date.now()}@groundhopper-planner`;
    const kickoff = new Date(`${match.date}T${match.time || "00:00"}`);
    const end = eventEnd(match, kickoff);
    const summary = `${match.home || "Heimteam"} vs. ${match.away || "Auswärtsteam"}`;
    const description = [
      match.leagueName || "",
      match.mustAttend ? "Highlightspiel" : ""
    ].filter(Boolean).join(" – ");

    return [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "PRODID:-//Groundhopper Planner//DE",
      "CALSCALE:GREGORIAN",
      "METHOD:PUBLISH",
      "BEGIN:VEVENT",
      `UID:${escapeIcs(uid)}`,
      `DTSTAMP:${formatIcsUtcNow()}`,
      `DTSTART:${formatIcsLocal(kickoff)}`,
      `DTEND:${formatIcsLocal(end)}`,
      `SUMMARY:${escapeIcs(summary)}`,
      `LOCATION:${escapeIcs(match.resolvedAddress || match.stadium)}`,
      `DESCRIPTION:${escapeIcs(description)}`,
      "END:VEVENT",
      "END:VCALENDAR",
      ""
    ].join("\r\n");
  }

  window.exportMatchCalendar = function (matchId) {
    const trip = typeof getActiveTrip === "function" ? getActiveTrip() : null;
    const match = trip && trip.matches.find(item => item.id === matchId);
    if (!match) return;
    const filename = `${(match.home || "spiel")}-${(match.away || "").trim()}`
      .replace(/[^a-z0-9äöüß]+/gi, "_").replace(/^_|_$/g, "").toLowerCase();
    download(`${filename || "spiel"}.ics`, matchIcs(match), "text/calendar;charset=utf-8");
  };

  window.printActiveTrip = function () {
    document.body.classList.add("printing-trip");
    window.addEventListener("afterprint", () => {
      document.body.classList.remove("printing-trip");
    }, { once: true });
    window.setTimeout(() => window.print(), 50);
  };

  function addPrintButton() {
    if (document.getElementById("printTripButton")) return;
    const controls = document.querySelector(".header-controls");
    if (!controls) return;
    const button = document.createElement("button");
    button.id = "printTripButton";
    button.className = "btn btn-secondary print-trip-button";
    button.type = "button";
    button.title = "Aktuellen Trip drucken oder als PDF speichern";
    button.textContent = "🖨️ Drucken / PDF";
    button.addEventListener("click", window.printActiveTrip);
    controls.insertBefore(button, controls.querySelector("#settingsModal") || null);
  }

  function addCalendarButtons() {
    document.querySelectorAll(".match-list-item").forEach(item => {
      if (item.querySelector(".match-ics-button")) return;
      const editButton = item.querySelector("button[onclick^=\"editMatch\"]");
      if (!editButton) return;
      const matchId = (editButton.getAttribute("onclick").match(/editMatch\('([^']+)'/) || [])[1];
      if (!matchId) return;
      const button = document.createElement("button");
      button.type = "button";
      button.className = "btn btn-small btn-secondary match-ics-button";
      button.textContent = "📅 .ics";
      button.title = "Dieses Spiel zum Kalender hinzufügen";
      button.addEventListener("click", () => window.exportMatchCalendar(matchId));
      editButton.parentElement.appendChild(button);
    });
  }

  document.addEventListener("DOMContentLoaded", () => {
    addPrintButton();
    addCalendarButtons();
    const observer = new MutationObserver(addCalendarButtons);
    const list = document.getElementById("matchList");
    if (list) observer.observe(list, { childList: true, subtree: true });
  });
})();
