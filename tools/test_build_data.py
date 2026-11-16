#!/usr/bin/env python3
"""Tests for build_data.py.   python3 -m unittest discover -s tools -p 'test_*.py'"""

import json
import os
import sys
import tempfile
import unittest
from datetime import date

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import build_data as B  # noqa: E402


def row(when="2026-12-05T14:22:11", lake="Lake Harriet", coords="44.92000, -93.30000", mm="150", comment=""):
    return {"datetime": when, "lake": lake, "Coordinates": coords, "Thickness_mm": mm,
            "Comment": comment, "Thickness_in": ""}


class Dates(unittest.TestCase):
    def test_the_forms_that_turn_up(self):
        self.assertEqual(B.parse_when("2026-12-05T14:22:11"), (date(2026, 12, 5), "14:22:11"))
        self.assertEqual(B.parse_when("2025-11-28T00:00:00"), (date(2025, 11, 28), ""))   # date only
        self.assertEqual(B.parse_when("2025-11-28"), (date(2025, 11, 28), ""))
        self.assertEqual(B.parse_when("12-5-2026"), (date(2026, 12, 5), ""))
        self.assertEqual(B.parse_when("1/14/2027"), (date(2027, 1, 14), ""))
        self.assertEqual(B.parse_when("12/5/2026 14:05"), (date(2026, 12, 5), "14:05:00"))
        self.assertEqual(B.parse_when("45989"), (date(2025, 11, 28), ""))                 # a sheet serial

    def test_nonsense_is_refused_not_guessed(self):
        for bad in ("", "soon", "13-45-2026", "2026-02-30", "5"):
            self.assertIsNone(B.parse_when(bad), bad)

    def test_a_winter_is_one_season_across_new_year(self):
        self.assertEqual(B.season_of(date(2025, 11, 28)), "2025-26")
        self.assertEqual(B.season_of(date(2026, 3, 11)), "2025-26")
        self.assertEqual(B.season_of(date(2026, 12, 1)), "2026-27")
        self.assertEqual(B.season_of(date(1999, 12, 31)), "1999-00")


class Places(unittest.TestCase):
    def test_coordinates(self):
        self.assertEqual(B.parse_coords("44.96530, -93.31978"), (44.9653, -93.31978))
        self.assertEqual(B.parse_coords("44.91714° N, 93.30092° W"), (44.91714, -93.30092))
        self.assertIsNone(B.parse_coords(""))
        self.assertIsNone(B.parse_coords("0, 0"))
        self.assertIsNone(B.parse_coords("44.9"))
        self.assertIsNone(B.parse_coords("944.9, -93.3"))

    def test_names_are_tidied_and_coded(self):
        self.assertEqual(B.canonical_lake("  lake  harriet "), ("Lake Harriet", "HA"))
        self.assertEqual(B.canonical_lake("Bde Maka Sa"), ("Bde Maka Ska", "BK"))
        self.assertEqual(B.canonical_lake("unknown lake ZZ"), ("unknown lake ZZ", ""))

    def test_every_code_is_unique_and_named(self):
        self.assertEqual(len(set(B.LAKES.values())), len(B.LAKES))


class Honeycomb(unittest.TestCase):
    def test_amount_written_before_the_word(self):
        self.assertEqual(B.honeycomb_from_comment("9 1/2 6 honey, 15 1/2"), 152)
        self.assertEqual(B.honeycomb_from_comment("12 1/4 4 3/4 honey, 17"), 121)
        self.assertEqual(B.honeycomb_from_comment("21 7/8 1/2 honey, 22 3/8"), 13)
        self.assertEqual(B.honeycomb_from_comment("15.0 5 honey, 20"), 127)

    def test_no_honey_is_zero_and_silence_is_unknown(self):
        self.assertEqual(B.honeycomb_from_comment("20 1/4 No honey"), 0)
        self.assertIsNone(B.honeycomb_from_comment("9 1/2"))
        self.assertIsNone(B.honeycomb_from_comment(""))

    def test_no_solid_ice_is_flagged_honeycomb_only(self):
        rows = [
            {"datetime": "2026-03-11", "lake": "Bde Maka Ska", "Thickness_mm": "0", "Comment": "0.0 16 honey, 16"},
            {"datetime": "2026-03-04", "lake": "Bde Maka Ska", "Thickness_mm": "400", "Comment": "15 3/4 5 1/2 honey, 21 1/4"},
            {"datetime": "2026-02-25", "lake": "Bde Maka Ska", "Thickness_mm": "514", "Comment": "20 1/4 No honey"},
            {"datetime": "2026-03-04", "lake": "Burnham Bridge", "Thickness_mm": "0", "Comment": "0.0 Open water"},
        ]
        obs, _ = B.normalise(rows)
        by = {o["comment"]: o for o in obs}
        only = by["0.0 16 honey, 16"]
        self.assertEqual((only["thickness_mm"], only["honeycomb_mm"]), (0, 406))
        self.assertEqual(only["flags"], "honeycomb_noted;honeycomb_only")
        self.assertEqual(by["15 3/4 5 1/2 honey, 21 1/4"]["flags"], "honeycomb_noted")
        self.assertEqual(by["20 1/4 No honey"]["flags"], "")
        self.assertEqual(by["20 1/4 No honey"]["honeycomb_mm"], 0)
        water = by["0.0 Open water"]
        self.assertTrue(water["open_water"])
        self.assertEqual(water["flags"], "")


