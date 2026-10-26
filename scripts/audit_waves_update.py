import argparse
import csv
import io
import json
import re
import urllib.error
import xml.etree.ElementTree as ET
from datetime import datetime, timezone

import numpy as np
import pandas as pd
from PIL import Image, ImageDraw, ImageFont
from pyproj import Transformer
from shapely.geometry import Point, Polygon, shape
from shapely.ops import transform, unary_union

from build_waves_data import CACHE, ROOT, download

OUT = ROOT / "output/three-waves/update-audit"
START = pd.Timestamp("2025-01-04")
IGNITION = pd.Timestamp("2025-01-07")
END = START + pd.Timedelta(days=59)
YEARS = (2022, 2023, 2024)


STATIONS = [
    (1103, 88101, 3, 170),
    (16, 88502, 3, 731),
    (4010, 88502, 3, 731),
    (1302, 88101, 3, 170),
    (2005, 88101, 3, 170),
]


def reference_days(parameter):
    cached = CACHE / f"waves-update-reference-{parameter}.csv"
    if cached.exists():
        return pd.read_csv(cached, low_memory=False)
    frames = []
    for year in YEARS:
        name = f"daily_{parameter}_{year}.zip"
        path, _ = download(name, "https://aqs.epa.gov/aqsweb/airdata/" + name)
        rows = pd.read_csv(path, low_memory=False)
        rows = rows[
            (rows["State Code"] == 6)
            & (rows["County Code"] == 37)
            & rows["Site Num"].isin([row[0] for row in STATIONS])
            & (rows["Date Local"] >= f"{year}-01-01")
            & (rows["Date Local"] < f"{year}-04-01")
            & (rows["Sample Duration"] == "1 HOUR")
        ].copy()

        rows = rows[rows["Event Type"].fillna("No Events").isin(["No Events", "Events Included"])]
        if set(rows["Units of Measure"]) != {"Micrograms/cubic meter (LC)"}:
            raise ValueError("Reference units differ")
        frames.append(rows)
    result = pd.concat(frames, ignore_index=True)
    result.to_csv(cached, index=False)
    return result


def hourly_days():
    path = CACHE / "waves-update-hourly-2025.csv"
    if path.exists():
        return pd.read_csv(path, low_memory=False)
    frames = []
    columns = [
        "State Code",
        "County Code",
        "Site Num",
        "Parameter Code",
        "POC",
        "Method Code",
        "Method Name",
        "Date Local",
        "Time Local",
        "Date GMT",
        "Time GMT",
        "Sample Measurement",
        "Units of Measure",
        "Qualifier",
        "Latitude",
        "Longitude",
        "Datum",
    ]
    for parameter in (88101, 88502):
        name = f"hourly_{parameter}_2025.zip"
        source, _ = download(name, "https://aqs.epa.gov/aqsweb/airdata/" + name)
        for chunk in pd.read_csv(source, usecols=columns, chunksize=200000, low_memory=False):
            keep = chunk[
                (chunk["State Code"] == 6)
                & (chunk["County Code"] == 37)
                & chunk["Site Num"].isin([row[0] for row in STATIONS])
                & (chunk["Date Local"] >= "2025-01-01")
                & (chunk["Date Local"] <= END.strftime("%Y-%m-%d"))
            ]
            if not keep.empty:
                frames.append(keep)
    rows = pd.concat(frames, ignore_index=True)
    rows.to_csv(path, index=False)
    return rows


def end_of_run(days, threshold):
    run = 0
    for _, row in days.iterrows():
        date = pd.Timestamp(row["date"])
        if date < IGNITION:
            continue
        if row["hours"] >= 18 and pd.notna(row["mean"]) and row["mean"] <= threshold:
            run += 1
        else:
            run = 0
        if run == 3:
            return (date - pd.Timedelta(days=2)).strftime("%Y-%m-%d"), date.strftime("%Y-%m-%d")
    return None, None


