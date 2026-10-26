import argparse
import hashlib
import json
import struct
import zlib
import xml.etree.ElementTree as ET
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlencode
from zipfile import ZipFile

import numpy as np
import rasterio
from pyproj import CRS, Transformer
from rasterio.features import geometry_mask
from rasterio.windows import from_bounds, Window
from shapely.geometry import mapping, shape, box
from shapely import transform, is_valid_reason
from shapely.ops import unary_union
from build_waves_data import CACHE, download

ROOT = Path(__file__).resolve().parents[1]
RAW = CACHE
PUBLIC = ROOT / "frontend/public/data"
COLLECTION = "https://www.sciencebase.gov/catalog/items?" + urlencode(
    {
        "parentId": "5e91dee782ce172707f02cdd",
        "max": 100,
        "format": "json",
    }
)
WFS = "https://edcintl.cr.usgs.gov/geoserver/wfs"
WCS = "https://edcintl.cr.usgs.gov/geoserver/mtbs/wcs"
LICENSE = "Public domain; USGS / USDA Forest Service MTBS; acknowledge source and limitations"


class GeometryUnavailable(ValueError):
    pass


def sha256(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def save_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, indent=2, allow_nan=False) + "\n", encoding="utf-8")


def cached(name, url):
    path, receipt = download(name, url)
    record = {
        "url": url,
        "retrieved": receipt["retrievedAt"],
        "bytes": receipt["bytes"],
        "sha256": receipt["sha256"],
        "license": LICENSE,
    }
    return path, record


def geometry_hash(geometry):
    values = [1 if geometry["type"] == "Polygon" else 2]

    def visit(node):
        if isinstance(node, list):
            values.append(len(node))
            for child in node:
                visit(child)
        else:
            values.append(float(node))

    visit(geometry["coordinates"])
    return hashlib.sha256(struct.pack("<" + "d" * len(values), *values)).hexdigest()


def count_classes(values, inside, valid):
    selected = values[inside & valid]
    if not np.isin(selected, np.arange(7)).all():
        raise ValueError("Unexpected class value: numeric MTBS values must be 0-6")
    counts = np.bincount(selected.astype(np.uint8), minlength=7)
    counts[0] += int(np.count_nonzero(inside & ~valid))
    if int(counts.sum()) != int(inside.sum()):
        raise ValueError("Class counts do not sum to the boundary pixel count")
    return counts.astype(int).tolist()


def summarize(dataset, geometry):
    crs = CRS.from_user_input(dataset.crs)
    operation = crs.coordinate_operation
    if (
        dataset.count != 1
        or dataset.dtypes != ("uint8",)
        or not operation
        or "albers" not in operation.method_name.lower()
        or dataset.res != (30.0, 30.0)
        or dataset.transform.b
        or dataset.transform.d
    ):
        raise ValueError("Expected a single-band, numeric 30 m Albers equal-area raster")
    project = Transformer.from_crs("EPSG:4326", crs, always_xy=True).transform
    original = shape(geometry)
    if not original.is_valid or original.is_empty:
        raise GeometryUnavailable(
            f"Source boundary topology unresolved: {is_valid_reason(original)}. No automatic repair."
        )
    polygon = transform(original, project, interleaved=False)
    if not polygon.is_valid or polygon.is_empty:
        raise GeometryUnavailable(
            "Projected boundary topology unresolved; no automatic geometry repair."
        )
    bounds_window = from_bounds(*polygon.bounds, transform=dataset.transform)

    left, top = np.floor([bounds_window.col_off, bounds_window.row_off]).astype(int)
    right, bottom = np.ceil(
        [bounds_window.col_off + bounds_window.width, bounds_window.row_off + bounds_window.height]
    ).astype(int)
    window = Window(left, top, right - left, bottom - top)
    values = dataset.read(1, window=window, boundless=True, fill_value=0)
    valid = dataset.read_masks(1, window=window, boundless=True) > 0
    inside = geometry_mask(
        [mapping(polygon)],
        out_shape=values.shape,
        transform=dataset.window_transform(window),
        invert=True,
        all_touched=False,
    )
    counts = count_classes(values, inside, valid)
    return {"counts": counts, "pixelAreaM2": 900, "polygonAreaKm2": polygon.area / 1e6}


