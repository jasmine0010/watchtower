import argparse
import json
import re
import time
import zipfile
import xml.etree.ElementTree as ET
from datetime import datetime, timedelta, timezone
from urllib.parse import urlencode

from pyproj import CRS
from shapely.geometry import shape, Point
from shapely.ops import unary_union
from shapely.errors import GEOSException

from build_waves_data import ROOT, download
from build_historical_coverage import save_json

PUBLIC = ROOT / "frontend/public"

EPA = "https://aqs.epa.gov/aqsweb/airdata/download_files.html"
EPA_INDEX = None
REVIEWED_CASES = None
HMS_INDEX = None
PLUME_DAYS = {}
STATION_NAMES = None


def reviewed_snapshot(record):
    global REVIEWED_CASES
    if REVIEWED_CASES is None:
        settings = json.loads((PUBLIC / "data/waves-cases.json").read_text(encoding="utf-8"))
        REVIEWED_CASES = {}
        for case in settings["cases"]:
            if case["id"] in REVIEWED_CASES:
                raise ValueError("Duplicate reviewed case identity")
            REVIEWED_CASES[case["id"]] = case
    case = REVIEWED_CASES.get(record.get("replayId"))
    if case is None:
        return None
    return json.loads((PUBLIC / case["snapshot"].lstrip("/")).read_text(encoding="utf-8"))


def epa_files():
    global EPA_INDEX
    if EPA_INDEX is None:
        path, receipt = download("epa-file-index.html", EPA)
        names = set(
            re.findall(r"(?:hourly|daily)_\d+_\d{4}\.zip", path.read_text(encoding="utf-8"))
        )
        EPA_INDEX = (names, receipt)
    return EPA_INDEX


def hms_years():
    global HMS_INDEX
    if HMS_INDEX is None:
        years, receipts = set(), []
        roots = [
            "https://www.ospo.noaa.gov/pub/Land/HMS/Smoke_Polygons/KML/",
            "https://satepsanone.nesdis.noaa.gov/pub/FIRE/web/HMS/Smoke_Polygons/KML/",
        ]
        for index, root in enumerate(roots):
            name = "hms-current-directory.html" if index == 0 else "hms-legacy-directory.html"
            path, receipt = download(name, root)
            listed = re.findall(r'href="(20\d{2})/"', path.read_text(encoding="utf-8"))
            if not listed:
                raise ValueError("NOAA year directory format could not be verified")
            years.update(int(year) for year in listed)
            receipts.append(receipt)
        HMS_INDEX = (years, receipts)
    return HMS_INDEX


def checked_fire_date(record):
    if record.get("ignition"):
        return record
    days = set()
    for source in record["sources"]:
        if source.get("ignition"):
            days.add(source["ignition"])
    if len(days) != 1:
        return None
    result = record.copy()
    result["ignition"] = days.pop()
    return result


def load_evidence(record):
    path = PUBLIC / record["evidenceUrl"].lstrip("/")
    if not path.exists():
        return {
            "schemaVersion": 1,
            "fireId": record["id"],
            "checks": {},
            "smoke": {
                "status": "not_checked",
                "reason": "EPA and NOAA records have not been checked.",
            },
        }
    data = json.loads(path.read_text(encoding="utf-8"))
    if data["fireId"] != record["id"]:
        raise ValueError("Evidence belongs to another fire")
    return data


def check_smoke(record):
    reviewed = reviewed_snapshot(record)
    existing = load_evidence(record)
    if reviewed or existing.get("smoke", {}).get("stations"):
        return {"status": "available", "reason": "Existing verified EPA values retained unchanged"}
    dated = checked_fire_date(record)
    if dated is None:
        return date_scope_failure(record)
    geometry, perimeter_source, blocked = smoke_boundary(dated)
    if blocked:
        return blocked
    needed, receipt = epa_window_sources(dated)
    if not needed:
        return {
            "status": "coverage_limited",
            "reason": "Checked EPA index has no hourly archive for the requested years",
            "source": receipt,
        }
    smoke = build_smoke(dated, geometry, include_plumes=False)
    if existing.get("smoke", {}).get("plumes"):
        smoke["plumes"] = existing["smoke"]["plumes"]
    existing["smoke"] = smoke
    expose_checked_plumes(smoke)
    existing["perimeter"] = {**perimeter_source, "value": geometry}
    existing["checks"]["smoke"] = {"status": smoke["status"], "reason": smoke["reason"]}
    save_evidence(PUBLIC / record["evidenceUrl"].lstrip("/"), existing, "smoke")
    status = "available" if smoke["epaStatus"] == "available" else "no_match"
    return {
        "status": status,
        "reason": smoke["reason"],
        "preparedUrl": record["evidenceUrl"],
        "scope": smoke_scope(
            record,
            perimeter_source,
            {"window": smoke["window"], "stations": smoke["stations"]},
            "nearby ambient monitors; not fire-attributed exposure",
        ),
    }


def date_scope_failure(record):
    return {
        "status": "metadata_limited",
        "reason": "Linked official metadata supplies no single exact ignition day",
        "scope": {"fireId": record["id"], "blockedBy": "date"},
    }


