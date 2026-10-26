import json
import hashlib
import re
import shutil
from datetime import datetime, timedelta, timezone
from urllib.parse import urlencode

from shapely.geometry import shape

from build_waves_data import CACHE, download
from build_historical_coverage import PUBLIC, save_json

LOADED_SOURCES = {}
SOURCE_FAILURES = {}
ANNUAL_DISCOVERY = None
ELIGIBLE_SELECTIONS = None


def window(record):
    if not record.get("ignition"):
        return None
    start = datetime.fromisoformat(record["ignition"]).replace(tzinfo=timezone.utc) - timedelta(
        days=3
    )
    return start, start + timedelta(days=60)


def annual_files(config):
    global ANNUAL_DISCOVERY
    if ANNUAL_DISCOVERY is not None:
        return ANNUAL_DISCOVERY
    template = config["annualExports"][0]
    paper, paper_receipt = download("ornl-outage-methods.html", template["methodsUrl"])
    identifiers = set(
        re.findall(r"10\.6084/m9\.figshare\.(\d+)", paper.read_text(encoding="utf-8"))
    )
    if len(identifiers) != 1:
        raise ValueError("ORNL paper does not identify one outage dataset")
    identifier = identifiers.pop()
    metadata_url = "https://api.figshare.com/v2/articles/" + identifier
    path, receipt = download("ornl-annual-release.json", metadata_url)
    metadata = json.loads(path.read_text(encoding="utf-8"))
    if metadata.get("license", {}).get("name") != "CC BY 4.0":
        raise ValueError("ORNL annual release reuse terms changed")
    if "Recorded Electricity Outages" not in metadata.get("title", ""):
        raise ValueError("ORNL paper-linked release identity differs")
    annual = {}
    guides = [file for file in metadata["files"] if file["name"] == "Uri_Map.R"]
    for file in metadata["files"]:
        match = re.fullmatch(r"eaglei_outages_(\d{4})\.csv", file["name"])
        if not match:
            continue
        year = int(match[1])
        if year in annual:
            raise ValueError("Duplicate annual ORNL outage file")
        annual[year] = {
            **template,
            "year": year,
            "file": file,
            "sourceUrl": metadata["url_public_html"],
            "metadataUrl": metadata_url,
            "metadataReceipt": receipt,
            "paperReceipt": paper_receipt,
            "sourceUpdatedAt": metadata.get("modified_date"),
            "publicationDate": metadata.get("published_date"),
            "releaseVersion": metadata.get("version"),
        }
        annual[year]["countGuide"] = guides[0] if len(guides) == 1 else None
    if not annual:
        raise ValueError("ORNL release lists no annual outage files")
    ANNUAL_DISCOVERY = (annual, receipt)
    return ANNUAL_DISCOVERY


def source_file(config):
    file = config["file"]
    check_annual_storage(file)
    path, receipt = download(file["name"], file["download_url"])
    if path.stat().st_size != file["size"]:
        raise ValueError("ORNL download differs from published file size")
    verify_annual_checksum(path, file, receipt)
    config["sourceCountField"], config["countDefinitionSource"] = verify_count_definition(
        path, config
    )
    return path, receipt, config["metadataReceipt"], config["sourceUpdatedAt"]


def verify_count_definition(path, config):
    import pandas as pd

    columns = list(pd.read_csv(path, nrows=0).columns)
    if "sum" not in columns:
        return "customers_out", None
    file = config.get("countGuide")
    if not file:
        raise ValueError("Source sum-column definition is not verified")
    guide, receipt = download("ornl-" + file["name"], file["download_url"])
    if guide.stat().st_size != file["size"]:
        raise ValueError("Source count guide size differs")
    verify_annual_checksum(guide, file, receipt)
    text = guide.read_text(encoding="utf-8")
    if (
        "max_out = max(sum, na.rm = TRUE)" not in text
        or "Max Percentage of Customers Out" not in text
    ):
        raise ValueError("Source sum-column definition is not verified")
    return "sum", receipt


def check_annual_storage(file):
    from build_historical_coverage import MIN_FREE_DISK_BYTES
    from build_waves_data import shared_source_name

    name = shared_source_name(file["name"], file["download_url"])
    if (CACHE / name).exists():
        return
    required = file["size"] + MIN_FREE_DISK_BYTES
    if shutil.disk_usage(CACHE).free < required:
        raise RuntimeError(
            "Local disk reserve would be exceeded by the published annual outage file"
        )


