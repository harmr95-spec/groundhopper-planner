#!/usr/bin/env python3
"""Erzeugt icons.js aus dem npm-Paket lucide-static.

Verwendung:
  npm pack lucide-static && tar xzf lucide-static-*.tgz   # entpackt nach ./package
  python3 tools/build-icons.py ./package

Neue Icons einfach in ICONS ergänzen (Namen siehe https://lucide.dev/icons).
"""
import re
import sys
from pathlib import Path

ICONS = """
map-pin calendar clock ticket ticket-check ticket-x pencil trash-2 plus settings menu printer
download upload x star external-link moon bed-double car route map hotel triangle-alert info
circle-check circle-x search chevron-left chevron-right ellipsis trophy scale luggage diamond
house goal whistle navigation sparkles shield-half users list-checks image calculator
book-open key-round refresh-cw badge-check loader-circle history lightbulb landmark shield
circle-help eye eye-off
""".split()

pkg = Path(sys.argv[1] if len(sys.argv) > 1 else "package")
entries = []
for name in ICONS:
    svg = (pkg / "icons" / f"{name}.svg").read_text()
    inner = svg[svg.index(">", svg.index("<svg")) + 1:svg.rindex("</svg>")]
    inner = re.sub(r"\s+", " ", inner).strip().replace("'", "\\'")
    entries.append(f"    \"{name}\": '{inner}',")

license_text = (pkg / "LICENSE").read_text().strip()
header = "\n".join(" * " + l if l else " *" for l in license_text.split("\n"))

js = f"""/*
 * Icons: Lucide (https://lucide.dev) – nur die in der App genutzten Icons.
 * Erzeugt mit tools/build-icons.py. Lizenz (ISC) – muss bei Weitergabe erhalten bleiben:
 *
{header}
 */
(function () {{
  "use strict";
  const ICONS = {{
{chr(10).join(entries)}
  }};

  // Sprite einmalig ins Dokument einfügen; Verwendung: <svg class="icon"><use href="#i-name"/></svg>
  const sprite = '<svg xmlns="http://www.w3.org/2000/svg" style="display:none" aria-hidden="true">' +
    Object.entries(ICONS).map(([name, body]) =>
      `<symbol id="i-${{name}}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${{body}}</symbol>`
    ).join("") + "</svg>";
  const inject = () => document.body.insertAdjacentHTML("afterbegin", sprite);
  if (document.body) inject(); else document.addEventListener("DOMContentLoaded", inject);

  // Icon als HTML-String, z. B. icon("car", "tone-sky")
  window.icon = function (name, cls = "", title = "") {{
    if (!ICONS[name]) return "";
    const label = title ? ` role="img" aria-label="${{title}}"` : ' aria-hidden="true"';
    return `<svg class="icon ${{cls}}"${{label}}><use href="#i-${{name}}"/></svg>`;
  }};
}})();
"""
Path("icons.js").write_text(js)
print(f"icons.js mit {len(entries)} Icons geschrieben")