def smoke_boundary(record):
    try:
        geometry, source = evidence_perimeter(record)
    except (ValueError, GEOSException) as error:
        return (
            None,
            None,
            {
                "status": "quality_failed",
                "reason": str(error),
                "scope": {"fireId": record["id"], "blockedBy": "boundary"},
            },
        )
    if geometry is None:
        return (
            None,
            source,
            {
                "status": "match_unresolved",
                "reason": source["reason"],
                "scope": {"fireId": record["id"], "blockedBy": "boundary"},
            },
        )
    return geometry, source, None


def evidence_perimeter(record):
    try:
        return perimeter_for(record)
    except (ValueError, GEOSException) as error:
        if not isinstance(error, GEOSException) and not str(error).startswith(
            "Invalid source perimeter"
        ):
            raise
        policy = json.loads(
            (ROOT / "data/historical_coverage_sources.json").read_text(encoding="utf-8")
        )["evidenceBoundaryPolicy"]
        if not policy["useVerifiedMtbsIfPreferredInvalid"] or not record.get("mtbs"):
            raise
        geometry, receipt = perimeter_for({"id": record["id"], "mtbs": record["mtbs"]})
        if geometry is None:
            raise ValueError("Linked MTBS boundary unavailable; no substitute selected") from error
        previous = load_evidence(record).get("perimeter", {})
        if previous.get("value"):
            if previous["value"] != geometry:
                raise ValueError(
                    "Invalid preferred boundary; retained boundary evidence cannot be replaced"
                ) from error
            return geometry, {key: value for key, value in previous.items() if key != "value"}
        receipt = {
            **receipt,
            "boundaryChoice": {
                "chosen": "MTBS",
                "mapId": record["mtbs"]["map_id"],
                "rejected": [
                    {
                        "source": record.get("source"),
                        "sourceUrl": record.get("boundaryUrl"),
                        "reason": str(error),
                    }
                ],
                "policy": policy,
            },
        }
        return geometry, receipt


def smoke_scope(record, boundary, smoke, relationship):
    sources = set()
    periods = []
    for station in smoke.get("stations", []):
        if station.get("sourceUrl"):
            sources.add(station["sourceUrl"])
        period = monitor_period(station)
        if period:
            periods.append(period)
        for reading in station.get("series", []):
            if reading.get("sourceUrl"):
                sources.add(reading["sourceUrl"])
    for day in smoke.get("plumes", {}).get("days", []):
        if day.get("sourceUrl"):
            sources.add(day["sourceUrl"])
        if day.get("measurementPeriod"):
            periods.append(day["measurementPeriod"])
    return {
        "fireId": record["id"],
        "boundarySource": boundary,
        "spatialRelationship": relationship,
        "analysisWindow": smoke.get("window"),
        "measurementPeriod": periods or None,
        "periodStatus": "source_supplied" if periods else "not_supplied",
        "sourceUrls": sorted(sources),
    }


def monitor_period(station):
    if station.get("measurementPeriod"):
        return station["measurementPeriod"]
    timestamps = []
    for reading in station.get("series", []):
        if reading.get("value") is not None and reading.get("timestamp"):
            timestamps.append(reading["timestamp"])
    if not timestamps:
        return None
    return {
        "stationId": station["id"],
        "start": min(timestamps),
        "end": max(timestamps),
        "basis": "first and last supplied hourly measurements; intervening gaps remain missing",
    }


def epa_window_sources(record):
    names, receipt = epa_files()
    start = datetime.fromisoformat(record["ignition"]) - timedelta(days=3)
    end = start + timedelta(days=59)
    needed = []
    for year in range(start.year, end.year + 1):
        for parameter in (88101, 88502):
            name = f"hourly_{parameter}_{year}.zip"
            if name in names:
                needed.append(name)
    return needed, receipt


def build_hms_days(record, evidence, geometry):
    import pandas as pd

    smoke = evidence.get("smoke", {})
    start = datetime.fromisoformat(record["ignition"]) - timedelta(days=3)
    end = smoke.get("window", {}).get("end", (start + timedelta(days=59)).date().isoformat())
    stations = smoke.get("stations", [])
    checked_days = {}
    for day in smoke.get("plumes", {}).get("days", []):
        if day["status"] == "available" and day.get("path"):
            checked_days[day["dateUtc"]] = day
    polygon = unary_union([shape(feature["geometry"]) for feature in geometry["features"]])
    days = []
    for date in pd.date_range(start, end):
        date_key = date.date().isoformat()
        previous = checked_days.get(date_key)
        if previous and all(
            station["id"] in previous.get("monitorCoverage", {}) for station in stations
        ):
            days.append(previous)
            continue
        day = checked_plume_day(date_key, stations)
        if day.get("path") and day["status"] == "available":
            data = json.loads((PUBLIC / day["path"].lstrip("/")).read_text(encoding="utf-8"))
            day["sourcePolygonCount"] = len(data["features"])
            day["firePolygonCount"] = 0
            for feature in data["features"]:
                if shape(feature["geometry"]).intersects(polygon):
                    day["firePolygonCount"] += 1
        days.append(day)
    return days, {"start": start.date().isoformat(), "end": end}


