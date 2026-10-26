import hashlib
import json
import math

from pyproj import Transformer
from shapely import transform as transform_geometry
from shapely.errors import GEOSException
from shapely.geometry import shape

from build_historical_coverage import PUBLIC, frozen_catalog, save_json, verify_catalog_record
from build_historical_evidence import perimeter_for
from build_power_data import county_geometry
from build_recovery_data import recovery_config

AREA_TRANSFORMER = Transformer.from_crs("EPSG:4326", "EPSG:3310", always_xy=True)
OUTPUT = PUBLIC / "data/historical-fires/county-lookup.json"


def checked_boundary(fire_id, decision, record):
    mtbs = decision.get("mtbs")
    if not mtbs or record.get("mtbs") != mtbs:
        return None, "Verified MTBS identity is unavailable or differs from the catalog."
    try:
        data, receipt = perimeter_for({"id": fire_id, "mtbs": mtbs})
        if not data or len(data.get("features", [])) != 1:
            raise ValueError("MTBS boundary is unavailable or not unique.")
        feature = data["features"][0]
        properties = feature.get("properties", {})
        for field in ("map_id", "event_id", "incid_type", "ig_date"):
            if properties.get(field) != mtbs.get(field):
                raise ValueError("MTBS boundary identity differs: " + field)
        digest = hashlib.sha256(
            json.dumps(feature["geometry"], sort_keys=True).encode()
        ).hexdigest()
        if digest != decision.get("boundarySha256"):
            raise ValueError("MTBS boundary differs from the verified scope boundary.")
        boundary = shape(feature["geometry"])
        if (
            boundary.geom_type not in ("Polygon", "MultiPolygon")
            or boundary.is_empty
            or not boundary.is_valid
        ):
            raise ValueError("MTBS boundary is invalid; no repair was applied.")
        return (boundary, receipt), ""
    except (OSError, ValueError, KeyError, TypeError, GEOSException) as error:
        return None, "Verified MTBS boundary unavailable: " + str(error)


def county_name(name):
    if name.lower().endswith(" county"):
        return name
    return name + " County"


def matching_counties(boundary, counties):
    projected_boundary = transform_geometry(boundary, AREA_TRANSFORMER.transform, interleaved=False)
    total_area = projected_boundary.area
    if not math.isfinite(total_area) or total_area <= 0:
        raise ValueError("Verified fire boundary has no positive projected area.")
    matches = []
    for geoid, county in counties.items():
        if not boundary.intersects(county["geometry"]):
            continue
        overlap = boundary.intersection(county["geometry"])
        if overlap.is_empty or overlap.area <= 0:
            continue
        overlap_area = transform_geometry(
            overlap, AREA_TRANSFORMER.transform, interleaved=False
        ).area
        if not math.isfinite(overlap_area) or overlap_area <= 0:
            raise ValueError("County overlap area could not be calculated.")
        matches.append(
            (
                overlap_area,
                {
                    "geoid": geoid,
                    "name": county_name(county["name"]),
                    "overlapAreaKm2": round(overlap_area / 1_000_000, 6),
                    "overlapSharePercent": round(overlap_area / total_area * 100, 6),
                },
            )
        )
    matches.sort(key=lambda match: (-match[0], match[1]["geoid"]))
    return [match[1] for match in matches]


def build_lookup():
    scope = json.loads((PUBLIC / "data/historical-fires/scope.json").read_text(encoding="utf-8"))
    records = frozen_catalog()
    decisions = {row["fireId"]: row for row in scope["decisions"] if row["eligible"]}
    if (
        len(scope["eligibleFireIds"]) != scope["eligibleFireCount"]
        or len(set(scope["eligibleFireIds"])) != scope["eligibleFireCount"]
        or set(decisions) != set(scope["eligibleFireIds"])
    ):
        raise ValueError("Verified scope and eligible fire identities differ.")
    for fire_id in scope["eligibleFireIds"]:
        verify_catalog_record(records[fire_id])

    config = recovery_config()["power"]["annualExports"][0]
    counties, county_receipt = county_geometry(config)
    lookup = []
    for fire_id in scope["eligibleFireIds"]:
        result = {
            "fireId": fire_id,
            "status": "unavailable",
            "primaryCounty": "",
            "counties": [],
            "reason": "",
        }
        checked, reason = checked_boundary(fire_id, decisions[fire_id], records[fire_id])
        if not checked:
            result["reason"] = reason
            lookup.append(result)
            continue
        boundary, receipt = checked
        matches = matching_counties(boundary, counties)
        result["boundary"] = {
            "sourceUrl": receipt.get(
                "sourceUrl", decisions[fire_id]["boundarySource"]["sourceUrl"]
            ),
            "sha256": decisions[fire_id]["boundarySha256"],
        }
        if not matches:
            result["reason"] = "Verified MTBS perimeter has no positive-area county overlap."
        else:
            result["counties"] = matches
            result["primaryCounty"] = matches[0]["name"]
            result["status"] = "single" if len(matches) == 1 else "multiple"
        lookup.append(result)

    output = {
        "schemaVersion": 1,
        "eligibleFireCount": scope["eligibleFireCount"],
        "countySource": county_receipt,
        "areaCrs": "EPSG:3310",
        "overlapShareBasis": "Percentage of total verified MTBS perimeter area",
        "records": lookup,
    }
    validate_lookup(output, decisions, records, counties)
    save_json(OUTPUT, output)
    return output


def validate_lookup(output, decisions, records, counties):
    rows = output["records"]
    if len(rows) != len(decisions) or len({row["fireId"] for row in rows}) != len(rows):
        raise ValueError("County lookup has missing or duplicate fire identities.")
    for row in rows:
        fire_id = row["fireId"]
        if fire_id not in decisions or fire_id not in records:
            raise ValueError("County lookup contains an ineligible fire.")
        if not row["counties"]:
            if row["primaryCounty"] or not row["reason"]:
                raise ValueError("Unresolved county lookup must include a reason and no county.")
            continue
        checked, reason = checked_boundary(fire_id, decisions[fire_id], records[fire_id])
        if not checked:
            raise ValueError("Assigned county has no verified fire boundary: " + reason)
        boundary, _ = checked
        expected = matching_counties(boundary, counties)
        if row["counties"] != expected or row["primaryCounty"] != expected[0]["name"]:
            raise ValueError(
                "Displayed county is not supported by a positive-area boundary intersection."
            )


if __name__ == "__main__":
    result = build_lookup()
    one = sum(len(row["counties"]) == 1 for row in result["records"])
    multiple = sum(len(row["counties"]) > 1 for row in result["records"])
    unresolved = [row for row in result["records"] if not row["counties"]]
    print(f"One county: {one}; multiple counties: {multiple}; no county: {len(unresolved)}")
    for row in unresolved:
        print(row["fireId"] + " / " + row["reason"])
