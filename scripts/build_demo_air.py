import csv
import hashlib
import io
import json
import zipfile
from datetime import datetime, timezone
from pathlib import Path
from urllib.request import urlopen

ROOT = Path(__file__).resolve().parents[1]
BASE = "https://files.airnowtech.org/airnow/2025/20250108/"
HOUR = "2025-01-08T23:00:00Z"


def download(name):
    url = BASE + name
    with urlopen(url, timeout=60) as response:
        content = response.read()
    return content.decode("utf-8-sig"), {
        "sourceUrl": url,
        "retrievedAt": datetime.now(timezone.utc).isoformat(),
        "sha256": hashlib.sha256(content).hexdigest(),
    }


def main():
    text, monitor_source = download("HourlyAQObs_2025010823.dat")
    regional, regional_source = download("reportingarea.dat")
    monitors = []
    for row in csv.DictReader(io.StringIO(text)):
        if row["StateName"] != "CA" or row["CountryCode"] != "US":
            continue
        if row["ValidDate"] != "01/08/2025" or row["ValidTime"] != "23:00":
            raise ValueError("Unexpected monitor hour")
        readings = [
            (float(row[key]), pollutant)
            for key, pollutant in [
                ("OZONE_AQI", "Ozone"),
                ("PM25_AQI", "PM2.5"),
                ("PM10_AQI", "PM10"),
                ("NO2_AQI", "NO2"),
            ]
            if row[key] and float(row[key]) >= 0
        ]
        if not readings:
            continue
        aqi, pollutant = max(readings)
        monitors.append(
            {
                "type": "Feature",
                "id": row["AQSID"],
                "geometry": {
                    "type": "Point",
                    "coordinates": [float(row["Longitude"]), float(row["Latitude"])],
                },
                "properties": {
                    "AQSID": row["AQSID"],
                    "SiteName": row["SiteName"],
                    "StateName": "CA",
                    "DataSource": row["DataSource"],
                    "ValidTime": HOUR,
                    "OZONEPM_AQI": aqi,
                    "PM_AQI": None,
                    "PM25": row["PM25"],
                    "PM25_Unit": row["PM25_Unit"],
                    "pollutant": pollutant,
                },
            }
        )
    rows = [line for line in regional.splitlines() if line.split("|")[8] == "CA"]

    observed = [
        line.split("|")
        for line in rows
        if line.split("|")[5] == "O" and line.split("|")[3] == "PST"
    ]
    times = sorted({row[1] + " " + row[2] + " " + row[3] for row in observed})
    if times != ["01/08/25 20:00 PST"]:
        raise ValueError(f"Unexpected reporting-area observation times: {times}")
    output = {
        "monitors": {"type": "FeatureCollection", "features": monitors},
        "regionalText": "\n".join(line for line in rows if line.split("|")[5] == "O"),
        "monitorTime": HOUR,
        "regionalTime": "2025-01-09T04:00:00Z",
        "sources": [monitor_source, regional_source],
    }

    concentrations = {}
    for parameter in ["88101", "88502"]:
        path = ROOT / f"data/raw/waves/6-all-hourly-{parameter}-2025.csv"
        url = f"https://aqs.epa.gov/aqsweb/airdata/hourly_{parameter}_2025.zip"
        if path.exists():
            stream = path.open(encoding="utf-8-sig", newline="")
        else:
            with urlopen(url, timeout=180) as response:
                archive = zipfile.ZipFile(io.BytesIO(response.read()))
            stream = io.TextIOWrapper(
                archive.open(f"hourly_{parameter}_2025.csv"), encoding="utf-8-sig"
            )
        with stream:
            for row in csv.DictReader(stream):
                if (
                    int(row["State Code"]) != 6
                    or row["Date GMT"] != "2025-01-08"
                    or row["Time GMT"] != "23:00"
                    or not row["Sample Measurement"]
                ):
                    continue
                site = f'{int(row["State Code"]):02}{int(row["County Code"]):03}{int(row["Site Num"]):04}'
                station = concentrations.setdefault(
                    site,
                    {
                        "type": "Feature",
                        "id": site,
                        "geometry": {
                            "type": "Point",
                            "coordinates": [float(row["Longitude"]), float(row["Latitude"])],
                        },
                        "properties": {"siteId": site, "timestamp": HOUR, "measurements": []},
                    },
                )
                station["properties"]["measurements"].append(
                    {
                        "value": float(row["Sample Measurement"]),
                        "qualifier": row["Qualifier"],
                        "parameter": parameter,
                        "poc": row["POC"],
                        "method": row["Method Name"],
                        "sourceUrl": url,
                    }
                )
    output["concentrations"] = {
        "type": "FeatureCollection",
        "features": list(concentrations.values()),
    }
    path = ROOT / "frontend/public/data/demo/california-2025-01-08-air.json"
    path.write_text(json.dumps(output, separators=(",", ":")) + "\n", encoding="utf-8")
    print(
        f"Saved {len(monitors)} AQI monitors, {len(concentrations)} AQS PM2.5 sites and {len(observed)} regional pollutant observations"
    )


if __name__ == "__main__":
    main()
