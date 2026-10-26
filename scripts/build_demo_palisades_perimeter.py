import json
from pathlib import Path
from urllib.parse import urlencode
from urllib.request import urlopen

SOURCE = "https://services.arcgis.com/xsiPoFK0f7RrxF0D/arcgis/rest/services/Palisades_Fire_Progression/FeatureServer/0/query"
UNION = "https://utility.arcgisonline.com/ArcGIS/rest/services/Geometry/GeometryServer/union"
OUTPUT = (
    Path(__file__).resolve().parents[1]
    / "frontend/public/data/demo/palisades-2025-01-08-perimeter.geojson"
)


def request(url, values):
    encoded = urlencode(values).encode()
    with urlopen(
        url + ("?" + encoded.decode() if url == SOURCE else ""),
        None if url == SOURCE else encoded,
        timeout=60,
    ) as response:
        return json.load(response)


def signed_area(ring):
    return sum(a[0] * b[1] - b[0] * a[1] for a, b in zip(ring, ring[1:]))


def contains(ring, point):
    x, y = point
    inside = False
    for a, b in zip(ring, ring[1:]):
        if (a[1] > y) != (b[1] > y) and x < (b[0] - a[0]) * (y - a[1]) / (b[1] - a[1]) + a[0]:
            inside = not inside
    return inside


def main():
    source = request(
        SOURCE,
        {
            "where": "OBJECTID<=5",
            "outFields": "OBJECTID,PROG_DATETIME,PROG_TOTAL_ACRES",
            "returnGeometry": "true",
            "outSR": "4326",
            "f": "json",
        },
    )
    features = sorted(source["features"], key=lambda feature: feature["attributes"]["OBJECTID"])
    if [feature["attributes"]["OBJECTID"] for feature in features] != [1, 2, 3, 4, 5]:
        raise ValueError("Expected five progression slices through Jan 8, 23:37 UTC")
    merged = request(
        UNION,
        {
            "geometries": json.dumps(
                {
                    "geometryType": "esriGeometryPolygon",
                    "geometries": [feature["geometry"] for feature in features],
                }
            ),
            "sr": "4326",
            "f": "json",
        },
    )
    if "error" in merged:
        raise ValueError(merged["error"])

    polygons = [[ring] for ring in merged["geometry"]["rings"] if signed_area(ring) < 0]
    for hole in (ring for ring in merged["geometry"]["rings"] if signed_area(ring) > 0):
        parent = next((polygon for polygon in polygons if contains(polygon[0], hole[0])), None)
        if parent is None:
            raise ValueError("Unmatched hole in cumulative footprint")
        parent.append(hole)
    if not polygons or features[-1]["attributes"]["PROG_TOTAL_ACRES"] != 17184:
        raise ValueError("Unexpected Palisades progression extent")
    perimeter = {
        "type": "FeatureCollection",
        "features": [
            {
                "type": "Feature",
                "properties": {
                    "OBJECTID": -1,
                    "poly_IncidentName": "Palisades Fire",
                    "poly_GISAcres": 17184,
                    "poly_DateCurrent": 1736379420000,
                    "demo": True,
                },
                "geometry": {"type": "MultiPolygon", "coordinates": polygons},
            }
        ],
    }
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT.write_text(json.dumps(perimeter, separators=(",", ":")), encoding="utf-8")
    print(f"Wrote {OUTPUT} ({len(polygons)} outer rings)")


if __name__ == "__main__":
    main()
