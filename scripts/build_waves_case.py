import argparse
import base64
import copy
import hashlib
import json
import math
import os
import re
import subprocess
import time
import urllib.parse
import zipfile
import xml.etree.ElementTree as ET
from urllib.error import HTTPError
from datetime import datetime, timedelta, timezone

import numpy as np
import pandas as pd
from PIL import Image
from pyproj import Geod, Transformer
from shapely.geometry import Point, Polygon, mapping, shape
from shapely.ops import transform, unary_union

from build_waves_data import CACHE, ROOT, USGS, download, query_fire_layer

CONFIG = ROOT / "data/waves_cases.json"
PUBLIC = ROOT / "frontend/public"
ANNUAL_ROWS = {}


def scenario_response_shares(basins, steps, classes):
    geod = Geod(ellps="WGS84")
    mapped = []
    for feature in basins["features"]:
        if feature["properties"].get("mapped") and feature["geometry"]:
            area, _ = geod.geometry_area_perimeter(shape(feature["geometry"]))
            if not math.isfinite(area) or area == 0:
                raise ValueError("Mapped basin area is invalid")
            mapped.append((feature["properties"], abs(area)))
    if not mapped:
        return {}

    shares = {}
    for mode, prefix in (("likelihood", "P"), ("volume", "V"), ("combined", "H")):
        if not classes.get(prefix):
            continue
        top_class = classes[prefix][-1]
        values = []
        for step in steps:
            field = f"{prefix}_{step}"
            if any(
                props.get(field) is None or props.get(field + "_LG") not in classes[prefix]
                for props, _ in mapped
            ):
                values = []
                break
            total_area = sum(area for _, area in mapped)
            top_area = sum(area for props, area in mapped if props[field + "_LG"] == top_class)
            percent = 100 * top_area / total_area
            if not math.isfinite(percent) or not 0 <= percent <= 100:
                raise ValueError("Scenario area share is outside 0-100%")
            values.append({"intensity": step, "percent": round(percent, 3)})
        if values:
            shares[mode] = {"topClass": top_class, "steps": values}
    return shares


def save_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + "." + str(os.getpid()) + ".tmp")
    temporary.write_text(
        json.dumps(value, ensure_ascii=False, allow_nan=False, separators=(",", ":")),
        encoding="utf-8",
    )

    for attempt in range(6):
        try:
            temporary.replace(path)
            return
        except PermissionError:
            if attempt == 5:
                raise
            time.sleep(0.1 * (attempt + 1))


def scenario_geometry(collection, kind, steps, classes, bounds=None):
    crs = collection.get("crs", {}).get("properties", {}).get("name")
    if crs != "urn:ogc:def:crs:OGC:1.3:CRS84":
        raise ValueError("Scenario CRS must be verified before conversion")
    features, ids, excluded = [], set(), []
    for feature in collection["features"]:
        geometry = shape(feature["geometry"])
        allowed = (
            ["Polygon", "MultiPolygon"] if kind != "segments" else ["LineString", "MultiLineString"]
        )
        if geometry.geom_type not in allowed or geometry.is_empty:
            raise ValueError("Unexpected assessment geometry")
        west, south, east, north = geometry.bounds
        extent = bounds or [-180, -90, 180, 90]
        if not (
            extent[0] <= west <= east <= extent[2] and extent[1] <= south <= north <= extent[3]
        ) or (west == east and south == north):
            raise ValueError("Scenario coordinates outside the source assessment extent")
        props = {"mapped": geometry.is_valid}
        if kind != "perimeter":
            source = feature["properties"]
            identity = source["SegmentID"]
            if not isinstance(identity, int) or identity in ids:
                raise ValueError("Duplicate or missing source SegmentID")
            ids.add(identity)
            props["SegmentID"] = identity
            for step in steps:
                for prefix in ["P", "V", "H"]:
                    field = f"{prefix}_{step}"
                    value, category = source[field], source[field + "_LG"]
                    if category == "NULL" and value is None:

                        props[field + "_LG_source"] = category
                        category = None
                    if value is not None and (not math.isfinite(value) or value < 0):
                        raise ValueError("Unverified missing or invalid scenario value")
                    if value is not None and prefix == "P" and value > 1:
                        raise ValueError("Likelihood must be a fraction")
                    if value is not None and prefix == "H" and value not in [1, 2, 3]:
                        raise ValueError("Unknown combined-hazard score")
                    if category is not None and category not in classes[prefix]:
                        raise ValueError("Category disagrees with XML legend")
                    props[field], props[field + "_LG"] = value, category
            if not geometry.is_valid:
                excluded.append(identity)
        elif not geometry.is_valid:
            raise ValueError("Invalid archive perimeter")
        features.append({"type": "Feature", "geometry": feature["geometry"], "properties": props})
    return {"type": "FeatureCollection", "features": features}, excluded


