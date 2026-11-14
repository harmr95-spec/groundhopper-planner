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

})();
