import argparse
import json
import xml.etree.ElementTree as ET
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import rasterio
from PIL import Image
from rasterio.features import geometry_mask
from rasterio.transform import from_bounds
from rasterio.warp import Resampling, reproject, transform_bounds, transform_geom
from rasterio.windows import from_bounds as window_from_bounds

from build_waves_data import download

ROOT = Path(__file__).resolve().parents[1]
PUBLIC = ROOT / "frontend/public"
DEST = PUBLIC / "data/waves/goes-eaton"
AUDIT = ROOT / "output/goes-eaton"
BUCKET = "https://noaa-goes18.s3.amazonaws.com/"
BOUNDS = [-118.7, 33.8, -117.7, 34.6]
GUIDE = "https://www.star.nesdis.noaa.gov/atmospheric-composition-training/documents/ABI_ADP_Users_Guide.pdf"


class SourceFormatUnavailable(ValueError):
    pass


class CoverageUnavailable(ValueError):
    pass


def classify(smoke, cloud, snow, dqf, pqi):
    confidence = (dqf >> 2) & 3

    none_confidence = (dqf >> 6) & 3
    valid = ((smoke == 1) & (confidence <= 1)) | ((smoke == 0) & (none_confidence <= 1))
    valid &= (cloud == 0) & (snow == 0) & ((pqi & 63) == 0)
    result = np.zeros(smoke.shape, dtype="uint8")
    result[valid] = 1
    result[valid & (smoke == 1)] = 2
    return result


def baseline_policy():
    settings = json.loads(
        (ROOT / "data/historical_coverage_sources.json").read_text(encoding="utf-8")
    )
    return settings.get("goesBaselinePolicy", {})


def quality_layout(path):
    with rasterio.open(f'NETCDF:"{path}":DQF') as source:
        tags = source.tags(1)
    if not tags.get("flag_meanings") or not tags.get("flag_values"):
        raise SourceFormatUnavailable("GOES quality flag definitions are not supplied")
    meanings = tags["flag_meanings"].split()
    values = [int(value) for value in tags["flag_values"].strip("{}").split(",")]
    if len(meanings) != len(values):
        raise ValueError("GOES quality flag names and values have different lengths")
    if "high_confidence_smoke_detection_qf" not in meanings:
        raise SourceFormatUnavailable("GOES smoke confidence definitions are not verified")
    high = values[meanings.index("high_confidence_smoke_detection_qf")]
    if high == 12:
        if not baseline_policy().get("detectionsOnlyApproved"):
            raise SourceFormatUnavailable(
                "GOES Baseline quality flags are present; their interpretation requires approval. Source data are not missing."
            )
        masks = [int(value) for value in tags["flag_masks"].strip("{}").split(",")]
        expected = [
            ("good_smoke_detection_retrieval_qf", 1, 0),
            ("medium_confidence_smoke_detection_qf", 12, 4),
            ("high_confidence_smoke_detection_qf", 12, 12),
            ("within_valid_solar_and_satellite_zenith_angle_range_qf", 128, 0),
        ]
        for name, mask, value in expected:
            if name not in meanings:
                raise SourceFormatUnavailable(
                    "GOES Baseline quality definition is missing: " + name
                )
            index = meanings.index(name)
            if masks[index] != mask or values[index] != value:
                raise SourceFormatUnavailable(
                    "GOES Baseline quality definitions differ from the approved source flags"
                )
        return "baseline"
    for name, expected in [("high", 0), ("medium", 4), ("low", 8)]:
        if values[meanings.index(name + "_confidence_smoke_detection_qf")] != expected:
            raise SourceFormatUnavailable("GOES quality definitions do not match a verified layout")
    return "enterprise"


def classify_baseline(smoke, dqf):

    confidence = dqf & 12
    accepted = (smoke == 1) & ((dqf & 1) == 0) & ((dqf & 128) == 0)
    accepted &= (confidence == 4) | (confidence == 12)
    result = np.zeros(smoke.shape, dtype="uint8")
    result[accepted] = 2
    return result


def frame_arrays(path, variables, window, crs, transform):
    arrays = []
    for variable in variables:
        with rasterio.open(f'NETCDF:"{path}":{variable}') as source:
            if source.crs != crs or source.window_transform(window) != transform:
                raise ValueError("Quality grids do not match")
            arrays.append(source.read(1, window=window))
    return arrays


def read_frame(path, perimeter, footprint=BOUNDS, coverage_key="eaton"):
    with rasterio.open(f'NETCDF:"{path}":Smoke') as source:
        bounds = transform_bounds("EPSG:4326", source.crs, *footprint)
        window = window_from_bounds(*bounds, source.transform).round_offsets().round_lengths()
        transform = source.window_transform(window)
        crs = source.crs
        metadata = source.tags()
        if metadata["NC_GLOBAL#platform_ID"] != "G18":
            raise ValueError("Wrong satellite")
    layout = quality_layout(path)
    variables = ["Smoke", "Cloud", "SnowIce", "DQF", "PQI1"]
    if layout == "baseline":
        variables = ["Smoke", "DQF"]
    arrays = frame_arrays(path, variables, window, crs, transform)
    if layout == "baseline":
        result = classify_baseline(*arrays)
        metadata["app_quality_interpretation"] = (
            "NOAA Baseline; detections only; all other pixels unknown"
        )
    else:
        result = classify(*arrays)
    counts = frame_coverage(result, perimeter, transform, crs, variables, arrays, coverage_key)
    return result, transform, crs, metadata, counts


