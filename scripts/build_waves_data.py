import argparse
import base64
import csv
import hashlib
import json
import math
import os
import re
import shutil
import subprocess
import time
import urllib.parse
import urllib.request
import zipfile
from urllib.error import HTTPError
import xml.etree.ElementTree as ET
from datetime import datetime, timezone
from pathlib import Path

from PIL import Image
from pyproj import Transformer
from shapely.geometry import Point, Polygon, mapping, shape
from shapely.ops import transform

ROOT = Path(__file__).resolve().parents[1]
CACHE = ROOT / "data/raw/waves"
OUTPUT = ROOT / "frontend/public/data/waves.json"
USGS = "https://earthquake.usgs.gov/arcgis/rest/services/ls/pwfdf/MapServer"
SOURCES = {
    "aqi-breakpoints.csv": "https://aqs.epa.gov/aqsweb/documents/codetables/aqi_breakpoints.csv",
    "health-la.html": "https://www.cdc.gov/mmwr/volumes/74/wr/mm7403a2.htm",
    "health-california.json": "https://www.ebi.ac.uk/europepmc/webservices/rest/search?query=EXT_ID:39670153%20AND%20SRC:MED&format=json&resultType=core",
    "soil-county.html": "https://content.govdelivery.com/accounts/CALACOUNTY/bulletins/3f26c76",
    "soil-epa.html": "https://www.epa.gov/newsreleases/epas-eaton-fire-soil-sampling-confirms-federal-cleanup-protocols-effectively",
    "soil-report.pdf": "https://publichealth.lacounty.gov/media/wildfire/docs/Roux_Community_Soil_Sampling_and_Human_Health_Screening_Report_Eaton_and_Palisades_Fire_Regions.pdf",
    "qualifiers.csv": "https://aqs.epa.gov/aqsweb/documents/codetables/qualifiers.csv",
    "health-contrast.pdf": "https://www.pches.psu.edu/assets/summary_slides/Stowell_etal_2024_EnvResHealth_Slide.pdf",
}
FAILED_DOWNLOADS = {}
VERIFIED_DOWNLOADS = {}
SOURCE_FILES = {}
LAST_REQUEST_TIME = 0.0


def shared_source_name(name, url):
    key = str(CACHE)
    by_url = SOURCE_FILES.setdefault(key, {})
    if url in by_url:
        return by_url[url]
    receipt = CACHE / (name + ".source.json")
    if receipt.exists() and (CACHE / name).exists():
        metadata = json.loads(receipt.read_text(encoding="utf-8"))
        if metadata.get("sourceUrl") == url:
            by_url[url] = name
            return name
    from build_historical_coverage import cache_source_index

    cache_source_index(CACHE)
    pointer = CACHE / "url-index" / (hashlib.sha256(url.encode()).hexdigest() + ".json")
    if pointer.exists():
        saved = json.loads(pointer.read_text(encoding="utf-8"))
        if saved["sourceUrl"] != url or Path(saved["name"]).name != saved["name"]:
            raise ValueError("Source cache index identity differs")
        by_url[url] = saved["name"]
        return saved["name"]
    receipt = CACHE / (name + ".source.json")
    if receipt.exists():
        metadata = json.loads(receipt.read_text(encoding="utf-8"))
        if metadata.get("sourceUrl") != url:
            path = Path(name)
            name = path.stem + "-" + hashlib.sha256(url.encode()).hexdigest()[:16] + path.suffix
    return name


def retrieve_source(request, destination):
    from build_historical_coverage import (
        REQUEST_INTERVAL_SECONDS,
        MAX_DOWNLOAD_ATTEMPTS,
        DOWNLOAD_TIMEOUT_SECONDS,
        DOWNLOAD_CHUNK_BYTES,
    )
    from build_historical_coverage import DISK_CHECK_BYTES

    global LAST_REQUEST_TIME
    for attempt in range(MAX_DOWNLOAD_ATTEMPTS):
        delay = REQUEST_INTERVAL_SECONDS - (time.monotonic() - LAST_REQUEST_TIME)
        if delay > 0:
            time.sleep(delay)
        LAST_REQUEST_TIME = time.monotonic()
        try:
            checksum = hashlib.sha256()
            published_checksum = hashlib.md5()
            size = 0
            with urllib.request.urlopen(
                request, timeout=DOWNLOAD_TIMEOUT_SECONDS
            ) as response, destination.open("wb") as output:
                verify_requested_range(request, response)
                expected = response.headers.get("Content-Length")
                require_download_space(destination, int(expected) if expected else 0)
                while True:
                    content = response.read(DOWNLOAD_CHUNK_BYTES)
                    if not content:
                        break
                    output.write(content)
                    checksum.update(content)
                    published_checksum.update(content)
                    size += len(content)
                    if size % DISK_CHECK_BYTES < len(content):
                        require_download_space(destination)
            if expected and size != int(expected):
                raise OSError("Incomplete source download")
            return {
                "bytes": size,
                "sha256": checksum.hexdigest(),
                "md5": published_checksum.hexdigest(),
            }
        except OSError as error:
            if isinstance(error, HTTPError) and error.code in (400, 401, 403, 404, 410):
                raise
            if attempt + 1 == MAX_DOWNLOAD_ATTEMPTS:
                raise


