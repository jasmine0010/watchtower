import csv
import errno
import hashlib
import json
import math
import re
import zipfile
import xml.etree.ElementTree as ET
from collections import Counter, defaultdict
from datetime import datetime

from shapely.geometry import Point, shape
from shapely.ops import unary_union

from build_historical_coverage import catalog_records, source_error_status
from build_historical_evidence import PUBLIC, ROOT, perimeter_for
from build_waves_case import save_json
from build_waves_data import download
from historical_identity import fire_name

RELEASE = "https://www.sciencebase.gov/catalog/item/69612c8ed4be02298529c522"
FEATURES = [
    "UniqueObservationID",
    "FireName",
    "FireYear",
    "FireIgnitionDate",
    "FireState",
    "AssessmentFireID",
    "AssessmentSegmentID",
    "ObservationLatitude",
    "ObservationLongitude",
    "StormStart",
]
THRESHOLD_SOURCES = {}
THRESHOLD_FAILURES = {}
INVENTORY_AUDIT = None
INVENTORY_EXCLUSIONS = None


def check_inventory(record, category):
    global INVENTORY_AUDIT, INVENTORY_EXCLUSIONS
    if INVENTORY_AUDIT is None:
        path = PUBLIC / "data/historical-fires/observation-audit.json"
        INVENTORY_AUDIT = json.loads(path.read_text(encoding="utf-8"))
        if INVENTORY_AUDIT.get("reservedFilesRead") is not False:
            raise ValueError("Inventory eligibility provenance is missing")
        INVENTORY_EXCLUSIONS = defaultdict(list)
        for row in INVENTORY_AUDIT["excludedCaliforniaRecords"]:
            key = (fire_name(row["FireName"]), int(row["FireYear"]))
            INVENTORY_EXCLUSIONS[key].append(
                {"id": row["UniqueObservationID"], "reason": row["reason"]}
            )
    if not INVENTORY_AUDIT.get("fires", {}).get(record["id"]):
        candidates = INVENTORY_EXCLUSIONS.get((fire_name(record["name"]), record["year"]), [])
        status = "match_unresolved" if candidates else "no_match"
        return {
            "status": status,
            "sourceUrl": RELEASE,
            "candidates": candidates,
            "reason": "Completed public-inventory search; no verified export for this fire. Other inventories are outside this check.",
        }
    path = checked_inventory_path(record)
    data = json.loads(path.read_text(encoding="utf-8"))
    if (
        data["fireId"] != record["id"]
        or data["selectionSha256"] != INVENTORY_AUDIT["selectionSha256"]
    ):
        raise ValueError("Observation identity or eligibility snapshot disagrees")
    rows = data["records"]
    if category != "observations":
        verified = category == "measured_rain"
        rows = [
            row
            for row in rows
            if row["PeakI15"] is not None and row["gaugeStormIdentityVerified"] == verified
        ]
    count = len(rows)
    if category != "observations":
        count = len({row["gaugeStormId"] for row in rows})
    return {
        "status": "available" if count else "no_match",
        "sourceUrl": data["sourceUrl"],
        "records": count,
        "reason": "Existing public-inventory values retained; gauge identity and missing peaks remain unchanged.",
    }


def checked_inventory_path(record):
    path = (
        PUBLIC / "data/historical-fires/observations" / (record["id"].replace(":", "-") + ".json")
    )
    expected = INVENTORY_AUDIT.get("fires", {}).get(record["id"], 0)
    if path.exists() or not expected:
        return path
    from build_historical_assessments import restore_baseline_file

    baseline = ROOT / "data/raw/historical-coverage/baseline/hashes.json"
    hashes = json.loads(baseline.read_text(encoding="utf-8"))
    digest = hashes.get(path.relative_to(PUBLIC).as_posix())
    if digest and restore_baseline_file(path, digest):
        return path
    raise FileNotFoundError(
        errno.ENOENT, "Verified local inventory export could not be restored", str(path)
    )


