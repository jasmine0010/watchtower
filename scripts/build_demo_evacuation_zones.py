import json
from pathlib import Path
from urllib.parse import urlencode
from urllib.request import Request, urlopen

GEOMETRY_SOURCE = "https://services.arcgis.com/RmCCgQtiZLDCtblq/arcgis/rest/services/Evacuation_Zones_Jan_13_2025/FeatureServer/0"
MAXIMUM_EXTENT_SOURCE = "https://services.arcgis.com/RmCCgQtiZLDCtblq/arcgis/rest/services/Maximum_Extent_Evacuation_Zones/FeatureServer/0"
DIFFERENCE_SOURCE = (
    "https://utility.arcgisonline.com/arcgis/rest/services/Geometry/GeometryServer/difference"
)
OUTPUT = (
    Path(__file__).resolve().parents[1]
    / "frontend/public/data/demo/palisades-2025-01-10-evacuation-zones.geojson"
)
CUTOFF = 1736566500000

ORDERS = """DRY-U026-A LOS-Q0767 MAL-C111-A MAL-C111-B MAL-C112-B MTN-U028
RMB-U030-A RMB-U030-B RMB-U030-D RMB-U030-E RRC-U027 SAN-Q1395-B SAN-Q1396-B SDP-U029
SSM-U010-A SSM-U010-B TOP-U001 TOP-U002 TOP-U003 TOP-U004 TOP-U005
TOP-U006 TOP-U007 TOP-U008 TOP-U009
LOS-Q0762-A LOS-Q0778-A LOS-Q0780 LOS-Q0781-A LOS-Q0782-A LOS-Q0782-B LOS-Q0798""".split()
WARNINGS = """CAL-C405 CAL-C406 CAL-C407 CAL-C408 CAL-C409 CAL-C410 CAL-C411
CAL-C412 CAL-C413 CAL-C414 CAL-C415 DRY-U026 DRY-U026-B LOS-Q0765
LOS-Q1118 MAL-C112 MAL-C112-A MCR-U021-A RMB-U030-C SAN-Q1388-B
SAN-Q1395-A SAN-Q1396-A LOS-Q0406-A LOS-Q0407 LOS-Q0751 LOS-Q0762-B
LOS-Q0764 LOS-Q0772 LOS-Q0779 LOS-Q0783 LOS-Q0800 LOS-Q1089 LOS-Q1119 LOS-Q1163""".split()


def reconstructed_a_zone(name):
    query = urlencode(
        {"where": f"zoneId='US-CA-XLA-{name}'", "outFields": "zoneId", "outSR": "4326", "f": "json"}
    )
    with urlopen(f"{MAXIMUM_EXTENT_SOURCE}/query?{query}", timeout=60) as response:
        full_zone = json.load(response)["features"]
    if len(full_zone) != 1:
        raise ValueError(f"Missing full-zone boundary for {name}")
    b_query = urlencode(
        {"where": f"zone_id='{name}-B'", "outFields": "zone_id", "outSR": "4326", "f": "json"}
    )
    with urlopen(f"{GEOMETRY_SOURCE}/query?{b_query}", timeout=60) as response:
        b_zones = json.load(response)["features"]
    if not b_zones or any(zone["geometry"] != b_zones[0]["geometry"] for zone in b_zones):
        raise ValueError(f"Missing B-zone boundary for {name}")
    fields = {
        "f": "json",
        "sr": "4326",
        "geometries": json.dumps(
            {"geometryType": "esriGeometryPolygon", "geometries": [full_zone[0]["geometry"]]}
        ),
        "geometry": json.dumps(
            {"geometryType": "esriGeometryPolygon", "geometry": b_zones[0]["geometry"]}
        ),
    }
    request = Request(DIFFERENCE_SOURCE, data=urlencode(fields).encode())
    with urlopen(request, timeout=60) as response:
        difference = json.load(response)
    polygons = difference.get("geometries", [])
    if len(polygons) != 1 or len(polygons[0].get("rings", [])) != 1:
        raise ValueError(f"Unexpected reconstructed boundary for {name}")
    return {"type": "Polygon", "coordinates": polygons[0]["rings"]}


def main():
    query = urlencode(
        {
            "where": "1=1",
            "outFields": "zone_id,zone_status,last_updated",
            "outSR": "4326",
            "resultRecordCount": "2000",
            "f": "geojson",
        }
    )
    with urlopen(f"{GEOMETRY_SOURCE}/query?{query}", timeout=60) as response:
        archive = json.load(response)
    if archive.get("type") != "FeatureCollection" or len(archive.get("features", [])) != 267:
        raise ValueError("Unexpected county evacuation archive")

    wanted = {name: "Evacuation Order" for name in ORDERS}
    wanted.update({name: "Evacuation Warning" for name in WARNINGS})
    selected = {}
    for feature in archive["features"]:
        record = feature["properties"]
        name = record.get("zone_id")
        if (
            name not in wanted
            or not isinstance(record.get("last_updated"), int)
            or (
                record["last_updated"] > CUTOFF
                and name not in ("LOS-Q0779", "SAN-Q1395-B", "SAN-Q1396-B")
            )
            or feature["geometry"]["type"] not in ("Polygon", "MultiPolygon")
        ):
            continue

        if name == "LOS-Q0779" and record["zone_status"] != "Evacuation Warning":
            continue
        feature["properties"] = {
            "ZONE_NAME": name,
            "STATUS": wanted[name],
            "EDIT_DATE": min(record["last_updated"], CUTOFF),
            "DEMO_ARCHIVED": True,
        }
        if record["last_updated"] > CUTOFF:
            feature["properties"]["GEOMETRY_EDIT_DATE"] = record["last_updated"]
        if name in selected:
            if selected[name]["geometry"] != feature["geometry"]:
                raise ValueError(f"Different polygons share zone name {name}")
            continue
        selected[name] = feature

    for name in ("SAN-Q1395", "SAN-Q1396"):
        selected[f"{name}-A"] = {
            "type": "Feature",
            "geometry": reconstructed_a_zone(name),
            "properties": {
                "ZONE_NAME": f"{name}-A",
                "STATUS": "Evacuation Warning",
                "EDIT_DATE": CUTOFF,
                "DEMO_ARCHIVED": True,
                "DEMO_RECONSTRUCTED": True,
            },
        }

    if len(selected) != 63:
        raise ValueError(f"January 10 zone set changed: {sorted(selected)}")
    zones = {"type": "FeatureCollection", "features": [selected[name] for name in sorted(selected)]}
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT.write_text(json.dumps(zones, separators=(",", ":")), encoding="utf-8")
    print(f"Saved {len(selected)} January 10 zones; {len(wanted) - len(selected)} not mapped")


if __name__ == "__main__":
    main()
