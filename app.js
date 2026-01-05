// ==========================
//  CONFIG — EDIT THESE ONLY
// ==========================
const SHEET_ID = "10smiQBJ8mBWax24aOagG9LdzrrnhFmj0tfRESunUJNI";

// Option A (recommended): if you publish to web, use CSV export like below.
// You must set the gid of your data tab.
// If you're not sure, open your sheet and look for ".../edit#gid=123456"
const GID = "2029178353";

// If using Publish-to-web CSV, this works well:
const CSV_URL = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/export?format=csv&gid=${GID}`;

// Option B (fallback): Google Visualization JSON endpoint (sometimes blocked).
const GVIZ_URL = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?tqx=out:json&gid=${GID}`;

// Choose fetch mode:
const FETCH_MODE = "csv"; // "csv" or "gviz"

// ==========================

const state = {
  rows: [],
  filtered: [],
  unit: localStorage.getItem("unit") || "in",
  lang: localStorage.getItem("lang") || "en",
  sortKey: "date",
  sortDir: "desc",
  lake: "",
  search: "",
  mapRange: localStorage.getItem("mapRange") || "all",
  mapFrom: localStorage.getItem("mapFrom") || "",
  mapTo: localStorage.getItem("mapTo") || "",
};

// ---------------------------
// Shareable URL state
// ---------------------------
function hydrateStateFromURL() {
  const params = new URLSearchParams(window.location.search);

  // Support both:
  // - ?q=free-text
  // - ?dates=MM-DD-YYYY,MM-DD-YYYY (shareable date filtering)
  const dates = params.get("dates");
  const q = params.get("q");
  if (dates !== null && dates.trim() !== "") {
    state.search = dates;
  } else if (q !== null) {
    state.search = q;
  }

  const lake = params.get("lake");
  if (lake !== null) state.lake = lake;

  const unit = params.get("unit");
  if (unit === "in" || unit === "cm") {
    state.unit = unit;
    localStorage.setItem("unit", unit);
  }

  const lang = params.get("lang");
  if (lang) {
    state.lang = lang;
    localStorage.setItem("lang", lang);
  }

  const range = params.get("range");
  if (range) {
    state.mapRange = range;
    localStorage.setItem("mapRange", range);
  }

  const from = params.get("from");
  if (from !== null) {
    state.mapFrom = from;
    localStorage.setItem("mapFrom", from);
  }

  const to = params.get("to");
  if (to !== null) {
    state.mapTo = to;
    localStorage.setItem("mapTo", to);
  }

  // Handle Back/Forward
  if (!window.__icePopStateHooked) {
    window.__icePopStateHooked = true;
    window.addEventListener("popstate", () => {
      hydrateStateFromURL();
      applyTranslations(state.lang);

      // Re-sync UI widgets to hydrated state
      const searchInput = document.getElementById("searchInput");
      if (searchInput) searchInput.value = state.search || "";
      const lakeSelect = document.getElementById("lakeSelect");
      if (lakeSelect) lakeSelect.value = state.lake;
      const unitSelect = document.getElementById("unitSelect");
      if (unitSelect) unitSelect.value = state.unit;
      const langSelect = document.getElementById("langSelect");
      if (langSelect) langSelect.value = state.lang;

      const mapRangeSelect = document.getElementById("mapRangeSelect");
      if (mapRangeSelect) mapRangeSelect.value = state.mapRange;
      const mapFromInput = document.getElementById("mapFromInput");
      if (mapFromInput) mapFromInput.value = state.mapFrom || "";
      const mapToInput = document.getElementById("mapToInput");
      if (mapToInput) mapToInput.value = state.mapTo || "";

      rerenderAll();
    });
  }
}