def threshold_for(item, source_row):
    from build_rainfall_thresholds import verify_values
    from pyproj import Transformer
    from shapely.ops import transform

    fire_id = source_row["AssessmentFireID"]
    if fire_id in THRESHOLD_FAILURES:
        return THRESHOLD_FAILURES[fire_id]
    if fire_id not in THRESHOLD_SOURCES:
        try:
            failure = prepare_threshold_sources(fire_id)
        except (OSError, ValueError, KeyError) as error:
            status = source_error_status(error)
            failure = {"status": status, "reason": str(error)}
        if failure:
            THRESHOLD_FAILURES[fire_id] = failure
            return failure
    sources, digest, url = THRESHOLD_SOURCES[fire_id]
    for scope in ["Basin", "Segment"]:
        source = sources.get(scope)
        if not source or item["assessmentSegmentId"] not in source["index"]:
            continue
        rows = [
            source["reader"].shapeRecord(oid)
            for oid in source["index"][item["assessmentSegmentId"]]
        ]
        attributes = rows[0].record.as_dict()
        area = attributes.get("UpArea_km2")
        if (
            item["HM23"] is None
            or item["UpstreamArea"] is None
            or not isinstance(area, (int, float))
            or not math.isclose(area, item["UpstreamArea"], abs_tol=0.000051)
        ):
            return {
                "status": "unavailable",
                "reason": "Source contributing area is missing or disagrees with inventory precision.",
            }
        supplied = unary_union([shape(row.shape.__geo_interface__) for row in rows])
        geometry = transform(
            Transformer.from_crs(source["crs"], 4326, always_xy=True).transform, supplied
        )
        if not geometry.is_valid:
            return {
                "status": "unavailable",
                "reason": "Threshold source geometry is invalid; no repair applied.",
            }
        if scope == "Basin" and not geometry.contains(Point(item["longitude"], item["latitude"])):
            return {
                "status": "unavailable",
                "reason": "Observation outside exact source basin; spatial association unresolved.",
            }
        depth, intensity = verify_values(rows, fire_id, item["assessmentSegmentId"], item["HM23"])
        return {
            "status": "available",
            "observationId": item["id"],
            "assessmentId": item["assessmentSegmentId"],
            "scope": scope.lower(),
            "durationMinutes": 15,
            "probability": 0.5,
            "depthMm": depth,
            "intensityMmH": intensity,
            "depthUnit": "mm",
            "intensityUnit": "mm/hour",
            "assessmentDate": source["date"],
            "version": "Dated archive snapshot; no numbered version supplied",
            "sourceUrl": url,
            "archiveSha256": digest,
            "layer": source["base"] + ".shp",
            "metadataSha256": source["metadataSha256"],
            "definitions": source["definitions"],
            "geometryCheck": "Original source geometry; exact containment for basin, segment identity for segment. No buffer.",
            "limitation": "Agency estimate, not a guaranteed trigger or current warning. Segment-only estimates do not establish a catchment polygon.",
        }
    return {
        "status": "unavailable",
        "reason": "Exact identifier absent from inspected basin and segment threshold layers.",
    }


def prepare_threshold_sources(fire_id):
    from build_rainfall_thresholds import verify_metadata
    from build_historical_assessments import native_reader

    archive_path, attachment = threshold_archive(fire_id)
    if archive_path is None:
        return attachment
    sources = {}
    with zipfile.ZipFile(archive_path) as archive:
        for scope in ["Basin", "Segment"]:
            base = f"{fire_id}_{scope}_RainfallEstimates_15min_RainAtP_50"
            if base + ".shp" not in archive.namelist():
                continue
            reader, crs = native_reader(archive, base)
            metadata = archive.read(base + ".shp.xml")
            date = source_day(ET.fromstring(metadata).findtext("idinfo/citation/citeinfo/pubdate"))
            definitions = verify_metadata(metadata, date)
            index = {}
            for row in reader.iterRecords():
                index.setdefault(row.as_dict()["Fire_Segme"], []).append(row.oid)
            sources[scope] = {
                "reader": reader,
                "crs": crs,
                "date": date,
                "index": index,
                "definitions": definitions,
                "metadataSha256": hashlib.sha256(metadata).hexdigest(),
                "base": base,
            }
    THRESHOLD_SOURCES.clear()
    THRESHOLD_SOURCES[fire_id] = (sources, attachment["sha256"], attachment["sourceUrl"])
    return None


