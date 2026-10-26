import xml.etree.ElementTree as ET
import json
import re
import html
import hashlib
import io
from zipfile import ZipFile
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib.parse import urlencode, urljoin
from zoneinfo import ZoneInfo

from shapely.geometry import Point, shape
from shapely.ops import unary_union
from shapely.errors import GEOSException

from build_goes_smoke import (
    BUCKET,
    GUIDE,
    CoverageUnavailable,
    SourceFormatUnavailable,
    read_frame,
    render,
)
from build_waves_case import PUBLIC, save_json
from build_waves_data import download

GOES_YEARS = None
SEVERITY_MANIFEST = None
SEVERITY_KEYS = {}
ANNUAL_MOSAICS = {}
MTBS_CANDIDATES = None
ORIGINAL_PRODUCTS = None
REPLAY_GROUND = None
MOSAIC_INDEX = None
BAER_INDEX = None
DOWNLOAD_INTERFACE = None
BAER_RELEASES = None
RASTER_EXCLUSIONS = None
GROUND_POLICY = None


class MetadataUnavailable(ValueError):
    pass


def missing_mtbs_link(record):
    from historical_identity import fire_name

    global MTBS_CANDIDATES
    if MTBS_CANDIDATES is None:
        path = PUBLIC / "data/historical-fires/source-records.json"
        MTBS_CANDIDATES = {}
        for source in json.loads(path.read_text(encoding="utf-8")):
            if source.get("mtbs"):
                key = (fire_name(source["name"]), source.get("ignition"))
                MTBS_CANDIDATES.setdefault(key, []).append(source["id"])
    candidates = MTBS_CANDIDATES.get((fire_name(record["name"]), record.get("ignition")), [])
    if candidates:
        return {
            "status": "match_unresolved",
            "reason": "MTBS index has name/day candidates without the required unique spatial association",
            "candidates": candidates,
        }
    if not record.get("ignition"):
        return {
            "status": "metadata_limited",
            "reason": "Official fire metadata lacks the exact day required by the existing MTBS matching rule",
        }
    return {
        "status": "no_match",
        "reason": "Checked MTBS source index contains no exact name/day candidate",
        "sourceUrl": "https://www.mtbs.gov/",
    }


def severity_manifest():
    global SEVERITY_MANIFEST
    if SEVERITY_MANIFEST is None:
        path = PUBLIC / "data/fire-burn-summaries.json"
        SEVERITY_MANIFEST = json.loads(path.read_text(encoding="utf-8"))
        for row in SEVERITY_MANIFEST["records"]:
            key = (row["mapId"], row["eventId"])
            if key in SEVERITY_KEYS:
                raise ValueError("Duplicate MTBS summary identity")
            SEVERITY_KEYS[key] = row
    return SEVERITY_MANIFEST


def numeric_severity(record):
    import rasterio
    from build_fire_burn_summaries import mosaic, summarize, geometry_hash, GeometryUnavailable
    from build_historical_evidence import perimeter_for

    if not record.get("mtbs"):
        return missing_mtbs_link(record)
    output = severity_manifest()
    source = record["mtbs"]
    key = (source["map_id"], source["event_id"])
    if key in SEVERITY_KEYS:
        return {"status": "available", "reason": "Existing numeric MTBS summary retained unchanged"}
    geometry, boundary_source = perimeter_for({"id": record["id"], "mtbs": source})
    if len(geometry["features"]) != 1:
        return {
            "status": "quality_failed",
            "reason": "MTBS map identifier did not resolve to one source boundary",
        }
    year = int(source["ig_date"][:4])
    available, index_source = original_mosaic_available(year)
    if not available:
        return {
            "status": "coverage_limited",
            "reason": "Checked annual release index has no original-grid mosaic for this year; no service-grid substitute is used",
            "source": index_source,
        }
    if year not in ANNUAL_MOSAICS:
        ANNUAL_MOSAICS[year] = mosaic(year)
    raster, receipt = ANNUAL_MOSAICS[year]
    try:
        with rasterio.open(raster) as dataset:
            summary = summarize(dataset, geometry["features"][0]["geometry"])
    except GeometryUnavailable as error:
        return {"status": "quality_failed", "reason": str(error)}
    if not sum(summary["counts"][1:6]):
        return {
            "status": "coverage_limited",
            "reason": "Checked numeric mosaic has no assessed cells inside the source boundary",
            "source": receipt,
        }
    row = {
        "mapId": key[0],
        "eventId": key[1],
        "name": source["incid_name"],
        "year": year,
        "ignition": source["ig_date"][:10],
        "postId": source.get("post_id"),
        "updatedAt": source.get("updated_at"),
        "geometrySha256": geometry_hash(geometry["features"][0]["geometry"]),
        "boundarySource": boundary_source,
        "rasterSha256": receipt["rasterSha256"],
        **summary,
    }
    append_severity(output, key, row, receipt)
    return {
        "status": "available",
        "reason": "Numeric MTBS source cells checked",
        "preparedUrl": "/data/fire-burn-summaries.json",
    }


def original_mosaic_available(year):
    from build_fire_burn_summaries import cached, COLLECTION

    global MOSAIC_INDEX
    if MOSAIC_INDEX is None:
        index_path, receipt = cached("burn-area-mosaic-collection.json", COLLECTION)
        listing = json.loads(index_path.read_text(encoding="utf-8"))
        if listing.get("total", len(listing["items"])) != len(listing["items"]):
            raise ValueError("Incomplete numeric mosaic index")
        MOSAIC_INDEX = (listing["items"], receipt)
    items, receipt = MOSAIC_INDEX
    matches = []
    for item in items:
        if f"Mosaic for {year} (" in item["title"]:
            matches.append(item)
    if len(matches) > 1:
        raise ValueError("Multiple original annual mosaics require source review")
    return bool(matches), receipt


def append_severity(output, key, row, receipt):
    output["records"].append(row)
    if not any(item.get("rasterSha256") == receipt["rasterSha256"] for item in output["sources"]):
        output["sources"].append(receipt)
    save_json(PUBLIC / "data/fire-burn-summaries.json", output)
    SEVERITY_KEYS[key] = row


