// app.js
// Static BBA habitat model explorer. Everything is read in the browser from the
// files tools/build_site.py assembles: PMTiles for the map layers, the COGs for
// a clicked cell (HTTP range requests through geotiff.js), JSON for the rest.
// Nothing is computed on a server, as in the Shiny app: values come from the
// data layer and are only formatted and drawn here.
//
// SHAP values are xgboost TreeSHAP on the log-odds scale: phi0 + sum of the SHAP
// bands (top covariates + the summed rest) = the model's log-odds f(x).

import { Protocol } from "https://cdn.jsdelivr.net/npm/pmtiles@4.5.0/+esm";
import { fromUrl } from "https://cdn.jsdelivr.net/npm/geotiff@3.0.5/+esm";
import proj4 from "https://cdn.jsdelivr.net/npm/proj4@2.22.0/+esm";
import * as Plot from "https://cdn.jsdelivr.net/npm/@observablehq/plot@0.6.17/+esm";

const BASEMAP = "https://tiles.openfreemap.org/styles/positron";
const COL_RAISE = "#2a78d6";     // the diverging palette's poles: blue raises, red lowers
const COL_LOWER = "#c74845";
const COL_MARK = "#5b5b57";      // single unsigned series (importance, dependence)
const RAMP_FEATURE = ["#ffbca3", "#fc6b31", "#bf4301", "#7a2a05"];   // covariate value, low -> high
const OTHER_BAND = "other_covariates";
const TOP_N = 15;

const $ = (id) => document.getElementById(id);
const href = (path) => new URL(path, document.baseURI).href;
const signed = (v, d = 3) => (v >= 0 ? "+" : "−") + Math.abs(v).toFixed(d);
const num = (v, d = 3) => (v < 0 ? "−" : "") + Math.abs(v).toFixed(d);
const sig = (v) => (Number.isFinite(v) ? Number(v.toPrecision(4)).toString() : "–");
const thousands = (v) => v.toLocaleString("en-US");

async function getJSON(path) {
  const r = await fetch(href(path));
  if (!r.ok) throw new Error(`${path}: HTTP ${r.status}`);
  return r.json();
}

function showError(err) {
  console.error(err);
  const box = $("error");
  box.textContent = `Something went wrong: ${err.message ?? err}`;
  box.hidden = false;
}

// ---- State ---------------------------------------------------------------------
const site = await getJSON("data/site.json");
const state = { sp: null, meta: null, layer: "prediction", cogs: null, sample: null, click: null, pixel: null };
const toGrid = proj4("EPSG:4326", site.grid.proj4);
let covariateCogs = null;   // shared by all species

// ---- Map -----------------------------------------------------------------------
const protocol = new Protocol({ metadata: true });
maplibregl.addProtocol("pmtiles", protocol.tile);
const map = new maplibregl.Map({
  container: "map", style: BASEMAP, bounds: site.area.bounds, fitBoundsOptions: { padding: 16 },
  minZoom: site.tiles.min_zoom - 1, maxZoom: site.tiles.max_zoom + 4, attributionControl: { compact: true },
});
map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");
map.addControl(new maplibregl.ScaleControl({ unit: "metric" }), "bottom-left");
const mapLoaded = new Promise((resolve) => map.on("load", resolve));

function layerScale(layer) {
  if (layer === "prediction") {
    return { colors: site.palettes.prediction, min: 0, max: 1, title: "P(present)", note: "Habitat suitability, fixed 0–1" };
  }
  const lim = state.meta.shap_limit;
  return {
    colors: site.palettes.shap, min: -lim, max: lim, title: `SHAP: ${layer.replace(/^shap_/, "")}`,
    note: `Log-odds; ±${lim.toFixed(2)} = ${100 * site.palettes.shap_quantile}% quantile of |SHAP| over all covariates, beyond clipped`,
  };
}