function syncUrlFromState(push = false) {
  const url = new URL(window.location.href);

  const set = (k, v) => {
    if (v === undefined || v === null || String(v).trim() === "") url.searchParams.delete(k);
    else url.searchParams.set(k, String(v).trim());
  };

  // Store date-only searches in ?dates=MM-DD-YYYY,... so the URL stays clean.
  const rawSearch = (state.search || "").trim();
  const maybeTokens = rawSearch
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
  const dateKeys = maybeTokens
    .map((t) => {
      const d = parseDate(t);
      if (!d) return null;
      const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
      const dd = String(d.getUTCDate()).padStart(2, "0");
      const yyyy = String(d.getUTCFullYear());
      return `${mm}-${dd}-${yyyy}`;
    })
    .filter(Boolean);

  if (dateKeys.length > 0 && dateKeys.length === maybeTokens.length) {
    set("dates", dateKeys.join(","));
    set("q", "");
  } else {
    set("dates", "");
    set("q", rawSearch);
  }

  set("lake", state.lake && state.lake !== "all" ? state.lake : "");
  set("unit", state.unit);
  set("lang", state.lang);
  set("range", state.mapRange);
  set("from", state.mapRange === "custom" ? state.mapFrom : "");
  set("to", state.mapRange === "custom" ? state.mapTo : "");

  if (push) window.history.pushState({}, "", url.toString());
  else window.history.replaceState({}, "", url.toString());
}

let map, markersLayer;

function setStatus(msg) {
  document.getElementById("statusLine").textContent = msg;
}

function parseMixedFractionToInches(raw) {
  // Accepts: "5 5/8", "9 1/4", "3/8", "5", "8 7/8)", "9 1/8!!"
  if (!raw) return null;
  const s = String(raw).replace(/[^0-9\/\s.]/g, " ").trim(); // remove weird chars
  if (!s) return null;

  // If it's a plain decimal number:
  if (/^\d+(\.\d+)?$/.test(s)) return Number(s);

  // Mixed fraction: "A B/C"
  const parts = s.split(/\s+/).filter(Boolean);
  let whole = 0;
  let frac = 0;

  if (parts.length === 1 && parts[0].includes("/")) {
    const [n, d] = parts[0].split("/");
    if (d && Number(d) !== 0) frac = Number(n) / Number(d);
    return isFinite(frac) ? frac : null;
  }

  if (parts.length >= 1 && /^\d+$/.test(parts[0])) whole = Number(parts[0]);

  const fracPart = parts.find(p => p.includes("/"));
  if (fracPart) {
    const [n, d] = fracPart.split("/");
    if (d && Number(d) !== 0) frac = Number(n) / Number(d);
  }

  const val = whole + frac;
  return isFinite(val) ? val : null;
}

function inchesToCm(inches) {
  if (inches == null) return null;
  return inches * 2.54;
}

function formatThickness(row) {
  const inches = row.thickness_in;
  const cm = row.thickness_cm;

  if (state.unit === "in") {
    if (inches == null) return t(state.lang, "no_thickness");
    return `${inches.toFixed(2)} in`;
  } else {
    const v = (cm != null) ? cm : (inches != null ? inchesToCm(inches) : null);
    if (v == null) return t(state.lang, "no_thickness");
    return `${v.toFixed(2)} cm`;
  }
}

function parseCoords(raw) {
  // "44.96853° N, 93.28444° W"
  if (!raw) return null;
  const s = String(raw);

  const mLat = s.match(/(-?\d+(\.\d+)?)[^\d\-]*\s*°?\s*([NS])/i);
  const mLon = s.match(/(-?\d+(\.\d+)?)[^\d\-]*\s*°?\s*([EW])/i);

  // If it has two numbers but no N/S/E/W, try splitting by comma:
  if (!mLat || !mLon) {
    const nums = s.match(/-?\d+(\.\d+)?/g);
    if (nums && nums.length >= 2) {
      const lat = Number(nums[0]);
      const lon = Number(nums[1]);
      if (isFinite(lat) && isFinite(lon)) return { lat, lon };
    }
    return null;
  }

  let lat = Number(mLat[1]);
  let lon = Number(mLon[1]);
  const ns = mLat[3].toUpperCase();
  const ew = mLon[3].toUpperCase();

  if (ns === "S") lat = -Math.abs(lat);
  if (ns === "N") lat = Math.abs(lat);

  if (ew === "W") lon = -Math.abs(lon);
  if (ew === "E") lon = Math.abs(lon);

  if (!isFinite(lat) || !isFinite(lon)) return null;
  return { lat, lon };
}