def fire_boundaries(year, california):
    page_number, offset, records, seen = 0, 0, [], set()
    while True:
        params = {
            "service": "WFS",
            "version": "2.0.0",
            "request": "GetFeature",
            "typeNames": "mtbs:fire_polygons",
            "outputFormat": "application/json",
            "srsName": "EPSG:4326",
            "count": 200,
            "startIndex": offset,
            "sortBy": "map_id A",
            "CQL_FILTER": f"map_prog='MTBS' AND incid_type='Wildfire' AND ig_date >= '{year}-01-01' "
            f"AND ig_date < '{year + 1}-01-01' AND BBOX(geom,-124.5,32.4,-114.0,42.1,'EPSG:4326')",
        }
        path, provenance = cached(
            f"burn-area-{year}-boundaries-{page_number}.geojson", WFS + "?" + urlencode(params)
        )
        page = json.loads(path.read_text())
        if not isinstance(page.get("features"), list):
            raise ValueError("Boundary service did not return GeoJSON")
        for feature in page["features"]:
            record = feature["properties"]
            if record["map_id"] in seen or record["ig_date"][:4] != str(year):
                raise ValueError("Duplicate ID or unexpected fire year")
            seen.add(record["map_id"])
            if shape(feature["geometry"]).intersects(california):
                records.append((feature, provenance))
        offset += len(page["features"])
        matched = page.get("numberMatched")
        if isinstance(matched, int) and offset >= matched:
            break
        if not page["features"]:
            if isinstance(matched, int) and offset < matched:
                raise ValueError("Boundary service returned incomplete pagination")
            break
        page_number += 1
    return records


def mosaic(year):
    listing_path, _ = cached("burn-area-mosaic-collection.json", COLLECTION)
    listing = json.loads(listing_path.read_text())
    if listing.get("total", len(listing["items"])) > len(listing["items"]):
        raise ValueError("Mosaic release listing is incomplete")
    matches = [item for item in listing["items"] if f"Mosaic for {year} (" in item["title"]]
    if len(matches) != 1:
        raise ValueError(f"No single verified annual release for {year}")
    item = matches[0]
    path, _ = cached(
        f"burn-area-{year}-release.json",
        f"https://www.sciencebase.gov/catalog/item/{item['id']}?format=json",
    )
    metadata = json.loads(path.read_text())
    files = [entry for entry in metadata["files"] if entry["name"] == f"mtbs_CONUS_{year}.zip"]
    if len(files) != 1:
        raise ValueError("No unique numeric CONUS mosaic archive")
    archive, source = cached(files[0]["name"], files[0]["url"])

    tif = RAW / f"mtbs_CONUS_{year}.tif"
    with ZipFile(archive) as bundle:
        info = bundle.getinfo(tif.name)
        if not tif.exists() or tif.stat().st_size != info.file_size:
            bundle.extract(info, RAW)
    crc = 0
    with tif.open("rb") as stream:
        while True:
            chunk = stream.read(1024 * 1024)
            if not chunk:
                break
            crc = zlib.crc32(chunk, crc)
    if crc != info.CRC:
        raise ValueError("Extracted numeric raster differs from its original ZIP")
    source = {
        **source,
        "title": metadata["title"],
        "year": year,
        "rasterSha256": sha256(tif),
        "metadataUrl": f"https://www.sciencebase.gov/catalog/item/{item['id']}",
    }
    return tif, source


def coverage_extent(xml):
    root = ET.fromstring(xml)
    envelopes = root.findall(".//{http://www.opengis.net/gml/3.2}Envelope")
    if len(envelopes) != 1:
        raise ValueError("Expected one documented numeric-coverage envelope")
    envelope = envelopes[0]
    crs = CRS.from_user_input(envelope.attrib["srsName"])
    if envelope.attrib.get("axisLabels") != "X Y" or crs.to_epsg() != 3857:
        raise ValueError("Unverified coverage axes or coordinate system")
    lower = envelope.findtext("{http://www.opengis.net/gml/3.2}lowerCorner")
    upper = envelope.findtext("{http://www.opengis.net/gml/3.2}upperCorner")
    bounds = [float(value) for value in (lower + " " + upper).split()]
    if (
        len(bounds) != 4
        or not np.isfinite(bounds).all()
        or bounds[0] >= bounds[2]
        or bounds[1] >= bounds[3]
    ):
        raise ValueError("Invalid coverage envelope")
    return crs, bounds