def build_rain_scenarios(config):
    expected = config["rainArchive"]
    source_url = "https://www.sciencebase.gov/catalog/item/" + expected["releaseId"]
    release_path, release_receipt = download(
        config["id"] + "-assessment-release.json", source_url + "?format=json"
    )
    release = json.loads(release_path.read_text(encoding="utf-8"))
    sources = [release_receipt]
    files = {}
    for entry in release["files"]:
        name = entry["name"]
        if name not in ["metadata.json", "GeoJSON.zip"] and not name.endswith(".xml"):
            continue
        path, receipt = download(config["id"] + "-assessment-" + name, entry["url"])
        if (
            path.stat().st_size != entry["size"]
            or hashlib.sha256(path.read_bytes()).hexdigest() != receipt["sha256"]
        ):
            raise ValueError("Cached assessment file changed")
        sources.append(receipt)
        files[name] = path
    metadata = json.loads(files["metadata.json"].read_text(encoding="utf-8"))
    dates = {row["type"]: row["dateString"] for row in release["dates"]}
    if config.get("discoverArchive"):
        from historical_identity import fire_name

        if fire_name(metadata["fire"]["name"]) != fire_name(config["name"]):
            raise ValueError("Linked archive fire name differs; review required")
        expected = {
            **expected,
            "ignition": metadata["fire"]["start_date"],
            "assessmentDate": metadata["assessment"]["date"],
            "publicationDate": dates["Publication"],
            "version": metadata["version"]["version"],
            "expectedSteps": metadata["assessment"]["models"]["likelihood"]["parameters"]["I15"],
        }
    if (
        (not config.get("discoverArchive") and metadata["fire"]["name"] + " Fire" != config["name"])
        or metadata["fire"]["start_date"] != expected["ignition"]
        or dates["FireStart"] != expected["ignition"]
        or metadata["assessment"]["date"] != expected["assessmentDate"]
        or dates["Assessment"] != expected["assessmentDate"]
        or dates["Publication"] != expected["publicationDate"]
        or metadata["version"]["version"] != expected["version"]
    ):
        raise ValueError("Pinned assessment identity or dates changed")
    models = metadata["assessment"]["models"]
    steps = models["likelihood"]["parameters"]["I15"]
    if steps != expected["expectedSteps"] or steps != models["volume"]["parameters"]["I15"]:
        raise ValueError("Published rainfall steps changed; review the release")
    source_step_order = list(steps)
    steps = sorted(steps)
    if len(set(steps)) != len(steps):
        raise ValueError("Duplicate published rainfall steps")
    xml = ET.parse(next(path for name, path in files.items() if name.endswith(".xml")))
    attributes = {row.findtext("attrlabl"): row for row in xml.findall(".//attr")}
    classes = {}
    for prefix in ["P", "V", "H"]:
        classes[prefix] = [
            node.text for node in attributes[f"{prefix}_{steps[0]}_LG"].findall(".//edomv")
        ]
        for step in steps:
            definition = attributes[f"{prefix}_{step}"].findtext("attrdef") or ""
            if f"peak 15-minute rainfall intensity of {step} mm/hour" not in definition:
                raise ValueError("Rainfall units or duration unverified")
            categories = [
                node.text for node in attributes[f"{prefix}_{step}_LG"].findall(".//edomv")
            ]
            if categories != classes[prefix]:
                raise ValueError("Scenario legends differ; review before rendering")
    if attributes[f"V_{steps[0]}"].findtext(".//attrunit") != "Cubic meters":
        raise ValueError("Volume units unverified")
    license_text = " ".join(node.text or "" for node in xml.findall(".//useconst"))
    if "CC0 1.0" not in license_text:
        raise ValueError("Assessment reuse terms need review")
    result = {
        "schemaVersion": 1,
        "releaseId": expected["releaseId"],
        "name": config["name"],
        "version": expected["version"],
        "ignition": expected["ignition"],
        "assessmentDate": expected["assessmentDate"],
        "publicationDate": expected["publicationDate"],
        "sourceUrl": source_url,
        "retrievedAt": release_receipt["retrievedAt"],
        "dataClass": "Historical",
        "license": license_text,
        "sources": sources,
        "steps": steps,
        "defaultIntensity": max(steps),
        "durationMinutes": 15,
        "intensityUnit": "mm/hour",
        "volumeUnit": "m3",
        "classes": classes,
        "unmappedBasinIds": [],
        "bounds": [],
    }
    result["processing"] = (
        "Published steps displayed in numeric order, without interpolation. Literal category NULL becomes missing only when its numeric estimate is null; original category retained in *_LG_source. Source geometries are not repaired."
    )
    result["sourceStepOrder"] = source_step_order
    result["featureCounts"] = {}
    if config.get("snapshot"):
        previous = json.loads((PUBLIC / config["snapshot"].lstrip("/")).read_text(encoding="utf-8"))
        result["previousAssessment"] = {
            "ignition": previous["case"]["ignition"],
            "assessmentDate": datetime.fromtimestamp(
                previous["rain"]["record"]["assessment_date"] / 1000, timezone.utc
            )
            .date()
            .isoformat(),
            "sourceUrl": previous["rain"]["sourceUrl"],
        }
    else:
        result["previousAssessment"] = config.get("previousAssessment")
    with zipfile.ZipFile(files["GeoJSON.zip"]) as archive:
        for kind in ["basins", "segments", "perimeter"]:
            collection = json.loads(archive.read(kind + ".geojson"))
            extent = metadata["assessment"]["bbox"]
            bounds = [extent["left"], extent["bottom"], extent["right"], extent["top"]]
            result[kind], excluded = scenario_geometry(collection, kind, steps, classes, bounds)
            result["featureCounts"][kind] = len(collection["features"])
            if kind == "basins":
                result["unmappedBasinIds"] = excluded
            elif excluded:
                raise ValueError("Invalid channel geometry needs review")
    if len(result["basins"]["features"]) != expected.get(
        "expectedBasins", result["featureCounts"]["basins"]
    ) or len(result["segments"]["features"]) != expected.get(
        "expectedSegments", result["featureCounts"]["segments"]
    ):
        raise ValueError("Incomplete assessment geometry")

    extents = []
    for kind in ["basins", "segments", "perimeter"]:
        for feature in result[kind]["features"]:
            extents.append(shape(feature["geometry"]).bounds)
    result["bounds"] = [
        min(box[0] for box in extents),
        min(box[1] for box in extents),
        max(box[2] for box in extents),
        max(box[3] for box in extents),
    ]
    result["responseShares"] = scenario_response_shares(result["basins"], steps, classes)
    output = PUBLIC / "data/waves" / (config["id"].replace(":", "-") + "-rain-scenarios.json")
    if output.exists():
        reviewed = json.loads(output.read_text(encoding="utf-8"))
        for key, value in reviewed.items():
            if key != "responseShares" and result.get(key) != value:
                raise ValueError("Prepared assessment values changed; review required")
        result = {**reviewed, "responseShares": result["responseShares"]}
    save_json(output, result)
    print(
        "Built",
        output.name,
        output.stat().st_size,
        "bytes; unmapped basin IDs",
        result["unmappedBasinIds"],
    )
    return output


