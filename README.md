# Minneapolis Frozen Lakes Report

This site contains useful information and data regarding the safety profile of frozen lakes in the city of Minneapolis.
Data collection occurs weekly during ice times.

All data is part of the public domain and can be used however a person may choose.

## The data

Every measurement is published as plain files at https://freeze.glasford.io/data/ :

| | |
|---|---|
| `data/ice-thickness.csv` | every observation, one row per hole per day |
| `data/ice-thickness.json`, `.ndjson`, `.geojson` | the same rows in other formats |
| `data/seasons/<season>.csv` | one file per winter |
| `data/latest.json`, `data/summary.md` | the most recent measured day for each lake |
| `data/README.md`, `data/datapackage.json` | what every column means, for people and for programs |

`llms.txt` at the site root points AI agents at these files, since the home page is drawn by JavaScript.

## How the files are made

Measurements are entered in a Google Sheet, by hand or dictated by phone. The sheet stays the place data is
entered and corrected. `tools/build_data.py` reads its combined tab and rewrites `data/`:

```bash
python3 tools/build_data.py            # fetch the sheet, rewrite data/
python3 tools/build_data.py --check    # fetch and validate, write nothing
python3 -m unittest discover -s tools -p 'test_*.py'
```

It needs nothing but Python 3. It refuses to write if the sheet comes back empty, with different columns, or
with noticeably fewer rows than last time, so a bad read cannot replace good files.

It runs in two places: `tools/publish.sh` from cron on the home server (every few minutes, pushes only when
something changed), and `.github/workflows/data.yml` once a day as a second route.

The page itself (`app.js`) reads the sheet live and falls back to `data/ice-thickness.json` if the sheet
cannot be reached.
