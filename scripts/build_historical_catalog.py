import argparse
import hashlib
import json
import re
from collections import Counter, defaultdict
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib.parse import urlencode
from build_waves_data import CACHE, download, shared_source_name

from pyproj import Transformer
from shapely.geometry import Point, shape, box
from shapely.ops import transform, unary_union
from historical_identity import consolidate, fire_name

ROOT = Path(__file__).resolve().parents[1]
PUBLIC = ROOT / "frontend/public/data/historical-fires"
RAW = ROOT / "data/raw/historical-catalog"
OFFLINE = False


def save(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")


def fetch(name, url, directory, params=None):
    request_record = {"url": url, "parameters": params}
    if params:
        url += ("&" if "?" in url else "?") + urlencode(params)
    filename = directory.name + "-" + name + ".json"
    filename = shared_source_name(filename, url)
    if OFFLINE and not (CACHE / filename).exists():
        raise OSError("Source file is not cached; no network request made")
    path, source = download(filename, url)
    payload = json.loads(path.read_text(encoding="utf-8"))
    if "error" in payload:
        raise ValueError(str(payload["error"]))
    receipt = {
        "request": request_record,
        "retrievedAt": source["retrievedAt"],
        "bytes": source["bytes"],
        "sha256": source["sha256"],
    }
    return payload, receipt


def arcgis_rows(service, directory, fields="*"):
    count, _ = fetch(
        "count",
        service + "/query?" + urlencode({"f": "json", "where": "1=1", "returnCountOnly": "true"}),
        directory,
    )
    rows, receipts, seen = [], [], set()
    offset = 0
    while offset < count["count"]:
        query = {
            "f": "json",
            "where": "1=1",
            "outFields": fields,
            "returnGeometry": "false",
            "orderByFields": "OBJECTID ASC",
            "resultOffset": offset,
            "resultRecordCount": 1000,
        }
        page, receipt = fetch(str(offset), service + "/query?" + urlencode(query), directory)
        features = page.get("features", [])
        if not features:
            raise ValueError("Catalog pagination ended early")
        for feature in features:
            row = feature["attributes"]
            if row["OBJECTID"] in seen:
                raise ValueError("Duplicate source object ID")
            seen.add(row["OBJECTID"])
            rows.append({**row, "_catalogRetrievedAt": receipt["retrievedAt"]})
        receipts.append(receipt)
        offset += len(features)
    if len(rows) != count["count"]:
        raise ValueError("Catalog count differs from returned pages")
    return rows, receipts


def day(value):
    if not isinstance(value, (int, float)):
        return None

    epoch = datetime(1970, 1, 1, tzinfo=timezone.utc)
    return (epoch + timedelta(milliseconds=value)).date().isoformat()


def frap_records(config, directory):
    item, item_receipt = fetch("item", config["itemUrl"], directory)
    if item.get("access") != "public" or not item.get("licenseInfo"):
        raise ValueError("CAL FIRE access or reuse terms need review")
    service = item["url"].rstrip("/") + "/" + str(config["layer"])
    layer, layer_receipt = fetch("layer", service + "?f=json", directory)
    rows, receipts = arcgis_rows(service, directory)
    records, ids = [], set()
    for row in rows:
        identifier = row.get("GlobalID")
        if not identifier or identifier in ids:
            raise ValueError("Missing or duplicate CAL FIRE GlobalID")
        ids.add(identifier)
        year = row.get("YEAR_")
        year = int(year) if year else 0
        ignition = day(row.get("ALARM_DATE"))
        key = identifier.strip("{}").lower()
        boundary = (
            service
            + "/query?"
            + urlencode(
                {
                    "f": "geojson",
                    "where": "GlobalID='" + identifier + "'",
                    "outFields": "GlobalID,FIRE_NAME,YEAR_,ALARM_DATE",
                    "outSR": 4326,
                    "returnGeometry": "true",
                }
            )
        )
        records.append(
            {
                "id": f"frap:{year}:{key}",
                "year": year,
                "source": "CAL FIRE",
                "sourceId": identifier,
                "name": row.get("FIRE_NAME") or "Unnamed fire",
                "ignition": ignition,
                "sourceUrl": config["sourceUrl"],
                "boundaryUrl": boundary,
                "retrievedAt": row.pop("_catalogRetrievedAt"),
                "datasetUpdatedAt": day(item.get("modified")),
                "record": row,
            }
        )
    return records, {
        "status": "available",
        "count": len(records),
        "sourceUrl": config["sourceUrl"],
        "license": item["licenseInfo"],
        "attribution": item.get("accessInformation"),
        "modified": item.get("modified"),
        "receipts": [item_receipt, layer_receipt, *receipts],
        "layer": layer.get("name"),
    }


def mtbs_records(config, directory, california):
    project = Transformer.from_crs(4326, 3857, always_xy=True).transform
    outline = transform(project, california).wkt
    filter_text = "map_prog='MTBS' AND incid_type='Wildfire' AND INTERSECTS(geom," + outline + ")"
    records, receipts, ids = [], [], set()
    offset = 0
    while True:
        params = {
            "service": "WFS",
            "version": "2.0.0",
            "request": "GetFeature",
            "typeNames": config["layer"],
            "outputFormat": "application/json",
            "count": 500,
            "startIndex": offset,
            "sortBy": "map_id A",
            "propertyName": "event_id,map_id,incid_name,incid_type,ig_date,asmt_type,post_id,burnbndac,burnbndlat,burnbndlon,updated_at",
            "CQL_FILTER": filter_text,
        }
        page, receipt = fetch(str(offset), config["service"], directory, params)
        receipts.append(receipt)
        features = page.get("features")
        if not isinstance(features, list):
            raise ValueError("MTBS did not return a feature collection")
        for feature in features:
            row = feature["properties"]
            identifier = row["map_id"]
            if identifier in ids or row["incid_type"] != "Wildfire":
                raise ValueError("Duplicate or unexpected MTBS record")
            ids.add(identifier)
            ignition = row["ig_date"][:10]
            year = int(ignition[:4])
            record = dict(row, asmnt_type=row.get("asmt_type", ""), pre_id=None)
            records.append(
                {
                    "id": f"mtbs:{year}:{identifier}",
                    "year": year,
                    "source": "MTBS",
                    "sourceId": str(identifier),
                    "name": row["incid_name"],
                    "ignition": ignition,
                    "sourceUrl": config["sourceUrl"],
                    "retrievedAt": receipt["retrievedAt"],
                    "datasetUpdatedAt": row.get("updated_at"),
                    "mtbs": record,
                }
            )
        offset += len(features)
        total = page.get("numberMatched")
        if isinstance(total, int) and offset >= total:
            if offset != total:
                raise ValueError("MTBS count differs from returned pages")
            break
        if not features:
            if isinstance(total, int) and offset < total:
                raise ValueError("MTBS pagination ended early")
            break
    return records, {
        "status": "available",
        "count": len(records),
        "sourceUrl": config["sourceUrl"],
        "receipts": receipts,
    }


def usgs_records(config, directory, california):
    rows, receipts = arcgis_rows(config["service"], directory)
    records, excluded = [], []
    for row in rows:
        lon, lat = row.get("lon"), row.get("lat")
        if not isinstance(lon, (int, float)) or not isinstance(lat, (int, float)):
            excluded.append(
                {
                    "sourceId": row.get("Fire_ID"),
                    "status": "unresolved",
                    "reason": "Source location missing; California membership unresolved",
                }
            )
            continue
        if not california.covers(Point(lon, lat)):
            excluded.append(
                {
                    "sourceId": row.get("Fire_ID"),
                    "status": "outside_scope",
                    "reason": "Source location outside California",
                }
            )
            continue
        ignition = day(row.get("start_date"))
        year = int(ignition[:4]) if ignition else 0
        records.append(
            {
                "id": f"usgs:{year}:{row['OBJECTID']}",
                "year": year,
                "source": "USGS",
                "sourceId": row["Fire_ID"],
                "name": row["fire"],
                "ignition": ignition,
                "sourceUrl": config["sourceUrl"],
                "assessmentDate": day(row.get("assessment_date")),
                "retrievedAt": row.pop("_catalogRetrievedAt"),
                "assessment": row,
            }
        )
    return records, {
        "status": "available",
        "count": len(records),
        "sourceCount": len(rows),
        "sourceUrl": config["sourceUrl"],
        "receipts": receipts,
        "excluded": excluded,
    }


def local_runout_records():
    catalog = json.loads(
        (ROOT / "frontend/public/data/runout/catalog.json").read_text(encoding="utf-8")
    )
    records = []
    for release in catalog["releases"]:
        identifier = release["assessmentId"]
        year = int(release["ignition"][:4])
        filename = identifier + "-basins.json"
        path = ROOT / "frontend/public/data/runout" / filename
        companion = None
        if path.exists():
            data = json.loads(path.read_text(encoding="utf-8"))
            companion = {
                "releaseId": identifier,
                "url": "/data/runout/" + filename,
                "sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
            }
        records.append(
            {
                "id": f"runout:{year}:{identifier}",
                "year": year,
                "source": "USGS runout",
                "sourceId": identifier,
                "name": release["name"],
                "ignition": release["ignition"],
                "sourceUrl": release["sourceUrl"],
                "retrievedAt": data["retrievedAt"] if companion else None,
                "publicationDate": release["publicationDate"],
                "assessmentDate": release["assessmentDate"],
                "runout": release,
                "coordinatedRain": companion,
            }
        )
    return records, {
        "status": "available",
        "count": len(records),
        "checkedAt": catalog["checkedAt"],
        "sourceUrl": catalog["collectionUrl"],
        "excluded": catalog["excluded"],
    }


def archive_records(collections, directory, california):
    records, audits = [], []
    for collection in collections:
        offset, seen = 0, set()
        audit = {"name": collection["name"], "items": [], "receipts": []}
        while True:
            url = "https://www.sciencebase.gov/catalog/items?" + urlencode(
                {
                    "filter": "parentId=" + collection["id"],
                    "format": "json",
                    "max": 100,
                    "offset": offset,
                    "fields": "id,title,spatial,files,dates",
                }
            )
            page, receipt = fetch(str(offset), url, directory / collection["id"])
            audit["receipts"].append(receipt)
            for item in page["items"]:
                identifier = item["id"]
                if identifier in seen:
                    raise ValueError("Duplicate ScienceBase release ID")
                seen.add(identifier)
                source = "https://www.sciencebase.gov/catalog/item/" + identifier
                files = []
                for archive_file in item.get("files", []):
                    file_fields = {}
                    for field in ("name", "url", "size", "checksum"):
                        file_fields[field] = archive_file.get(field)
                    files.append(file_fields)
                bbox = item.get("spatial", {}).get("boundingBox")
                status, reason = (
                    "unresolved",
                    "No assessment bounding box; California membership not established.",
                )
                if bbox:
                    extent = [bbox["minX"], bbox["minY"], bbox["maxX"], bbox["maxY"]]
                    if california.intersects(box(*extent)):
                        status, reason = (
                            "available",
                            "Official assessment extent intersects California; no fire or watershed crosswalk assumed.",
                        )
                        dates = {
                            row["type"]: row.get("dateString") for row in item.get("dates", [])
                        }
                        ignition = dates.get("FireStart")
                        name = item["title"]
                        legacy = re.match(
                            r"^(.*?) (\d{4}-\d{2}-\d{2}) (?:\([^)]+\)|v[\d.]+) postfire",
                            item["title"],
                        )
                        if legacy:
                            name, ignition = legacy.groups()
                        if not ignition:
                            audit["items"].append(
                                {
                                    "id": identifier,
                                    "title": item["title"],
                                    "sourceUrl": source,
                                    "status": "not_inspected",
                                    "reason": "Multi-fire or undated archive: individual California catchments have not been inspected.",
                                    "files": files,
                                }
                            )
                            continue
                        year = int(ignition[:4]) if ignition else 0
                        records.append(
                            {
                                "id": f"archive:{year}:{identifier}",
                                "year": year,
                                "source": "USGS archive",
                                "sourceId": identifier,
                                "name": name,
                                "ignition": ignition,
                                "assessmentDate": dates.get("Assessment"),
                                "publicationDate": dates.get("Publication"),
                                "sourceUrl": source,
                                "retrievedAt": receipt["retrievedAt"],
                                "bounds": extent,
                                "archiveFiles": files,
                                "productsStatus": "not_processed",
                            }
                        )
                    else:
                        status, reason = (
                            "outside_scope",
                            "Assessment extent does not intersect California.",
                        )
                audit["items"].append(
                    {
                        "id": identifier,
                        "title": item["title"],
                        "sourceUrl": source,
                        "status": status,
                        "reason": reason,
                        "files": files,
                    }
                )
            offset += len(page["items"])
            if offset >= page["total"]:
                if offset != page["total"]:
                    raise ValueError("ScienceBase total changed during pagination")
                break
            if not page["items"]:
                raise ValueError("ScienceBase pagination ended early")
        audit["sourceUrl"] = "https://www.sciencebase.gov/catalog/item/" + collection["id"]
        audit["count"] = len(seen)
        audits.append(audit)
    return records, {
        "status": "available",
        "count": len(records),
        "sourceUrl": "https://www.usgs.gov/programs/landslide-hazards/science/postfire-debris-flow-hazard-assessment-data",
        "collections": audits,
    }


def matching_polygons(records, directory):
    keys = {
        (fire_name(row["name"]), row["ignition"])
        for row in records
        if row.get("mtbs") or row.get("assessment")
    }
    candidates = [
        row
        for row in records
        if row["source"] == "CAL FIRE" and (fire_name(row["name"]), row["ignition"]) in keys
    ]
    polygons = {}
    for start in range(0, len(candidates), 50):
        page = candidates[start : start + 50]
        identifiers = [row["sourceId"] for row in page]
        service = page[0]["boundaryUrl"].split("/query?")[0]
        params = {
            "f": "geojson",
            "where": "GlobalID IN (" + ",".join("'" + key + "'" for key in identifiers) + ")",
            "outFields": "GlobalID",
            "returnGeometry": "true",
            "outSR": 4326,
        }
        digest = hashlib.sha256(json.dumps(params, sort_keys=True).encode()).hexdigest()[:16]
        payload, receipt = fetch(digest, service + "/query", directory, params)
        features = payload.get("features", [])
        if payload.get("exceededTransferLimit") or len(features) != len(page):
            raise ValueError("Incomplete CAL FIRE containment geometry")
        for feature in features:
            key = feature["properties"]["GlobalID"]
            if key not in identifiers or key in polygons:
                raise ValueError("CAL FIRE polygon identity differs")
            polygons[key] = feature["geometry"]
    return polygons


def write_catalog(records, sources, raw_count=None):
    ids, years = set(), defaultdict(list)
    for record in records:
        if record["id"] in ids:
            raise ValueError("Duplicate catalog ID")
        ids.add(record["id"])
        years[record["year"]].append(record)
    listing = []
    for year in sorted(years, reverse=True):
        rows = sorted(years[year], key=lambda row: (row["name"].upper(), row["source"], row["id"]))
        content = {"schemaVersion": 1, "year": year, "records": rows}
        save(PUBLIC / f"{year}.json", content)
        listing.append(
            {"year": year, "count": len(rows), "url": f"/data/historical-fires/{year}.json"}
        )
    save(PUBLIC / "audit.json", sources)
    source_summary = {}
    for key, source in sources.items():
        source_summary[key] = {
            field: source[field]
            for field in ("status", "count", "sourceUrl", "checkedAt")
            if field in source
        }
    aliases = {}
    for record in records:
        for key in record.get("aliases", [record["id"]]):
            if key == record["id"]:
                continue
            if key in aliases:
                raise ValueError("Source alias resolves to multiple fires")
            aliases[key] = {"id": record["id"], "year": record["year"]}
    index = {
        "schemaVersion": 2,
        "builtAt": datetime.now(timezone.utc).isoformat(),
        "scope": "California",
        "recordCount": len(records),
        "counts": dict(Counter(row["source"] for row in records)),
        "sourceRecordCount": raw_count or len(records),
        "aliases": aliases,
        "years": listing,
        "sources": source_summary,
        "auditUrl": "/data/historical-fires/audit.json",
        "limitation": "One entry per resolved fire identity. Unconfirmed possible duplicates remain in the source audit; catalogs are incomplete.",
        "productDefaults": {
            "smoke": {
                "status": "not_checked",
                "reason": "Monitor streams and a historical smoke window have not been audited for this record.",
            },
            "ash": {
                "status": "not_checked",
                "reason": "No verified sampling study is linked to this record.",
            },
            "imagery": {
                "status": "not_processed",
                "reason": "Dated imagery and continuous dNBR have not been prepared for this record; source availability is not established.",
            },
            "slope": {
                "status": "not_processed",
                "reason": "No elevation-derived overlay has been prepared for this record.",
            },
        },
    }
    save(PUBLIC / "index.json", index)
    print(json.dumps({"records": len(records), "years": len(years), "counts": index["counts"]}))


def main():
    global OFFLINE
    parser = argparse.ArgumentParser(
        description="Discover California historical records without a fire list or observation cap.\n\nReceives official metadata and the existing California outline; downloads no imagery.\n"
    )
    parser.add_argument("--refresh", action="store_true")
    parser.add_argument(
        "--local-only", action="store_true", help="Rebuild from already cached metadata"
    )
    parser.add_argument("--cache-dir", type=Path, help="Reuse a particular raw catalog snapshot")
    args = parser.parse_args()
    OFFLINE = args.local_only
    if args.refresh and args.local_only:
        parser.error("A refresh needs network access")
    directory = args.cache_dir.resolve() if args.cache_dir else RAW
    directory.relative_to(RAW.resolve())
    if args.refresh:
        directory = RAW / datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    config = json.loads((ROOT / "data/historical_sources.json").read_text(encoding="utf-8"))
    outline = json.loads(
        (ROOT / "frontend/public/data/california-outline.geojson").read_text(encoding="utf-8")
    )
    california = unary_union([shape(feature["geometry"]) for feature in outline["features"]])
    records, sources = [], {}
    for key, load in [("frap", frap_records), ("mtbs", mtbs_records), ("usgs", usgs_records)]:
        try:
            if args.local_only and not (directory / key).exists():
                raise OSError("Source has not been cached")
            rows, receipt = (
                load(config[key], directory / key)
                if key == "frap"
                else load(config[key], directory / key, california)
            )
            records.extend(rows)
            sources[key] = receipt
        except (OSError, ValueError, KeyError) as error:

            raise RuntimeError(f"{key} catalog not published: {error}") from error
    rows, receipt = local_runout_records()
    records.extend(rows)
    sources["runout"] = receipt
    rows, receipt = archive_records(config["archives"], directory / "archives", california)
    records.extend(rows)
    sources["archives"] = receipt
    polygons = matching_polygons(records, directory / "containment")
    replays = json.loads(
        (ROOT / "frontend/public/data/waves-cases.json").read_text(encoding="utf-8")
    )["cases"]
    fires, identity_audit = consolidate(records, polygons, replays)
    sources["identity"] = identity_audit

    save(PUBLIC / "source-records.json", records)
    write_catalog(fires, sources, len(records))


if __name__ == "__main__":
    main()
