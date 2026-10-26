import hashlib
import argparse
import io
import json
import math
import sys
import xml.etree.ElementTree as ET
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

if sys.platform == "win32":
    sys.path.insert(0, str(ROOT / ".interface-deps"))
import shapefile
from pyproj import CRS, Transformer
from shapely.geometry import shape
from shapely.ops import transform, unary_union

from build_interface_catalog import build_catalog


def unavailable(reason):
    return {"status": "unavailable", "reason": reason}


def matching_features(reader, identifier):

    return [
        reader.shapeRecord(row.oid)
        for row in reader.iterRecords()
        if row.as_dict().get("Fire_Segme") == identifier
    ]


def verify_values(rows, fire_id, identifier, hm23):
    first = rows[0].record.as_dict()
    fields = (
        "Fire_ID",
        "Fire_Segme",
        "Segment_ID",
        "Fire_Name",
        "Start_Date",
        "UpArea_km2",
        "L_X1",
        "L_X2",
        "L_X3",
        "RainAccAtP",
        "RainIntAtP",
    )
    for row in rows:
        attributes = row.record.as_dict()
        if any(attributes.get(key) != first.get(key) for key in fields):
            raise ValueError("Duplicate assessment IDs have conflicting threshold attributes.")
    if first["Fire_ID"] != fire_id or first["Fire_Segme"] != identifier:
        raise ValueError("Assessment identity disagrees with the case.")
    if str(first["Segment_ID"]) != identifier.removeprefix(fire_id + "_"):
        raise ValueError("Numeric segment identity disagrees with the case.")
    if not math.isclose(first["L_X1"], hm23, abs_tol=0.000051):
        raise ValueError("Burned-and-steep attribute disagrees with inventory precision.")
    depth, intensity = first["RainAccAtP"], first["RainIntAtP"]
    if not all(
        isinstance(v, (int, float)) and math.isfinite(v) and v > 0 for v in (depth, intensity)
    ):
        raise ValueError("Threshold is missing, nonpositive or nonfinite.")
    if not math.isclose(depth, intensity * 15 / 60, abs_tol=1e-8):
        raise ValueError("Supplied depth and hourly intensity disagree for 15 minutes.")
    return depth, intensity


def verify_metadata(raw, assessment_date):
    root = ET.fromstring(raw)
    date = root.findtext("idinfo/citation/citeinfo/pubdate")
    if date != assessment_date.replace("-", ""):
        raise ValueError(
            "Threshold metadata date disagrees with the displayed assessment snapshot."
        )
    definitions = {}
    for field in root.findall(".//attr"):
        label = field.findtext("attrlabl", "")
        if label in ("RainAccAtP50_mm", "RainIntAtP50_mm"):
            definitions[label] = field.findtext("attrdef", "")
    for label, unit in (
        ("RainAccAtP50_mm", "millimeters)"),
        ("RainIntAtP50_mm", "millimeters per hour)"),
    ):
        definition = definitions.get(label, "")
        if (
            not definition.startswith("15 rainfall")
            or unit not in definition
            or "= 0.50" not in definition
        ):
            raise ValueError("Metadata does not confirm 15-minute, 50% threshold units.")
    return definitions


