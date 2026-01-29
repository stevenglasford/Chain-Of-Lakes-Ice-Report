// ==========================
//  CONFIG — EDIT THESE ONLY
// ==========================
const SHEET_ID = "10smiQBJ8mBWax24aOagG9LdzrrnhFmj0tfRESunUJNI";

// Option A (recommended): if you publish to web, use CSV export like below.
// You must set the gid of your data tab.
// If you're not sure, open your sheet and look for ".../edit#gid=123456"
const GID = "2029178353";

// Name of the tab that contains the combined dataset
const DATA_SHEET_NAME = "AllData";

// If using Publish-to-web CSV, this works well:
const CSV_URL = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/export?format=csv&gid=${GID}`;

// Option B (fallback): Google Visualization JSON endpoint (sometimes blocked).
const GVIZ_URL = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?tqx=out:json&sheet=${encodeURIComponent(DATA_SHEET_NAME)}`;

// Choose fetch mode:
// GViz usually works without needing "Publish to web", so it's the safest default.
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
  reports: [],
  reportDate: "",
  mapRange: localStorage.getItem("mapRange") || "all",
  mapFrom: localStorage.getItem("mapFrom") || "",
  mapTo: localStorage.getItem("mapTo") || "",
  latestMarkdown: "",
};

let map, markersLayer;

function setStatus(msg) {
  document.getElementById("statusLine").textContent = msg;
}

async function copyTextToClipboard(text) {
  if (!text) return false;
  // Modern API
  try {
    if (navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch (_) {}

  // Fallback
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.left = "-9999px";
    ta.style.top = "0";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    return !!ok;
  } catch (_) {
    return false;
  }
}

function applyCellExpandButtonsToMarkdownTables(rootEl) {
  if (!rootEl) return;

  const tables = rootEl.querySelectorAll("table");
  tables.forEach((table) => {
    // Only touch tables inside your markdown renderer
    // (If your rootEl is already the md container, this is enough.)
    const tds = table.querySelectorAll("tbody td:last-child");
    tds.forEach((td) => {
      // Skip if we've already processed this cell
      if (td.querySelector(".cellClampText")) return;

      // Wrap existing content
      const wrap = document.createElement("div");
      wrap.className = "cellClampText";
      wrap.innerHTML = td.innerHTML;

      td.innerHTML = "";
      td.appendChild(wrap);

      // Add button (hidden unless clamped)
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "cellExpandBtn";

      const EMOJI_EXPAND = "⤢";
      const EMOJI_COLLAPSE = "⤡";
      btn.textContent = EMOJI_EXPAND;
      btn.title = "Expand";
      btn.setAttribute("aria-label", "Expand");
      
      btn.addEventListener("click", () => {
        const expanded = td.classList.toggle("cellExpanded");
        btn.textContent = expanded ? EMOJI_COLLAPSE : EMOJI_EXPAND;
        btn.title = expanded ? "Collapse" : "Expand";
        btn.setAttribute("aria-label", btn.title);
      });

      td.appendChild(btn);

      // After layout, detect overflow and enable the button only when needed
      requestAnimationFrame(() => {
        // If content is taller than the clamped box, it's clamped
        const isOverflowing = wrap.scrollHeight > wrap.clientHeight + 1;
        if (isOverflowing) {
          td.classList.add("cellClamped");
        } else {
          // No need for button if not clamped
          btn.remove();
        }
      });
    });
  });
}

function buildLatestByLake(rows) {
  const latest = new Map();

  for (const row of rows) {
    const lake = row.lake;
    const date = new Date(row.date);

    if (!latest.has(lake) || date > latest.get(lake).date) {
      latest.set(lake, { ...row, date });
    }
  }

  return Array.from(latest.values());
}

function buildLatestDayRows(rows) {
  // "Latest" = all points from the most recent *date* present in the current filtered dataset.
  // (Not "latest per lake".)
  let maxDayKey = null;

  for (const r of rows) {
    if (!r || !r.date_sort) continue;
    const d = new Date(r.date_sort);
    if (isNaN(d.getTime())) continue;
    const dayKey = d.getFullYear() + "-" + String(d.getMonth()+1).padStart(2,"0") + "-" + String(d.getDate()).padStart(2,"0");
    if (maxDayKey === null || dayKey > maxDayKey) maxDayKey = dayKey;
  }

  if (!maxDayKey) return [];

  return rows.filter(r => {
    if (!r || !r.date_sort) return false;
    const d = new Date(r.date_sort);
    if (isNaN(d.getTime())) return false;
    const dayKey = d.getFullYear() + "-" + String(d.getMonth()+1).padStart(2,"0") + "-" + String(d.getDate()).padStart(2,"0");
    return dayKey === maxDayKey;
  });
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
  // Your format is M-D-YYYY or MM-DD-YYYY (e.g., 12-23-2025)
  if (!raw) return null;
  const s = String(raw).trim();
  const m = s.match(/^(\d{1,2})-(\d{1,2})-(\d{4})$/);
  if (!m) return null;
  const mm = Number(m[1]);
  const dd = Number(m[2]);
  const yyyy = Number(m[3]);
  const d = new Date(Date.UTC(yyyy, mm - 1, dd));
  return isFinite(d.getTime()) ? d : null;
}

function normalizeDashDate(s) {
  // Normalize "MM-DD-YYYY" or "M-D-YYYY" to "M-D-YYYY"
  if (!s) return "";
  const m = String(s).trim().match(/^(\d{1,2})-(\d{1,2})-(\d{4})$/);
  if (!m) return String(s).trim();
  const mm = String(Number(m[1]));
  const dd = String(Number(m[2]));
  const yyyy = m[3];
  return `${mm}-${dd}-${yyyy}`;
}

function parseDateTokensFromSearch(s) {
  // If s is "12-31-2025,12-30-2025" -> ["12-31-2025","12-30-2025"]
  // Only returns tokens that look like dash dates.
  if (!s) return [];
  return String(s)
    .split(",")
    .map(x => normalizeDashDate(x))
    .map(x => x.trim())
    .filter(x => /^\d{1,2}-\d{1,2}-\d{4}$/.test(x));
}


function buildDateRegexFromSearch(s) {
  // Build a regex that matches ANY date found in the search text.
  // Accepts dates like 12-31-2025 or 12/31/2025 (also allows single-digit M/D).
  // If no date-like tokens are found, returns null.
  if (!s) return null;
  const text = String(s);

  const matches = [];
  const re = /(\d{1,2})[\/-](\d{1,2})[\/-](\d{4})/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const mm = Number(m[1]);
    const dd = Number(m[2]);
    const yyyy = m[3];
    if (!Number.isFinite(mm) || !Number.isFinite(dd)) continue;
    // Allow optional leading zeros and either "-" or "/"
    const mmPat = mm < 10 ? `0?${mm}` : `${mm}`;
    const ddPat = dd < 10 ? `0?${dd}` : `${dd}`;
    // Match the whole date cell, trimming whitespace
    matches.push(`\\s*${mmPat}[\\/-]${ddPat}[\\/-]${yyyy}\\s*`);
  }

  if (!matches.length) return null;
  // OR all date patterns together; anchored to full field
  return new RegExp(`^(?:${matches.join("|")})$`, "i");
}

