import hashlib
import json
import math
import re
import argparse
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlencode
from zipfile import ZipFile

import numpy as np
from pyproj import CRS, Transformer
from shapely import transform, get_coordinates
from shapely.geometry import mapping, shape, Point
from shapely.ops import unary_union

ROOT = Path(__file__).resolve().parents[1]
RAW = ROOT / "data/raw/eaton-runout"
CATALOG_RAW = ROOT / "data/raw/runout-catalog"
PUBLIC = ROOT / "frontend/public/data/runout"
COLLECTION = "6851e986d4be027dac17f0ae"
LEVELS = [0, 0.3, 0.6]


def cached(name, url, directory=RAW):
    from build_waves_data import download

    path, receipt = download(directory.name + "-" + name, url)
    return path, {
        "url": receipt["sourceUrl"],
        "retrieved": receipt["retrievedAt"],
        "bytes": receipt["bytes"],
        "sha256": receipt["sha256"],
    }


def prepare_scenario(data, intensity):
    crs = CRS.from_user_input(data["crs"]["properties"]["name"])
    if not crs.is_projected or crs.axis_info[0].unit_name != "metre":
        raise ValueError("Source must use projected metres")
    features = data["features"]
    if len(features) != 3 or sorted(f["properties"]["dfsi_thr"] for f in features) != LEVELS:
        raise ValueError("Unexpected contour levels")
    project = Transformer.from_crs(crs, 4326, always_xy=True).transform
    inverse = Transformer.from_crs(4326, crs, always_xy=True).transform
    native = {}
    result = []
    for feature in features:
        properties = feature["properties"]
        if properties["I15"] != intensity:
            raise ValueError("Scenario does not match filename")
        original = shape(feature["geometry"])
        if original.is_empty or not original.is_valid:
            raise ValueError("Invalid runout geometry")
        native[properties["dfsi_thr"]] = original
        geographic = transform(original, project, interleaved=False)
        restored = transform(geographic, inverse, interleaved=False)
        difference = np.abs(get_coordinates(original) - get_coordinates(restored))
        if not geographic.is_valid or difference.max() > 0.001:
            raise ValueError("Coordinate conversion failed")
        west, south, east, north = geographic.bounds
        if not (-125 < west <= east < -113 and 32 < south <= north < 43):
            raise ValueError("Unexpected California coordinates")
        result.append(
            {"type": "Feature", "properties": properties, "geometry": mapping(geographic)}
        )
    for lower, upper in [(0, 0.3), (0.3, 0.6)]:
        if not native[lower].covers(native[upper]):
            raise ValueError("Contours are not nested within this scenario")
    result.sort(key=lambda f: f["properties"]["dfsi_thr"])
    return {"type": "FeatureCollection", "features": result}


def source_file(files, name, directory, provenance):
    file = files[name]
    path, provenance[name] = cached(name, file["url"], directory)
    content = path.read_bytes()
    if len(content) != file["size"]:
        raise ValueError("Source size changed")
    checksum = file.get("checksum", {})
    if checksum.get("type") == "MD5" and hashlib.md5(content).hexdigest() != checksum["value"]:
        raise ValueError("Source checksum changed")
    return path


def inside_fire(record, bbox):
    return (
        isinstance(record.get("lon"), (int, float))
        and isinstance(record.get("lat"), (int, float))
        and bbox["left"] < record["lon"] < bbox["right"]
        and bbox["bottom"] < record["lat"] < bbox["top"]
    )