def query_case(config, layer, fields="*", geometry=True):
    message = "Assessment identity or complete geometry unavailable"
    payload, receipt = query_fire_layer(
        config["usgsId"],
        layer,
        f"{config['id']}-layer-{layer}.json",
        fields,
        geometry,
        (message, message),
    )
    return payload, {**receipt, "dataClass": "Historical"}


def verify_case(config):
    locations, source = query_case(config, 0, geometry=False)
    if len(locations["features"]) != 1:
        raise ValueError("Ambiguous assessment")
    record = locations["features"][0]["properties"]
    expected = {
        "start_date": int(
            datetime.fromisoformat(config["ignition"]).replace(tzinfo=timezone.utc).timestamp()
            * 1000
        ),
        "assessment_date": int(
            datetime.fromisoformat(config["assessmentDate"])
            .replace(tzinfo=timezone.utc)
            .timestamp()
            * 1000
        ),
    }
    if record["Fire_ID"] != config["usgsId"] or any(
        record[key] != value for key, value in expected.items()
    ):
        raise ValueError("Assessment dates or fire identity changed; review configuration")
    perimeter, perimeter_source = query_case(config, 9)
    for feature in perimeter["features"]:
        props = feature["properties"]
        if props["Fire_ID"] != config["usgsId"] or any(
            props[key] != value for key, value in expected.items()
        ):
            raise ValueError("Perimeter does not match the configured assessment")
    return record, source, perimeter, perimeter_source


def annual_rows(parameter, year, config, daily=False):
    kind = "daily" if daily else "hourly"
    name = f"{kind}_{parameter}_{year}.zip"
    early_key = (config["stateCode"], config.get("countyCode"), kind, parameter, year)
    if early_key in ANNUAL_ROWS:
        return ANNUAL_ROWS[early_key]
    available = config.get("availableFiles")
    if available is not None and name not in available:
        columns = [
            "County Code",
            "Site Num",
            "POC",
            "Method Code",
            "Date Local",
            "Time Local",
            "Sample Measurement",
            "Sample Duration",
            "Observation Count",
            "Observation Percent",
            "Units of Measure",
            "Event Type",
            "Arithmetic Mean",
        ]
        return pd.DataFrame(columns=columns), {
            **config["fileIndexSource"],
            "dataClass": "Observed",
            "status": "unavailable",
            "reason": name + " is absent from the checked EPA file index",
        }
    path, receipt = download(name, "https://aqs.epa.gov/aqsweb/airdata/" + name)
    if hashlib.sha256(path.read_bytes()).hexdigest() != receipt["sha256"]:
        raise ValueError("Cached EPA source checksum changed")
    county = config.get("countyCode")
    subset = (
        CACHE
        / f"{config['stateCode']}-{county if county is not None else 'all'}-{kind}-{parameter}-{year}.csv"
    )
    subset_receipt = subset.with_suffix(".receipt.json")
    if subset.exists() and subset_receipt.exists():
        stored = json.loads(subset_receipt.read_text(encoding="utf-8"))
        if (
            stored["sourceSha256"] == receipt["sha256"]
            and stored["sha256"] == hashlib.sha256(subset.read_bytes()).hexdigest()
        ):
            result = pd.read_csv(subset, low_memory=False)
            if len(ANNUAL_ROWS) >= 12:
                ANNUAL_ROWS.pop(next(iter(ANNUAL_ROWS)))
            ANNUAL_ROWS[early_key] = (result, {**receipt, "dataClass": "Observed"})
            return result, {**receipt, "dataClass": "Observed"}
    rows = []
    columns = [
        "State Code",
        "County Code",
        "Site Num",
        "Parameter Code",
        "POC",
        "Method Code",
        "Units of Measure",
        "Date Local",
    ]
    if daily:
        columns += [
            "Sample Duration",
            "Observation Count",
            "Observation Percent",
            "Event Type",
            "Arithmetic Mean",
        ]
    else:
        columns += [
            "Latitude",
            "Longitude",
            "Datum",
            "Method Name",
            "Time Local",
            "Date GMT",
            "Time GMT",
            "Sample Measurement",
            "Qualifier",
        ]
    with zipfile.ZipFile(path) as archive:
        with archive.open(archive.namelist()[0]) as stream:
            for chunk in pd.read_csv(stream, usecols=columns, chunksize=150000, low_memory=False):
                keep = chunk["State Code"] == config["stateCode"]
                if county is not None:
                    keep &= chunk["County Code"] == county
                county_rows = chunk[keep]
                rows.append(county_rows)
    result = pd.concat(rows, ignore_index=True)
    result.to_csv(subset, index=False)
    save_json(
        subset_receipt,
        {
            "sourceSha256": receipt["sha256"],
            "sha256": hashlib.sha256(subset.read_bytes()).hexdigest(),
        },
    )
    if len(ANNUAL_ROWS) >= 12:
        ANNUAL_ROWS.pop(next(iter(ANNUAL_ROWS)))
    ANNUAL_ROWS[early_key] = (result, {**receipt, "dataClass": "Observed"})
    return result, {**receipt, "dataClass": "Observed"}


def dates(config):
    ignition = datetime.fromisoformat(config["ignition"])
    start = ignition - timedelta(days=config["leadDays"])
    return start, start + timedelta(days=config["capDays"] - 1)


