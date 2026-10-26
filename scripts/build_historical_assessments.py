import hashlib
import codecs
import io
import json
import math
import re
import zipfile
import xml.etree.ElementTree as ET
from collections import Counter
from datetime import datetime
from urllib.parse import urlencode

import shapefile
from pyproj import CRS, Transformer
from shapely.geometry import mapping, shape
from shapely.ops import transform

from build_waves_data import ROOT, download
from build_waves_case import PUBLIC, save_json, scenario_response_shares
from build_historical_coverage import source_error_status
from historical_identity import fire_name

AUDIT = None
ANNUAL_INDEX = None
TRAVEL_INDEX = None
ARCHIVE_RESULTS = {}
PROJECTORS = {}
SOURCE_PAGE = "https://www.usgs.gov/programs/landslide-hazards/science/postfire-debris-flow-hazard-assessment-data"


def source_audit():
    global AUDIT
    if AUDIT is None:
        AUDIT = json.loads(
            (PUBLIC / "data/historical-fires/audit.json").read_text(encoding="utf-8")
        )
        for source in ("usgs", "archives"):
            if AUDIT[source]["status"] != "available":
                raise OSError("Official assessment discovery did not complete")
    return AUDIT


def release_links(record):
    links = set()
    agency = record.get("assessment") or {}
    if agency.get("ScienceBaseURL"):
        links.add(agency["ScienceBaseURL"].strip())
    for source in record.get("sources", []):
        if source["source"] == "USGS archive":
            links.add(source["sourceUrl"].strip())
    return sorted(links)


def unlinked_result(record):
    candidates = []
    for item in record.get("unconfirmedSources", []):
        if item["source"] in ("USGS", "USGS archive"):
            candidates.append(item["id"])
    key = (fire_name(record["name"]), record["year"])
    candidates.extend(annual_candidates().get(key, []))
    status = "match_unresolved" if candidates else "no_match"
    return {
        "status": status,
        "sourceUrl": SOURCE_PAGE,
        "candidates": sorted(set(candidates)),
        "reason": "Completed assessment catalog and annual attachment-index search; no verified fire-to-release link. No nearby assessment was substituted.",
    }


def annual_candidates():
    global ANNUAL_INDEX
    if ANNUAL_INDEX is not None:
        return ANNUAL_INDEX
    index = {}
    for collection in source_audit()["archives"]["collections"]:
        for item in collection["items"]:
            for file in item.get("files", []):
                match = re.fullmatch(r"(.+)_(\d{4}-\d{2}-\d{2})_([^/]+)\.zip", file["name"])
                if not match:
                    continue
                name, day, identifier = match.groups()
                key = (fire_name(name.replace("-", " ")), int(day[:4]))
                index.setdefault(key, []).append(identifier)
    ANNUAL_INDEX = index
    return index


def read_release(url):
    match = re.fullmatch(r"https://www.sciencebase.gov/catalog/item/([a-f0-9]{24})", url)
    if not match:
        raise ValueError("Linked assessment URL is not an official release identifier")
    path, receipt = download(match[1] + "-assessment-release.json", url + "?format=json")
    release = json.loads(path.read_text(encoding="utf-8"))
    if release.get("id") != match[1]:
        raise ValueError("Returned assessment release identity differs")
    return release, receipt


def retrieve_attachment(release, file):
    path, receipt = download(release["id"] + "-" + file["name"], file["url"])
    if file.get("size") is not None and path.stat().st_size != file["size"]:
        raise ValueError("Assessment attachment size differs from release")
    checksum = file.get("checksum") or {}
    if checksum.get("type") == "MD5":
        if hashlib.md5(path.read_bytes()).hexdigest() != checksum["value"]:
            raise ValueError("Assessment attachment checksum differs from release")
    return path, receipt


def assessment_identifiers(record):
    identifiers = set()
    for source in record.get("sources", []):
        if source["source"] == "USGS":
            identifiers.add(source["sourceId"])
    if record.get("assessment"):
        identifiers.add(record["assessment"]["Fire_ID"])
    return identifiers


def linked_archives(record, release):
    files = release.get("files", [])
    direct = (record.get("assessment") or {}).get("download_url", "").strip()
    identifiers = assessment_identifiers(record)
    archives = []
    for file in files:
        if not file["name"].lower().endswith(".zip"):
            continue
        exact_id = any(
            file["name"].endswith("_" + identifier + ".zip") for identifier in identifiers
        )
        single_release = file["name"] in ("GeoJSON.zip", "Shapefile.zip", "Shapefiles.zip")
        if exact_id or file["url"] == direct or single_release:
            archives.append(file)
    if any(file["name"] == "GeoJSON.zip" for file in archives):
        archives = [file for file in archives if file["name"] == "GeoJSON.zip"]
    return archives


def native_reader(archive, base):
    parts = {}
    for part in ("shp", "shx", "dbf"):
        parts[part] = io.BytesIO(archive.read(base + "." + part))
    encoding = "utf-8"
    if base + ".cpg" in archive.namelist():
        encoding = dbf_encoding(archive.read(base + ".cpg").decode().strip())
    reader = shapefile.Reader(**parts, encoding=encoding)
    crs = CRS.from_wkt(archive.read(base + ".prj").decode())
    return reader, crs


def dbf_encoding(label):
    normal = re.sub(r"[-_ ]", "", label).lower()
    if normal == "65001":
        return "utf-8"
    if normal.startswith("iso8859") and normal[7:].isdigit():
        label = "iso8859-" + normal[7:]
    elif normal.isdigit():
        label = "cp" + normal
    try:
        return codecs.lookup(label).name
    except LookupError as error:
        raise ValueError("Unrecognized source DBF encoding: " + label) from error


def geographic_geometry(source, crs):
    if source is None or getattr(source, "shapeType", None) == shapefile.NULL:
        return None, "Source geometry missing"
    original = shape(source.__geo_interface__)
    if original.is_empty or not original.is_valid:
        return None, "Invalid source geometry; no repair applied"
    key = crs.to_string()
    if key not in PROJECTORS:
        PROJECTORS[key] = (
            Transformer.from_crs(crs, 4326, always_xy=True).transform,
            Transformer.from_crs(4326, crs, always_xy=True).transform,
        )
    project, inverse = PROJECTORS[key]
    geographic = transform(project, original)
    restored = transform(inverse, geographic)
    tolerance = 0.001 if crs.is_projected else 0.00000001
    if not geographic.is_valid or original.hausdorff_distance(restored) > tolerance:
        raise ValueError("Assessment coordinate round trip failed")
    west, south, east, north = geographic.bounds
    if not (-125 < west <= east < -113 and 32 < south <= north < 43):
        raise ValueError("Assessment coordinates are outside California bounds")

    geographic_json = json.loads(json.dumps(mapping(geographic)))
    return geographic_json, None