def check_hms(record):
    if reviewed_snapshot(record):
        return {"status": "available", "reason": "Reviewed NOAA replay retained unchanged"}
    dated = checked_fire_date(record)
    if dated is None:
        return date_scope_failure(record)
    geometry, receipt, blocked = smoke_boundary(dated)
    if blocked:
        return blocked
    years, sources = hms_years()
    start = datetime.fromisoformat(dated["ignition"]) - timedelta(days=3)
    end = start + timedelta(days=59)
    if not years.intersection(range(start.year, end.year + 1)):
        return {
            "status": "coverage_limited",
            "reason": "Neither checked NOAA directory lists the requested years",
            "sources": sources,
        }
    evidence = load_evidence(record)
    days, window = build_hms_days(dated, evidence, geometry)
    smoke = evidence.setdefault("smoke", {"status": "unavailable", "stations": []})
    smoke.setdefault("checkedAt", datetime.now(timezone.utc).isoformat())
    smoke["plumes"] = {"days": days}
    smoke.setdefault("window", window)
    expose_checked_plumes(smoke)
    evidence["perimeter"] = {**receipt, "value": geometry}
    from build_waves_case import plume_fire_coverage

    evidence["plumeCoverage"] = plume_fire_coverage(evidence)
    states = {day["status"] for day in days}
    status = "available" if "available" in states else "no_match"
    if states & {"failed", "access_failed", "quality_failed"}:
        status = "access_failed" if "quality_failed" not in states else "quality_failed"
    if "processing_failed" in states:
        status = "processing_failed"
    reason = "Independent NOAA daily-file checks completed"
    if status == "processing_failed":
        reason = "A local NOAA processing step failed; successful days remain available"
    elif status == "quality_failed":
        reason = "A NOAA daily file failed source validation; successful days remain available"
    elif status == "access_failed":
        reason = "A NOAA daily file could not be retrieved; successful days remain available"
    result = {"status": status, "reason": reason, "dayStatuses": {}}
    for day in days:
        result["dayStatuses"][day["status"]] = result["dayStatuses"].get(day["status"], 0) + 1
    result["scope"] = smoke_scope(
        record,
        receipt,
        {"window": window, "plumes": {"days": days}},
        "medium/heavy polygons intersecting the existing fire footprint",
    )
    evidence["checks"]["hms"] = result
    save_evidence(PUBLIC / record["evidenceUrl"].lstrip("/"), evidence, "hms")
    return result


def expose_checked_plumes(smoke):
    days = smoke.get("plumes", {}).get("days", [])
    if not any(day["status"] == "available" for day in days):
        return
    if not smoke.get("stations"):
        smoke.setdefault("epaStatus", "unavailable")
        smoke.setdefault(
            "reason", "EPA measurements are not available; see the recorded EPA check."
        )
        if smoke.get("status") == "not_checked":
            smoke["reason"] = (
                "EPA measurements have not been verified; NOAA daily checks are shown separately."
            )
    reference = json.loads((ROOT / "data/waves_reference.json").read_text(encoding="utf-8"))
    smoke.setdefault("aqiReference", reference["aqiReference"])
    smoke.setdefault("stations", [])
    smoke.setdefault("health", [])
    smoke.setdefault("exclusions", [])
    smoke.setdefault("timezone", "America/Los_Angeles")
    smoke["status"] = "available"


def check_source(record, source):
    from build_historical_coverage import verify_catalog_record, load_scope

    verify_catalog_record(record)
    scope = load_scope()
    if record["id"] not in scope["eligibleFireIds"]:
        return {
            "status": "excluded_by_scope",
            "reason": "Archived outside the current California MTBS wildfire scope",
            "scope": {"fireId": record["id"], "eligible": False},
        }
    result = dispatch_source(record, source)
    scope = result.setdefault("scope", {})
    scope.setdefault("fireId", record["id"])
    scope["catalogIdentityVerified"] = True
    publish_check(record, source, result)
    return result


def publish_check(record, source, result):
    if result["status"] in ("pending", "excluded_by_scope"):
        return
    evidence = load_evidence(record)
    product = "context" if source == "slope" else source
    evidence.setdefault("checks", {})[product] = result
    save_evidence(PUBLIC / record["evidenceUrl"].lstrip("/"), evidence, "check:" + product)


def publish_completed_checks(connection, records):
    for record in records:
        evidence = load_evidence(record)
        changed = False
        rows = connection.execute(
            "SELECT source,status,last_result FROM jobs WHERE fire=?", (record["id"],)
        )
        for row in rows:
            if row["status"] in ("pending", "excluded_by_scope"):
                continue
            product = "context" if row["source"] == "slope" else row["source"]
            result = json.loads(row["last_result"])
            if evidence.setdefault("checks", {}).get(product) != result:
                evidence["checks"][product] = result
                changed = True
        if changed:
            save_evidence(PUBLIC / record["evidenceUrl"].lstrip("/"), evidence, "checks")