def verify_annual_checksum(path, file, receipt):
    from build_historical_coverage import file_hash

    expected = file.get("computed_md5")
    if not expected:
        raise ValueError("Published ORNL file has no source checksum")
    verification = CACHE / (path.name + ".verified.json")
    signature = {"sourceSha256": receipt["sha256"], "sourceMd5": expected}
    if verification.exists():
        if json.loads(verification.read_text(encoding="utf-8")) == signature:
            return
    checksum = receipt.get("md5")
    if checksum is None:
        checksum = file_hash(path, "md5")
    if checksum != expected:
        raise ValueError("ORNL annual file differs from its published checksum")
    save_json(verification, signature)


def validated_outage_chunk(chunk):
    import pandas as pd

    required = ["fips_code", "county", "state", "customers_out", "run_start_time"]
    legacy = ["fips_code", "county", "state", "sum", "run_start_time"]
    if list(chunk.columns) == legacy:
        chunk = chunk.rename(columns={"sum": "customers_out"})
    if list(chunk.columns) not in (required, required + ["total_customers"]):
        raise ValueError("Outage columns changed")
    timestamps = pd.to_datetime(chunk["run_start_time"], utc=True, errors="raise")
    selected = chunk[chunk["state"] == "California"].copy()
    if not selected["fips_code"].str.fullmatch(r"06\d{3}").all():
        raise ValueError("California county FIPS disagrees")
    selected["timestamp"] = pd.to_datetime(selected["run_start_time"], utc=True)
    return selected, timestamps.min(), timestamps.max()


def california_rows(path, selection=None):
    import pandas as pd
    from build_historical_coverage import SOURCE_ROWS_PER_CHUNK

    parts, discovered = [], 0
    first, last = None, None
    with pd.read_csv(path, dtype={"fips_code": str}, chunksize=SOURCE_ROWS_PER_CHUNK) as reader:
        for chunk in reader:
            selected, chunk_first, chunk_last = validated_outage_chunk(chunk)
            discovered += len(chunk)
            first = chunk_first if first is None else min(first, chunk_first)
            last = chunk_last if last is None else max(last, chunk_last)
            if selection:
                selected = selected_outage_rows(selected, selection)
            parts.append(selected)
    return pd.concat(parts, ignore_index=True), first, last, discovered


def selected_outage_rows(rows, selection):
    import pandas as pd

    windows = selection.get("windows", [selection])
    keep = pd.Series(False, index=rows.index)
    for window in windows:
        inside = rows["fips_code"].isin(window["countyIds"])
        inside &= rows["timestamp"] >= pd.Timestamp(window["start"])
        inside &= rows["timestamp"] < pd.Timestamp(window["endExclusive"])
        keep |= inside
    return rows[keep]


def eligible_power_selections():
    global ELIGIBLE_SELECTIONS
    if ELIGIBLE_SELECTIONS is not None:
        return ELIGIBLE_SELECTIONS
    from build_historical_coverage import frozen_catalog, load_scope
    from build_recovery_data import recovery_config

    records = frozen_catalog()
    config = recovery_config()["power"]
    windows = []
    for fire in load_scope()["eligibleFireIds"]:
        inputs, perimeter, scope, blocked = power_preflight(records[fire], config)
        if not blocked:
            windows.append(inputs["selection"])
    ELIGIBLE_SELECTIONS = {"windows": windows}
    return ELIGIBLE_SELECTIONS


def county_geometry(config):
    base = config["countyUrl"]
    parameters = {
        "f": "geojson",
        "where": "STATE='06'",
        "outFields": "STATE,COUNTY,GEOID,NAME",
        "returnGeometry": "true",
        "outSR": 4326,
        "resultRecordCount": 1000,
    }
    county_path, county_receipt = download(
        "power-ca-counties.geojson", base + "/query?" + urlencode(parameters)
    )
    geometry = json.loads(county_path.read_text(encoding="utf-8"))
    crs = geometry.get("crs", {}).get("properties", {}).get("name", "urn:ogc:def:crs:OGC:1.3:CRS84")
    if crs not in ("urn:ogc:def:crs:OGC:1.3:CRS84", "EPSG:4326"):
        raise ValueError("County coordinates are not verified longitude/latitude")
    if geometry.get("exceededTransferLimit") or geometry.get("properties", {}).get(
        "exceededTransferLimit"
    ):
        raise ValueError("County geometry response truncated")
    counties = {}
    for feature in geometry["features"]:
        props = feature["properties"]
        identifier = props["GEOID"]
        polygon = shape(feature["geometry"])
        west, south, east, north = polygon.bounds
        if not (-180 <= west < east <= 180 and -90 <= south < north <= 90):
            raise ValueError("County coordinates outside longitude/latitude range")
        if (
            props["STATE"] != "06"
            or identifier != props["STATE"] + props["COUNTY"]
            or identifier in counties
            or not polygon.is_valid
        ):
            raise ValueError("County identity or geometry invalid")
        counties[identifier] = {"name": props["NAME"], "geometry": polygon}
    return counties, county_receipt