def source_day(value):
    if value is None:
        return None
    text = str(value).strip()
    for pattern in ("%Y-%m-%d", "%Y%m%d", "%m/%d/%Y", "%Y/%m/%d", "%B %d, %Y", "%b %d, %Y"):
        try:
            return datetime.strptime(text, pattern).date().isoformat()
        except ValueError:
            continue
    return None


def feature_matches(record, attributes):
    identifiers = assessment_identifiers(record)
    if attributes.get("Fire_ID") not in identifiers:
        return False
    if fire_name(str(attributes.get("Fire_Name", ""))) != fire_name(record["name"]):
        return False
    dates = {record.get("ignition")}
    for source in record.get("sources", []):
        dates.add(source.get("ignition"))
    day = source_day(attributes.get("Start_Date"))
    return day is not None and day in dates


def matching_source_parts(reader, record):
    rows = []
    identities = {}
    for item in reader.iterRecords():
        attributes = item.as_dict()
        if not feature_matches(record, attributes):
            continue
        identifier = attributes.get("Fire_Segme")
        if not identifier:
            raise ValueError("Missing assessment feature identity")
        if str(attributes.get("Segment_ID")) != identifier.removeprefix(
            attributes["Fire_ID"] + "_"
        ):
            raise ValueError("Assessment feature identifiers disagree")
        scientific = {}
        for key, value in attributes.items():
            if key not in ("Shape_Leng", "Shape_Area"):
                scientific[key] = value
        if identifier in identities and identities[identifier] != scientific:
            raise ValueError("Duplicate assessment IDs have conflicting attributes")
        identities[identifier] = scientific
        rows.append(reader.shapeRecord(item.oid))
    return rows


def xml_definitions(archive, base):
    path = base + ".shp.xml"
    if path not in archive.namelist():
        return {}, None, None
    content = archive.read(path)
    root = ET.fromstring(content)
    fields = {}
    for item in root.findall(".//attr"):
        fields[item.findtext("attrlabl")] = item
    date = source_day(root.findtext("idinfo/citation/citeinfo/pubdate"))
    return fields, date, content


def legacy_bundle_guide(archive):
    policy = json.loads(
        (ROOT / "data/historical_coverage_sources.json").read_text(encoding="utf-8")
    )
    if not policy.get("legacyAssessmentGuidePolicy", {}).get("useSameBundleVolumeDefinition"):
        return None
    from pypdf import PdfReader

    names = []
    for name in archive.namelist():
        if name.rsplit("/", 1)[-1] == "PostFireDFEstimates_README.pdf":
            names.append(name)
    if len(names) != 1:
        return None
    content = archive.read(names[0])
    pages, text = [], []
    for index, page in enumerate(PdfReader(io.BytesIO(content)).pages):
        value = " ".join((page.extract_text() or "").split())
        if "Volume:" in value or "M1_R:" in value:
            pages.append(index + 1)
            text.append(value)
    definitions = " ".join(text)
    units = bool(
        re.search(r"Volume:\s*predicted volume for the design storm,? in m\s*3", definitions)
    )
    conflict = bool(re.search(r"M1_R:\s*Peak 15-minute rainfall intensity.*?\(mm/h\)", definitions))
    return {
        "path": names[0],
        "sha256": hashlib.sha256(content).hexdigest(),
        "pages": pages,
        "volumeUnit": "m3" if units else None,
        "rainfallDefinitionConflict": conflict,
    }


def old_scenario_metadata(fields, step, guide=None):
    rain = fields.get("M1_R")
    if rain is None or "15-minute rainfall accumulation (mm)" not in (
        rain.findtext("attrdef") or ""
    ):
        return "Rainfall duration and source depth units not verified"
    for label in ("P", "Volume", "CombHazCl"):
        if label not in fields:
            return "Required likelihood, volume or combined class definition missing"
    volume = fields["Volume"]
    definition = (volume.findtext("attrdef") or "").lower()
    units = (volume.findtext(".//attrunit") or "").lower()
    bundle_units = guide and guide.get("volumeUnit") == "m3"
    if (
        "cubic meter" not in definition + units
        and "meters^3" not in definition + units
        and not bundle_units
    ):
        return "Volume field metadata does not explicitly establish cubic-metre units; no numeric volume display inferred"
    return None


def validate_scenario_values(attributes, step):
    expected_depth = step * 15 / 60
    supplied_depth = attributes.get("R", attributes.get("M1_R"))
    if not isinstance(supplied_depth, (int, float)) or not math.isclose(
        supplied_depth, expected_depth, abs_tol=1e-8
    ):
        raise ValueError("Supplied rainfall depth does not match the published 15-minute intensity")
    for key in ("P", "Volume", "CombHazCl"):
        value = attributes.get(key)
        if value is not None and (
            not isinstance(value, (int, float)) or not math.isfinite(value) or value < 0
        ):
            raise ValueError("Missing-code or invalid assessment estimate; no replacement applied")
    if attributes.get("P") is not None and attributes["P"] > 1:
        raise ValueError("Source likelihood is not a fraction")
    if attributes.get("CombHazCl") not in (None, 1, 2, 3):
        raise ValueError("Source classified combined hazard is not 1, 2 or 3")


def inspect_old_scenarios(archive, record):
    checks = []
    guide = legacy_bundle_guide(archive)
    for filename in archive.namelist():
        match = re.fullmatch(r"(.+)_(Basin|Segment)_DFPredictions_15min_(\d+)mmh\.shp", filename)
        if not match:
            continue
        prefix, kind, intensity = match.groups()
        if prefix.rsplit("/", 1)[-1] not in assessment_identifiers(record):
            continue
        base, step = filename[:-4], int(intensity)
        reader, crs = native_reader(archive, base)
        rows = matching_source_parts(reader, record)
        fields, date, metadata = xml_definitions(archive, base)
        limitation = old_scenario_metadata(fields, step, guide)
        invalid = 0
        for row in rows:
            validate_scenario_values(row.record.as_dict(), step)
            geometry, reason = geographic_geometry(row.shape, crs)
            invalid += reason is not None
        checks.append(
            {
                "layer": filename,
                "scope": kind.lower(),
                "intensity": step,
                "features": len(rows),
                "invalidGeometry": invalid,
                "sourceCrs": crs.to_string(),
                "sourceMetadataDate": date,
                "metadataLimitation": limitation,
                "metadataSha256": hashlib.sha256(metadata).hexdigest() if metadata else None,
                "bundleGuide": guide,
            }
        )
    return checks