def dispatch_source(record, source):
    if source == "smoke":
        return check_smoke(record)
    if source == "hms":
        return check_hms(record)
    if source in ("rain", "thresholds", "travel"):
        return check_assessment_source(record, source)
    if source in ("observations", "measured_rain", "unresolved_rain"):
        from build_historical_observations import check_inventory

        return check_inventory(record, source)
    if source in ("damage", "water", "power"):
        from build_recovery_data import check_recovery

        return check_recovery(record, source)
    if source in ("health", "soil", "soil_followup"):
        from build_recovery_data import check_limited

        return check_limited(record, source)
    if source in ("severity", "slope", "imagery", "dnbr", "case_severity"):
        from build_historical_rasters import check_ground

        return check_ground(record, source)
    if source == "goes":
        return check_goes(record)
    if source == "hrrr":
        return check_hrrr(record)
    return {
        "status": "pending",
        "reason": "Source adapter migration is pending.",
        "nextAction": "Complete this source adapter before running its queue",
    }


def check_assessment_source(record, source):
    from build_historical_assessments import check_assessment

    checked = check_assessment(record, source)
    output = PUBLIC / record["evidenceUrl"].lstrip("/")
    if not output.exists() and checked["status"] != "available":
        return checked
    evidence = load_evidence(record)
    evidence["checks"][source] = checked
    if source == "rain" and checked.get("preparedUrl"):
        previous = evidence.get("rainUrl")
        if previous and previous != checked["preparedUrl"]:
            raise ValueError("Previously reviewed assessment link would change")
        evidence["rainUrl"] = checked["preparedUrl"]
    save_evidence(output, evidence, source)
    return checked


def check_goes(record):
    from build_historical_rasters import goes_years

    reviewed_snapshot(record)
    case = REVIEWED_CASES.get(record.get("replayId"), {})
    if case.get("goes"):
        manifest = PUBLIC / case["goes"]["manifest"].lstrip("/")
        data = json.loads(manifest.read_text(encoding="utf-8"))
        if data["caseId"] != case["id"]:
            raise ValueError("Reviewed satellite manifest belongs to another case")
        return {
            "status": "available",
            "reason": "Existing verified satellite replay retained unchanged",
            "preparedUrl": case["goes"]["manifest"],
        }
    dated = checked_fire_date(record)
    if dated is None:
        return {
            "status": "metadata_limited",
            "reason": "Linked official metadata supplies no single exact ignition day",
        }
    years, receipt = goes_years()
    if int(dated["ignition"][:4]) not in years:
        return {
            "status": "coverage_limited",
            "reason": "Checked GOES-18 product index does not list this year",
            "source": receipt,
        }
    return check_prepared_product(dated, "goes")


def check_hrrr(record):
    dated = checked_fire_date(record)
    if dated is None:
        return {
            "status": "metadata_limited",
            "reason": "No exact ignition day is recorded for this fire.",
        }
    if not 2021 <= int(dated["ignition"][:4]) <= 2025:
        return {
            "status": "coverage_limited",
            "reason": "Modeled smoke is available here for 2021 through 2025.",
        }
    reviewed_snapshot(record)
    case = REVIEWED_CASES.get(record.get("replayId"), {})
    product = case.get("hrrr") or case.get("regionalHrrr")
    if product:
        evidence = load_evidence(record)
        evidence["hrrr"] = {
            **product,
            "caseId": record["id"],
            "sourceCaseId": product.get("sourceCaseId", case["id"]),
            "status": "available",
        }
        evidence["checks"]["hrrr"] = {
            "status": "available",
            "reason": "Reviewed modeled smoke replay.",
        }
        save_evidence(PUBLIC / record["evidenceUrl"].lstrip("/"), evidence, "hrrr")
        return evidence["checks"]["hrrr"]
    return check_prepared_product(dated, "hrrr")


def hrrr_geometry(record):
    saved = load_evidence(record).get("perimeter", {}).get("value")
    if saved:
        return saved
    if record.get("boundaryUrl"):
        name = record["id"].replace(":", "-") + "-perimeter.json"
        path, _ = download(name, record["boundaryUrl"])
        data = json.loads(path.read_text(encoding="utf-8"))
        features = data.get("features", [])
        identifier = record.get("boundaryId", record["sourceId"])
        if (
            not features
            or data.get("exceededTransferLimit")
            or any(
                feature.get("properties", {}).get("GlobalID") != identifier for feature in features
            )
        ):
            raise ValueError("Fire boundary identity could not be verified")
        coordinate_crs = CRS.from_user_input(
            data.get("crs", {}).get("properties", {}).get("name", "OGC:CRS84")
        )
        if not coordinate_crs.equals(CRS.from_epsg(4326), ignore_axis_order=True):
            raise ValueError("Fire boundary is not longitude/latitude")
        return data
    geometry, _ = perimeter_for(record)
    if geometry is None:
        raise ValueError("No mapped fire boundary is available for modeled smoke")
    return geometry


