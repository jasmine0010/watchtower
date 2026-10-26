import argparse

from build_historical_coverage import catalog_records, load_scope
from build_historical_evidence import build, load_evidence


def main():
    parser = argparse.ArgumentParser(
        description="Prepare modeled smoke replays for every eligible 2021-2025 fire."
    )
    parser.add_argument("--year", type=int)
    args = parser.parse_args()
    eligible = set(load_scope()["eligibleFireIds"])
    records = [
        record
        for record in catalog_records()
        if record["id"] in eligible
        and 2021 <= record["year"] <= 2025
        and (args.year is None or record["year"] == args.year)
    ]
    unavailable = []
    for index, record in enumerate(records, 1):
        evidence = load_evidence(record)
        if evidence.get("hrrr", {}).get("status") != "available":
            print(f"Preparing {index}/{len(records)}: {record['name']}", flush=True)
            build(record, "hrrr", rebuild=True)
            evidence = load_evidence(record)
        if evidence.get("hrrr", {}).get("status") != "available":
            unavailable.append(record["id"])
    print(f"Prepared {len(records) - len(unavailable)}/{len(records)} replays", flush=True)
    if unavailable:
        raise SystemExit("No replay for: " + ", ".join(unavailable))


if __name__ == "__main__":
    main()