def aggregate_days(rows, nonnegative=False):
    finite = rows[np.isfinite(rows["Sample Measurement"])].copy()
    if nonnegative:
        finite = finite[finite["Sample Measurement"] >= 0]
    grouped = finite.groupby("Date Local")["Sample Measurement"].agg(["count", "mean"])
    days = grouped.reindex(pd.date_range(START, END).strftime("%Y-%m-%d"))
    days.index.name = "date"
    days = days.rename(columns={"count": "hours"}).reset_index()
    days["hours"] = days["hours"].fillna(0).astype(int)
    days.loc[days["hours"] < 18, "mean"] = np.nan
    return days


def monitor_audit():
    OUT.mkdir(parents=True, exist_ok=True)
    references = {parameter: reference_days(parameter) for parameter in (88101, 88502)}
    hourly = hourly_days()
    sites = pd.read_csv(CACHE / "aqs_sites.zip", low_memory=False)
    perimeter = json.loads((CACHE / "eaton-perimeter.geojson").read_text())
    project = Transformer.from_crs(4326, 32611, always_xy=True).transform
    polygon = transform(
        project, unary_union([shape(row["geometry"]) for row in perimeter["features"]])
    )
    results = []
    plots = []
    for site, parameter, poc, method in STATIONS:
        identity = f"06-037-{site:04d}"
        metadata = sites[
            (sites["State Code"].astype(str).str.zfill(2) == "06")
            & (sites["County Code"] == 37)
            & (sites["Site Number"] == site)
        ].iloc[0]
        rows = hourly[
            (hourly["Site Num"] == site)
            & (hourly["Parameter Code"] == parameter)
            & (hourly["POC"] == poc)
            & (hourly["Method Code"] == method)
        ].copy()
        if len(rows):
            if set(rows["Units of Measure"]) != {"Micrograms/cubic meter (LC)"}:
                raise ValueError("Hourly units differ")
            if rows.duplicated(["Date Local", "Time Local"]).any():
                raise ValueError("Duplicate hourly stream: " + identity)
            local = pd.to_datetime(rows["Date Local"] + " " + rows["Time Local"])
            utc = pd.to_datetime(rows["Date GMT"] + " " + rows["Time GMT"])
            if not ((utc - local) == pd.Timedelta(hours=8)).all():
                raise ValueError("Local/GMT timestamps differ: " + identity)
            longitude, latitude, datum = rows.iloc[0][["Longitude", "Latitude", "Datum"]]
        else:
            longitude, latitude, datum = metadata[["Longitude", "Latitude", "Datum"]]
        if datum not in ("WGS84", "NAD83"):
            raise ValueError("Unverified coordinate datum")
        station_project = Transformer.from_crs(
            4269 if datum == "NAD83" else 4326, 32611, always_xy=True
        ).transform
        point = transform(station_project, Point(float(longitude), float(latitude)))
        reference = references[parameter]
        reference = reference[
            (reference["Site Num"] == site)
            & (reference["POC"] == poc)
            & (reference["Method Code"] == method)
        ].copy()

        for date, group in reference.groupby("Date Local"):
            if len(group[["Arithmetic Mean", "Observation Count"]].drop_duplicates()) != 1:
                raise ValueError("Conflicting daily summaries: " + identity + " " + date)
        reference = reference.drop_duplicates("Date Local")
        reference = reference[
            (reference["Observation Count"] >= 18)
            & (reference["Observation Count"] <= 24)
            & (reference["Observation Percent"] >= 75)
            & np.isfinite(reference["Arithmetic Mean"])
        ]
        reference.to_csv(OUT / (identity + "-reference.csv"), index=False)
        by_year = {
            str(year): int(reference["Date Local"].str.startswith(str(year)).sum())
            for year in YEARS
        }
        threshold = None
        if all(by_year.values()):

            threshold = float(np.quantile(reference["Arithmetic Mean"], 0.90, method="linear"))
        days = aggregate_days(rows)
        sensitivity = aggregate_days(rows, nonnegative=True)
        first, end = end_of_run(days, threshold) if threshold is not None else (None, None)
        _, sensitive_end = (
            end_of_run(sensitivity, threshold) if threshold is not None else (None, None)
        )
        reason = ""
        if rows.empty:
            reason = "No hourly records in the selected stream; 24-hour filter samples cannot replace missing hours"
        elif threshold is None:
            missing_years = ", ".join(year for year, count in by_year.items() if count == 0)
            reason = (
                "No same-parameter/POC/method reference in "
                + missing_years
                + "; do not silently stitch other instrument definitions"
            )
        elif end is None:
            reason = "No three-consecutive-day return within the 60-day cap"
        january = rows[rows["Date Local"] < "2025-02-01"]
        present = int(np.isfinite(january["Sample Measurement"]).sum())
        negative = int((january["Sample Measurement"] < 0).sum())
        peak = january[
            (january["Date Local"] >= "2025-01-07") & (january["Date Local"] <= "2025-01-12")
        ]
        result = {
            "id": identity,
            "name": metadata["Local Site Name"],
            "parameter": parameter,
            "poc": poc,
            "method": method,
            "longitude": float(longitude),
            "latitude": float(latitude),
            "datum": datum,
            "distanceKm": float(polygon.distance(point) / 1000),
            "januaryExpectedHours": 744,
            "januaryAbsentHours": 744 - len(january),
            "januaryNonfiniteHours": len(january) - present,
            "januaryNegativeHours": negative,
            "januarySuppliedFiniteHours": present,
            "januaryNonnegativeHours": present - negative,
            "jan7to12AbsentHours": 144 - int(np.isfinite(peak["Sample Measurement"]).sum()),
            "referenceValidDays": by_year,
            "referenceExpectedDays": {"2022": 90, "2023": 90, "2024": 91},
            "thresholdUgM3": threshold,
            "firstQualifyingDay": first,
            "windowEnd": end,
            "nonnegativeSensitivityEnd": sensitive_end,
            "unknownDaysToCap": days.loc[days["hours"] < 18, "date"].tolist(),
            "status": "available" if threshold is not None and end else "unavailable",
            "reason": reason,
        }
        days["thresholdUgM3"] = threshold
        days["atOrBelow"] = None
        if threshold is not None:
            good = days["hours"] >= 18
            days.loc[good, "atOrBelow"] = days.loc[good, "mean"] <= threshold
        days.to_csv(OUT / (identity + "-daily.csv"), index=False)
        plots.append((result, days))
        results.append(result)
    result = {
        "computedAt": datetime.now(timezone.utc).isoformat(),
        "start": START.strftime("%Y-%m-%d"),
        "ignition": IGNITION.strftime("%Y-%m-%d"),
        "cap": END.strftime("%Y-%m-%d"),
        "referenceYears": list(YEARS),
        "referenceMonths": [1, 2, 3],
        "minimumHoursPerDay": 18,
        "endRule": "third consecutive qualifying day on or after ignition",
        "negativePolicy": "Retain finite signed EPA measurements for daily means; report nonnegative-only sensitivity separately. No zero substitution.",
        "sources": [
            json.loads(path.read_text())
            for path in sorted(CACHE.glob("*.source.json"))
            if re.match(
                r"(daily_(88101|88502)_202[234]|hourly_(88101|88502)_2025|aqs_sites)\.zip\.source\.json$",
                path.name,
            )
        ],
        "stations": results,
    }
    (OUT / "monitor-windows.json").write_text(json.dumps(result, indent=2), encoding="utf-8")
    draw_chart(plots)
    print(json.dumps(result, indent=2), flush=True)


