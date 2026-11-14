/* Print feature */
(function () {
  "use strict";

  window.printActiveTrip = function () {
    // KI-One-Pager der aktiven Alternative an den Ausdruck anhängen
    if (typeof window.prepareBriefingsPrint === "function") window.prepareBriefingsPrint();
    document.body.classList.add("printing-trip");
    window.addEventListener("afterprint", () => {
      document.body.classList.remove("printing-trip");
    }, { once: true });
    window.setTimeout(() => window.print(), 50);
  };

})();