class PhoneLineRows(unittest.TestCase):
    def test_rows_as_the_phone_line_writes_them(self):
        rows = [
            {"datetime": "2026-12-20T14:03:11", "lake": "Bde Maka Ska", "Thickness_mm": "150", "Comment": "honeycomb 120 mm; looks solid"},
            {"datetime": "2026-12-20T14:05:00", "lake": "Bde Maka Ska", "Thickness_mm": "0", "Comment": "honeycomb 406 mm"},
            {"datetime": "2026-12-20T14:06:00", "lake": "Bde Maka Ska", "Thickness_mm": "514", "Comment": "no honeycomb"},
            {"datetime": "2026-12-20T14:07:00", "lake": "Bde Maka Ska", "Thickness_mm": "0", "Comment": "open water; under the bridge"},
            {"datetime": "2026-12-20T14:08:00", "lake": "Bde Maka Ska", "Thickness_mm": "", "Comment": "snow depth 50 mm; drifted"},
        ]
        obs, _ = B.normalise(rows)
        by = {o["time"]: o for o in obs}
        self.assertEqual((by["14:03:11"]["thickness_mm"], by["14:03:11"]["honeycomb_mm"]), (150, 120))
        self.assertEqual(by["14:03:11"]["flags"], "honeycomb_noted")
        self.assertEqual((by["14:05:00"]["thickness_mm"], by["14:05:00"]["honeycomb_mm"]), (0, 406))
        self.assertIn("honeycomb_only", by["14:05:00"]["flags"])
        self.assertEqual(by["14:06:00"]["honeycomb_mm"], 0)
        self.assertEqual(by["14:06:00"]["flags"], "")
        self.assertTrue(by["14:07:00"]["open_water"])
        snow = by["14:08:00"]
        self.assertIsNone(snow["thickness_mm"])
        self.assertEqual(snow["comment"], "snow depth 50 mm; drifted")
        self.assertEqual(snow["flags"], "")


class Thickness(unittest.TestCase):
    def test_millimetres(self):
        self.assertEqual(B.parse_mm("150"), 150)
        self.assertEqual(B.parse_mm("0"), 0)
        self.assertIsNone(B.parse_mm(""))
        self.assertIsNone(B.parse_mm("?"))
        self.assertIsNone(B.parse_mm("-5"))
        self.assertIsNone(B.parse_mm("99999"))

    def test_inches_in_a_comment_only_when_plainly_inches(self):
        self.assertEqual(B.inches_from_comment("9 1/2 clear"), 241)
        self.assertEqual(B.inches_from_comment("3/4"), 19)
        self.assertEqual(B.inches_from_comment('6" black ice'), 152)
        self.assertEqual(B.inches_from_comment("6 inches"), 152)
        self.assertIsNone(B.inches_from_comment("3 people skating"))
        self.assertIsNone(B.inches_from_comment("Open water"))
        self.assertIsNone(B.inches_from_comment("1/0"))