def daily_means(rows, days, minimum):
    values = pd.to_numeric(rows["Sample Measurement"], errors="coerce")
    rows = rows.assign(finite=values.where(np.isfinite(values)))
    grouped = rows.groupby("Date Local")["finite"].agg(["count", "mean"])
    result = []
    for day in days:
        key = day.strftime("%Y-%m-%d")
        count = int(grouped.loc[key, "count"]) if key in grouped.index else 0
        value = float(grouped.loc[key, "mean"]) if count >= minimum else None
        result.append({"date": key, "hours": count, "value": value})
    return result


def confirmation(days, threshold, ignition):
    if threshold is None:
        return None
    run = 0
    for day in days:
        if day["date"] < ignition:
            continue
        if day["value"] is not None and day["value"] <= threshold:
            run += 1
        else:
            run = 0
        if run == 3:
            return day["date"]
    return None


def station_audit(config, perimeter):
    start, cap = dates(config)
    days = pd.date_range(start, cap)
    project = Transformer.from_crs("EPSG:4326", config["projectedCrs"], always_xy=True).transform
    polygon = transform(project, unary_union([shape(f["geometry"]) for f in perimeter["features"]]))
    candidates = []
    for parameter in [88101, 88502]:
        rows, receipt = annual_rows(parameter, start.year, config)
        if start.year != cap.year:
            extra, _ = annual_rows(parameter, cap.year, config)
            rows = pd.concat([rows, extra])
        rows = rows[
            (rows["Date Local"] >= start.date().isoformat())
            & (rows["Date Local"] <= cap.date().isoformat())
        ]
        for (county, site, poc, method), stream in rows.groupby(
            ["County Code", "Site Num", "POC", "Method Code"]
        ):
            if len(stream[["Latitude", "Longitude", "Datum"]].drop_duplicates()) != 1:
                raise ValueError(
                    "Station location changed during the window; review before building"
                )
            first = stream.iloc[0]
            lon, lat = float(first["Longitude"]), float(first["Latitude"])
            if first["Datum"] == "NAD83":
                lon, lat = Transformer.from_crs(4269, 4326, always_xy=True).transform(lon, lat)
            elif first["Datum"] != "WGS84":
                continue
            distance = polygon.distance(transform(project, Point(lon, lat))) / 1000
            if distance > 50:
                continue
            identity = f"{config['stateCode']:02d}-{int(county):03d}-{int(site):04d}"
            if stream[["Date Local", "Time Local"]].duplicated().any():
                raise ValueError("Duplicate hours in " + identity)
            if set(stream["Units of Measure"]) != {"Micrograms/cubic meter (LC)"}:
                raise ValueError("Unverified PM2.5 units")
            offset = timezone(timedelta(hours=config["utcOffsetHours"]))
            for _, row in stream.iterrows():
                local = datetime.fromisoformat(row["Date Local"] + "T" + row["Time Local"]).replace(
                    tzinfo=offset
                )
                gmt = datetime.fromisoformat(row["Date GMT"] + "T" + row["Time GMT"]).replace(
                    tzinfo=timezone.utc
                )
                if local != gmt:
                    raise ValueError("Local standard/GMT timestamp mismatch")
            daily = daily_means(stream, days, config["minimumHoursPerDay"])
            candidates.append(
                {
                    "id": identity,
                    "parameter": parameter,
                    "poc": int(poc),
                    "method": int(method),
                    "methodName": str(first["Method Name"]),
                    "longitude": lon,
                    "latitude": lat,
                    "distanceKm": distance,
                    "dailyMeans": daily,
                    "source": receipt,
                    "missingHours": len(days) * 24 - sum(d["hours"] for d in daily),
                    "rows": stream,
                }
            )
    candidates.sort(key=lambda s: (s["distanceKm"], s["parameter"]))

    sites = []
    for station in candidates:
        if station["id"] not in sites:
            sites.append(station["id"])
        if len(sites) == 5:
            break
    candidates = [s for s in candidates if s["id"] in sites]
    reference_archives = {}
    for station in candidates:
        references = []
        sources = []
        counts = []
        for year in config["referenceYears"]:
            key = (station["parameter"], year)
            if key not in reference_archives:
                reference_archives[key] = annual_rows(
                    station["parameter"], year, config, daily=True
                )
            reference, receipt = reference_archives[key]
            reference = reference[
                (reference["County Code"] == int(station["id"].split("-")[1]))
                & (reference["Site Num"] == int(station["id"].split("-")[-1]))
                & (reference["POC"] == station["poc"])
                & (reference["Method Code"] == station["method"])
                & (reference["Sample Duration"] == "1 HOUR")
                & (reference["Observation Count"] >= config["minimumHoursPerDay"])
                & (reference["Observation Percent"] >= 75)
                & (reference["Units of Measure"] == "Micrograms/cubic meter (LC)")
                & (
                    reference["Event Type"]
                    .fillna("No Events")
                    .isin(["No Events", "Events Included"])
                )
            ]
            reference = reference[
                pd.to_datetime(reference["Date Local"]).dt.month.isin(config["referenceMonths"])
            ]
            if (reference.groupby("Date Local")["Arithmetic Mean"].nunique() > 1).any():
                raise ValueError("Conflicting EPA reference daily means")
            reference = reference.drop_duplicates("Date Local")
            finite = reference["Arithmetic Mean"].to_numpy(dtype=float)
            finite = finite[np.isfinite(finite)]
            references.extend(finite.tolist())
            counts.append(len(finite))
            sources.append(receipt)

        threshold = float(np.quantile(references, 0.9)) if all(counts) else None
        station.update(
            referenceDayCounts=counts,
            referenceSources=sources,
            thresholdUgM3=threshold,
            windowEnd=confirmation(station["dailyMeans"], threshold, config["ignition"]),
        )
    report = []
    for station in candidates:
        report.append({key: value for key, value in station.items() if key != "rows"})
    save_json(ROOT / f"output/three-waves/{config['id'].replace(':', '-')}-audit.json", report)
    return candidates