def daily_crosscheck():
    results = []
    for parameter in (88101, 88502):
        path, receipt = download(
            f"daily_{parameter}_2025.zip",
            f"https://aqs.epa.gov/aqsweb/airdata/daily_{parameter}_2025.zip",
        )
        rows = pd.read_csv(path, low_memory=False)
        rows = rows[
            (rows["State Code"] == 6)
            & (rows["County Code"] == 37)
            & (rows["Sample Duration"] == "1 HOUR")
            & rows["Event Type"].fillna("No Events").isin(["No Events", "Events Included"])
        ]
        for site, selected_parameter, poc, method in STATIONS:
            if selected_parameter != parameter or site == 2005:
                continue
            selected = rows[
                (rows["Site Num"] == site) & (rows["POC"] == poc) & (rows["Method Code"] == method)
            ]
            for _, group in selected.groupby("Date Local"):
                if len(group[["Arithmetic Mean", "Observation Count"]].drop_duplicates()) != 1:
                    raise ValueError("Conflicting check summaries")
            selected = selected.drop_duplicates("Date Local")
            calculated = pd.read_csv(OUT / f"06-037-{site:04d}-daily.csv")
            paired = calculated.merge(selected, left_on="date", right_on="Date Local")
            paired = paired[paired["hours"] >= 18]
            maximum = float((paired["mean"] - paired["Arithmetic Mean"]).abs().max())
            counts_agree = bool((paired["hours"] == paired["Observation Count"]).all())
            if maximum >= 0.0000011 or not counts_agree:
                raise ValueError("Daily reconstruction disagrees with EPA")
            results.append(
                {
                    "id": f"06-037-{site:04d}",
                    "pairedDays": len(paired),
                    "maximumMeanDifferenceUgM3": maximum,
                    "hourCountsAgree": counts_agree,
                    **receipt,
                }
            )
    (OUT / "daily-crosscheck.json").write_text(json.dumps(results, indent=2), encoding="utf-8")
    print(json.dumps(results, indent=2), flush=True)