class Normalise(unittest.TestCase):
    def test_a_dictated_row(self):
        obs, problems = B.normalise([row(comment="slush; position 7 minutes old")])
        o = obs[0]
        self.assertEqual((o["season"], o["date"], o["time"]), ("2026-27", "2026-12-05", "14:22:11"))
        self.assertEqual((o["thickness_mm"], o["thickness_in"], o["thickness_cm"]), (150, 5.91, 15.0))
        self.assertEqual(o["lake_code"], "HA")
        self.assertIn("position_stale", o["flags"])
        self.assertEqual(problems, [])
        self.assertTrue(o["id"].startswith("mfl-"))

    def test_missing_thickness_stays_missing_and_zero_stays_zero(self):
        obs, _ = B.normalise([row(mm="", comment="Open water!"), row(mm="0", coords="44.921, -93.3")])
        by = {o["comment"]: o for o in obs}
        self.assertIsNone(by["Open water!"]["thickness_mm"])
        self.assertTrue(by["Open water!"]["open_water"])
        self.assertEqual(by[""]["thickness_mm"], 0)
        self.assertFalse(by[""]["open_water"])

    def test_a_row_nobody_can_place_is_left_out_and_reported(self):
        obs, problems = B.normalise([row(), row(lake="", coords="", mm="128")])
        self.assertEqual(len(obs), 1)
        self.assertEqual(len(problems), 1)

    def test_an_unreadable_date_is_left_out_and_reported(self):
        obs, problems = B.normalise([row(when="yesterday")])
        self.assertEqual(obs, [])
        self.assertIn("not understood", problems[0])

    def test_a_position_outside_the_city_is_kept_and_flagged(self):
        obs, problems = B.normalise([row(coords="4.49, -93.3")])
        self.assertIn("position_outside_area", obs[0]["flags"])
        self.assertEqual(len(problems), 1)

    def test_identical_holes_get_distinct_ids_and_order_is_stable(self):
        a, _ = B.normalise([row(), row(), row(when="2026-12-04T10:00:00")])
        b, _ = B.normalise([row(when="2026-12-04T10:00:00"), row(), row()])
        self.assertEqual([o["id"] for o in a], [o["id"] for o in b])
        self.assertEqual(len({o["id"] for o in a}), 3)

    def test_the_old_sheet_layout_is_read_too(self):
        obs, _ = B.normalise([{"Date": "12-23-2025", "Lake": "Loring Pond", "Coordinates": "44.96853° N, 93.28444° W",
                               "Thickness_mm": "", "Info": "9 1/2"}])
        self.assertEqual(obs[0]["date"], "2025-12-23")
        self.assertEqual(obs[0]["thickness_mm"], 241)
        self.assertIn("thickness_from_comment", obs[0]["flags"])
        self.assertEqual(obs[0]["longitude"], -93.28444)


class Publishing(unittest.TestCase):
    def rows(self, n=120):
        return [row(when="2026-12-%02dT10:%02d:00" % (1 + i % 28, i % 60), mm=str(100 + i)) for i in range(n)]

    def test_files_are_complete_and_agree_with_each_other(self):
        obs, problems = B.normalise(self.rows())
        files = B.build_files(obs, problems)
        self.assertEqual(len(json.loads(files["ice-thickness.json"])), 120)
        self.assertEqual(len(files["ice-thickness.ndjson"].splitlines()), 120)
        self.assertEqual(len(files["ice-thickness.csv"].splitlines()), 121)
        self.assertEqual(len(json.loads(files["ice-thickness.geojson"])["features"]), 120)
        self.assertIn("seasons/2026-27.csv", files)
        pkg = json.loads(files["datapackage.json"])
        self.assertEqual([f["name"] for f in pkg["resources"][0]["schema"]["fields"]], B.COLUMNS)
        self.assertEqual(json.loads(files["latest.json"])["as_of"], "2026-12-28")

    def test_running_twice_changes_nothing(self):
        obs, problems = B.normalise(self.rows())
        with tempfile.TemporaryDirectory() as d:
            self.assertTrue(B.write(d, B.build_files(obs, problems)))
            self.assertEqual(B.write(d, B.build_files(obs, problems)), [])

    def test_a_shrunken_or_broken_source_is_refused(self):
        obs, _ = B.normalise(self.rows())
        B.check(obs, self.rows(), before=120, min_ratio=0.9)                  # fine
        with self.assertRaises(B.Refuse):
            B.check(obs[:100], self.rows(100), before=1252, min_ratio=0.9)    # lost most of the archive
        with self.assertRaises(B.Refuse):
            B.check(obs[:5], self.rows(5), before=0, min_ratio=0.9)           # nearly empty
        bad = [row(when="garbage") for _ in range(200)] + self.rows()
        with self.assertRaises(B.Refuse):
            B.check(B.normalise(bad)[0], bad, before=0, min_ratio=0.9)        # the format moved

    def test_a_web_page_instead_of_csv_is_refused(self):
        with tempfile.NamedTemporaryFile("w", suffix=".csv", delete=False) as f:
            f.write("<!doctype html><html>Sign in</html>")
        try:
            with self.assertRaises(B.Refuse):
                B.read_source(f.name)
        finally:
            os.unlink(f.name)

    def test_main_leaves_published_files_alone_when_refusing(self):
        with tempfile.TemporaryDirectory() as d:
            src = os.path.join(d, "s.csv")
            out = os.path.join(d, "data")
            obs, problems = B.normalise(self.rows())
            B.write(out, B.build_files(obs, problems))
            before = open(os.path.join(out, "ice-thickness.csv")).read()
            with open(src, "w") as f:
                f.write("datetime,lake,Coordinates,Thickness_mm,Comment\n2026-12-01,Lake Harriet,,150,\n")
            self.assertEqual(B.main(["--source", src, "--out", out]), 2)
            self.assertEqual(open(os.path.join(out, "ice-thickness.csv")).read(), before)


if __name__ == "__main__":
    unittest.main()