function renderLegend() {
  const s = layerScale(state.layer);
  const shap = s.min < 0;
  const f = (v) => (shap ? signed(v, 2) : v.toFixed(1));
  $("legend").innerHTML = `
    <div class="legend-title">${s.title}</div>
    <div class="legend-bar" style="background: linear-gradient(to right, ${s.colors.join(", ")})"></div>
    <div class="legend-labels"><span>${f(s.min)}</span><span>${shap ? "0" : f((s.min + s.max) / 2)}</span><span>${f(s.max)}</span></div>
    <div class="legend-note">${s.note}</div>`;
}

// Swap the raster layer: remove it and its PMTiles source, add the new one under the outline
function showLayer() {
  const entry = state.meta.layers.find((l) => l.layer === state.layer);
  if (map.getLayer("hsm")) map.removeLayer("hsm");
  if (map.getSource("hsm")) map.removeSource("hsm");
  map.addSource("hsm", { type: "raster", url: `pmtiles://${href(`data/${state.sp}/${entry.file}`)}`, tileSize: 256 });
  map.addLayer({ id: "hsm", type: "raster", source: "hsm",
                 paint: { "raster-resampling": "nearest", "raster-fade-duration": 0 } }, "area_outline");
  renderLegend();
}

function layerLabel(layer) {
  if (layer === "prediction") return "P(present)";
  const name = layer.replace(/^shap_/, "");
  const cv = state.meta.covariates.find((c) => c.name === name);
  return `${name}  (mean |SHAP| ${cv.mean_abs_shap.toFixed(3)})`;
}

function fillLayerMenu() {
  const shap = state.meta.layers.filter((l) => l.layer !== "prediction");
  if (!state.meta.layers.some((l) => l.layer === state.layer)) state.layer = "prediction";
  $("layer").innerHTML = `
    <optgroup label="Prediction"><option value="prediction">P(present)</option></optgroup>
    <optgroup label="SHAP: top covariates in the area">
      ${shap.map((l) => `<option value="${l.layer}">${layerLabel(l.layer)}</option>`).join("")}
    </optgroup>`;
  $("layer").value = state.layer;
  const used = state.meta.covariates.filter((c) => c.mean_abs_shap > 0).length;
  $("layers-note").textContent = `SHAP map layers: the ${shap.length} covariates with the largest mean |SHAP| over ` +
    `${site.area.label}. All ${used} covariates the ${state.sp} model uses are in the clicked-cell panel and the area summary.`;
}

// ---- Clicked cell: values from the COGs ------------------------------------------
async function openCogs() {
  const open = async (path) => (await fromUrl(href(path))).getImage();
  if (!covariateCogs) {
    covariateCogs = await Promise.all(site.covariates.files.map((f) => open(`data/covariates/${f.file}`)));
  }
  if (!state.cogs) {
    const c = state.meta.cogs;
    state.cogs = { pred: await open(`data/${state.sp}/${c.prediction.file}`), shap: await open(`data/${state.sp}/${c.shap.file}`) };
  }
  return state.cogs;
}

// Values at a lon/lat: mapped p, SHAP bands and all covariate values of the cell
// under the point (the grid cell whose extent contains it); null outside the area.
async function readPixel(lng, lat) {
  const g = site.grid;
  const [x, y] = toGrid.forward([lng, lat]);
  const col = Math.floor((x - g.x0) / g.res);
  const row = Math.floor((g.y0 - y) / g.res);
  if (col < 0 || row < 0 || col >= g.width || row >= g.height) return null;
  const cogs = await openCogs();
  const window_ = [col, row, col + 1, row + 1];
  const read = async (img) => Array.from(await img.readRasters({ window: window_ }), (band) => band[0]);
  const P = state.meta.cogs.prediction;
  const S = state.meta.cogs.shap;
  const [pRaw] = await read(cogs.pred);
  if (pRaw === P.nodata) return null;
  const sRaw = await read(cogs.shap);
  const phi = Object.fromEntries(S.bands.map((b, i) => [b, sRaw[i] * S.scales[i] + S.offsets[i]]));
  const xs = {};
  await Promise.all(site.covariates.files.map(async (f, k) => {
    const raw = await read(covariateCogs[k]);
    f.bands.forEach((b, i) => { xs[b] = raw[i] * f.scales[i] + f.offsets[i]; });
  }));
  const margin = state.meta.phi0 + Object.values(phi).reduce((a, b) => a + b, 0);
  return { lng, lat, row, col, p_map: pRaw * P.scales[0] + P.offsets[0], phi, x: xs, phi0: state.meta.phi0,
           margin, p: 1 / (1 + Math.exp(-margin)), other: state.meta.shap_cog.other_covariates };
}