def require_download_space(destination, remaining_bytes=0):
    from build_historical_coverage import MIN_FREE_DISK_BYTES

    free_bytes = shutil.disk_usage(destination.parent).free
    if free_bytes < remaining_bytes + MIN_FREE_DISK_BYTES:
        raise RuntimeError(
            "Local cache space is insufficient; source availability is not determined"
        )


def verify_requested_range(request, response):
    requested = request.get_header("Range")
    if requested:
        actual = response.headers.get("Content-Range", "").split("/")[0]
        if response.status != 206 or actual != requested.replace("=", " "):
            raise ValueError("Source did not return the requested byte range")


def source_request(url):
    address, marker, byte_range = url.partition("#bytes=")
    headers = {"User-Agent": "WatchtowerStudentPreview/1.0"}
    if marker:
        if not re.fullmatch(r"\d+-\d+", byte_range):
            raise ValueError("Invalid source byte range")
        start, end = [int(value) for value in byte_range.split("-")]
        if end < start:
            raise ValueError("Invalid source byte range")
        headers["Range"] = "bytes=" + byte_range
    request_url, _, arguments = address.partition("?")
    if len(address) > 2000:
        return urllib.request.Request(request_url, data=arguments.encode(), headers=headers)
    return urllib.request.Request(address, headers=headers)


def check_previous_failure(url, failure_path):
    if failure_path.exists() and os.environ.get("WILDFIRE_RETRY_SOURCES") != "1":
        failure = json.loads(failure_path.read_text(encoding="utf-8"))
        if failure["sourceUrl"] != url:
            raise ValueError("Failure receipt URL differs")
        if failure["httpStatus"]:
            raise HTTPError(
                url,
                failure["httpStatus"],
                "Recorded source failure; explicit retry required",
                {},
                None,
            )
        raise OSError("Recorded source access failure; explicit retry required")
    if url in FAILED_DOWNLOADS:
        raise FAILED_DOWNLOADS[url]


def fetch_source(path, receipt, url):
    failure_path = CACHE / "failures" / (hashlib.sha256(url.encode()).hexdigest() + ".json")
    check_previous_failure(url, failure_path)
    print("Downloading", path.name, flush=True)
    request = source_request(url)
    temporary = path.with_suffix(path.suffix + "." + str(os.getpid()) + ".partial")
    try:
        metadata = retrieve_source(request, temporary)
        temporary.replace(path)
        receipt.write_text(
            json.dumps(
                {
                    "sourceUrl": url,
                    "retrievedAt": datetime.now(timezone.utc).isoformat(),
                    **metadata,
                },
                indent=2,
            ),
            encoding="utf-8",
        )
        stat = path.stat()
        VERIFIED_DOWNLOADS[str(path)] = (stat.st_mtime_ns, stat.st_size, metadata["sha256"])
    except OSError as error:
        from build_historical_coverage import source_error_status

        if source_error_status(error) == "processing_failed":
            raise
        FAILED_DOWNLOADS[url] = error
        failure_path.parent.mkdir(parents=True, exist_ok=True)
        failed_temporary = failure_path.with_suffix("." + str(os.getpid()) + ".tmp")
        failed_temporary.write_text(
            json.dumps(
                {
                    "sourceUrl": url,
                    "checkedAt": datetime.now(timezone.utc).isoformat(),
                    "httpStatus": getattr(error, "code", None),
                    "reason": str(error),
                }
            ),
            encoding="utf-8",
        )
        failed_temporary.replace(failure_path)
        raise
    finally:
        if temporary.exists():
            temporary.unlink()


def verified_source(path, receipt, url):
    metadata = json.loads(receipt.read_text(encoding="utf-8"))
    if metadata["sourceUrl"] != url:
        raise ValueError("Cached source URL changed: " + path.name)
    stat = path.stat()
    signature = (stat.st_mtime_ns, stat.st_size, metadata["sha256"])
    if VERIFIED_DOWNLOADS.get(str(path)) != signature:
        from build_historical_coverage import file_hash

        checksum = file_hash(path)
        if stat.st_size != metadata["bytes"] or checksum != metadata["sha256"]:
            raise ValueError("Cached source bytes changed: " + path.name)
        VERIFIED_DOWNLOADS[str(path)] = signature
    return metadata