def original_ground_products():
    global ORIGINAL_PRODUCTS, REPLAY_GROUND
    if ORIGINAL_PRODUCTS is not None:
        return ORIGINAL_PRODUCTS
    observation_fires = {}
    for path in sorted((PUBLIC / "data/historical-fires/observations").glob("*.json")):
        data = json.loads(path.read_text(encoding="utf-8"))
        for observation in data["records"]:
            previous = observation_fires.get(observation["id"])
            if previous and previous != data["fireId"]:
                raise ValueError("One observation belongs to multiple resolved fire identities")
            observation_fires[observation["id"]] = data["fireId"]
    ORIGINAL_PRODUCTS = {}
    original = json.loads((PUBLIC / "data/catalog.json").read_text(encoding="utf-8"))
    for case in original["cases"]:
        fire = observation_fires.get(case["observationId"])
        if fire is None:
            raise ValueError("Original case lacks its verified fire association")
        ORIGINAL_PRODUCTS.setdefault(fire, []).append(case["products"])
    replays = json.loads((PUBLIC / "data/waves/ground.json").read_text(encoding="utf-8"))
    REPLAY_GROUND = {}
    for case in replays["cases"]:
        if case["id"] in REPLAY_GROUND:
            raise ValueError("Duplicate reviewed terrain identity")
        REPLAY_GROUND[case["id"]] = case
    return ORIGINAL_PRODUCTS


def retained_ground(record, source):
    products = original_ground_products().get(record["id"], [])
    kind = "severity" if source == "case_severity" else source
    kinds = ["pre", "post"] if source == "imagery" else [kind]
    files = []
    for product in products:
        for name in kinds:
            layer = product["layers"].get(name, {})
            if layer.get("status") == "available":
                files.append(layer["file"])
    if source == "slope" and record.get("replayId") in REPLAY_GROUND:
        layer = REPLAY_GROUND[record["replayId"]]["layers"]["slope"]
        if layer["status"] == "available":
            files.append(layer["file"])
    for file in files:
        path = PUBLIC / file.lstrip("/") if file.startswith("/") else PUBLIC / "data" / file
        if not path.is_file():
            return {
                "status": "processing_failed",
                "reason": "A retained verified product file is missing",
                "file": file,
            }
    if files:
        return {
            "status": "available",
            "reason": "Existing verified ground products retained unchanged",
            "files": files,
        }
    return None


def check_ground(record, source):
    from build_historical_coverage import source_error_status

    try:
        if source == "severity":
            return numeric_severity(record)
        retained = retained_ground(record, source)
        if retained:
            return retained
        if source == "slope":
            return check_terrain(record)
        if source in ("imagery", "dnbr", "case_severity"):
            return check_original_download(record, source)
        raise ValueError("Unknown ground source category")
    except MetadataUnavailable as error:
        return {"status": "metadata_limited", "reason": str(error)}
    except (ValueError, GEOSException) as error:
        return {"status": "quality_failed", "reason": str(error)}
    except KeyError:
        raise
    except LookupError as error:
        return {"status": "coverage_limited", "reason": str(error)}
    except OSError as error:
        return {"status": source_error_status(error), "reason": str(error)}


def check_terrain(record):
    from build_historical_evidence import load_evidence, save_evidence
    from build_waves_ground import SLOPE_CONTEXT_METRES, SLOPE_CONTEXT_SHAPE, SLOPE_OUTSIDE_ALPHA

    evidence = load_evidence(record)
    context = evidence.get("context", {})
    if context.get("slope", {}).get("status") == "available":
        path = PUBLIC / context["slope"]["file"].lstrip("/")
        if not path.is_file():
            return {"status": "processing_failed", "reason": "Prepared terrain file is missing"}
        if (
            context["slope"].get("contextBufferMetres") == SLOPE_CONTEXT_METRES
            and context["slope"].get("contextShape") == SLOPE_CONTEXT_SHAPE
            and context["slope"].get("outsideAlpha") == SLOPE_OUTSIDE_ALPHA
            and context["slope"].get("fireSteepPercent") is not None
        ):
            return {"status": "available", "reason": "Existing fire terrain retained unchanged"}
    geometry, receipt, footprint = ground_inputs(record)
    if geometry is None:
        return {"status": "match_unresolved", "reason": receipt["reason"]}
    if footprint is None:
        return missing_footprint(record)
    product = terrain(record, geometry, footprint)
    product["boundarySource"] = receipt
    evidence["context"] = product
    evidence.setdefault("perimeter", {**receipt, "value": geometry})
    evidence.setdefault("checks", {})["context"] = {
        "status": "available",
        "reason": "Original 3DEP windows processed and checked",
    }
    save_evidence(PUBLIC / record["evidenceUrl"].lstrip("/"), evidence, "context")
    return {
        "status": "available",
        "reason": "Original 3DEP windows processed and checked",
        "preparedUrl": record["evidenceUrl"],
        "scope": {
            "fireId": record["id"],
            "boundarySource": receipt,
            "displayFootprint": footprint,
            "spatialRelationship": "Slope in a rectangle extending 3 km past each edge of the verified fire boundary's projected bounding box",
            "measurementPeriod": None,
            "periodStatus": "not_supplied; elevation is not a fire-date measurement",
            "sourceUrls": [product["slope"]["sourceUrl"]],
        },
    }


def ground_policy():
    global GROUND_POLICY
    if GROUND_POLICY is None:
        path = PUBLIC.parent.parent / "data/historical_coverage_sources.json"
        GROUND_POLICY = json.loads(path.read_text(encoding="utf-8"))
    return GROUND_POLICY


def established_footprint(record):
    from build_historical_evidence import load_evidence

    evidence = load_evidence(record)
    original_slope = evidence.get("context", {}).get("slope", {})
    if original_slope.get("inputFootprint"):
        return list(original_slope["inputFootprint"])
    layers = evidence.get("groundProducts", {}).get("layers", {})
    candidates = [layers.get(role, {}) for role in ("pre", "post", "dnbr", "severity", "slope")]
    candidates.append(evidence.get("context", {}).get("slope", {}))
    for layer in candidates:
        if layer.get("status") == "available" and layer.get("bounds"):
            return list(layer["bounds"])
    return None


def missing_footprint(record):
    return {
        "status": "metadata_limited",
        "reason": "No established display footprint; no new margin or buffer was created",
        "scope": {"fireId": record["id"], "blockedBy": "footprint"},
    }