def cached_check(name, url):
    try:
        path, receipt = download(name, url)
        return path, {"status": "available", **receipt}
    except (OSError, urllib.error.URLError) as error:
        return None, {
            "status": "unavailable",
            "sourceUrl": url,
            "checkedAt": datetime.now(timezone.utc).isoformat(),
            "reason": str(error),
        }


def plume_polygons(path):
    root = ET.parse(path).getroot()
    ns = {"k": "http://www.opengis.net/kml/2.2"}
    records = []
    invalid = 0
    densities = set()
    for placemark in root.findall(".//k:Placemark", ns):
        description = placemark.findtext("k:description", "", ns)
        density = re.search(r"Density:\s*([A-Za-z]+)", description)
        if not density:
            raise ValueError("Unverified NOAA density")
        category = density.group(1).lower()
        densities.add(category)
        if category not in ("light", "medium", "heavy"):
            raise ValueError("Unverified NOAA density category")
        if category == "light":
            continue
        for element in placemark.findall(".//k:Polygon", ns):

            def ring(boundary):
                text = boundary.findtext("k:LinearRing/k:coordinates", "", ns)
                return [
                    tuple(float(value) for value in coordinate.split(",")[:2])
                    for coordinate in text.split()
                ]

            outer = ring(element.find("k:outerBoundaryIs", ns))
            holes = [ring(boundary) for boundary in element.findall("k:innerBoundaryIs", ns)]
            polygon = Polygon(outer, holes)
            if not polygon.is_valid:
                invalid += 1
                continue
            records.append((category, polygon))
    return records, invalid, sorted(densities)