function parseDate(raw) {
  // Accepts:
  // - MM-DD-YYYY
  // - MM/DD/YYYY
  // - "Date(2025,2,11)" (Google GViz date literal; month is 0-indexed)
  if (!raw && raw !== 0) return null;
  const s0 = String(raw).trim();

  // GViz date literal: Date(YYYY,MM,DD)
  const g = s0.match(/^Date\((\d{4})\s*,\s*(\d{1,2})\s*,\s*(\d{1,2})\)\s*$/i);
  if (g) {
    const yyyy = Number(g[1]);
    const mm0 = Number(g[2]);
    const dd = Number(g[3]);
    const d = new Date(Date.UTC(yyyy, mm0, dd));
    return isFinite(d.getTime()) ? d : null;
  }

  // Common US date formats
  const s = s0.replace(/\//g, "-");
  const m = s.match(/^(\d{1,2})-(\d{1,2})-(\d{4})$/);
  if (!m) return null;
  const mm = Number(m[1]);
  const dd = Number(m[2]);
  const yyyy = Number(m[3]);
  const d = new Date(Date.UTC(yyyy, mm - 1, dd));
  return isFinite(d.getTime()) ? d : null;
}

function toDisplayDate(raw) {
  // Display as MM/DD/YYYY when possible.
  const d = parseDate(raw);
  if (!d) return raw ? String(raw) : "";
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  const yyyy = String(d.getUTCFullYear());
  return `${mm}/${dd}/${yyyy}`;
}

function normalizeKeys(obj) {
  // Creates a lookup with trimmed, lowercased keys for case/space-insensitive access.
  const out = {};
  for (const [k, v] of Object.entries(obj || {})) {
    out[String(k).trim().toLowerCase()] = v;
  }
  return out;
}

function pick(obj, ...candidates) {
  // Case/space-insensitive field fetch.
  const n = normalizeKeys(obj);
  for (const c of candidates) {
    const key = String(c).trim().toLowerCase();
    if (key in n) return n[key];
  }
  return "";
}

function normRow(obj) {
  // Normalize Ice2024 (lat/lon + description) and Ice2025 (Coordinates + Info)
  const dateRaw = pick(obj, "Date", "date");
  const lake = String(pick(obj, "Lake", "lake")).trim();

  const coordsRaw = pick(obj, "Coordinates", "coords", "coordinate");
  const latRaw = pick(obj, "lat_dd", "lat", "latitude");
  const lonRaw = pick(obj, "long_dd", "lon", "lng", "longitude", "long");
  const coordsFromLatLon = (latRaw !== "" && lonRaw !== "")
    ? `${Number(latRaw).toFixed(5)}° N, ${Math.abs(Number(lonRaw)).toFixed(5)}° W`
    : "";

  const info = String(pick(obj, "Info", "info", "description", "Desc", "Notes")).trim();

  const thicknessInRaw = pick(obj, "Thickness (Inches)", "thickness_in", "thickness (inches)", "Thickness", "thickness");
  const thicknessCmRaw = pick(obj, "Thickness (cm)", "Thickness_cm", "thickness_cm", "thickness (cm)");

  const dateObj = parseDate(dateRaw);
  const coords = parseCoords(coordsRaw || coordsFromLatLon);

  const thickness_in = parseMixedFractionToInches(thicknessInRaw);
  const thickness_cm = (thicknessCmRaw !== "" && thicknessCmRaw != null && isFinite(Number(thicknessCmRaw)))
    ? Number(thicknessCmRaw)
    : (thickness_in != null ? inchesToCm(thickness_in) : null);

  return {
    date_raw: dateRaw ? String(dateRaw).trim() : "",
    date: dateObj,
    date_key: dateObj
      ? `${String(dateObj.getUTCMonth() + 1).padStart(2, "0")}-${String(dateObj.getUTCDate()).padStart(2, "0")}-${dateObj.getUTCFullYear()}`
      : "",
    date_display: dateObj
      ? `${String(dateObj.getUTCMonth() + 1).padStart(2, "0")}/${String(dateObj.getUTCDate()).padStart(2, "0")}/${dateObj.getUTCFullYear()}`
      : "",
    date_sort: dateObj ? dateObj.getTime() : 0,
    lake,
    coords_raw: (coordsRaw || coordsFromLatLon) ? String(coordsRaw || coordsFromLatLon).trim() : "",
    coords,
    info,
    thickness_in,
    thickness_cm
  };
}

function csvToObjects(csvText) {
  // Simple CSV parser good enough for this sheet.
  const lines = csvText.replace(/\r/g, "").split("\n").filter(l => l.trim().length);
  if (!lines.length) return [];
  const headers = splitCsvLine(lines[0]).map(h => h.trim());
  const out = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = splitCsvLine(lines[i]);
    const obj = {};
    headers.forEach((h, idx) => obj[h] = cols[idx] ?? "");
    out.push(obj);
  }
  return out;
}

