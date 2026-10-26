import hashlib
import json
import re
from collections import Counter
from datetime import datetime, timezone

from shapely.geometry import Point, shape
from shapely.ops import unary_union

from build_historical_catalog import ROOT, fetch, day
from build_historical_coverage import source_error_status

RAW = ROOT / "data/raw/recovery"
PUBLIC = ROOT / "frontend/public"
RECOVERY_CONFIG = None
DAMAGE_INDEX = {}
LIMITED_PRODUCTS = None


def incident_key(value):
    match = re.fullmatch(r"([A-Z]{5})[ -]*0*([0-9]+)", str(value).upper())
    return (match[1], int(match[2])) if match else None


def exact_name(value):
    return re.sub(r"\s+", " ", re.sub(r" Fire$", "", str(value).strip(), flags=re.I)).upper()


def query(service, parameters):
    key = hashlib.sha256(json.dumps([service, parameters], sort_keys=True).encode()).hexdigest()
    return fetch(key, service + "/query", RAW, parameters)


def source_rows(service, where, fields, geometry=False):
    count, _ = query(service, {"f": "json", "where": where, "returnCountOnly": "true"})
    rows, receipts, seen = [], [], set()
    while len(rows) < count["count"]:
        page, receipt = query(
            service,
            {
                "f": "json",
                "where": where,
                "outFields": "OBJECTID," + fields,
                "returnGeometry": str(geometry).lower(),
                "outSR": "4326",
                "orderByFields": "OBJECTID",
                "resultOffset": len(rows),
                "resultRecordCount": 1000,
            },
        )
        if not page.get("features"):
            raise ValueError("Damage pagination ended before the source count")
        if geometry and page.get("spatialReference", {}).get("wkid") != 4326:
            raise ValueError("Damage coordinates are not longitude/latitude")
        for feature in page["features"]:
            identifier = feature["attributes"]["OBJECTID"]
            if identifier in seen:
                raise ValueError("Duplicate damage object ID across pages")
            seen.add(identifier)
            rows.append(feature)
        receipts.append(receipt)
    if len(rows) != count["count"]:
        raise ValueError("Damage count changed during retrieval")
    return rows, receipts


def damage_groups(service):
    if service in DAMAGE_INDEX:
        return DAMAGE_INDEX[service]
    data, receipt = query(
        service,
        {
            "f": "json",
            "where": "HAZARDTYPE='Fire'",
            "returnGeometry": "false",
            "outFields": "INCIDENTNUM,INCIDENTNAME,INCIDENTSTARTDATE",
            "returnDistinctValues": "true",
        },
    )
    if data.get("exceededTransferLimit"):
        raise ValueError("Damage incident index was truncated")
    result = ([row["attributes"] for row in data["features"]], receipt)
    DAMAGE_INDEX[service] = result
    return result


def match_incident(record, groups):
    source = record.get("record", {})
    key = incident_key("CA" + str(source.get("UNIT_ID", "")) + " " + str(source.get("INC_NUM", "")))
    dates = {row["ignition"] for row in record.get("sources", []) if row.get("ignition")}
    if record.get("ignition"):
        dates.add(record["ignition"])
    candidates = []
    for group in groups:
        if (
            key
            and incident_key(group["INCIDENTNUM"]) == key
            and exact_name(group["INCIDENTNAME"]) == exact_name(record["name"])
            and day(group["INCIDENTSTARTDATE"]) in dates
        ):
            candidates.append(group)
    return candidates[0] if len(candidates) == 1 else None


def verify_reviewed_link(link):
    app, _ = fetch("link-app", link["appUrl"], RAW / link["catalogId"].replace(":", "-"))
    webmap, receipt = fetch("link-map", link["mapUrl"], RAW / link["catalogId"].replace(":", "-"))
    if app["values"]["webmap"] not in link["mapUrl"]:
        raise ValueError("Reviewed damage map identity changed")
    if not any(layer.get("url") == link["publicLayer"] for layer in webmap["operationalLayers"]):
        raise ValueError("Reviewed damage layer is no longer linked")
    terms, _ = fetch("link-terms", link["termsUrl"], RAW / link["catalogId"].replace(":", "-"))
    if (
        terms.get("access") != "public"
        or terms.get("url") != link["publicLayer"].rsplit("/", 1)[0]
        or not terms.get("licenseInfo")
    ):
        raise ValueError("Public damage source terms could not be verified")
    return {
        "method": "Dedicated public layer explicitly linked by CAL FIRE's incident map",
        **link,
        "retrievedAt": receipt["retrievedAt"],
    }