def load_source(config):
    path, receipt, metadata_receipt, modified = source_file(config)
    rows, first, last, discovered = california_rows(path, config["selection"])
    counties, county_receipt = config["counties"], config["countyReceipt"]
    if set(rows["fips_code"]) - set(counties):
        raise ValueError("Outage county absent from verified geometry")
    result = {
        "config": config,
        "rows": rows,
        "counties": counties,
        "source": receipt,
        "metadata": metadata_receipt,
        "countySource": county_receipt,
        "sourceUpdatedAt": modified,
        "first": first,
        "last": last,
        "discovered": discovered,
    }
    return result


def verify_published_outage_values(source):
    import pandas as pd

    year = source["config"]["year"]
    values = source["rows"].set_index(["fips_code", "timestamp"])["customers_out"]
    folder = PUBLIC / "data/historical-fires/power"
    for path in folder.glob("*.json"):
        product = json.loads(path.read_text(encoding="utf-8"))
        for county in product["counties"]:
            for row in county["series"]:
                timestamp = pd.Timestamp(row["timestamp"])
                if timestamp.year != year:
                    continue
                selection = source["config"].get("selection")
                if selection and (
                    county["id"] not in selection["countyIds"]
                    or timestamp < pd.Timestamp(selection["start"])
                    or timestamp >= pd.Timestamp(selection["endExclusive"])
                ):
                    continue
                supplied = values.get((county["id"], timestamp))
                if supplied is None or pd.isna(supplied) or supplied != row["customersOut"]:
                    raise ValueError(
                        "Annual ORNL release disagrees with a previously reviewed county/time count"
                    )


def save_power_validation(source):
    config, rows = source["config"], source["rows"]
    if not config.get("file"):
        return
    result = {
        "year": config["year"],
        "source": source["source"],
        "sourceRecordsValidated": source["discovered"],
        "selectedCountyWindowRows": len(rows),
        "numericSelectedRows": int(rows["customers_out"].notna().sum()),
        "missingSelectedRows": int(rows["customers_out"].isna().sum()),
        "selection": config["selection"],
        "firstTimestamp": source["first"].isoformat(),
        "lastTimestamp": source["last"].isoformat(),
        "releaseVersion": config["releaseVersion"],
        "publicationDate": config["publicationDate"],
        "license": config["license"],
    }
    identity = hashlib.sha256(json.dumps(config["selection"], sort_keys=True).encode()).hexdigest()[
        :16
    ]
    path = CACHE / ("ornl-window-validation-" + str(config["year"]) + "-" + identity + ".json")
    if path.exists():
        if json.loads(path.read_text(encoding="utf-8")) != result:
            raise ValueError("Previously validated annual outage file changed")
        return
    save_json(path, result)