function splitCsvLine(line) {
  const res = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      // toggle quotes or escaped quote
      if (inQuotes && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === "," && !inQuotes) {
      res.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  res.push(cur);
  return res;
}

async function fetchData() {
  setStatus(t(state.lang, "status_loading"));

  try {
    let rawRows = [];
    if (FETCH_MODE === "csv") {
      const resp = await fetch(CSV_URL, { cache: "no-store" });
      if (!resp.ok) throw new Error("CSV fetch failed");
      const text = await resp.text();
      rawRows = csvToObjects(text);
    } else {
      const resp = await fetch(GVIZ_URL, { cache: "no-store" });
      if (!resp.ok) throw new Error("GVIZ fetch failed");
      const text = await resp.text();
      const json = JSON.parse(text.substring(text.indexOf("{"), text.lastIndexOf("}") + 1));
      const table = json.table;
      const headers = table.cols.map(c => c.label);
      rawRows = table.rows.map(r => {
        const obj = {};
        r.c.forEach((cell, i) => obj[headers[i]] = cell ? (cell.v ?? "") : "");
        return obj;
      });
    }

    const rows = rawRows
      .map(normRow)
      .filter(r => r.lake || r.date_raw || r.coords_raw || r.info || r.thickness_in != null || r.thickness_cm != null);

    // Sort newest first by default
    rows.sort((a,b) => b.date_sort - a.date_sort);

    state.rows = rows;
    setStatus(t(state.lang, "status_loaded", rows.length));
  } catch (e) {
    console.error(e);
    setStatus(t(state.lang, "status_error"));
    state.rows = [];
  }
}

function lakeColor(thicknessIn) {
  // Discrete thickness-based colors (requested):
  //   <= 4"  : red
  //   <= 8"  : yellow
  //   <= 10" : green
  //    > 10" : blue
  //   null/NaN: grey
  if (thicknessIn == null || Number.isNaN(Number(thicknessIn))) return "#808080";
  const v = Number(thicknessIn);
  if (v > 10) return "#2563eb";      // blue
  if (v > 8) return "#16a34a";       // green
  if (v > 4) return "#f59e0b";       // yellow
  return "#ef4444";                  // red
}

function updateLegend() {
  const el = document.getElementById("legend");
  el.innerHTML = `
    <div>
      <span style="color:#ef4444;font-weight:700;">●</span> ≤ 4" &nbsp;
      <span style="color:#f59e0b;font-weight:700;">●</span> 4–8" &nbsp;
      <span style="color:#16a34a;font-weight:700;">●</span> 8–10" &nbsp;
      <span style="color:#2563eb;font-weight:700;">●</span> > 10" &nbsp;
      <span style="color:#94a3b8;font-weight:700;">●</span> unknown
    </div>
    <div style="margin-top:6px;">Tip: click markers to see details.</div>
  `;
}

function initMap() {
  map = L.map("map", { preferCanvas: true }).setView([44.96, -93.27], 11);

  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: '&copy; OpenStreetMap'
  }).addTo(map);

  markersLayer = L.layerGroup().addTo(map);
  updateLegend();
}

function renderMap(rows) {
  markersLayer.clearLayers();

  const pts = rows.filter(r => r.coords && isFinite(r.coords.lat) && isFinite(r.coords.lon));

  for (const r of pts) {
    const color = lakeColor(r.thickness_in);
    const thicknessLabel = formatThickness(r);
    const popup = `
      <div style="font-weight:800;margin-bottom:4px;">${escapeHtml(r.lake || "—")}</div>
      <div><b>${escapeHtml(r.date_raw || "—")}</b></div>
      <div>${escapeHtml(thicknessLabel)}</div>
      <div style="color:#94a3b8;margin-top:6px;line-height:1.35;">
        ${escapeHtml(r.info || "")}
      </div>
      <div style="color:#94a3b8;margin-top:6px;">
        ${escapeHtml(r.coords_raw || "")}
      </div>
    `;

    const marker = L.circleMarker([r.coords.lat, r.coords.lon], {
      radius: 7,
      weight: 2,
      color: color,
      fillColor: color,
      fillOpacity: 0.35
    }).bindPopup(popup);

    marker.addTo(markersLayer);
  }

  if (pts.length) {
    const bounds = L.latLngBounds(pts.map(r => [r.coords.lat, r.coords.lon]));
    map.fitBounds(bounds.pad(0.18));
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (m) => ({
    "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;"
  }[m]));
}