def summarize_damage(rows, group, perimeter, classes):
    seen, features, counts = {}, [], Counter()
    audit = {"duplicates": 0, "dateConflicts": 0, "missingGeometry": 0, "inside": 0, "outside": 0}
    for row in rows:
        attributes = row["attributes"]
        identifier = attributes.get("GLOBALID")
        if not isinstance(identifier, str) or not identifier.strip():
            raise ValueError("Inspection has no stable GLOBALID")
        identifier = identifier.lower()
        signature = {key: value for key, value in attributes.items() if key != "OBJECTID"}
        signature["geometry"] = row.get("geometry")
        if identifier in seen:
            if seen[identifier] != signature:
                raise ValueError("Conflicting duplicate damage GLOBALID")
            audit["duplicates"] += 1
            continue
        seen[identifier] = signature
        if group and (
            attributes["INCIDENTNUM"] != group["INCIDENTNUM"]
            or exact_name(attributes["INCIDENTNAME"]) != exact_name(group["INCIDENTNAME"])
        ):
            raise ValueError("Damage incident identity differs")
        if group and attributes["INCIDENTSTARTDATE"] != group["INCIDENTSTARTDATE"]:
            audit["dateConflicts"] += 1
            continue
        label = attributes["DAMAGE"] or "Not supplied"
        if label not in classes:
            raise ValueError("Unknown source damage category")
        counts[label] += 1
        geometry = row.get("geometry")
        if not geometry:
            audit["missingGeometry"] += 1
            continue
        lon, lat = geometry["x"], geometry["y"]
        if not (-180 <= lon <= 180 and -90 <= lat <= 90):
            raise ValueError("Invalid damage coordinates")
        inside = perimeter.contains(Point(lon, lat)) if perimeter else None
        if inside is not None:
            audit["inside" if inside else "outside"] += 1
        features.append(
            {
                "type": "Feature",
                "id": identifier,
                "properties": {
                    "id": identifier,
                    "damage": label,
                    "structureType": attributes["STRUCTURETYPE"],
                    "insidePerimeter": inside,
                },
                "geometry": {"type": "Point", "coordinates": [lon, lat]},
            }
        )

    return (
        [
            {"label": label, "count": counts[label], "color": color}
            for label, color in classes.items()
        ],
        features,
        audit,
    )


def build_damage(record, config, perimeter):
    reviewed = [row for row in config["reviewedSources"] if row["catalogId"] == record["id"]]
    if len(reviewed) > 1:
        raise ValueError("Duplicate reviewed damage sources")
    link = reviewed[0] if reviewed else None
    group = None
    if not link:
        groups, receipt = damage_groups(config["service"])
        group = match_incident(record, groups)
    else:
        receipt = {"retrievedAt": datetime.now(timezone.utc).isoformat()}
    check = {"sourceUrl": config["sourceUrl"], "retrievedAt": receipt["retrievedAt"]}
    if not group and not link:
        return {
            "status": "match_unresolved",
            "reason": "CAL FIRE inspection index checked; no unique exact incident/name/day link was confirmed.",
            **check,
        }
    service = link["publicLayer"] if link else config["service"]
    if link:
        match = verify_reviewed_link(link)
        where, fields, group = "1=1", "GLOBALID,DAMAGE,STRUCTURETYPE", None
        check["sourceUrl"] = link["sourceUrl"]
    else:
        match = {"method": "Exact incident identifier, name and published source day"}
        where = (
            "HAZARDTYPE='Fire' AND INCIDENTNUM='" + group["INCIDENTNUM"].replace("'", "''") + "'"
        )
        where += " AND INCIDENTNAME='" + group["INCIDENTNAME"].replace("'", "''") + "'"
        stamp = datetime.fromtimestamp(group["INCIDENTSTARTDATE"] / 1000, timezone.utc).strftime(
            "%Y-%m-%d %H:%M:%S"
        )
        where += " AND INCIDENTSTARTDATE = TIMESTAMP '" + stamp + "'"
        fields = "GLOBALID,DAMAGE,STRUCTURETYPE,INCIDENTNUM,INCIDENTNAME,INCIDENTSTARTDATE"
    rows, receipts = source_rows(service, where, fields, True)
    classes, metadata, metadata_receipt = damage_classes(service, config)
    categories, features, audit = summarize_damage(rows, group, perimeter, classes)
    check["retrievedAt"] = receipts[-1]["retrievedAt"] if receipts else receipt["retrievedAt"]
    filename = record["id"].replace(":", "-") + "-damage.geojson"
    path = PUBLIC / "data/historical-fires/recovery" / filename
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(
            {"type": "FeatureCollection", "fireId": record["id"], "features": features},
            separators=(",", ":"),
        ),
        encoding="utf-8",
    )
    return {
        "status": "available",
        **check,
        "dataClass": "Historical",
        "incidentId": group["INCIDENTNUM"] if group else None,
        "incidentDate": day(group["INCIDENTSTARTDATE"]) if group else link["incidentDate"],
        "recordDatesSupplied": group is not None,
        "sourceDates": sorted(
            {row.get("ignition") for row in record.get("sources", []) if row.get("ignition")}
        ),
        "match": match,
        "categories": categories,
        "total": sum(row["count"] for row in categories),
        "geometryUrl": "/" + path.relative_to(PUBLIC).as_posix(),
        "mappedCount": len(features),
        "audit": audit,
        "spatialChecked": perimeter is not None,
        "sourceUpdatedAt": day(metadata.get("editingInfo", {}).get("dataLastEditDate")),
        "inspectionDate": None,
        "publicationDate": None,
        "license": link["license"] if link else config["license"],
        "receipts": receipts + [metadata_receipt],
    }