def build_power(record, source, perimeter, scope):
    requested = window(record)
    if requested is None:
        return None
    start, end = requested
    if end <= source["first"] or start > source["last"]:
        return None
    counties = matching_county_series(source, perimeter, start, end)
    if not counties:
        return {
            "status": "unavailable",
            "reason": "Checked ORNL file has no county/time rows for this fire window. Missing rows may mean zero outages or missing collection; no no-outage finding.",
        }
    config = source["config"]
    path = PUBLIC / "data/historical-fires/power" / (record["id"].replace(":", "-") + ".json")
    details = {
        "schemaVersion": 1,
        "fireId": record["id"],
        "dataClass": "Historical",
        "relationship": "nearby_time_matched",
        "unit": "reported customers without power",
        "timezone": "UTC",
        "sourceUrl": config["sourceUrl"],
        "methodsUrl": config["methodsUrl"],
        "license": config["license"],
        "retrievedAt": source["source"]["retrievedAt"],
        "sourceUpdatedAt": source["sourceUpdatedAt"],
        "publicationDate": config.get("publicationDate"),
        "source": source["source"],
        "countySource": source["countySource"],
        "window": {"start": start.isoformat(), "endExclusive": end.isoformat()},
        "fileTimestampRange": {
            "start": source["first"].isoformat(),
            "end": source["last"].isoformat(),
        },
        "counties": counties,
        "limitation": "County-wide context, not fire-caused outages or household service status. Reported zero counts are retained; absent rows may mean zero or a collection gap. No missing row is filled. Current Census county geometry links the fire to counties, not a historical outage footprint. Daily maxima are maxima of available reports, not unique affected customers or complete-day peaks.",
    }
    if source.get("annualSources"):
        details["annualSources"] = source["annualSources"]
    if config.get("releaseVersion") is not None:
        details["releaseVersion"] = config["releaseVersion"]
        details["publicationDate"] = config.get("publicationDate")
    if config.get("countDefinitionSource"):
        details["sourceCountField"] = config["sourceCountField"]
        details["countDefinitionSource"] = config["countDefinitionSource"]
    details["sourceMissingness"] = (
        "Blank source counts are retained as unknown records, separate from numeric series. No zero is substituted."
    )
    periods = []
    for county in counties:
        times = [row["timestamp"] for row in county["series"] + county["missingRecords"]]
        periods.append({"countyId": county["id"], "start": min(times), "end": max(times)})
    scope["measurementPeriod"] = periods
    scope["periodStatus"] = "source_supplied"
    details["scope"] = scope
    save_json(path, details)
    numeric_count = sum(len(county["series"]) for county in counties)
    return {
        "status": "available" if numeric_count else "no_match",
        "dataClass": "Historical",
        "relationship": "nearby_time_matched",
        "unit": details["unit"],
        "sourceUrl": config["sourceUrl"],
        "retrievedAt": details["retrievedAt"],
        "license": config["license"],
        "seriesUrl": "/" + path.relative_to(PUBLIC).as_posix(),
        "countyCount": len(counties),
        "recordCount": numeric_count,
        "scope": scope,
        "missingRecordCount": sum(len(county["missingRecords"]) for county in counties),
        "reason": (
            ""
            if numeric_count
            else "Matched county/time records contain no numeric outage counts; conditions remain unknown."
        ),
    }


def matching_county_series(source, perimeter, start, end):
    counties = []
    for identifier, county in source["counties"].items():
        if (
            not perimeter.intersects(county["geometry"])
            or perimeter.intersection(county["geometry"]).area <= 0
        ):
            continue
        rows = source["rows"]
        selected = rows[
            (rows["fips_code"] == identifier)
            & (rows["timestamp"] >= start)
            & (rows["timestamp"] < end)
        ].sort_values("timestamp")
        if selected.empty:
            continue
        series = county_values(selected)
        counties.append({"id": identifier, "name": county["name"], **series})
    return counties


def county_values(selected):
    known = selected[selected["customers_out"].notna()]
    missing = selected[selected["customers_out"].isna()]
    series = [
        {"timestamp": row.timestamp.isoformat(), "customersOut": int(row.customers_out)}
        for row in known.itertuples()
    ]
    missing_records = [
        {"timestamp": row.timestamp.isoformat(), "customersOut": None}
        for row in missing.itertuples()
    ]
    daily = []
    for date, group in known.groupby(known["timestamp"].dt.strftime("%Y-%m-%d")):
        daily.append(
            {
                "dateUtc": date,
                "maximumReported": int(group["customers_out"].max()),
                "reportedSlots": len(group),
            }
        )
    missing_days = []
    for date, group in selected.groupby(selected["timestamp"].dt.strftime("%Y-%m-%d")):
        missing_slots = int(group["customers_out"].isna().sum())
        if missing_slots == len(group):
            missing_days.append(
                {
                    "dateUtc": date,
                    "maximumReported": None,
                    "reportedSlots": 0,
                    "missingSlots": missing_slots,
                }
            )
    return {
        "series": series,
        "daily": daily,
        "missingRecords": missing_records,
        "missingDays": missing_days,
    }