def outside_coverage(geometry, crs, bounds):

    west, south, east, north = shape(geometry).bounds
    project = Transformer.from_crs("EPSG:4326", crs, always_xy=True)
    projected = project.transform_bounds(west, south, east, north, densify_pts=21)
    return not box(*projected).intersects(box(*bounds))


def audit_service_year(year, california):
    url = (
        WCS
        + "?"
        + urlencode(
            {
                "service": "WCS",
                "version": "2.0.1",
                "request": "DescribeCoverage",
                "coverageId": f"mtbs__mtbs_CONUS_{year}",
            }
        )
    )
    path, source = cached(f"burn-area-{year}-coverage.xml", url)
    crs, bounds = coverage_extent(path.read_bytes())
    manifest_path = PUBLIC / "fire-burn-summaries.json"
    output = json.loads(manifest_path.read_text())
    protected = {(record["mapId"], record["eventId"]) for record in output["records"]}
    audit = {
        "year": year,
        "source": source,
        "crs": crs.to_string(),
        "bounds": bounds,
        "records": [],
    }
    for feature, provenance in fire_boundaries(year, california):
        record = feature["properties"]
        identity = {"mapId": record["map_id"], "eventId": record["event_id"]}
        outside = outside_coverage(feature["geometry"], crs, bounds)
        audit["records"].append(
            {
                **identity,
                "name": record["incid_name"],
                "outsideServedExtent": outside,
                "geometrySha256": geometry_hash(feature["geometry"]),
                "boundarySource": provenance,
            }
        )
        key = (identity["mapId"], identity["eventId"])
        if outside and key not in protected:
            reason = (
                f"The {year} numeric MTBS download service checked {source['retrieved'][:10]} "
                "excludes this fire's extent, even if its display map is available. "
                "An official numeric product is needed to calculate area percentages."
            )
            output["exclusions"] = [
                entry for entry in output["exclusions"] if (entry["mapId"], entry["eventId"]) != key
            ]
            output["exclusions"].append(
                {**identity, "reason": reason, "geometrySha256": geometry_hash(feature["geometry"])}
            )
        print(
            year,
            record["incid_name"],
            (
                "outside served extent"
                if outside
                else "extent overlaps; numeric values still require verification"
            ),
            flush=True,
        )
    output["coverageAudits"] = [
        entry for entry in output.get("coverageAudits", []) if entry["year"] != year
    ] + [audit]
    save_json(manifest_path, output)
    print("Saved coverage audit; all existing numeric summaries unchanged.")