def ground_inputs(record):
    from build_historical_evidence import perimeter_for, load_evidence

    footprint = established_footprint(record)
    if footprint is not None:
        evidence = load_evidence(record)
        original = evidence.get("groundProducts", {}).get("displayFootprintSource", {})
        if not original.get("displayFootprintChoice"):
            original = evidence.get("context", {}).get("boundarySource", {})
        if original.get("displayFootprintChoice"):
            geometry, receipt = perimeter_for({"id": record["id"], "mtbs": record["mtbs"]})
            if (
                receipt["sha256"] != original["sha256"]
                or footprint != original["displayFootprintChoice"]["bounds"]
            ):
                raise ValueError("Previously approved MTBS footprint or source boundary changed")
            return geometry, original, footprint
        geometry, receipt = ground_perimeter(record)
        return geometry, receipt, footprint
    policy = ground_policy().get("groundFootprintPolicy", {})
    if not policy.get("useVerifiedMtbsBoundaryExtent") or not record.get("mtbs"):
        geometry, receipt = ground_perimeter(record)
        return geometry, receipt, None
    geometry, receipt = perimeter_for({"id": record["id"], "mtbs": record["mtbs"]})
    if geometry is None:
        return geometry, receipt, None
    if len(geometry["features"]) != 1:
        raise ValueError("MTBS boundary identity does not resolve to one original polygon")
    footprint = list(shape(geometry["features"][0]["geometry"]).bounds)
    receipt = {
        **receipt,
        "displayFootprintChoice": {
            "policy": policy,
            "mapId": record["mtbs"]["map_id"],
            "bounds": footprint,
            "padding": 0,
        },
    }
    return geometry, receipt, footprint


def ground_boundary_candidates(record):
    candidates = [(record, record.get("source", "Preferred source"))]
    if record.get("boundaryUrl") and record.get("mtbs"):
        candidates.append(({"id": record["id"], "mtbs": record["mtbs"]}, "MTBS"))
    if (record.get("boundaryUrl") or record.get("mtbs")) and record.get("assessment"):
        candidates.append(
            ({"id": record["id"], "assessment": record["assessment"]}, "USGS fire perimeter")
        )
    return candidates


def ground_perimeter(record):
    from build_historical_evidence import perimeter_for

    policy = ground_policy()["groundBoundaryPolicy"]
    rejected = []
    for candidate, source in ground_boundary_candidates(record):
        try:
            geometry, receipt = perimeter_for(candidate)
            if geometry is None:
                return geometry, receipt
            for feature in geometry["features"]:
                polygon = shape(feature["geometry"])
                if (
                    not polygon.is_valid
                    or polygon.is_empty
                    or polygon.geom_type not in ("Polygon", "MultiPolygon")
                ):
                    raise ValueError("Invalid source perimeter; no automatic repair")
            if rejected:
                receipt = {
                    **receipt,
                    "boundaryChoice": {"chosen": source, "rejected": rejected, "policy": policy},
                }
            return geometry, receipt
        except (ValueError, GEOSException) as error:
            if not isinstance(error, GEOSException) and not str(error).startswith(
                "Invalid source perimeter"
            ):
                raise
            rejected.append(
                {
                    "source": source,
                    "reason": str(error),
                    "sourceUrl": candidate.get("boundaryUrl"),
                    "mapId": candidate.get("mtbs", {}).get("map_id"),
                    "assessmentId": candidate.get("assessment", {}).get("Fire_ID"),
                }
            )
            if not policy["useVerifiedAlternativeIfPreferredInvalid"]:
                raise
    raise ValueError(
        "All already-linked fire boundaries are invalid; no geometry repaired: " + str(rejected)
    )


def baer_catalog():
    from historical_identity import fire_name
    from build_historical_coverage import BATCH_SIZE

    global BAER_INDEX
    if BAER_INDEX is not None:
        return BAER_INDEX
    offset, seen, rows, receipts = 0, set(), {}, []
    while True:
        parameters = {
            "service": "WFS",
            "version": "2.0.0",
            "request": "GetFeature",
            "typeNames": "mtbs:fire_polygons",
            "outputFormat": "application/json",
            "srsName": "EPSG:4326",
            "count": BATCH_SIZE,
            "startIndex": offset,
            "sortBy": "id A",
            "propertyName": "id,map_id,map_prog,incid_name,event_id,ig_date,burnbndlon,burnbndlat,post_id,updated_at",
            "CQL_FILTER": "map_prog='BAER' AND BBOX(geom,-124.5,32.4,-114.0,42.1,'EPSG:4326')",
        }
        path, receipt = download(
            f"baer-california-catalog-{offset}.json",
            "https://edcintl.cr.usgs.gov/geoserver/wfs?" + urlencode(parameters),
        )
        page = json.loads(path.read_text(encoding="utf-8"))
        features = page.get("features", [])
        if not isinstance(page.get("numberMatched"), int) or not features:
            raise ValueError("BAER catalog pagination is incomplete")
        for feature in features:
            row = feature["properties"]
            if row["map_prog"] != "BAER" or row["id"] in seen:
                raise ValueError("Duplicate identity or unexpected BAER program")
            seen.add(row["id"])
            key = (fire_name(row["incid_name"]), row["ig_date"][:10])
            rows.setdefault(key, []).append(row)
        receipts.append(receipt)
        offset += len(features)
        if offset == page["numberMatched"]:
            break
        if offset > page["numberMatched"]:
            raise ValueError("BAER catalog response exceeded its declared count")
    BAER_INDEX = (rows, receipts)
    return BAER_INDEX


def matched_baer(record):
    from historical_identity import fire_name

    rows, receipts = baer_catalog()
    if not record.get("ignition"):
        return {
            "status": "metadata_limited",
            "reason": "Exact ignition day is required for BAER matching",
            "sources": receipts,
        }
    candidates = rows.get((fire_name(record["name"]), record["ignition"]), [])
    if not candidates:
        return {
            "status": "no_match",
            "reason": "Checked BAER index has no exact name/day candidate",
            "sources": receipts,
        }
    geometry, perimeter_source = ground_perimeter(record)
    if geometry is None:
        return {
            "status": "match_unresolved",
            "reason": "BAER name/day candidates exist but the fire has no verified polygon",
            "sources": receipts,
        }
    polygons = []
    for feature in geometry["features"]:
        polygon = shape(feature["geometry"])
        if not polygon.is_valid or polygon.geom_type not in ("Polygon", "MultiPolygon"):
            raise ValueError("Invalid original fire polygon; BAER association is not inferred")
        polygons.append(polygon)
    perimeter = unary_union(polygons)
    if not perimeter.is_valid or perimeter.geom_type not in ("Polygon", "MultiPolygon"):
        raise ValueError("Invalid original fire polygon; BAER association is not inferred")
    matches = []
    for candidate in candidates:
        longitude, latitude = candidate["burnbndlon"], candidate["burnbndlat"]
        if longitude is not None and latitude is not None:
            if perimeter.contains(Point(float(longitude), float(latitude))):
                matches.append(candidate)
    if len(matches) != 1:
        return {
            "status": "match_unresolved",
            "reason": "BAER exact name/day candidates lack one unique polygon-contained agency location",
            "candidates": candidates,
            "sources": receipts,
        }
    return {
        "status": "available",
        "record": matches[0],
        "sources": receipts,
        "boundarySource": perimeter_source,
        "matchingRule": "Exact name and ignition day; one BAER agency location strictly inside the original fire polygon; no date tolerance or nearest match",
    }