def download(name, url):
    CACHE.mkdir(parents=True, exist_ok=True)
    name = shared_source_name(name, url)
    path = CACHE / name
    receipt = CACHE / (name + ".source.json")
    if not path.exists() or not receipt.exists():
        fetch_source(path, receipt, url)
    metadata = verified_source(path, receipt, url)
    from build_historical_coverage import remember_cached_source

    remember_cached_source(CACHE, url, name)
    SOURCE_FILES[str(CACHE)][url] = name
    return path, metadata


def query_fire_layer(fire_id, layer, name, fields, geometry, errors):
    params = {
        "where": "Fire_ID='" + fire_id + "'",
        "outFields": fields,
        "returnGeometry": str(geometry).lower(),
        "outSR": "4326",
        "f": "geojson",
    }
    if fields != "*" and not geometry:
        params["returnDistinctValues"] = "true"
    url = USGS + f"/{layer}/query?" + urllib.parse.urlencode(params)
    path, metadata = download(name, url)
    payload = json.loads(path.read_text(encoding="utf-8"))
    if payload.get("error") or payload.get("exceededTransferLimit"):
        raise ValueError(errors[0])
    if not payload.get("features"):
        raise ValueError(errors[1])
    return payload, metadata


def query(layer, name, fields="*", geometry=True):
    return query_fire_layer(
        "eat2025",
        layer,
        name,
        fields,
        geometry,
        ("Incomplete USGS source: " + name, "No Eaton features: " + name),
    )


def rainfall_sources():
    perimeter, provenance = query(9, "eaton-perimeter.geojson")
    return perimeter, provenance


def audit_monitors(perimeter):
    import pandas as pd

    project = Transformer.from_crs("EPSG:4326", "EPSG:32611", always_xy=True).transform
    polygon = transform(project, shape(perimeter["features"][0]["geometry"]))
    subset = CACHE / "january-la-pm25.csv"
    if subset.exists():
        rows = pd.read_csv(subset, low_memory=False)
    else:
        frames = []
        columns = [
            "State Code",
            "County Code",
            "Site Num",
            "Parameter Code",
            "POC",
            "Method Code",
            "Method Name",
            "Latitude",
            "Longitude",
            "Date Local",
            "Time Local",
            "Date GMT",
            "Time GMT",
            "Sample Measurement",
            "Units of Measure",
            "Qualifier",
            "Datum",
            "Method Type",
        ]
        for parameter in (88101, 88502):
            name = f"hourly_{parameter}_2025.zip"
            path, provenance = download(name, "https://aqs.epa.gov/aqsweb/airdata/" + name)
            with zipfile.ZipFile(path) as archive:
                with archive.open(archive.namelist()[0]) as source:
                    for chunk in pd.read_csv(
                        source, usecols=columns, chunksize=200000, low_memory=False
                    ):
                        local = chunk[
                            (chunk["State Code"] == 6)
                            & (chunk["County Code"] == 37)
                            & (chunk["Date Local"] >= "2025-01-01")
                            & (chunk["Date Local"] < "2025-02-01")
                        ]
                        if not local.empty:
                            frames.append(local.copy())
        if not frames:
            raise ValueError("No January LA County PM2.5 records")
        rows = pd.concat(frames, ignore_index=True)
        rows.to_csv(subset, index=False)
    sites_path, _ = download("aqs_sites.zip", "https://aqs.epa.gov/aqsweb/airdata/aqs_sites.zip")
    sites = pd.read_csv(sites_path, low_memory=False)
    records = []
    keys = ["State Code", "County Code", "Site Num", "Parameter Code", "POC", "Method Code"]
    for identity, readings in rows.groupby(keys):
        first = readings.iloc[0]
        names = sites[
            (sites["State Code"].astype(str).str.zfill(2) == f"{int(identity[0]):02d}")
            & (sites["County Code"] == identity[1])
            & (sites["Site Number"] == identity[2])
        ]
        site_name = str(names.iloc[0]["Local Site Name"]) if len(names) == 1 else "Name unavailable"
        datum = str(first["Datum"])
        if datum not in ("WGS84", "NAD83"):
            raise ValueError("Unverified monitor coordinate datum")
        station_project = Transformer.from_crs(
            "EPSG:4269" if datum == "NAD83" else "EPSG:4326", "EPSG:32611", always_xy=True
        ).transform
        point = transform(
            station_project, Point(float(first["Longitude"]), float(first["Latitude"]))
        )
        distance = polygon.distance(point) / 1000
        if distance > 50:
            continue
        readings = readings.copy()
        readings["timestamp"] = readings["Date Local"] + "T" + readings["Time Local"]
        valid = readings[
            readings["Sample Measurement"].notna() & (readings["Sample Measurement"] >= 0)
        ]
        if set(readings["Units of Measure"]) != {"Micrograms/cubic meter (LC)"}:
            raise ValueError("Unverified PM2.5 units")
        hours = valid["timestamp"].nunique()
        absent = 744 - readings["timestamp"].nunique()
        peak_window = valid[
            (valid["Date Local"] >= "2025-01-07") & (valid["Date Local"] <= "2025-01-12")
        ]
        state, county, site, parameter, poc, method = (int(value) for value in identity)
        records.append(
            {
                "id": f"{state:02d}-{county:03d}-{site:04d}",
                "name": site_name,
                "parameter": parameter,
                "poc": poc,
                "method": method,
                "methodName": first["Method Name"],
                "latitude": first["Latitude"],
                "longitude": first["Longitude"],
                "distanceKm": round(distance, 3),
                "datum": datum,
                "validHours": hours,
                "missingHours": 744 - hours,
                "absentHours": absent,
                "negativeHours": int((readings["Sample Measurement"] < 0).sum()),
                "jan7to12MissingHours": 144 - peak_window["timestamp"].nunique(),
                "duplicateHours": len(valid) - hours,
                "qualifiers": sorted(
                    str(value) for value in readings["Qualifier"].dropna().unique()
                ),
            }
        )
    records.sort(key=lambda item: (item["distanceKm"], item["parameter"], item["poc"]))
    (CACHE / "monitor-audit.json").write_text(json.dumps(records, indent=2), encoding="utf-8")
    rows.to_csv(CACHE / "january-la-pm25.csv", index=False)
    print(json.dumps(records[:12], indent=2), flush=True)
    return records