def inspect_wide_scenarios(archive, release):
    checks = []
    for filename in archive.namelist():
        if not re.search(r"-(basins|segments)\.shp$", filename):
            continue
        reader, crs = native_reader(archive, filename[:-4])
        fields = {field[0] for field in reader.fields[1:]}
        steps = sorted(
            int(re.fullmatch(r"P_(\d+)mmh", field)[1])
            for field in fields
            if re.fullmatch(r"P_(\d+)mmh", field)
        )
        missing = "SegmentID" not in fields and "Segment_ID" not in fields
        invalid = 0
        for row in reader.iterShapeRecords():
            geographic, reason = geographic_geometry(row.shape, crs)
            invalid += reason is not None
        checks.append(
            {
                "layer": filename,
                "features": len(reader),
                "steps": steps,
                "invalidGeometry": invalid,
                "sourceCrs": crs.to_string(),
                "metadataLimitation": (
                    "Source layer lacks stable basin/segment identifiers; no join identifier invented"
                    if missing
                    else None
                ),
            }
        )
    return checks


def old_thresholds(archive, record, receipt):
    from build_rainfall_thresholds import verify_metadata, verify_values

    features, checks = [], []
    for filename in archive.namelist():
        match = re.fullmatch(
            r"(.+)_(Basin|Segment)_RainfallEstimates_15min_RainAtP_50\.shp", filename
        )
        if not match or match[1].rsplit("/", 1)[-1] not in assessment_identifiers(record):
            continue
        base, scope = filename[:-4], match[2].lower()
        reader, crs = native_reader(archive, base)
        fields, date, metadata = xml_definitions(archive, base)
        if metadata is None or date is None:
            checks.append(
                {
                    "layer": filename,
                    "status": "metadata_limited",
                    "reason": "Threshold metadata date missing",
                }
            )
            continue
        definitions = verify_metadata(metadata, date)
        rows = matching_source_parts(reader, record)
        exclusions = Counter()
        first_feature = len(features)
        for row in rows:
            attributes = row.record.as_dict()
            try:
                depth, intensity = verify_values(
                    [row], attributes["Fire_ID"], attributes["Fire_Segme"], attributes["L_X1"]
                )
            except ValueError as error:
                exclusions[str(error)] += 1
                continue
            geometry, reason = geographic_geometry(row.shape, crs)
            features.append(
                old_threshold_feature(
                    row, geometry, reason, scope, filename, crs, date, definitions, depth, intensity
                )
            )
        status = "available" if len(features) > first_feature else "coverage_limited"
        if not rows:
            status = "match_unresolved"
        checks.append(
            {
                "layer": filename,
                "status": status,
                "matchedFeatures": len(rows),
                "excludedThresholdValues": dict(exclusions),
                "metadataSha256": hashlib.sha256(metadata).hexdigest(),
            }
        )
    return features, checks


def old_threshold_feature(
    row, geometry, reason, scope, filename, crs, date, definitions, depth, intensity
):
    attributes = row.record.as_dict()
    values = {}
    for key in (
        "Fire_ID",
        "Fire_Segme",
        "Segment_ID",
        "Fire_Name",
        "Start_Date",
        "UpArea_km2",
        "L_X1",
        "RainAccAtP",
        "RainIntAtP",
    ):
        values[key] = attributes[key]
    return {
        "type": "Feature",
        "geometry": geometry,
        "properties": {
            "assessmentId": attributes["Fire_Segme"],
            "scope": scope,
            "depthMm": depth,
            "intensityMmH": intensity,
            "sourceMetadataDate": date,
            "assessmentDate": None,
            "version": "Dated archive snapshot; no numbered version supplied",
            "durationMinutes": 15,
            "probability": 0.5,
            "sourceLayer": filename,
            "sourceCrs": crs.to_string(),
            "definitions": definitions,
            "mapped": geometry is not None,
            "limitation": reason,
            "sourceFeatureIndex": row.record.oid,
            "observationAssociation": None,
            "sourceAttributes": values,
        },
    }


def inspect_archive(record, release, file, category="rain"):
    path, receipt = retrieve_attachment(release, file)
    cache_key = (record["id"], receipt["sha256"], category)
    if cache_key in ARCHIVE_RESULTS:
        return ARCHIVE_RESULTS[cache_key]
    with zipfile.ZipFile(path) as archive:
        if archive.testzip():
            raise ValueError("Assessment ZIP integrity failed")
        scenarios, thresholds, threshold_checks = [], [], []
        if category == "rain":
            scenarios = inspect_old_scenarios(archive, record)
            if not scenarios:
                scenarios = inspect_wide_scenarios(archive, release)
        if category == "thresholds":
            thresholds, threshold_checks = old_thresholds(archive, record, receipt)
        result = {
            "source": receipt,
            "scenarios": scenarios,
            "thresholds": thresholds,
            "thresholdChecks": threshold_checks,
            "files": archive.namelist(),
        }
    ARCHIVE_RESULTS.clear()
    ARCHIVE_RESULTS[cache_key] = result
    return result


def aggregate_status(results):
    for status in (
        "available",
        "access_failed",
        "processing_failed",
        "quality_failed",
        "metadata_limited",
        "match_unresolved",
        "coverage_limited",
    ):
        if any(row["status"] == status for row in results):
            return status
    return "no_match"


def check_legacy(record, release, category):
    files = {file["name"]: file for file in release.get("files", [])}
    wide = any(name.endswith("-field-descriptions.txt") for name in files)
    if wide and category == "rain":
        return build_wide_scenarios(record, release)
    if category == "rain":
        return build_old_scenarios(record, release)
    checks, features, sources = [], [], []
    for file in linked_archives(record, release):
        try:
            result = inspect_archive(record, release, file, category)
            sources.append(result["source"])
            features.extend(result["thresholds"])
            checks.extend(result["thresholdChecks"])
        except (OSError, ValueError, KeyError, zipfile.BadZipFile) as error:
            status = source_error_status(error)
            checks.append({"file": file["name"], "status": status, "reason": str(error)})
    if features:
        return save_threshold_product(record, release, features, checks, sources)
    status = aggregate_status(checks)
    if not checks:
        status = "metadata_limited"
    reason = "Linked source attachments inspected; original attribute, geometry and metadata limitations retained. No values inferred."
    if wide and category == "thresholds":
        reason = "Threshold values are present but stable basin/segment identifiers are absent; display-only source rows do not establish threshold or observation joins."
    return {"status": status, "checks": checks, "sources": sources, "reason": reason}


