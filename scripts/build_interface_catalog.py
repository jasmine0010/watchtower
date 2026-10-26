import hashlib
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
EXPORT = ROOT / "data/interface_export"
PUBLIC = ROOT / "frontend/public/data"
FILES = ("case", "historical-cases", "case-products", "historical-imagery", "burn-summary", "slope")


def unavailable(reason):
    return {"status": "unavailable", "reason": reason}


def summaries_for(record, original, burn, slope):
    summaries = {
        "burn": unavailable(
            "No watershed-specific severity summary has been calculated for this observation."
        ),
        "slope": unavailable(
            "No watershed-specific slope summary has been calculated for this observation."
        ),
    }

    if record["observationId"] != original["observationId"]:
        return summaries
    if burn["basin"] != record["id"] or slope["bounds"] != record["bounds"]:
        raise ValueError("Summary identity or footprint disagrees with its observation")
    summaries["burn"] = {"status": "available", "value": burn}
    summaries["slope"] = {"status": "available", "value": slope}
    return summaries


def build_catalog():
    inputs = {}
    hashes = {}
    for name in FILES:
        path = EXPORT / f"{name}.json"
        raw = path.read_bytes()
        inputs[name] = json.loads(raw)
        hashes[path.name] = hashlib.sha256(raw).hexdigest()
    original = inputs["case"]
    products = inputs["case-products"]
    threshold_path = ROOT / "data/verified_rainfall_thresholds.json"
    thresholds = (
        json.loads(threshold_path.read_text()) if threshold_path.is_file() else {"cases": {}}
    )
    records = []
    seen = set()
    for exported in inputs["historical-cases"]:
        record = dict(exported)
        case_id = record["observationId"]
        if case_id in seen:
            raise ValueError(f"Duplicate observation: {case_id}")
        seen.add(case_id)
        if case_id == original["observationId"]:
            record.update(original)
        product = products["cases"].get(case_id)
        if product is not None:
            if (
                product["assessmentId"] != record["id"]
                or product["assessmentFireId"] != record["inventory"]["AssessmentFireID"]
            ):
                raise ValueError(f"Product identity mismatch: {case_id}")
            product = dict(product)
            product.pop("slopeSummary", None)
        record["products"] = product
        record["productReason"] = (
            ""
            if product
            else "No verified local product manifest is available for this observation."
        )
        record["summaries"] = summaries_for(
            record, original, inputs["burn-summary"], inputs["slope"]
        )
        record["rainfallThreshold"] = thresholds["cases"].get(
            case_id,
            unavailable(
                "No basin- or segment-specific USGS rainfall threshold has been verified for this observation."
            ),
        )
        records.append(record)
    if original["observationId"] not in seen:
        raise ValueError("Default observation is absent from the reviewed case export")
    product_meta = {key: value for key, value in products.items() if key != "cases"}
    return {
        "version": 1,
        "defaultCaseId": original["observationId"],
        "cases": records,
        "provenance": {
            "exportSha256": hashes,
            "products": product_meta,
            "datedImagery": inputs["historical-imagery"],
        },
    }


if __name__ == "__main__":
    catalog = build_catalog()
    dst = PUBLIC / "catalog.json"

    dst.write_text(json.dumps(catalog, indent=2) + "\n", encoding="utf-8")
    print(f"Published {len(catalog['cases'])} reviewed observations to {dst}")