def plume_audit():
    OUT.mkdir(parents=True, exist_ok=True)
    monitor_result = json.loads((OUT / "monitor-windows.json").read_text())
    stations = [row for row in monitor_result["stations"] if row["windowEnd"]]
    end = max(row["windowEnd"] for row in stations)
    directory_checks = []
    directories = {}
    for month in pd.date_range(START, end).strftime("%Y/%m").unique():
        for label, base in [
            ("current", "https://www.ospo.noaa.gov/pub/Land/HMS/Smoke_Polygons/KML/"),
            ("legacy", "https://satepsanone.nesdis.noaa.gov/pub/FIRE/web/HMS/Smoke_Polygons/KML/"),
        ]:
            url = base + month + "/"
            path, receipt = cached_check(
                "hms-directory-" + label + "-" + month.replace("/", "-") + ".html", url
            )
            receipt["directory"] = label
            directory_checks.append(receipt)
            directories[(label, month)] = (url, path.read_text() if path else "")
    daily = []
    for date in pd.date_range(START, end).strftime("%Y-%m-%d"):
        filename = "hms_smoke" + date.replace("-", "") + ".kml"
        chosen = None
        for label in ("current", "legacy"):
            base, index = directories[(label, date[:7].replace("-", "/"))]
            if filename in index:
                chosen = (label, base + filename)
                break
        row = {"dateUtc": date, "file": filename}
        if chosen is None:
            row.update(status="unavailable", reason="No file in accessible checked directories")
        else:
            path, receipt = cached_check(
                "hms-" + chosen[0] + "-" + date.replace("-", "") + ".kml", chosen[1]
            )
            row.update(receipt)
            if path:
                polygons, invalid, densities = plume_polygons(path)
                row.update(
                    mediumHeavyPolygonCount=len(polygons),
                    invalidPolygonCount=invalid,
                    sourceDensities=densities,
                    monitorCoverage={},
                )
                for station in stations:
                    longitude, latitude = station["longitude"], station["latitude"]
                    if station["datum"] == "NAD83":
                        longitude, latitude = Transformer.from_crs(
                            4269, 4326, always_xy=True
                        ).transform(longitude, latitude)
                    covered = any(
                        polygon.covers(Point(longitude, latitude)) for _, polygon in polygons
                    )
                    if covered:
                        row["monitorCoverage"][station["id"]] = True
                    elif invalid:
                        row["monitorCoverage"][station["id"]] = None
                    else:
                        row["monitorCoverage"][station["id"]] = False
        daily.append(row)
    result = {
        "computedAt": datetime.now(timezone.utc).isoformat(),
        "start": START.strftime("%Y-%m-%d"),
        "end": end,
        "directoryChecks": directory_checks,
        "days": daily,
        "timeLimitation": "NOAA files use UTC analysis dates; EPA daily means use local standard days. Matching date labels do not create identical 24-hour measurement periods.",
        "missingFiles": [row["dateUtc"] for row in daily if row["status"] != "available"],
    }
    (OUT / "plume-audit.json").write_text(json.dumps(result, indent=2), encoding="utf-8")
    print(json.dumps(result, indent=2), flush=True)


