import hashlib
import io
import json
import math
import re
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlencode

import numpy as np
import rasterio
from affine import Affine
from PIL import Image
from pyproj import Transformer
from rasterio.features import geometry_mask
from rasterio.transform import from_bounds
from rasterio.warp import Resampling, reproject, transform_bounds
from rasterio.windows import Window, from_bounds as raster_window, transform as window_transform
from shapely.geometry import box, mapping, shape
from shapely.ops import transform, unary_union

from build_waves_data import CACHE, ROOT, download

PUBLIC = ROOT / "frontend/public"
PORTAL = "https://burnseverity.cr.usgs.gov/direct-download?product=MTBS"
LICENSE = "Public domain (USGS 3DEP); elevation metres, NAVD88; horizontal NAD83."
COLORS = {"below": "#e0e7e1", "atOrAbove": "#4d7778"}
SLOPE_CONTEXT_METRES = 3000
SLOPE_CONTEXT_SHAPE = "rectangle"
SLOPE_OUTSIDE_ALPHA = 64


def slope_degrees(elevation, spacing, validate=True):
    if spacing <= 0:
        raise ValueError("Projected spacing must be positive")
    north, east = np.gradient(elevation.astype(float), spacing)
    slope = np.degrees(np.arctan(np.hypot(east, north)))
    slope[~np.isfinite(elevation)] = np.nan
    slope[[0, -1], :] = np.nan
    slope[:, [0, -1]] = np.nan
    if validate:
        check_slope_range(slope)
    return slope


def tile_windows(height, width, size):
    if size < 1:
        raise ValueError("Tile size must be positive")
    for top in range(0, height, size):
        for left in range(0, width, size):
            yield top, left, min(top + size, height), min(left + size, width)


def tiled_slope(elevation, spacing, size, destination):
    height, width = elevation.shape
    for top, left, bottom, right in tile_windows(height, width, size):
        north, west = max(0, top - 1), max(0, left - 1)
        south, east = min(height, bottom + 1), min(width, right + 1)
        values = slope_degrees(elevation[north:south, west:east], spacing, validate=False)
        destination[top:bottom, left:right] = values[
            top - north : bottom - north, left - west : right - west
        ]
    return destination


def project_terrain_on_disk(paths, grid_shape, grid, crs, case_id):
    from build_historical_coverage import TERRAIN_TILE_SIZE

    elevation_path = CACHE / (case_id + "-temporary-elevation.npy")
    projected_path = CACHE / (case_id + "-temporary-projected.npy")
    elevation = np.lib.format.open_memmap(
        elevation_path, mode="w+", dtype=np.float32, shape=grid_shape
    )
    projected = np.lib.format.open_memmap(
        projected_path, mode="w+", dtype=np.float32, shape=grid_shape
    )
    elevation[:] = np.nan
    for path in paths:
        with rasterio.open(path) as source:
            original = source.read(1, masked=True).astype(np.float32).filled(np.nan)
            projected[:] = np.nan

            reproject(
                original,
                projected,
                src_transform=source.transform,
                src_crs=source.crs,
                src_nodata=np.nan,
                dst_transform=grid,
                dst_crs=crs,
                dst_nodata=np.nan,
                resampling=Resampling.bilinear,
            )
        for top, left, bottom, right in tile_windows(*grid_shape, TERRAIN_TILE_SIZE):
            current = elevation[top:bottom, left:right]
            incoming = projected[top:bottom, left:right]
            use = ~np.isfinite(current) & np.isfinite(incoming)
            current[use] = incoming[use]
    del projected
    projected_path.unlink()
    return elevation


def terrain_grid_tiled(paths, footprint, crs, case_id):
    from build_historical_coverage import TERRAIN_TILE_SIZE

    west, south, east, north = transform_bounds(4326, crs, *footprint)
    spacing, buffer = 10, 100
    width = math.ceil((east - west + buffer * 2) / spacing)
    height = math.ceil((north - south + buffer * 2) / spacing)
    grid = Affine(spacing, 0, west - buffer, 0, -spacing, north + buffer)
    path = CACHE / (case_id + "-temporary-slope.npy")
    result = np.lib.format.open_memmap(path, mode="w+", dtype=np.float64, shape=(height, width))
    elevation = project_terrain_on_disk(paths, (height, width), grid, crs, case_id)
    tiled_slope(elevation, spacing, TERRAIN_TILE_SIZE, result)
    elevation_path = Path(elevation.filename)
    del elevation
    elevation_path.unlink()
    result.flush()
    return result, grid