def extract_threshold(record):
    history = record.get("history")
    if not history:
        return unavailable(
            "No checked assessment geometry or archive is linked to this observation."
        )
    evidence = history["evidence"]
    if evidence.get("basin_contains_observation") is False:
        return unavailable(
            "Observation is outside the linked basin; spatial association remains unresolved."
        )
    scope = "basin" if history["watersheds"]["features"] else "segment"
    key = "watersheds" if scope == "basin" else "segments"
    local = history[key]["features"]
    if len(local) != 1 or local[0]["properties"].get("id") != record["id"]:
        return unavailable("A single checked basin or stream-segment geometry is required.")
    path = ROOT / "data/interface_sources" / history["archive"]
    if not path.is_file():
        return unavailable("The linked original assessment archive is not locally accessible.")
    digest = hashlib.sha256(path.read_bytes()).hexdigest()
    if digest != history["archiveSha256"]:
        return unavailable("Assessment archive differs from the checked geometry snapshot.")
    fire_id = record["inventory"]["AssessmentFireID"]
    base = f"{fire_id}_{scope.title()}_RainfallEstimates_15min_RainAtP_50"
    try:
        year = record["inventory"]["FireYear"]
        release = json.loads((ROOT / f"data/interface_sources/assessments_{year}.json").read_text())
        attachments = [
            entry for entry in release["files"] if entry["name"].endswith("_" + fire_id + ".zip")
        ]
        if len(attachments) != 1:
            raise ValueError("The original assessment release attachment is ambiguous or absent.")
        download = attachments[0]["url"]
        release_id = download.split("/get/")[1].split("?")[0]
        with zipfile.ZipFile(path) as archive:
            metadata = archive.read(base + ".shp.xml")
            definitions = verify_metadata(metadata, record["assessmentPublished"])
            reader = shapefile.Reader(
                **{
                    part: io.BytesIO(archive.read(base + "." + part))
                    for part in ("shp", "shx", "dbf")
                }
            )
            rows = matching_features(reader, record["id"])
            if not rows:
                raise ValueError("Exact assessment identifier absent from the threshold layer.")
            depth, intensity = verify_values(rows, fire_id, record["id"], record["hm23"])
            crs = CRS.from_wkt(archive.read(base + ".prj").decode())
            project = Transformer.from_crs(4326, crs, always_xy=True).transform
            saved = transform(project, shape(local[0]["geometry"]))
            supplied = unary_union([shape(row.shape.__geo_interface__) for row in rows])

            distance = supplied.hausdorff_distance(saved)
            if not supplied.is_valid or not saved.is_valid or distance > 0.00001:
                raise ValueError("Threshold geometry does not equal the checked map geometry.")
            return {
                "status": "available",
                "observationId": record["observationId"],
                "assessmentId": record["id"],
                "scope": scope,
                "durationMinutes": 15,
                "probability": 0.5,
                "depthMm": depth,
                "intensityMmH": intensity,
                "depthUnit": "mm",
                "intensityUnit": "mm/hour",
                "assessmentDate": record["assessmentPublished"],
                "version": "Dated archive snapshot; no numbered version supplied",
                "sourceUrl": "https://data.usgs.gov/datacatalog/data/USGS:" + release_id,
                "downloadUrl": download,
                "archive": history["archive"],
                "archiveSha256": digest,
                "layer": base + ".shp",
                "metadataSha256": hashlib.sha256(metadata).hexdigest(),
                "definitions": definitions,
                "matchedFeatureParts": len(rows),
                "geometryDifferenceMetres": distance,
                "limitation": (
                    "Agency-linked stream segment; its complete catchment outline is unavailable. "
                    if scope == "segment"
                    else ""
                )
                + "Historical post-fire conditions, not current conditions. Agency estimates have not been independently validated here.",
            }
    except (KeyError, ValueError, zipfile.BadZipFile) as error:
        return unavailable(str(error))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(
        description="Extract documented agency thresholds from already downloaded assessment ZIPs.\n\nReceives the reviewed case catalog and local archives; never downloads or models.\nUses the geospatial Python environment.\n"
    )
    parser.add_argument(
        "--checked-date", required=True, help="Date of this local source audit, YYYY-MM-DD"
    )
    args = parser.parse_args()
    cases = build_catalog()["cases"]
    results = {record["observationId"]: extract_threshold(record) for record in cases}
    destination = ROOT / "data/verified_rainfall_thresholds.json"
    destination.write_text(
        json.dumps({"checkedDate": args.checked_date, "cases": results}, indent=2) + "\n"
    )
    for identifier, result in results.items():
        print(identifier, result["status"], result.get("depthMm", result.get("reason")))