def source_audit():
    OUT.mkdir(parents=True, exist_ok=True)

    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S")
    sources = {
        "county-item.json": "https://www.arcgis.com/sharing/rest/content/items/359b5a988070454d94fe5cc4538ec063?f=json",
        "county-layer.json": "https://services.arcgis.com/RmCCgQtiZLDCtblq/arcgis/rest/services/ZIPsLeadResults_CURRENT/FeatureServer/5?f=json",
        "airnow-terms.pdf": "https://docs.airnowapi.org/docs/DataUseGuidelines.pdf",
        "airnow-format.pdf": "https://docs.airnowapi.org/docs/ReportingAreaFactSheet.pdf",
        "airnow-places.csv": "https://files.airnowtech.org/airnow/today/cityzipcodes.csv",
        "airnow-areas.dat": "https://files.airnowtech.org/airnow/today/reportingarea_metadata.dat",
        "airnow-current.dat": "https://files.airnowtech.org/airnow/today/reportingarea.dat",
        "noaa-terms.html": "https://data.ngdc.noaa.gov/ngdcinfo/privacy.html",
        "noaa-today.kml": "https://satepsanone.nesdis.noaa.gov/pub/FIRE/web/HMS/Smoke_Polygons/KML/2026/10/hms_smoke20261018.kml",
        "county-release.html": "https://content.govdelivery.com/accounts/CALACOUNTY/bulletins/3f26c76",
        "epa-followup.html": "https://www.epa.gov/newsreleases/epas-eaton-fire-soil-sampling-confirms-federal-cleanup-protocols-effectively",
    }
    receipts = {}
    paths = {}
    for name, url in sources.items():
        path, receipt = cached_check("update-" + stamp + "-" + name, url)
        paths[name], receipts[name] = path, receipt
    places = []
    requested = [
        ("Burbank", "91502"),
        ("Glendale", "91206"),
        ("Pasadena", "91101"),
        ("Altadena", "91001"),
        ("La Cañada Flintridge", "91011"),
        ("Pacific Palisades", "90272"),
        ("Malibu", "90265"),
    ]
    if paths["airnow-places.csv"] and paths["airnow-current.dat"]:
        zip_rows = list(
            csv.DictReader(
                io.StringIO(paths["airnow-places.csv"].read_text(encoding="utf-8-sig")),
                delimiter="|",
            )
        )
        current_rows = list(
            csv.reader(
                io.StringIO(paths["airnow-current.dat"].read_text(encoding="utf-8-sig")),
                delimiter="|",
            )
        )
        for name, zipcode in requested:
            matches = [
                row for row in zip_rows if row["Zipcode"] == zipcode and row["State"] == "CA"
            ]
            if len(matches) != 1:
                places.append(
                    {"name": name, "zipcode": zipcode, "status": "unavailable", "matches": matches}
                )
                continue
            match = matches[0]
            observations = [
                row
                for row in current_rows
                if len(row) >= 17 and row[5] == "O" and row[7] == match["City"] and row[8] == "CA"
            ]
            places.append(
                {
                    "name": name,
                    "zipcode": zipcode,
                    "reportingArea": match["City"],
                    "latitude": float(match["Latitude"]),
                    "longitude": float(match["Longitude"]),
                    "status": "available" if observations else "no current observation",
                    "currentObservations": observations,
                }
            )
    item = json.loads(paths["county-item.json"].read_text()) if paths["county-item.json"] else {}
    layer = json.loads(paths["county-layer.json"].read_text()) if paths["county-layer.json"] else {}
    result = {
        "computedAt": datetime.now(timezone.utc).isoformat(),
        "sources": receipts,
        "places": places,
        "placeLimitation": "Fixed ZIP centroid, not a whole-city footprint or a private address.",
        "countyZipTerms": {
            "licenseInfo": item.get("licenseInfo"),
            "owner": item.get("owner"),
            "copyrightText": layer.get("copyrightText"),
            "sampleDateFields": [
                field["name"]
                for field in layer.get("fields", [])
                if field["type"] == "esriFieldTypeDate"
            ],
            "decision": "Link only unless an applicable reuse permission is established",
        },
    }
    (OUT / "source-audit.json").write_text(json.dumps(result, indent=2), encoding="utf-8")
    print(json.dumps(result, indent=2), flush=True)