def build_station(config, audited, end, selected):
    start, _ = dates(config)
    offset = timezone(timedelta(hours=config["utcOffsetHours"]))
    rows = audited["rows"].copy()
    times = [
        datetime.fromisoformat(day + "T" + hour)
        for day, hour in rows[["Date Local", "Time Local"]].itertuples(index=False, name=None)
    ]
    phases = {time.minute * 60 + time.second for time in times}
    if len(phases) != 1:
        raise ValueError(
            "Source hourly timestamp alignment changes; review required, no rounding applied"
        )
    phase = next(iter(phases))
    rows["Time Local"] = [time.strftime("%H:%M:%S") for time in times]
    rows = rows.set_index(["Date Local", "Time Local"])
    series = []
    shift = timedelta(seconds=phase)
    for hour in pd.date_range(
        start + shift,
        datetime.fromisoformat(end) + timedelta(days=1) + shift,
        freq="h",
        inclusive="left",
    ):
        key = (hour.strftime("%Y-%m-%d"), hour.strftime("%H:%M:%S"))
        value, qualifier, reason = None, None, "Missing source hour"
        if key in rows.index:
            row = rows.loc[key]
            reading = float(row["Sample Measurement"])
            qualifier = None if pd.isna(row["Qualifier"]) else str(row["Qualifier"])
            if math.isfinite(reading):
                value = reading
                reason = "Signed negative source reading retained" if reading < 0 else ""
        provenance = {} if config.get("compactReadings") else audited["source"]
        series.append(
            {
                "timestamp": hour.to_pydatetime().replace(tzinfo=offset).isoformat(),
                "value": value,
                "qualifier": qualifier,
                "reason": reason,
                **provenance,
            }
        )
    nonnegative = audited["rows"][audited["rows"]["Sample Measurement"] >= 0]
    _, cap = dates(config)
    sensitivity = confirmation(
        daily_means(nonnegative, pd.date_range(start, cap), config["minimumHoursPerDay"]),
        audited["thresholdUgM3"],
        config["ignition"],
    )
    result = {
        key: value for key, value in audited.items() if key not in ("rows", "source", "dailyMeans")
    }
    result.update(selected)
    if phase:
        result["sampleOffsetSeconds"] = phase
    result.update(audited["source"])
    result.update(
        series=series,
        expectedHours=len(series),
        missingHours=sum(r["value"] is None for r in series),
        negativeHours=sum(r["value"] is not None and r["value"] < 0 for r in series),
        dailyMeans=[
            {**day, **audited["source"]} for day in audited["dailyMeans"] if day["date"] <= end
        ],
        nonnegativeSensitivityEnd=sensitivity,
    )
    return result


def plume_day(day, stations):
    from build_historical_coverage import source_error_status

    compact = day.replace("-", "")
    roots = [
        "https://www.ospo.noaa.gov/pub/Land/HMS/Smoke_Polygons/KML/",
        "https://satepsanone.nesdis.noaa.gov/pub/FIRE/web/HMS/Smoke_Polygons/KML/",
    ]
    source = None
    failures = []
    missing = []

    cached = CACHE / ("hms-legacy-" + compact + ".kml")
    if cached.exists():
        source = json.loads((CACHE / (cached.name + ".source.json")).read_text(encoding="utf-8"))
        path = cached
    else:
        for root in roots:
            url = root + day[:4] + "/" + day[5:7] + "/hms_smoke" + compact + ".kml"
            try:
                path, source = download(
                    "hms-"
                    + ("legacy-" if "satepsanone" in root else "current-")
                    + compact
                    + ".kml",
                    url,
                )
                break
            except (OSError, ValueError) as error:
                if isinstance(error, OSError) and source_error_status(error) == "processing_failed":
                    raise
                failures.append(str(error))
                missing.append(isinstance(error, HTTPError) and error.code in (404, 410))
    if source is None:
        return {
            "dateUtc": day,
            "status": "unavailable" if missing and all(missing) else "failed",
            "reason": "; ".join(failures),
            "path": None,
            "monitorCoverage": {s["id"]: None for s in stations},
            "measurementPeriod": None,
            "sourceUrl": url,
            "retrievedAt": None,
            "attemptedAt": datetime.now(timezone.utc).isoformat(),
            "dataClass": "Historical",
        }
    features = []
    ns = {"k": "http://www.opengis.net/kml/2.2"}
    for placemark in ET.parse(path).getroot().findall(".//k:Placemark", ns):
        description = placemark.findtext("k:description", "", ns)
        match = re.search(r"Density:\s*([A-Za-z]+)", description)
        if not match or match.group(1).lower() not in ("light", "medium", "heavy"):
            raise ValueError("Unverified NOAA density")
        density = match.group(1).lower()
        if density == "light":
            continue
        times = {}
        for label, key in [("Start", "analysisStart"), ("End", "analysisEnd")]:
            found = re.search(label + r" Time:\s*(\d{7})\s+(\d{4})UTC", description)
            times[key] = (
                datetime.strptime("".join(found.groups()), "%Y%j%H%M")
                .replace(tzinfo=timezone.utc)
                .isoformat()
                if found
                else None
            )
        for polygon in placemark.findall(".//k:Polygon", ns):
            rings = []
            for boundary in [
                polygon.find("k:outerBoundaryIs", ns),
                *polygon.findall("k:innerBoundaryIs", ns),
            ]:
                coordinates = boundary.findtext("k:LinearRing/k:coordinates", "", ns)
                rings.append(
                    [tuple(float(v) for v in p.split(",")[:2]) for p in coordinates.split()]
                )
            geometry = Polygon(rings[0], rings[1:])
            if not geometry.is_valid:
                raise ValueError("Invalid NOAA geometry; not repaired automatically")
            features.append(
                {
                    "type": "Feature",
                    "geometry": mapping(geometry),
                    "properties": {"density": density, "dateUtc": day, **times},
                }
            )
    coverage = {}
    for station in stations:
        point = Point(station["longitude"], station["latitude"])
        coverage[station["id"]] = any(shape(f["geometry"]).covers(point) for f in features)
    starts = [f["properties"]["analysisStart"] for f in features]
    ends = [f["properties"]["analysisEnd"] for f in features]
    period = (
        {"start": min(starts), "end": max(ends)} if starts and all(starts) and all(ends) else None
    )
    output = PUBLIC / ("data/waves/plumes/" + day + ".json")
    content = json.loads(json.dumps({"type": "FeatureCollection", "features": features}))

    if output.exists() and json.loads(output.read_text(encoding="utf-8")) != content:
        raise ValueError("Existing frozen NOAA geometry differs; preserve it and review")
    if not output.exists():
        save_json(output, content)
    return {
        "dateUtc": day,
        "status": "available",
        "path": "/data/waves/plumes/" + day + ".json",
        "monitorCoverage": coverage,
        "measurementPeriod": period,
        **source,
        "dataClass": "Historical",
    }