def link_catalogs(metadata, directory, locations, provenance):
    fire = metadata["fire"]
    bbox = fire["bbox"]
    name = fire["name"].upper()
    query = urlencode(
        {
            "service": "WFS",
            "version": "2.0.0",
            "request": "GetFeature",
            "typeNames": "mtbs:fire_polygons",
            "outputFormat": "application/json",
            "srsName": "EPSG:4326",
            "CQL_FILTER": "incid_name='" + name.replace("'", "''") + "'",
        }
    )
    path, provenance["mtbs"] = cached(
        "mtbs-name.json", "https://edcintl.cr.usgs.gov/geoserver/wfs?" + query, directory
    )
    candidates = []
    point = Point((bbox["left"] + bbox["right"]) / 2, (bbox["bottom"] + bbox["top"]) / 2)
    response = json.loads(path.read_text())
    if response.get("numberMatched", len(response["features"])) != len(response["features"]):
        raise ValueError("MTBS response is incomplete")
    for feature in response["features"]:
        row = feature["properties"]
        if (
            row.get("map_prog") == "MTBS"
            and row["incid_name"] == name
            and row["ig_date"][:10] == fire["start_date"]
            and shape(feature["geometry"]).contains(point)
        ):
            candidates.append(
                {
                    "mapId": row["map_id"],
                    "eventId": row["event_id"],
                    "name": name,
                    "ignition": fire["start_date"],
                }
            )
    if len(candidates) > 1:
        raise ValueError("MTBS association is ambiguous")
    matching = []
    related = []
    for row in locations:
        if row["fire"].upper() != name or not inside_fire(row, bbox):
            continue
        day = datetime.fromtimestamp(row["start_date"] / 1000, timezone.utc).date().isoformat()
        if day == fire["start_date"]:
            matching.append(row)
        else:
            related.append(row)
    if len(matching) > 1:
        raise ValueError("USGS association is ambiguous")

    return (
        candidates[0] if candidates else None,
        matching[0] if matching else None,
        related[0] if len(related) == 1 and candidates else None,
    )