def check_slope_range(values):
    finite = values[np.isfinite(values)]
    if np.isinf(values).any() or not finite.size or finite.min() < 0 or finite.max() > 90:
        raise ValueError("Slope must contain degrees between 0 and 90")


def threshold_from_model():
    model = json.loads((PUBLIC / "data/model.json").read_text(encoding="utf-8"))
    thresholds = []
    for feature in model["inputs"]:
        match = re.fullmatch(r"HM(\d+(?:\.\d+)?)", feature)
        if match:
            thresholds.append(float(match.group(1)))
    if len(thresholds) != 1:
        raise ValueError("One archived HM threshold is required")
    return thresholds[0]


def read_perimeter(case, geometry=None):
    if geometry is None:
        replay = json.loads((PUBLIC / case["snapshot"].lstrip("/")).read_text(encoding="utf-8"))
        if (
            replay["case"]["name"] != case["name"]
            or replay["case"]["ignition"] != case["ignition"]
            or replay["rain"]["record"]["Fire_ID"] != case["usgsId"]
        ):
            raise ValueError("Wrong fire snapshot")
        geometry = replay["perimeter"]["value"]
    polygons = []
    for feature in geometry["features"]:
        polygon = shape(feature["geometry"])
        if not polygon.is_valid or polygon.geom_type not in ("Polygon", "MultiPolygon"):
            raise ValueError("Invalid source fire boundary")
        polygons.append(polygon)
    perimeter = unary_union(polygons)
    zone = int((perimeter.centroid.x + 180) // 6) + 1
    if zone not in (10, 11):
        raise ValueError("Only California UTM zones are supported")
    crs = 26900 + zone
    to_utm = Transformer.from_crs(4326, crs, always_xy=True).transform
    projected = transform(to_utm, perimeter)
    west, south, east, north = projected.bounds
    context = box(
        west - SLOPE_CONTEXT_METRES,
        south - SLOPE_CONTEXT_METRES,
        east + SLOPE_CONTEXT_METRES,
        north + SLOPE_CONTEXT_METRES,
    )
    to_wgs84 = Transformer.from_crs(crs, 4326, always_xy=True).transform
    context_wgs84 = transform(to_wgs84, context)
    footprint = context_wgs84.bounds
    if not box(*footprint).covers(perimeter):
        raise ValueError("Display footprint does not cover the fire")
    return list(footprint), crs, mapping(context_wgs84), mapping(perimeter)


def elevation_products(key, footprint):
    parameters = {
        "bbox": ",".join(str(value) for value in footprint),
        "datasets": "National Elevation Dataset (NED) 1/3 arc-second",
        "max": 1000,
    }
    path, receipt = download(
        key + "-3dep-catalog.json",
        "https://tnmaccess.nationalmap.gov/api/v1/products?" + urlencode(parameters),
    )
    catalog = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(catalog.get("items"), list) or catalog["total"] > len(catalog["items"]):
        raise ValueError("Incomplete 3DEP product catalog")
    if not catalog["items"]:
        raise LookupError(
            "The checked 3DEP catalog has no 1/3 arc-second product for this footprint"
        )
    tiles = {}
    for item in catalog["items"]:
        url = item["downloadURL"]
        tile = re.search(r"(n\d{2}w\d{3})", url)
        if not tile or not url.endswith(".tif"):
            continue
        if "public domain" not in item["body"].lower() or "meters" not in item["body"]:
            raise ValueError("Elevation license or metre units unverified")
        previous = tiles.get(tile[1])
        if not previous or item["publicationDate"] > previous["publicationDate"]:
            tiles[tile[1]] = item
    if not tiles:
        raise ValueError("No usable 1/3 arc-second elevation tiles")
    return list(tiles.values()), receipt


def buffered_elevation_window(source, footprint):
    bounds = transform_bounds(4326, source.crs, *footprint)
    requested = raster_window(*bounds, source.transform)
    left = max(0, math.floor(requested.col_off) - 20)
    top = max(0, math.floor(requested.row_off) - 20)
    right = min(source.width, math.ceil(requested.col_off + requested.width) + 20)
    bottom = min(source.height, math.ceil(requested.row_off + requested.height) + 20)
    if right <= left or bottom <= top:
        return None
    return Window(left, top, right - left, bottom - top)


def elevation_window(case_id, item, footprint, catalog_receipt):
    from build_historical_coverage import file_hash

    url = item["downloadURL"]
    filename = Path(url).stem
    path = CACHE / (case_id + "-" + filename + "-window.tif")
    receipt_path = path.with_suffix(".source.json")
    if path.exists() and receipt_path.exists():
        receipt = json.loads(receipt_path.read_text(encoding="utf-8"))
        if (
            receipt["sourceUrl"] != url
            or receipt["footprint"] != footprint
            or file_hash(path) != receipt["sha256"]
        ):
            raise ValueError("Cached elevation window changed")
        return path, receipt
    print("Reading native window", filename, flush=True)
    with rasterio.open(url) as source:
        if source.count != 1 or source.crs is None or max(source.res) > 0.0001:
            raise ValueError("Elevation resolution or CRS disagrees with the catalog")
        window = buffered_elevation_window(source, footprint)
        if window is None:

            return None, {
                "sourceUrl": url,
                "catalogUrl": catalog_receipt["sourceUrl"],
                "retrievedAt": datetime.now(timezone.utc).isoformat(),
                "license": LICENSE,
                "publicationDate": item["publicationDate"],
                "title": item["title"],
                "footprint": footprint,
                "nativeBounds": list(source.bounds),
                "nativeCrs": source.crs.to_string(),
                "status": "no_intersection",
                "processing": "Original tile has no cells in the unchanged 20-cell buffered window; no pixels contributed.",
            }
        values = source.read(1, window=window)
        profile = source.profile.copy()
        profile.update(
            width=window.width,
            height=window.height,
            transform=source.window_transform(window),
            compress="deflate",
        )
        with rasterio.open(path, "w", **profile) as destination:
            destination.write(values, 1)
    receipt = {
        "sourceUrl": url,
        "catalogUrl": catalog_receipt["sourceUrl"],
        "retrievedAt": datetime.now(timezone.utc).isoformat(),
        "license": LICENSE,
        "publicationDate": item["publicationDate"],
        "title": item["title"],
        "bytes": path.stat().st_size,
        "sha256": file_hash(path),
        "footprint": footprint,
        "processing": "Native-grid window plus 20-cell derivative buffer; not a complete copy of the source tile.",
    }
    receipt_path.write_text(json.dumps(receipt, indent=2), encoding="utf-8")
    return path, receipt


def terrain_grid(paths, footprint, crs):
    west, south, east, north = transform_bounds(4326, crs, *footprint)
    spacing, buffer = 10, 100
    width = math.ceil((east - west + buffer * 2) / spacing)
    height = math.ceil((north - south + buffer * 2) / spacing)
    grid = Affine(spacing, 0, west - buffer, 0, -spacing, north + buffer)
    elevation = np.full((height, width), np.nan, dtype=np.float32)
    for path in paths:
        with rasterio.open(path) as source:
            original = source.read(1, masked=True).astype(np.float32).filled(np.nan)
            projected = np.full_like(elevation, np.nan)
            reproject(
                original,
                projected,
                src_transform=source.transform,
                src_crs=source.crs,
                src_nodata=np.nan,
                dst_transform=grid,
                dst_crs=crs,
                dst_nodata=np.nan,
                resampling=Resampling.bilinear,
            )
            use = ~np.isfinite(elevation) & np.isfinite(projected)
            elevation[use] = projected[use]
    return slope_degrees(elevation, spacing), grid


def prepare_terrain(case, footprint, crs, cache_id):
    products, catalog_receipt = elevation_products(cache_id, footprint)
    paths, receipts = [], []
    for product in products:
        path, receipt = elevation_window(cache_id, product, footprint, catalog_receipt)
        receipts.append(receipt)
        if path is not None:
            paths.append(path)
    if not paths:
        raise LookupError("Checked 3DEP native tiles do not cover this display footprint")
    from build_historical_coverage import IN_MEMORY_TERRAIN_CELLS

    west, south, east, north = transform_bounds(4326, crs, *footprint)
    cells = math.ceil((east - west + 200) / 10) * math.ceil((north - south + 200) / 10)
    if cells > IN_MEMORY_TERRAIN_CELLS:
        values, grid = terrain_grid_tiled(paths, footprint, crs, cache_id)
    else:
        values, grid = terrain_grid(paths, footprint, crs)
    return values, grid, receipts


def classify_terrain(
    values,
    grid,
    footprint,
    crs,
    threshold,
    case_id=None,
    analysis_geometry=None,
    fire_geometry=None,
):
    from build_historical_coverage import IN_MEMORY_TERRAIN_CELLS, TERRAIN_TILE_SIZE

    polygon = box(*footprint) if analysis_geometry is None else shape(analysis_geometry)
    native_polygon = transform(Transformer.from_crs(4326, crs, always_xy=True).transform, polygon)
    inside = geometry_mask([mapping(native_polygon)], values.shape, grid, invert=True)
    native_fire = None
    if fire_geometry is not None:
        native_fire = mapping(
            transform(
                Transformer.from_crs(4326, crs, always_xy=True).transform, shape(fire_geometry)
            )
        )
    if values.size > IN_MEMORY_TERRAIN_CELLS and case_id:
        path = CACHE / (case_id + "-temporary-classes.npy")
        classes = np.lib.format.open_memmap(path, mode="w+", dtype=np.uint8, shape=values.shape)
        classes[:] = 0
    else:
        classes = np.zeros(values.shape, dtype=np.uint8)
    count, minimum, maximum = 0, math.inf, -math.inf
    fire_cells, fire_valid, fire_steep = 0, 0, 0
    for top, left, bottom, right in tile_windows(*values.shape, TERRAIN_TILE_SIZE):
        block = values[top:bottom, left:right]
        selected = inside[top:bottom, left:right]
        if np.isinf(block[selected]).any():
            raise ValueError("Slope must contain degrees between 0 and 90")
        valid = selected & np.isfinite(block)
        if native_fire is not None:
            window = Window(left, top, right - left, bottom - top)
            fire_mask = geometry_mask(
                [native_fire], block.shape, window_transform(window, grid), invert=True
            )
            valid_fire = fire_mask & valid
            fire_cells += int(np.count_nonzero(fire_mask))
            fire_valid += int(np.count_nonzero(valid_fire))
            fire_steep += int(np.count_nonzero(block[valid_fire] >= threshold))
        original = block[valid]
        if not original.size:
            continue
        check_slope_range(original)
        count += original.size
        minimum = min(minimum, float(original.min()))
        maximum = max(maximum, float(original.max()))
        output = classes[top:bottom, left:right]
        output[valid] = 1 + (original >= threshold).astype(np.uint8)
    if not count:
        raise ValueError("Slope must contain degrees between 0 and 90")
    statistics = {
        "minimumDegrees": minimum,
        "maximumDegrees": maximum,
        "nativeValidPercent": float(count / int(inside.sum()) * 100),
    }
    if native_fire is not None:
        if not fire_valid or not fire_cells:
            raise ValueError("No valid slope cells inside the verified fire boundary")
        statistics["fireSteepPercent"] = float(fire_steep / fire_valid * 100)
        statistics["fireValidPercent"] = float(fire_valid / fire_cells * 100)
        statistics["fireValidCells"] = fire_valid
    return classes, statistics


def terrain_display(classes, grid, crs, footprint):
    west, south, east, north = transform_bounds(4326, 3857, *footprint)
    ratio = (east - west) / (north - south)
    width = max(1, round(1600 * min(1, ratio)))
    height = max(1, round(1600 * min(1, 1 / ratio)))
    display_grid = from_bounds(west, south, east, north, width, height)
    display = np.zeros((height, width), dtype=np.uint8)
    reproject(
        classes,
        display,
        src_transform=grid,
        src_crs=crs,
        src_nodata=0,
        dst_transform=display_grid,
        dst_crs=3857,
        dst_nodata=0,
        resampling=Resampling.nearest,
    )
    return display, display_grid


def water_features(case_id, footprint, context_geometry):
    water_parameters = {
        "f": "geojson",
        "where": "1=1",
        "geometry": ",".join(str(value) for value in footprint),
        "geometryType": "esriGeometryEnvelope",
        "inSR": 4326,
        "outSR": 4326,
        "spatialRel": "esriSpatialRelIntersects",
        "outFields": "*",
        "returnGeometry": "true",
        "resultRecordCount": 100000,
    }
    url = "https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/Hydro/MapServer/1/query?"
    water_path, water_receipt = download(
        case_id + "-ground-water.geojson", url + urlencode(water_parameters)
    )
    water = json.loads(water_path.read_text(encoding="utf-8"))
    if "features" not in water:
        raise ValueError("Water-mask response incomplete")
    receipts = [water_receipt]
    seen = set()
    for feature in water["features"]:
        identifier = feature["properties"]["OBJECTID"]
        if identifier in seen:
            raise ValueError("Duplicate source water polygon")
        seen.add(identifier)
    while water.get("exceededTransferLimit") or water.get("properties", {}).get(
        "exceededTransferLimit"
    ):
        features = water["features"]
        if not features:
            raise ValueError("Water-mask pagination stopped before completion")
        water_parameters["resultOffset"] = len(features)
        name = case_id + "-ground-water-" + str(len(features)) + ".geojson"
        path, receipt = download(name, url + urlencode(water_parameters))
        page = json.loads(path.read_text(encoding="utf-8"))
        if "features" not in page or not page["features"]:
            raise ValueError("Water-mask pagination stopped before completion")
        for feature in page["features"]:
            identifier = feature["properties"]["OBJECTID"]
            if identifier in seen:
                raise ValueError("Duplicate source water polygon across pages")
            seen.add(identifier)
        page["features"] = features + page["features"]
        water = page
        receipts.append(receipt)
    if len(receipts) > 1:
        water_receipt = {**water_receipt, "pages": receipts}
    context = shape(context_geometry)
    selected = []
    invalid_ids = []
    for feature in water["features"]:
        polygon = shape(feature["geometry"])
        if not polygon.intersects(context):
            continue
        if not polygon.is_valid or polygon.geom_type not in ("Polygon", "MultiPolygon"):
            invalid_ids.append(feature["properties"]["OBJECTID"])
            continue
        selected.append(feature)
    water_receipt["usedFeatureCount"] = len(selected)
    water_receipt["excludedInvalidFeatureIds"] = invalid_ids
    return selected, water_receipt


def mask_display_water(display, display_grid, features):
    water_shapes = []
    project = Transformer.from_crs(4326, 3857, always_xy=True).transform
    for feature in features:
        polygon = shape(feature["geometry"])
        if not polygon.is_valid or polygon.geom_type not in ("Polygon", "MultiPolygon"):
            raise ValueError("Invalid Census water polygon")
        water_shapes.append(mapping(transform(project, polygon)))
    if water_shapes:
        display[geometry_mask(water_shapes, display.shape, display_grid, invert=True)] = 0


def write_slope_image(case_id, display, grid, perimeter):
    palette = np.array([[0, 0, 0, 0], [224, 231, 225, 255], [77, 119, 120, 255]], dtype=np.uint8)
    pixels = palette[display]
    project = Transformer.from_crs(4326, 3857, always_xy=True).transform
    inside = geometry_mask(
        [mapping(transform(project, shape(perimeter)))], display.shape, grid, invert=True
    )
    pixels[(display != 0) & ~inside, 3] = SLOPE_OUTSIDE_ALPHA
    encoded = io.BytesIO()
    Image.fromarray(pixels).save(encoded, format="PNG")
    content = encoded.getvalue()
    filename = case_id + "-slope-" + hashlib.sha256(content).hexdigest()[:12] + ".png"
    (PUBLIC / "data/waves" / filename).write_bytes(content)
    return filename, len(content)


def ground_result(
    case, threshold, footprint, display, statistics, receipts, water_receipt, filename
):
    unavailable = {
        "status": "unavailable",
        "sourceUrl": PORTAL,
        "reason": "Official fire-level files have not been retrieved. The current MTBS portal uses an emailed processing request; no request was sent.",
    }
    result = {
        "id": case["id"],
        "usgsId": case["usgsId"],
        "name": case["name"],
        "ignition": case["ignition"],
        "layers": {
            "pre": unavailable,
            "post": unavailable,
            "dnbr": unavailable,
            "slope": {
                "status": "available",
                "file": "/data/waves/" + filename,
                "bounds": footprint,
                "width": display.shape[1],
                "height": display.shape[0],
                "thresholdDegrees": threshold,
                "pixelSizeMetres": 10,
                "colors": COLORS,
                **statistics,
                "sourceUrl": "https://www.usgs.gov/3d-elevation-program",
                "license": LICENSE,
                "retrievedAt": max(receipt["retrievedAt"] for receipt in receipts),
                "sources": receipts,
                "waterSource": water_receipt,
                "dataClass": "Historical",
                "processing": f"Native elevation windows; bilinear reprojection to a metre-based 10 m NAD83 UTM grid; central-difference slope in degrees; 0-90 degree check before thresholding; rectangle extending {SLOPE_CONTEXT_METRES / 1000:g} km past each edge of the fire's projected bounding box; nearest-neighbor class rendering to Web Mercator PNG. Water and no-data transparent.",
                "contextBufferMetres": SLOPE_CONTEXT_METRES,
                "contextShape": SLOPE_CONTEXT_SHAPE,
                "outsideAlpha": SLOPE_OUTSIDE_ALPHA,
                "inputFootprint": case.get("displayFootprint"),
                "limitation": "Elevation editions are not fire-date measurements. Display is resampled; no extra spatial detail is created. Census water is not date-matched; invalid water polygons are omitted and listed in the water source record. This is terrain, not a watershed or a debris-flow estimate.",
            },
        },
    }
    result["layers"]["slope"][
        "analysisMask"
    ] = f"Rectangle extending {SLOPE_CONTEXT_METRES / 1000:g} km past each edge of the verified fire boundary's projected bounding box"
    return result


def build_case(case, threshold, geometry=None):
    footprint, crs, context_geometry, perimeter = read_perimeter(case, geometry)
    cache_id = f"{case['id']}-slope-context-{SLOPE_CONTEXT_METRES / 1000:g}km-{SLOPE_CONTEXT_SHAPE}"
    values, grid, receipts = prepare_terrain(case, footprint, crs, cache_id)
    classes = None
    try:
        classes, statistics = classify_terrain(
            values, grid, footprint, crs, threshold, cache_id, context_geometry, perimeter
        )
        display, display_grid = terrain_display(classes, grid, crs, footprint)
        features, water_receipt = water_features(cache_id, footprint, context_geometry)
        mask_display_water(display, display_grid, features)
        filename, byte_count = write_slope_image(case["id"], display, display_grid, perimeter)
        print(
            case["name"],
            filename,
            byte_count,
            "bytes; native valid",
            statistics["nativeValidPercent"],
            flush=True,
        )
        return ground_result(
            case, threshold, footprint, display, statistics, receipts, water_receipt, filename
        )
    finally:
        if isinstance(values, np.memmap):
            temporary_path = Path(values.filename)
            del values
            temporary_path.unlink()
        if isinstance(classes, np.memmap):
            temporary_path = Path(classes.filename)
            del classes
            temporary_path.unlink()


def main():
    configuration = json.loads((ROOT / "data/waves_cases.json").read_text(encoding="utf-8"))
    threshold = threshold_from_model()
    result = {"schemaVersion": 1, "builtAt": datetime.now(timezone.utc).isoformat(), "cases": []}
    for case in configuration["cases"]:
        result["cases"].append(build_case(case, threshold))
    output = PUBLIC / "data/waves/ground.json"
    output.write_text(
        json.dumps(result, ensure_ascii=False, allow_nan=False, separators=(",", ":")),
        encoding="utf-8",
    )


if __name__ == "__main__":
    main()