def baer_release_nodes():
    from historical_identity import fire_name

    global BAER_RELEASES
    if BAER_RELEASES is not None:
        return BAER_RELEASES
    page_number, final_page, rows, receipts = 0, 0, {}, []
    while page_number <= final_page:
        url = "https://burnseverity.cr.usgs.gov/baer/node/?page=" + str(page_number)
        path, receipt = download(f"baer-release-index-{page_number}.html", url)
        text = path.read_text(encoding="utf-8")
        pages = re.findall(r'href="[^"<>]*[?&]page=(\d+)[^"<>]*"', text)
        if pages:
            final_page = max(final_page, max(int(page) for page in pages))
        links = re.findall(r'href="(/baer/node/\d+)"[^>]*title="([^"<>]+)"', text)
        if not links:
            raise ValueError("BAER release-page format or pagination could not be verified")
        for link, title in links:
            match = re.fullmatch(r"(.+) \(([A-Z]{2}) (\d{4})\)", html.unescape(title))
            if match:
                key = (fire_name(match[1]), int(match[3]))
                entries = rows.setdefault(key, [])
                if link not in entries:
                    entries.append(link)
        receipts.append(receipt)
        page_number += 1
    BAER_RELEASES = (rows, receipts)
    return BAER_RELEASES


def baer_page_field(text, name):
    pattern = (
        r"field--name-" + re.escape(name) + r'\b[^>]*>.*?<div\s+class="field__item">(.*?)</div>'
    )
    match = re.search(pattern, text, flags=re.S)
    if match is None:
        return None
    return html.unescape(re.sub(r"<[^>]+>", "", match[1])).strip()


def older_baer_release_nodes(event_id):
    page_number, final_page, links, receipts = 0, 0, [], []
    while page_number <= final_page:
        parameters = {"keys": event_id, "page": page_number}
        url = "https://burnseverity.cr.usgs.gov/baer/search/node?" + urlencode(parameters)
        name = "baer-event-search-" + event_id.lower() + "-" + str(page_number) + ".html"
        path, receipt = download(name, url)
        text = path.read_text(encoding="utf-8")
        if "<h2>Search results</h2>" not in text and "Your search yielded no results" not in text:
            raise MetadataUnavailable("Official BAER event-search response could not be verified")
        results = re.findall(r'<h3>\s*<a href="([^"]+)"', text)
        for result in results:
            link = html.unescape(result)
            if link.startswith("https://burnseverity.cr.usgs.gov/baer/") and link not in links:
                links.append(link)
        pages = re.findall(r'href="[^"<>]*[?&](?:amp;)?page=(\d+)[^"<>]*"', text)
        if pages:
            final_page = max(final_page, max(int(page) for page in pages))
        receipts.append(receipt)
        page_number += 1
    return links, receipts


def same_baer_event_id(source, expected):
    if not isinstance(source, str) or not isinstance(expected, str):
        return False
    if ground_policy().get("baerEventIdComparison", {}).get("ignoreLetterCase"):
        return source.casefold() == expected.casefold()
    return source == expected


def baer_archives_from_links(links, record):
    verified = []
    for link in links:
        url = urljoin("https://burnseverity.cr.usgs.gov", link)
        page_name = "baer-release-" + hashlib.sha256(url.encode()).hexdigest()[:16] + ".html"
        path, receipt = download(page_name, url)
        text = path.read_text(encoding="utf-8")
        event = baer_page_field(text, "field-event-id")
        dates = re.findall(r'<time\s+datetime="(\d{4}-\d{2}-\d{2})T', text)
        if not same_baer_event_id(event, record["event_id"]) or dates != [record["ig_date"][:10]]:
            continue
        archive = baer_page_field(text, "field-preliminary-data-url")
        if (
            archive
            and archive.startswith("https://edcintl.cr.usgs.gov/")
            and archive.endswith(".zip")
        ):
            verified.append(
                {
                    "url": archive,
                    "releaseSource": receipt,
                    "releaseIdentity": {
                        "pageEventId": event,
                        "catalogEventId": record["event_id"],
                        "ignition": dates[0],
                        "comparisonRule": "Letter case only; every digit and the exact ignition day remain unchanged",
                    },
                }
            )
    return verified


def original_baer_archive(match):
    from historical_identity import fire_name

    rows, receipts = baer_release_nodes()
    record = match["record"]
    key = (fire_name(record["incid_name"]), int(record["ig_date"][:4]))
    verified = baer_archives_from_links(rows.get(key, []), record)
    if not verified:
        links, search_receipts = older_baer_release_nodes(record["event_id"])
        receipts = receipts + search_receipts
        verified = baer_archives_from_links(links, record)
    unique = {}
    for product in verified:
        unique[product["url"]] = product
    if len(unique) == 1:
        return {"status": "available", **next(iter(unique.values())), "match": match}
    reason = "No direct original-raster ZIP was found in the checked BAER release pages"
    if len(unique) > 1:
        reason = "Multiple BAER original-raster releases require assessment-version review"
    return {
        "status": "match_unresolved",
        "reason": reason,
        "match": match,
        "indexSources": receipts,
    }


def download_interface():
    global DOWNLOAD_INTERFACE
    if DOWNLOAD_INTERFACE is not None:
        return DOWNLOAD_INTERFACE
    url = "https://burnseverity.cr.usgs.gov/viewer/"
    path, receipt = download("burn-original-product-viewer.html", url)
    text = path.read_text(encoding="utf-8")
    scripts = re.findall(r'<script[^>]+src="(main\.[^"<>]+\.js)"', text)
    if len(scripts) != 1:
        raise ValueError("Official original-product download interface could not be verified")
    script, script_receipt = download("burn-original-product-viewer.js", urljoin(url, scripts[0]))
    code = script.read_text(encoding="utf-8")
    required = ("downloads/addQueue.php", "mapping_products", "mapping_ids", "emailIsValid")
    if not all(term in code for term in required):
        raise ValueError("Original-product download workflow changed; manual source review needed")
    DOWNLOAD_INTERFACE = [receipt, script_receipt]
    return DOWNLOAD_INTERFACE


