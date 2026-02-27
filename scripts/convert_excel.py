"""
convert_excel.py

Reads the RVJP Weekly Report Excel file and converts it into JSON files
consumed by the React dashboard.

Usage:
    python convert_excel.py
    python convert_excel.py <path_to_excel>
"""

import sys
import os
import json
import math
import pandas as pd

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------
DEFAULT_EXCEL_PATH = r"C:\Users\rokmc\CLAUDE cowork\[RVJP-RVKR] Weekly Report.xlsx"
OUTPUT_DIR = r"D:\CLAUDE YANGIL\rvjp-dashboard\public\data"

CHANNEL_NORMALIZE = {
    "piccoma": "piccoma",
    "Piccoma": "piccoma",
    "cmoa": "cmoa",
    "CMOA": "cmoa",
}


def normalize_channel(raw: str) -> str:
    """Return a normalised channel/platform name."""
    if pd.isna(raw):
        return ""
    raw = str(raw).strip()
    return CHANNEL_NORMALIZE.get(raw, raw)


def safe_json(obj):
    """Replace NaN / Infinity with None so json.dump won't choke."""
    if isinstance(obj, float) and (math.isnan(obj) or math.isinf(obj)):
        return None
    return obj


def clean_for_json(obj):
    """Recursively walk a Python structure and sanitise float values."""
    if isinstance(obj, dict):
        return {k: clean_for_json(v) for k, v in obj.items()}
    if isinstance(obj, list):
        return [clean_for_json(v) for v in obj]
    if isinstance(obj, float):
        if math.isnan(obj) or math.isinf(obj):
            return None
        # Store as int when there is no fractional part (keeps JSON smaller)
        if obj == int(obj):
            return int(obj)
    return obj