def source(name, label="Historical"):
    _, metadata = download(name, SOURCES[name])
    return {**metadata, "dataClass": label}


def measurement(value, provenance, **details):
    return {"value": value, **provenance, **details}


def build_data(monitor_id):
    import pandas as pd

    perimeter, perimeter_source = rainfall_sources()
    audit = json.loads((CACHE / "monitor-audit.json").read_text(encoding="utf-8"))
    candidates = [row for row in audit if row["id"] == monitor_id]
    if len(candidates) != 1:
        raise ValueError("Select one audited monitor stream")
    monitor = candidates[0]
    rows = pd.read_csv(CACHE / "january-la-pm25.csv", low_memory=False)
    rows = rows[
        (rows["Site Num"] == int(monitor_id.split("-")[2]))
        & (rows["Parameter Code"] == monitor["parameter"])
        & (rows["POC"] == monitor["poc"])
        & (rows["Method Code"] == monitor["method"])
    ].copy()
    rows["timestamp"] = rows["Date Local"] + "T" + rows["Time Local"] + ":00-08:00"
    if rows["timestamp"].duplicated().any():
        raise ValueError("Duplicate monitor hours")

    for _, row in rows.iterrows():
        local = datetime.fromisoformat(row["timestamp"]).astimezone(timezone.utc)
        utc = datetime.fromisoformat(row["Date GMT"] + "T" + row["Time GMT"] + ":00+00:00")
        if local != utc:
            raise ValueError("EPA local/GMT timestamps disagree")
    by_time = rows.set_index("timestamp")
    parameter_name = f"hourly_{monitor['parameter']}_2025.zip"
    pm_source = json.loads((CACHE / (parameter_name + ".source.json")).read_text(encoding="utf-8"))
    pm_source["dataClass"] = "Observed"
    series = []
    for hour in pd.date_range(
        "2025-01-01", "2025-02-01", freq="h", inclusive="left", tz="Etc/GMT+8"
    ):
        timestamp = hour.isoformat()
        value = None
        reason = "Missing source hour"
        qualifier = None
        if timestamp in by_time.index:
            row = by_time.loc[timestamp]
            raw = float(row["Sample Measurement"])
            qualifier = None if pd.isna(row["Qualifier"]) else str(row["Qualifier"])
            if pd.notna(raw) and raw >= 0:
                value, reason = raw, ""
            else:
                reason = "Negative or missing source measurement"
        series.append(
            measurement(value, pm_source, timestamp=timestamp, reason=reason, qualifier=qualifier)
        )

    aqi_source = source("aqi-breakpoints.csv")
    breakpoint_path = CACHE / "aqi-breakpoints.csv"
    bands = []
    colors = ["#00e400", "#ffff00", "#ff7e00", "#ff0000", "#8f3f97", "#7e0023"]
    names = [
        "Good",
        "Moderate",
        "Unhealthy for sensitive groups",
        "Unhealthy",
        "Very unhealthy",
        "Hazardous",
    ]
    with breakpoint_path.open(encoding="utf-8-sig") as handle:
        for row in csv.DictReader(handle):
            if (
                row["Parameter Code"] != "88101"
                or row["Duration Code"] != "7"
                or int(row["Low AQI"]) > 500
            ):
                continue
            index = len(bands)
            bands.append(
                {
                    "name": names[index],
                    "low": float(row["Low Breakpoint"]),
                    "high": float(row["High Breakpoint"]),
                    "color": colors[index],
                }
            )
    if [row["high"] for row in bands] != [9.0, 35.4, 55.4, 125.4, 225.4, 325.4]:
        raise ValueError("EPA AQI breakpoints changed; review before building")

    la_source = source("health-la.html")
    state_source = source("health-california.json")
    source("health-contrast.pdf")
    source("qualifiers.csv")
    la_text = (CACHE / "health-la.html").read_text(encoding="utf-8")
    if any(text not in la_text for text in ("0.06%", "0.52%", "9%")):
        raise ValueError("LA County findings changed; review the source")
    state_record = json.loads((CACHE / "health-california.json").read_text())["resultList"][
        "result"
    ][0]
    if "15.17% (12.86%, 17.52%)" not in state_record["abstractText"]:
        raise ValueError("Statewide finding differs from the primary abstract")
    state_source["sourceUrl"] = "https://doi.org/10.1088/2752-5309/ad976d"
    state_source["retrievalUrl"] = SOURCES["health-california.json"]
    reviewed = json.loads((ROOT / "data/waves_reviewed_evidence.json").read_text(encoding="utf-8"))
    health = []
    for row in reviewed["health"]:
        sources = {la_source["sourceUrl"]: la_source, state_source["sourceUrl"]: state_source}
        if row["sourceUrl"] not in sources:
            raise ValueError("Reviewed health source differs from the cached publication")
        fields = {
            key: value
            for key, value in row.items()
            if key not in ("value", "sourceUrl", "retrievedAt", "dataClass")
        }
        health.append(measurement(row["value"], sources[row["sourceUrl"]], **fields))

    county_source = source("soil-county.html")
    report_source = source("soil-report.pdf")
    epa_source = source("soil-epa.html")
    county_text = (CACHE / "soil-county.html").read_text(encoding="utf-8")
    epa_text = (CACHE / "soil-epa.html").read_text(encoding="utf-8")
    if "Of the 23 sampling grids" not in county_text or "10 had average" not in county_text:
        raise ValueError("County soil findings changed; review the source")
    if "98%" not in epa_text or "95%" not in epa_text:
        raise ValueError("EPA follow-up findings changed; review the source")

    grid_values = {row["id"]: row["value"] for row in reviewed["grids"]}
    county = reviewed["county"]
    if (
        sum(value > county["screeningMgKg"] for value in grid_values.values()) != county["value"]
        or len(grid_values) != county["total"]
    ):
        raise ValueError("County grid transcription disagrees with final counts")
    grids = []
    for grid_id, value in grid_values.items():
        grids.append(
            measurement(value, report_source, id=grid_id, unit="mg/kg", statistic="Geometric mean")
        )

    record_payload, record_source = query(0, "eaton-location.json", geometry=False)
    if len(record_payload["features"]) != 1:
        raise ValueError("Ambiguous Eaton assessment")
    record = record_payload["features"][0]["properties"]
    expected = {"Fire_ID": "eat2025", "start_date": 1736208000000, "assessment_date": 1737244800000}
    for feature in perimeter["features"]:
        if any(feature["properties"].get(key) != value for key, value in expected.items()):
            raise ValueError("USGS perimeter identity mismatch")
    polygon = shape(perimeter["features"][0]["geometry"])
    west, south, east, north = polygon.bounds
    bounds = [west - 0.005, south - 0.005, east + 0.005, north + 0.005]
    modes = {"likelihood": (2, 1), "volume": (6, 7), "combined": (4, 5)}

    render_code = """
import { hazardRenderer, hazardClasses } from './src/usgsHazards.ts';
const renderers = {};
for (const layer of [1, 2, 4, 5, 6, 7]) {
    renderers[layer] = hazardRenderer(layer);
}
console.log(JSON.stringify({ renderers, classes: hazardClasses }));
"""
    rendered = subprocess.run(
        ["node", "--import", "tsx", "--input-type=module", "-e", render_code],
        cwd=ROOT / "frontend",
        check=True,
        capture_output=True,
        text=True,
    )
    display = json.loads(rendered.stdout)
    layers = {}
    for mode, numbers in modes.items():
        for layer in numbers:
            identity, _ = query(
                layer,
                f"eaton-layer-{layer}.json",
                "Fire_ID,start_date,assessment_date,version",
                False,
            )
            for feature in identity["features"]:
                properties = feature["properties"]
                properties["Fire_ID"] = properties.get("fire_id")
                if (
                    any(properties.get(key) != value for key, value in expected.items())
                    or properties.get("version") != "1.0"
                ):
                    raise ValueError("USGS layer identity mismatch")
        dynamic_layers = []
        for layer in numbers:
            dynamic_layers.append(
                {
                    "id": layer,
                    "source": {"type": "mapLayer", "mapLayerId": layer},
                    "definitionExpression": "fire_id='eat2025'",
                    "drawingInfo": {"renderer": display["renderers"][str(layer)]},
                }
            )
        params = {
            "bbox": ",".join(str(value) for value in bounds),
            "bboxSR": "4326",
            "imageSR": "3857",
            "size": "1200,1200",
            "format": "png32",
            "transparent": "true",
            "f": "json",
            "dynamicLayers": json.dumps(dynamic_layers),
        }
        export_path, image_source = download(
            f"eaton-{mode}-export.json", USGS + "/export?" + urllib.parse.urlencode(params)
        )
        export = json.loads(export_path.read_text())
        if "href" not in export or export["extent"]["spatialReference"]["wkid"] != 102100:
            raise ValueError("USGS map export or its projected extent is unverified")
        path, _ = download(f"eaton-{mode}-app-colors.png", export["href"])
        extent = export["extent"]
        geographic = Transformer.from_crs("EPSG:3857", "EPSG:4326", always_xy=True)
        west, south = geographic.transform(extent["xmin"], extent["ymin"])
        east, north = geographic.transform(extent["xmax"], extent["ymax"])
        image_bounds = [west, south, east, north]
        content = path.read_bytes()
        if not content.startswith(b"\x89PNG"):
            raise ValueError("USGS map did not return a PNG")
        with Image.open(path) as image:
            if not image.convert("RGBA").getchannel("A").getbbox():
                raise ValueError("USGS map is entirely transparent")
        layers[mode] = {
            "status": "available",
            **image_source,
            "dataClass": "Historical",
            "image": "data:image/png;base64," + base64.b64encode(content).decode(),
            "bounds": image_bounds,
            "classes": display["classes"][mode],
        }

    monitor["sourceUrl"] = "https://aqs.epa.gov/aqsweb/airdata/aqs_sites.zip"
    monitor["retrievedAt"] = json.loads((CACHE / "aqs_sites.zip.source.json").read_text())[
        "retrievedAt"
    ]
    monitor["dataClass"] = "Observed"
    result = {
        "schemaVersion": 1,
        "builtAt": datetime.now(timezone.utc).isoformat(),
        "case": {
            "name": "Eaton Fire",
            "county": "Los Angeles County",
            "ignition": "2025-01-07",
            **record_source,
            "dataClass": "Historical",
        },
        "perimeter": {
            "status": "available",
            "value": perimeter,
            **perimeter_source,
            "dataClass": "Historical",
        },
        "smoke": {
            "status": "available",
            "monitor": monitor,
            "series": series,
            "sourceUrl": pm_source["sourceUrl"],
            "retrievedAt": pm_source["retrievedAt"],
            "dataClass": "Observed",
            "timezone": "America/Los_Angeles (PST, UTC−08:00)",
            "health": health,
            "qualifiers": {
                "IJ": "High winds (informational)",
                "IT": "Wildfire-U.S. (informational)",
                **source("qualifiers.csv"),
            },
            "aqiReference": {"bands": bands, "averagingHours": 24, **aqi_source},
        },
        "ash": {
            "county": {**county, **county_source},
            "grids": grids,
            "geometry": {
                "status": "unavailable",
                "reason": "Separate grid geometry not verified; PDF map is not digitized.",
                **report_source,
            },
            "followup": [{**row, **epa_source} for row in reviewed["followup"]],
        },
        "rain": {"record": record, **record_source, "dataClass": "Historical", "layers": layers},
    }
    OUTPUT.write_text(
        json.dumps(result, ensure_ascii=False, separators=(",", ":")), encoding="utf-8"
    )
    print("Built", OUTPUT, OUTPUT.stat().st_size, "bytes", flush=True)