def old_scenario_properties(attributes, step):
    validate_scenario_values(attributes, step)
    properties = {}
    fields = (
        ("P", "P", "PCl_Legend"),
        ("V", "Volume", "VolCl_Lege"),
        ("H", "CombHazCl", "CombHazCl_"),
    )
    for prefix, value_field, label_field in fields:
        value, label = attributes[value_field], attributes[label_field]
        if value is None and label == "NULL":
            properties[f"{prefix}_{step}_LG_source"] = label
            label = None
        if value is not None and (not isinstance(label, str) or not label):
            raise ValueError("Source scenario category label missing")
        properties[f"{prefix}_{step}"] = value
        properties[f"{prefix}_{step}_LG"] = label
    return properties


def append_old_scenario(collection, archive, layer, record, digest):
    reader, crs = native_reader(archive, layer["layer"][:-4])
    rows = matching_source_parts(reader, record)
    first = not collection["features"]
    if not first and len(rows) != len(collection["features"]):
        raise ValueError("Source feature count changes between rainfall steps")
    for index, row in enumerate(rows):
        attributes = row.record.as_dict()
        geometry, reason = geographic_geometry(row.shape, crs)
        if first:
            props = {
                "sourceFeatureIndex": row.record.oid,
                "sourceLayer": layer["layer"],
                "archiveSha256": digest,
                "mapped": reason is None,
                "sourceIgnition": source_day(attributes["Start_Date"]),
                "sourceAssessmentReference": attributes["Fire_Segme"],
                "sourceScenarioReferences": {},
            }
            collection["features"].append(
                {"type": "Feature", "geometry": geometry, "properties": props}
            )
        feature = collection["features"][index]
        props = feature["properties"]
        if (
            feature["geometry"] != geometry
            or props["sourceAssessmentReference"] != attributes["Fire_Segme"]
        ):
            raise ValueError("Source geometry or identity changes between rainfall steps")
        props.update(old_scenario_properties(attributes, layer["intensity"]))
        props["sourceScenarioReferences"][str(layer["intensity"])] = {
            "layer": layer["layer"],
            "row": row.record.oid,
        }


def old_scenario_header(record, release, receipt, checks, terms, collections):
    dates = {layer["sourceMetadataDate"] for layer in checks}
    if len(dates) != 1 or None in dates:
        raise ValueError("Unique source metadata date unavailable")
    date = next(iter(dates))
    ignitions = set()
    for kind in ("basins", "segments"):
        for feature in collections[kind]["features"]:
            ignitions.add(feature["properties"]["sourceIgnition"])
    if len(ignitions) != 1 or None in ignitions:
        raise ValueError("Source scenario ignition dates disagree")
    metadata = {
        "Start Date": next(iter(ignitions)),
        "Assessment Date": None,
        "Version": "Dated archive; no numbered version supplied",
    }
    result = wide_scenario_header(record, release, metadata, "\n".join(sorted(terms)), [receipt])
    result["sourceMetadataDate"] = date
    result["metadataLimitations"] = [
        "Assessment date and numbered version are not separately supplied; the per-layer metadata date is "
        + date
        + "."
    ]
    guides = []
    for layer in checks:
        guide = layer.get("bundleGuide")
        if guide and guide not in guides:
            guides.append(guide)
    result["bundleGuides"] = guides
    if any(guide["rainfallDefinitionConflict"] for guide in guides):
        result["metadataLimitations"].append(
            "The bundle guide calls M1_R an intensity. The layer XML calls it 15-minute accumulation; stored values agree with the filename intensity divided by four. The existing XML/filename consistency rule is retained. Volume units are verified from this bundle's guide."
        )
    result["sourceLayerChecks"] = checks
    return result


def old_scenario_collections(archive, record, receipt, checks):
    collections, terms = {}, set()
    for scope, kind in (("basin", "basins"), ("segment", "segments")):
        layers = sorted(
            (row for row in checks if row["scope"] == scope), key=lambda row: row["intensity"]
        )
        collection = {"type": "FeatureCollection", "features": []}
        if len({row["intensity"] for row in layers}) != len(layers):
            raise ValueError("Duplicate source scenario layer")
        for layer in layers:
            append_old_scenario(collection, archive, layer, record, receipt["sha256"])
            root = ET.fromstring(archive.read(layer["layer"] + ".xml"))
            terms.update(node.text.strip() for node in root.findall(".//useconst") if node.text)
        collections[kind] = collection
        collections[kind + "Steps"] = [row["intensity"] for row in layers]
    if not terms:
        raise ValueError("Source reuse terms unavailable")
    if not collections["basinsSteps"] or collections["basinsSteps"] != collections["segmentsSteps"]:
        raise ValueError("Source basin and segment scenario steps differ")
    return collections, terms


def old_scenario_perimeter(archive, record):
    names = []
    for name in archive.namelist():
        prefix = name.rsplit("/", 1)[-1].removesuffix("_perim_feat.shp")
        if name.endswith("_perim_feat.shp") and prefix in assessment_identifiers(record):
            names.append(name)
    if len(names) != 1:
        raise ValueError("Unique linked assessment perimeter missing")
    reader, crs = native_reader(archive, names[0][:-4])
    features = []
    for row in reader.iterShapeRecords():
        geometry, reason = geographic_geometry(row.shape, crs)
        if reason:
            raise ValueError("Invalid source perimeter; no repair applied")
        features.append({"type": "Feature", "geometry": geometry, "properties": {"mapped": True}})
    return {"type": "FeatureCollection", "features": features}


def build_old_scenarios(record, release):
    files = linked_archives(record, release)
    if len(files) != 1:
        return {
            "status": "match_unresolved",
            "reason": "Unique linked scenario archive unavailable",
        }
    inspected = inspect_archive(record, release, files[0])
    checks = inspected["scenarios"]
    if not checks or any(
        row.get("metadataLimitation") or not row.get("features") for row in checks
    ):
        return {
            "status": "metadata_limited",
            "checks": checks,
            "sources": [inspected["source"]],
            "reason": "Source units, dates or matched scenario features remain unverified",
        }
    path, receipt = retrieve_attachment(release, files[0])
    with zipfile.ZipFile(path) as archive:
        collections, terms = old_scenario_collections(archive, record, receipt, checks)
        result = old_scenario_header(record, release, receipt, checks, terms, collections)
        for kind in ("basins", "segments"):
            result[kind] = collections[kind]
        result["steps"] = collections["basinsSteps"]
        result["perimeter"] = old_scenario_perimeter(archive, record)
    result["unmappedSourceFeatureIndices"] = []
    for feature in result["basins"]["features"]:
        if not feature["properties"]["mapped"]:
            result["unmappedSourceFeatureIndices"].append(
                feature["properties"]["sourceFeatureIndex"]
            )
    if any(not feature["properties"]["mapped"] for feature in result["segments"]["features"]):
        raise ValueError("Invalid source channel geometry; no repair applied")
    return save_old_scenarios(record, release, receipt, result)