def check_original_download(record, source):
    if source == "case_severity":
        return {
            "status": "no_match",
            "reason": "The original observation-display crop catalog has no verified severity crop for this fire; fire-wide numeric severity is checked separately",
        }
    baer = matched_baer(record)
    if baer["status"] == "available":
        archive = original_baer_archive(baer)
        if archive["status"] == "available":
            return prepare_baer_product(record, archive, source)
        return archive
    if record.get("mtbs"):
        return {
            "status": "access_failed",
            "reason": "Verified MTBS product identity, but the checked original-raster interface requires an emailed processing request; no request sent",
            "mtbs": record["mtbs"],
            "sources": download_interface(),
            "baerCheck": baer,
        }
    if baer["status"] != "no_match":
        return baer
    mtbs = missing_mtbs_link(record)
    return {**mtbs, "baerCheck": baer}


def baer_archive_metadata(archive, match):
    from historical_identity import fire_name

    with ZipFile(archive) as bundle:
        text_names = []
        for name in bundle.namelist():

            if re.search(r"_SBS_metadata(?:_utm)?\.(?:txt|xml)$", name, re.I):
                continue
            if re.search(r"_metadata(?:_utm)?\.(?:txt|xml)$", name, re.I):
                text_names.append(name)
        if len(text_names) != 1:
            raise MetadataUnavailable(
                "Original BAER bundle does not supply one unambiguous product metadata file"
            )
        text = bundle.read(text_names[0]).decode("utf-8-sig")
        if text_names[0].lower().endswith(".xml"):
            text = "\n".join(ET.fromstring(text).itertext())
        names = bundle.namelist()
    if "no restrictions on use" not in text.lower():
        raise MetadataUnavailable("Original BAER reuse terms require review before rendering")
    title = re.search(r"Fire Name:\s*([^\r\n]+)", text, re.I)
    if not title or fire_name(title[1]) != fire_name(match["incid_name"]):
        raise ValueError("BAER bundle fire name disagrees with the verified source identity")
    dates = baer_acquisition_dates(text)
    if not dates["pre"] < match["ig_date"][:10] <= dates["post"]:
        raise ValueError("BAER acquisition dates do not bracket the linked ignition day")
    publication = re.search(r"Publication Date:\s*(\d{4}-\d{2}-\d{2})", text, re.I)
    license_line = re.search(r"Use Constraints:\s*([^\r\n]+)", text, re.I)
    credit = re.search(r"Data Set Credit:\s*([^\r\n]+)", text, re.I)
    return {
        "text": text,
        "names": names,
        "dates": dates,
        "publicationDate": publication[1] if publication else None,
        "metadataFile": text_names[0],
        "license": license_line[1].strip() if license_line else None,
        "credit": credit[1].strip() if credit else None,
    }


def baer_acquisition_dates(text):
    dates = {}
    for role in ("Pre", "Post"):
        lines = re.findall(role + r"-Fire Imagery Date[^:]*:([^\r\n]+)", text, re.I)
        values = set()
        for line in lines:
            values.update(re.findall(r"\b\d{4}-\d{2}-\d{2}\b", line))
        if len(values) != 1:
            raise MetadataUnavailable(
                "BAER acquisition dates are not explicitly verified in the original metadata"
            )
        dates[role.lower()] = values.pop()
    return dates


def baer_layer_names(metadata, event_id, source):
    names = {}
    for name in metadata["names"]:
        basename = Path(name).name.lower()
        if not basename.endswith(".tif") or not basename.startswith(event_id.lower() + "_"):
            continue
        if source == "dnbr" and basename.endswith(("_dnbr.tif", "_dnbr_utm.tif")):
            if "dnbr" in names:
                raise ValueError("Multiple continuous dNBR rasters require assessment review")
            names["dnbr"] = name
        if source == "imagery" and "_refl" in basename:
            for role, date in metadata["dates"].items():
                if "_" + date.replace("-", "") + "_" in basename:
                    if role in names:
                        raise ValueError("Multiple same-date reflectance rasters require review")
                    names[role] = name
    expected = {"dnbr"} if source == "dnbr" else {"pre", "post"}
    if set(names) != expected:
        raise LookupError(
            "Checked original BAER bundle does not contain the requested dated product set"
        )
    return names


def baer_render_rule(metadata, source):
    text = metadata["text"]
    if source == "dnbr":
        if not re.search(r"dNBR product scaled by 1000", text, re.I):
            raise MetadataUnavailable(
                "Continuous dNBR units and scale are not verified by bundle metadata"
            )
        return {
            "scale": 1000,
            "bands": [1],
            "rule": "Source dNBR /1000; existing continuous ramp at -0.2, 0.15, 0.5, 0.85, 1.2; no severity thresholds",
        }
    sensors = baer_imagery_sensors(text)
    scales = re.findall(r"reflectance[^\r\n]*?scaled by (\d+(?:\.\d+)?)", text, re.I)
    combinations = re.findall(r"set RGB to bands\s+(\d+),\s*(\d+),\s*(\d+)", text, re.I)
    combinations.extend(
        re.findall(r"set RGB to band combination\s*\((\d+),\s*(\d+),\s*(\d+)\)", text, re.I)
    )
    if not scales:
        raise MetadataUnavailable(
            "Original metadata does not state reflectance scaling; no scale inferred"
        )
    if len(set(scales)) != 1:
        raise MetadataUnavailable("Original metadata states conflicting reflectance scales")
    if not combinations or len(set(combinations)) != 1:
        raise MetadataUnavailable("RGB band order is not uniquely verified in original metadata")
    scale = float(scales[0])
    if scale <= 0:
        raise ValueError("Invalid source reflectance scale")
    bands = [int(value) for value in combinations[0]]
    return {
        "scale": scale,
        "bands": bands,
        "sensors": sensors,
        "rule": "Metadata RGB bands "
        + "/".join(str(band) for band in bands)
        + "; source DN / "
        + str(scale)
        + "; existing fixed 0-0.6 reflectance display stretch on both dates",
    }


def baer_imagery_sensors(text):
    families = ground_policy()["reflectanceValidation"]["approvedSensorFamilies"]
    sensors = {}
    for role in ("Pre", "Post"):
        matches = re.findall(r"=\s*" + role + r"-Fire\s+([^\r\n]+?)\s+reflectance", text, re.I)
        if len(set(matches)) != 1:
            raise MetadataUnavailable(
                "Before/after source sensors are not uniquely stated in product metadata"
            )
        sensor = matches[0].strip()
        approved = False
        for family in families:
            if same_sensor_family(sensor, family):
                approved = True
        if not approved:
            raise MetadataUnavailable(
                "Source sensor needs approval before adding new imagery: " + sensor
            )
        sensors[role.lower()] = sensor
    return sensors


