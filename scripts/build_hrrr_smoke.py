import json
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo
from urllib.error import HTTPError

import numpy as np
import rasterio
from PIL import Image
from rasterio.transform import from_bounds
from rasterio.warp import Resampling, reproject, transform_bounds
from rasterio.windows import Window, from_bounds as source_window
from shapely.geometry import shape

from build_waves_data import ROOT, download
from build_waves_case import PUBLIC, save_json

BUCKET = "https://noaa-hrrr-bdp-pds.s3.amazonaws.com/"
GUIDE = (
    "https://www.weather.gov/media/notification/pdf2/scn21-86rap_and_hrr_smoke_units_change_aab.pdf"
)
LICENSE = "https://registry.opendata.aws/noaa-hrrr-pds/"
SCALE = {
    "unit": "µg/m³",
    "stops": [0, 10, 25, 50, 100, 200],
    "colors": ["#e6f1f5", "#9fc7db", "#599ebc", "#e4b455", "#d77b3e", "#873f69"],
}


def hourly_slots(snapshot, product):
    zone = ZoneInfo(product["timezone"])
    window = snapshot["smoke"]["window"]
    start = datetime.fromisoformat(window["start"]).replace(tzinfo=zone)
    end = datetime.fromisoformat(window["end"]).replace(tzinfo=zone) + timedelta(days=1)
    slots = []
    valid = start.astimezone(timezone.utc)
    while valid < end.astimezone(timezone.utc):
        slots.append(valid)
        valid += timedelta(hours=1)
    return slots


def field_range(text, initialization, lead):
    lines = text.splitlines()
    matches = []
    for index, line in enumerate(lines):
        parts = line.split(":")
        if len(parts) >= 6 and parts[3:5] == ["MASSDEN", "8 m above ground"]:
            matches.append((index, parts))
    if len(matches) != 1:
        raise ValueError("Exact near-surface MASSDEN field absent or ambiguous")
    index, parts = matches[0]
    if parts[2] != initialization.strftime("d=%Y%m%d%H") or parts[5] != f"{lead} hour fcst":
        raise ValueError("Smoke index initialization or forecast lead differs")
    if index + 1 == len(lines):
        raise ValueError("Source does not supply the field's ending byte")
    start = int(parts[1])
    end = int(lines[index + 1].split(":")[1]) - 1
    if start < 0 or end < start:
        raise ValueError("Invalid source field byte offsets")
    return start, end


def source_field(valid, product):
    lead = product["forecastLeadHours"]
    initialization = valid - timedelta(hours=lead)
    key = initialization.strftime("hrrr.%Y%m%d/conus/hrrr.t%Hz.wrfsfcf") + f"{lead:02}.grib2"
    url = BUCKET + key
    name = initialization.strftime("hrrr-%Y%m%d-%H-") + f"f{lead:02}"
    index, index_receipt = download(name + ".idx", url + ".idx")
    start, end = field_range(index.read_text(encoding="utf-8"), initialization, lead)
    path, receipt = download(name + "-massden.grib2", url + f"#bytes={start}-{end}")
    return path, {
        "sourceUrl": url,
        "indexUrl": url + ".idx",
        "byteRange": [start, end],
        "initializationTime": initialization.isoformat(),
        "forecastLeadHours": lead,
        "validTime": valid.isoformat(),
        "retrievedAt": receipt["retrievedAt"],
        "indexReceipt": index_receipt,
        "receipt": receipt,
    }


def verify_grid(source, valid, product):
    tags = source.tags(1)
    expected_init = valid - timedelta(hours=product["forecastLeadHours"])
    expected = {
        "GRIB_ELEMENT": "MASSDEN",
        "GRIB_SHORT_NAME": "8-HTGL",
        "GRIB_UNIT": "[kg/(m^3)]",
        "GRIB_REF_TIME": str(int(expected_init.timestamp())),
        "GRIB_VALID_TIME": str(int(valid.timestamp())),
        "GRIB_FORECAST_SECONDS": str(product["forecastLeadHours"] * 3600),
    }
    for key, value in expected.items():
        if tags.get(key) != value:
            raise ValueError("Unverified HRRR metadata: " + key)
    if source.count != 1 or (source.width, source.height) != (1799, 1059):
        raise ValueError("Unexpected HRRR native grid")
    if (
        source.res != (3000.0, 3000.0)
        or not source.crs
        or source.crs.to_dict().get("proj") != "lcc"
    ):
        raise ValueError("HRRR is not the verified 3 km Lambert grid")
    return {
        "width": source.width,
        "height": source.height,
        "cellSizeMetres": 3000,
        "crs": source.crs.to_wkt(),
        "transform": list(source.transform)[:6],
        "fieldTags": tags,
    }