function normRow(obj) {
  // Flexible header matching
  const dateRaw = obj["Date"] ?? obj["date"] ?? obj["DATE"];
  const lake = (obj["Lake"] ?? obj["lake"] ?? "").toString().trim();
  const coordsRaw = obj["Coordinates"] ?? obj["coords"] ?? obj["Coordinate"] ?? "";
  const info = (obj["Info"] ?? obj["info"] ?? "").toString().trim();

  const thicknessInRaw = obj["Thickness (Inches)"] ?? obj["thickness_in"] ?? obj["Thickness"] ?? obj["thickness"] ?? "";
  const thicknessCmRaw = obj["Thickness (cm)"] ?? obj["Thickness_cm"] ?? obj["Thickness (cm) "] ?? obj["thickness_cm"] ?? "";

  const dateObj = parseDate(dateRaw);
  const coords = parseCoords(coordsRaw);

  const thickness_in = parseMixedFractionToInches(thicknessInRaw);
  const thickness_cm = (thicknessCmRaw !== "" && thicknessCmRaw != null && isFinite(Number(thicknessCmRaw)))
    ? Number(thicknessCmRaw)
    : (thickness_in != null ? inchesToCm(thickness_in) : null);

  return {
    date_raw: dateRaw ? String(dateRaw).trim() : "",
    date: dateObj,
    date_sort: dateObj ? dateObj.getTime() : 0,
    lake,
    coords_raw: coordsRaw ? String(coordsRaw).trim() : "",
    coords,
    info,
    thickness_in,
    thickness_cm,
    thickness_in_raw: (thicknessInRaw!=null?String(thicknessInRaw).trim():""),
    thickness_cm_raw: (thicknessCmRaw!=null?String(thicknessCmRaw).trim():"")
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
      const resp = await fetch(CSV_URL + `&_=${Date.now()}`, { cache: "no-store" });
      if (!resp.ok) throw new Error("CSV fetch failed");
      const text = await resp.text();
      rawRows = csvToObjects(text);
    } else {
      const resp = await fetch(GVIZ_URL + `&_=${Date.now()}`, { cache: "no-store" });
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
  // Basic scale: 0 -> red, 12+ -> green-ish; clamp
  if (thicknessIn == null) return "#94a3b8";
  const v = Math.max(0, Math.min(12, thicknessIn));
  const pct = v / 12;
  // interpolate red->yellow->green
  const r = pct < 0.5 ? 255 : Math.round(255 * (1 - (pct - 0.5) * 2));
  const g = pct < 0.5 ? Math.round(255 * (pct * 2)) : 255;
  const b = 70;
  return `rgb(${r},${g},${b})`;
}

function updateLegend() {
  const el = document.getElementById("legend");
  el.innerHTML = `
    <div><span class="badge">●</span> Marker color roughly follows thickness (thin = red, thick = green).</div>
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
  const dateTokens = parseDateTokensFromSearch(state.search);
  const q = state.search.toLowerCase().trim();

  let out = state.rows.slice();

  if (lake) out = out.filter(r => r.lake === lake);

  if (q) {
    const dateRe = buildDateRegexFromSearch(state.search);
    const hasComma = state.search.includes(",");
    const tokenCount = parseDateTokensFromSearch(state.search).length;

    if (dateRe && (hasComma || tokenCount >= 2)) {
      // Regex-based multi-date match against the date field (accepts "-" or "/")
      out = out.filter(r => dateRe.test(String(r.date_raw || "")));
    } else {
      out = out.filter(r =>
        (r.lake || "").toLowerCase().includes(q) ||
        (r.info || "").toLowerCase().includes(q) ||
        (r.date_raw || "").toLowerCase().includes(q)
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

    tr.innerHTML = `
      <td>${escapeHtml(r.date_raw || "—")}</td>
      <td>${escapeHtml(r.lake || "—")}</td>
      <td><span class="badge">${escapeHtml(thickness)}</span></td>
      <td>${escapeHtml(r.info || "")}</td>
      <td>${escapeHtml(coords)}</td>
    `;

    tbody.appendChild(tr);
  }
}

// ---------------------------
// Two-week "Latest" summary + "Outdated points"
// ---------------------------

const DAY_MS = 24 * 60 * 60 * 1000;
const TWO_WEEKS_MS = 14 * DAY_MS;

function roundToEighth(inches) {
  if (inches == null || !isFinite(inches)) return null;
  return Math.round(inches * 8) / 8;
}

function inchesToMixedFraction(inches) {
  // Converts decimal inches to a mixed fraction rounded to nearest 1/8.
  // Examples: 13 -> "13", 13.25 -> "13 1/4", 0.125 -> "1/8"
  const v = roundToEighth(inches);
  if (v == null) return "—";
  const whole = Math.floor(v + 1e-9);
  const frac = v - whole;
  const n = Math.round(frac * 8);

  const gcd = (a, b) => (b ? gcd(b, a % b) : a);
  if (n === 0) return String(whole);
  if (whole === 0) {
    const g = gcd(n, 8);
    return `${n / g}/${8 / g}`;
  }
  const g = gcd(n, 8);
  return `${whole} ${n / g}/${8 / g}`;
}

function formatDeltaInches(delta) {
  if (delta == null || !isFinite(delta)) return "N/A";
  if (Math.abs(delta) < 1e-9) return "0";
  const sign = delta > 0 ? "+" : "−";
  return `${sign}${inchesToMixedFraction(Math.abs(delta))}`;
}

function isHazardRow(r) {
  const t = r?.thickness_in;
  const info = String(r?.info || "").toLowerCase();
  // Treat <= 1/4" or explicit hazards as unsafe for averaging.
  if (t == null || !isFinite(t)) return true;
  if (t <= 0.25) return true;
  if (info.includes("portage")) return true;
  if (info.includes("hole")) return true;
  if (info.includes("open water")) return true;
  if (info.includes("leak")) return true;
  if (info.includes("thin")) return true;
  if (info.trim() === "!") return true;
  return false;
}

function mean(nums) {
  const arr = nums.filter(v => v != null && isFinite(v));
  if (!arr.length) return null;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function summarizeNotesForDate(rowsOnDate) {
  const infos = rowsOnDate
    .map(r => String(r.info || "").trim())
    .filter(Boolean)
    .filter(x => x !== "!");

  const hazards = rowsOnDate.filter(isHazardRow);
  const hazardInfo = hazards.map(r => String(r.info || "").trim()).filter(Boolean);

  // Keep notes short: first 2 unique signals.
  const uniq = (xs) => {
    const out = [];
    const seen = new Set();
    for (const x of xs) {
      const k = x.toLowerCase();
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(x);
    }
    return out;
  };

  const bits = [];
  if (hazards.length) {
    // Prefer explicit hazard notes when present
    const h = uniq(hazardInfo);
    if (h.length) bits.push(...h.slice(0, 2));
    else bits.push("⚠️ Hazard / thin spot");
  }

  const clean = uniq(infos);
  for (const x of clean) {
    if (bits.length >= 2) break;
    bits.push(x);
  }

  return bits.join("; ");
}

function computeLatestSummary(rows) {
  const dated = rows.filter(r => r.date_sort);
  if (!dated.length) return { latest: [], outdated: [], latestDate: null, cutoff: null };

  const mostRecent = Math.max(...dated.map(r => r.date_sort));
  const latestDate = new Date(mostRecent);
  const cutoff = mostRecent - TWO_WEEKS_MS;

  // Group all rows by lake/location
  const byLake = new Map();
  for (const r of dated) {
    if (!r.lake) continue;
    const arr = byLake.get(r.lake) || [];
    arr.push(r);
    byLake.set(r.lake, arr);
  }

  const latest = [];
  const outdated = [];

  for (const [lake, lakeRows] of byLake.entries()) {
    lakeRows.sort((a, b) => b.date_sort - a.date_sort);
    const rLatestAny = lakeRows[0];
    if (!rLatestAny) continue;

    // Outdated points = latest measurement older than 14 days from global most recent date
    if (rLatestAny.date_sort < cutoff) {
      outdated.push(rLatestAny);
      continue;
    }

    // Latest date for this lake (within last 14 days)
    const latestDateRaw = rLatestAny.date_raw;
    const rowsLatestDate = lakeRows.filter(r => r.date_raw === latestDateRaw);

    // Previous measurement date for delta (immediate prior date with >=1 valid thickness)
    const prevDateRaw = lakeRows.find(r => r.date_raw !== latestDateRaw)?.date_raw || "";
    const rowsPrevDate = prevDateRaw ? lakeRows.filter(r => r.date_raw === prevDateRaw) : [];

    const validLatest = rowsLatestDate.filter(r => !isHazardRow(r));
    const validPrev = rowsPrevDate.filter(r => !isHazardRow(r));

    const latestVals = validLatest.map(r => r.thickness_in).filter(v => v != null && isFinite(v));
    const prevVals = validPrev.map(r => r.thickness_in).filter(v => v != null && isFinite(v));

    const minV = latestVals.length ? Math.min(...latestVals) : null;
    const maxV = latestVals.length ? Math.max(...latestVals) : null;
    const avgV = mean(latestVals);
    const prevAvg = mean(prevVals);
    const delta = (avgV != null && prevAvg != null) ? (avgV - prevAvg) : null;

    latest.push({
      lake,
      date_raw: latestDateRaw,
      samples: latestVals.length,
      min: minV,
      max: maxV,
      avg: avgV,
      delta,
      notes: summarizeNotesForDate(rowsLatestDate),
      sortKey: rLatestAny.date_sort,
    });
  }

  // Sort latest summary: newest lakes first, then name
  latest.sort((a, b) => (b.sortKey - a.sortKey) || a.lake.localeCompare(b.lake));
  // Sort outdated: oldest first (more urgent to update), then name
  outdated.sort((a, b) => (a.date_sort - b.date_sort) || (a.lake || "").localeCompare(b.lake || ""));

  return { latest, outdated, latestDate, cutoff: new Date(cutoff) };
}

function renderLatestSummaryTable(summaryRows) {
  const tbody = document.querySelector("#latestSummaryTable tbody");
  if (!tbody) return;
  tbody.innerHTML = "";

  for (const s of summaryRows) {
    const tr = document.createElement("tr");

    const minS = (s.min == null) ? "—" : inchesToMixedFraction(s.min);
    const maxS = (s.max == null) ? "—" : inchesToMixedFraction(s.max);
    const avgS = (s.avg == null) ? "⚠️" : inchesToMixedFraction(s.avg);
    const dS = (s.delta == null) ? "N/A" : formatDeltaInches(s.delta);

    tr.innerHTML = `
      <td><b>${escapeHtml(s.lake)}</b></td>
      <td style="text-align:right;">${escapeHtml(String(s.samples || 0))}</td>
      <td style="text-align:right;">${escapeHtml(minS)}</td>
      <td style="text-align:right;">${escapeHtml(maxS)}</td>
      <td style="text-align:right;"><b>${escapeHtml(avgS)}</b></td>
      <td style="text-align:right;"><b>${escapeHtml(dS)}</b></td>
      <td>${escapeHtml(s.notes || "")}</td>
    `;
    tbody.appendChild(tr);
  }
}

function renderOutdatedPointsTable(rows) {
  const tbody = document.querySelector("#outdatedPointsTable tbody");
  if (!tbody) return;
  tbody.innerHTML = "";

  for (const r of rows) {
    const tr = document.createElement("tr");
    const thickness = formatThickness(r);
    const coords = r.coords_raw ? r.coords_raw : t(state.lang, "no_coords");
    tr.innerHTML = `
      <td>${escapeHtml(r.date_raw || "—")}</td>
      <td>${escapeHtml(r.lake || "—")}</td>
      <td><span class="badge">${escapeHtml(thickness)}</span></td>
      <td>${escapeHtml(r.info || "")}</td>
      <td>${escapeHtml(coords)}</td>
    `;
    tbody.appendChild(tr);
  }
}

function buildLatestMarkdown(summary, outdatedRows, latestDate, cutoffDate) {
  const fmtDash = (d) => {
    if (!d) return "—";
    // Convert UTC date to M-D-YYYY
    const mm = d.getUTCMonth() + 1;
    const dd = d.getUTCDate();
    const yyyy = d.getUTCFullYear();
    return `${mm}-${dd}-${yyyy}`;
  };

  const titleDate = fmtDash(latestDate);
  const cutoff = fmtDash(cutoffDate);

  const lines = [];
  lines.push(`**As of:** ${titleDate} (includes measurements back to ${cutoff})`);
  lines.push(``);
  lines.push(`| Lake / Location | Samples | Min | Max | Avg (≈) | Change | Notes |`);
  lines.push(`|---|---:|---:|---:|---:|---:|---|`);

  for (const s of summary) {
    const minS = (s.min == null) ? "—" : inchesToMixedFraction(s.min);
    const maxS = (s.max == null) ? "—" : inchesToMixedFraction(s.max);
    const avgS = (s.avg == null) ? "⚠️" : inchesToMixedFraction(s.avg);
    const dS = (s.delta == null) ? "N/A" : formatDeltaInches(s.delta);
    const notes = (s.notes || "").replace(/\|/g, "/"); // avoid breaking tables
    lines.push(`| **${s.lake}** | ${s.samples || 0} | ${minS} | ${maxS} | **${avgS}** | **${dS}** | ${notes} |`);
  }

  if (outdatedRows && outdatedRows.length) {
    lines.push(``);
    lines.push(`### Outdated points (latest measurement older than 14 days)`);
    lines.push(`| Date | Lake / Location | Thickness | Notes |`);
    lines.push(`|---|---|---:|---|`);
    for (const r of outdatedRows) {
      const thick = inchesToMixedFraction(r.thickness_in);
      const note = String(r.info || "").replace(/\|/g, "/");
      lines.push(`| ${r.date_raw || "—"} | **${r.lake || "—"}** | ${thick} | ${note} |`);
    }
  }

  return lines.join("\n");
}