def check_prepared_product(record, product):
    path = PUBLIC / record["evidenceUrl"].lstrip("/")
    existing = json.loads(path.read_text(encoding="utf-8")) if path.exists() else {}
    if existing and existing.get("fireId") != record["id"]:
        raise ValueError("Prepared evidence belongs to another fire")
    previous = existing.get("checks", {}).get(product, {})
    retained = retained_coverage_result(existing, product, previous)
    if retained:
        return {**retained, "fireId": record["id"], "preparedUrl": record["evidenceUrl"]}
    if previous.get("status") == "available":
        return {
            "status": "available",
            "fireId": record["id"],
            "preparedUrl": record["evidenceUrl"],
            "reason": "Existing verified export retained unchanged",
        }
    output = prepare_mapped_product(record, product)
    data = json.loads(output.read_text(encoding="utf-8"))
    check = data["checks"][product]
    states = {
        "available": "available",
        "unavailable": "coverage_limited",
        "not_checked": "pending",
        "not_processed": "pending",
        "access_failed": "access_failed",
        "quality_failed": "quality_failed",
        "match_unresolved": "match_unresolved",
        "metadata_limited": "metadata_limited",
        "coverage_limited": "coverage_limited",
        "processing_failed": "processing_failed",
    }
    return {
        **check,
        "status": states[check["status"]],
        "fireId": record["id"],
        "preparedUrl": record["evidenceUrl"],
    }


def retained_coverage_result(evidence, product, previous):

    checked = evidence.get(product, {})
    if product != "goes" or previous.get("status") != "processing_failed":
        return None
    if checked.get("status") != "coverage_limited" or checked.get("reason") != previous.get(
        "reason"
    ):
        return None
    slots = checked.get("slots", [])
    if len(slots) != 18 or len({row.get("slot") for row in slots}) != 18:
        return None
    for row in slots:
        if row.get("failureStatus") != "coverage_limited":
            return None
        if "No native pixel center lies inside the verified perimeter" not in row.get("reason", ""):
            return None
    return checked


def find_fire(identifier):
    from build_historical_coverage import load_scope, verify_catalog_record

    index = json.loads((PUBLIC / "data/historical-fires/index.json").read_text(encoding="utf-8"))
    target = index["aliases"].get(identifier)
    year = target["year"] if target else int(identifier.split(":")[1])
    identifier = target["id"] if target else identifier
    rows = json.loads((PUBLIC / f"data/historical-fires/{year}.json").read_text(encoding="utf-8"))[
        "records"
    ]
    matches = [row for row in rows if row["id"] == identifier]
    if len(matches) != 1:
        raise ValueError("Fire identity is not uniquely present in the catalog")
    verify_catalog_record(matches[0])
    if identifier not in load_scope()["eligibleFireIds"]:
        raise ValueError("This fire is archived outside the current California MTBS scope")
    return matches[0]


def perimeter_for(record):
    if record.get("boundaryUrl"):
        url = record["boundaryUrl"]
        field, identifier = "GlobalID", record.get("boundaryId", record["sourceId"])
    elif record.get("mtbs"):
        row = record["mtbs"]
        url = "https://edcintl.cr.usgs.gov/geoserver/wfs?" + urlencode(
            {
                "service": "WFS",
                "version": "2.0.0",
                "request": "GetFeature",
                "typeNames": "mtbs:fire_polygons",
                "outputFormat": "application/json",
                "srsName": "EPSG:4326",
                "CQL_FILTER": f"map_id={row['map_id']}",
            }
        )
        field, identifier = "map_id", row["map_id"]
    elif record.get("assessment"):
        identifier = record["assessment"]["Fire_ID"]
        field = "Fire_ID"
        url = (
            "https://earthquake.usgs.gov/arcgis/rest/services/ls/pwfdf/MapServer/9/query?"
            + urlencode(
                {
                    "f": "geojson",
                    "where": "Fire_ID='" + identifier + "'",
                    "outFields": "Fire_ID",
                    "returnGeometry": "true",
                    "outSR": 4326,
                }
            )
        )
    else:
        return None, {
            "status": "not_checked",
            "reason": "No verified fire perimeter is linked; an assessment extent is not substituted.",
        }
    name = record["id"].replace(":", "-")
    path, receipt = download(name + "-perimeter.json", url)
    data = json.loads(path.read_text(encoding="utf-8"))
    features = data.get("features", [])
    if (
        not features
        or data.get("exceededTransferLimit")
        or any(f["properties"].get(field) != identifier for f in features)
    ):
        raise ValueError("Exact perimeter identity or complete response could not be verified")
    coordinate_crs = CRS.from_user_input(
        data.get("crs", {}).get("properties", {}).get("name", "OGC:CRS84")
    )
    if not coordinate_crs.equals(CRS.from_epsg(4326), ignore_axis_order=True):
        raise ValueError("Perimeter is not verified longitude/latitude")
    parts = []
    for feature in features:
        polygon = shape(feature["geometry"])
        if (
            polygon.is_empty
            or not polygon.is_valid
            or polygon.geom_type not in ("Polygon", "MultiPolygon")
        ):
            raise ValueError("Invalid source perimeter; no automatic repair")
        parts.append(polygon)
    polygon = unary_union(parts)
    west, south, east, north = polygon.bounds
    if not (-180 <= west < east <= 180 and -90 <= south < north <= 90) or not polygon.is_valid:
        raise ValueError("Invalid source perimeter; no automatic repair")
    return data, {"status": "available", **receipt}