def threshold_archive(fire_id):
    from build_historical_assessments import source_audit, retrieve_attachment

    matches = []
    for collection in source_audit()["archives"]["collections"]:
        for release in collection["items"]:
            for file in release.get("files", []):
                if file["name"].endswith("_" + fire_id + ".zip"):
                    matches.append((release, file))
    if not matches:
        return None, {
            "status": "unavailable",
            "reason": "Exact assessment identifier absent from the checked annual attachment index.",
        }
    if len(matches) != 1:
        return None, {
            "status": "quality_failed",
            "reason": "Original threshold attachment identity is ambiguous.",
        }
    release, file = matches[0]
    return retrieve_attachment(release, file)


def check_observation_thresholds(record):
    inventory = check_inventory(record, "observations")
    if inventory["status"] != "available":
        return None
    path = (
        PUBLIC / "data/historical-fires/observations" / (record["id"].replace(":", "-") + ".json")
    )
    data = json.loads(path.read_text(encoding="utf-8"))
    rows, results = public_observation_metadata(data), []
    for item in data["records"]:
        previous = item.get("rainfallThreshold", {})
        if previous.get("status") == "available":
            results.append(previous)
            continue
        try:
            value = threshold_for(item, rows[item["id"]])
        except (OSError, ValueError, KeyError, TypeError) as error:
            status = source_error_status(error)
            value = {"status": status, "reason": str(error)}
        results.append({**value, "observationId": item["id"]})
    output = (
        PUBLIC
        / "data/historical-fires/thresholds"
        / (record["id"].replace(":", "-") + "-observations.json")
    )
    supplement = {
        "schemaVersion": 1,
        "fireId": record["id"],
        "selectionSha256": data["selectionSha256"],
        "sourceUrl": data["sourceUrl"],
        "dataClass": "Historical",
        "records": results,
    }
    if output.exists() and json.loads(output.read_text(encoding="utf-8")) != supplement:
        raise ValueError("Previously checked observation threshold supplement changed")
    if not output.exists():
        save_json(output, supplement)
    counts = Counter(row["status"] for row in results)
    status = "available" if counts["available"] else "match_unresolved"
    for failure in ("quality_failed", "access_failed", "processing_failed"):
        if not counts["available"] and counts[failure]:
            status = failure
    return {
        "status": status,
        "records": counts["available"],
        "checks": dict(counts),
        "preparedUrl": "/" + output.relative_to(PUBLIC).as_posix(),
        "reason": "Existing observation values retained; original thresholds checked with unchanged identifier, area, HM23 and containment rules.",
    }


def public_observation_metadata(data):
    source = data["sourceReceipt"]
    path, receipt = download("public-inventory.csv", source["sourceUrl"])
    if receipt["sha256"] != source["sha256"]:
        raise ValueError("Public inventory differs from the reviewed eligibility snapshot")
    eligible = {row["id"] for row in data["records"]}
    metadata = {}
    with path.open(encoding="utf-8-sig", newline="") as stream:
        for row in csv.DictReader(stream):
            identifier = row["UniqueObservationID"]
            if identifier not in eligible:
                continue
            if identifier in metadata:
                raise ValueError("Duplicate eligible public observation identity")
            metadata[identifier] = {key: row[key] for key in FEATURES}
    if set(metadata) != eligible:
        raise ValueError("Eligible observation metadata is incomplete")
    return metadata


def assessment_id(value):

    return re.sub(r"^([a-z]{2,4})_(\d{4})$", r"\1\2", str(value).lower())


def source_day(value):
    if value in (None, "", "-9999"):
        return None
    value = str(value)
    if re.fullmatch(r"\d{8}\.0", value):
        value = value[:-2]
    return datetime.strptime(value, "%Y%m%d").date().isoformat()


def number(value):
    if value in (None, "", "-9999"):
        return None
    result = float(value)
    if not (-float("inf") < result < float("inf")):
        raise ValueError("Nonfinite inventory value")
    return result