def same_sensor_family(sensor, family):
    label = re.sub(r"[\s-]", "", sensor.casefold())
    prefix = re.sub(r"[\s-]", "", family.casefold())
    if not prefix or not label.startswith(prefix):
        return False

    if prefix[-1].isdigit() and len(label) > len(prefix) and label[len(prefix)].isdigit():
        return False
    return True


def approved_raster_exclusions(receipt, source):
    global RASTER_EXCLUSIONS
    if RASTER_EXCLUSIONS is None:
        configuration = ground_policy()
        RASTER_EXCLUSIONS = configuration.get("approvedRasterExclusions", [])
    approved = []
    for decision in RASTER_EXCLUSIONS:
        if decision["archiveSha256"] == receipt.get("sha256") and decision["product"] == source:
            approved.append(decision)
    return approved


def exclude_approved_values(values, valid, inside, decisions):
    excluded = []
    for decision in decisions:
        band = decision["band"] - 1
        if band < 0 or band >= values.shape[0]:
            raise ValueError("Approved exclusion refers to a missing source band")
        selected = values[band].data == decision["value"]
        count = int((inside & valid & selected).sum())
        valid[selected] = False
        excluded.append({**decision, "excludedFootprintPixels": count})
    return excluded


def check_reflectance_scale(values, valid, inside, rule):
    import numpy as np

    policy = ground_policy()["reflectanceValidation"]
    summaries = []
    for index, band in enumerate(rule["bands"]):
        selected = values[index].data[valid & inside]
        if not selected.size:
            raise LookupError("No valid native imagery pixels in this footprint")
        median = float(np.median(selected))
        summaries.append({"band": band, "medianNativeDn": median, "declaredScale": rule["scale"]})
        if policy["withholdIfMedianExceedsDeclaredScale"] and median > rule["scale"]:
            raise MetadataUnavailable(
                "Native RGB median exceeds the declared reflectance scale; withheld for review, not proof the source is wrong"
            )
    return summaries


def baer_native_values(archive, name, footprint, rule, source, decisions=None):
    import rasterio
    import numpy as np
    from rasterio.features import geometry_mask
    from rasterio.warp import transform_geom
    from rasterio.windows import from_bounds
    from shapely.geometry import box, mapping

    with rasterio.open("zip://" + str(archive) + "!" + name) as dataset:
        if dataset.crs is None or max(rule["bands"]) > dataset.count:
            raise ValueError("BAER raster CRS or documented band count is invalid")
        polygon = transform_geom(4326, dataset.crs, mapping(box(*footprint)))
        window = (
            from_bounds(*shape(polygon).bounds, dataset.transform).round_offsets().round_lengths()
        )
        grid = dataset.window_transform(window)
        values = dataset.read(rule["bands"], window=window, boundless=True, masked=True)
        inside = geometry_mask([polygon], values.shape[1:], grid, invert=True)
        valid = ~np.ma.getmaskarray(values).any(axis=0)
        finite = np.isfinite(values.data).all(axis=0)
        valid &= finite
        exclusions = exclude_approved_values(values, valid, inside, decisions or [])
        if source == "dnbr":
            invalid = valid & ((values[0].data < -2000) | (values[0].data > 2000))
            if invalid.any():
                raise MetadataUnavailable(
                    "dNBR contains values outside its documented range without a declared no-data mask; no sentinel was silently reclassified"
                )
        if not inside.any() or not (inside & valid).any():
            raise LookupError(
                "The original raster has no valid pixels in this fire display footprint"
            )
        scale_check = (
            check_reflectance_scale(values, valid, inside, rule) if source == "imagery" else None
        )
        coverage = {
            "nativeFootprintPixels": int(inside.sum()),
            "nativeValidPixels": int((inside & valid).sum()),
            "nativeValidPercent": float(valid[inside].mean() * 100),
            "sourceExclusions": exclusions,
            "sourceCrs": dataset.crs.to_string(),
            "nativePixelSize": list(dataset.res),
            "declaredNoData": dataset.nodata,
            "reflectanceScaleCheck": scale_check,
        }
        return values.astype(np.float32).filled(np.nan), valid, grid, dataset.crs, coverage


def baer_display_grid(footprint):
    from rasterio.transform import from_bounds
    from rasterio.warp import transform_bounds

    west, south, east, north = transform_bounds(4326, 3857, *footprint)
    ratio = (east - west) / (north - south)
    width = max(1, round(1600 * min(1, ratio)))
    height = max(1, round(1600 * min(1, 1 / ratio)))
    return (height, width), from_bounds(west, south, east, north, width, height)


def render_baer_values(native, footprint, rule, source):
    import numpy as np
    from rasterio.warp import reproject, Resampling

    values, valid, transform, crs, coverage = native
    shape_out, grid = baer_display_grid(footprint)
    output = np.full((values.shape[0], *shape_out), np.nan, dtype=np.float32)
    values[:, ~valid] = np.nan
    reproject(
        values,
        output,
        src_transform=transform,
        src_crs=crs,
        src_nodata=np.nan,
        dst_transform=grid,
        dst_crs=3857,
        dst_nodata=np.nan,
        resampling=Resampling.nearest,
    )
    present = np.isfinite(output).all(axis=0)
    if source == "dnbr":
        stops = [-0.2, 0.15, 0.5, 0.85, 1.2]
        colors = np.array(
            [[255, 255, 204], [254, 217, 118], [253, 141, 60], [227, 26, 28], [128, 0, 38]]
        )
        rgb = np.zeros((*shape_out, 3), dtype=np.uint8)
        for band in range(3):
            rgb[:, :, band][present] = np.interp(
                output[0][present] / rule["scale"], stops, colors[:, band]
            ).astype(np.uint8)
    else:
        rgb = np.moveaxis(
            np.nan_to_num(np.clip(output / rule["scale"] / 0.6, 0, 1) * 255).astype(np.uint8), 0, -1
        )
    return rgb, present, grid, coverage