def approved_station(station, hourly, audit_folder):
    import pandas as pd

    rows = hourly[
        (hourly["Site Num"] == int(station["id"].split("-")[-1]))
        & (hourly["Parameter Code"] == station["parameter"])
        & (hourly["POC"] == station["poc"])
        & (hourly["Method Code"] == station["method"])
    ].copy()
    if set(rows["Units of Measure"]) != {"Micrograms/cubic meter (LC)"}:
        raise ValueError("Unverified station units")
    rows["timestamp"] = rows["Date Local"] + "T" + rows["Time Local"] + ":00-08:00"
    if rows["timestamp"].duplicated().any():
        raise ValueError("Duplicate station hours")
    for _, row in rows.iterrows():
        local = datetime.fromisoformat(row["timestamp"]).astimezone(timezone.utc)
        utc = datetime.fromisoformat(row["Date GMT"] + "T" + row["Time GMT"] + ":00+00:00")
        if local != utc:
            raise ValueError("EPA local/GMT timestamps disagree")
    by_time = rows.set_index("timestamp")
    receipt = CACHE / f"hourly_{station['parameter']}_2025.zip.source.json"
    provenance = {**json.loads(receipt.read_text()), "dataClass": "Observed"}
    series = []
    for hour in pd.date_range(
        "2025-01-04", "2025-01-15", freq="h", inclusive="left", tz="Etc/GMT+8"
    ):
        timestamp = hour.isoformat()
        value, qualifier, reason = None, None, "Missing source hour"
        if timestamp in by_time.index:
            row = by_time.loc[timestamp]
            raw = float(row["Sample Measurement"])
            qualifier = None if pd.isna(row["Qualifier"]) else str(row["Qualifier"])
            if math.isfinite(raw):
                value = raw
                reason = "Signed negative source reading retained" if raw < 0 else ""
            else:
                reason = "Missing source measurement"
        series.append(
            measurement(value, provenance, timestamp=timestamp, qualifier=qualifier, reason=reason)
        )
    daily = pd.read_csv(audit_folder / (station["id"] + "-daily.csv"))
    daily = daily[(daily["date"] >= "2025-01-04") & (daily["date"] <= "2025-01-14")]
    means = []
    for _, row in daily.iterrows():
        mean = float(row["mean"])
        means.append(
            measurement(
                mean if math.isfinite(mean) else None,
                provenance,
                date=row["date"],
                hours=int(row["hours"]),
            )
        )
    longitude, latitude = station["longitude"], station["latitude"]
    if station["datum"] == "NAD83":
        longitude, latitude = Transformer.from_crs(
            "EPSG:4269", "EPSG:4326", always_xy=True
        ).transform(longitude, latitude)
    return {
        **station,
        **provenance,
        "longitude": longitude,
        "latitude": latitude,
        "coordinateDatum": "WGS84",
        "series": series,
        "dailyMeans": means,
        "methodName": str(rows.iloc[0]["Method Name"]),
        "expectedHours": len(series),
        "missingHours": sum(row["value"] is None for row in series),
        "negativeHours": sum(row["value"] is not None and row["value"] < 0 for row in series),
    }