def damage_classes(service, config):
    cache_key = hashlib.sha256(service.encode()).hexdigest()
    metadata, receipt = fetch(cache_key + "-layer", service + "?f=json", RAW)
    domain = next(
        field["domain"]["codedValues"] for field in metadata["fields"] if field["name"] == "DAMAGE"
    )
    classes = {}
    for row in domain:
        label = row["code"]
        if label not in config["colors"]:
            raise ValueError("Source damage classes changed; review their colors")
        classes[label] = config["colors"][label]
    classes["Not supplied"] = "#a6aeae"
    return classes, metadata, receipt


def build_water(record, notices):
    source_ids = {row["sourceId"] for row in record.get("sources", []) if row["source"] == "USGS"}
    results, failures = [], []
    from build_waves_data import download

    for notice in notices:
        if notice["sourceId"] not in source_ids:
            continue
        try:
            key = hashlib.sha256(notice["sourceUrl"].encode()).hexdigest()
            extension = ".pdf" if notice.get("sourceFormat") == "pdf" else ".html"
            path, receipt = download("recovery-water-" + key + extension, notice["sourceUrl"])
            if extension == ".pdf":
                from pypdf import PdfReader

                text = " ".join(page.extract_text() for page in PdfReader(path).pages)
            else:
                text = re.sub(r"<[^>]+>", " ", path.read_text(encoding="utf-8"))
            text = re.sub(r"\s+", " ", text)
            if notice["verifyText"] not in text:
                raise ValueError("Official notice wording changed; review required")
            results.append(
                {
                    key: value
                    for key, value in {
                        **notice,
                        **receipt,
                        "dataClass": "Historical",
                        "relationship": "fire_specific",
                    }.items()
                    if key != "verifyText"
                }
            )
        except (OSError, ValueError) as error:
            if isinstance(error, OSError) and source_error_status(error) == "processing_failed":
                raise
            failures.append(
                {
                    "provider": notice["provider"],
                    "sourceUrl": notice["sourceUrl"],
                    "reason": "Official notice could not be rechecked.",
                }
            )
    if results:
        status = "available"
    elif failures:
        status = "access_failed"
    else:
        status = "not_checked"
    return {
        "status": status,
        "reason": (
            "No reviewed water-notice history is linked; this does not mean no notice existed."
            if not results and not failures
            else ""
        ),
        "notices": results,
        "failures": failures,
        "completeHistory": False,
    }


def recovery_config():
    global RECOVERY_CONFIG
    if RECOVERY_CONFIG is None:
        path = ROOT / "data/recovery_sources.json"
        RECOVERY_CONFIG = json.loads(path.read_text(encoding="utf-8"))
    return RECOVERY_CONFIG


def current_evidence(record):
    path = PUBLIC / record["evidenceUrl"].lstrip("/")
    if path.exists():
        evidence = json.loads(path.read_text(encoding="utf-8"))
        if evidence.get("fireId") != record["id"]:
            raise ValueError("Recovery evidence belongs to another fire")
        return evidence
    return {
        "schemaVersion": 1,
        "fireId": record["id"],
        "checks": {},
        "smoke": {"status": "not_checked", "reason": "Historical smoke not checked."},
    }