def write_baer_layer(record, role, native, footprint, rule, source, metadata, receipt, water):
    import numpy as np
    from PIL import Image
    from build_waves_ground import mask_display_water

    rgb, present, grid, coverage = render_baer_values(native, footprint, rule, source)
    mask = present.astype(np.uint8)
    mask_display_water(mask, grid, water[0])
    rgba = np.dstack([rgb, mask * 255])
    rgba[mask == 0] = 0
    output = io.BytesIO()
    Image.fromarray(rgba).save(output, format="PNG")
    content = output.getvalue()
    digest = hashlib.sha256(content).hexdigest()
    filename = record["id"].replace(":", "-") + "-baer-" + role + "-" + digest[:12] + ".png"
    (PUBLIC / "data/waves" / filename).write_bytes(content)
    return {
        "status": "available",
        "file": "/data/waves/" + filename,
        "bounds": footprint,
        "width": rgb.shape[1],
        "height": rgb.shape[0],
        "sha256": digest,
        "bytes": len(content),
        "sourceUrl": receipt["sourceUrl"],
        "retrievedAt": receipt["retrievedAt"],
        "publicationDate": metadata["publicationDate"],
        "sourceMetadataFile": metadata["metadataFile"],
        "license": metadata["license"],
        "credit": metadata["credit"],
        "preDate": metadata["dates"]["pre"],
        "postDate": metadata["dates"]["post"],
        "nativeCoverage": coverage,
        "processing": rule["rule"]
        + "; nearest-neighbor Web Mercator display; source masks, approved numeric exclusions, nonfinite pixels and Census water transparent",
        "dataClass": "Historical",
        "waterSource": water[1],
        "limitation": "Preliminary BAER imagery context; not a field-checked severity classification. Terrain and water context are not acquisition-date measurements.",
    }


def prepare_baer_product(record, archive, source):
    from build_historical_evidence import load_evidence
    from build_waves_ground import water_features

    previous = load_evidence(record).get("groundProducts", {}).get("layers", {})
    required = ["dnbr"] if source == "dnbr" else ["pre", "post"]
    if all(previous.get(role, {}).get("status") == "available" for role in required):
        for role in required:
            if not (PUBLIC / previous[role]["file"].lstrip("/")).is_file():
                return {
                    "status": "processing_failed",
                    "reason": "Previously prepared BAER product file is missing",
                }
        return {
            "status": "available",
            "reason": "Previously prepared verified BAER products retained unchanged",
            "preparedUrl": record["evidenceUrl"],
        }
    geometry, boundary_source, footprint = ground_inputs(record)
    if geometry is None:
        return {"status": "match_unresolved", "reason": boundary_source["reason"]}
    if footprint is None:
        return missing_footprint(record)
    path, receipt = download(Path(archive["url"]).name, archive["url"])
    metadata = baer_archive_metadata(path, archive["match"]["record"])
    names = baer_layer_names(metadata, archive["match"]["record"]["event_id"], source)
    rule = baer_render_rule(metadata, source)
    decisions = approved_raster_exclusions(receipt, source)
    native = {}
    for role, name in names.items():
        native[role] = baer_native_values(path, name, footprint, rule, source, decisions)
    water = water_features(record["id"].replace(":", "-") + "-baer", footprint)
    layers = {}
    for role in names:
        layers[role] = write_baer_layer(
            record, role, native[role], footprint, rule, source, metadata, receipt, water
        )
    store_baer_product(record, layers, archive, receipt, boundary_source)
    return {
        "status": "available",
        "reason": "Verified original BAER raster values checked and rendered",
        "preparedUrl": record["evidenceUrl"],
        "scope": {
            "fireId": record["id"],
            "boundarySource": boundary_source,
            "displayFootprint": footprint,
            "spatialRelationship": "Original raster crop intersecting the approved display footprint",
            "measurementPeriod": metadata["dates"],
            "periodStatus": "source_supplied acquisition dates",
            "sourceUrls": [receipt["sourceUrl"]],
        },
    }


def store_baer_product(record, layers, archive, receipt, footprint_source=None):
    from build_historical_evidence import load_evidence, save_evidence

    evidence = load_evidence(record)
    product = evidence.setdefault("groundProducts", {"fireId": record["id"], "layers": {}})
    product["layers"].update(layers)
    product["sourceReceipt"] = receipt
    product["match"] = archive["match"]
    product["releaseSource"] = archive["releaseSource"]
    if archive.get("releaseIdentity"):
        product.setdefault("releaseIdentity", archive["releaseIdentity"])
    if footprint_source and footprint_source.get("displayFootprintChoice"):
        product.setdefault("displayFootprintSource", footprint_source)
    evidence.setdefault("checks", {})["groundProducts"] = {
        "status": "available",
        "reason": "Verified original BAER raster products prepared",
    }
    save_evidence(PUBLIC / record["evidenceUrl"].lstrip("/"), evidence, "groundProducts")


def goes_years():
    global GOES_YEARS
    if GOES_YEARS is None:
        url = BUCKET + "?list-type=2&prefix=ABI-L2-ADPC%2F&delimiter=%2F"
        path, receipt = download("goes18-adpc-years.xml", url)
        root = ET.parse(path).getroot()
        ns = {"s": "http://s3.amazonaws.com/doc/2006-03-01/"}
        if root.findtext("s:IsTruncated", namespaces=ns) != "false":
            raise ValueError("Incomplete GOES year listing")
        years = set()
        for entry in root.findall("s:CommonPrefixes/s:Prefix", ns):
            year = entry.text.rstrip("/").rsplit("/", 1)[-1]
            if not year.isdigit():
                raise ValueError("Unexpected GOES year prefix")
            years.add(int(year))
        GOES_YEARS = (years, receipt)
    return GOES_YEARS


def terrain(record, geometry, footprint):
    from build_waves_ground import build_case, threshold_from_model

    case = {
        "id": record["id"].replace(":", "-"),
        "usgsId": record.get("assessment", {}).get("Fire_ID"),
        "name": record["name"],
        "ignition": record.get("ignition"),
        "displayFootprint": footprint,
    }
    ground = build_case(case, threshold_from_model(), geometry)
    return {
        "status": "available",
        "fireId": record["id"],
        "slope": ground["layers"]["slope"],
        "imagery": {
            "status": "not_checked",
            "reason": "No verified fire-level dated imagery archive has been retrieved. MTBS maps are checked separately.",
        },
    }


def goes_display_inputs(record, geometry):
    from build_historical_evidence import load_evidence

    existing = load_evidence(record).get("goes", {})
    manifest = existing.get("manifest")
    footprint = None
    footprint_source = None
    if manifest and (PUBLIC / manifest.lstrip("/")).is_file():
        previous = json.loads((PUBLIC / manifest.lstrip("/")).read_text(encoding="utf-8"))
        if previous.get("caseId") != record["id"]:
            raise ValueError("GOES footprint belongs to another fire")
        footprint = previous.get("bounds")
    if not footprint:
        geometry, footprint_source, footprint = ground_inputs(record)
    return geometry, footprint_source, footprint