def rain_layers(config, perimeter):
    bounds = unary_union([shape(f["geometry"]) for f in perimeter["features"]]).bounds
    west, south, east, north = bounds
    bounds = [west - 0.005, south - 0.005, east + 0.005, north + 0.005]
    code = """
import { hazardRenderer, hazardClasses } from './src/usgsHazards.ts';
const renderers = {};
for (const layer of [1, 2, 4, 5, 6, 7]) renderers[layer] = hazardRenderer(layer);
console.log(JSON.stringify({renderers, classes: hazardClasses}));
"""
    rendered = subprocess.run(
        ["node", "--import", "tsx", "--input-type=module", "-e", code],
        cwd=ROOT / "frontend",
        check=True,
        capture_output=True,
        text=True,
    )
    display = json.loads(rendered.stdout)
    result = {}
    for mode, layers in {"likelihood": (2, 1), "volume": (6, 7), "combined": (4, 5)}.items():
        for layer in layers:
            features, _ = query_case(
                config, layer, "Fire_ID,start_date,assessment_date,version", False
            )
            for feature in features["features"]:
                props = feature["properties"]
                if (
                    props.get("fire_id", props.get("Fire_ID")) != config["usgsId"]
                    or props["version"] != config["assessmentVersion"]
                ):
                    raise ValueError("Assessment layer identity/version mismatch")
                for field, key in [
                    ("start_date", "ignition"),
                    ("assessment_date", "assessmentDate"),
                ]:
                    if (
                        datetime.fromtimestamp(props[field] / 1000, timezone.utc).date().isoformat()
                        != config[key]
                    ):
                        raise ValueError("Assessment layer date mismatch")
        drawing = []
        for layer in layers:
            drawing.append(
                {
                    "id": layer,
                    "source": {"type": "mapLayer", "mapLayerId": layer},
                    "definitionExpression": "fire_id='" + config["usgsId"] + "'",
                    "drawingInfo": {"renderer": display["renderers"][str(layer)]},
                }
            )
        params = {
            "bbox": ",".join(map(str, bounds)),
            "bboxSR": "4326",
            "imageSR": "3857",
            "size": "1200,1200",
            "format": "png32",
            "transparent": "true",
            "f": "json",
            "dynamicLayers": json.dumps(drawing),
        }
        exported, source = download(
            config["id"] + "-" + mode + "-export.json",
            USGS + "/export?" + urllib.parse.urlencode(params),
        )
        metadata = json.loads(exported.read_text(encoding="utf-8"))
        if "href" not in metadata or metadata["extent"]["spatialReference"]["wkid"] not in (
            3857,
            102100,
        ):
            raise ValueError("Unverified map export")
        image, _ = download(config["id"] + "-" + mode + ".png", metadata["href"])
        with Image.open(image) as png:
            if not png.convert("RGBA").getchannel("A").getbbox():
                raise ValueError("Empty assessment export")
        extent = metadata["extent"]
        to_geo = Transformer.from_crs(3857, 4326, always_xy=True)
        west, south = to_geo.transform(extent["xmin"], extent["ymin"])
        east, north = to_geo.transform(extent["xmax"], extent["ymax"])
        result[mode] = {
            "status": "available",
            **source,
            "dataClass": "Historical",
            "bounds": [west, south, east, north],
            "image": "data:image/png;base64," + base64.b64encode(image.read_bytes()).decode(),
            "classes": display["classes"][mode],
        }
    return result


def build_soil_findings(config):
    definition = config.get("soilFindings")
    if not definition:
        return None
    path, receipt = download(definition["sourceCacheName"], definition["sourceUrl"])
    text = path.read_text(encoding="utf-8")
    for expected in ["two isolated areas", "cadmium and thallium", "arsenic and PAHs"]:
        if expected not in text:
            raise ValueError("County soil findings changed; review before building")
    findings = dict(definition)
    findings.pop("sourceCacheName")
    findings.update(receipt)
    findings["dataClass"] = "Historical"
    return findings