def power_preflight(record, config):
    from build_recovery_data import recovery_scope, recovery_boundary

    scope = recovery_scope(record, "power")
    requested = window(record)
    if requested is None:
        scope["blockedBy"] = "date"
        return (
            None,
            None,
            scope,
            {
                "status": "metadata_limited",
                "reason": "Exact ignition day is missing; county/time matching cannot be established.",
                "scope": scope,
            },
        )
    perimeter, blocked = recovery_boundary(record, scope)
    if blocked:
        return None, None, scope, blocked
    counties, receipt = county_geometry(config["annualExports"][0])
    selected = {}
    for identifier, county in counties.items():
        if (
            perimeter.intersects(county["geometry"])
            and perimeter.intersection(county["geometry"]).area > 0
        ):
            selected[identifier] = county
    if not selected:
        scope["blockedBy"] = "footprint"
        return (
            None,
            None,
            scope,
            {
                "status": "match_unresolved",
                "reason": "No verified intersecting county footprint.",
                "scope": scope,
            },
        )
    scope["countyBoundarySource"] = receipt
    scope["countyIds"] = sorted(selected)
    selection = {
        "countyIds": sorted(selected),
        "start": requested[0].isoformat(),
        "endExclusive": requested[1].isoformat(),
    }
    scope["analysisWindow"] = selection
    return (
        {"selection": selection, "counties": selected, "countyReceipt": receipt},
        perimeter,
        scope,
        None,
    )


def checked_power(record, config):
    inputs, perimeter, scope, blocked = power_preflight(record, config)
    if blocked:
        return blocked
    requested = window(record)
    annual, receipt = annual_files(config)
    selected = []
    for year in range(requested[0].year, requested[1].year + 1):
        if year in annual:
            selected.append({**annual[year], **inputs})
    if not selected:
        scope["excludedAsUnrelated"] = True
        scope["sourceUrls"] = [receipt["sourceUrl"]]
        return {
            "status": "coverage_limited",
            "reason": "Published ORNL annual release has no file overlapping this fire window.",
            "source": receipt,
            "scope": scope,
        }
    scope["sourceUrls"] = [settings["file"]["download_url"] for settings in selected]
    sources = []
    for settings in selected:
        sources.append(loaded_annual_source(settings))
    source = combine_years(sources)
    result = build_power(record, source, perimeter, scope)
    if result is None:
        scope["excludedAsUnrelated"] = True
        return {
            "status": "coverage_limited",
            "reason": "Actual ORNL file dates do not overlap this fire window.",
            "source": receipt,
            "scope": scope,
        }
    if result["status"] == "unavailable":
        result = {**result, "status": "no_match"}
    return result


def loaded_annual_source(settings):
    from build_historical_coverage import POWER_CACHE_YEARS

    key = settings["file"]["download_url"]
    if key in SOURCE_FAILURES:
        error_type, arguments = SOURCE_FAILURES[key]
        raise error_type(*arguments)
    if key not in LOADED_SOURCES:
        try:
            counties, county_receipt = county_geometry(settings)
            annual = {
                **settings,
                "selection": eligible_power_selections(),
                "counties": counties,
                "countyReceipt": county_receipt,
            }
            source = load_source(annual)
        except (OSError, ValueError, KeyError) as error:
            error_type = ValueError
            if isinstance(error, OSError):
                error_type = OSError
            elif isinstance(error, KeyError):
                error_type = KeyError

            SOURCE_FAILURES[key] = (error_type, error.args)
            raise
        if len(LOADED_SOURCES) >= POWER_CACHE_YEARS:
            oldest = next(iter(LOADED_SOURCES))
            del LOADED_SOURCES[oldest]
        LOADED_SOURCES[key] = source
    return checked_annual_window(LOADED_SOURCES[key], settings)


def checked_annual_window(annual, settings):
    source = dict(annual)
    source["config"] = {**source["config"], "selection": settings["selection"]}
    source["rows"] = selected_outage_rows(source["rows"], settings["selection"])
    validate_window_rows(source["rows"])
    verify_published_outage_values(source)
    save_power_validation(source)
    return source


def validate_window_rows(rows):
    known = rows["customers_out"].dropna()
    if not ((known >= 0) & (known % 1 == 0)).all():
        raise ValueError("Unexpected negative or fractional customer count")
    if rows.duplicated(["fips_code", "timestamp"]).any():
        raise ValueError("Duplicate county/timestamp requires source review")


def combine_years(sources):
    import pandas as pd

    if len(sources) == 1:
        return sources[0]
    rows = pd.concat([source["rows"] for source in sources], ignore_index=True)
    if rows.duplicated(["fips_code", "timestamp"]).any():
        raise ValueError("Overlapping annual outage rows require source review")
    result = dict(sources[0])
    result["rows"] = rows
    result["first"] = min(source["first"] for source in sources)
    result["last"] = max(source["last"] for source in sources)
    result["discovered"] = sum(source["discovered"] for source in sources)
    result["annualSources"] = [source["source"] for source in sources]
    return result


def main():
    import sys
    from build_historical_coverage import main as run_queue

    sys.argv[1:1] = ["--sources", "power"]
    run_queue()


if __name__ == "__main__":
    main()
