/* Print feature */
(function () {
  "use strict";

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

  document.addEventListener("DOMContentLoaded", addPrintButton);
})();