function renderLatestAndOutdated() {
  const { latest, outdated, latestDate, cutoff } = computeLatestSummary(state.rows);
  renderLatestSummaryTable(latest);
  renderOutdatedPointsTable(outdated);

    
  // Console markdown (copy/paste for Reddit) + store for copy button
  const md = buildLatestMarkdown(latest, outdated, latestDate, cutoff);
  state.latestMarkdown = md;

  const renderedEl = document.getElementById("latestMarkdownRendered");
  if (renderedEl) {
    const html = marked.parse(md, { gfm: true, breaks: false });
    renderedEl.innerHTML = DOMPurify.sanitize(html);
    applyCellExpandButtonsToMarkdownTables(renderedEl);
  }
  
  // Enable copy button once we have markdown
  const copyBtn = document.getElementById("copyLatestMarkdownBtn");
  if (copyBtn) copyBtn.disabled = !md;

  console.log("\n" + md + "\n");  
  
  if (copyBtn) copyBtn.disabled = !md;
  console.log("\n" + md + "\n");
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
    div.innerHTML = `
      <div class="row1">
        <div>${escapeHtml(r.lake)}</div>
        <div>${escapeHtml(formatThickness(r))}</div>
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

  document.getElementById("searchInput").addEventListener("input", (e) => {
    state.search = e.target.value;
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

  const copyBtn = document.getElementById("copyLatestMarkdownBtn");
  if (copyBtn) {
    copyBtn.addEventListener("click", async () => {
      const md = state.latestMarkdown || "";
      if (!md) return;

      try {
        await navigator.clipboard.writeText(md);
        // optional tiny UX feedback:
        copyBtn.classList.add("copied");
        setTimeout(() => copyBtn.classList.remove("copied"), 700);
      } catch (e) {
        // fallback if clipboard is blocked
        const ta = document.createElement("textarea");
        ta.value = md;
        document.body.appendChild(ta);
        ta.select();
        document.execCommand("copy");
        ta.remove();
      }
    });
  }
}

function rerenderAll() {
  applyFilters();
  renderTable(state.filtered);

  // Map uses date range + current table filters (lake/search) by default:
  let mapRows;
  if (state.mapRange === "latest") {
    // Show ALL points from the most recent measurement date in the current filtered dataset
    mapRows = buildLatestDayRows(state.filtered);
  } else {
    mapRows = filterRowsForMap(state.filtered);
  }
  renderMap(mapRows);

  renderLatestPerLake(state.rows);

  // Two-week summary tables + console markdown output
  renderLatestAndOutdated();

  // Keep the URL updated so people can share exactly what they're viewing.
  syncShareURLFromState();
}

function hydrateShareStateFromURL() {
  const url = new URL(window.location.href);
  const p = url.searchParams;

  // Table filters
  const dates = p.get("dates");
  const q = p.get("q");
  const lake = p.get("lake");
  // Prefer dates= over q= if present
  if (dates !== null) state.search = dates;
  else if (q !== null) state.search = q;
  if (lake !== null) state.lake = lake;

  // Map range
  //const mr = p.get("mr");
  const from = p.get("from");
  const to = p.get("to");
  // if (mr) state.mapRange = mr;
  if (from) state.mapFrom = from;
  if (to) state.mapTo = to;
  const params = new URLSearchParams(window.location.search);

  // Map range default logic
  if (!params.has("mr")) {
    state.mapRange = "latest";   // DEFAULT for direct visits
  } else {
    state.mapRange = params.get("mr");
  }

  // UI prefs
  const unit = p.get("unit");
  const lang = p.get("lang");
  if (unit) state.unit = unit;
  if (lang) state.lang = lang;
}

function syncShareURLFromState() {
  const url = new URL(window.location.href);
  const p = url.searchParams;

  // Only include non-default values so the URL stays clean.
  const dateTokens = parseDateTokensFromSearch(state.search);
  if (dateTokens.length >= 2) {
    p.set("dates", dateTokens.join(","));
    p.delete("q");
  } else {
    p.delete("dates");
    if (state.search) p.set("q", state.search); else p.delete("q");
  }
  if (state.lake) p.set("lake", state.lake); else p.delete("lake");

  // Map range: keep URL clean when using default "latest"
  if (state.mapRange === "latest") {
    p.delete("mr");
  } else if (state.mapRange) {
    p.set("mr", state.mapRange);
  } else {
    p.delete("mr");
  }

  if (state.mapRange === "custom") {
    if (state.mapFrom) p.set("from", state.mapFrom); else p.delete("from");
    if (state.mapTo) p.set("to", state.mapTo); else p.delete("to");
  } else {
    p.delete("from");
    p.delete("to");
  }

  if (state.unit && state.unit !== "cm") p.set("unit", state.unit); else p.delete("unit");
  if (state.lang && state.lang !== "en") p.set("lang", state.lang); else p.delete("lang");

  const qs = p.toString();
  const newUrl = url.pathname + (qs ? `?${qs}` : "") + url.hash;
  window.history.replaceState({}, "", newUrl);
}



// ---------------------------
// Reddit ice reports (direct from Reddit, no caching)
// ---------------------------
// NOTE: Reddit may block some requests in some environments. If it fails,
// the rest of the app still works.
const REDDIT_USERNAME = "stevenglasford"; // change if needed
const REDDIT_FETCH_LIMIT = 100;
const REDDIT_REPORT_TITLE_RE = /^(?:Ice Report|Chain of Lakes Ice Report|Minneapolis Chain of Lakes Ice Report|Minneapolis Frozen Lakes Report|Frozen Lakes Report)\b/i;

function normalizeDashOrSlashDateToDash(s) {
  // Accept 12-31-2025 or 12/31/2025 -> 12-31-2025 (no leading zeros requirement)
  if (!s) return "";
  const m = String(s).trim().match(/^(\d{1,2})[\/-](\d{1,2})[\/-](\d{4})$/);
  if (!m) return "";
  const mm = String(Number(m[1]));
  const dd = String(Number(m[2]));
  const yyyy = m[3];
  return `${mm}-${dd}-${yyyy}`;
}

function extractDashDateFromTitle(title) {
  // Finds first MM-DD-YYYY or MM/DD/YYYY in a title
  if (!title) return "";
  const m = String(title).match(/(\d{1,2}[\/-]\d{1,2}[\/-]\d{4})/);
  return m ? (normalizeDashOrSlashDateToDash(m[1]) || "") : "";
}

function ensureReportsUI() {
  // Create a report card at the top of <main class="grid"> without changing HTML.
  if (document.getElementById('reportSelect')) return;

  const main = document.querySelector('main.grid');
  if (!main) return;

  const section = document.createElement('section');
  section.className = 'card reportCard';

  section.innerHTML = `
    <div class="cardHeader">
      <div>
        <div class="cardTitle" id="t_reports">Frozen Lakes Report</div>
        <div class="cardMeta" id="t_reports_hint">Latest Reddit report (select a date)</div>
      </div>
      <div class="filters" style="gap:10px; align-items:center;">
        <label class="control">
          <span id="t_reports_date">Date</span>
          <select id="reportSelect"></select>
        </label>
        <a id="reportLink" class="btn" target="_blank" rel="noreferrer" style="display:none; text-decoration:none;"><span id="t_reports_open">Open</span></a>
      </div>
    </div>
    <div id="reportBody" class="reportBody" style="padding:12px 16px;">
      <div id="reportStatus" class="cardMeta" style="margin-bottom:8px;"></div>
      <div id="reportText" class="reportText"></div>
      <div id="reportPermalink" class="cardMeta" style="margin-top:10px;"></div>
      <div style="margin-top:10px;">
        <button id="reportToggle" class="btn" type="button" style="display:none;"></button>
      </div>
      <div id="reportMedia" style="margin-top:12px;"></div>
    </div>
  `;

  // Insert as first card in grid
  main.insertBefore(section, main.firstChild);

  // Translate newly inserted nodes
  if (typeof applyTranslations === 'function') applyTranslations(state.lang);
}

function extractMediaFromPost(p) {
  const items = [];

  // Gallery posts
  if (p && p.is_gallery && p.gallery_data && p.media_metadata) {
    const arr = (p.gallery_data.items || []);
    for (const it of arr) {
      const meta = p.media_metadata[it.media_id];
      const u = decodeHtmlEntities(meta?.s?.u || "");
      if (u) items.push({ type: "image", url: u });
    }
  }

  // Single image
  const uod = p?.url_overridden_by_dest || "";
  if (p?.post_hint === "image" && uod) items.push({ type: "image", url: uod });

  // Preview images (fallback)
  const prev = p?.preview?.images?.[0]?.source?.url;
  if (prev) items.push({ type: "image", url: decodeHtmlEntities(prev) });

  // Reddit hosted video
  const v = p?.media?.reddit_video?.fallback_url;
  if (v) items.push({ type: "video", url: v });

  // Remove duplicates
  const seen = new Set();
  return items.filter(it => {
    if (!it.url) return false;
    const k = `${it.type}|${it.url}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

async function fetchRedditReports() {
  const url = `https://www.reddit.com/user/${encodeURIComponent(REDDIT_USERNAME)}/submitted.json?limit=${REDDIT_FETCH_LIMIT}&raw_json=1`;
  const resp = await fetch(url, { cache: 'no-store' });
  if (!resp.ok) throw new Error(`Reddit HTTP ${resp.status}`);
  const json = await resp.json();
  const posts = (json && json.data && json.data.children ? json.data.children : []).map(c => c && c.data).filter(Boolean);

  const reports = [];
  for (const p of posts) {
    const title = p.title || '';
    if (!REDDIT_REPORT_TITLE_RE.test(title)) continue;
    const date = extractDashDateFromTitle(title);
    if (!date) continue;
    reports.push({
      date,
      title,
      permalink: p.permalink ? `https://www.reddit.com${p.permalink}` : '',
      selftext: p.selftext || '',
      created_utc: p.created_utc || 0,
      media: extractMediaFromPost(p),
    });
  }

  // Deduplicate by date (keep newest post for that date)
  const byDate = new Map();
  for (const r of reports) {
    const prev = byDate.get(r.date);
    if (!prev || (r.created_utc || 0) > (prev.created_utc || 0)) byDate.set(r.date, r);
  }

  // Sort by date desc
  const out = Array.from(byDate.values()).sort((a, b) => {
    const da = parseDate(a.date)?.getTime() || 0;
    const db = parseDate(b.date)?.getTime() || 0;
    if (db !== da) return db - da;
    return (b.created_utc || 0) - (a.created_utc || 0);
  });

  state.reports = out;
  return out;
}

function firstNWords(text, n) {
  const words = String(text || "").trim().split(/\s+/).filter(Boolean);
  return {
    preview: words.slice(0, n).join(" "),
    truncated: words.length > n,
  };
}

function decodeHtmlEntities(s) {
  // Reddit gallery URLs sometimes contain &amp;
  return String(s || "").replaceAll("&amp;", "&");
}

function setReportSelection(date) {
  const sel = document.getElementById('reportSelect');
  if (!sel) return;

  const report = (state.reports || []).find(r => r.date === date) || null;
  state.reportDate = report ? report.date : '';

  // Sync URL param report= (shareable), without disturbing existing q/dates filters
  try {
    const u = new URL(window.location.href);
    const p = u.searchParams;
    if (state.reportDate) p.set('report', state.reportDate);
    else p.delete('report');
    u.search = p.toString();
    window.history.replaceState({}, '', u.toString());
  } catch (_) {}

  const status = document.getElementById('reportStatus');
  const text = document.getElementById('reportText');
  const link = document.getElementById('reportLink');
  const pl = document.getElementById("reportPermalink");
  
  if (pl) {
    if (report.permalink) {
      const href = report.permalink;
      pl.innerHTML = `<a href="${href}" target="_blank" rel="noreferrer">${href}</a>`;
    } else {
      pl.textContent = "";
    }
  }
  

  if (!report) {
    if (status) status.textContent = (typeof t === 'function') ? t(state.lang, 't_reports_none') : '';
    if (text) text.textContent = '';
    if (link) link.style.display = 'none';
    const mediaBox = document.getElementById("reportMedia");
    if (mediaBox) { mediaBox.innerHTML = ""; mediaBox.style.display = "none"; }
    return;
  }

  if (status) status.textContent = report.title;
  // --- Text rendering: 100 words + Read more toggle ---
  const full = (report.selftext || "").trim();
  const cut = firstNWords(full, 25);
  
  const toggleBtn = document.getElementById("reportToggle");
  const expandedKey = `reportExpanded:${report.date}`;
  const expanded = (sessionStorage.getItem(expandedKey) === "1");
  
  // --- Media: only show when expanded ---
  const mediaBox = document.getElementById("reportMedia");
  if (mediaBox) {
    if (!expanded) {
      // Hide media when collapsed
      mediaBox.innerHTML = "";
      mediaBox.style.display = "none";
    } else {
      mediaBox.style.display = "";
      mediaBox.innerHTML = "";
  
      const media = report.media || [];
      for (const m of media) {
        if (m.type === "image") {
          const img = document.createElement("img");
          img.src = m.url;
          img.loading = "lazy";
          img.style.maxWidth = "100%";
          img.style.display = "block";
          img.style.marginTop = "10px";
          mediaBox.appendChild(img);
        } else if (m.type === "video") {
          const a = document.createElement("a");
          a.href = m.url;
          a.target = "_blank";
          a.rel = "noreferrer";
          a.textContent = m.url;
          a.style.display = "block";
          a.style.marginTop = "10px";
          mediaBox.appendChild(a);
        }
      }
    }
  }
  const shown = expanded ? full : cut.preview;
  
  // Render markdown if available (see section E)
  if (text) {
    if (window.marked && typeof window.marked.parse === "function") {
      text.innerHTML = window.marked.parse(shown || "");
    } else {
      // fallback (still readable)
      text.textContent = shown || "";
      text.style.whiteSpace = "pre-wrap";
    }
  }
  
  if (toggleBtn) {
    if (cut.truncated) {
      toggleBtn.style.display = "";
      toggleBtn.textContent = expanded
        ? ((typeof t === "function") ? t(state.lang, "t_show_less") : "Show less")
        : ((typeof t === "function") ? t(state.lang, "t_read_more") : "Read more");
  
      toggleBtn.onclick = () => {
        sessionStorage.setItem(expandedKey, expanded ? "0" : "1");
        setReportSelection(report.date);
      };
    } else {
      toggleBtn.style.display = "none";
    }
  }
    if (link) {
      link.href = report.permalink || '#';
      link.style.display = report.permalink ? '' : 'none';
    }
  
}

function ensureMarkedLoaded() {
  return new Promise((resolve) => {
    if (window.marked && typeof window.marked.parse === "function") return resolve(true);
    const s = document.createElement("script");
    s.src = "https://cdn.jsdelivr.net/npm/marked/marked.min.js";
    s.onload = () => resolve(true);
    s.onerror = () => resolve(false); // fail gracefully
    document.head.appendChild(s);
  });
}

async function loadRedditReports() {
  ensureReportsUI();

  const status = document.getElementById('reportStatus');
  if (status) status.textContent = (typeof t === 'function') ? t(state.lang, 't_reports_loading') : 'Loading…';

  try {
    const reports = await fetchRedditReports();

    await ensureMarkedLoaded();

    const sel = document.getElementById('reportSelect');
    if (!sel) return;

    sel.innerHTML = '';

    for (let i = 0; i < reports.length; i++) {
      const r = reports[i];
      const opt = document.createElement('option');
      opt.value = r.date;
    
      const latestTag = (typeof t === 'function')
        ? t(state.lang, 't_latest_tag')
        : '(latest)';
    
      opt.textContent = (i === 0) ? `${r.date} ${latestTag}` : r.date;
      sel.appendChild(opt);
    }

    // Determine selected report from URL (?report=) else default to latest.
    const p = new URLSearchParams(window.location.search);
    const fromUrl = normalizeDashOrSlashDateToDash(p.get('report') || '') || '';
    const pick = fromUrl || (reports[0] ? reports[0].date : '');

    sel.value = pick || '';
    setReportSelection(sel.value);

    // When user changes report date
    sel.addEventListener('change', () => {
      setReportSelection(sel.value);
    });

    if (status) status.textContent = '';
  } catch (err) {
    console.warn('Reddit reports failed:', err);
    const status = document.getElementById('reportStatus');
    if (status) status.textContent = (typeof t === 'function') ? t(state.lang, 't_reports_error') : 'Could not load Reddit reports.';
  }
}
async function loadAndRender() {
  await fetchData();
  renderLakeOptions(state.rows);
  rerenderAll();
}

(function init() {
  // Sheet link
  const sheetLink = document.getElementById("sheetLink");
  sheetLink.href = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/edit`;
  sheetLink.textContent = `docs.google.com/spreadsheets/d/${SHEET_ID}`;

  // If the URL includes filters (e.g. ?q=12-23-2025), hydrate state first so UI + data match.
  hydrateShareStateFromURL();

  applyTranslations(state.lang);
  initMap();
  wireUI();
  loadAndRender();
  // Load Reddit reports (non-blocking)
  loadRedditReports();
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

function getQueryParam(name) {
  const url = new URL(window.location.href);
  return url.searchParams.get(name) || "";
}

function setQueryParam(name, value, { push = false } = {}) {
  const url = new URL(window.location.href);

  if (value && value.trim() !== "") {
    url.searchParams.set(name, value.trim());
  } else {
    url.searchParams.delete(name);
  }

  if (push) {
    window.history.pushState({}, "", url.toString());
  } else {
    window.history.replaceState({}, "", url.toString());
  }
}

// ===============================
// Hamburger menu (Units + Language)
// ===============================
(function () {
  function findLabelFor(selectEl) {
    if (!selectEl) return null;
    return selectEl.closest('label');
  }

  function initMenu() {
    const menuBtn = document.getElementById('menuBtn');
    const menuPanel = document.getElementById('menuPanel');
    const unitSelect = document.getElementById('unitSelect');
    const langSelect = document.getElementById('langSelect');

    if (!menuBtn || !menuPanel || !unitSelect || !langSelect) return;

    // Move the existing controls into the floating panel (keeps event listeners intact)
    const unitLabel = findLabelFor(unitSelect);
    const langLabel = findLabelFor(langSelect);

    // Only move if they are not already inside the panel
    if (unitLabel && !menuPanel.contains(unitLabel)) menuPanel.appendChild(unitLabel);
    if (langLabel && !menuPanel.contains(langLabel)) menuPanel.appendChild(langLabel);

    function setOpen(open) {
      if (open) {
        menuPanel.classList.add('open');
        menuPanel.setAttribute('aria-hidden', 'false');
      } else {
        menuPanel.classList.remove('open');
        menuPanel.setAttribute('aria-hidden', 'true');
      }
    }

    // Toggle on click
    menuBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const isOpen = menuPanel.classList.contains('open');
      setOpen(!isOpen);
    });

    // Close when clicking outside
    document.addEventListener('click', (e) => {
      if (!menuPanel.classList.contains('open')) return;
      if (menuPanel.contains(e.target) || menuBtn.contains(e.target)) return;
      setOpen(false);
    });

    // Close on Escape
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') setOpen(false);
    });
  }

  // Your script runs at end of body; still, init on next tick to ensure wireUI() already ran
  setTimeout(initMenu, 0);
})();