def smoke_config(record, geometry, file_names, source):
    import pandas as pd

    ignition = datetime.fromisoformat(record["ignition"])
    start = ignition - timedelta(days=3)
    cap = start + timedelta(days=59)
    months = sorted({day.month for day in pd.date_range(start, cap)})
    center = unary_union([shape(f["geometry"]) for f in geometry["features"]]).centroid
    zone = int((center.x + 180) // 6) + 1
    return {
        "id": record["id"],
        "ignition": record["ignition"],
        "leadDays": 3,
        "capDays": 60,
        "stateCode": 6,
        "countyCode": None,
        "projectedCrs": f"EPSG:{32600 + zone}",
        "utcOffsetHours": -8,
        "timezone": "Pacific standard time (UTC−08:00)",
        "minimumHoursPerDay": 18,
        "referenceYears": list(range(ignition.year - 3, ignition.year)),
        "referenceMonths": months,
        "availableFiles": file_names,
        "fileIndexSource": source,
        "compactReadings": True,
    }


def select_stations(audited):
    by_site = {}
    for station in audited:
        coverage = sum(day["hours"] for day in station["dailyMeans"]) / (
            len(station["dailyMeans"]) * 24
        )
        if coverage == 0:
            continue
        station["coverageFraction"] = coverage
        previous = by_site.get(station["id"])
        quality = (coverage >= 0.75, station["thresholdUgM3"] is not None, -station["missingHours"])
        if previous is None or quality > (
            previous["coverageFraction"] >= 0.75,
            previous["thresholdUgM3"] is not None,
            -previous["missingHours"],
        ):
            by_site[station["id"]] = station
    complete = [station for station in by_site.values() if station["coverageFraction"] >= 0.75]

    candidates = complete or list(by_site.values())
    return sorted(candidates, key=lambda row: (row["distanceKm"], row["id"]))[:3]


def station_names():
    import pandas as pd

    global STATION_NAMES
    if STATION_NAMES is not None:
        return STATION_NAMES
    path, _ = download("aqs_sites.zip", "https://aqs.epa.gov/aqsweb/airdata/aqs_sites.zip")
    with zipfile.ZipFile(path) as archive:
        rows = pd.read_csv(archive.open(archive.namelist()[0]), dtype=str)
    names = {}
    for _, row in rows.iterrows():
        key = f"{row['State Code']}-{row['County Code']}-{row['Site Number']}"
        name = row["Local Site Name"]
        names[key] = name if isinstance(name, str) and name.strip() else "EPA " + key
    STATION_NAMES = names
    return names


def build_smoke(record, geometry, include_plumes=True):
    import pandas as pd
    from build_waves_case import station_audit, build_station

    path, source = download("epa-file-index.html", EPA)
    names = set(re.findall(r"(?:hourly|daily)_\d+_\d{4}\.zip", path.read_text(encoding="utf-8")))
    config = smoke_config(record, geometry, sorted(names), source)
    audited = station_audit(config, geometry)
    selected = select_stations(audited)
    start = datetime.fromisoformat(config["ignition"]) - timedelta(days=3)
    end = (selected[0]["windowEnd"] if selected else None) or (
        start + timedelta(days=59)
    ).date().isoformat()
    names_by_id = station_names() if selected else {}
    colors = ["#254c46", "#717b9b", "#a07a59"]
    stations = []
    for index, station in enumerate(selected):
        stations.append(
            build_station(
                config, station, end, {"name": names_by_id[station["id"]], "color": colors[index]}
            )
        )
    days = []
    if include_plumes:
        for day in pd.date_range(start, end):
            days.append(checked_plume_day(day.date().isoformat(), stations))
    reference = json.loads((ROOT / "data/waves_reference.json").read_text(encoding="utf-8"))
    epa_available = False
    for station in stations:
        for reading in station["series"]:
            if reading["value"] is not None:
                epa_available = True
                break
        if epa_available:
            break
    hms_available = any(day["status"] == "available" for day in days)
    reason = (
        ""
        if epa_available
        else "Checked EPA archives: no numeric observations in the selected hourly window among up to five audited sites within 50 km. More distant sites not evaluated."
    )
    return {
        "status": "available" if epa_available or hms_available else "unavailable",
        "epaStatus": "available" if epa_available else "unavailable",
        "reason": reason,
        "checkedAt": datetime.now(timezone.utc).isoformat(),
        "relationship": "nearby_time_matched",
        **(selected[0]["source"] if selected else source),
        "stations": stations,
        "timezone": config["timezone"],
        "window": {
            "start": start.date().isoformat(),
            "end": end,
            "referenceYears": config["referenceYears"],
            "referenceMonths": config["referenceMonths"],
            "minimumHoursPerDay": 18,
            "referenceSources": selected[0]["referenceSources"] if selected else [],
        },
        "plumes": {"days": days},
        "exclusions": [],
        "health": [],
        "aqiReference": reference["aqiReference"],
        "limitedCoverage": not selected or selected[0]["coverageFraction"] < 0.75,
        "selectionRule": "Nearest three distinct sites among five audited within 50 km, preferring >=75% hourly coverage over 60 days. If none qualify, show partial records with gaps. Prefer comparable reference instrument within each site. Not fire-attributed smoke.",
    }


def checked_plume_day(day, stations):
    if day > datetime.now(timezone.utc).date().isoformat():
        return {
            "dateUtc": day,
            "status": "not_elapsed",
            "reason": "Future day; no source request made.",
            "path": None,
            "measurementPeriod": None,
            "monitorCoverage": {s["id"]: None for s in stations},
            "dataClass": "Historical",
            "retrievedAt": None,
            "sourceUrl": "https://satepsanone.nesdis.noaa.gov/pub/FIRE/web/HMS/Smoke_Polygons/KML/",
        }
    try:
        return cached_plume_day(day, stations)
    except (OSError, ValueError, KeyError, ET.ParseError) as error:
        from build_historical_coverage import source_error_status
        from build_waves_data import CACHE

        receipt = {}
        for prefix in ["hms-legacy-", "hms-current-"]:
            path = CACHE / (prefix + day.replace("-", "") + ".kml.source.json")
            if path.exists():
                receipt = json.loads(path.read_text(encoding="utf-8"))
                break
        status = source_error_status(error)
        return {
            "dateUtc": day,
            "status": status,
            "reason": str(error),
            "path": None,
            "measurementPeriod": None,
            "monitorCoverage": {s["id"]: None for s in stations},
            "dataClass": "Historical",
            "sourceUrl": receipt.get(
                "sourceUrl",
                "https://satepsanone.nesdis.noaa.gov/pub/FIRE/web/HMS/Smoke_Polygons/KML/",
            ),
            "retrievedAt": receipt.get("retrievedAt"),
            "attemptedAt": datetime.now(timezone.utc).isoformat(),
        }


def cached_plume_day(day, stations):
    from build_waves_case import plume_day
    from build_historical_coverage import PLUME_CACHE_DAYS

    if day not in PLUME_DAYS:
        result = plume_day(day, [])
        geometries = []
        if result.get("path") and result["status"] == "available":
            data = json.loads((PUBLIC / result["path"].lstrip("/")).read_text(encoding="utf-8"))
            for feature in data["features"]:
                geometries.append(shape(feature["geometry"]))
        if len(PLUME_DAYS) >= PLUME_CACHE_DAYS:
            PLUME_DAYS.pop(next(iter(PLUME_DAYS)))
        PLUME_DAYS[day] = (result, geometries)
    original, geometries = PLUME_DAYS[day]
    result = original.copy()
    result["monitorCoverage"] = {}
    for station in stations:
        coverage = None
        if result["status"] == "available":
            point = Point(station["longitude"], station["latitude"])
            coverage = any(geometry.covers(point) for geometry in geometries)
        result["monitorCoverage"][station["id"]] = coverage
    return result


def prepare_mapped_product(record, product):
    result = load_evidence(record)
    output = PUBLIC / record["evidenceUrl"].lstrip("/")
    try:
        if product == "hrrr":
            from build_hrrr_smoke import build_historical_hrrr

            prepared = build_historical_hrrr(record, hrrr_geometry(record))
        else:
            geometry, receipt = evidence_perimeter(record)
            if geometry is None:
                prepared = {"status": "match_unresolved", "reason": receipt["reason"]}
            else:
                from build_historical_rasters import goes

                prepared = goes(record, geometry)
                result["perimeter"] = {**receipt, "value": geometry}
    except (OSError, ValueError, KeyError) as error:
        from build_historical_coverage import source_error_status

        status = source_error_status(error)
        prepared = {"status": status, "reason": "Source or processing check failed: " + str(error)}
    result[product] = prepared
    result["checks"][product] = {"status": prepared["status"], "reason": prepared.get("reason", "")}
    if prepared.get("scope"):
        result["checks"][product]["scope"] = prepared["scope"]
    save_evidence(output, result, product)
    return output


def save_evidence(output, result, product):
    from build_historical_coverage import CACHE, EVIDENCE_LOCK_SECONDS

    folder = CACHE / "evidence-locks"
    folder.mkdir(parents=True, exist_ok=True)
    lock = folder / output.name
    deadline = time.monotonic() + EVIDENCE_LOCK_SECONDS
    while True:
        try:
            lock.mkdir()
            break
        except FileExistsError:
            if time.monotonic() >= deadline:
                raise RuntimeError("Evidence file is locked by another writer: " + output.name)
            time.sleep(0.05)
    try:
        merge_evidence(output, result, product)
    finally:
        lock.rmdir()


def merge_evidence(output, result, product):
    current = json.loads(output.read_text(encoding="utf-8")) if output.exists() else result.copy()
    if current["fireId"] != result["fireId"]:
        raise ValueError("Concurrent evidence identity differs")
    if product == "groundProducts":
        merge_ground_layers(current, result)
    if product == "smoke":
        previous = current.get("smoke", {})
        following = result["smoke"].copy()
        if "plumes" in previous:
            following["plumes"] = previous["plumes"]
        expose_checked_plumes(following)
        current["smoke"] = following
    elif product == "hms":
        smoke = current.setdefault("smoke", {})
        for key, value in result["smoke"].items():
            if key == "plumes":
                smoke[key] = value
            else:
                smoke.setdefault(key, value)
        expose_checked_plumes(smoke)
    if product in ("damage", "water", "power"):
        from build_recovery_data import complete_recovery_shape

        recovery = current.setdefault("recovery", {"schemaVersion": 1, "fireId": result["fireId"]})
        previous = recovery.get(product)
        following = result["recovery"][product]
        if previous and previous.get("status") == "available" and previous != following:
            raise ValueError("Previously reviewed recovery evidence would change")
        recovery[product] = following
        complete_recovery_shape(recovery)
        current.setdefault("checks", {})["recovery"] = result["checks"]["recovery"]
    fields = {
        "smoke": ["perimeter"],
        "hms": ["plumeCoverage", "perimeter"],
        "rain": ["rainUrl"],
        "recovery": ["recovery"],
        "context": ["context", "perimeter"],
        "goes": ["goes", "perimeter"],
        "hrrr": ["hrrr", "perimeter"],
    }
    for key in fields.get(product, []):
        if key in result:
            current[key] = result[key]
    if product == "checks":
        current["checks"] = {**current.get("checks", {}), **result["checks"]}
        expose_checked_plumes(current.setdefault("smoke", {}))
    else:
        check_key = product.removeprefix("check:")
        current["checks"] = {**current.get("checks", {}), check_key: result["checks"][check_key]}
    current["builtAt"] = datetime.now(timezone.utc).isoformat()
    save_json(output, current)


def merge_ground_layers(current, result):
    following = result["groundProducts"]
    existing = current.setdefault("groundProducts", {})
    if following["fireId"] != current["fireId"]:
        raise ValueError("Ground product belongs to another fire")
    layers = existing.setdefault("layers", {})
    for name, layer in following.get("layers", {}).items():
        if name in layers and layers[name] != layer:
            raise ValueError("Previously verified ground layer would change: " + name)
        layers[name] = layer
    for key, value in following.items():
        if key == "layers":
            continue
        if key in existing and existing[key] != value:
            raise ValueError("Previously verified ground provenance would change: " + key)
        existing[key] = value


def build(record, product="smoke", rebuild=False):
    output = PUBLIC / record["evidenceUrl"].lstrip("/")
    result = load_evidence(record)
    if product in result["checks"] and not rebuild:
        return output
    if product == "recovery":
        from build_recovery_data import complete_recovery_shape

        recovery = result.setdefault("recovery", {"schemaVersion": 1, "fireId": record["id"]})
        complete_recovery_shape(recovery)
        result["checks"]["recovery"] = {
            "status": "not_checked",
            "reason": "Recovery source checks are in progress.",
        }
        save_evidence(output, result, "recovery")
    sources = {
        "smoke": ["smoke", "hms"],
        "rain": ["rain"],
        "recovery": ["damage", "water", "power"],
        "context": ["slope"],
        "goes": ["goes"],
        "hrrr": ["hrrr"],
    }
    for source in sources[product]:
        checked = check_display_source(record, source)
        result = load_evidence(record)
        result["checks"][source] = checked
        if source == "smoke" and not result["smoke"].get("stations"):
            result["smoke"].update(checked)
        if product == "recovery" and result["recovery"][source]["status"] == "not_checked":
            result["recovery"][source].update(checked)
        save_evidence(output, result, source)
    if product == "context":
        result["checks"]["context"] = result["checks"]["slope"]
        save_evidence(output, result, "context")
    if product == "recovery":
        result["checks"]["recovery"] = {
            "status": "checked",
            "reason": "Recovery sources checked separately; see each product's coverage.",
        }
        save_evidence(output, result, "recovery")
    return output


def check_display_source(record, source):
    try:
        return check_source(record, source)
    except OSError as error:
        from build_historical_coverage import source_error_status

        return {"status": source_error_status(error), "reason": str(error)}
    except ValueError as error:
        return {"status": "quality_failed", "reason": str(error)}
    except (KeyError, RuntimeError) as error:
        return {"status": "processing_failed", "reason": str(error)}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(
        description="Prepare one selected fire from the same public EPA/NOAA sources as reviewed replays.\n\nReceives a catalog ID, never an arbitrary URL; caches raw files and preserves reviewed data.\n"
    )
    parser.add_argument("--fire", required=True)
    parser.add_argument(
        "--product",
        choices=["smoke", "rain", "recovery", "context", "goes", "hrrr"],
        default="smoke",
    )
    parser.add_argument(
        "--rebuild",
        action="store_true",
        help="Rebuild the selected product from its cached source bytes",
    )
    args = parser.parse_args()
    result = build(find_fire(args.fire), args.product, args.rebuild)
    if isinstance(result, dict):
        print(json.dumps(result), flush=True)
        raise SystemExit(1)
    print(result, flush=True)