def approved_plumes(day, stations):
    path = CACHE / ("hms-legacy-" + day["dateUtc"].replace("-", "") + ".kml")
    root = ET.parse(path).getroot()
    ns = {"k": "http://www.opengis.net/kml/2.2"}
    features = []
    for placemark in root.findall(".//k:Placemark", ns):
        description = placemark.findtext("k:description", "", ns)
        match = re.search(r"Density:\s*([A-Za-z]+)", description)
        if not match or match.group(1).lower() not in ("light", "medium", "heavy"):
            raise ValueError("Unverified NOAA density")
        density = match.group(1).lower()
        if density == "light":
            continue
        times = {}
        for label, key in [("Start", "analysisStart"), ("End", "analysisEnd")]:
            time_match = re.search(label + r" Time:\s*(\d{7})\s+(\d{4})UTC", description)
            times[key] = None
            if time_match:
                parsed = datetime.strptime("".join(time_match.groups()), "%Y%j%H%M")
                times[key] = parsed.replace(tzinfo=timezone.utc).isoformat()
        for element in placemark.findall(".//k:Polygon", ns):
            rings = []
            for boundary in [
                element.find("k:outerBoundaryIs", ns),
                *element.findall("k:innerBoundaryIs", ns),
            ]:
                coordinates = boundary.findtext("k:LinearRing/k:coordinates", "", ns)
                rings.append(
                    [
                        tuple(float(value) for value in point.split(",")[:2])
                        for point in coordinates.split()
                    ]
                )
            polygon = Polygon(rings[0], rings[1:])
            if not polygon.is_valid:
                raise ValueError("Invalid NOAA polygon; review before rendering")
            features.append(
                {
                    "type": "Feature",
                    "geometry": mapping(polygon),
                    "properties": {"density": density, "dateUtc": day["dateUtc"], **times},
                }
            )
    coverage = {}
    for station in stations:
        point = Point(station["longitude"], station["latitude"])
        coverage[station["id"]] = any(
            shape(feature["geometry"]).covers(point) for feature in features
        )
    if coverage != day["monitorCoverage"] or len(features) != day["mediumHeavyPolygonCount"]:
        raise ValueError("NOAA conversion disagrees with the approval audit")
    return {"type": "FeatureCollection", "features": features}