def frame_coverage(result, perimeter, transform, crs, variables, arrays, coverage_key):
    geometries = []
    for feature in perimeter["features"]:
        geometries.append(transform_geom("EPSG:4326", crs, feature["geometry"]))
    inside = geometry_mask(geometries, result.shape, transform, invert=True)
    if not inside.any():
        raise CoverageUnavailable(
            "No native pixel center lies inside the verified perimeter; no larger footprint or geometry repair applied"
        )
    counts = {}
    for name, values in [("region", result), (coverage_key, result[inside])]:
        counts[name] = {
            "pixels": int(values.size),
            "usable": int(np.count_nonzero(values)),
            "smoke": int(np.count_nonzero(values == 2)),
        }
    evidence = {}
    for name, values in zip(variables, arrays):
        codes, totals = np.unique(values[inside], return_counts=True)
        evidence[name] = {str(int(code)): int(total) for code, total in zip(codes, totals)}
    counts[coverage_key + "Flags"] = evidence
    return counts


def render(result, transform, crs, target, footprint=BOUNDS):

    projected = transform_bounds("EPSG:4326", "EPSG:3857", *footprint)
    destination = np.zeros((160, 160), dtype="uint8")
    reproject(
        result,
        destination,
        src_transform=transform,
        src_crs=crs,
        dst_transform=from_bounds(*projected, 160, 160),
        dst_crs="EPSG:3857",
        resampling=Resampling.nearest,
    )
    rgba = np.zeros((160, 160, 4), dtype="uint8")
    rgba[destination == 2] = [112, 67, 165, 180]

    rgba[destination == 0] = [110, 120, 130, 65]
    Image.fromarray(rgba).save(target)


def main():
    parser = argparse.ArgumentParser(
        description="Audit one Eaton afternoon, then optionally render its GOES-18 smoke replay.\n\nReceives --render; uses cached NOAA files and never changes EPA or HMS data.\n"
    )
    parser.add_argument("--render", action="store_true")
    args = parser.parse_args()
    AUDIT.mkdir(parents=True, exist_ok=True)
    perimeter = json.loads((PUBLIC / "data/waves.json").read_text())["perimeter"]["value"]
    ns = {"s": "http://s3.amazonaws.com/doc/2006-03-01/"}
    keys = []
    for hour in [20, 21, 22]:
        prefix = f"ABI-L2-ADPC/2025/008/{hour}/"
        listing, _ = download(
            f"goes18-20250108-{hour}-listing.xml", BUCKET + "?list-type=2&prefix=" + prefix
        )
        root = ET.parse(listing).getroot()
        if root.findtext("s:IsTruncated", namespaces=ns) != "false":
            raise ValueError("Incomplete archive listing")
        for item in root.findall("s:Contents", ns):
            keys.append(item.findtext("s:Key", namespaces=ns))
    frames = []
    for hour in [20, 21, 22]:
        for minute in range(0, 60, 10):
            slot = f"2025-01-08T{hour}:{minute:02d}:00Z"
            matches = []
            for key in keys:
                stamp = key.split("_s")[1].split("_")[0]
                start = datetime.strptime(stamp[:13], "%Y%j%H%M%S")
                if start.hour == hour and start.minute // 10 == minute // 10:
                    matches.append(key)
            if len(matches) > 1:
                raise ValueError("Duplicate scans require review")
            frame = {"slot": slot, "status": "unavailable", "reason": "No scan in archive"}
            if matches:
                key = matches[0]
                try:
                    path, receipt = download(Path(key).name, BUCKET + key)
                except OSError as error:
                    frame["reason"] = "Source access failed: " + str(error)
                else:
                    result, transform, crs, metadata, counts = read_frame(path, perimeter)
                    frame.update(
                        {
                            "status": "available",
                            "reason": None,
                            "sourceUrl": receipt["sourceUrl"],
                            "retrievedAt": receipt["retrievedAt"],
                            "bytes": receipt["bytes"],
                            "sha256": receipt["sha256"],
                            "start": metadata["NC_GLOBAL#time_coverage_start"],
                            "end": metadata["NC_GLOBAL#time_coverage_end"],
                            "publishedAt": metadata["NC_GLOBAL#date_created"],
                            "coverage": counts,
                        }
                    )
                    if args.render:
                        DEST.mkdir(parents=True, exist_ok=True)
                        name = f"{hour}{minute:02d}.png"
                        render(result, transform, crs, DEST / name)
                        frame["image"] = "/data/waves/goes-eaton/" + name
                    print(slot, counts, flush=True)
            frames.append(frame)
    manifest = {
        "caseId": "eaton",
        "dataClass": "Historical",
        "product": "GOES-18 ABI ADPC Enterprise",
        "bounds": BOUNDS,
        "resolution": "2 km at nadir; larger off-nadir",
        "coverageDefinition": "Counts on original source-grid crop; Eaton uses pixel centers inside its polygon, not area weighting. Region is the enclosing source-grid rectangle, not the rendered geographic rectangle.",
        "window": "January 8, 2025, noon-3 p.m. PST",
        "guideUrl": GUIDE,
        "builtAt": datetime.now(timezone.utc).isoformat(),
        "processing": "Smoke=1 requires high/medium smoke confidence. Smoke=0 requires high/medium none/unknown/clear-sky confidence. Cloud, snow/ice, invalid coordinates and out-of-range angles excluded. Unknown gray, detected smoke purple, usable nondetection transparent (not clean air). Nearest-neighbor Mercator rendering. No interpolation or fire attribution.",
        "frames": frames,
    }
    (AUDIT / "audit.json").write_text(json.dumps(manifest, indent=2) + "\n")
    if args.render:
        if not any(f.get("coverage", {}).get("eaton", {}).get("usable", 0) for f in frames):
            raise ValueError("No usable Eaton pixels; do not publish replay")
        (DEST / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")


if __name__ == "__main__":
    main()