def recovery_scope(record, source):
    relationships = {
        "damage": "Exact incident-linked inspection points; original locations retained, including outside the perimeter.",
        "water": "Provider notice territory, not the fire footprint or every property inside it.",
        "power": "County-wide context in counties intersecting the fire; not outages inside the perimeter or attributed to the fire.",
    }
    return {
        "fireId": record["id"],
        "boundarySource": None,
        "spatialRelationship": relationships[source],
        "measurementPeriod": None,
        "periodStatus": "not_supplied",
        "sourceUrls": [],
    }


def recovery_boundary(record, scope):
    from build_historical_evidence import evidence_perimeter

    try:
        geometry, receipt = evidence_perimeter(record)
        scope["boundarySource"] = receipt
        if not geometry:
            raise ValueError("Verified fire boundary unavailable; no recovery product processed.")
        polygons = []
        for feature in geometry["features"]:
            polygon = shape(feature["geometry"])
            if (
                polygon.geom_type not in ("Polygon", "MultiPolygon")
                or polygon.is_empty
                or not polygon.is_valid
            ):
                raise ValueError("Fire boundary is not a valid polygon; no repair applied.")
            polygons.append(polygon)
        if not polygons:
            raise ValueError("Verified fire boundary has no polygons.")
        scope["preflightVerified"] = True
        return unary_union(polygons), None
    except (OSError, ValueError, KeyError) as error:
        scope["blockedBy"] = "boundary"
        status = "match_unresolved" if isinstance(error, ValueError) else source_error_status(error)
        return None, {"status": status, "reason": str(error), "scope": scope}


def checked_damage(record, config):
    scope = recovery_scope(record, "damage")
    scope["sourceUrls"] = [config["sourceUrl"]]
    reviewed = []
    for link in config["reviewedSources"]:
        if link["catalogId"] == record["id"]:
            reviewed.append(link)
    if len(reviewed) > 1:
        raise ValueError("Duplicate reviewed damage source")
    if not reviewed:
        groups, receipt = damage_groups(config["service"])
        if match_incident(record, groups) is None:
            dates = [
                row.get("ignition") for row in record.get("sources", []) if row.get("ignition")
            ]
            if not record.get("ignition") and not dates:
                scope["blockedBy"] = "date"
            return {
                "status": "match_unresolved",
                "sourceUrl": config["sourceUrl"],
                "retrievedAt": receipt["retrievedAt"],
                "scope": scope,
                "reason": "CAL FIRE inspection index checked; no unique exact incident/name/day link was confirmed.",
            }
    perimeter, blocked = recovery_boundary(record, scope)
    if blocked:
        return blocked
    result = build_damage(record, config, perimeter)
    scope["sourceUrls"] = [result["sourceUrl"]]
    scope["incidentDate"] = result.get("incidentDate")
    scope["periodStatus"] = (
        "Inspection dates not supplied; incident date is not a measurement date."
    )
    return {**result, "scope": scope}


def checked_water(record, notices):
    scope = recovery_scope(record, "water")
    identifiers = {row["sourceId"] for row in record.get("sources", []) if row["source"] == "USGS"}
    linked = [notice for notice in notices if notice["sourceId"] in identifiers]
    scope["sourceUrls"] = sorted({notice["sourceUrl"] for notice in linked})
    if linked:
        _, blocked = recovery_boundary(record, scope)
        if blocked:
            return blocked
    result = build_water(record, notices)
    if result["status"] != "not_checked":
        event_dates = []
        for notice in result["notices"]:
            for event in notice["events"]:
                event_dates.append(event["date"])
        scope["eventDates"] = event_dates
        notice_scopes = []
        for notice in result["notices"]:
            for event in notice["events"]:
                notice_scopes.append(event["scope"])
        scope["noticeTerritories"] = notice_scopes
        scope["periodStatus"] = "Notice event dates supplied; water sampling periods not supplied."
        return {**result, "scope": scope}
    scope["blockedBy"] = "provider_link"
    scope["indexChecked"] = "Existing verified provider-notice catalog"
    return {
        **result,
        "status": "match_unresolved",
        "scope": scope,
        "reason": "The verified notice catalog has no fire-to-provider link for this record. No complete historical notice registry or service-area crosswalk is supplied; this is not evidence that no notice existed. Unrelated provider pages were not requested.",
    }