def draw_chart(plots):
    plots = [(station, days) for station, days in plots if station["thresholdUgM3"] is not None]
    image = Image.new("RGB", (1300, 100 + len(plots) * 260), "white")
    draw = ImageDraw.Draw(image)
    font = ImageFont.truetype("C:/Windows/Fonts/arial.ttf", 19)
    small = ImageFont.truetype("C:/Windows/Fonts/arial.ttf", 16)
    draw.text(
        (30, 20),
        "Eaton monitor audit: daily PM2.5 against each station's reference 90th percentile",
        fill="#172d25",
        font=font,
    )
    draw.text(
        (30, 50),
        "Jan 4-Mar 4, 2025 (PST). Reference: Jan-Mar 2022-2024. Unknown days break the line; no gap filling.",
        fill="#40534c",
        font=small,
    )
    for index, (station, days) in enumerate(plots):
        top = 105 + index * 260
        left, right, bottom = 85, 1260, top + 185
        maximum = max(float(days["mean"].max()), station["thresholdUgM3"]) * 1.12
        draw.text(
            (30, top - 18),
            f"{station['name']} ({station['id']}) - threshold {station['thresholdUgM3']:.2f} ug/m3; confirmed {station['windowEnd']}",
            fill="#172d25",
            font=font,
        )
        for fraction in (0, 0.5, 1):
            y = bottom - fraction * 145
            draw.line((left, y, right, y), fill="#dfe5e1")
            draw.text((left - 55, y - 10), f"{maximum * fraction:.0f}", fill="#40534c", font=small)
        draw.text((left - 55, top + 10), "ug/m3", fill="#40534c", font=small)
        threshold_y = bottom - station["thresholdUgM3"] / maximum * 145
        draw.line((left, threshold_y, right, threshold_y), fill="#ad5b1b", width=2)
        previous = None
        for day_index, row in days.iterrows():
            x = left + day_index / 59 * (right - left)
            if pd.isna(row["mean"]):
                draw.line((x, bottom - 5, x, bottom + 5), fill="#777777", width=3)
                previous = None
                continue
            y = bottom - row["mean"] / maximum * 145
            if previous:
                draw.line((*previous, x, y), fill="#246b55", width=3)
            draw.ellipse((x - 2, y - 2, x + 2, y + 2), fill="#246b55")
            previous = (x, y)
        if station["windowEnd"]:
            day_index = (pd.Timestamp(station["windowEnd"]) - START).days
            x = left + day_index / 59 * (right - left)
            draw.line((x, top + 35, x, bottom), fill="#365f96", width=2)
        for offset in (0, 7, 14, 21, 28, 35, 42, 49, 59):
            x = left + offset / 59 * (right - left)
            label = (START + pd.Timedelta(days=offset)).strftime("%b %d")
            draw.text((x - 22, bottom + 10), label, fill="#40534c", font=small)
    draw.text(
        (30, image.height - 30),
        "Green: daily mean | Brown: reference threshold | Blue: third-day confirmation | Gray ticks: unknown days. Source: EPA AQS.",
        fill="#40534c",
        font=small,
    )
    image.save(OUT / "daily-means.png")


def self_test():
    days = pd.DataFrame(
        {
            "date": pd.date_range("2025-01-07", periods=5).strftime("%Y-%m-%d"),
            "hours": [18, 17, 18, 18, 18],
            "mean": [10, np.nan, 10, 10, 10],
        }
    )
    assert end_of_run(days, 10) == ("2025-01-09", "2025-01-11")
    assert end_of_run(days, 9) == (None, None)

    prior = pd.DataFrame(
        {
            "date": pd.date_range("2025-01-04", periods=6).strftime("%Y-%m-%d"),
            "hours": [24] * 6,
            "mean": [1] * 6,
        }
    )
    assert end_of_run(prior, 1) == ("2025-01-07", "2025-01-09")
    prior.loc[3, "mean"] = 2
    assert end_of_run(prior, 1) == (None, None)
    assert END.strftime("%Y-%m-%d") == "2025-03-04"
    assert float(np.quantile([0, 10], 0.9, method="linear")) == 9


if __name__ == "__main__":
    self_test()
    parser = argparse.ArgumentParser()
    parser.add_argument("--sources", action="store_true")
    parser.add_argument("--plumes", action="store_true")
    parser.add_argument("--check-daily", action="store_true")
    args = parser.parse_args()
    if args.sources:
        source_audit()
    elif args.plumes:
        plume_audit()
    elif args.check_daily:
        daily_crosscheck()
    else:
        monitor_audit()