def save_old_scenarios(record, release, receipt, result):
    result["defaultIntensity"] = max(result["steps"])
    result["classes"] = source_category_order(
        [result["basins"], result["segments"]], result["steps"]
    )
    result["bounds"] = collection_bounds(result)
    result["featureCounts"] = {
        kind: len(result[kind]["features"]) for kind in ("basins", "segments", "perimeter")
    }
    result["responseShares"] = scenario_response_shares(
        result["basins"], result["steps"], result["classes"]
    )
    output = (
        PUBLIC
        / "data/waves"
        / (record["id"].replace(":", "-") + "-" + release["id"] + "-rain-scenarios.json")
    )
    if output.exists():
        previous = json.loads(output.read_text(encoding="utf-8"))
        if {key: value for key, value in previous.items() if key != "responseShares"} != {
            key: value for key, value in result.items() if key != "responseShares"
        }:
            raise ValueError("Prepared legacy scenarios changed; existing values retained")
    if not output.exists() or previous != result:
        save_json(output, result)
    return {
        "status": "available",
        "preparedUrl": "/" + output.relative_to(PUBLIC).as_posix(),
        "source": receipt,
        "records": result["featureCounts"],
        "metadataLimitations": result["metadataLimitations"],
        "reason": "Original source values retained; bundle guide volume units verified, rainfall wording conflict disclosed, no observation joins invented.",
    }


def wide_metadata(record, release):
    documents, sources = {}, []
    for file in release["files"]:
        if file["name"].endswith(("-metadata.txt", "-field-descriptions.txt", ".xml")):
            path, receipt = retrieve_attachment(release, file)
            documents[file["name"]] = path.read_text(encoding="utf-8-sig")
            sources.append(receipt)
    text = next(value for key, value in documents.items() if key.endswith("-metadata.txt"))
    metadata = {}
    for line in text.splitlines():
        if ": " in line:
            key, value = line.split(": ", 1)
            metadata[key] = value
    if fire_name(metadata["Name"]) != fire_name(record["name"]):
        raise ValueError("Legacy assessment name does not match its catalog fire")
    identifiers = assessment_identifiers(record)
    if identifiers and metadata.get("Fire ID") not in identifiers:
        raise ValueError(
            "Legacy assessment fire identifier disagrees with the verified release link"
        )
    dates = {source.get("ignition") for source in record.get("sources", [])}
    dates.add(record.get("ignition"))
    if metadata["Start Date"] not in dates:
        raise ValueError("Legacy assessment ignition day does not match a verified source day")
    if metadata.get("State") not in ("CA", "California") or not source_day(
        metadata.get("Assessment Date")
    ):
        raise ValueError("Legacy assessment state or assessment date is unverified")
    definitions = {}
    description = next(
        value for key, value in documents.items() if key.endswith("-field-descriptions.txt")
    )
    for line in description.splitlines():
        if "|" in line:
            key, value = line.split("|", 1)
            definitions[key.strip()] = value.strip()
    licenses = []
    for name, content in documents.items():
        if name.endswith(".xml"):
            licenses.extend(
                node.text or "" for node in ET.fromstring(content).findall(".//useconst")
            )
    if not any("CC0" in value for value in licenses):
        raise ValueError("Legacy release reuse terms not verified")
    return metadata, definitions, " ".join(licenses), sources


def wide_steps(fields, definitions):
    steps = []
    for field in fields:
        match = re.fullmatch(r"P_(\d+)mmh", field)
        if match:
            steps.append(int(match[1]))
    if not steps:
        raise ValueError("No published legacy rainfall scenarios")
    for step in steps:
        for prefix in ("P", "V", "H"):
            key = f"{prefix}_{step}mmh"
            if key not in fields or key + "_LG" not in fields:
                raise ValueError("Incomplete legacy scenario fields")
            if f"peak 15-minute rainfall intensity of {step} mm/hour" not in definitions.get(
                key, ""
            ):
                raise ValueError("Legacy scenario intensity or duration not verified")
        if "meters^3" not in definitions.get(f"V_{step}mmh", ""):
            raise ValueError("Legacy volume units not verified")
    return sorted(steps)


def wide_properties(attributes, steps, index, layer, digest):
    properties = {"sourceFeatureIndex": index, "sourceLayer": layer, "archiveSha256": digest}
    for step in steps:
        for prefix in ("P", "V", "H"):
            original = f"{prefix}_{step}mmh"
            value, label = attributes[original], attributes[original + "_LG"]
            if value is None and label == "NULL":
                properties[f"{prefix}_{step}_LG_source"] = label
                label = None
            if value is not None and (
                not isinstance(value, (int, float)) or not math.isfinite(value) or value < 0
            ):
                raise ValueError("Invalid legacy estimate; no missing code replaced")
            if value is not None and prefix == "P" and value > 1:
                raise ValueError("Legacy likelihood is not a fraction")
            if value is not None and prefix == "H" and value not in (1, 2, 3):
                raise ValueError("Legacy combined class is not 1, 2 or 3")
            properties[f"{prefix}_{step}"] = value
            properties[f"{prefix}_{step}_LG"] = label
    return properties


def wide_layer(archive, base, definitions, digest, perimeter=False):
    reader, crs = native_reader(archive, base)
    fields = {field[0] for field in reader.fields[1:]}
    steps = [] if perimeter else wide_steps(fields, definitions)
    features, excluded = [], []
    for index, row in enumerate(reader.iterShapeRecords()):
        geometry, reason = geographic_geometry(row.shape, crs)
        props = {"mapped": reason is None}
        if not perimeter:
            props.update(wide_properties(row.record.as_dict(), steps, index, base + ".shp", digest))
            if reason:
                excluded.append(index)
        elif reason:
            raise ValueError("Invalid legacy perimeter; no repair applied")
        features.append({"type": "Feature", "properties": props, "geometry": geometry})
    return {"type": "FeatureCollection", "features": features}, steps, excluded