// Waterfall from phi0 (bottom) to f(x) (top): bars ordered by |SHAP|, largest on top
function waterfall(px, width) {
  const items = Object.entries(px.phi).map(([name, value]) => ({
    name, value,
    label: name === OTHER_BAND ? `${px.other.length} other covariates` : `${name} = ${sig(px.x[name])}`,
  }));
  items.sort((a, b) => Math.abs(a.value) - Math.abs(b.value));
  let acc = px.phi0;
  const rows = items.map((d) => { const start = acc; acc += d.value; return { ...d, start, end: acc }; });
  const order = rows.map((d) => d.label).reverse();
  const tip = (d) => `${d.label}\nSHAP ${signed(d.value, 4)} log-odds\n${num(d.start, 3)} → ${num(d.end, 3)}`;
  // value labels: inside bars wide enough to hold them, else beside the bar's end
  // (the x-range is padded so those fit)
  const xs = rows.flatMap((d) => [d.start, d.end]);
  const lo = Math.min(...xs), hi = Math.max(...xs), pad = 0.18 * (hi - lo || 1);
  const marginLeft = labelMargin(order, width);
  const pxPerUnit = (width - marginLeft - 16) / (hi - lo + 2 * pad);
  const inside = rows.filter((d) => Math.abs(d.value) * pxPerUnit > 52);
  const outside = rows.filter((d) => !inside.includes(d));
  return Plot.plot({
    width, height: 56 + rows.length * 38, marginLeft, marginRight: 16, style: { fontSize: "11px" },
    x: { label: "log-odds of presence", grid: true, domain: [lo - pad, hi + pad], ticks: 4, labelAnchor: "center",
         labelArrow: "none" },
    y: { domain: order, label: null },
    marks: [
      Plot.ruleX([px.phi0], { stroke: "#a3a29d", strokeDasharray: "3,3" }),
      Plot.barX(rows, { x1: "start", x2: "end", y: "label", fill: (d) => (d.value >= 0 ? COL_RAISE : COL_LOWER),
                        insetTop: 7, insetBottom: 7, title: tip }),
      Plot.text(inside, { x: (d) => (d.start + d.end) / 2, y: "label", text: (d) => signed(d.value, 3), fill: "white",
                          fontWeight: 600 }),
      Plot.text(outside.filter((d) => d.value >= 0), { x: "end", y: "label", text: (d) => signed(d.value, 3), dx: 4,
                                                       textAnchor: "start", fill: "#1b1b1a" }),
      Plot.text(outside.filter((d) => d.value < 0), { x: "end", y: "label", text: (d) => signed(d.value, 3), dx: -4,
                                                      textAnchor: "end", fill: "#1b1b1a" }),
      Plot.ruleX([px.margin], { stroke: "#1b1b1a" }),
    ],
  });
}

function covariateTable(px) {
  const own = Object.entries(px.phi).filter(([k]) => k !== OTHER_BAND).sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]));
  const rows = own.map(([k, v]) => `<tr><td>${k}</td><td class="num">${sig(px.x[k])}</td><td class="num">${signed(v, 4)}</td></tr>`);
  if (px.other.length) {
    rows.push(`<tr class="other-sum"><td>${px.other.length} other covariates, summed</td><td></td>` +
              `<td class="num">${signed(px.phi[OTHER_BAND], 4)}</td></tr>`);
    rows.push(...px.other.map((k) => `<tr class="other"><td>${k}</td><td class="num">${sig(px.x[k])}</td><td class="num">in sum</td></tr>`));
  }
  return `<details><summary>All ${Object.keys(px.x).length} covariate values and their SHAP</summary>
    <table class="cov-table"><thead><tr><th>Covariate</th><th class="num">Value</th><th class="num">SHAP</th></tr></thead>
    <tbody>${rows.join("")}</tbody></table></details>`;
}