function renderLakeOptions(rows) {
  const lakes = Array.from(new Set(rows.map(r => r.lake).filter(Boolean))).sort();
  const sel = document.getElementById("lakeFilter");
  const keep = state.lake;
  sel.innerHTML = `<option value="">All</option>` + lakes.map(l => `<option value="${escapeHtml(l)}">${escapeHtml(l)}</option>`).join("");
  sel.value = keep;
}

function applyFilters() {
  const lake = state.lake;
  const qRaw = (state.search || "").toLowerCase().trim();

  let out = state.rows.slice();

  if (lake) out = out.filter(r => r.lake === lake);

  if (qRaw) {
    // If the search is one or more dates (comma-separated), match on date key.
    const tokens = qRaw.split(",").map(s => s.trim()).filter(Boolean);
    const dateKeys = tokens
      .map(t => {
        const d = parseDate(t);
        if (!d) return null;
        const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
        const dd = String(d.getUTCDate()).padStart(2, "0");
        const yyyy = String(d.getUTCFullYear());
        return `${mm}-${dd}-${yyyy}`;
      })
      .filter(Boolean);

    const isDateOnlySearch = dateKeys.length === tokens.length && tokens.length > 0;

    if (isDateOnlySearch) {
      out = out.filter(r => dateKeys.includes((r.date_key || "").toLowerCase()));
    } else {
      out = out.filter(r =>
        (r.lake || "").toLowerCase().includes(qRaw) ||
        (r.info || "").toLowerCase().includes(qRaw) ||
        (r.date_raw || "").toLowerCase().includes(qRaw) ||
        (r.date_key || "").toLowerCase().includes(qRaw)
      );
    }
  }

  // sort
  out.sort((a,b) => {
    let av, bv;
    switch (state.sortKey) {
      case "lake": av = a.lake; bv = b.lake; break;
      case "info": av = a.info; bv = b.info; break;
      case "coords": av = a.coords_raw; bv = b.coords_raw; break;
      case "thickness":
        av = (state.unit === "in") ? (a.thickness_in ?? -1) : (a.thickness_cm ?? -1);
        bv = (state.unit === "in") ? (b.thickness_in ?? -1) : (b.thickness_cm ?? -1);
        break;
      case "date":
      default:
        av = a.date_sort; bv = b.date_sort;
    }

    if (typeof av === "number" && typeof bv === "number") {
      return state.sortDir === "asc" ? av - bv : bv - av;
    }
    av = (av ?? "").toString();
    bv = (bv ?? "").toString();
    return state.sortDir === "asc" ? av.localeCompare(bv) : bv.localeCompare(av);
  });

  state.filtered = out;
}

function renderTable(rows) {
  const tbody = document.querySelector("#dataTable tbody");
  tbody.innerHTML = "";

  for (const r of rows) {
    const tr = document.createElement("tr");

    const thickness = formatThickness(r);
    const coords = r.coords_raw ? r.coords_raw : t(state.lang, "no_coords");

    const col = lakeColor(r.thickness_in);
    tr.innerHTML = `
      <td>${escapeHtml(r.date_display || toDisplayDate(r.date_raw || r.date_key || "") || "—")}</td>
      <td>${escapeHtml(r.lake || "—")}</td>
      <td>
        <span style="color:${col};font-weight:700;">●</span>
        <span class="badge">${escapeHtml(thickness)}</span>
      </td>
      <td>${escapeHtml(r.info || "")}</td>
      <td>${escapeHtml(coords)}</td>
    `;

    tbody.appendChild(tr);
  }
}