def source_category_order(collections, steps):
    values = {"P": {}, "V": {}, "H": {}}
    for collection in collections:
        for feature in collection["features"]:
            props = feature["properties"]
            for step in steps:
                for prefix in values:
                    label, value = props[f"{prefix}_{step}_LG"], props[f"{prefix}_{step}"]
                    if label is not None and value is not None:
                        values[prefix][label] = min(value, values[prefix].get(label, value))
    classes = {}
    for prefix, categories in values.items():
        classes[prefix] = sorted(categories, key=categories.get)
    return classes


def build_wide_scenarios(record, release):
    metadata, definitions, license_text, sources = wide_metadata(record, release)
    archives = linked_archives(record, release)
    if len(archives) != 1:
        raise ValueError("Legacy source archive is not unique")
    path, receipt = retrieve_attachment(release, archives[0])
    sources.append(receipt)
    result = wide_scenario_header(record, release, metadata, license_text, sources)
    with zipfile.ZipFile(path) as archive:
        for kind in ("basins", "segments", "perimeter"):
            names = [
                name[:-4]
                for name in archive.namelist()
                if name.rsplit("/", 1)[-1] == metadata["Fire ID"] + "-" + kind + ".shp"
            ]
            if len(names) != 1:
                raise ValueError("Unique legacy " + kind + " layer is missing")
            collection, steps, excluded = wide_layer(
                archive, names[0], definitions, receipt["sha256"], kind == "perimeter"
            )
            if kind != "perimeter":
                if result.get("steps") and result["steps"] != steps:
                    raise ValueError("Legacy basin and segment scenarios differ")
                result["steps"] = steps
            result[kind] = collection
            if kind == "basins":
                result["unmappedSourceFeatureIndices"] = excluded
            elif excluded:
                raise ValueError("Invalid legacy channel geometry; no repair applied")
    result["defaultIntensity"] = max(result["steps"])
    result["classes"] = source_category_order(
        [result["basins"], result["segments"]], result["steps"]
    )
    result["bounds"] = collection_bounds(result)
    result["featureCounts"] = {
        kind: len(result[kind]["features"]) for kind in ("basins", "segments", "perimeter")
    }
    result["responseShares"] = scenario_response_shares(
        result["basins"], result["steps"], result["classes"]
    )
    output = (
        PUBLIC
        / "data/waves"
        / (record["id"].replace(":", "-") + "-" + release["id"] + "-rain-scenarios.json")
    )
    if output.exists():
        previous = json.loads(output.read_text(encoding="utf-8"))
        if {key: value for key, value in previous.items() if key != "responseShares"} != {
            key: value for key, value in result.items() if key != "responseShares"
        }:
            raise ValueError("Prepared legacy scenarios changed; existing values retained")
    if not output.exists() or previous != result:
        save_json(output, result)
    return {
        "status": "available",
        "preparedUrl": "/" + output.relative_to(PUBLIC).as_posix(),
        "source": receipt,
        "records": result["featureCounts"],
        "reason": "Original values and source-row references retained; no watershed identifiers or observation joins invented.",
    }


def wide_scenario_header(record, release, metadata, license_text, sources):
    dates = {row["type"]: row.get("dateString") for row in release.get("dates", [])}
    return {
        "schemaVersion": 1,
        "releaseId": release["id"],
        "fireId": record["id"],
        "name": record["name"],
        "version": metadata.get("Version"),
        "ignition": metadata["Start Date"],
        "assessmentDate": metadata["Assessment Date"],
        "publicationDate": dates.get("Publication"),
        "sourceUrl": "https://www.sciencebase.gov/catalog/item/" + release["id"],
        "retrievedAt": sources[-1]["retrievedAt"],
        "dataClass": "Historical",
        "license": license_text,
        "sources": sources,
        "durationMinutes": 15,
        "intensityUnit": "mm/hour",
        "volumeUnit": "m3",
        "unmappedBasinIds": [],
        "identityKind": "source-row",
        "previousAssessment": None,
        "processing": "Source-file row indices and archive checksum identify display features only, not watersheds or observation matches. Supplied scenario values and labels retained; no interpolation or geometry repair.",
    }


def collection_bounds(result):
    extents = []
    for kind in ("basins", "segments", "perimeter"):
        for feature in result[kind]["features"]:
            if feature["geometry"]:
                extents.append(shape(feature["geometry"]).bounds)
    if not extents:
        raise ValueError("No valid source geometry")
    return [
        min(box[0] for box in extents),
        min(box[1] for box in extents),
        max(box[2] for box in extents),
        max(box[3] for box in extents),
    ]


def save_threshold_product(record, release, features, checks, sources):
    if not features:
        return {
            "status": "no_match",
            "checks": checks,
            "sources": sources,
            "reason": "Original threshold fields checked; no finite positive threshold pair was supplied.",
        }
    filename = record["id"].replace(":", "-") + "-" + release["id"] + ".json"
    path = PUBLIC / "data/historical-fires/thresholds" / filename
    value = {
        "schemaVersion": 1,
        "fireId": record["id"],
        "releaseId": release["id"],
        "dataClass": "Historical",
        "sourceUrl": "https://www.sciencebase.gov/catalog/item/" + release["id"],
        "sources": sources,
        "checks": checks,
        "type": "FeatureCollection",
        "features": features,
        "limitation": "Agency estimates, not guaranteed triggers or current warnings. Source basin/segment features are not new observation matches.",
    }
    if path.exists():
        previous = json.loads(path.read_text(encoding="utf-8"))
        if previous != value:
            raise ValueError("Previously prepared threshold values differ")
    else:
        save_json(path, value)
    identities = {
        (feature["properties"]["scope"], feature["properties"]["assessmentId"])
        for feature in features
    }
    return {
        "status": "available",
        "records": len(identities),
        "sourceFeatureParts": len(features),
        "checks": checks,
        "preparedUrl": "/" + path.relative_to(PUBLIC).as_posix(),
        "sources": sources,
        "reason": "Source-supplied 15-minute 50% thresholds retained; no new observation association or threshold computation.",
    }


def check_rain_release(record, release, receipt):
    names = {file["name"] for file in release.get("files", [])}
    if not {"metadata.json", "GeoJSON.zip"}.issubset(names):
        return check_legacy(record, release, "rain")
    from build_waves_case import build_rain_scenarios

    output = build_rain_scenarios(
        {
            "id": record["id"].replace(":", "-") + "-" + release["id"],
            "name": record["name"],
            "rainArchive": {"releaseId": release["id"]},
            "discoverArchive": True,
        }
    )
    return {
        "status": "available",
        "preparedUrl": "/" + output.relative_to(PUBLIC).as_posix(),
        "source": receipt,
        "reason": "Published scenarios validated with existing reader; no new estimates computed.",
    }


