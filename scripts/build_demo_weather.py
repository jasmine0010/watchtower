import csv
import hashlib
import io
import json
import re
import xml.etree.ElementTree as ET
from datetime import datetime, timezone
from pathlib import Path
from urllib.request import urlopen

BASE = "https://mesonet.agron.iastate.edu"
TIME = "2025-01-08T23:51:00Z"
WEATHER = (
    BASE
    + "/cgi-bin/request/asos.py?network=CA_ASOS&data=tmpf&data=relh&data=drct&data=sknt&data=gust&data=metar&sts=2025-01-08T22:00:00Z&ets=2025-01-09T00:00:00Z&tz=UTC&format=onlycomma&latlon=yes&report_type=3&report_type=4"
)
ALERTS = (
    BASE
    + "/cgi-bin/request/gis/watchwarn.py?accept=kml&at=2025-01-08T23:51Z&timeopt=2&location_group=states&states=CA"
)


def fetch(url, sources):
    with urlopen(url, timeout=90) as response:
        content = response.read()
    sources.append(
        {
            "sourceUrl": url,
            "retrievedAt": datetime.now(timezone.utc).isoformat(),
            "sha256": hashlib.sha256(content).hexdigest(),
        }
    )
    return content.decode("utf-8-sig")


def number(raw):
    return None if raw in ("M", "") else float(raw)


def main():
    sources = []
    metadata = json.loads(fetch(BASE + "/geojson/network.py?network=CA_ASOS", sources))
    names = {station["id"]: station["properties"]["sname"] for station in metadata["features"]}
    stations = {}
    for row in csv.DictReader(io.StringIO(fetch(WEATHER, sources))):
        timestamp = row["valid"].replace(" ", "T") + ":00Z"
        if timestamp > TIME or row["tmpf"] == "M" or row["station"] not in names:
            continue
        previous = stations.get(row["station"])
        if previous and previous["timestamp"] >= timestamp:
            continue
        stations[row["station"]] = {
            "id": row["station"],
            "name": names[row["station"]],
            "timestamp": timestamp,
            "longitude": float(row["lon"]),
            "latitude": float(row["lat"]),
            **{key: number(row[key]) for key in ["tmpf", "relh", "drct", "sknt", "gust"]},
            "metar": row["metar"],
        }
    ns = {"k": "http://www.opengis.net/kml/2.2"}
    root = ET.fromstring(fetch(ALERTS, sources))
    alerts = {}
    for placemark in root.findall(".//k:Placemark", ns):
        label = placemark.findtext("k:name", "", ns)
        begin = placemark.findtext("k:TimeSpan/k:begin", "", ns)
        end = placemark.findtext("k:TimeSpan/k:end", "", ns)
        if not begin <= TIME < end:
            raise ValueError("Warning outside Demo timestamp")
        link = re.search(r'href="([^"]+)"', placemark.findtext("k:description", "", ns)).group(1)
        feature = alerts.setdefault(
            (label, begin, end),
            {
                "type": "Feature",
                "id": label,
                "properties": {
                    "event": label.split(" ", 1)[1],
                    "sent": begin,
                    "expires": end,
                    "sourceUrl": link,
                },
                "geometry": {"type": "MultiPolygon", "coordinates": []},
            },
        )
        for polygon in placemark.findall(".//k:Polygon", ns):
            boundaries = [
                polygon.find("k:outerBoundaryIs", ns),
                *polygon.findall("k:innerBoundaryIs", ns),
            ]
            rings = []
            for boundary in boundaries:
                text = boundary.findtext("k:LinearRing/k:coordinates", "", ns)
                ring = []
                for pair in text.split():
                    point = []
                    for value in pair.split(",")[:2]:
                        point.append(float(value))
                    ring.append(point)
                rings.append(ring)
            feature["geometry"]["coordinates"].append(rings)
    output = {
        "time": TIME,
        "stations": list(stations.values()),
        "alerts": {"type": "FeatureCollection", "features": list(alerts.values())},
        "sources": sources,
    }
    path = (
        Path(__file__).resolve().parents[1]
        / "frontend/public/data/demo/california-2025-01-08-weather.json"
    )
    path.write_text(json.dumps(output, separators=(",", ":")) + "\n", encoding="utf-8")
    print(f"Saved {len(stations)} weather stations and {len(alerts)} NWS warning events")


if __name__ == "__main__":
    main()
