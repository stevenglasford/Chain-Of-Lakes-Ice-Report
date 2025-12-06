import pandas as pd

df = pd.read_excel("Ice2024.xlsx")

# Fix weird date strings and standardize to YYYY-MM-DD
df["date"] = pd.to_datetime(df["date"], errors="coerce").dt.strftime("%Y-%m-%d")

# Drop rows with no valid date
df = df.dropna(subset=["date"])

# Keep only the columns we care about
df = df[["date", "lake", "lat", "long", "thickness_cm", "description"]]

df.to_json("Ice2024.json", orient="records", indent=2)
print("Wrote Ice2024.json with", len(df), "rows")