def retained_rain(record):
    path = PUBLIC / record["evidenceUrl"].lstrip("/")
    if not path.exists():
        return None
    evidence = json.loads(path.read_text(encoding="utf-8"))
    if evidence["fireId"] != record["id"]:
        raise ValueError("Existing assessment export belongs to another fire")
    url = evidence.get("rainUrl")
    if url and (PUBLIC / url.lstrip("/")).is_file():
        return {
            "status": "available",
            "preparedUrl": url,
            "reason": "Existing verified scenario values retained unchanged",
        }
    return None


def check_assessment(record, source):
    if source == "travel":
        return check_travel(record)
    if source == "rain":
        retained = retained_rain(record)
        if retained:
            return retained
    results = []
    if source == "thresholds":
        from build_historical_observations import check_observation_thresholds

        supplement = check_observation_thresholds(record)
        if supplement:
            results.append(supplement)
    links = release_links(record)
    if not links and not results:
        return unlinked_result(record)
    for url in links:
        try:
            release, receipt = read_release(url)
            if source == "rain":
                result = check_rain_release(record, release, receipt)
            else:
                result = check_threshold_release(record, release, receipt)
            results.append({**result, "sourceUrl": url})
        except (OSError, ValueError, KeyError) as error:
            status = source_error_status(error)
            results.append({"status": status, "sourceUrl": url, "reason": str(error)})
    status = aggregate_status(results)
    prepared = [row["preparedUrl"] for row in results if row.get("preparedUrl")]
    return {
        "status": status,
        "releaseChecks": results,
        "preparedUrls": prepared,
        "preparedUrl": prepared[0] if len(prepared) == 1 else None,
        "reason": "Every linked assessment release checked independently; source dates and versions remain separate.",
    }


def check_threshold_release(record, release, receipt):
    files = {file["name"]: file for file in release.get("files", [])}
    if not {"metadata.json", "GeoJSON.zip"}.issubset(files):
        return check_legacy(record, release, "thresholds")
    path, source = retrieve_attachment(release, files["GeoJSON.zip"])
    counts = {}
    with zipfile.ZipFile(path) as archive:
        for kind in ("basins", "segments"):
            collection = json.loads(archive.read(kind + ".geojson"))
            fields = set()
            for feature in collection["features"]:
                fields.update(feature["properties"])
            counts[kind] = len(collection["features"])
            if not {"I15_50", "R15_50"}.issubset(fields):
                return {
                    "status": "coverage_limited",
                    "source": source,
                    "recordsChecked": counts,
                    "reason": "Linked original feature tables do not supply both 15-minute 50% threshold fields; design scenarios are not thresholds.",
                }
    return modern_thresholds(record, release, files, path, source)


def modern_thresholds(record, release, files, path, receipt):
    metadata_path, metadata_source = retrieve_attachment(release, files["metadata.json"])
    metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
    if fire_name(metadata["fire"]["name"]) != fire_name(record["name"]):
        return {"status": "match_unresolved", "reason": "Linked release fire name differs"}
    definitions, units = {}, {}
    for name, file in files.items():
        if name.endswith(".xml"):
            xml_path, _ = retrieve_attachment(release, file)
            for attr in ET.parse(xml_path).findall(".//attr"):
                definitions[attr.findtext("attrlabl")] = attr.findtext("attrdef") or ""
                units[attr.findtext("attrlabl")] = attr.findtext(".//attrunit") or ""
    for key, unit in (("I15_50", "Millimeters per hour"), ("R15_50", "Millimeters")):
        if (
            "15-minute" not in definitions.get(key, "")
            or "50%" not in definitions.get(key, "")
            or units.get(key) != unit
        ):
            return {
                "status": "metadata_limited",
                "reason": "Threshold probability, duration or units not verified in release metadata",
            }
    features = []
    with zipfile.ZipFile(path) as archive:
        for kind in ("basins", "segments"):
            collection = json.loads(archive.read(kind + ".geojson"))
            features.extend(modern_threshold_features(collection, kind, metadata, definitions))
    return save_threshold_product(record, release, features, [], [receipt, metadata_source])


def modern_threshold_features(collection, scope, metadata, definitions):
    crs = CRS.from_user_input(collection["crs"]["properties"]["name"])
    identifiers, features = set(), []
    for feature in collection["features"]:
        values = feature["properties"]
        identifier = values.get("SegmentID")
        if not isinstance(identifier, int) or identifier in identifiers:
            raise ValueError("Duplicate or missing source threshold SegmentID")
        identifiers.add(identifier)
        depth, intensity = values.get("R15_50"), values.get("I15_50")
        if depth is None or intensity is None:
            continue
        if not all(
            isinstance(value, (int, float)) and math.isfinite(value) and value > 0
            for value in (depth, intensity)
        ):
            raise ValueError("Invalid threshold values; no missing code replaced")
        if not math.isclose(depth, intensity * 15 / 60, abs_tol=1e-8):
            raise ValueError("Published threshold depth and intensity disagree")
        source_geometry = shape(feature["geometry"]) if feature["geometry"] else None
        geometry, reason = geographic_geometry(source_geometry, crs)
        features.append(
            {
                "type": "Feature",
                "geometry": geometry,
                "properties": {
                    "assessmentId": identifier,
                    "scope": scope.rstrip("s"),
                    "depthMm": depth,
                    "intensityMmH": intensity,
                    "assessmentDate": metadata["assessment"]["date"],
                    "version": metadata["version"]["version"],
                    "durationMinutes": 15,
                    "probability": 0.5,
                    "sourceLayer": scope + ".geojson",
                    "sourceCrs": crs.to_string(),
                    "definitions": {key: definitions[key] for key in ("I15_50", "R15_50")},
                    "mapped": geometry is not None,
                    "limitation": reason,
                    "observationAssociation": None,
                    "sourceAttributes": values,
                },
            }
        )
    return features


def travel_index():
    global TRAVEL_INDEX
    if TRAVEL_INDEX is not None:
        return TRAVEL_INDEX
    from build_runout_data import COLLECTION

    items, sources, offset = [], [], 0
    while True:
        url = "https://www.sciencebase.gov/catalog/items?" + urlencode(
            {"filter": "parentId=" + COLLECTION, "format": "json", "max": 100, "offset": offset}
        )
        path, receipt = download("runout-coverage-collection-" + str(offset) + ".json", url)
        page = json.loads(path.read_text(encoding="utf-8"))
        items.extend(page["items"])
        sources.append(receipt)
        offset += len(page["items"])
        if offset == page["total"]:
            break
        if not page["items"] or offset > page["total"]:
            raise ValueError("Runout collection pagination is incomplete")
    if len({item["id"] for item in items}) != len(items):
        raise ValueError("Duplicate runout release identity")
    TRAVEL_INDEX = (items, sources)
    return TRAVEL_INDEX


