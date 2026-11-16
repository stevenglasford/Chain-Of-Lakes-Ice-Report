#!/usr/bin/env python3
"""build_data.py - the Google Sheet in, an open dataset out.

    python3 tools/build_data.py            fetch the sheet, rewrite data/
    python3 tools/build_data.py --check    fetch and validate, write nothing
    python3 tools/build_data.py --source some.csv --out /tmp/data

The measurements are kept in a Google Sheet because a sheet is easy to fill in
and correct, including from a phone on a lake. A sheet is a poor thing to hand
to a program, though: its address and layout belong to Google, a script has to
know which tab and which columns, and nothing describes what the numbers mean.

So this reads the sheet's combined tab and writes the same observations as
plain files that will still open in fifty years -- CSV, JSON, JSON Lines and
GeoJSON -- next to a description of every column (data/README.md, and
data/datapackage.json for programs). The sheet stays the place data is entered
and corrected; these files are a copy of it, regenerated whenever it changes.

Python standard library only, on purpose: it has to run unchanged on the home
server, in GitHub Actions, and on whatever is around in ten years.

IT REFUSES RATHER THAN PUBLISHES NONSENSE

A fetch that comes back empty, a sheet whose headers have moved, or an export
that has lost a tenth of its rows since last time is far more likely to be a
broken read than a real change. In each case nothing is written and the exit
status is non-zero, so the files already published stay as they are.
"""

import argparse
import csv
import hashlib
import io
import json
import os
import re
import sys
import urllib.request
from collections import OrderedDict, defaultdict
from datetime import date, datetime, timedelta

SHEET_ID = "1012ms_FIXpCG7HNW-EJgl8cTf3a_haNKsNlgpZhoxqo"
ALLDATA_GID = "969405456"
SOURCE_URL = ("https://docs.google.com/spreadsheets/d/%s/export?format=csv&gid=%s"
              % (SHEET_ID, ALLDATA_GID))
SHEET_VIEW_URL = "https://docs.google.com/spreadsheets/d/%s/edit" % SHEET_ID
SITE = "https://freeze.glasford.io"
TITLE = "Minneapolis Frozen Lakes Report: ice thickness measurements"
TIMEZONE = "America/Chicago"

# The places that get measured. Codes are the two letters dictated by phone
# (ice-cream/src/lakes.js); the names are what the sheet holds.
LAKES = OrderedDict([
    ("IS", "Lake of the Isles"), ("BK", "Bde Maka Ska"), ("HA", "Lake Harriet"),
    ("CD", "Cedar Lake"), ("NK", "Lake Nokomis"), ("PD", "Loring Pond"),
    ("HW", "Lake Hiawatha"), ("PO", "Powderhorn Lake"), ("CH", "Cedar Lake Channel"),
    ("SB", "Lake Street Bridge"), ("KG", "Kenilworth Lagoon"), ("KC", "Kenilworth Channel"),
    ("MG", "Midtown Greenway Bridge"), ("DP", "Dean Parkway Bridge"), ("BR", "Brownie Lake"),
    ("BW", "Brownie Tunnel"), ("EP", "East Lake of the Isles Parkway Bridge"),
    ("BN", "Burnham Bridge"), ("RT", "LRT Bridge"), ("SG", "Spring Lake"),
    ("IG", "Lake of the Isles Lagoon"),
])
NAME_TO_CODE = {name.lower(): code for code, name in LAKES.items()}

# Spellings that have turned up when a name was typed by hand in the cold.
ALIASES = {
    "harriet": "Lake Harriet", "isles": "Lake of the Isles", "nokomis": "Lake Nokomis",
    "hiawatha": "Lake Hiawatha", "cedar": "Cedar Lake", "loring": "Loring Pond",
    "powderhorn": "Powderhorn Lake", "brownie": "Brownie Lake",
    "bde maka sa": "Bde Maka Ska", "bde maka ska lake": "Bde Maka Ska",
    "lake bde maka ska": "Bde Maka Ska", "calhoun": "Bde Maka Ska", "lake calhoun": "Bde Maka Ska",
    "east isles parkway bridge": "East Lake of the Isles Parkway Bridge",
    "isles lagoon": "Lake of the Isles Lagoon",
}

# Roughly the city, with room to spare. A coordinate outside it is kept and
# flagged, not dropped: it is more likely a typo worth seeing than nothing.
AREA = {"south": 44.85, "north": 45.06, "west": -93.40, "east": -93.15}

MM_PER_INCH = 25.4