def build_soil_map(config):
    definition = config["soilGrid"]
    settings = json.loads(CONFIG.read_text(encoding="utf-8"))
    report_definition = settings["soilReports"][definition["report"]]
    snapshot_path = PUBLIC / config["snapshot"].lstrip("/")
    snapshot = json.loads(snapshot_path.read_text(encoding="utf-8"))
    params = urllib.parse.urlencode(
        {
            "where": "1=1",
            "outFields": "PageName",
            "returnGeometry": "true",
            "outSR": "4326",
            "f": "geojson",
        }
    )
    path, receipt = download(
        config["id"] + "-soil-grids.geojson", definition["url"] + "/query?" + params
    )
    geometry = json.loads(path.read_text(encoding="utf-8"))
    if (
        geometry.get("exceededTransferLimit")
        or len(geometry.get("features", [])) != definition["count"]
    ):
        raise ValueError("Incomplete soil geometry")
    ids = set()
    for feature in geometry["features"]:
        grid_id = feature["properties"]["PageName"]
        if (
            grid_id in ids
            or feature["geometry"]["type"] != "Polygon"
            or not shape(feature["geometry"]).is_valid
        ):
            raise ValueError("Duplicate or invalid soil grid")
        ids.add(grid_id)
        feature["properties"] = {"PageName": grid_id, "fireId": config["usgsId"]}
        west, south, east, north = shape(feature["geometry"]).bounds
        extent = report_definition["bounds"]
        if not (extent[0] <= west < east <= extent[2] and extent[1] <= south < north <= extent[3]):
            raise ValueError("Soil coordinates differ from the reviewed report extent")
    report = json.loads(
        (CACHE / (report_definition["cacheName"] + ".source.json")).read_text(encoding="utf-8")
    )
    if report["sha256"] != report_definition["sha256"]:
        raise ValueError("Final soil report version changed; recheck transcription")
    series = []
    for entry in definition["series"]:
        values = entry.get("values")
        if entry.get("existingLeadValues"):
            values = {row["id"]: row["value"] for row in snapshot["ash"]["grids"]}
        if not values or any(
            key not in ids or not math.isfinite(value) or value < 0 for key, value in values.items()
        ):
            raise ValueError("Soil result has no verified grid match")
        above = sorted(key for key, value in values.items() if value > entry["thresholdMgKg"])
        if "expectedAbove" in entry and above != sorted(entry["expectedAbove"]):
            raise ValueError("Soil transcription disagrees with the final report")
        series.append(
            {
                "id": entry["id"],
                "name": entry["name"],
                "thresholdMgKg": entry["thresholdMgKg"],
                "sourcePage": entry["sourcePage"],
                "figure": entry["figure"],
                "values": values,
                "fireId": config["usgsId"],
                "measurementPeriod": report_definition["measurementPeriod"],
                "publicationDate": report_definition["publicationDate"],
                **report,
                "dataClass": "Historical",
            }
        )
    output = "/data/waves/" + config["id"] + "-soil-grids.geojson"
    save_json(PUBLIC / output.lstrip("/"), geometry)
    geometry_metadata = {
        "status": "available",
        "reason": "Reference sampling cells, not contamination boundaries or property results.",
        "path": output,
        "count": len(ids),
        "itemId": definition["itemId"],
        "termsUrl": "https://egis-lacounty.hub.arcgis.com/pages/terms-of-use",
        **receipt,
        "dataClass": "Historical",
    }
    save_json(
        PUBLIC / ("data/waves/" + config["id"] + "-soil.json"),
        {"fireId": config["usgsId"], "geometry": geometry_metadata, "mapSeries": series},
    )
    print(
        config["id"],
        "soil polygons",
        len(ids),
        "verified results",
        [len(row["values"]) for row in series],
    )


def build_case(settings, config, audited, record, source, perimeter, perimeter_source):
    shared = json.loads((ROOT / settings["sharedEvidence"]).read_text(encoding="utf-8"))
    start, cap = dates(config)
    selected = []
    for definition in config["stations"]:
        matches = [
            s
            for s in audited
            if all(s[key] == definition[key] for key in ("id", "parameter", "poc", "method"))
        ]
        if len(matches) != 1:
            raise ValueError("Approved station stream is not uniquely verified")
        selected.append(matches[0])

    end = (
        config.get("displayEnd")
        or (selected[0]["windowEnd"] if selected else None)
        or cap.date().isoformat()
    )
    if not (start.date().isoformat() <= end <= cap.date().isoformat()):
        raise ValueError("Display window is outside the configured search period")
    stations = []
    for definition, station in zip(config["stations"], selected):
        stations.append(build_station(config, station, end, definition))
    days = []
    if selected:
        for day in pd.date_range(start, end):
            days.append(plume_day(day.date().isoformat(), stations))
    reviewed = json.loads((ROOT / settings["reviewedEvidence"]).read_text(encoding="utf-8"))
    health = []
    for finding in reviewed["health"]:
        if finding["sourceUrl"] in config.get("healthSourceUrls", []):
            health.append(copy.deepcopy(finding))
    smoke = {
        "status": "available" if selected else "unavailable",
        **(selected[0]["source"] if selected else source),
        "stations": stations,
        "timezone": config["timezone"],
        "reason": (
            "" if selected else "Smoke replay unavailable - monitor selection awaits confirmation."
        ),
        "window": {
            "start": start.date().isoformat(),
            "end": end,
            "referenceYears": config["referenceYears"],
            "referenceMonths": config["referenceMonths"],
            "minimumHoursPerDay": config["minimumHoursPerDay"],
            "referenceSources": selected[0]["referenceSources"] if selected else [],
        },
        "plumes": {"days": days},
        "exclusions": [],
        "health": health,
        "aqiReference": copy.deepcopy(shared["aqiReference"]),
    }
    soil_receipt = json.loads(
        (CACHE / (config["soilCacheName"] + ".source.json")).read_text(encoding="utf-8")
    )
    if soil_receipt["sourceUrl"] != config["soilSource"]:
        raise ValueError("Soil publication link mismatch")
    findings = build_soil_findings(config)
    data = {
        "schemaVersion": 2,
        "builtAt": datetime.now(timezone.utc).isoformat(),
        "case": {
            "name": config["name"],
            "county": config["county"],
            "ignition": config["ignition"],
            **source,
        },
        "perimeter": {"status": "available", "value": perimeter, **perimeter_source},
        "smoke": smoke,
        "ash": {
            "county": None,
            "grids": [],
            "reason": config["soilReason"],
            "followup": [],
            "followupReason": config["followupReason"],
            "geometry": {
                "status": "unavailable",
                "reason": "Unavailable - standalone sampling-grid geometry not verified.",
                **soil_receipt,
                "dataClass": "Historical",
            },
            "zipLink": config["soilZipLink"],
        },
        "rain": {"record": record, "layers": rain_layers(config, perimeter), **source},
        "rightNowPlaces": shared["rightNowPlaces"],
    }
    if findings:
        data["ash"]["findings"] = findings
    save_json(PUBLIC / config["snapshot"].lstrip("/"), data)
    if config.get("soilGrid"):
        build_soil_map(config)
    write_catalog(settings)
    print(
        "Built",
        config["snapshot"],
        "window",
        start.date(),
        "to",
        end,
        "without changing the original replay",
    )


