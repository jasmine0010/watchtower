import csv
import hashlib
import io
import json
import sys
from datetime import datetime, timezone
from pathlib import Path
from urllib.request import urlopen

ROOT = Path(__file__).resolve().parents[1]
SOURCE_URL = "https://files.airnowtech.org/airnow/today/cityzipcodes.csv"
CACHED_SOURCE = ROOT / "data/raw/waves/update-20261019T050449-airnow-places.csv"
CACHED_TIME = "2026-10-19T05:04:52.131400+00:00"
CACHED_SHA256 = "a531fd5f1aa4e6c26156da92116379ef52c05d6a931a549d28c042a46bcc8ea1"
OUTPUT = ROOT / "frontend/public/data/california-zip-places.json"


def source_bytes(refresh):
    if refresh:
        with urlopen(SOURCE_URL, timeout=30) as response:
            body = response.read()
        return body, datetime.now(timezone.utc).isoformat()
    body = CACHED_SOURCE.read_bytes()
    if hashlib.sha256(body).hexdigest() != CACHED_SHA256:
        raise ValueError("Cached AirNow ZIP source differs from its checked receipt")
    return body, CACHED_TIME


def parse_places(body):
    rows = csv.DictReader(io.StringIO(body.decode("utf-8-sig")), delimiter="|")
    places = []
    seen = set()
    for row in rows:
        if row["State"] != "CA":
            continue
        zip_code = row["Zipcode"]
        area = row["City"].strip()
        lat = float(row["Latitude"])
        lon = float(row["Longitude"])
        if (
            len(zip_code) != 5
            or not zip_code.isdigit()
            or zip_code in seen
            or not area
            or not (32 <= lat <= 42.5)
            or not (-125 <= lon <= -114)
        ):
            raise ValueError(f"Invalid or duplicate California ZIP: {zip_code}")
        seen.add(zip_code)
        places.append([zip_code, area, lat, lon])
    if not places:
        raise ValueError("AirNow supplied no California ZIPs")
    return sorted(places)


def main():
    body, retrieved_at = source_bytes("--refresh" in sys.argv)
    places = parse_places(body)
    payload = {
        "sourceUrl": SOURCE_URL,
        "retrievedAt": retrieved_at,
        "sourceSha256": hashlib.sha256(body).hexdigest(),
        "places": places,
    }
    OUTPUT.write_text(json.dumps(payload, separators=(",", ":")) + "\n", encoding="utf-8")
    print(f"Wrote {len(places)} California ZIPs to {OUTPUT}")


if __name__ == "__main__":
    main()