def build_approved_update():
    import pandas as pd

    audit_folder = ROOT / "output/three-waves/update-audit"
    audit = json.loads((audit_folder / "monitor-windows.json").read_text())
    plume_audit = json.loads((audit_folder / "plume-audit.json").read_text())
    sources = json.loads((audit_folder / "source-audit.json").read_text())
    result = json.loads(OUTPUT.read_text(encoding="utf-8"))
    unchanged = {key: result[key] for key in ("case", "perimeter", "rain")}
    original_grids = result["ash"]["grids"]
    hourly = pd.read_csv(CACHE / "waves-update-hourly-2025.csv", low_memory=False)
    stations = []
    for identity, name, color in [
        ("06-037-1103", "North Main Street", "#254c46"),
        ("06-037-4010", "North Hollywood", "#717b9b"),
        ("06-037-0016", "Glendora", "#a07a59"),
    ]:
        station = next(row for row in audit["stations"] if row["id"] == identity)
        built = approved_station(station, hourly, audit_folder)
        built.update(name=name, color=color)
        stations.append(built)
    smoke = result["smoke"]
    smoke.pop("monitor", None)
    smoke.pop("series", None)
    smoke["stations"] = stations
    smoke["window"] = {
        "start": "2025-01-04",
        "end": "2025-01-14",
        "referenceYears": audit["referenceYears"],
        "referenceMonths": audit["referenceMonths"],
        "minimumHoursPerDay": 18,
        "referenceSources": audit["sources"],
        "endRule": audit["endRule"],
        "negativePolicy": audit["negativePolicy"],
    }
    smoke["exclusions"] = [
        {"name": "Pasadena", "reason": "All hourly values missing in the checked archives."},
        {"name": "Compton", "reason": "Older records use different instrument definitions."},
    ]
    days = []
    output_folder = OUTPUT.parent / "waves/plumes"
    output_folder.mkdir(parents=True, exist_ok=True)
    for day in plume_audit["days"]:
        if day["status"] != "available":
            days.append({**day, "dataClass": "Historical", "path": None})
            continue
        content = approved_plumes(day, stations)
        starts = [feature["properties"]["analysisStart"] for feature in content["features"]]
        ends = [feature["properties"]["analysisEnd"] for feature in content["features"]]
        period = (
            {"start": min(starts), "end": max(ends)}
            if starts and all(starts) and all(ends)
            else None
        )
        name = day["dateUtc"] + ".json"
        (output_folder / name).write_text(
            json.dumps(content, separators=(",", ":")), encoding="utf-8"
        )
        days.append(
            {
                **day,
                "dataClass": "Historical",
                "path": "/data/waves/plumes/" + name,
                "measurementPeriod": period,
            }
        )
    smoke["plumes"] = {"days": days, "directoryChecks": plume_audit["directoryChecks"]}
    result["rightNowPlaces"] = []
    place_source = sources["sources"]["airnow-places.csv"]
    for place in sources["places"]:
        result["rightNowPlaces"].append(
            {
                key: place[key]
                for key in ("name", "zipcode", "reportingArea", "latitude", "longitude")
            }
            | {
                "sourceUrl": place_source["sourceUrl"],
                "retrievedAt": place_source["retrievedAt"],
                "dataClass": "Historical",
            }
        )
    county = result["ash"]["county"]
    reviewed = json.loads((ROOT / "data/waves_reviewed_evidence.json").read_text(encoding="utf-8"))
    for key in ("title", "measurementPeriod", "publicationDate", "reportDate"):
        county[key] = reviewed["county"][key]
    for row in result["ash"]["followup"]:
        row.update(publicationDate="2026-05-19", measurementPeriod=None)
    result["ash"][
        "zipLink"
    ] = "https://storymaps.arcgis.com/stories/667412ef37ee4392bddb5c90da3480f1?cover=false"
    result["schemaVersion"] = 2
    result["builtAt"] = datetime.now(timezone.utc).isoformat()
    if (
        any(result[key] != value for key, value in unchanged.items())
        or original_grids != result["ash"]["grids"]
    ):
        raise ValueError("Unrelated preview values changed")
    OUTPUT.write_text(
        json.dumps(result, ensure_ascii=False, allow_nan=False, separators=(",", ":")),
        encoding="utf-8",
    )
    print(
        "Updated stations:", [(s["name"], s["missingHours"], s["negativeHours"]) for s in stations]
    )
    print(
        "Exported",
        len(days),
        "NOAA days",
    )


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--audit-only", action="store_true")
    parser.add_argument("--monitor", help="Approved EPA site ID; never selected from plotted peaks")
    parser.add_argument(
        "--approved-update",
        action="store_true",
        help="Build the approved three-station update from cached audit evidence",
    )
    options = parser.parse_args()
    if options.approved_update:
        build_approved_update()
    elif options.audit_only:
        perimeter, provenance = rainfall_sources()
        audit_monitors(perimeter)
    elif options.monitor:
        if options.monitor != "06-037-1103":
            parser.error("The approved primary monitor is North Main Street (06-037-1103)")

        if not (ROOT / "output/three-waves/update-audit/monitor-windows.json").exists():
            parser.error("Reproduce the approved monitor audit before rebuilding")
        build_data(options.monitor)
        build_approved_update()
    else:
        parser.error("Use --audit-only or an approved --monitor ID")