def plume_fire_coverage(snapshot):
    perimeter = unary_union(
        [shape(feature["geometry"]) for feature in snapshot["perimeter"]["value"]["features"]]
    )
    coverage = {}
    for day in snapshot["smoke"]["plumes"]["days"]:
        coverage[day["dateUtc"]] = None
        if day["status"] != "available" or not day["path"]:
            continue
        path = PUBLIC / day["path"].lstrip("/")
        if not path.exists():
            continue
        polygons = json.loads(path.read_text(encoding="utf-8"))
        if polygons.get("type") != "FeatureCollection":
            raise ValueError("NOAA geometry unavailable")
        coverage[day["dateUtc"]] = False
        for feature in polygons["features"]:
            plume = shape(feature["geometry"])
            if plume.intersects(perimeter):
                coverage[day["dateUtc"]] = True
                break
    return coverage


def write_catalog(settings):
    shared = json.loads((ROOT / settings["sharedEvidence"]).read_text(encoding="utf-8"))
    index = {"cases": [], "rightNowPlaces": shared["rightNowPlaces"]}
    ids = set()
    for case in settings["cases"]:
        if case["id"] in ids:
            raise ValueError("Duplicate replay ID")
        ids.add(case["id"])
        entry = {
            key: copy.deepcopy(case[key])
            for key in (
                "id",
                "usgsId",
                "name",
                "county",
                "ignition",
                "snapshot",
                "comparisonObservationId",
                "coordinatedRain",
                "goes",
                "hrrr",
                "regionalHrrr",
            )
            if key in case
        }
        if case.get("soilGrid"):
            entry["soilMap"] = "/data/waves/" + case["id"] + "-soil.json"
        if case.get("rainArchive"):
            release = case["rainArchive"]
            entry["rainScenarios"] = {
                "url": "/data/waves/" + case["id"] + "-rain-scenarios.json",
                "name": case["name"],
                "releaseId": release["releaseId"],
                "ignition": release["ignition"],
                "assessmentDate": release["assessmentDate"],
                "publicationDate": release["publicationDate"],
                "version": release["version"],
            }
        elif case.get("rainAssessment"):
            entry["rainScenarios"] = copy.deepcopy(case["rainAssessment"])
        snapshot_path = PUBLIC / case["snapshot"].lstrip("/")
        if snapshot_path.exists():
            snapshot = json.loads(snapshot_path.read_text(encoding="utf-8"))
            entry["plumeCoverage"] = plume_fire_coverage(snapshot)
        index["cases"].append(entry)
    save_json(PUBLIC / "data/waves-cases.json", index)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--case")
    parser.add_argument("--catalog-only", action="store_true")
    parser.add_argument("--audit", action="store_true")
    parser.add_argument("--soil-only", action="store_true")
    parser.add_argument("--rain-only", action="store_true")
    parser.add_argument("--hrrr-only", action="store_true")
    args = parser.parse_args()
    settings = json.loads(CONFIG.read_text(encoding="utf-8"))
    if args.catalog_only:
        write_catalog(settings)
        return
    if not args.case:
        parser.error("Choose a configured --case or --catalog-only")
    matches = [case for case in settings["cases"] if case["id"] == args.case]
    if len(matches) != 1:
        parser.error("Choose one uniquely configured case")
    config = matches[0]
    if args.hrrr_only:
        from build_hrrr_smoke import build_hrrr

        build_hrrr(config, audit_only=args.audit)
        if not args.audit:
            write_catalog(settings)
        return
    if args.rain_only:
        if not config.get("rainArchive"):
            parser.error("No pinned rainfall archive for this case")
        build_rain_scenarios(config)
        write_catalog(settings)
        return
    if args.soil_only:
        build_soil_map(config)
        write_catalog(settings)
        return
    if config.get("preserveSnapshot"):
        parser.error(
            "This entry preserves an approved snapshot; use its documented original builder"
        )
    record, source, perimeter, perimeter_source = verify_case(config)
    stations = station_audit(config, perimeter)
    for station in stations:
        print(
            station["id"],
            station["parameter"],
            round(station["distanceKm"], 2),
            "km; missing in cap",
            station["missingHours"],
            "reference days",
            station["referenceDayCounts"],
            "threshold",
            station["thresholdUgM3"],
            "end",
            station["windowEnd"],
            flush=True,
        )
    if not args.audit:
        build_case(settings, config, stations, record, source, perimeter, perimeter_source)


if __name__ == "__main__":
    main()