def prepare_release(item, metadata, directory, locations, provenance):
    identifier = item["id"]
    fire = metadata["fire"]
    assessment = metadata["assessment"]
    version = metadata["version"]["version"]
    if item.get("parentId") != COLLECTION or "CC0" not in item.get("rights", ""):
        raise ValueError("Release identity or license differs")
    dates = {date["type"]: date["dateString"] for date in item["dates"]}
    if (
        dates["FireStart"] != fire["start_date"]
        or dates["Assessment"] != assessment["date"]
        or metadata["version"]["spec"]["version"] != "1.0.0"
    ):
        raise ValueError("Assessment metadata differs")
    intensities = assessment["models"]["runout"]["parameters"]["I15"]
    if (
        not intensities
        or len(set(intensities)) != len(intensities)
        or any(not isinstance(value, (int, float)) or value <= 0 for value in intensities)
    ):
        raise ValueError("Rainfall scenarios are invalid")
    intensities = sorted(intensities)
    files = {file["name"]: file for file in item["files"]}
    archive_path = source_file(files, "GeoJSON.zip", directory, provenance)
    config_name = "config.yml" if "config.yml" in files else "configuration.yml"
    config = source_file(files, config_name, directory, provenance).read_text()
    source_file(files, "version.txt", directory, provenance)
    cutoffs = re.findall(r"^\s*depth_thresh:\s*([0-9.]+)\s*$", config, re.MULTILINE)
    if len(cutoffs) != 1:
        raise ValueError("Depth cutoff is unverified")
    match, agency_match, related = link_catalogs(metadata, directory, locations, provenance)
    if not match and not agency_match:
        raise ValueError("No confirmed catalog association")
    prepared = []
    display_bounds = []
    previous_outer = None
    cross_scenario_nested = True
    key = re.sub(r"[^a-z0-9]+", "-", fire["name"].lower()).strip("-")
    with ZipFile(archive_path) as archive:
        if archive.testzip():
            raise ValueError("Archive integrity check failed")
        expected = {f"I15_{value:g}-simulation_index.geojson" for value in intensities}
        actual = {name for name in archive.namelist() if name.endswith("-simulation_index.geojson")}
        if expected != actual:
            raise ValueError("Scenario files differ from metadata")
        for intensity in intensities:
            data = json.loads(archive.read(f"I15_{intensity:g}-simulation_index.geojson"))
            collection = prepare_scenario(data, intensity)
            for feature in collection["features"]:
                display_bounds.append(shape(feature["geometry"]).bounds)
            for feature in data["features"]:
                if feature["properties"]["dfsi_thr"] == 0:
                    outer = shape(feature["geometry"])
                    if previous_outer is not None and not outer.covers(previous_outer):
                        cross_scenario_nested = False
                    previous_outer = outer
            content = json.dumps(collection, separators=(",", ":"), allow_nan=False).encode()
            digest = hashlib.sha256(content).hexdigest()
            filename = f"{key}-{intensity:g}-{digest[:12]}.geojson"
            prepared.append(
                (
                    filename,
                    content,
                    {
                        "intensity": intensity,
                        "url": "/data/runout/" + filename,
                        "bytes": len(content),
                        "sha256": digest,
                    },
                )
            )
        basins = json.loads(archive.read("basins.geojson"))["features"]
        invalid_basins = sum(not shape(f["geometry"]).is_valid for f in basins)
        if "preliminary or provisional" not in archive.read("readme.txt").decode():
            raise ValueError("Review changed source disclaimer")
    extent = assessment["bbox"]
    source = "https://www.sciencebase.gov/catalog/item/" + identifier
    manifest = {
        "version": 1,
        "assessmentId": identifier,
        "name": fire["name"],
        "ignition": fire["start_date"],
        "assessmentDate": assessment["date"],
        "publicationDate": dates["Publication"],
        "assessmentVersion": version,
        "sourceUrl": source,
        "license": "CC0 1.0",
        "provisional": True,
        "bounds": [
            min(b[0] for b in display_bounds),
            min(b[1] for b in display_bounds),
            max(b[2] for b in display_bounds),
            max(b[3] for b in display_bounds),
        ],
        "studyBounds": [extent["left"], extent["bottom"], extent["right"], extent["top"]],
        "match": match,
        "agencyMatch": agency_match,
        "model": assessment["models"]["runout"]["name"],
        "terrain": assessment["input_datasets"]["dem"]["source"],
        "depthCutoffMetres": float(cutoffs[0]),
        "assessmentAgeDays": (
            datetime.fromisoformat(assessment["date"]) - datetime.fromisoformat(fire["start_date"])
        ).days,
        "sourceCrs": data["crs"]["properties"]["name"],
        "displayCrs": "EPSG:4326",
        "scenarios": [record for _, _, record in prepared],
        "sources": provenance,
        "audit": {
            "runoutFeatures": len(intensities) * 3,
            "invalidRunoutFeatures": 0,
            "basinFeatures": len(basins),
            "invalidBasinFeatures": invalid_basins,
            "basinsDisplayed": False,
            "withinScenarioNested": True,
            "crossScenarioNested": cross_scenario_nested,
            "note": "Fire-level identities only; no watershed crosswalk or live-assessment version join.",
        },
    }
    PUBLIC.mkdir(parents=True, exist_ok=True)
    for filename, content, _ in prepared:
        (PUBLIC / filename).write_bytes(content)
    content = (json.dumps(manifest, indent=2) + "\n").encode()
    (PUBLIC / f"{identifier}.json").write_bytes(content)
    print(
        f"{fire['name']}: {len(intensities)} scenarios; {invalid_basins}/{len(basins)} invalid basins omitted."
    )
    return {
        "assessmentId": identifier,
        "name": fire["name"],
        "ignition": fire["start_date"],
        "assessmentDate": assessment["date"],
        "publicationDate": dates["Publication"],
        "assessmentVersion": version,
        "sourceUrl": source,
        "match": match,
        "agencyMatch": agency_match,
        "relatedAgency": related,
        "intensities": intensities,
        "url": f"/data/runout/{identifier}.json",
        "sha256": hashlib.sha256(content).hexdigest(),
    }