function renderLatestPerLake(rows) {
  // pick latest (max date_sort) per lake
  const byLake = new Map();
  for (const r of rows) {
    if (!r.lake) continue;
    const prev = byLake.get(r.lake);
    if (!prev || r.date_sort > prev.date_sort) byLake.set(r.lake, r);
  }

  const list = Array.from(byLake.values()).sort((a,b) => (b.date_sort - a.date_sort));
  const el = document.getElementById("latestList");
  el.innerHTML = "";

  for (const r of list) {
    const div = document.createElement("div");
    div.className = "latestItem";
    const col = lakeColor(r.thickness_in);
    div.innerHTML = `
      <div class="row1">
        <div>${escapeHtml(r.lake)}</div>
        <div><span style="color:${col};font-weight:700;">●</span> ${escapeHtml(formatThickness(r))}</div>
      </div>
      <div class="row2">
        <div><b>${escapeHtml(r.date_raw || "—")}</b></div>
        <div>${escapeHtml(r.info || "")}</div>
      </div>
    `;
    el.appendChild(div);
  }
}

function wireUI() {
  document.getElementById("lakeFilter").value = state.lake;
  document.getElementById("searchInput").value = state.search;
  document.getElementById("unitSelect").value = state.unit;
  document.getElementById("langSelect").value = state.lang;

  document.getElementById("unitSelect").addEventListener("change", (e) => {
    state.unit = e.target.value;
    localStorage.setItem("unit", state.unit);
    rerenderAll();
  });

  document.getElementById("langSelect").addEventListener("change", (e) => {
    state.lang = e.target.value;
    localStorage.setItem("lang", state.lang);
    applyTranslations(state.lang);
    rerenderAll();
  });
  
    // Map range UI init
  const mapRangeSelect = document.getElementById("mapRangeSelect");
  const customWrap = document.getElementById("customRangeWrap");
  const mapFrom = document.getElementById("mapFrom");
  const mapTo = document.getElementById("mapTo");

  mapRangeSelect.value = state.mapRange;
  mapFrom.value = state.mapFrom;
  mapTo.value = state.mapTo;
  customWrap.style.display = (state.mapRange === "custom") ? "flex" : "none";

  mapRangeSelect.addEventListener("change", () => {
    state.mapRange = mapRangeSelect.value;
    localStorage.setItem("mapRange", state.mapRange);
    customWrap.style.display = (state.mapRange === "custom") ? "flex" : "none";
    rerenderAll();
  });

  mapFrom.addEventListener("change", () => {
    state.mapFrom = mapFrom.value;
    localStorage.setItem("mapFrom", state.mapFrom);
    rerenderAll();
  });

  mapTo.addEventListener("change", () => {
    state.mapTo = mapTo.value;
    localStorage.setItem("mapTo", state.mapTo);
    rerenderAll();
  });

  document.getElementById("lakeFilter").addEventListener("change", (e) => {
    state.lake = e.target.value;
    rerenderAll();
  });

  const searchInput = document.getElementById("searchInput");

// Set initial value (from URL if present)
searchInput.value = state.search || "";

// Update filters + URL as user types
searchInput.addEventListener("input", (e) => {
  state.search = e.target.value;

  // Put the search into the URL so it’s shareable: ?q=...
  setQueryParam("q", state.search, { push: false });

  rerenderAll();
});

  document.getElementById("refreshBtn").addEventListener("click", async () => {
    await loadAndRender();
  });

  document.querySelectorAll("#dataTable thead th").forEach(th => {
    th.addEventListener("click", () => {
      const key = th.getAttribute("data-key");
      if (!key) return;
      if (state.sortKey === key) {
        state.sortDir = (state.sortDir === "asc") ? "desc" : "asc";
      } else {
        state.sortKey = key;
        state.sortDir = (key === "date") ? "desc" : "asc";
      }
      rerenderAll();
    });
  });
}

function rerenderAll() {
  applyFilters();
  renderTable(state.filtered);

  // Map uses date range + current table filters (lake/search) by default:
  const mapRows = filterRowsForMap(state.filtered);
  renderMap(mapRows);

  renderLatestPerLake(state.rows);
  syncStateToURL();
  syncUrlFromState(false);
}

async function loadAndRender() {
  await fetchData();
  renderLakeOptions(state.rows);
  rerenderAll();
}

