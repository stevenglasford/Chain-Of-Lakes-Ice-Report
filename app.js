/* Ice Report Map - app.js
   Shareable filters via URL, multiple-date support, robust CSV parsing.
*/

(() => {
  "use strict";

  // -----------------------------
  // Config
  // -----------------------------
  const SHEET_ID = "10smiQBJ8mBWax24aOagG9LdzrrnhFmj0tfRESunUJNI";
  const GID_ALLDATA = "2029178353"; // AllData tab in Ice2025
  const CSV_URL = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/export?format=csv&gid=${GID_ALLDATA}`;

  const DEFAULT_CENTER = [44.96, -93.265];
  const DEFAULT_ZOOM = 12;

  // -----------------------------
  // DOM helpers
  // -----------------------------
  const $ = (id) => document.getElementById(id);

  const els = {
    map: $("map"),
    status: $("status"),
    sheetLink: $("sheetLink"),
    langSelect: $("langSelect"),
    unitSelect: $("unitSelect"),
    lakeFilter: $("lakeFilter"),
    mapRangeSelect: $("mapRangeSelect"),
    mapFrom: $("mapFrom"),
    mapTo: $("mapTo"),
    searchInput: $("searchInput"),
    refreshBtn: $("refreshBtn"),
    resultsCount: $("resultsCount"),
    resultsBody: (document.querySelector("#dataTable tbody") || $("resultsBody")),
  };

  // -----------------------------
  // i18n (expects window.I18N from i18n.js)
  // -----------------------------
  function t(key) {
    const lang = (els.langSelect && els.langSelect.value) || "en";
    const dict = (window.I18N && window.I18N[lang]) || (window.I18N && window.I18N.en) || {};
    return dict[key] || key;
  }

  function setStatus(msgKeyOrText, isError = false) {
    if (!els.status) return;
    const txt = (window.I18N ? t(msgKeyOrText) : msgKeyOrText) || "";
    els.status.textContent = txt;
    els.status.style.color = isError ? "#c62828" : "";
  }

  // -----------------------------
  // Parsing helpers
  // -----------------------------
  function safeTrim(x) {
    return (x ?? "").toString().trim();
  }

  // Accepts: "12/31/2025", "12-31-2025", "2025-12-31", "Date(2025,2,11)"
  // Returns a Date object (local) or null
  function parseDateLoose(s) {
    s = safeTrim(s);
    if (!s) return null;

    // Google Visualization style: Date(YYYY,M,DD) where M is 0-based
    const mG = s.match(/^Date\((\d{4})\s*,\s*(\d{1,2})\s*,\s*(\d{1,2})\)$/i);
    if (mG) {
      const y = Number(mG[1]);
      const mo0 = Number(mG[2]);
      const d = Number(mG[3]);
      if (Number.isFinite(y) && Number.isFinite(mo0) && Number.isFinite(d)) {
        return new Date(y, mo0, d);
      }
    }

    // yyyy-mm-dd
    const mIso = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
    if (mIso) {
      const y = Number(mIso[1]);
      const mo = Number(mIso[2]) - 1;
      const d = Number(mIso[3]);
      return new Date(y, mo, d);
    }

    // mm/dd/yyyy or mm-dd-yyyy
    const mMdY = s.match(/^(\d{1,2})[\/-](\d{1,2})[\/-](\d{4})$/);
    if (mMdY) {
      const mo = Number(mMdY[1]) - 1;
      const d = Number(mMdY[2]);
      const y = Number(mMdY[3]);
      return new Date(y, mo, d);
    }

    // Fallback: Date.parse (may be locale-dependent)
    const ts = Date.parse(s);
    return Number.isFinite(ts) ? new Date(ts) : null;
  }

  function formatMDY(dateObj) {
    if (!(dateObj instanceof Date) || isNaN(dateObj.getTime())) return "";
    const mm = String(dateObj.getMonth() + 1).padStart(2, "0");
    const dd = String(dateObj.getDate()).padStart(2, "0");
    const yy = String(dateObj.getFullYear());
    return `${mm}/${dd}/${yy}`;
  }
  function thicknessColor(inches) {
    if (inches === "" || inches == null || isNaN(inches)) return "#999"; // grey
    if (inches < 4) return "red";
    if (inches < 8) return "yellow";
    if (inches < 10) return "green";
    return "blue";
  }



  // normalize any date string to MM/DD/YYYY (or "")
  function normalizeDateString(s) {
    const d = parseDateLoose(s);
    return d ? formatMDY(d) : "";
  }

  // "44.96857° N, 93.28427° W" or "44.96857, -93.28427"
  function parseCoordsLoose(s) {
    s = safeTrim(s);
    if (!s) return { lat: null, lon: null };

    // Try "lat, lon"
    const m1 = s.match(/(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)/);
    if (m1) return { lat: Number(m1[1]), lon: Number(m1[2]) };

    // Try "44.96857° N, 93.28427° W"
    const m2 = s.match(/(-?\d+(?:\.\d+)?)\s*°?\s*([NS])\s*,\s*(-?\d+(?:\.\d+)?)\s*°?\s*([EW])/i);
    if (m2) {
      let lat = Number(m2[1]);
      const ns = m2[2].toUpperCase();
      let lon = Number(m2[3]);
      const ew = m2[4].toUpperCase();
      if (ns === "S") lat = -Math.abs(lat);
      else lat = Math.abs(lat);
      if (ew === "W") lon = -Math.abs(lon);
      else lon = Math.abs(lon);
      return { lat, lon };
    }

    return { lat: null, lon: null };
  }

  function parseMaybeNum(x) {
    const s = safeTrim(x);
    if (!s) return null;
    // allow commas
    const n = Number(s.replace(/,/g, ""));
    return Number.isFinite(n) ? n : null;
  }

  // Basic CSV parser that supports quotes and commas
  function parseCSV(text) {
    const rows = [];
    let row = [];
    let cur = "";
    let inQuotes = false;

    for (let i = 0; i < text.length; i++) {
      const ch = text[i];

      if (inQuotes) {
        if (ch === '"') {
          const next = text[i + 1];
          if (next === '"') {
            cur += '"';
            i++;
          } else {
            inQuotes = false;
          }
        } else {
          cur += ch;
        }
      } else {
        if (ch === '"') {
          inQuotes = true;
        } else if (ch === ",") {
          row.push(cur);
          cur = "";
        } else if (ch === "\n") {
          row.push(cur);
          rows.push(row);
          row = [];
          cur = "";
        } else if (ch === "\r") {
          // ignore
        } else {
          cur += ch;
        }
      }
    }
    row.push(cur);
    rows.push(row);

    // trim trailing empty rows
    while (rows.length && rows[rows.length - 1].every((c) => safeTrim(c) === "")) rows.pop();
    return rows;
  }

  // -----------------------------
  // State / URL handling
  // -----------------------------
  function getUrlParams() {
    const p = new URLSearchParams(window.location.search);
    return {
      dates: safeTrim(p.get("dates") || ""), // comma-separated list
      q: safeTrim(p.get("q") || ""),         // free text search
      lake: safeTrim(p.get("lake") || ""),
      range: safeTrim(p.get("range") || ""), // all/7d/14d/30d/season/custom
      from: safeTrim(p.get("from") || ""),
      to: safeTrim(p.get("to") || ""),
      units: safeTrim(p.get("units") || ""),
      lang: safeTrim(p.get("lang") || ""),
    };
  }

  // Accepts "12/30/2025,12-31-2025" -> ["12/30/2025","12/31/2025"]
  function decodeDatesParam(datesParam) {
    const raw = safeTrim(datesParam);
    if (!raw) return [];
    return raw
      .split(",")
      .map((s) => normalizeDateString(decodeURIComponent(s)))
      .filter((s) => !!s);
  }

  // Update the URL to match current UI filters (shareable)
  function syncUrlFromUI({ replace = false } = {}) {
    const p = new URLSearchParams();

    const q = safeTrim(els.searchInput?.value || "");
    const lake = safeTrim(els.lakeFilter?.value || "");
    const range = safeTrim(els.mapRangeSelect?.value || "all");
    const from = safeTrim(els.mapFrom?.value || "");
    const to = safeTrim(els.mapTo?.value || "");
    const units = safeTrim(els.unitSelect?.value || "");
    const lang = safeTrim(els.langSelect?.value || "");

    // If q looks like one or more dates, prefer dates=
    const datesFromQ = decodeDatesParam(q);
    if (datesFromQ.length) {
      p.set("dates", datesFromQ.join(","));
    } else if (q) {
      p.set("q", q);
    }

    if (lake) p.set("lake", lake);
    if (range && range !== "all") p.set("range", range);
    if (range === "custom") {
      if (from) p.set("from", from);
      if (to) p.set("to", to);
    }
    if (units) p.set("units", units);
    if (lang && lang !== "en") p.set("lang", lang);

    const newUrl = `${window.location.pathname}${p.toString() ? "?" + p.toString() : ""}${window.location.hash || ""}`;
    if (replace) history.replaceState(null, "", newUrl);
    else history.pushState(null, "", newUrl);
  }

  function applyUrlToUI() {
    const u = getUrlParams();

    if (u.lang && els.langSelect) els.langSelect.value = u.lang;
    if (u.units && els.unitSelect) els.unitSelect.value = u.units;
    if (u.lake && els.lakeFilter) els.lakeFilter.value = u.lake;

    // Prefer dates= over q=
    const decodedDates = decodeDatesParam(u.dates);
    if (decodedDates.length) {
      if (els.searchInput) els.searchInput.value = decodedDates.join(",");
    } else if (u.q && els.searchInput) {
      els.searchInput.value = u.q;
    }

    if (u.range && els.mapRangeSelect) {
      els.mapRangeSelect.value = u.range;
    }
    if (u.from && els.mapFrom) els.mapFrom.value = u.from;
    if (u.to && els.mapTo) els.mapTo.value = u.to;

    // If dates are present, force range=all (we'll filter by dates explicitly)
    if (decodedDates.length && els.mapRangeSelect) {
      els.mapRangeSelect.value = "all";
      if (els.mapFrom) els.mapFrom.value = "";
      if (els.mapTo) els.mapTo.value = "";
    }
  }

  // -----------------------------
  // Data normalization
  // -----------------------------
  // Expected columns:
  // Date, Lake, Coordinates, Thickness (Inches), Info, Thickness (cm)
  function normalizeRow(obj) {
    const dateStr = normalizeDateString(obj["Date"] ?? obj["date"] ?? obj["DATE"]);
    const dateObj = parseDateLoose(dateStr);

    const lake = safeTrim(obj["Lake"] ?? obj["lake"] ?? "");
    const coordsStr = safeTrim(obj["Coordinates"] ?? obj["coords"] ?? obj["Coordinates "] ?? "");
    const { lat, lon } = parseCoordsLoose(coordsStr);

    const inStr = safeTrim(obj["Thickness (Inches)"] ?? obj["thickness_in"] ?? obj["Thickness"] ?? "");
    const cmStr = safeTrim(obj["Thickness (cm)"] ?? obj["Thickness_cm"] ?? obj["Thickness (cm) "] ?? "");

    const inches = parseMaybeNum(inStr);
    const cm = parseMaybeNum(cmStr);

    const info = safeTrim(obj["Info"] ?? obj["description"] ?? obj["Description"] ?? "");

    return {
      date: dateStr,
      date_obj: dateObj,
      lake,
      coords: coordsStr,
      lat: Number.isFinite(lat) ? lat : null,
      lon: Number.isFinite(lon) ? lon : null,
      inches,
      cm,
      info,
      raw: obj,
    };
  }

  function rowsToObjects(csvRows) {
    if (!csvRows.length) return [];
    const header = csvRows[0].map((h) => safeTrim(h));
    const out = [];
    for (let i = 1; i < csvRows.length; i++) {
      const r = csvRows[i];
      if (!r || r.every((c) => safeTrim(c) === "")) continue;
      const obj = {};
      for (let j = 0; j < header.length; j++) obj[header[j]] = r[j] ?? "";
      out.push(obj);
    }
    return out;
  }

  // -----------------------------
  // Filtering
  // -----------------------------
  function getActiveFilters() {
    const u = getUrlParams();
    const datesList = decodeDatesParam(u.dates);

    const q = safeTrim(els.searchInput?.value || "");
    const lake = safeTrim(els.lakeFilter?.value || "");
    const range = safeTrim(els.mapRangeSelect?.value || "all");
    const from = safeTrim(els.mapFrom?.value || "");
    const to = safeTrim(els.mapTo?.value || "");

    // If the search box contains comma-separated dates, treat it as dates filter
    const datesFromQ = decodeDatesParam(q);

    return {
      dates: datesList.length ? datesList : (datesFromQ.length ? datesFromQ : []),
      qText: datesFromQ.length ? "" : q,
      lake,
      range,
      from: from ? normalizeDateString(from) : "",
      to: to ? normalizeDateString(to) : "",
    };
  }

  function withinRange(d, start, end) {
    if (!(d instanceof Date) || isNaN(d.getTime())) return false;
    if (start && (d < start)) return false;
    if (end && (d > end)) return false;
    return true;
  }

  function applyFilters(allRows) {
    const f = getActiveFilters();

    // date set filter
    const dateSet = new Set((f.dates || []).map(normalizeDateString));

    // range filter
    let start = null, end = null;
    if (f.range === "custom") {
      start = f.from ? parseDateLoose(f.from) : null;
      end = f.to ? parseDateLoose(f.to) : null;
    } else if (f.range === "7d" || f.range === "14d" || f.range === "30d") {
      const days = Number(f.range.replace("d", ""));
      const now = new Date();
      start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - (days - 1));
      end = null;
    } else if (f.range === "season") {
      // "season" = current ice season Aug 1 -> Jul 31, based on today
      const now = new Date();
      const y = now.getFullYear();
      const seasonStart = new Date(now.getMonth() >= 7 ? y : y - 1, 7, 1); // Aug 1
      start = seasonStart;
      end = null;
    }

    const q = (f.qText || "").toLowerCase();

    return allRows.filter((r) => {
      if (f.lake && r.lake !== f.lake) return false;

      if (dateSet.size) {
        if (!dateSet.has(normalizeDateString(r.date))) return false;
      }

      if (start || end) {
        if (!withinRange(r.date_obj, start, end)) return false;
      }

      if (q) {
        const hay = `${r.date} ${r.lake} ${r.coords} ${r.info}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }

      return true;
    });
  }

  // -----------------------------
  // Map rendering (Leaflet)
  // -----------------------------
  let map = null;
  let markersLayer = null;

  function initMap() {
    if (!window.L || !els.map) return;
    if (map) return;

    map = L.map(els.map).setView(DEFAULT_CENTER, DEFAULT_ZOOM);
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19,
      attribution: "&copy; OpenStreetMap contributors",
    }).addTo(map);

    markersLayer = L.layerGroup().addTo(map);
  }

  function clearMarkers() {
    if (markersLayer) markersLayer.clearLayers();
  }

  function addMarker(row) {
    if (!markersLayer) return;
    if (row.lat == null || row.lon == null) return;

    const units = safeTrim(els.unitSelect?.value || "in");
    const thicknessVal =
      units === "cm"
        ? (row.cm != null ? `${row.cm} cm` : (row.inches != null ? `${(row.inches * 2.54).toFixed(2)} cm` : ""))
        : (row.inches != null ? `${row.inches} in` : (row.cm != null ? `${(row.cm / 2.54).toFixed(2)} in` : ""));

    const popup = `
      <div style="min-width:200px">
        <div><b>${row.lake || ""}</b></div>
        <div>${row.date || ""}</div>
        <div>${thicknessVal}</div>
        <div style="opacity:.85">${row.info || ""}</div>
      </div>`;

    L.circleMarker([row.lat, row.lon], { radius: 6, color: color, fillColor: color, fillOpacity: 0.9, weight: 1 }).bindPopup(popup).addTo(markersLayer);
  }

  function fitToMarkers() {
    if (!map || !markersLayer) return;
    const layers = markersLayer.getLayers();
    if (!layers.length) return;
    const group = L.featureGroup(layers);
    map.fitBounds(group.getBounds().pad(0.15));
  }

  // -----------------------------
  // Table rendering
  // -----------------------------
  function renderTable(rows) {
    if (!els.resultsBody) return;
    els.resultsBody.innerHTML = "";

    for (const r of rows) {
      const tr = document.createElement("tr");

      const tdDate = document.createElement("td");
      tdDate.textContent = r.date || "";
      tr.appendChild(tdDate);

      const tdLake = document.createElement("td");
      tdLake.textContent = r.lake || "";
      tr.appendChild(tdLake);

      const tdCoords = document.createElement("td");
      tdCoords.textContent = r.coords || "";
      tr.appendChild(tdCoords);

      const units = safeTrim(els.unitSelect?.value || "in");
      const tdThick = document.createElement("td");
      if (units === "cm") {
        const cm = r.cm != null ? r.cm : (r.inches != null ? (r.inches * 2.54) : null);
        tdThick.textContent = cm != null ? `${cm}` : "";
      } else {
        const inches = r.inches != null ? r.inches : (r.cm != null ? (r.cm / 2.54) : null);
        tdThick.textContent = inches != null ? `${inches}` : "";
      }
      tr.appendChild(tdThick);

      const tdInfo = document.createElement("td");
      tdInfo.textContent = r.info || "";
      tr.appendChild(tdInfo);

      // click row => open popup
      tr.addEventListener("click", () => {
        if (map && r.lat != null && r.lon != null) {
          map.setView([r.lat, r.lon], Math.max(map.getZoom(), 14));
          // open matching marker popup
          if (markersLayer) {
            for (const lyr of markersLayer.getLayers()) {
              const ll = lyr.getLatLng?.();
              if (ll && Math.abs(ll.lat - r.lat) < 1e-7 && Math.abs(ll.lng - r.lon) < 1e-7) {
                lyr.openPopup();
                break;
              }
            }
          }
        }
      });

      els.resultsBody.appendChild(tr);
    }

    if (els.resultsCount) els.resultsCount.textContent = `${rows.length}`;
  }

  // -----------------------------
  // Data loading
  // -----------------------------
  let ALL_ROWS = [];
  let lastFetchOk = false;

  async function fetchCsvText(url) {
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  }

  async function loadAllData() {
    setStatus("status_loading", false);
    lastFetchOk = false;

    const csvText = await fetchCsvText(CSV_URL);
    const csvRows = parseCSV(csvText);
    const objs = rowsToObjects(csvRows);
    const normalized = objs.map(normalizeRow).filter((r) => r.date && r.lake);

    ALL_ROWS = normalized;
    lastFetchOk = true;
    setStatus("", false);
  }

  function populateLakeFilter(rows) {
    if (!els.lakeFilter) return;
    const current = els.lakeFilter.value || "";
    const lakes = Array.from(new Set(rows.map((r) => r.lake).filter(Boolean))).sort((a, b) => a.localeCompare(b));

    // Preserve first option (All)
    const firstOpt = els.lakeFilter.querySelector("option[value='']") || els.lakeFilter.options[0];
    els.lakeFilter.innerHTML = "";
    if (firstOpt) {
      const opt = document.createElement("option");
      opt.value = "";
      opt.textContent = firstOpt.textContent || "All lakes";
      els.lakeFilter.appendChild(opt);
    }

    for (const lake of lakes) {
      const opt = document.createElement("option");
      opt.value = lake;
      opt.textContent = lake;
      els.lakeFilter.appendChild(opt);
    }

    if (current && lakes.includes(current)) els.lakeFilter.value = current;
  }

  function renderAll() {
    if (!map) initMap();
    clearMarkers();

    const filtered = applyFilters(ALL_ROWS);

    for (const r of filtered) addMarker(r);
    renderTable(filtered);
    fitToMarkers();

    // show sheet link
    if (els.sheetLink) {
      els.sheetLink.href = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/edit`;
      els.sheetLink.textContent = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/edit`;
    }
  }

  // -----------------------------
  // Event wiring
  // -----------------------------
  function wireEvents() {
    if (els.refreshBtn) {
      els.refreshBtn.addEventListener("click", async () => {
        await refresh(true);
      });
    }

    const onFilterChanged = () => {
      // reflect to URL and rerender
      syncUrlFromUI({ replace: true });
      renderAll();
    };

    if (els.langSelect) els.langSelect.addEventListener("change", onFilterChanged);
    if (els.unitSelect) els.unitSelect.addEventListener("change", onFilterChanged);
    if (els.lakeFilter) els.lakeFilter.addEventListener("change", onFilterChanged);
    if (els.mapRangeSelect) els.mapRangeSelect.addEventListener("change", () => {
      // show/hide custom fields
      const isCustom = els.mapRangeSelect.value === "custom";
      if (els.mapFrom) els.mapFrom.style.display = isCustom ? "" : "none";
      if (els.mapTo) els.mapTo.style.display = isCustom ? "" : "none";
      onFilterChanged();
    });
    if (els.mapFrom) els.mapFrom.addEventListener("change", onFilterChanged);
    if (els.mapTo) els.mapTo.addEventListener("change", onFilterChanged);

    if (els.searchInput) {
      // update on Enter + debounce typing
      let tmr = null;
      els.searchInput.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          onFilterChanged();
        }
      });
      els.searchInput.addEventListener("input", () => {
        clearTimeout(tmr);
        tmr = setTimeout(onFilterChanged, 300);
      });
    }

    window.addEventListener("popstate", async () => {
      applyUrlToUI();
      renderAll();
    });
  }

  async function refresh(forceRefetch = false) {
    try {
      // ensure UI matches URL (on first load, and on refresh)
      applyUrlToUI();

      if (!lastFetchOk || forceRefetch) {
        await loadAllData();
        populateLakeFilter(ALL_ROWS);
      }

      // show/hide custom date inputs
      if (els.mapRangeSelect && els.mapFrom && els.mapTo) {
        const isCustom = els.mapRangeSelect.value === "custom";
        els.mapFrom.style.display = isCustom ? "" : "none";
        els.mapTo.style.display = isCustom ? "" : "none";
      }

      renderAll();
      syncUrlFromUI({ replace: true });
    } catch (err) {
      console.error("Data load error:", err);
      setStatus("status_error", true);
    }
  }

  // -----------------------------
  // Init
  // -----------------------------
  document.addEventListener("DOMContentLoaded", async () => {
    try {
      if (els.sheetLink) {
        els.sheetLink.href = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/edit`;
      }
      initMap();
      wireEvents();
      await refresh(false);
    } catch (err) {
      console.error(err);
      setStatus("status_error", true);
    }
  });

})();