FIELDS = [
    ("id", "string", "Identifier for this observation, derived from its date, time, place, "
     "position and thickness. Stable unless one of those is corrected in the source sheet."),
    ("season", "string", "Winter the observation belongs to, named by both calendar years "
     "(July to June), e.g. 2025-26."),
    ("date", "date", "Local calendar date of the observation (America/Chicago), YYYY-MM-DD."),
    ("time", "string", "Local time of day, HH:MM:SS, when it was recorded. Empty for observations "
     "that were logged by date only (all of them before the 2026-27 season)."),
    ("lake", "string", "Lake, pond, channel, lagoon or bridge where the hole was cut."),
    ("lake_code", "string", "Two-letter code for the place (see lakes.csv). Empty when the name "
     "in the sheet is not one of the listed places."),
    ("latitude", "number", "WGS84 latitude of the hole, decimal degrees. Empty when no position "
     "was recorded."),
    ("longitude", "number", "WGS84 longitude of the hole, decimal degrees (negative = west)."),
    ("thickness_mm", "integer", "Thickness of SOLID ice in millimetres, measured through a drilled "
     "hole. It does not include honeycombed (candled) ice, which is in honeycomb_mm. 0 means there "
     "was no solid ice at that spot: open water, or honeycomb only. Empty when no measurement was "
     "taken (see comment)."),
    ("thickness_in", "number", "The same thickness in inches (thickness_mm / 25.4, 2 decimals)."),
    ("thickness_cm", "number", "The same thickness in centimetres (thickness_mm / 10)."),
    ("honeycomb_mm", "integer", "Thickness of honeycombed (candled) ice in millimetres, in addition "
     "to thickness_mm. Candled ice has rotted into loose vertical crystals: it is like shredded ice, "
     "carries very little load, and can look as strong as solid ice. 0 when the observer wrote 'no "
     "honey'. Empty when honeycomb was not recorded, which is not the same as none. Read from the "
     "comment text."),
    ("open_water", "boolean", "true when there was no solid ice (thickness_mm 0 or empty) and the "
     "comment reports open or flowing water at that spot. Derived from the comment text."),
    ("comment", "string", "The observer's note, as written. For seasons before 2026-27 it begins "
     "with the reading as originally written down in inches and fractions (e.g. '9 1/2')."),
    ("flags", "string", "Semicolon-separated notes added by the export: uncertain (the observer "
     "marked the reading with '?'), thickness_from_comment (millimetres were worked out from "
     "inches written in the comment), position_outside_area (coordinates fall outside "
     "Minneapolis), position_stale (the phone's position was several minutes old), "
     "unlisted_place (the place name is not in lakes.csv), honeycomb_noted (the comment records "
     "honeycombed ice), honeycomb_only (no solid ice at all, only honeycombed ice: thickness_mm is "
     "0 and the whole sheet is weak, whatever it looks like)."),
]
COLUMNS = [f[0] for f in FIELDS]


class Refuse(Exception):
    """The source cannot be trusted; nothing should be written."""


# --------------------------------------------------------------- parsing ---