def main():
    parser = argparse.ArgumentParser(
        description="Prepare every compatible California release in the official USGS runout collection.\n\nReceives official release files; checks original geometry and transforms coordinates only.\n"
    )
    parser.add_argument(
        "--refresh", action="store_true", help="Cache a new official catalog snapshot"
    )
    parser.add_argument(
        "--companion-release",
        help="Export one cached release's basin estimates without rebuilding existing products",
    )
    parser.add_argument(
        "--companions",
        action="store_true",
        help="Prepare basin estimates for every installed compatible release",
    )
    args = parser.parse_args()
    if args.companions:
        catalog = json.loads((PUBLIC / "catalog.json").read_text())
        for entry in catalog["releases"]:
            prepare_companion(entry["assessmentId"])
        return
    if args.companion_release:
        prepare_companion(args.companion_release)
        return
    snapshot = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    catalog_directory = CATALOG_RAW / snapshot if args.refresh else CATALOG_RAW
    outline = json.loads((ROOT / "frontend/public/data/california-outline.geojson").read_text())
    california = unary_union([shape(feature["geometry"]) for feature in outline["features"]])
    listing = []
    listing_sources = []
    offset = 0
    while True:
        url = "https://www.sciencebase.gov/catalog/items?" + urlencode(
            {"filter": "parentId=" + COLLECTION, "format": "json", "max": 100, "offset": offset}
        )
        path, source = cached(f"collection-{offset}.json", url, catalog_directory)
        page = json.loads(path.read_text())
        listing_sources.append(source)
        listing.extend(page["items"])
        offset += len(page["items"])
        if offset >= page["total"]:
            break
        if not page["items"]:
            raise ValueError("Collection pagination is incomplete")
    if len({item["id"] for item in listing}) != len(listing):
        raise ValueError("Duplicate collection release")
    location_url = (
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
    path, location_source = cached("usgs-locations.json", location_url, catalog_directory)
    response = json.loads(path.read_text())
    if response.get("exceededTransferLimit"):
        raise ValueError("USGS location response is incomplete")
    locations = [feature["attributes"] for feature in response["features"]]
    releases = []
    excluded = []
    for record in listing:
        identifier = record["id"]
        directory = CATALOG_RAW / identifier
        try:
            path, item_source = cached(
                "release.json",
                "https://www.sciencebase.gov/catalog/item/" + identifier + "?format=json",
                catalog_directory / identifier,
            )
            item = json.loads(path.read_text())
            files = {file["name"]: file for file in item["files"]}
            provenance = {"release": item_source, "locations": location_source}
            path = source_file(files, "metadata.json", directory, provenance)
            metadata = json.loads(path.read_text())
            bbox = metadata["fire"]["bbox"]
            point = Point((bbox["left"] + bbox["right"]) / 2, (bbox["bottom"] + bbox["top"]) / 2)
            if not california.contains(point):
                excluded.append(
                    {
                        "id": identifier,
                        "title": item["title"],
                        "sourceUrl": "https://www.sciencebase.gov/catalog/item/" + identifier,
                        "status": "outside_scope",
                        "reason": "Outside California; not imported.",
                    }
                )
                continue
            releases.append(prepare_release(item, metadata, directory, locations, provenance))
        except (OSError, ValueError, KeyError) as error:
            status = "inaccessible" if isinstance(error, OSError) else "incompatible"
            excluded.append(
                {
                    "id": identifier,
                    "title": record["title"],
                    "sourceUrl": "https://www.sciencebase.gov/catalog/item/" + identifier,
                    "status": status,
                    "reason": str(error),
                }
            )
            print(record["title"], "unavailable:", error)
    catalog = {
        "version": 1,
        "checkedAt": snapshot,
        "collectionUrl": "https://www.sciencebase.gov/catalog/item/" + COLLECTION,
        "sources": listing_sources,
        "releaseCount": len(listing),
        "releases": releases,
        "excluded": excluded,
    }
    PUBLIC.mkdir(parents=True, exist_ok=True)
    (PUBLIC / "catalog.json").write_text(json.dumps(catalog, indent=2) + "\n")
    print(
        f"Published {len(releases)} California releases; audited {len(listing)} collection records."
    )


def prepare_companion(identifier):
    catalog = json.loads((PUBLIC / "catalog.json").read_text())
    entries = [entry for entry in catalog["releases"] if entry["assessmentId"] == identifier]
    if len(entries) != 1:
        raise ValueError("A unique installed runout release is required")
    entry = entries[0]
    manifest_bytes = (ROOT / "frontend/public" / entry["url"].lstrip("/")).read_bytes()
    if hashlib.sha256(manifest_bytes).hexdigest() != entry["sha256"]:
        raise ValueError("Installed runout manifest changed")
    directory = CATALOG_RAW / identifier
    source_url = entry["sourceUrl"]
    path, release_source = cached("release.json", source_url + "?format=json", directory)
    release = json.loads(path.read_text())
    if release["id"] != identifier or "CC0" not in release.get("rights", ""):
        raise ValueError("Release identity or reuse terms changed")
    files = {file["name"]: file for file in release["files"]}
    sources = {"release": release_source}
    metadata_path = source_file(files, "metadata.json", directory, sources)
    metadata = json.loads(metadata_path.read_text())
    assessment = metadata["assessment"]
    steps = entry["intensities"]
    if (
        assessment["date"] != entry["assessmentDate"]
        or metadata["version"]["version"] != entry["assessmentVersion"]
        or metadata["fire"]["name"] != entry["name"]
        or metadata["fire"]["start_date"] != entry["ignition"]
        or assessment["models"]["likelihood"]["parameters"]["I15"] != steps
        or assessment["models"]["volume"]["parameters"]["I15"] != steps
    ):
        raise ValueError("Companion and runout scenarios differ")
    archive_path = source_file(files, "GeoJSON.zip", directory, sources)
    with ZipFile(archive_path) as archive:
        if archive.testzip():
            raise ValueError("Archive integrity check failed")
        native = json.loads(archive.read("basins.geojson"))
        cartography = archive.read("cartography.txt").decode()
    bands = likelihood_legend(cartography)
    colors = [band["color"] for band in bands]
    if metadata["assessment"]["models"]["runout"]["parameters"]["I15"] != steps:
        raise ValueError("Runout and basin rainfall scenarios differ")
    crs = CRS.from_user_input(native["crs"]["properties"]["name"])
    if not crs.is_projected or crs.axis_info[0].unit_name != "metre":
        raise ValueError("Basin source must use projected metres")
    project = Transformer.from_crs(crs, 4326, always_xy=True).transform
    inverse = Transformer.from_crs(4326, crs, always_xy=True).transform
    features = []
    assessed_areas = []
    excluded = []
    identifiers = set()
    for feature in native["features"]:
        properties = dict(feature["properties"])
        basin_id = properties["SegmentID"]
        if not isinstance(basin_id, int) or basin_id in identifiers:
            raise ValueError("Duplicate or invalid basin identifier")
        identifiers.add(basin_id)
        for step in steps:
            for prefix in ["P", "V"]:
                value = properties[f"{prefix}_{step}"]
                if value is not None and (
                    not isinstance(value, (int, float))
                    or not np.isfinite(value)
                    or value < 0
                    or (prefix == "P" and value > 1)
                ):
                    raise ValueError("Invalid source estimate")
        original = shape(feature["geometry"])
        reason = None
        geographic = None
        if original.is_empty or not original.is_valid:
            reason = "Invalid source basin geometry; no repair or replacement"
        else:
            geographic = transform(original, project, interleaved=False)
            restored = transform(geographic, inverse, interleaved=False)
            if (
                not geographic.is_valid
                or geographic.geom_type not in ["Polygon", "MultiPolygon"]
                or np.abs(get_coordinates(original) - get_coordinates(restored)).max() > 0.001
            ):
                raise ValueError("Basin coordinate conversion failed")
            west, south, east, north = geographic.bounds
            if not (-125 < west <= east < -113 and 32 < south <= north < 43):
                raise ValueError("Unexpected basin coordinates")
            assessed_areas.append((properties, original.area))
        properties["mapped"] = reason is None
        properties["exclusionReason"] = reason
        if reason:
            excluded.append(basin_id)
        features.append(
            {
                "type": "Feature",
                "properties": properties,
                "geometry": mapping(geographic) if geographic is not None else None,
            }
        )
    manifest = json.loads(manifest_bytes)
    if (
        len(features) != manifest["audit"]["basinFeatures"]
        or len(excluded) != manifest["audit"]["invalidBasinFeatures"]
    ):
        raise ValueError("Basin coverage differs from checked runout release")
    output = {
        "schemaVersion": 1,
        "releaseId": identifier,
        "name": entry["name"],
        "ignition": entry["ignition"],
        "assessmentDate": entry["assessmentDate"],
        "publicationDate": entry["publicationDate"],
        "version": entry["assessmentVersion"],
        "sourceUrl": source_url,
        "license": "CC0 1.0",
        "dataClass": "Historical",
        "retrievedAt": sources["GeoJSON.zip"]["retrieved"],
        "durationMinutes": 15,
        "intensityUnit": "mm/hour",
        "volumeUnit": "m3",
        "steps": steps,
        "sourceCrs": crs.to_string(),
        "displayCrs": "EPSG:4326",
        "bounds": manifest["studyBounds"],
        "unmappedBasinIds": excluded,
        "likelihoodBreaks": [band["low"] for band in bands[1:]],
        "likelihoodColors": colors,
        "likelihoodLabels": [band["label"] for band in bands],
        "volumeRamp": json.loads(
            (ROOT / "data/map_display_rules.json").read_text(encoding="utf-8")
        )["volumeRamp"],
        "initialization": metadata["assessment"]["models"]["runout"]["parameters"],
        "volumeNote": "Continuous cubic-metre estimates; no supplied Combined categories",
        "basins": {"type": "FeatureCollection", "features": features},
        "sources": sources,
    }
    has_probabilities = True
    for basin_props, _ in assessed_areas:
        for scenario_step in steps:
            if basin_props[f"P_{scenario_step}"] is None:
                has_probabilities = False
                break
        if not has_probabilities:
            break
    if assessed_areas and has_probabilities:
        total_area = sum(area for _, area in assessed_areas)
        if not math.isfinite(total_area) or total_area <= 0:
            raise ValueError("Assessed basin area is invalid")
        top_class = bands[-1]
        response = []
        for step in steps:
            top_area = sum(
                area for props, area in assessed_areas if props[f"P_{step}"] >= top_class["low"]
            )
            percent = 100 * top_area / total_area
            if not math.isfinite(percent) or not 0 <= percent <= 100:
                raise ValueError("Scenario area share is outside 0-100%")
            response.append({"intensity": step, "percent": round(percent, 3)})
        output["responseShares"] = {
            "likelihood": {"topClass": top_class["label"], "steps": response}
        }
    filename = f"{identifier}-basins.json"
    existing_path = PUBLIC / filename
    if existing_path.exists():
        reviewed = json.loads(existing_path.read_text(encoding="utf-8"))
        for key, value in reviewed.items():
            if key not in ("responseShares", "retrievedAt", "sources") and json.dumps(
                output.get(key), sort_keys=True
            ) != json.dumps(value, sort_keys=True):
                raise ValueError(f"Prepared companion {key} changed; review required")
        output = {**reviewed, "responseShares": output.get("responseShares", {})}
        if output == reviewed:
            content = existing_path.read_bytes()
            print(
                json.dumps(
                    {
                        "releaseId": identifier,
                        "url": "/data/runout/" + filename,
                        "sha256": hashlib.sha256(content).hexdigest(),
                        "basins": len(features),
                        "unmapped": len(excluded),
                        "bytes": len(content),
                    }
                )
            )
            return
    content = json.dumps(output, separators=(",", ":"), allow_nan=False).encode()
    (PUBLIC / filename).write_bytes(content)
    print(
        json.dumps(
            {
                "releaseId": identifier,
                "url": "/data/runout/" + filename,
                "sha256": hashlib.sha256(content).hexdigest(),
                "basins": len(features),
                "unmapped": len(excluded),
                "bytes": len(content),
            }
        )
    )


def likelihood_legend(cartography):
    rows = re.findall(r"\|\s*\[([\d.]+),\s*([\d.]+)([)\]])\s*\|\s*(#[a-fA-F0-9]{6})", cartography)
    bands = []
    previous = 0
    for low_text, high_text, closing, color in rows:
        low, high = float(low_text), float(high_text)
        if low != previous or not low < high <= 1:
            raise ValueError("Review discontinuous likelihood bins")
        upper = "<" if closing == ")" else ""
        bands.append(
            {
                "low": low,
                "high": high,
                "color": color,
                "label": f"{low * 100:g}-{upper}{high * 100:g}%",
            }
        )
        previous = high
    if not bands or previous != 1:
        raise ValueError("Likelihood legend unavailable in release cartography")
    return bands


if __name__ == "__main__":
    main()
