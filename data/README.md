# Minneapolis Frozen Lakes Report: the data

Ice thickness measured by hand through drilled holes on the lakes, ponds, channels and lagoons of Minneapolis, Minnesota, USA. Measurements are taken about weekly while the ice lasts, at several holes per lake. One row is one hole on one day.

- Coverage: 2024-12-26 to 2026-03-11, 1252 observations, seasons 2024-25, 2025-26.
- Licence: public domain (CC0 1.0). Use it for anything; credit is appreciated, not required.
- Suggested citation: Minneapolis Frozen Lakes Report, ice thickness measurements, https://freeze.glasford.io/data/
- These are spot measurements at single drilled holes. Ice thickness varies a great deal over short distances and changes from day to day; a measurement here does not mean the ice is safe anywhere, including at the same spot later. Nothing in this dataset is safety advice.

## Files

| File | What it is |
|---|---|
| `ice-thickness.csv` | Every observation. UTF-8, comma-separated, header row, RFC 4180 quoting. |
| `ice-thickness.json` | The same rows as a JSON array of objects. |
| `ice-thickness.ndjson` | The same rows as JSON Lines, one object per line. |
| `ice-thickness.geojson` | The rows that have a position, as a GeoJSON FeatureCollection of points. |
| `seasons/<season>.csv` | The same columns, one file per winter. |
| `latest.json` | For each place, its most recent measured day in the current season: number of holes, minimum, maximum and mean. |
| `lakes.csv`, `lakes.json` | The places: name, two-letter code, number of observations, date range, and the centre of the measured positions. |
| `seasons.csv`, `seasons.json` | One row per winter: counts, date range, thickest ice. |
| `summary.md` | The latest measurements and season totals as readable text. |
| `datapackage.json` | A Frictionless Data Package descriptor: every file and column, typed. |
| `manifest.json` | Row counts, date range and a SHA-256 of every file. |

All of these are at stable addresses under https://freeze.glasford.io/data/ and are served with `Access-Control-Allow-Origin: *`, so they can be fetched from a browser or a script with no key.

## Columns

| Column | Type | Meaning |
|---|---|---|
| id | string | Identifier for this observation, derived from its date, time, place, position and thickness. Stable unless one of those is corrected in the source sheet. |
| season | string | Winter the observation belongs to, named by both calendar years (July to June), e.g. 2025-26. |
| date | date | Local calendar date of the observation (America/Chicago), YYYY-MM-DD. |
| time | string | Local time of day, HH:MM:SS, when it was recorded. Empty for observations that were logged by date only (all of them before the 2026-27 season). |
| lake | string | Lake, pond, channel, lagoon or bridge where the hole was cut. |
| lake_code | string | Two-letter code for the place (see lakes.csv). Empty when the name in the sheet is not one of the listed places. |
| latitude | number | WGS84 latitude of the hole, decimal degrees. Empty when no position was recorded. |
| longitude | number | WGS84 longitude of the hole, decimal degrees (negative = west). |
| thickness_mm | integer | Thickness of SOLID ice in millimetres, measured through a drilled hole. It does not include honeycombed (candled) ice, which is in honeycomb_mm. 0 means there was no solid ice at that spot: open water, or honeycomb only. Empty when no measurement was taken (see comment). |
| thickness_in | number | The same thickness in inches (thickness_mm / 25.4, 2 decimals). |
| thickness_cm | number | The same thickness in centimetres (thickness_mm / 10). |
| honeycomb_mm | integer | Thickness of honeycombed (candled) ice in millimetres, in addition to thickness_mm. Candled ice has rotted into loose vertical crystals: it is like shredded ice, carries very little load, and can look as strong as solid ice. 0 when the observer wrote 'no honey'. Empty when honeycomb was not recorded, which is not the same as none. Read from the comment text. |
| open_water | boolean | true when there was no solid ice (thickness_mm 0 or empty) and the comment reports open or flowing water at that spot. Derived from the comment text. |
| comment | string | The observer's note, as written. For seasons before 2026-27 it begins with the reading as originally written down in inches and fractions (e.g. '9 1/2'). |
| flags | string | Semicolon-separated notes added by the export: uncertain (the observer marked the reading with '?'), thickness_from_comment (millimetres were worked out from inches written in the comment), position_outside_area (coordinates fall outside Minneapolis), position_stale (the phone's position was several minutes old), unlisted_place (the place name is not in lakes.csv), honeycomb_noted (the comment records honeycombed ice), honeycomb_only (no solid ice at all, only honeycombed ice: thickness_mm is 0 and the whole sheet is weak, whatever it looks like). |

## Things worth knowing before using it

- **Units.** Since the 2026-27 season thickness is recorded in whole millimetres. Earlier seasons were written down in inches and fractions and converted; the original inch reading is still at the start of `comment`.
- **Dates and times.** Local time in Minneapolis (America/Chicago). Before 2026-27 only the date was recorded, so `time` is empty.
- **Missing thickness is not zero.** An empty `thickness_mm` means no measurement was taken: open water, unsafe access, a note with no reading. A real zero is written as 0.
- **`thickness_mm` is solid ice only.** As the ice rots in late winter it turns to honeycombed (candled) ice: loose vertical crystals, like standing on shredded ice. It is very weak and can look as strong as solid ice. Its thickness is recorded separately in `honeycomb_mm` and is never added to `thickness_mm`. Do not add the two together to judge strength.
- **Honeycomb 0.** A row with `thickness_mm` 0 and the flag `honeycomb_only` (written in the sheet as e.g. '0 16 honey, 16') had no solid ice at all, only honeycombed ice. Treat it as unsafe however thick `honeycomb_mm` is. A 0 without that flag is open water or no ice.
- **Older comments** read 'solid, honeycomb, total' in inches: '9 1/2 6 honey, 15 1/2' is 9 1/2 in solid, 6 in honeycomb, 15 1/2 in altogether.
- **Several rows per lake per day** are separate holes, not repeats. Thickness across one lake on one day commonly differs by a few centimetres.
- **Places.** Channels, lagoons and bridges are recorded as their own places because ice under a bridge or in moving water behaves differently from the open lake.
- **Positions** are the observer's phone GPS at the hole, typically good to a few metres.
- **Corrections.** The Google Sheet the files are generated from is the place corrections are made; these files are regenerated from it. An `id` changes if its row's date, place, position or thickness is corrected.

## Where it comes from

Entered by hand or dictated by phone into a Google Sheet (https://docs.google.com/spreadsheets/d/1012ms_FIXpCG7HNW-EJgl8cTf3a_haNKsNlgpZhoxqo/edit), then exported by `tools/build_data.py` in https://github.com/stevenglasford/Chain-Of-Lakes-Ice-Report. The export leaves out rows it cannot place (no lake and no position) and never invents a value.