def write_json(data, filename: str) -> None:
    """Write *data* to OUTPUT_DIR/filename as JSON."""
    path = os.path.join(OUTPUT_DIR, filename)
    data = clean_for_json(data)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, separators=(",", ":"))
    size_mb = os.path.getsize(path) / (1024 * 1024)
    print(f"  -> {filename}  ({size_mb:.2f} MB)")


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
def main():
    excel_path = sys.argv[1] if len(sys.argv) > 1 else DEFAULT_EXCEL_PATH

    if not os.path.isfile(excel_path):
        print(f"ERROR: Excel file not found: {excel_path}")
        sys.exit(1)

    os.makedirs(OUTPUT_DIR, exist_ok=True)

    # ------------------------------------------------------------------
    # 1. Read Daily_raw sheet (header at row 1, 0-indexed -> header=1)
    # ------------------------------------------------------------------
    print(f"Reading Daily_raw from:\n  {excel_path}")
    df_raw = pd.read_excel(
        excel_path,
        sheet_name="Daily_raw",
        header=1,
        engine="openpyxl",
    )
    print(f"  Daily_raw rows: {len(df_raw):,}")

    # Rename columns to internal names
    col_map_raw = {
        "Title(JP)": "titleJP",
        "Title(KR)": "titleKR",
        "Channel Title(JP)": "channelTitleJP",
        "Channel": "channel",
        "Date": "date",
        "Sales(without tax)": "sales",
    }
    df_raw.rename(columns=col_map_raw, inplace=True)

    # Normalise channel
    df_raw["channel"] = df_raw["channel"].apply(normalize_channel)

    # Parse dates -- coerce errors to NaT so we can drop them
    df_raw["date"] = pd.to_datetime(df_raw["date"], errors="coerce")

    # Drop rows without a valid date
    before = len(df_raw)
    df_raw.dropna(subset=["date"], inplace=True)
    print(f"  Dropped {before - len(df_raw):,} rows with invalid dates")

    # Ensure sales is numeric
    df_raw["sales"] = pd.to_numeric(df_raw["sales"], errors="coerce").fillna(0)

    # Keep only rows with sales > 0
    df_raw = df_raw[df_raw["sales"] > 0].copy()
    print(f"  Rows with sales > 0: {len(df_raw):,}")

    # Convenience columns
    df_raw["date_str"] = df_raw["date"].dt.strftime("%Y-%m-%d")
    df_raw["month"] = df_raw["date"].dt.to_period("M").astype(str)

    # ------------------------------------------------------------------
    # 2. Read Title sheet (header at row 2, 0-indexed -> header=2)
    # ------------------------------------------------------------------
    print("Reading Title sheet ...")
    df_title = pd.read_excel(
        excel_path,
        sheet_name="Title",
        header=2,
        engine="openpyxl",
    )
    print(f"  Title rows: {len(df_title):,}")

    col_map_title = {
        "Channel Title(JP)": "channelTitleJP",
        "Title(KR)": "titleKR",
        "Title(JP)": "titleJP",
        "シリーズ名": "seriesName",
        "PF": "platform",
    }
    df_title.rename(columns=col_map_title, inplace=True)

    # Normalise platform in Title sheet as well
    if "platform" in df_title.columns:
        df_title["platform"] = df_title["platform"].apply(normalize_channel)

    # ------------------------------------------------------------------
    # 3. Generate JSON files
    # ------------------------------------------------------------------

    # ---- daily_sales.json ----
    print("Generating daily_sales.json ...")
    daily_records = df_raw[["titleKR", "titleJP", "channel", "date_str", "sales"]].copy()
    daily_records.rename(columns={"date_str": "date"}, inplace=True)
    # Fill any remaining NaN strings
    daily_records["titleKR"] = daily_records["titleKR"].fillna("")
    daily_records["titleJP"] = daily_records["titleJP"].fillna("")
    daily_records["channel"] = daily_records["channel"].fillna("")
    write_json(daily_records.to_dict(orient="records"), "daily_sales.json")

    # ---- monthly_summary.json ----
    print("Generating monthly_summary.json ...")
    monthly_total = df_raw.groupby("month")["sales"].sum()
    monthly_platform = df_raw.groupby(["month", "channel"])["sales"].sum().unstack(fill_value=0)

    monthly_summary = []
    for month in sorted(monthly_total.index):
        platforms = {}
        if month in monthly_platform.index:
            row = monthly_platform.loc[month]
            for plat in row.index:
                val = row[plat]
                if val > 0:
                    platforms[plat] = int(val)
        monthly_summary.append({
            "month": month,
            "totalSales": int(monthly_total[month]),
            "platforms": platforms,
        })
    write_json(monthly_summary, "monthly_summary.json")

    # ---- title_summary.json ----
    print("Generating title_summary.json ...")

    # Group by titleJP (primary key), take first titleKR per titleJP
    title_groups = df_raw.groupby("titleJP")

    title_summary = []
    for title_jp, grp in title_groups:
        title_kr = grp["titleKR"].iloc[0] if pd.notna(grp["titleKR"].iloc[0]) else ""
        total_sales = grp["sales"].sum()

        # Series name lookup from Title sheet
        series_match = df_title.loc[df_title["titleJP"] == title_jp, "seriesName"]
        series_name = ""
        if len(series_match) > 0 and pd.notna(series_match.iloc[0]):
            series_name = str(series_match.iloc[0])

        # Platforms breakdown
        plat_sales = grp.groupby("channel")["sales"].sum().sort_values(ascending=False)
        platforms = [{"name": p, "sales": int(s)} for p, s in plat_sales.items() if s > 0]

        # Daily average
        n_days = grp["date_str"].nunique()
        daily_avg = round(total_sales / n_days, 2) if n_days > 0 else 0

        # Peak
        daily_totals = grp.groupby("date_str")["sales"].sum()
        peak_date = daily_totals.idxmax()
        peak_sales = int(daily_totals.max())

        # First / last date
        first_date = grp["date_str"].min()
        last_date = grp["date_str"].max()

        # Monthly trend
        monthly_trend_raw = grp.groupby("month")["sales"].sum().sort_index()
        monthly_trend = [{"month": m, "sales": int(s)} for m, s in monthly_trend_raw.items()]

        title_summary.append({
            "titleKR": title_kr,
            "titleJP": title_jp if pd.notna(title_jp) else "",
            "seriesName": series_name,
            "totalSales": int(total_sales),
            "platforms": platforms,
            "dailyAvg": daily_avg,
            "peakDate": peak_date,
            "peakSales": peak_sales,
            "firstDate": first_date,
            "lastDate": last_date,
            "monthlyTrend": monthly_trend,
        })

    # Sort by totalSales descending
    title_summary.sort(key=lambda x: x["totalSales"], reverse=True)
    write_json(title_summary, "title_summary.json")

    # ---- platform_summary.json ----
    print("Generating platform_summary.json ...")
    plat_groups = df_raw.groupby("channel")

    platform_summary = []
    for plat, grp in plat_groups:
        total_sales = grp["sales"].sum()
        title_count = grp["titleJP"].nunique()

        # Monthly trend
        mt = grp.groupby("month")["sales"].sum().sort_index()
        monthly_trend = [{"month": m, "sales": int(s)} for m, s in mt.items()]

        # Top 10 titles
        top_titles_raw = (
            grp.groupby(["titleKR", "titleJP"])["sales"]
            .sum()
            .sort_values(ascending=False)
            .head(10)
        )
        top_titles = []
        for (tkr, tjp), s in top_titles_raw.items():
            top_titles.append({
                "titleKR": tkr if pd.notna(tkr) else "",
                "titleJP": tjp if pd.notna(tjp) else "",
                "sales": int(s),
            })

        platform_summary.append({
            "platform": plat,
            "totalSales": int(total_sales),
            "titleCount": int(title_count),
            "monthlyTrend": monthly_trend,
            "topTitles": top_titles,
        })

    # Sort by totalSales descending
    platform_summary.sort(key=lambda x: x["totalSales"], reverse=True)
    write_json(platform_summary, "platform_summary.json")

    # ---- title_master.json ----
    print("Generating title_master.json ...")
    # Deduplicate by titleJP, aggregating platforms into a list
    master_groups = df_title.groupby("titleJP")
    title_master = []
    seen = set()
    for title_jp, grp in master_groups:
        if pd.isna(title_jp) or title_jp in seen:
            continue
        seen.add(title_jp)

        title_kr = ""
        for v in grp["titleKR"]:
            if pd.notna(v):
                title_kr = str(v)
                break

        series_name = ""
        for v in grp["seriesName"]:
            if pd.notna(v):
                series_name = str(v)
                break

        platforms_list = []
        if "platform" in grp.columns:
            platforms_list = sorted(
                set(
                    normalize_channel(p)
                    for p in grp["platform"]
                    if pd.notna(p) and str(p).strip()
                )
            )

        title_master.append({
            "titleKR": title_kr,
            "titleJP": str(title_jp),
            "seriesName": series_name,
            "platforms": platforms_list,
        })

    write_json(title_master, "title_master.json")

    print("\nDone! All JSON files written to:")
    print(f"  {OUTPUT_DIR}")


if __name__ == "__main__":
    main()