function renderPixel(px) {
  const box = $("pixel");
  if (!px) { box.innerHTML = `<p class="muted">Outside the prediction area.</p>`; return; }
  const nOwn = Object.keys(px.phi).length - 1;
  box.innerHTML = `
    <div class="pixel-stats">
      <div><span class="stat-value">${px.p_map.toFixed(3)}</span><span class="stat-label">mapped P(present)</span></div>
      <div><span class="stat-value">${signed(px.margin)}</span><span class="stat-label">log-odds f(x)</span></div>
      <div><span class="stat-value">${signed(px.phi0)}</span><span class="stat-label">base value &phi;<sub>0</sub></span></div>
    </div>
    <p class="pixel-text">${state.sp} &middot; ${px.lat.toFixed(5)}, ${px.lng.toFixed(5)} &middot; cell row ${px.row + 1}, col ${px.col + 1}
      (30 m, EPSG:${site.grid.epsg}). SHAP on the log-odds scale: &phi;<sub>0</sub> + &Sigma; SHAP = f(x),
      p = 1/(1 + e<sup>&minus;f(x)</sup>) = ${px.p.toFixed(4)}; the map stores p in 0.004 steps.
      ${px.other.length ? `SHAP is stored per covariate for the ${nOwn} with the largest mean |SHAP| in the area; the other ${px.other.length} are summed.` : ""}</p>
    <p class="wf-caption top">f(x) = ${num(px.margin)} &rarr; p = ${px.p.toFixed(3)}</p>
    <div id="waterfall" class="plot"></div>
    <p class="wf-caption bottom">base value E[f(x)] = ${num(px.phi0)}</p>
    ${covariateTable(px)}`;
  $("waterfall").append(waterfall(px, Math.max(320, box.clientWidth - 32)));
}

async function updatePixel() {
  if (!state.click) return;
  $("pixel").innerHTML = `<p class="muted">Reading the cell…</p>`;
  state.pixel = await readPixel(state.click.lng, state.click.lat);
  renderPixel(state.pixel);
}

map.on("click", (e) => {
  state.click = { lng: e.lngLat.lng, lat: e.lngLat.lat };
  map.getSource("pick")?.setData({ type: "Feature", geometry: { type: "Point", coordinates: [state.click.lng, state.click.lat] } });
  updatePixel().catch(showError);
});

// ---- Area summary ------------------------------------------------------------------
function plotWidth(id) { return Math.max(300, $(id).clientWidth - 24); }

// Left margin that fits the longest covariate name at 11 px (about 6.5 px per character)
function labelMargin(names, width, maxShare = 0.55) {
  return Math.min(width * maxShare, 12 + 6.5 * Math.max(...names.map((n) => n.length)));
}

function importancePlot() {
  const d = state.meta.model_importance.slice(0, TOP_N);
  const width = plotWidth("importance");
  return Plot.plot({
    width, height: 520, marginLeft: labelMargin(d.map((r) => r.name), width, 0.68), marginRight: 16, style: { fontSize: "11px" },
    x: { label: "Share of total gain", tickFormat: "%", grid: true, nice: true, ticks: 3, labelAnchor: "center", labelArrow: "none" },
    y: { domain: d.map((r) => r.name), label: null },
    marks: [
      Plot.barX(d, { x: "gain", y: "name", fill: COL_MARK, insetTop: 4, insetBottom: 4,
                     title: (r) => `${r.name}\n${(100 * r.gain).toFixed(1)}% of total gain` }),
      Plot.ruleX([0]),
    ],
  });
}