def read_crop(path, bounds, valid, product):
    with rasterio.open(path) as source:
        grid = verify_grid(source, valid, product)
        projected = transform_bounds("EPSG:4326", source.crs, *bounds, densify_pts=41)
        enclosing = source_window(*projected, transform=source.transform)
        left, top = int(np.floor(enclosing.col_off)), int(np.floor(enclosing.row_off))
        window = Window(
            left,
            top,
            int(np.ceil(enclosing.col_off + enclosing.width)) - left,
            int(np.ceil(enclosing.row_off + enclosing.height)) - top,
        )
        values = source.read(1, window=window, masked=True)
        if not values.size:
            raise ValueError("Existing footprint has no HRRR cells")
        valid_cells = ~np.ma.getmaskarray(values) & np.isfinite(values.data)
        if np.any(values.data[valid_cells] < 0):
            raise ValueError("Negative source smoke density withheld")
        units = 1 if valid < datetime(2021, 12, 21, 13, tzinfo=timezone.utc) else 1e9
        converted = values.data.astype("float64") * units
        converted[~valid_cells] = np.nan
        finite = converted[valid_cells]
        statistics = {
            "nativeCells": int(values.size),
            "validCells": int(valid_cells.sum()),
            "validFraction": float(valid_cells.mean()),
            "minUgM3": float(finite.min()) if finite.size else None,
            "maxUgM3": float(finite.max()) if finite.size else None,
        }
        return converted, source.window_transform(window), source.crs, grid, statistics


def render_crop(values, transform, crs, bounds, target):
    projected = transform_bounds("EPSG:4326", "EPSG:3857", *bounds)
    width = int(np.ceil((projected[2] - projected[0]) / 3000))
    height = int(np.ceil((projected[3] - projected[1]) / 3000))
    output = np.full((height, width), np.nan, dtype="float64")
    reproject(
        values,
        output,
        src_transform=transform,
        src_crs=crs,
        src_nodata=np.nan,
        dst_transform=from_bounds(*projected, width, height),
        dst_crs="EPSG:3857",
        dst_nodata=np.nan,
        resampling=Resampling.nearest,
    )
    valid = np.isfinite(output)
    rgba = np.zeros((height, width, 4), dtype="uint8")
    colors = []
    for color in SCALE["colors"]:
        colors.append([int(color[offset : offset + 2], 16) for offset in (1, 3, 5)])
    for channel in range(3):
        rgba[:, :, channel][valid] = (
            np.interp(output[valid], SCALE["stops"], np.array(colors)[:, channel])
            .round()
            .astype("uint8")
        )
    rgba[:, :, 3][valid] = 175
    Image.fromarray(rgba).save(target)


def prepare_hour(valid, config, bounds, destination, audit_only):
    frame = {"validTime": valid.isoformat(), "status": "unavailable"}
    try:
        path, metadata = source_field(valid, config["hrrr"])
        frame.update(metadata)
        values, transform, crs, grid, statistics = read_crop(path, bounds, valid, config["hrrr"])
        frame.update({"grid": grid, "coverage": statistics})
        if not statistics["validCells"]:
            raise ValueError("No valid smoke cells in the established footprint")
        if not audit_only:
            name = valid.strftime("%Y%m%dT%H%MZ.png")
            render_crop(values, transform, crs, bounds, destination / name)
            frame["image"] = "/" + (destination / name).relative_to(PUBLIC).as_posix()
        frame["status"] = "available"
    except HTTPError as error:
        frame.update(
            {"reason": f"NOAA source returned HTTP {error.code}", "failureStatus": "access_failed"}
        )
    except ValueError as error:
        frame.update({"reason": str(error), "failureStatus": "quality_failed"})
    except OSError as error:
        frame.update({"reason": str(error), "failureStatus": "processing_failed"})
    return frame