def select_fire(row, candidates, polygons):
    day = source_day(row["FireIgnitionDate"])
    point = Point(float(row["ObservationLongitude"]), float(row["ObservationLatitude"]))
    matches = []
    for record in candidates:
        days = {s.get("ignition") for s in record["sources"]} | {record.get("ignition")}
        if fire_name(row["FireName"]) != fire_name(record["name"]) or day not in days:
            continue
        ids = {assessment_id(s["sourceId"]) for s in record["sources"] if s["source"] == "USGS"}
        linked = assessment_id(row["AssessmentFireID"]) in ids
        polygon = polygons.get(record["id"])
        inside = bool(polygon and polygon.contains(point))
        if linked or inside:
            matches.append((record, linked, inside if polygon else None))
    return matches[0] if len(matches) == 1 else None


def unresolved_reason(row, candidates):
    if not candidates:
        return "No exact catalog fire name/year"
    day = source_day(row["FireIgnitionDate"])
    dated = [
        r
        for r in candidates
        if day in ({s.get("ignition") for s in r["sources"]} | {r.get("ignition")})
    ]
    if not dated:
        return "Exact ignition day disagrees with all catalog source days"
    return "Unique documented assessment ID or actual fire-polygon containment not established"


def main():
    release_path, release_receipt = download(
        "public-inventory-release.json", RELEASE + "?format=json"
    )
    release = json.loads(release_path.read_text(encoding="utf-8"))
    files = {f["name"]: f for f in release["files"]}
    source, receipt = download(
        "public-inventory.csv", files["USGS_RG_PFDF_Inventory_v1.csv"]["url"]
    )
    records = catalog_records()
    groups = defaultdict(list)
    for record in records:
        groups[(fire_name(record["name"]), record["year"])].append(record)

    with source.open(encoding="utf-8-sig", newline="") as stream:
        features = []
        for csv_row in csv.DictReader(stream):
            record_fields = {}
            for field in FEATURES:
                record_fields[field] = csv_row[field]
            features.append(record_fields)
    if len({row["UniqueObservationID"] for row in features}) != len(features):
        raise ValueError("Duplicate public observation ID")
    polygons, checked, failures, eligible = {}, set(), {}, {}
    exclusions = Counter()
    excluded_records = []
    for row in features:
        if row["FireState"] != "CA":
            exclusions["Outside California"] += 1
            continue
        candidates = groups[(fire_name(row["FireName"]), int(row["FireYear"]))]
        for record in candidates:
            if record["id"] in checked:
                continue
            checked.add(record["id"])
            try:
                data, _ = perimeter_for(record)
                if data:
                    polygons[record["id"]] = unary_union(
                        [shape(f["geometry"]) for f in data["features"]]
                    )
            except (OSError, ValueError, KeyError) as error:
                failures[record["id"]] = str(error)
        try:
            matched = select_fire(row, candidates, polygons)
            if source_day(row["StormStart"]) < source_day(row["FireIgnitionDate"]):
                matched = None
        except (ValueError, TypeError):
            matched = None
        if matched:
            record, linked, inside = matched
            eligible[row["UniqueObservationID"]] = {
                "fireId": record["id"],
                "assessmentLinked": linked,
                "insideFirePerimeter": inside,
                "assessmentSegmentId": row["AssessmentSegmentID"],
            }
        else:
            reason = unresolved_reason(row, candidates)
            exclusions[reason] += 1
            excluded_records.append({**row, "reason": reason})
    selection = {
        "sourceSha256": receipt["sha256"],
        "selectedBeforeOutcomes": True,
        "eligible": eligible,
    }
    selection_sha = hashlib.sha256(json.dumps(selection, sort_keys=True).encode()).hexdigest()
    save_json(
        ROOT / "data/raw/historical-coverage/observation-eligibility.json",
        {**selection, "sha256": selection_sha},
    )
    audit_path = ROOT / "output/geometry-audit/observations.csv"
    spatial = {}
    if audit_path.exists():
        with audit_path.open(encoding="utf-8-sig", newline="") as stream:
            spatial = {row["UniqueObservationID"]: row for row in csv.DictReader(stream)}
    by_fire = defaultdict(list)
    with source.open(encoding="utf-8-sig", newline="") as stream:
        for row in csv.DictReader(stream):
            match = eligible.get(row["UniqueObservationID"])
            if not match:
                continue
            response = int(row["Response"])
            if response not in (0, 1):
                raise ValueError("Unknown public response definition")
            previous = spatial.get(row["UniqueObservationID"], {})
            values = {
                key: number(row[key])
                for key in ["PeakI15", "HM23", "UpstreamArea", "GageLatitude", "GageLongitude"]
            }
            if values["HM23"] is not None and not 0 <= values["HM23"] <= 1:
                raise ValueError("HM23 is not a proportion")
            gauge_key = [
                row["GageID"],
                row["GageName"],
                values["GageLatitude"],
                values["GageLongitude"],
                row["StormStart"],
            ]
            gauge_known = row["GageID"] not in ("", "-9999") or (
                row["GageName"] not in ("", "-9999")
                and values["GageLatitude"] is not None
                and values["GageLongitude"] is not None
            )
            if not gauge_known:
                gauge_key.append(row["UniqueObservationID"])
            gauge_key = hashlib.sha256(json.dumps(gauge_key).encode()).hexdigest()
            item = {
                "id": row["UniqueObservationID"],
                **match,
                **values,
                "stormDate": source_day(row["StormStart"]),
                "recordingDate": source_day(row["ObservationDate"]),
                "longitude": number(row["ObservationLongitude"]),
                "latitude": number(row["ObservationLatitude"]),
                "response": response,
                "gauge": None if row["GageName"] == "-9999" else row["GageName"],
                "gaugeId": None if row["GageID"] == "-9999" else row["GageID"],
                "gaugeStormId": gauge_key,
                "gaugeStormIdentityVerified": gauge_known,
                "source": row["ObservationSource"],
                "yearAfterFire": number(row["YearAfterFire"]),
                "geometryMatch": previous.get("geometry_match")
                or "Original assessment geometry not inspected",
                "spatialStatus": previous.get("spatial_status")
                or "Contributing-watershed association not locally checked",
                "relationship": "fire_specific",
                "dataClass": "Observed",
            }
            try:
                item["rainfallThreshold"] = threshold_for(item, row)
            except (ValueError, KeyError, TypeError) as error:
                item["rainfallThreshold"] = {"status": "quality_failed", "reason": str(error)}
            by_fire[match["fireId"]].append(item)
    for record in records:
        items = by_fire.get(record["id"])
        if not items:
            continue
        path = (
            PUBLIC
            / "data/historical-fires/observations"
            / (record["id"].replace(":", "-") + ".json")
        )
        save_json(
            path,
            {
                "schemaVersion": 1,
                "fireId": record["id"],
                "sourceUrl": RELEASE,
                "retrievedAt": receipt["retrievedAt"],
                "publicationDate": "2026-08-17",
                "license": "CC0 1.0",
                "selectionSha256": selection_sha,
                "records": items,
                "sourceReceipt": receipt,
                "limitation": "Inventory points are observations, not exact watershed outlets. Terrain attributes are agency-supplied, not independently measured here. Response 0 excludes true debris flow, not every muddy flood. Peaks are not a rainfall time series.",
            },
        )
    save_json(
        PUBLIC / "data/historical-fires/observation-audit.json",
        {
            "discovered": len(features),
            "matchedObservations": len(eligible),
            "matchedFires": len(by_fire),
            "exclusions": dict(exclusions),
            "geometryAccessFailures": failures,
            "selectionSha256": selection_sha,
            "source": release_receipt,
            "fires": {key: len(value) for key, value in by_fire.items()},
            "excludedCaliforniaRecords": excluded_records,
            "reservedFilesRead": False,
            "rainfallSeries": "Not supplied by this release; no curve synthesized.",
        },
    )
    print(
        "Public observations",
        len(eligible),
        "resolved fires",
        len(by_fire),
        dict(exclusions),
        flush=True,
    )


if __name__ == "__main__":
    main()