// Deterministic jitter (same picture on every load)
function rng(seed) {
  return () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

// Beeswarm: one row per covariate, x = SHAP, spread vertically by the local density
// of SHAP values (sina style), colour = covariate value scaled within its range
function beeswarmPlot() {
  const s = state.sample;
  const covs = state.meta.covariates.filter((c) => c.mean_abs_shap > 0).slice(0, TOP_N).map((c) => c.name)
    .filter((c) => s.shap[c]);
  const rand = rng(20261020);
  const pts = [];
  covs.forEach((c, i) => {
    const v = s.shap[c];
    const xv = s.x[c];
    const lo = Math.min(...v), hi = Math.max(...v), xlo = Math.min(...xv), xhi = Math.max(...xv);
    const nb = 60, counts = new Array(nb).fill(0);
    const bin = (a) => (hi > lo ? Math.min(nb - 1, Math.floor(((a - lo) / (hi - lo)) * nb)) : 0);
    v.forEach((a) => counts[bin(a)]++);
    const peak = Math.max(...counts);
    v.forEach((a, k) => pts.push({ cov: c, shap: a, y: i + (rand() - 0.5) * 0.8 * (counts[bin(a)] / peak),
                                    t: xhi > xlo ? (xv[k] - xlo) / (xhi - xlo) : 0.5 }));
  });
  const width = plotWidth("beeswarm");
  return Plot.plot({
    width, height: 520, marginLeft: labelMargin(covs, width), marginRight: 16, style: { fontSize: "11px" },
    x: { label: "SHAP (log-odds)", grid: true, nice: true, ticks: 4, labelAnchor: "center", labelArrow: "none" },
    y: { domain: [covs.length - 0.5, -0.5], ticks: covs.map((_, i) => i), tickFormat: (i) => covs[i], label: null,
         tickSize: 0 },
    color: { type: "linear", domain: [0, 1], range: RAMP_FEATURE, interpolate: "rgb", legend: true, width: 220,
             label: "Covariate value within its range", ticks: [0, 1], tickFormat: (t) => (t === 0 ? "low" : "high") },
    marks: [
      Plot.ruleX([0], { stroke: "#a3a29d" }),
      Plot.dot(pts, { x: "shap", y: "y", fill: "t", r: 1.4, stroke: null }),
    ],
  });
}

function dependencePlot(cov) {
  const s = state.sample;
  const pts = s.x[cov].map((x, k) => ({ x, shap: s.shap[cov][k] }));
  return Plot.plot({
    width: plotWidth("dependence"), height: 520, marginRight: 16, style: { fontSize: "11px" },
    x: { label: `${cov} (covariate value)`, grid: true, nice: true, ticks: 5, labelAnchor: "center", labelArrow: "none" },
    y: { label: "SHAP value (log-odds of presence)", grid: true, nice: true, labelArrow: "none" },
    marks: [
      Plot.ruleY([0], { stroke: "#a3a29d", strokeDasharray: "4,3" }),
      Plot.dot(pts, { x: "x", y: "shap", fill: COL_MARK, fillOpacity: 0.35, r: 1.6, stroke: null }),
      Plot.tip(pts, Plot.pointer({ x: "x", y: "shap", title: (d) => `${cov} = ${sig(d.x)}\nSHAP ${signed(d.shap, 4)}` })),
    ],
  });
}

async function renderSummary() {
  if (!state.sample) state.sample = await getJSON(`data/${state.sp}/sample.json`);
  const m = state.meta;
  $("importance").replaceChildren(importancePlot());
  $("importance-note").textContent = `xgboost gain importance of the fitted ${state.sp} model: each covariate's share of the ` +
    `improvement from all its splits, over the ${thousands(m.n_training_points)} training points (TALIN area, VA/WV), not ${site.area.label} alone.`;
  $("beeswarm").replaceChildren(beeswarmPlot());
  $("sample-note").textContent = `${thousands(m.n_sample)} random cells of ${site.area.label} (${thousands(m.n_cells)} cells); ` +
    `SHAP on the log-odds scale; colour = covariate value within its range.`;
  const sel = $("dep-covariate");
  const covs = state.sample.covariates;
  if (!covs.includes(sel.value)) {
    sel.innerHTML = covs.map((c) => `<option value="${c}">${c}</option>`).join("");
    sel.value = covs[0];
  }
  $("dependence").replaceChildren(dependencePlot(sel.value));
}

$("dep-covariate").addEventListener("change", () => {
  $("dependence").replaceChildren(dependencePlot($("dep-covariate").value));
});

// ---- Priority species table ----------------------------------------------------------------
const priorities = await getJSON("data/priorities.json");
const onSite = new Set(site.species.map((s) => s.species));
const REASON = { "fewer than 20 detections": "< 20 detections", "not in the BBA species list": "not in BBA data",
                 "not in the training data": "no training data" };
const COLUMNS = [
  { key: "priority", label: "AMJV priority", value: (r) => priorities.levels.indexOf(r.priority) },
  { key: "com_name", label: "Species", value: (r) => r.com_name },
  { key: "code", label: "Code", value: (r) => r.code ?? "~" },
  { key: "detections", label: "Detections", value: (r) => r.detections ?? -1, num: true },
  { key: "cv_auc", label: "CV AUC", value: (r) => r.cv_auc ?? -1, num: true },
];
const sortState = { key: "priority", dir: 1 };   // the file's order: priority, then the best models first

function renderPriorityTable() {
  const col = COLUMNS.find((c) => c.key === sortState.key);
  const order = new Map(priorities.species.map((r, i) => [r, i]));
  const rows = [...priorities.species].sort((a, b) => {
    const va = col.value(a), vb = col.value(b);
    const c = typeof va === "string" ? va.localeCompare(vb) : va - vb;
    return c * sortState.dir || order.get(a) - order.get(b);
  });
  const arrow = (c) => (c.key === sortState.key ? (sortState.dir > 0 ? " ▲" : " ▼") : "");
  const head = COLUMNS.map((c) => `<th class="${c.num ? "num" : ""}" aria-sort="${c.key === sortState.key ?
    (sortState.dir > 0 ? "ascending" : "descending") : "none"}"><button type="button" data-key="${c.key}">${c.label}${arrow(c)}</button></th>`);
  const body = rows.map((r) => {
    const name = onSite.has(r.code)
      ? `<a href="#map" data-species="${r.code}" title="${r.sci_name}: open the map">${r.com_name}</a>`
      : `<span title="${r.sci_name}">${r.com_name}</span>`;
    const auc = r.cv_auc != null ? r.cv_auc.toFixed(2) : `<span class="muted">not modeled: ${REASON[r.note] ?? r.note}</span>`;
    return `<tr class="${r.modeled ? "" : "unmodeled"}"><td>${r.priority}</td><td>${name}</td><td>${r.code ?? "–"}</td>` +
      `<td class="num">${r.detections != null ? thousands(r.detections) : "–"}</td><td class="num">${auc}</td></tr>`;
  });
  $("priority-table").innerHTML = `<thead><tr>${head.join("")}</tr></thead><tbody>${body.join("")}</tbody>`;
}

function renderPriorityText() {
  const s = priorities.species;
  const count = (lv) => s.filter((r) => r.priority === lv).length;
  const nMapped = s.filter((r) => onSite.has(r.code)).length;
  $("priority-intro").innerHTML = `${s.length} species are ranked Medium, High or Very High priority by the AMJV for the
    Virginia Highlands (${priorities.levels.map((lv) => `${count(lv)} ${lv}`).join(", ")}). ${nMapped} of them have BBA
    habitat models and maps here: click a species name to open its map. Click a column heading to sort.`;
  $("priority-notes").innerHTML = `Detections: survey points with the species detected, of ${thousands(priorities.training_points)}
    in the models' training data (TALIN area, VA/WV). CV AUC: the model's pooled cross-validated ROC AUC (0.5 = no better
    than chance, 1 = perfect). Species with fewer than ${priorities.min_presences} detections were not modeled. Source:
    ${priorities.source}.`;
}

$("priority-table").addEventListener("click", (e) => {
  const sortBy = e.target.closest("button[data-key]")?.dataset.key;
  if (sortBy) {
    const numeric = COLUMNS.find((c) => c.key === sortBy).num;
    sortState.dir = sortState.key === sortBy ? -sortState.dir : (numeric ? -1 : 1);
    sortState.key = sortBy;
    renderPriorityTable();
    return;
  }
  const sp = e.target.closest("a[data-species]")?.dataset.species;
  if (sp) {
    e.preventDefault();
    selectTab("map");
    mapLoaded.then(() => loadSpecies(sp)).catch(showError);
  }
});

// ---- Species and tabs ------------------------------------------------------------------
function renderSpeciesInfo() {
  const m = state.meta;
  $("species-info").innerHTML = `
    <div><em>${m.sci_name}</em></div>
    <div>CV AUC ${m.cv_auc.toFixed(2)} &middot; prevalence ${(100 * m.prevalence).toFixed(1)}% (${thousands(m.n_present)} detections)</div>
    <div>Base value &phi;<sub>0</sub> = ${num(m.phi0)} log-odds (p = ${(1 / (1 + Math.exp(-m.phi0))).toFixed(3)})</div>
    <div>SHAP colour limit &plusmn;${m.shap_limit.toFixed(2)} log-odds</div>`;
}

async function loadSpecies(sp) {
  state.sp = sp;
  $("species").value = sp;
  state.meta = await getJSON(`data/${sp}/meta.json`);
  state.cogs = null;
  state.sample = null;
  fillLayerMenu();
  renderSpeciesInfo();
  showLayer();
  if (!$("tab-summary").hidden) await renderSummary();
  if (state.click) await updatePixel();
}

// The map starts in a hidden tab (zero size): fit it to the area the first time it is shown
let mapFitted = false;
function selectTab(name) {
  document.querySelectorAll(".tabs button").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.tab === name)));
  for (const t of ["species", "map", "summary"]) $(`tab-${t}`).hidden = t !== name;
  if (name === "map") {
    map.resize();
    if (!mapFitted) {
      map.fitBounds(site.area.bounds, { padding: 16, animate: false });
      mapFitted = true;
    }
  }
  if (name === "summary") renderSummary().catch(showError);
}