def main():
    parser = argparse.ArgumentParser(
        description="Build fire-wide MTBS class-area counts from numeric annual rasters, not map colors.\n\nReceives explicit years (and an optional proof-case map ID); uses existing interface\nPython dependencies and caches official inputs under data/raw, never the study files.\n"
    )
    parser.add_argument("--years", type=int, nargs="+", default=[2018])
    parser.add_argument("--map-id", type=int, help="Optional single proof-case assessment ID")
    parser.add_argument(
        "--audit-service-year",
        type=int,
        help="Only audit a served coverage extent; preserve existing summaries",
    )
    parser.add_argument(
        "--append-cached",
        action="store_true",
        help="Append catalog matches from already cached mosaics; never replace a numeric record or download a national archive",
    )
    args = parser.parse_args()
    outline = json.loads((PUBLIC / "california-outline.geojson").read_text())
    california = unary_union([shape(feature["geometry"]) for feature in outline["features"]])
    if args.append_cached:
        append_cached(california)
        return
    if args.audit_service_year:
        audit_service_year(args.audit_service_year, california)
        return
    output = {
        "version": 1,
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "scope": "fire-wide",
        "method": "Native 30 m equal-area cells; pixel centers inside exact fire boundary; no resampling.",
        "limitation": "Annual mosaic snapshot, not confirmed exact-assessment revision. Approximate boundary area; no watershed or field-severity inference.",
        "sources": [],
        "records": [],
        "exclusions": [],
    }
    for year in sorted(set(args.years)):
        tif, source = mosaic(year)
        output["sources"].append(source)
        with rasterio.open(tif) as dataset:
            for feature, provenance in fire_boundaries(year, california):
                record = feature["properties"]
                if args.map_id and record["map_id"] != args.map_id:
                    continue
                identity = {"mapId": record["map_id"], "eventId": record["event_id"]}
                try:
                    summary = summarize(dataset, feature["geometry"])
                except GeometryUnavailable as error:
                    output["exclusions"].append({**identity, "reason": str(error)})
                    print(year, record["incid_name"], "EXCLUDED", str(error), flush=True)
                    continue
                if not sum(summary["counts"][1:6]):
                    output["exclusions"].append(
                        {
                            **identity,
                            "reason": "No assessed class 1-5 cells in this annual mosaic snapshot.",
                        }
                    )
                    continue
                output["records"].append(
                    {
                        **identity,
                        "name": record["incid_name"],
                        "year": year,
                        "ignition": record["ig_date"][:10],
                        "postId": record.get("post_id"),
                        "updatedAt": record.get("updated_at"),
                        "geometrySha256": geometry_hash(feature["geometry"]),
                        "boundarySource": provenance,
                        "rasterSha256": source["rasterSha256"],
                        **summary,
                    }
                )
                print(year, record["incid_name"], record["map_id"], summary["counts"], flush=True)
    if not output["records"]:
        raise ValueError("No usable summaries; existing app file was not replaced")
    output["records"].sort(key=lambda record: record["mapId"])
    save_json(PUBLIC / "fire-burn-summaries.json", output)
    print(
        f"Published {len(output['records'])} fire-wide summaries; {len(output['exclusions'])} exclusions."
    )


def append_cached(california):
    from build_historical_coverage import catalog_records

    manifest = PUBLIC / "fire-burn-summaries.json"
    output = json.loads(manifest.read_text(encoding="utf-8"))
    original = {(r["mapId"], r["eventId"]): dict(r) for r in output["records"]}
    ids = {r["mtbs"]["map_id"] for r in catalog_records() if r.get("mtbs")}
    for cached_tif in sorted(RAW.glob("mtbs_CONUS_*.tif")):
        year = int(cached_tif.stem.rsplit("_", 1)[1])
        if not (RAW / f"mtbs_CONUS_{year}.zip").exists():
            continue
        tif, source = mosaic(year)
        if not any(s.get("rasterSha256") == source["rasterSha256"] for s in output["sources"]):
            output["sources"].append(source)
        with rasterio.open(tif) as dataset:
            for feature, provenance in fire_boundaries(year, california):
                row = feature["properties"]
                key = (row["map_id"], row["event_id"])
                if row["map_id"] not in ids or key in original:
                    continue
                try:
                    summary = summarize(dataset, feature["geometry"])
                except GeometryUnavailable as error:
                    print("Unchecked raster summary", key, str(error), flush=True)
                    continue
                if not sum(summary["counts"][1:6]):
                    continue
                output["records"].append(
                    {
                        "mapId": key[0],
                        "eventId": key[1],
                        "name": row["incid_name"],
                        "year": year,
                        "ignition": row["ig_date"][:10],
                        "postId": row.get("post_id"),
                        "updatedAt": row.get("updated_at"),
                        "geometrySha256": geometry_hash(feature["geometry"]),
                        "boundarySource": provenance,
                        "rasterSha256": source["rasterSha256"],
                        **summary,
                    }
                )
                original[key] = output["records"][-1]
                print("Added MTBS numeric classes", year, row["incid_name"], key[0], flush=True)
        save_json(manifest, output)
    print("Preserved and appended", len(output["records"]), "numeric summaries", flush=True)


if __name__ == "__main__":
    main()