(function init() {
  hydrateStateFromURL();
  // Load URL params into state first
  readStateFromURL();

  // Pull initial search from URL, e.g. ?q=12-23-2025
  state.search = getQueryParam("q") || "";

  // Sheet link
  const sheetLink = document.getElementById("sheetLink");
  sheetLink.href = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/edit`;
  sheetLink.textContent = `docs.google.com/spreadsheets/d/${SHEET_ID}`;

  applyTranslations(state.lang);
  initMap();
  wireUI();       // wireUI will now set the input value from state.search
  loadAndRender();

  // If the user presses back/forward, sync UI with the URL
  window.addEventListener("popstate", () => {
    const q = getQueryParam("q") || "";
    state.search = q;
    const input = document.getElementById("searchInput");
    if (input) input.value = q;
    rerenderAll();
  });
})();

function toISODateStringUTC(d) {
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function getSeasonStartUTC() {
  // “This season” = Nov 1 of current season year.
  // If today is before Nov 1, season started Nov 1 of previous year.
  const now = new Date();
  const y = now.getUTCFullYear();
  const nov1ThisYear = Date.UTC(y, 10, 1); // month 10 = November
  const seasonYear = (now.getTime() >= nov1ThisYear) ? y : (y - 1);
  return new Date(Date.UTC(seasonYear, 10, 1));
}

function getNowUTCDateFloor() {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

function computeMapDateWindow() {
  const mode = state.mapRange;
  const now = getNowUTCDateFloor();

  if (mode === "all") return { start: null, end: null };

  if (mode === "season") {
    const start = getSeasonStartUTC();
    return { start, end: null };
  }

  const daysMap = { "7d": 7, "14d": 14, "30d": 30 };
  if (daysMap[mode]) {
    const days = daysMap[mode];
    const start = new Date(now.getTime() - (days * 24 * 60 * 60 * 1000));
    return { start, end: null };
  }

  if (mode === "custom") {
    const start = state.mapFrom ? new Date(state.mapFrom + "T00:00:00Z") : null;
    const end = state.mapTo ? new Date(state.mapTo + "T23:59:59Z") : null;
    return { start: start && isFinite(start) ? start : null, end: end && isFinite(end) ? end : null };
  }

  return { start: null, end: null };
}

function filterRowsForMap(rows) {
  const { start, end } = computeMapDateWindow();
  if (!start && !end) return rows;

  return rows.filter(r => {
    if (!r.date || !r.date_sort) return false; // no date => don’t show on map
    const t = r.date_sort;
    if (start && t < start.getTime()) return false;
    if (end && t > end.getTime()) return false;
    return true;
  });
}

function readStateFromURL() {
  const url = new URL(window.location.href);
  const p = url.searchParams;

  // Table filters
  if (p.has("q")) state.search = p.get("q") || "";
  if (p.has("lake")) state.lake = p.get("lake") || "";

  // Display prefs
  if (p.has("unit")) state.unit = p.get("unit") || state.unit;
  if (p.has("lang")) state.lang = p.get("lang") || state.lang;

  // Sorting
  if (p.has("sort")) state.sortKey = p.get("sort") || state.sortKey;
  if (p.has("dir")) state.sortDir = p.get("dir") || state.sortDir;

  // Map date range
  if (p.has("range")) state.mapRange = p.get("range") || state.mapRange;
  if (p.has("from")) state.mapFrom = p.get("from") || "";
  if (p.has("to")) state.mapTo = p.get("to") || "";
}

function syncStateToURL() {
  const url = new URL(window.location.href);
  const p = url.searchParams;

  // Always include these so links are “exact view”
  p.set("unit", state.unit);
  p.set("lang", state.lang);
  p.set("sort", state.sortKey);
  p.set("dir", state.sortDir);

  // Optional filters
  if (state.search && state.search.trim() !== "") p.set("q", state.search.trim());
  else p.delete("q");

  if (state.lake && state.lake.trim() !== "") p.set("lake", state.lake.trim());
  else p.delete("lake");

  // Map range
  p.set("range", state.mapRange);
  if (state.mapRange === "custom") {
    if (state.mapFrom) p.set("from", state.mapFrom); else p.delete("from");
    if (state.mapTo) p.set("to", state.mapTo); else p.delete("to");
  } else {
    p.delete("from");
    p.delete("to");
  }

  // Update the URL without reloading
  window.history.replaceState({}, "", url.toString());
}