def build_hrrr(config, audit_only=False):
    product = config.get("hrrr")
    if not product:
        raise ValueError("No HRRR replay configured for this case")
    footprint = json.loads(
        (PUBLIC / product["footprintFrom"].lstrip("/")).read_text(encoding="utf-8")
    )
    if footprint["caseId"] != config["id"]:
        raise ValueError("Smoke footprint belongs to another fire")
    snapshot = json.loads((PUBLIC / config["snapshot"].lstrip("/")).read_text(encoding="utf-8"))
    bounds = footprint["bounds"]
    destination = PUBLIC / product["manifest"].lstrip("/")
    destination.parent.mkdir(parents=True, exist_ok=True)
    frames = []
    for valid in hourly_slots(snapshot, product):
        frame = prepare_hour(valid, config, bounds, destination.parent, audit_only)
        frames.append(frame)
        print("HRRR", valid.isoformat(), frame["status"], frame.get("reason", ""), flush=True)
    manifest = {
        "caseId": config["id"],
        "dataClass": "Historical",
        "product": "NOAA HRRR-Smoke MASSDEN / 8 m above ground",
        "label": "NOAA modeled near-surface smoke / historical",
        "bounds": bounds,
        "timezone": product["timezone"],
        "forecastLeadHours": product["forecastLeadHours"],
        "cadenceMinutes": 60,
        "scale": SCALE,
        "initialValidTime": footprint["frames"][0]["slot"],
        "guideUrl": GUIDE,
        "licenseUrl": LICENSE,
        "builtAt": datetime.now(timezone.utc).isoformat(),
        "frames": frames,
        "processing": "Exact MASSDEN 8 m GRIB2 message only; kg/m³ × 1,000,000,000 = µg/m³. Native 3 km crop of the existing smoke footprint; nearest-neighbor Mercator rendering. One fixed 0-200 µg/m³ display ramp; values above 200 use the last color without changing source values. Missing cells transparent, no temporal interpolation.",
        "limitations": "Model estimate-not a monitor reading or smoke attributed only to Eaton. Smoke tracer is not total measured PM2.5 or AQI. A new model initialization supplies each hourly 1-hour forecast; not a single-run plume track. Fire emissions, transport and terrain are uncertain at neighborhood scale; no indoor or personal exposure estimate.",
    }
    target = ROOT / "output/hrrr-eaton/audit.json" if audit_only else destination
    target.parent.mkdir(parents=True, exist_ok=True)
    save_json(target, manifest)
    print(
        "HRRR coverage",
        sum(frame["status"] == "available" for frame in frames),
        "/",
        len(frames),
        flush=True,
    )
    return manifest


def build_historical_hrrr(record, geometry):
    extents = [shape(feature["geometry"]).bounds for feature in geometry["features"]]
    west = min(extent[0] for extent in extents)
    south = min(extent[1] for extent in extents)
    east = max(extent[2] for extent in extents)
    north = max(extent[3] for extent in extents)
    longitude_padding = max(0.25, (east - west) * 0.25)
    latitude_padding = max(0.25, (north - south) * 0.25)
    bounds = [
        west - longitude_padding,
        south - latitude_padding,
        east + longitude_padding,
        north + latitude_padding,
    ]
    start = (
        datetime.fromisoformat(record["ignition"])
        .replace(tzinfo=ZoneInfo("America/Los_Angeles"))
        .astimezone(timezone.utc)
    )
    destination = PUBLIC / "data/waves" / ("hrrr-" + record["id"].replace(":", "-"))
    destination.mkdir(parents=True, exist_ok=True)
    config = {"hrrr": {"forecastLeadHours": 1}}
    frames = []
    for hour in range(48):
        valid = start + timedelta(hours=hour)
        frame = prepare_hour(valid, config, bounds, destination, False)
        frames.append(frame)
        print("HRRR", record["id"], valid.isoformat(), frame["status"], flush=True)
    if not any(frame["status"] == "available" for frame in frames):
        return {
            "status": "coverage_limited",
            "reason": "No archived HRRR smoke frames for this fire's first two days.",
        }
    manifest_path = destination / "manifest.json"
    manifest = {
        "caseId": record["id"],
        "dataClass": "Historical",
        "product": "NOAA HRRR-Smoke MASSDEN / 8 m above ground",
        "bounds": bounds,
        "timezone": "America/Los_Angeles",
        "forecastLeadHours": 1,
        "cadenceMinutes": 60,
        "scale": SCALE,
        "initialValidTime": next(
            frame["validTime"] for frame in frames if frame["status"] == "available"
        ),
        "guideUrl": GUIDE,
        "frames": frames,
        "processing": "Archived hourly one-hour forecasts for the first two local days from the reported ignition date. Before December 21, 2021 12Z, source values are already in micrograms per cubic meter; later values are converted from kilograms per cubic meter.",
        "limitations": "Model estimate, not a monitor reading or smoke attributed to this fire alone.",
    }
    save_json(manifest_path, manifest)
    return {
        "status": "available",
        "caseId": record["id"],
        "manifest": "/" + manifest_path.relative_to(PUBLIC).as_posix(),
        "forecastLeadHours": 1,
        "timezone": "America/Los_Angeles",
        "reason": "Archived NOAA model frames prepared.",
    }