def goes_source_keys(start):
    ns = {"s": "http://s3.amazonaws.com/doc/2006-03-01/"}
    keys = []
    for hour in range(3):
        date = start + timedelta(hours=hour)
        prefix = date.strftime("ABI-L2-ADPC/%Y/%j/%H/")
        listing, _ = download(
            date.strftime("goes18-%Y%m%d-%H-listing.xml"), BUCKET + "?list-type=2&prefix=" + prefix
        )
        root = ET.parse(listing).getroot()
        if root.findtext("s:IsTruncated", namespaces=ns) != "false":
            raise ValueError("Incomplete GOES archive listing")
        keys.extend(
            item.findtext("s:Key", namespaces=ns) for item in root.findall("s:Contents", ns)
        )
    return keys


def goes_slot_keys(date, keys):
    matches = []
    for key in keys:
        stamp = key.split("_s")[1].split("_")[0]
        scan = datetime.strptime(stamp[:13], "%Y%j%H%M%S").replace(tzinfo=timezone.utc)
        if (
            scan.date() == date.date()
            and scan.hour == date.hour
            and scan.minute // 10 == date.minute // 10
        ):
            matches.append(key)
    if len(matches) > 1:
        raise ValueError("Multiple GOES scans in one slot; review required")
    return matches


def prepare_goes_frame(date, matches, geometry, footprint, folder):
    from build_historical_coverage import source_error_status

    frame = {
        "slot": date.isoformat(),
        "status": "unavailable",
        "reason": "No scan in checked archive slot",
    }
    if not matches:
        return frame
    try:
        path, receipt = download(Path(matches[0]).name, BUCKET + matches[0])
        values, grid, crs, metadata, counts = read_frame(path, geometry, footprint, "fire")
        filename = date.strftime("%H%M.png")
        render(values, grid, crs, folder / filename, footprint)
        frame.update(
            {
                **receipt,
                "status": "available",
                "reason": None,
                "coverage": counts,
                "start": metadata["NC_GLOBAL#time_coverage_start"],
                "end": metadata["NC_GLOBAL#time_coverage_end"],
                "publishedAt": metadata["NC_GLOBAL#date_created"],
                "image": "/" + (folder / filename).relative_to(PUBLIC).as_posix(),
            }
        )
        if metadata.get("app_quality_interpretation"):
            frame["interpretation"] = metadata["app_quality_interpretation"]
    except (OSError, ValueError, KeyError) as error:
        frame["reason"] = "Source or quality check failed: " + str(error)
        frame["failureStatus"] = source_error_status(error)
        if isinstance(error, SourceFormatUnavailable):
            frame["failureStatus"] = "metadata_limited"
        elif isinstance(error, CoverageUnavailable):
            frame["failureStatus"] = "coverage_limited"
    return frame


def goes_window_status(frames, keys):
    for frame in frames:
        if frame.get("coverage", {}).get("fire", {}).get("usable", 0):
            return "available"
    failures = set()
    baseline = False
    for frame in frames:
        if frame.get("failureStatus"):
            failures.add(frame["failureStatus"])
        baseline = baseline or bool(frame.get("interpretation"))
    for status in ("processing_failed", "access_failed", "quality_failed", "metadata_limited"):
        if status in failures:
            return status
    if failures == {"coverage_limited"} or baseline:
        return "coverage_limited"
    return "quality_failed" if keys else "unavailable"


def goes_manifest(record, frames, footprint, footprint_source, start):
    manifest = {
        "caseId": record["id"],
        "dataClass": "Historical",
        "relationship": "nearby_time_matched",
        "bounds": footprint,
        "resolution": "2 km at nadir; larger off-nadir",
        "window": start.isoformat() + " to " + (start + timedelta(hours=3)).isoformat(),
        "guideUrl": GUIDE,
        "processing": "First complete post-ignition afternoon, noon-3 pm local. Original Enterprise cloud/confidence flags; unknown gray, smoke purple, usable nondetection transparent. Nearest-neighbor Web Mercator rendering; no interpolation or fire attribution.",
        "coverageDefinition": "Original source-grid pixel centers within the selected perimeter; not area weighting.",
        "frames": frames,
    }
    if footprint_source:
        manifest["boundarySource"] = footprint_source
    if any(frame.get("interpretation") for frame in frames):
        manifest["interpretation"] = "NOAA Baseline / detections only; other pixels unknown"
        baseline_note = "Baseline Smoke=1 only with good retrieval (DQF bit 0=0), medium/high smoke confidence (bits 2-3=4 or 12), and valid solar/view angles (bit 7=0). All other Baseline pixels unknown; no clear-air claim. Source pixel-center coverage, original time slots and nearest-neighbor Web Mercator rendering unchanged. No interpolation or fire attribution."
        mixed = False
        for frame in frames:
            if frame["status"] == "available" and not frame.get("interpretation"):
                mixed = True
        if mixed:
            manifest["interpretation"] = "NOAA mixed layouts / Baseline frames are detections only"
            manifest["processing"] += " " + baseline_note
        else:
            manifest["processing"] = baseline_note
        from build_goes_smoke import baseline_policy

        manifest["interpretationSource"] = baseline_policy()
    return manifest


def goes(record, geometry):
    if not record.get("ignition"):
        return {"status": "not_checked", "reason": "Exact ignition day is missing."}

    local = datetime.fromisoformat(record["ignition"]).replace(
        tzinfo=ZoneInfo("America/Los_Angeles")
    )
    start = (local + timedelta(days=1)).replace(hour=12).astimezone(timezone.utc)
    geometry, footprint_source, footprint = goes_display_inputs(record, geometry)
    if not footprint:
        return missing_footprint(record)
    if geometry is None:
        return {
            "status": "match_unresolved",
            "reason": "Verified fire boundary unavailable for the GOES footprint",
        }
    slug = record["id"].replace(":", "-")
    folder = PUBLIC / "data/waves" / ("goes-" + slug)
    folder.mkdir(parents=True, exist_ok=True)
    keys = goes_source_keys(start)
    frames = []
    for index in range(18):
        date = start + timedelta(minutes=10 * index)
        matches = goes_slot_keys(date, keys)
        frames.append(prepare_goes_frame(date, matches, geometry, footprint, folder))
    status = goes_window_status(frames, keys)
    if status != "available":
        return {
            "status": status,
            "reason": "Checked three-hour GOES-18 archive: no usable source pixels in the selected fire. See individual slot checks; no frames or clear-air values invented.",
            "slots": frames,
        }
    manifest = goes_manifest(record, frames, footprint, footprint_source, start)
    save_json(folder / "manifest.json", manifest)
    return {
        "status": "available",
        "manifest": "/" + (folder / "manifest.json").relative_to(PUBLIC).as_posix(),
        "coverageKey": "fire",
        "timezone": "America/Los_Angeles",
        "cadenceMinutes": 10,
        "caseId": record["id"],
    }