def persist_recovery(record, source, result, evidence):
    from build_historical_evidence import save_evidence

    path = PUBLIC / record["evidenceUrl"].lstrip("/")
    if not path.exists() and result["status"] != "available":
        return
    recovery = evidence.setdefault("recovery", {"schemaVersion": 1, "fireId": record["id"]})
    previous = recovery.get(source)
    if previous and previous.get("status") == "available" and previous != result:
        raise ValueError("A reviewed recovery value would change")
    recovery[source] = result
    complete_recovery_shape(recovery)
    evidence.setdefault("checks", {})[source] = {
        "status": result["status"],
        "reason": result.get("reason", ""),
    }
    evidence["checks"]["recovery"] = {
        "status": "checked",
        "reason": "Products checked separately; power is county/time context.",
    }
    save_evidence(path, evidence, source)


def complete_recovery_shape(recovery):
    recovery.setdefault("builtAt", datetime.now(timezone.utc).isoformat())
    recovery.setdefault(
        "damage", {"status": "not_checked", "reason": "Inspection match not checked."}
    )
    recovery.setdefault(
        "power",
        {
            "status": "not_checked",
            "reason": "County outage records have not been verified for this period.",
        },
    )
    recovery.setdefault(
        "water", {"status": "not_checked", "notices": [], "failures": [], "completeHistory": False}
    )


def check_recovery(record, source):
    evidence = current_evidence(record)
    existing = evidence.get("recovery", {}).get(source, {})
    if existing.get("status") == "available":
        return {
            "status": "available",
            "reason": "Previously reviewed recovery evidence retained unchanged.",
            "sourceUrl": existing.get("sourceUrl"),
            "scope": {"fireId": record["id"], "priorEvidenceRetained": True},
        }
    config = recovery_config()
    if source not in ("damage", "water", "power"):
        raise ValueError("Unknown recovery source")
    try:
        if source == "damage":
            result = checked_damage(record, config["damage"])
        elif source == "water":
            result = checked_water(record, config["waterNotices"])
        else:
            from build_power_data import checked_power

            result = checked_power(record, config["power"])
    except (OSError, ValueError) as error:
        status = source_error_status(error) if isinstance(error, OSError) else "quality_failed"
        result = {"status": status, "reason": str(error)}
    persist_recovery(record, source, result, evidence)
    return result


def limited_products():
    global LIMITED_PRODUCTS
    if LIMITED_PRODUCTS is not None:
        return LIMITED_PRODUCTS
    settings = json.loads((PUBLIC / "data/waves-cases.json").read_text(encoding="utf-8"))
    products = {}
    for case in settings["cases"]:
        if case["id"] in products:
            raise ValueError("Duplicate limited-study replay identity")
        snapshot = json.loads((PUBLIC / case["snapshot"].lstrip("/")).read_text(encoding="utf-8"))
        products[case["id"]] = {"case": case, "snapshot": snapshot}
    LIMITED_PRODUCTS = products
    return products


def limited_items(product, source):
    snapshot = product["snapshot"]
    if source == "health":
        return snapshot.get("smoke", {}).get("health", [])
    if source == "soil_followup":
        return snapshot.get("ash", {}).get("followup", [])
    soil_map = product["case"].get("soilMap")
    if soil_map:
        data = json.loads((PUBLIC / soil_map.lstrip("/")).read_text(encoding="utf-8"))
        if data["fireId"] != product["case"]["usgsId"]:
            raise ValueError("Sampling series belongs to another fire")
        return data.get("mapSeries", [])
    return snapshot.get("ash", {}).get("grids", [])


def check_limited(record, source):
    products = limited_products()
    product = products.get(record.get("replayId"))
    if product is None:
        return {
            "status": "coverage_limited",
            "reason": "The approved limited-study registry was checked. This fire has no documented study link; regional health findings and other fires' soil results are not transferred.",
            "scope": "Approved reviewed health and chemical-sampling studies only",
        }
    supplied_ids = set()
    for link in record.get("sources", []):
        if link.get("source") == "USGS":
            supplied_ids.add(link["sourceId"])
    if product["case"]["usgsId"] not in supplied_ids:
        return {
            "status": "match_unresolved",
            "reason": "Replay and catalog source identity do not agree.",
        }
    rows = limited_items(product, source)
    if not rows:
        return {
            "status": "no_match",
            "reason": "The linked reviewed study export has no values for this category. Other studies were not substituted.",
        }
    sources = sorted({row["sourceUrl"] for row in rows if row.get("sourceUrl")})
    return {
        "status": "available",
        "reason": "Reviewed study values retained unchanged; study populations and dates remain separate from individual fires.",
        "sourceUrls": sources,
        "records": len(rows),
    }
