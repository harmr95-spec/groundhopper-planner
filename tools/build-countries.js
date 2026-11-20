#!/usr/bin/env node
/*
 * Erzeugt countries.js (Ländergrenzen Europas) aus Natural Earth (gemeinfrei) via world-atlas (ISC).
 * Verwendung:
 *   npm pack world-atlas topojson-client && tar xzf world-atlas-*.tgz -C wa && tar xzf topojson-client-*.tgz -C tc
 *   node tools/build-countries.js <pfad/zu/wa/package> <pfad/zu/tc/package>
 * Ergebnis: countries.js mit window.COUNTRY_SHAPES = [{ cc, bbox, polys: [[[lng,lat,...flach]], ...] }]
 */
const fs = require("fs");
const path = require("path");
const [waDir, tcDir] = process.argv.slice(2);
const topojson = require(path.resolve(tcDir, "dist/topojson-client.js"));
const topo = JSON.parse(fs.readFileSync(path.join(waDir, "countries-50m.json"), "utf8"));

// ISO-3166 numerisch -> Alpha-2 (Europa und Nachbarn)
const ISO = {
  "008": "al", "020": "ad", "040": "at", "056": "be", "070": "ba", "100": "bg", "112": "by", "191": "hr", "196": "cy",
  "203": "cz", "208": "dk", "233": "ee", "246": "fi", "250": "fr", "276": "de", "300": "gr", "348": "hu", "352": "is",
  "372": "ie", "380": "it", "428": "lv", "438": "li", "440": "lt", "442": "lu", "470": "mt", "498": "md", "492": "mc",
  "499": "me", "528": "nl", "807": "mk", "578": "no", "616": "pl", "620": "pt", "642": "ro", "674": "sm", "688": "rs",
  "703": "sk", "705": "si", "724": "es", "752": "se", "756": "ch", "792": "tr", "804": "ua", "826": "gb", "268": "ge",
  "051": "am", "031": "az", "234": "fo"
};
const EUROPE = [-32, 27, 50, 72]; // Teile außerhalb (z. B. Überseegebiete) werden verworfen

const features = topojson.feature(topo, topo.objects.countries).features;
const out = [];
for (const f of features) {
  const id = String(f.id || "").padStart(3, "0");
  const cc = ISO[id] || (f.properties && f.properties.name === "Kosovo" ? "xk" : null);
  if (!cc) continue;
  const polys = (f.geometry.type === "Polygon" ? [f.geometry.coordinates] : f.geometry.coordinates).map(rings => rings.map(ring => {
    const flat = [];
    let lx = null, ly = null;
    for (const [x, y] of ring) {
      const rx = Math.round(x * 1000) / 1000, ry = Math.round(y * 1000) / 1000;
      if (lx !== null && Math.abs(rx - lx) < 0.01 && Math.abs(ry - ly) < 0.01) continue; // ~1 km vereinfachen
      flat.push(rx, ry); lx = rx; ly = ry;
    }
    return flat;
  }).filter(r => r.length >= 6))
    .filter(rings => rings.length && (() => {
      const r = rings[0];
      for (let i = 0; i < r.length; i += 2) if (r[i] >= EUROPE[0] && r[i] <= EUROPE[2] && r[i + 1] >= EUROPE[1] && r[i + 1] <= EUROPE[3]) return true;
      return false;
    })());
  if (!polys.length) continue;
  let bbox = [180, 90, -180, -90];
  polys.forEach(rings => { const r = rings[0]; for (let i = 0; i < r.length; i += 2) {
    bbox = [Math.min(bbox[0], r[i]), Math.min(bbox[1], r[i + 1]), Math.max(bbox[2], r[i]), Math.max(bbox[3], r[i + 1])]; } });
  out.push({ cc, bbox, polys });
}
out.sort((a, b) => a.cc.localeCompare(b.cc));
const js = `/* Ländergrenzen Europas – Natural Earth 1:50m (gemeinfrei), über world-atlas (ISC). Erzeugt mit tools/build-countries.js */
window.COUNTRY_SHAPES = ${JSON.stringify(out)};
`;
fs.writeFileSync("countries.js", js);
console.log(`countries.js: ${out.length} Länder, ${(js.length / 1024).toFixed(0)} KB`);