def parse_when(raw):
    """A cell from the date column -> (date, 'HH:MM:SS' or ''), or None."""
    s = str(raw or "").strip()
    if not s:
        return None
    m = re.match(r"^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ](\d{1,2}):(\d{2})(?::(\d{2}))?)?", s)
    order = "ymd"
    if not m:
        # 12-23-2025 or 12/23/2025, as the older seasons were typed.
        m = re.match(r"^(\d{1,2})[-/](\d{1,2})[-/](\d{4})(?:[T ]+(\d{1,2}):(\d{2})(?::(\d{2}))?)?", s)
        order = "mdy"
    if not m:
        # A bare serial number is what a date cell exports as when unformatted.
        if re.match(r"^\d{5}(\.\d+)?$", s):
            serial = float(s)
            whole = int(serial)
            d = date(1899, 12, 30) + timedelta(days=whole)
            secs = int(round((serial - whole) * 86400))
            t = "" if secs == 0 else "%02d:%02d:%02d" % (secs // 3600, secs % 3600 // 60, secs % 60)
            return (d, t)
        return None
    g = m.groups()
    try:
        d = date(int(g[0]), int(g[1]), int(g[2])) if order == "ymd" else date(int(g[2]), int(g[0]), int(g[1]))
    except ValueError:
        return None
    t = ""
    if g[3] is not None:
        hh, mi, ss = int(g[3]), int(g[4]), int(g[5] or 0)
        if hh > 23 or mi > 59 or ss > 59:
            return None
        # Midnight exactly is how a date-only entry was stored, not a time.
        if (hh, mi, ss) != (0, 0, 0):
            t = "%02d:%02d:%02d" % (hh, mi, ss)
    return (d, t)


def parse_coords(raw):
    """'44.9, -93.3' or '44.9 N, 93.3 W' -> (lat, lon), or None."""
    s = str(raw or "").strip()
    if not s:
        return None
    nums = re.findall(r"-?\d+(?:\.\d+)?", s)
    if len(nums) != 2:
        return None
    lat, lon = float(nums[0]), float(nums[1])
    if re.search(r"[Ss]", re.sub(r"[^NSEWnsew]", "", s)):
        lat = -abs(lat)
    if re.search(r"[Ww]", re.sub(r"[^NSEWnsew]", "", s)):
        lon = -abs(lon)
    if not (-90 <= lat <= 90 and -180 <= lon <= 180):
        return None
    if lat == 0 and lon == 0:
        return None
    return (round(lat, 5), round(lon, 5))


def parse_mm(raw):
    """A thickness cell -> whole millimetres, or None."""
    s = str(raw or "").strip().replace(",", "")
    if not s:
        return None
    try:
        v = float(s)
    except ValueError:
        return None
    if v < 0 or v > 2000:        # two metres of lake ice is not a reading, it is a typo
        return None
    return int(round(v))


INCHES_AT_START = re.compile(
    r"^\s*(?:(\d+)\s+(\d+)/(\d+)|(\d+)/(\d+)|(\d+(?:\.\d+)?)\s*(?:\"|in\b|inch\b|inches\b))")


def inches_from_comment(comment):
    """Inches written at the start of a comment -> mm, or None.

    Only a fraction, or a number explicitly marked as inches. A bare number is
    left alone: '3 people skating' is not three inches of ice.
    """
    m = INCHES_AT_START.match(str(comment or ""))
    if not m:
        return None
    try:
        if m.group(1):
            inches = int(m.group(1)) + int(m.group(2)) / int(m.group(3))
        elif m.group(4):
            inches = int(m.group(4)) / int(m.group(5))
        else:
            inches = float(m.group(6))
    except ZeroDivisionError:
        return None
    if not 0 <= inches <= 80:
        return None
    return int(round(inches * MM_PER_INCH))


def canonical_lake(raw):
    """The name as the dataset spells it, and its code if it has one."""
    name = re.sub(r"\s+", " ", str(raw or "")).strip()
    if not name:
        return ("", "")
    low = name.lower()
    if low in ALIASES:
        name = ALIASES[low]
        low = name.lower()
    if low in NAME_TO_CODE:
        code = NAME_TO_CODE[low]
        return (LAKES[code], code)
    return (name, "")


def season_of(d):
    start = d.year if d.month >= 7 else d.year - 1
    return "%d-%02d" % (start, (start + 1) % 100)


OPEN_WATER = re.compile(r"\b(open|flowing|running)\s+water\b", re.I)
STALE = re.compile(r"\bposition \d+ minutes old\b", re.I)
HONEY = re.compile(r"\bhoney", re.I)
NO_HONEY = re.compile(r"\bno\s+honey", re.I)
# The amount written straight before the word: '5 1/2 honey', '1/2 honey', '8 honey'.
# The lookbehind stops '21 7/8 1/2 honey' being read as eight and a half.
HONEY_AMOUNT = re.compile(r"(?<![\d/.])(?:(\d+) (\d+)/(\d+)|(\d+)/(\d+)|(\d+(?:\.\d+)?))\s+honey", re.I)


# What the phone line writes: 'honeycomb 152 mm', already in millimetres.
HONEY_MM = re.compile(r"\bhoneycomb (\d{1,4}) mm\b", re.I)


def honeycomb_from_comment(comment):
    """Honeycombed ice written in a comment -> mm; 0 for 'no honey'; else None.

    Either the phone line's 'honeycomb 152 mm' or the older hand-written
    inches before the word ('5 1/2 honey').
    """
    text = str(comment or "")
    if NO_HONEY.search(text):
        return 0
    m = HONEY_MM.search(text)
    if m:
        return int(m.group(1))
    m = HONEY_AMOUNT.search(text)
    if not m:
        return None
    try:
        if m.group(1):
            inches = int(m.group(1)) + int(m.group(2)) / int(m.group(3))
        elif m.group(4):
            inches = int(m.group(4)) / int(m.group(5))
        else:
            inches = float(m.group(6))
    except ZeroDivisionError:
        return None
    if not 0 <= inches <= 80:
        return None
    return int(round(inches * MM_PER_INCH))


def pick(row, *names):
    for n in names:
        for k, v in row.items():
            if k and k.strip().lower() == n:
                return v
    return ""


def normalise(rows):
    """Sheet rows -> (observations, problems). Problems are for a person to read."""
    out, problems = [], []
    for n, row in enumerate(rows, start=2):                  # 1 is the header
        when_raw = pick(row, "datetime", "date")
        lake_raw = pick(row, "lake")
        coords_raw = pick(row, "coordinates")
        mm_raw = pick(row, "thickness_mm")
        comment = re.sub(r"[ \t]*\r?\n[ \t]*", " / ", str(pick(row, "comment", "info") or "")).strip()
        if not any(str(x or "").strip() for x in (when_raw, lake_raw, coords_raw, mm_raw, comment)):
            continue

        when = parse_when(when_raw)
        if not when:
            problems.append("row %d: date %r not understood; row left out" % (n, when_raw))
            continue
        d, t = when
        lake, code = canonical_lake(lake_raw)
        coords = parse_coords(coords_raw)
        flags = []

        if not lake and not coords:
            problems.append("row %d (%s): no lake and no position; row left out" % (n, d.isoformat()))
            continue
        if str(coords_raw or "").strip() and not coords:
            problems.append("row %d (%s, %s): position %r not understood" % (n, d.isoformat(), lake, coords_raw))
        if coords and not (AREA["south"] <= coords[0] <= AREA["north"] and AREA["west"] <= coords[1] <= AREA["east"]):
            flags.append("position_outside_area")
            problems.append("row %d (%s, %s): position %s, %s is outside Minneapolis" %
                            (n, d.isoformat(), lake, coords[0], coords[1]))
        if lake and not code:
            flags.append("unlisted_place")

        mm = parse_mm(mm_raw)
        if mm is None and str(mm_raw or "").strip():
            problems.append("row %d (%s, %s): thickness %r not understood" % (n, d.isoformat(), lake, mm_raw))
        if mm is None and "?" not in comment:
            derived = inches_from_comment(comment)
            if derived is not None:
                mm = derived
                flags.append("thickness_from_comment")
        if "?" in comment:
            flags.append("uncertain")
        if STALE.search(comment):
            flags.append("position_stale")
        honey_mm = honeycomb_from_comment(comment)
        if HONEY.search(comment) and honey_mm != 0:
            flags.append("honeycomb_noted")
            if mm == 0:
                flags.append("honeycomb_only")

        out.append({
            "season": season_of(d),
            "date": d.isoformat(),
            "time": t,
            "lake": lake,
            "lake_code": code,
            "latitude": coords[0] if coords else None,
            "longitude": coords[1] if coords else None,
            "thickness_mm": mm,
            "thickness_in": round(mm / MM_PER_INCH, 2) if mm is not None else None,
            "thickness_cm": round(mm / 10.0, 1) if mm is not None else None,
            "honeycomb_mm": honey_mm,
            "open_water": bool(not mm and OPEN_WATER.search(comment)),
            "comment": comment,
            "flags": ";".join(flags),
        })

    out.sort(key=lambda o: (o["date"], o["time"], o["lake"],
                            o["latitude"] or 0, o["longitude"] or 0,
                            -1 if o["thickness_mm"] is None else o["thickness_mm"], o["comment"]))
    seen = defaultdict(int)
    for o in out:
        key = "|".join(str(o[k]) for k in ("date", "time", "lake", "latitude", "longitude", "thickness_mm"))
        seen[key] += 1
        digest = hashlib.sha1(key.encode("utf-8")).hexdigest()[:12]
        o["id"] = "mfl-" + digest + ("" if seen[key] == 1 else "-%d" % seen[key])
    return ([OrderedDict((c, o[c]) for c in COLUMNS) for o in out], problems)


# ------------------------------------------------------------- summaries ---

def stats(values):
    return {"n": len(values), "min_mm": min(values), "max_mm": max(values),
            "mean_mm": int(round(sum(values) / len(values)))}


def inches(mm):
    return round(mm / MM_PER_INCH, 1)


def build_lakes(obs):
    by = defaultdict(list)
    for o in obs:
        by[o["lake"]].append(o)
    rows = []
    names = list(LAKES.values()) + sorted(n for n in by if n and n.lower() not in NAME_TO_CODE)
    for name in names:
        group = by.get(name, [])
        pts = [(o["latitude"], o["longitude"]) for o in group
               if o["latitude"] is not None and "position_outside_area" not in o["flags"]]
        measured = [o for o in group if o["thickness_mm"] is not None]
        rows.append(OrderedDict([
            ("lake", name),
            ("lake_code", NAME_TO_CODE.get(name.lower(), "")),
            ("observations", len(group)),
            ("measurements", len(measured)),
            ("first_date", min((o["date"] for o in group), default="")),
            ("last_date", max((o["date"] for o in group), default="")),
            ("centroid_latitude", round(sum(p[0] for p in pts) / len(pts), 5) if pts else None),
            ("centroid_longitude", round(sum(p[1] for p in pts) / len(pts), 5) if pts else None),
        ]))
    return rows


def build_seasons(obs):
    by = defaultdict(list)
    for o in obs:
        by[o["season"]].append(o)
    rows = []
    for s in sorted(by):
        g = by[s]
        m = [o["thickness_mm"] for o in g if o["thickness_mm"] is not None]
        mdates = [o["date"] for o in g if o["thickness_mm"] is not None]
        rows.append(OrderedDict([
            ("season", s), ("observations", len(g)), ("measurements", len(m)),
            ("places", len({o["lake"] for o in g if o["lake"]})),
            ("outing_days", len({o["date"] for o in g})),
            ("first_date", min(o["date"] for o in g)), ("last_date", max(o["date"] for o in g)),
            ("first_measurement_date", min(mdates) if mdates else ""),
            ("last_measurement_date", max(mdates) if mdates else ""),
            ("max_thickness_mm", max(m) if m else None),
            ("max_thickness_in", inches(max(m)) if m else None),
        ]))
    return rows


def build_latest(obs):
    """For each place: its most recent day with a measurement, and anything noted since."""
    if not obs:
        return {"as_of": None, "season": None, "places": []}
    as_of = max(o["date"] for o in obs)
    season = season_of(date.fromisoformat(as_of))
    current = [o for o in obs if o["season"] == season]
    by = defaultdict(list)
    for o in current:
        if o["lake"]:
            by[o["lake"]].append(o)
    places = []
    for lake in sorted(by):
        g = by[lake]
        days = sorted({o["date"] for o in g if o["thickness_mm"] is not None})
        entry = OrderedDict([("lake", lake), ("lake_code", NAME_TO_CODE.get(lake.lower(), ""))])
        if days:
            day = days[-1]
            vals = [o["thickness_mm"] for o in g if o["date"] == day and o["thickness_mm"] is not None]
            st = stats(vals)
            entry.update([
                ("measured_on", day), ("days_before_as_of", (date.fromisoformat(as_of) - date.fromisoformat(day)).days),
                ("samples", st["n"]),
                ("min_mm", st["min_mm"]), ("max_mm", st["max_mm"]), ("mean_mm", st["mean_mm"]),
                ("min_in", inches(st["min_mm"])), ("max_in", inches(st["max_mm"])), ("mean_in", inches(st["mean_mm"])),
            ])
            if len(days) > 1:
                prev = [o["thickness_mm"] for o in g if o["date"] == days[-2] and o["thickness_mm"] is not None]
                entry["previous_measured_on"] = days[-2]
                entry["change_in_mean_mm"] = st["mean_mm"] - stats(prev)["mean_mm"]
        else:
            day = ""
            entry["measured_on"] = None
        later = [o for o in g if o["date"] >= (day or "") and o["comment"]
                 and (o["thickness_mm"] is None or o["date"] == day)]
        notes = []
        for o in later:
            text = o["comment"]
            if o["thickness_mm"] is not None:
                # Drop the echo of the reading itself; keep what was said about it.
                text = INCHES_AT_START.sub("", text).strip(" ,;")
                text = re.sub(r"^\d+(\.\d+)?\s*", "", text).strip(" ,;")
            if text and (o["date"] + ": " + text) not in notes:
                notes.append(o["date"] + ": " + text)
        entry["open_water_reported"] = any(o["open_water"] for o in g if o["date"] >= (day or ""))
        entry["honeycomb_only_reported"] = any("honeycomb_only" in o["flags"] for o in g
                                               if o["date"] >= (day or ""))
        entry["notes"] = notes[-6:]
        if entry["honeycomb_only_reported"]:
            entry["notes"].insert(0, "HONEYCOMB ONLY: no solid ice, only candled ice; weak however thick")
        places.append(entry)
    return OrderedDict([("as_of", as_of), ("season", season), ("timezone", TIMEZONE), ("places", places)])


# ---------------------------------------------------------------- writing ---

def summary_notes(place):
    """The last two dated notes, with the honeycomb-only warning kept in front."""
    dated = [n for n in place["notes"] if ": " in n and n[:4].isdigit()]
    text = "; ".join(n.split(": ", 1)[1] for n in dated[-2:])
    if place.get("honeycomb_only_reported"):
        text = ("HONEYCOMB ONLY (no solid ice). " + text).strip()
    return text


def to_csv(rows, columns):
    buf = io.StringIO()
    w = csv.writer(buf, lineterminator="\n")
    w.writerow(columns)
    for r in rows:
        w.writerow(["" if r[c] is None else ("true" if r[c] is True else "false" if r[c] is False else r[c])
                    for c in columns])
    return buf.getvalue()


def to_json(obj):
    return json.dumps(obj, indent=1, ensure_ascii=False) + "\n"


def to_geojson(obs):
    feats = []
    for o in obs:
        if o["latitude"] is None:
            continue
        props = OrderedDict((k, v) for k, v in o.items() if k not in ("latitude", "longitude"))
        feats.append(OrderedDict([
            ("type", "Feature"), ("id", o["id"]),
            ("geometry", {"type": "Point", "coordinates": [o["longitude"], o["latitude"]]}),
            ("properties", props),
        ]))
    return json.dumps(OrderedDict([("type", "FeatureCollection"), ("name", "ice-thickness"),
                                   ("features", feats)]), ensure_ascii=False, separators=(",", ":")) + "\n"


def md_table(header, rows):
    lines = ["| " + " | ".join(header) + " |", "|" + "|".join("---" for _ in header) + "|"]
    for r in rows:
        lines.append("| " + " | ".join(str(c).replace("|", "\\|").replace("\n", " ") for c in r) + " |")
    return "\n".join(lines)


def latest_rows(latest):
    rows = []
    for p in latest["places"]:
        if p.get("measured_on"):
            change = p.get("change_in_mean_mm")
            rows.append([p["lake"], p["measured_on"], p["samples"],
                         "%d (%.1f)" % (p["min_mm"], p["min_in"]), "%d (%.1f)" % (p["max_mm"], p["max_in"]),
                         "%d (%.1f)" % (p["mean_mm"], p["mean_in"]),
                         "" if change is None else "%+d" % change,
                         summary_notes(p)])
        else:
            rows.append([p["lake"], "not measured", "", "", "", "", "",
                         summary_notes(p)])
    return rows


DISCLAIMER = ("These are spot measurements at single drilled holes. Ice thickness varies a great deal "
              "over short distances and changes from day to day; a measurement here does not mean the "
              "ice is safe anywhere, including at the same spot later. Nothing in this dataset is "
              "safety advice.")


def build_summary_md(obs, seasons, latest, lakes):
    first, last = obs[0]["date"], obs[-1]["date"]
    measured = sum(1 for o in obs if o["thickness_mm"] is not None)
    parts = [
        "# Minneapolis Frozen Lakes Report: data summary",
        "",
        "Ice thickness measured by hand through drilled holes on the lakes, ponds, channels and "
        "lagoons of Minneapolis, Minnesota, USA, about weekly while the ice lasts. "
        "%d observations (%d with a measured thickness) from %s to %s, over %d winters."
        % (len(obs), measured, first, last, len(seasons)),
        "",
        "Public domain (CC0 1.0). " + DISCLAIMER,
        "",
        "## Most recent measurements (%s season, as of %s)" % (latest["season"], latest["as_of"]),
        "",
        "For each place, its most recent day with a measurement. Thickness in millimetres, inches in "
        "brackets. Change is the difference in the mean from the previous measured day, in millimetres.",
        "",
        md_table(["Place", "Measured on", "Holes", "Min", "Max", "Mean", "Change", "Notes"], latest_rows(latest)),
        "",
        "## Seasons",
        "",
        md_table(["Season", "Observations", "Measurements", "Places", "Outing days", "First measurement",
                  "Last measurement", "Thickest, mm (in)"],
                 [[s["season"], s["observations"], s["measurements"], s["places"], s["outing_days"],
                   s["first_measurement_date"], s["last_measurement_date"],
                   "" if s["max_thickness_mm"] is None else "%d (%.1f)" % (s["max_thickness_mm"], s["max_thickness_in"])]
                  for s in seasons]),
        "",
        "## Places",
        "",
        md_table(["Place", "Code", "Observations", "First", "Last", "Latitude", "Longitude"],
                 [[l["lake"], l["lake_code"], l["observations"], l["first_date"], l["last_date"],
                   "" if l["centroid_latitude"] is None else l["centroid_latitude"],
                   "" if l["centroid_longitude"] is None else l["centroid_longitude"]]
                  for l in lakes if l["observations"]]),
        "",
        "## Files",
        "",
        "- [ice-thickness.csv](ice-thickness.csv): every observation, one row each",
        "- [ice-thickness.json](ice-thickness.json), [ice-thickness.ndjson](ice-thickness.ndjson): the same as JSON",
        "- [ice-thickness.geojson](ice-thickness.geojson): the observations that have a position, as map points",
        "- [seasons/](seasons/): one CSV per winter",
        "- [latest.json](latest.json): the table above, for programs",
        "- [lakes.csv](lakes.csv), [seasons.csv](seasons.csv): the places and winters",
        "- [README.md](README.md): what every column means",
        "- [datapackage.json](datapackage.json): the same description, machine-readable",
        "",
    ]
    return "\n".join(parts)


def build_readme(obs, seasons):
    cols = md_table(["Column", "Type", "Meaning"], [[n, t, d] for n, t, d in FIELDS])
    return "\n".join([
        "# Minneapolis Frozen Lakes Report: the data",
        "",
        "Ice thickness measured by hand through drilled holes on the lakes, ponds, channels and "
        "lagoons of Minneapolis, Minnesota, USA. Measurements are taken about weekly while the ice "
        "lasts, at several holes per lake. One row is one hole on one day.",
        "",
        "- Coverage: %s to %s, %d observations, seasons %s." % (
            obs[0]["date"], obs[-1]["date"], len(obs), ", ".join(s["season"] for s in seasons)),
        "- Licence: public domain (CC0 1.0). Use it for anything; credit is appreciated, not required.",
        "- Suggested citation: Minneapolis Frozen Lakes Report, ice thickness measurements, " + SITE + "/data/",
        "- " + DISCLAIMER,
        "",
        "## Files",
        "",
        md_table(["File", "What it is"], [
            ["`ice-thickness.csv`", "Every observation. UTF-8, comma-separated, header row, RFC 4180 quoting."],
            ["`ice-thickness.json`", "The same rows as a JSON array of objects."],
            ["`ice-thickness.ndjson`", "The same rows as JSON Lines, one object per line."],
            ["`ice-thickness.geojson`", "The rows that have a position, as a GeoJSON FeatureCollection of points."],
            ["`seasons/<season>.csv`", "The same columns, one file per winter."],
            ["`latest.json`", "For each place, its most recent measured day in the current season: "
                              "number of holes, minimum, maximum and mean."],
            ["`lakes.csv`, `lakes.json`", "The places: name, two-letter code, number of observations, "
                                         "date range, and the centre of the measured positions."],
            ["`seasons.csv`, `seasons.json`", "One row per winter: counts, date range, thickest ice."],
            ["`summary.md`", "The latest measurements and season totals as readable text."],
            ["`datapackage.json`", "A Frictionless Data Package descriptor: every file and column, typed."],
            ["`manifest.json`", "Row counts, date range and a SHA-256 of every file."],
        ]),
        "",
        "All of these are at stable addresses under " + SITE + "/data/ and are served with "
        "`Access-Control-Allow-Origin: *`, so they can be fetched from a browser or a script with no key.",
        "",
        "## Columns",
        "",
        cols,
        "",
        "## Things worth knowing before using it",
        "",
        "- **Units.** Since the 2026-27 season thickness is recorded in whole millimetres. Earlier "
        "seasons were written down in inches and fractions and converted; the original inch reading "
        "is still at the start of `comment`.",
        "- **Dates and times.** Local time in Minneapolis (America/Chicago). Before 2026-27 only the "
        "date was recorded, so `time` is empty.",
        "- **Missing thickness is not zero.** An empty `thickness_mm` means no measurement was taken: "
        "open water, unsafe access, a note with no reading. A real zero is written as 0.",
        "- **`thickness_mm` is solid ice only.** As the ice rots in late winter it turns to honeycombed "
        "(candled) ice: loose vertical crystals, like standing on shredded ice. It is very weak and can "
        "look as strong as solid ice. Its thickness is recorded separately in `honeycomb_mm` and is "
        "never added to `thickness_mm`. Do not add the two together to judge strength.",
        "- **Honeycomb 0.** A row with `thickness_mm` 0 and the flag `honeycomb_only` (written in the "
        "sheet as e.g. '0 16 honey, 16') had no solid ice at all, only honeycombed ice. Treat it as "
        "unsafe however thick `honeycomb_mm` is. A 0 without that flag is open water or no ice.",
        "- **Older comments** read 'solid, honeycomb, total' in inches: '9 1/2 6 honey, 15 1/2' is "
        "9 1/2 in solid, 6 in honeycomb, 15 1/2 in altogether.",
        "- **Several rows per lake per day** are separate holes, not repeats. Thickness across one "
        "lake on one day commonly differs by a few centimetres.",
        "- **Places.** Channels, lagoons and bridges are recorded as their own places because ice "
        "under a bridge or in moving water behaves differently from the open lake.",
        "- **Positions** are the observer's phone GPS at the hole, typically good to a few metres.",
        "- **Corrections.** The Google Sheet the files are generated from is the place corrections "
        "are made; these files are regenerated from it. An `id` changes if its row's date, place, "
        "position or thickness is corrected.",
        "",
        "## Where it comes from",
        "",
        "Entered by hand or dictated by phone into a Google Sheet (" + SHEET_VIEW_URL + "), then "
        "exported by `tools/build_data.py` in https://github.com/stevenglasford/Chain-Of-Lakes-Ice-Report. "
        "The export leaves out rows it cannot place (no lake and no position) and never invents a value.",
        "",
    ])


def build_datapackage(obs, seasons):
    schema = {"fields": [], "primaryKey": "id", "missingValues": [""]}
    for name, typ, desc in FIELDS:
        f = OrderedDict([("name", name), ("type", typ), ("description", desc)])
        if name == "thickness_mm":
            f["unit"] = "mm"
            f["constraints"] = {"minimum": 0}
        if name == "latitude":
            f["constraints"] = {"minimum": -90, "maximum": 90}
        if name == "longitude":
            f["constraints"] = {"minimum": -180, "maximum": 180}
        if name in ("id", "season", "date"):
            f["constraints"] = {"required": True}
        schema["fields"].append(f)
    return OrderedDict([
        ("profile", "tabular-data-package"),
        ("name", "minneapolis-frozen-lakes-ice-thickness"),
        ("title", TITLE),
        ("description", "Ice thickness measured by hand through drilled holes on the lakes, ponds, "
                        "channels and lagoons of Minneapolis, Minnesota, USA, about weekly while the "
                        "ice lasts. " + DISCLAIMER),
        ("homepage", SITE + "/"),
        ("licenses", [{"name": "CC0-1.0", "title": "Creative Commons Zero v1.0 Universal (public domain)",
                       "path": "https://creativecommons.org/publicdomain/zero/1.0/"}]),
        ("keywords", ["ice thickness", "lake ice", "Minneapolis", "Minnesota", "Chain of Lakes",
                      "citizen science", "winter", "limnology"]),
        ("contributors", [{"title": "Minneapolis Frozen Lakes Report", "path": SITE + "/", "role": "author"}]),
        ("sources", [{"title": "Google Sheet the measurements are entered in", "path": SHEET_VIEW_URL}]),
        ("temporal", {"start": obs[0]["date"], "end": obs[-1]["date"]}),
        ("spatial", {"description": "Minneapolis, Minnesota, USA", "bbox": [AREA["west"], AREA["south"],
                                                                           AREA["east"], AREA["north"]]}),
        ("timezone", TIMEZONE),
        ("resources", [
            OrderedDict([("name", "ice-thickness"), ("path", "ice-thickness.csv"), ("format", "csv"),
                         ("mediatype", "text/csv"), ("encoding", "utf-8"),
                         ("description", "Every observation, all seasons."), ("schema", schema)]),
        ] + [
            OrderedDict([("name", "ice-thickness-" + s["season"]), ("path", "seasons/%s.csv" % s["season"]),
                         ("format", "csv"), ("mediatype", "text/csv"), ("encoding", "utf-8"),
                         ("description", "Observations from the %s winter." % s["season"]), ("schema", schema)])
            for s in seasons
        ] + [
            OrderedDict([("name", "ice-thickness-json"), ("path", "ice-thickness.json"), ("format", "json"),
                         ("mediatype", "application/json")]),
            OrderedDict([("name", "ice-thickness-ndjson"), ("path", "ice-thickness.ndjson"), ("format", "ndjson"),
                         ("mediatype", "application/x-ndjson")]),
            OrderedDict([("name", "ice-thickness-geojson"), ("path", "ice-thickness.geojson"),
                         ("format", "geojson"), ("mediatype", "application/geo+json")]),
            OrderedDict([("name", "lakes"), ("path", "lakes.csv"), ("format", "csv"), ("mediatype", "text/csv")]),
            OrderedDict([("name", "seasons"), ("path", "seasons.csv"), ("format", "csv"), ("mediatype", "text/csv")]),
            OrderedDict([("name", "latest"), ("path", "latest.json"), ("format", "json"),
                         ("mediatype", "application/json")]),
        ]),
    ])


def esc(s):
    return (str(s).replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace('"', "&quot;"))


def html_table(header, rows):
    out = ["<table>", "<thead><tr>" + "".join("<th>%s</th>" % esc(h) for h in header) + "</tr></thead>", "<tbody>"]
    for r in rows:
        out.append("<tr>" + "".join("<td>%s</td>" % esc(c) for c in r) + "</tr>")
    out += ["</tbody>", "</table>"]
    return "\n".join(out)


def build_index_html(obs, seasons, latest):
    files = [
        ("ice-thickness.csv", "Every observation, CSV"),
        ("ice-thickness.json", "Every observation, JSON array"),
        ("ice-thickness.ndjson", "Every observation, JSON Lines"),
        ("ice-thickness.geojson", "Observations with a position, GeoJSON"),
        ("latest.json", "Most recent measurement per place, JSON"),
        ("summary.md", "Latest measurements and season totals, Markdown"),
        ("lakes.csv", "The places measured"),
        ("seasons.csv", "One row per winter"),
        ("README.md", "What every column means"),
        ("datapackage.json", "Machine-readable description of the files (Frictionless Data Package)"),
        ("manifest.json", "Row counts and checksums"),
    ] + [("seasons/%s.csv" % s["season"], "The %s winter, CSV" % s["season"]) for s in seasons]
    return "\n".join([
        "<!doctype html>",
        '<html lang="en">',
        "<head>",
        '<meta charset="utf-8">',
        '<meta name="viewport" content="width=device-width,initial-scale=1">',
        "<title>Data: Minneapolis Frozen Lakes Report</title>",
        '<meta name="description" content="Download every ice thickness measurement from the Minneapolis '
        'Frozen Lakes Report as CSV, JSON or GeoJSON. Public domain.">',
        '<link rel="canonical" href="%s/data/">' % SITE,
        '<link rel="alternate" type="text/csv" href="ice-thickness.csv" title="All observations (CSV)">',
        '<link rel="alternate" type="application/json" href="ice-thickness.json" title="All observations (JSON)">',
        '<link rel="alternate" type="application/geo+json" href="ice-thickness.geojson" title="All observations (GeoJSON)">',
        "<style>",
        "body{font:16px/1.5 system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;"
        "max-width:60rem;margin:0 auto;padding:1rem;color:#111;background:#fff}",
        "table{border-collapse:collapse;width:100%;margin:1rem 0;font-size:.92rem}",
        "th,td{border:1px solid #ccc;padding:.3rem .5rem;text-align:left;vertical-align:top}",
        "th{background:#f1f5f9}",
        ".scroll{overflow-x:auto}",
        "@media (prefers-color-scheme:dark){body{background:#0f172a;color:#e2e8f0}th{background:#1e293b}"
        "th,td{border-color:#334155}a{color:#7dd3fc}}",
        "</style>",
        "</head>",
        "<body>",
        "<h1>Minneapolis Frozen Lakes Report: the data</h1>",
        "<p>Ice thickness measured by hand through drilled holes on the lakes of Minneapolis, Minnesota. "
        "%d observations from %s to %s. Public domain (CC0 1.0). "
        '<a href="../">Back to the map and tables</a>.</p>' % (len(obs), obs[0]["date"], obs[-1]["date"]),
        "<p>%s</p>" % esc(DISCLAIMER),
        "<h2>Files</h2>",
        "<ul>",
    ] + ['<li><a href="%s">%s</a>: %s</li>' % (esc(p), esc(p), esc(d)) for p, d in files] + [
        "</ul>",
        "<h2>Most recent measurements (%s season, as of %s)</h2>" % (esc(latest["season"]), esc(latest["as_of"])),
        "<p>For each place, its most recent day with a measurement. Millimetres, inches in brackets. "
        "Change is the difference in the mean from the previous measured day, in millimetres.</p>",
        '<div class="scroll">',
        html_table(["Place", "Measured on", "Holes", "Min", "Max", "Mean", "Change", "Notes"], latest_rows(latest)),
        "</div>",
        "<h2>Seasons</h2>",
        '<div class="scroll">',
        html_table(["Season", "Observations", "Measurements", "Places", "First measurement", "Last measurement",
                    "Thickest, mm (in)"],
                   [[s["season"], s["observations"], s["measurements"], s["places"], s["first_measurement_date"],
                     s["last_measurement_date"],
                     "" if s["max_thickness_mm"] is None else "%d (%.1f)" % (s["max_thickness_mm"], s["max_thickness_in"])]
                    for s in seasons]),
        "</div>",
        "<h2>Columns</h2>",
        '<div class="scroll">',
        html_table(["Column", "Type", "Meaning"], [[n, t, d] for n, t, d in FIELDS]),
        "</div>",
        "</body>",
        "</html>",
        "",
    ])


def build_files(obs, problems):
    seasons = build_seasons(obs)
    lakes = build_lakes(obs)
    latest = build_latest(obs)
    files = OrderedDict()
    files["ice-thickness.csv"] = to_csv(obs, COLUMNS)
    files["ice-thickness.json"] = to_json(obs)
    files["ice-thickness.ndjson"] = "".join(json.dumps(o, ensure_ascii=False) + "\n" for o in obs)
    files["ice-thickness.geojson"] = to_geojson(obs)
    for s in seasons:
        files["seasons/%s.csv" % s["season"]] = to_csv([o for o in obs if o["season"] == s["season"]], COLUMNS)
    files["lakes.csv"] = to_csv(lakes, list(lakes[0].keys()))
    files["lakes.json"] = to_json(lakes)
    files["seasons.csv"] = to_csv(seasons, list(seasons[0].keys()))
    files["seasons.json"] = to_json(seasons)
    files["latest.json"] = to_json(latest)
    files["summary.md"] = build_summary_md(obs, seasons, latest, lakes)
    files["README.md"] = build_readme(obs, seasons)
    files["datapackage.json"] = to_json(build_datapackage(obs, seasons))
    files["index.html"] = build_index_html(obs, seasons, latest)
    files["manifest.json"] = to_json(OrderedDict([
        ("title", TITLE),
        ("observations", len(obs)),
        ("measurements", sum(1 for o in obs if o["thickness_mm"] is not None)),
        ("first_date", obs[0]["date"]), ("last_date", obs[-1]["date"]),
        ("seasons", [s["season"] for s in seasons]),
        ("source", SHEET_VIEW_URL),
        ("rows_needing_attention", problems),
        ("sha256", OrderedDict((name, hashlib.sha256(text.encode("utf-8")).hexdigest())
                               for name, text in files.items())),
    ]))
    return files


# ------------------------------------------------------------------ main ---

def read_source(source):
    if re.match(r"^https?://", source):
        req = urllib.request.Request(source, headers={"User-Agent": "freeze-data-export/1"})
        with urllib.request.urlopen(req, timeout=60) as res:
            text = res.read().decode("utf-8-sig")
    else:
        with open(source, encoding="utf-8-sig") as f:
            text = f.read()
    if text.lstrip()[:1] == "<":
        raise Refuse("the source returned a web page, not CSV (is the sheet still shared publicly?)")
    rows = list(csv.DictReader(io.StringIO(text)))
    headers = [h.strip().lower() for h in (rows[0].keys() if rows else []) if h]
    for need in ("lake", "coordinates", "thickness_mm"):
        if need not in headers:
            raise Refuse("the source has no %r column; found %s" % (need, headers))
    if "datetime" not in headers and "date" not in headers:
        raise Refuse("the source has no date column; found %s" % headers)
    return rows


def previous_count(out_dir):
    try:
        with open(os.path.join(out_dir, "manifest.json"), encoding="utf-8") as f:
            return int(json.load(f).get("observations") or 0)
    except (OSError, ValueError):
        return 0


def check(obs, rows, before, min_ratio):
    if len(obs) < 100:
        raise Refuse("only %d usable rows; the archive has well over a thousand" % len(obs))
    if len(obs) < len(rows) * 0.9:
        raise Refuse("%d of %d sheet rows could not be used; that is a format change, not a typo"
                     % (len(rows) - len(obs), len(rows)))
    if before and len(obs) < before * min_ratio:
        raise Refuse("the export fell from %d to %d observations; refusing to replace the published files"
                     % (before, len(obs)))


def write(out_dir, files):
    changed = []
    for name, text in files.items():
        path = os.path.join(out_dir, name)
        try:
            with open(path, encoding="utf-8") as f:
                if f.read() == text:
                    continue
        except OSError:
            pass
        os.makedirs(os.path.dirname(path), exist_ok=True)
        tmp = path + ".tmp"
        with open(tmp, "w", encoding="utf-8", newline="") as f:
            f.write(text)
        os.replace(tmp, path)
        changed.append(name)
    return changed


def main(argv=None):
    here = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--source", default=SOURCE_URL, help="CSV address or file (default: the sheet's AllData tab)")
    ap.add_argument("--out", default=os.path.join(here, "data"))
    ap.add_argument("--check", action="store_true", help="validate only; write nothing")
    ap.add_argument("--min-ratio", type=float, default=0.9,
                    help="refuse if the row count falls below this fraction of the last export")
    args = ap.parse_args(argv)

    try:
        rows = read_source(args.source)
        obs, problems = normalise(rows)
        check(obs, rows, previous_count(args.out), args.min_ratio)
    except Refuse as e:
        print("REFUSED: %s" % e, file=sys.stderr)
        return 2
    except Exception as e:                                   # network, decoding
        print("FAILED: %s: %s" % (type(e).__name__, e), file=sys.stderr)
        return 1

    for p in problems:
        print("note: " + p, file=sys.stderr)
    files = build_files(obs, problems)
    if args.check:
        print("ok: %d observations, %s to %s; nothing written" % (len(obs), obs[0]["date"], obs[-1]["date"]))
        return 0
    changed = write(args.out, files)
    print("%d observations, %s to %s; %s" % (
        len(obs), obs[0]["date"], obs[-1]["date"],
        ("updated " + ", ".join(changed)) if changed else "no change"))
    return 0


if __name__ == "__main__":
    sys.exit(main())