document.querySelectorAll(".tabs button").forEach((b) => b.addEventListener("click", () => selectTab(b.dataset.tab)));
$("layer").addEventListener("change", () => { state.layer = $("layer").value; showLayer(); });
$("species").addEventListener("change", () => loadSpecies($("species").value).catch(showError));
let resizeTimer;
window.addEventListener("resize", () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    if (!$("tab-summary").hidden && state.sample) renderSummary().catch(showError);
    if (state.pixel) renderPixel(state.pixel);
  }, 250);
});

// ---- Start ---------------------------------------------------------------------------------
try {
  document.querySelectorAll(".area-label").forEach((e) => { e.textContent = site.area.label; });
  $("species").innerHTML = site.species.map((s) => `<option value="${s.species}">${s.com_name} (${s.species})</option>`).join("");
  renderPriorityText();
  renderPriorityTable();
  await mapLoaded;
  map.addSource("area", { type: "geojson", data: href("data/area.geojson") });
  map.addLayer({ id: "area_outline", type: "line", source: "area", paint: { "line-color": "#3a3a38", "line-width": 1.2 } });
  map.addSource("pick", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
  map.addLayer({ id: "pick", type: "circle", source: "pick",
                 paint: { "circle-radius": 8, "circle-opacity": 0, "circle-stroke-color": "#1b1b1a", "circle-stroke-width": 2.5 } });
  await loadSpecies(site.default_species ?? site.species[0].species);
} catch (err) {
  showError(err);
}

// Hook for the verification scripts (verify/05_site.R)
window.explorer = { state, map, readPixel, showLayer, selectTab, loadSpecies, ready: true };