def check_travel(record):
    items, receipts = travel_index()
    linked = record.get("runout")
    if not linked:
        candidates = []
        for item in items:
            title = re.match(r"^(.*?) (\d{4}-\d{2}-\d{2}) v", item.get("title", ""))
            if (
                title
                and fire_name(title[1]) == fire_name(record["name"])
                and int(title[2][:4]) == record["year"]
            ):
                candidates.append(item["id"])
        return {
            "status": "match_unresolved" if candidates else "no_match",
            "candidates": candidates,
            "sources": receipts,
            "reason": "Complete official runout collection checked; no verified release link for this fire.",
        }
    if linked["assessmentId"] not in {item["id"] for item in items}:
        return {
            "status": "metadata_limited",
            "reason": "Previously linked runout release absent from current checked collection",
        }
    path = PUBLIC / linked["url"].lstrip("/")
    if not path.is_file():
        restore_travel_manifest(linked, path)
    if hashlib.sha256(path.read_bytes()).hexdigest() != linked["sha256"]:
        raise ValueError("Prepared runout manifest differs from verified release")
    manifest = json.loads(path.read_text(encoding="utf-8"))
    count = 0
    for scenario in manifest["scenarios"]:
        scenario_path = PUBLIC / scenario["url"].lstrip("/")
        if not scenario_path.is_file():
            restore_travel_contour(linked, scenario, scenario_path)
        content = scenario_path.read_bytes()
        if hashlib.sha256(content).hexdigest() != scenario["sha256"]:
            raise ValueError("Prepared travel geometry differs from verified release")
        count += len(json.loads(content)["features"])
    return {
        "status": "available",
        "preparedUrl": linked["url"],
        "records": count,
        "sources": receipts,
        "reason": "Published runout contours and source scenarios retained unchanged",
    }


def restore_baseline_file(path, digest):
    baseline = ROOT / "data/raw/historical-coverage/baseline/public-json.zip"
    if not baseline.exists():
        return False
    name = path.relative_to(PUBLIC / "data").as_posix()
    with zipfile.ZipFile(baseline) as archive:
        candidates = [name, "data/" + name, "frontend/public/data/" + name]
        for candidate in candidates:
            if candidate not in archive.namelist():
                continue
            content = archive.read(candidate)
            if hashlib.sha256(content).hexdigest() != digest:
                raise ValueError("Baseline artifact differs from the verified runout checksum")
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(content)
            return True
    return False


def restore_travel_manifest(linked, path):
    if restore_baseline_file(path, linked["sha256"]):
        return
    from build_runout_data import CATALOG_RAW, prepare_release

    release, receipt = read_release(linked["sourceUrl"])
    files = {file["name"]: file for file in release.get("files", [])}
    metadata_path, metadata_source = retrieve_attachment(release, files["metadata.json"])
    metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
    if (
        metadata["fire"]["start_date"] != linked["ignition"]
        or metadata["assessment"]["date"] != linked["assessmentDate"]
    ):
        raise ValueError("Runout source dates changed; previous release cannot be reconstructed")
    url = (
        "https://earthquake.usgs.gov/arcgis/rest/services/ls/pwfdf/MapServer/0/query?"
        + urlencode(
            {
                "f": "json",
                "where": "1=1",
                "outFields": "*",
                "returnGeometry": "false",
                "resultRecordCount": 2000,
            }
        )
    )
    locations_path, locations_source = download("runout-coverage-locations.json", url)
    locations = json.loads(locations_path.read_text(encoding="utf-8"))
    if locations.get("exceededTransferLimit"):
        raise ValueError("USGS assessment listing incomplete")
    provenance = {
        "release": receipt,
        "metadata.json": metadata_source,
        "locations": locations_source,
    }
    prepare_release(
        release,
        metadata,
        CATALOG_RAW / release["id"],
        [feature["attributes"] for feature in locations["features"]],
        provenance,
    )
    if hashlib.sha256(path.read_bytes()).hexdigest() != linked["sha256"]:
        raise ValueError(
            "Reconstructed manifest provenance differs from the pinned snapshot; review required"
        )


def restore_travel_contour(linked, scenario, path):
    if restore_baseline_file(path, scenario["sha256"]):
        return
    from build_runout_data import prepare_scenario

    release, receipt = read_release(linked["sourceUrl"])
    files = {file["name"]: file for file in release.get("files", [])}
    archive_path, source = retrieve_attachment(release, files["GeoJSON.zip"])
    filename = "I15_" + format(scenario["intensity"], "g") + "-simulation_index.geojson"
    with zipfile.ZipFile(archive_path) as archive:
        original = json.loads(archive.read(filename))
    prepared = prepare_scenario(original, scenario["intensity"])
    content = json.dumps(prepared, separators=(",", ":"), allow_nan=False).encode()
    if hashlib.sha256(content).hexdigest() != scenario["sha256"]:
        raise ValueError("Reconstructed contour differs from its pinned source values")
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(content)


def refresh_prepared_shares():
    root = PUBLIC / "data/historical-fires"
    eligible = json.loads((root / "scope.json").read_text(encoding="utf-8"))["eligibleFireIds"]
    years = {}
    paths = set()
    for fire_id in eligible:
        year = fire_id.split(":")[1]
        if year not in years:
            records = json.loads((root / f"{year}.json").read_text(encoding="utf-8"))["records"]
            years[year] = {record["id"]: record for record in records}
        record = years[year][fire_id]
        evidence = json.loads(
            (PUBLIC / record["evidenceUrl"].lstrip("/")).read_text(encoding="utf-8")
        )
        if evidence.get("rainUrl"):
            paths.add(PUBLIC / evidence["rainUrl"].lstrip("/"))
    for path in sorted(paths):
        result = json.loads(path.read_text(encoding="utf-8"))
        shares = scenario_response_shares(result["basins"], result["steps"], result["classes"])
        if result.get("responseShares") != shares:
            result["responseShares"] = shares
            save_json(path, result)
    print(f"Checked {len(paths)} linked rainfall exports for area shares")


if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser()
    parser.add_argument("--refresh-prepared-shares", action="store_true")
    args = parser.parse_args()
    if args.refresh_prepared_shares:
        refresh_prepared_shares()
