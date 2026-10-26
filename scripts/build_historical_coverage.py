import argparse
import errno
import hashlib
import json
import os
import shutil
import sqlite3
import zipfile
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlencode

ROOT = Path(__file__).resolve().parents[1]
PUBLIC = ROOT / "frontend/public"
CACHE = ROOT / "data/raw/waves"

REQUEST_INTERVAL_SECONDS = 0.25
BATCH_SIZE = 100
MAX_DOWNLOAD_ATTEMPTS = 2
DOWNLOAD_TIMEOUT_SECONDS = 45
DOWNLOAD_CHUNK_BYTES = 1024 * 1024
CHECKSUM_CHUNK_BYTES = 8 * 1024 * 1024
MIN_FREE_DISK_BYTES = 5 * 1024 * 1024 * 1024
DISK_CHECK_BYTES = 64 * 1024 * 1024
SOURCE_ROWS_PER_CHUNK = 100000
PLUME_CACHE_DAYS = 120
POWER_CACHE_YEARS = 2
EVIDENCE_LOCK_SECONDS = 60
PILOT_FIRE_COUNT = 20
TERRAIN_TILE_SIZE = 1024
IN_MEMORY_TERRAIN_CELLS = 25000000

SOURCES = (
    "smoke",
    "hms",
    "severity",
    "rain",
    "goes",
    "imagery",
    "dnbr",
    "case_severity",
    "slope",
    "thresholds",
    "travel",
    "observations",
    "measured_rain",
    "unresolved_rain",
    "damage",
    "water",
    "power",
    "health",
    "soil",
    "soil_followup",
)
QUEUE = Path(
    os.environ.get("WILDFIRE_COVERAGE_QUEUE", ROOT / "data/raw/historical-coverage/queue.sqlite")
)
BASELINE = ROOT / "data/raw/historical-coverage/baseline"
FROZEN_CATALOG = None
SCOPE = PUBLIC / "data/historical-fires/scope.json"
SCOPE_CACHE = None

DEST = PUBLIC / "data/historical-fires/coverage.json"
STATE = ROOT / "data/raw/historical-coverage/state.json"


def save_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding="utf-8")
    temporary.replace(path)


def file_hash(path, algorithm="sha256"):
    checksum = hashlib.new(algorithm)
    with path.open("rb") as source:
        while True:
            content = source.read(CHECKSUM_CHUNK_BYTES)
            if not content:
                break
            checksum.update(content)
    return checksum.hexdigest()


def cache_source_index(cache=CACHE):
    folder = cache / "url-index"
    marker = folder / "complete.json"
    if marker.exists():
        return
    folder.mkdir(parents=True, exist_ok=True)
    count = 0
    for receipt in cache.glob("*.source.json"):
        metadata = json.loads(receipt.read_text(encoding="utf-8"))
        url = metadata.get("sourceUrl")
        name = receipt.name.removesuffix(".source.json")
        if not url or not (cache / name).exists():
            continue
        remember_cached_source(cache, url, name)
        count += 1
    save_json(marker, {"receiptsIndexed": count})


def remember_cached_source(cache, url, name):
    folder = cache / "url-index"
    folder.mkdir(parents=True, exist_ok=True)
    path = folder / (hashlib.sha256(url.encode()).hexdigest() + ".json")
    if path.exists():
        return
    temporary = path.with_suffix("." + str(os.getpid()) + ".tmp")
    temporary.write_text(json.dumps({"sourceUrl": url, "name": name}), encoding="utf-8")
    temporary.replace(path)


def capture_baseline():
    manifest = BASELINE / "hashes.json"
    if manifest.exists():
        return json.loads(manifest.read_text(encoding="utf-8"))
    BASELINE.mkdir(parents=True, exist_ok=True)
    hashes = {}
    for path in sorted((PUBLIC / "data").rglob("*")):
        if path.is_file():
            relative = path.relative_to(PUBLIC).as_posix()
            hashes[relative] = file_hash(path)
    shutil.copy2(DEST, BASELINE / "coverage.json")
    if STATE.exists():
        shutil.copy2(STATE, BASELINE / "state.json")
    save_json(manifest, hashes)
    return hashes


def preserve_original_json():
    hashes = capture_baseline()
    destination = BASELINE / "public-json.zip"
    if destination.exists():
        return
    with zipfile.ZipFile(destination, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        for relative, digest in hashes.items():
            path = PUBLIC / relative
            if path.suffix in (".json", ".geojson") and file_hash(path) == digest:
                archive.write(path, relative)


def cached_request_url(metadata):
    if metadata.get("sourceUrl"):
        return metadata["sourceUrl"]
    if metadata.get("url"):
        return metadata["url"]
    request = metadata.get("request", {})
    if not request.get("url"):
        return None
    url = request["url"]
    if request.get("parameters"):
        separator = "&" if "?" in url else "?"
        url += separator + urlencode(request["parameters"])
    return url


def import_cached_source(receipt_path):
    metadata = json.loads(receipt_path.read_text(encoding="utf-8"))
    url = cached_request_url(metadata)
    original = receipt_path.with_name(receipt_path.name.removesuffix(".source.json"))
    if not original.exists():
        original = original.with_suffix(".json")
    if not url or not original.exists() or not metadata.get("sha256"):
        return
    name = hashlib.sha256(url.encode()).hexdigest()[:20] + "-" + original.name
    destination = CACHE / name
    if destination.exists():
        return
    if file_hash(original) != metadata["sha256"]:
        raise ValueError("Legacy cache checksum mismatch: " + str(original))
    shutil.copy2(original, destination)
    save_json(
        CACHE / (name + ".source.json"),
        {
            "sourceUrl": url,
            "retrievedAt": metadata.get("retrievedAt", metadata.get("retrieved")),
            "sha256": metadata["sha256"],
            "bytes": destination.stat().st_size,
            "originalReceipt": metadata,
            "importedFrom": str(original.relative_to(ROOT)),
        },
    )


def import_existing_caches():
    CACHE.mkdir(parents=True, exist_ok=True)
    folders = [
        ROOT / "data/raw",
        ROOT / "data/raw/recovery",
        ROOT / "data/raw/eaton-runout",
        ROOT / "data/raw/historical-catalog",
        ROOT / "data/raw/runout-catalog",
    ]
    receipts = list(folders[0].glob("*.source.json"))
    for folder in folders[1:]:
        receipts.extend(folder.rglob("*.source.json"))
    for receipt in receipts:
        import_cached_source(receipt)


def compare_smoke_evidence(before, after):
    original = before.get("smoke", {})
    current = after.get("smoke", {})
    if original.get("stations") and original["stations"] != current.get("stations"):
        raise ValueError("Previously exported EPA station values or metadata changed")
    if original.get("stations"):
        for key, value in original.items():
            if key not in (
                "plumes",
                "checkedAt",
                "status",
                "reason",
                "epaStatus",
            ) and value != current.get(key):
                raise ValueError("Previously exported EPA evidence changed: " + key)
    days = {day["dateUtc"]: day for day in current.get("plumes", {}).get("days", [])}
    fields = (
        "path",
        "monitorCoverage",
        "measurementPeriod",
        "sourcePolygonCount",
        "firePolygonCount",
    )
    for day in original.get("plumes", {}).get("days", []):
        if day["status"] != "available":
            continue
        following = days.get(day["dateUtc"], {})
        for field in fields:
            if field in day and day[field] != following.get(field):
                raise ValueError(
                    "Previously checked NOAA evidence changed: " + day["dateUtc"] + " " + field
                )
    for field in before:
        if field not in ("smoke", "plumeCoverage", "perimeter", "checks", "builtAt"):
            compare_product_evidence(field, before[field], after.get(field))


def compare_product_evidence(field, before, after):
    if field == "recovery":
        for source, value in before.items():
            compare_product_evidence(source, value, (after or {}).get(source))
        return
    if field == "groundProducts":
        for key, value in before.items():
            if key == "layers":
                for role, layer in value.items():
                    compare_product_evidence(role, layer, (after or {}).get("layers", {}).get(role))
            elif value != (after or {}).get(key):
                raise ValueError("Previously reviewed ground provenance changed: " + key)
        return
    if isinstance(before, dict) and before.get("status") in (
        "not_checked",
        "not_processed",
        "unavailable",
        "access_failed",
        "quality_failed",
        "match_unresolved",
    ):
        return
    if before is None:
        return
    if before != after:
        raise ValueError("Previously reviewed evidence changed: " + field)


def compare_public_snapshot():
    hashes = capture_baseline()
    result = {
        "baselineFiles": len(hashes),
        "unchangedFiles": 0,
        "extendedEvidence": [],
        "preservedTemporaryFiles": [],
        "failures": [],
    }
    with zipfile.ZipFile(BASELINE / "public-json.zip") as archive:
        for relative, digest in hashes.items():
            path = PUBLIC / relative
            try:
                unchanged = path.exists() and file_hash(path) == digest
            except OSError as error:
                result["failures"].append(
                    {"file": relative, "reason": "File could not be checked: " + str(error)}
                )
                continue
            if unchanged:
                result["unchangedFiles"] += 1
                continue
            if preserved_temporary_file(relative, digest):
                result["preservedTemporaryFiles"].append(relative)
                continue
            try:
                compare_changed_artifact(relative, path, archive)
                result["extendedEvidence"].append(relative)
            except (ValueError, KeyError, OSError) as error:
                result["failures"].append({"file": relative, "reason": str(error)})
    save_json(BASELINE.parent / "preservation.json", result)
    return result


def preserved_temporary_file(relative, digest):
    path = Path(relative)
    if path.suffix != ".tmp" or (PUBLIC / relative).exists():
        return False
    retained = BASELINE.parent / "interrupted-output" / path.name
    return retained.is_file() and file_hash(retained) == digest


def compare_changed_artifact(relative, path, archive):
    if relative == "data/historical-fires/coverage-report.html":
        relative = "data/historical-fires/coverage.json"
        path = PUBLIC / relative
    before = json.loads(archive.read(relative))
    after = json.loads(path.read_text(encoding="utf-8"))
    if relative.startswith("data/historical-fires/evidence/"):
        compare_smoke_evidence(before, after)
    elif relative == "data/fire-burn-summaries.json":
        for key, value in before.items():
            if key in ("records", "sources"):
                if after[key][: len(value)] != value:
                    raise ValueError("Existing MTBS values or provenance changed")
            elif value != after.get(key):
                raise ValueError("Existing MTBS definitions changed")
    elif relative == "data/historical-fires/coverage.json":
        compare_audit_snapshot(before, after)
    elif relative == "data/historical-fires/scope.json":
        for field, value in before.items():
            if field != "queue" and after.get(field) != value:
                raise ValueError("Verified historical scope changed: " + field)
    else:
        raise ValueError("Changed protected artifact requires source-specific comparison")


def compare_audit_snapshot(before, after):
    if before["catalogFires"] != after["catalogFires"]:
        raise ValueError("Audit catalog denominator changed")
    if "completion" not in after:
        for field, value in before.items():
            if field == "historicalScope":
                original = {key: entry for key, entry in value.items() if key != "queue"}
                current = {
                    key: entry for key, entry in after.get(field, {}).items() if key != "queue"
                }
                if original != current:
                    raise ValueError("Verified historical scope changed")
                continue
            if after.get(field) != value:
                raise ValueError("Archived audit evidence changed: " + field)
        return
    comparisons = after["completion"]["categories"]
    fingerprint = hashlib.sha256(json.dumps(before, sort_keys=True).encode()).hexdigest()
    for checkpoint in after["completion"].get("auditCheckpoints", []):
        if checkpoint["snapshotSha256"] == fingerprint:
            comparisons = checkpoint["categories"]
            break
    for source, original in before["categories"].items():
        comparison = comparisons[source]
        for field, key in (
            ("matchedRecords", "startingMatchedRecords"),
            ("fireCount", "startingMatchedFires"),
            ("statuses", "startingStatuses"),
            ("unit", "unit"),
        ):
            if comparison[key] != original[field]:
                raise ValueError("Starting audit evidence changed: " + source + " " + field)
        if set(original["matchedFires"]) - set(after["categories"][source]["matchedFires"]):
            raise ValueError("Previously matched fires disappeared from audit: " + source)


def open_queue(path=QUEUE):
    path.parent.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(path, timeout=60)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA journal_mode=WAL")
    connection.execute("PRAGMA synchronous=FULL")
    connection.execute("""CREATE TABLE IF NOT EXISTS jobs (
        fire TEXT NOT NULL, source TEXT NOT NULL, status TEXT NOT NULL,
        next_action TEXT NOT NULL, last_result TEXT NOT NULL,
        PRIMARY KEY (fire, source))""")
    connection.execute("CREATE INDEX IF NOT EXISTS jobs_by_source_status ON jobs(source, status)")
    connection.commit()
    return connection


def initialize_queue(connection, records):
    identities = set()
    for record in records:
        if record["id"] in identities:
            raise ValueError("Duplicate catalog fire identity: " + record["id"])
        identities.add(record["id"])
    stored = {row[0] for row in connection.execute("SELECT DISTINCT fire FROM jobs")}
    if stored and stored != identities:
        raise ValueError(
            "Catalog membership changed; the existing queue cannot expand or substitute fires"
        )
    sources = {row[0] for row in connection.execute("SELECT DISTINCT source FROM jobs")}
    total = connection.execute("SELECT count(*) FROM jobs").fetchone()[0]
    if stored == identities and sources == set(SOURCES) and total == len(records) * len(SOURCES):
        return
    for record in records:
        for source in SOURCES:
            connection.execute(
                "INSERT OR IGNORE INTO jobs VALUES (?, ?, ?, ?, ?)",
                (record["id"], source, "pending", "Discover and check this source", "{}"),
            )
    connection.commit()


def finish_job(connection, fire, source, status, next_action, result):
    allowed = {
        "pending",
        "available",
        "no_match",
        "match_unresolved",
        "access_failed",
        "metadata_limited",
        "coverage_limited",
        "processing_failed",
        "quality_failed",
        "excluded_by_scope",
    }
    if status not in allowed:
        raise ValueError("Unknown queue status: " + status)
    if status != "excluded_by_scope":
        result["checkedAt"] = datetime.now(timezone.utc).isoformat()
    cursor = connection.execute(
        "UPDATE jobs SET status=?, next_action=?, last_result=? WHERE fire=? AND source=?",
        (status, next_action, json.dumps(result), fire, source),
    )
    if cursor.rowcount != 1:
        raise ValueError("Job is absent from the catalog queue")
    connection.commit()


def queue_counts(connection, sources=SOURCES):
    counts = {}
    for source in sources:
        rows = connection.execute(
            "SELECT status, count(*) AS total FROM jobs WHERE source=? GROUP BY status", (source,)
        )
        counts[source] = {}
        for row in rows:
            counts[source][row["status"]] = row["total"]
    return counts


def execute_job(connection, record, source, handler):
    row = connection.execute(
        "SELECT * FROM jobs WHERE fire=? AND source=?", (record["id"], source)
    ).fetchone()
    prior = json.loads(row["last_result"])
    attempts = prior.get("attempts", 0) + 1
    try:
        result = handler(record)
        if result.get("fireId", record["id"]) != record["id"]:
            raise ValueError("Prepared evidence belongs to a different fire")
        status = result["status"]
    except Exception as error:
        status = source_error_status(error) if isinstance(error, OSError) else "processing_failed"
        result = {"status": status, "reason": str(error)}
    result["attempts"] = (
        attempts if status not in ("pending", "excluded_by_scope") else attempts - 1
    )
    if prior and row["status"] not in ("pending", "excluded_by_scope"):
        history = list(prior.get("previousChecks", []))
        previous_result = prior.copy()
        previous_result.pop("previousChecks", None)
        history.append(
            {"status": row["status"], "nextAction": row["next_action"], "result": previous_result}
        )
        result["previousChecks"] = history
    action = result.get("nextAction", "Check complete")
    if status in ("access_failed", "processing_failed"):
        action = "Retry after resolving the recorded failure"
    finish_job(connection, record["id"], source, status, action, result)
    return result


def source_error_status(error):
    if isinstance(error, (KeyError, TypeError, AttributeError, RuntimeError)):
        return "processing_failed"
    if not isinstance(error, OSError):
        return "quality_failed"
    local_errors = (
        errno.EIO,
        errno.ENOSPC,
        errno.ENOENT,
        errno.EACCES,
        errno.EROFS,
        errno.ENOTDIR,
        errno.ENAMETOOLONG,
        errno.EBADF,
    )
    if error.errno in local_errors:
        return "processing_failed"
    return "access_failed"


def catalog_records():
    base = PUBLIC / "data/historical-fires"
    index = json.loads((base / "index.json").read_text(encoding="utf-8"))
    records = []
    for year in index["years"]:
        records.extend(
            json.loads((base / (str(year["year"]) + ".json")).read_text(encoding="utf-8"))[
                "records"
            ]
        )
    if len({record["id"] for record in records}) != index["recordCount"]:
        raise ValueError("Catalog count or unique identities changed")
    original = frozen_catalog()
    if set(original) != {record["id"] for record in records}:
        raise ValueError("Current catalog differs from the frozen app fire list")
    for record in records:
        verify_catalog_record(record)
    return sorted(records, key=lambda row: (-row["year"], row["id"]))


def frozen_catalog():
    global FROZEN_CATALOG
    if FROZEN_CATALOG is None:
        records = {}
        archive_path = BASELINE / "public-json.zip"
        if archive_path.exists():
            with zipfile.ZipFile(archive_path) as archive:
                index = json.loads(archive.read("data/historical-fires/index.json"))
                catalogs = [
                    json.loads(archive.read("data/historical-fires/" + str(year["year"]) + ".json"))
                    for year in index["years"]
                ]
        else:
            folder = PUBLIC / "data/historical-fires"
            index = json.loads((folder / "index.json").read_text(encoding="utf-8"))
            catalogs = [
                json.loads((folder / (str(year["year"]) + ".json")).read_text(encoding="utf-8"))
                for year in index["years"]
            ]
        for catalog in catalogs:
            for record in catalog["records"]:
                if record["id"] in records:
                    raise ValueError("Duplicate fire in the catalog")
                records[record["id"]] = record
        if len(records) != index["recordCount"]:
            raise ValueError("Catalog count differs")
        FROZEN_CATALOG = records
    return FROZEN_CATALOG


def verify_catalog_record(record):
    original = frozen_catalog().get(record.get("id"))
    if original is None:
        raise ValueError("Fire is outside the existing app catalog; no source requested")
    if record != original:
        raise ValueError("Catalog identity or verified source links differ from the frozen record")


def mtbs_source_links(record, official):
    links = []
    for link in record.get("sources", []):
        if link["source"] != "MTBS":
            continue
        source = official.get(link["id"])
        if source is None or link["id"] not in record.get("aliases", []):
            raise ValueError("MTBS link is not confirmed in the existing catalog")
        for field in ("sourceId", "sourceUrl", "ignition"):
            if link.get(field) != source.get(field):
                raise ValueError("Confirmed MTBS link disagrees with its original source record")
        if str(source["mtbs"]["map_id"]) != source["sourceId"]:
            raise ValueError("MTBS map identity disagrees")
        links.append(source)
    if record.get("mtbs") and not links:
        raise ValueError("Embedded MTBS metadata lacks a confirmed source link")
    return links


def scope_decision(record, official, california, start, end):
    result = {"fireId": record["id"], "eligible": False, "reasonCode": "no_confirmed_mtbs"}
    try:
        links = mtbs_source_links(record, official)
    except (ValueError, KeyError) as error:
        return {**result, "reasonCode": "identity_unresolved", "reason": str(error)}
    if not links:
        return result
    wildfires = [link for link in links if link["mtbs"].get("incid_type") == "Wildfire"]
    if not wildfires:
        return {**result, "reasonCode": "not_wildfire"}
    dated = []
    for link in wildfires:
        try:
            year = datetime.fromisoformat(link["mtbs"]["ig_date"].replace("Z", "+00:00")).year
        except (ValueError, KeyError, TypeError):
            return {
                **result,
                "reasonCode": "identity_unresolved",
                "reason": "MTBS ignition date is unverified",
            }
        if start <= year <= end:
            dated.append(link)
    if not dated:
        return {**result, "reasonCode": "outside_year_window"}
    checks = [check_scope_boundary(record, link, california) for link in dated]
    for check in checks:
        if check["eligible"]:
            return {**result, **check, "sourceChecks": checks}
    return {**result, **checks[0], "sourceChecks": checks}


def check_scope_boundary(record, source, california):
    from build_historical_evidence import perimeter_for
    from shapely.geometry import shape

    result = {"eligible": False, "mtbsMapIds": [source["mtbs"]["map_id"]]}
    try:
        geometry, receipt = perimeter_for({"id": record["id"], "mtbs": source["mtbs"]})
        if geometry is None or len(geometry["features"]) != 1:
            return {**result, "reasonCode": "boundary_unresolved"}
        feature = geometry["features"][0]
        for field in ("map_id", "event_id", "incid_type", "ig_date"):
            if feature["properties"].get(field) != source["mtbs"].get(field):
                return {
                    **result,
                    "reasonCode": "identity_unresolved",
                    "reason": "MTBS boundary metadata differs: " + field,
                }
        if not shape(feature["geometry"]).intersects(california):
            return {**result, "reasonCode": "outside_california"}
        digest = hashlib.sha256(
            json.dumps(feature["geometry"], sort_keys=True).encode()
        ).hexdigest()
        return {
            **result,
            "eligible": True,
            "reasonCode": "eligible",
            "boundarySource": receipt,
            "boundarySha256": digest,
            "ignitionYear": int(source["mtbs"]["ig_date"][:4]),
            "catalogYear": record["year"],
            "californiaIntersects": True,
            "sourceRecordId": source["id"],
            "mtbs": source["mtbs"],
        }
    except OSError as error:
        return {**result, "reasonCode": "source_access_failed", "reason": str(error)}
    except (ValueError, KeyError) as error:
        return {**result, "reasonCode": "boundary_invalid", "reason": str(error)}


def build_scope(records):
    from shapely.geometry import shape
    from shapely.ops import unary_union
    from zoneinfo import ZoneInfo

    current_year = datetime.now(ZoneInfo("America/Los_Angeles")).year
    source_rows = json.loads(
        (PUBLIC / "data/historical-fires/source-records.json").read_text(encoding="utf-8")
    )
    official = {}
    for source in source_rows:
        if source["source"] == "MTBS":
            if source["id"] in official:
                raise ValueError("Duplicate official MTBS source identity")
            official[source["id"]] = source
    outline = PUBLIC / "data/california-outline.geojson"
    features = json.loads(outline.read_text(encoding="utf-8"))["features"]
    polygons = [shape(feature["geometry"]) for feature in features]
    if any(not polygon.is_valid for polygon in polygons):
        raise ValueError("Existing California geometry is invalid; no repair")
    california = unary_union(polygons)
    decisions = []
    for index, record in enumerate(records):
        decisions.append(
            scope_decision(record, official, california, current_year - 9, current_year)
        )
        if (index + 1) % BATCH_SIZE == 0:
            print("Scope checked", index + 1, "existing fires", flush=True)
    scope = scope_manifest(decisions, current_year, file_hash(outline))
    save_json(SCOPE, scope)
    return scope


def scope_manifest(decisions, current_year, outline_hash):
    exclusions, eligible = {}, []
    for decision in decisions:
        if decision["eligible"]:
            eligible.append(decision["fireId"])
        else:
            reason = decision["reasonCode"]
            exclusions[reason] = exclusions.get(reason, 0) + 1
    observations = []
    for identifier in eligible:
        path = (
            PUBLIC / "data/historical-fires/observations" / (identifier.replace(":", "-") + ".json")
        )
        if path.exists():
            data = json.loads(path.read_text(encoding="utf-8"))
            if data["fireId"] != identifier:
                raise ValueError("Observation export belongs to another fire")
            observations.extend(row["id"] for row in data["records"])
    unresolved = []
    originals = frozen_catalog()
    for decision in decisions:
        record = originals.get(decision["fireId"], {})
        if decision["reasonCode"] == "no_confirmed_mtbs":
            if any(link.get("source") == "MTBS" for link in record.get("unconfirmedSources", [])):
                unresolved.append(decision["fireId"])
    return {
        "schemaVersion": 1,
        "builtAt": datetime.now(timezone.utc).isoformat(),
        "currentYear": current_year,
        "yearRange": {"start": current_year - 9, "end": current_year},
        "catalogFireCount": len(decisions),
        "eligibleFireCount": len(eligible),
        "eligibleFireIds": eligible,
        "exclusionCounts": exclusions,
        "decisions": decisions,
        "eligibleObservationIds": sorted(observations),
        "unresolvedMtbsAssociations": len(unresolved),
        "unresolvedMtbsFireIds": unresolved,
        "californiaGeometrySha256": outline_hash,
        "archive": "Original index, yearly records and reviewed products are retained unchanged.",
    }


def load_scope():
    from zoneinfo import ZoneInfo

    global SCOPE_CACHE
    signature = SCOPE.stat().st_mtime_ns
    if SCOPE_CACHE is None or SCOPE_CACHE[0] != signature:
        scope = json.loads(SCOPE.read_text(encoding="utf-8"))
        ids = scope["eligibleFireIds"]
        decisions = scope["decisions"]
        if len(ids) != len(set(ids)) or len(ids) != scope["eligibleFireCount"]:
            raise ValueError("Duplicate or inconsistent scope identities")
        if {row["fireId"] for row in decisions} != set(frozen_catalog()):
            raise ValueError("Scope differs from the archived app catalog")
        if set(ids) != {row["fireId"] for row in decisions if row["eligible"]}:
            raise ValueError("Scope decisions and eligible identities differ")
        SCOPE_CACHE = (signature, scope)
    scope = SCOPE_CACHE[1]
    year = datetime.now(ZoneInfo("America/Los_Angeles")).year
    if scope["currentYear"] != year or scope["yearRange"] != {"start": year - 9, "end": year}:
        raise ValueError("Historical scope is out of date; run --apply-scope first")
    return scope


def apply_scope_to_queue(connection, scope):
    decisions = {row["fireId"]: row for row in scope["decisions"]}
    restore_eligible_queue_jobs(connection, decisions)
    rows = connection.execute(
        "SELECT * FROM jobs WHERE status='pending' ORDER BY fire, source"
    ).fetchall()
    changed = 0
    prior_fire = None
    for row in rows:
        decision = decisions[row["fire"]]
        if decision["eligible"]:
            continue
        if row["fire"] != prior_fire:
            connection.commit()
            prior_fire = row["fire"]
        prior = {
            "status": row["status"],
            "next_action": row["next_action"],
            "last_result": row["last_result"],
        }
        result = {
            "scopeExclusion": {
                "reasonCode": decision["reasonCode"],
                "yearRange": scope["yearRange"],
                "excludedAt": scope["builtAt"],
                "previousJob": prior,
            }
        }
        connection.execute(
            "UPDATE jobs SET status='excluded_by_scope',next_action=?,last_result=? WHERE fire=? AND source=?",
            (
                "Archived outside the active MTBS scope; not a source availability finding",
                json.dumps(result),
                row["fire"],
                row["source"],
            ),
        )
        changed += 1
    connection.commit()
    return changed


def restore_eligible_queue_jobs(connection, decisions):
    rows = connection.execute("SELECT * FROM jobs WHERE status='excluded_by_scope'").fetchall()
    for row in rows:
        if not decisions[row["fire"]]["eligible"]:
            continue
        exclusion = json.loads(row["last_result"])["scopeExclusion"]
        previous = exclusion["previousJob"]
        if previous["status"] != "pending":
            raise ValueError("Scope restoration cannot replace completed history")
        result = json.loads(previous["last_result"])
        result.setdefault("scopeExclusionHistory", []).append(exclusion)
        connection.execute(
            "UPDATE jobs SET status='pending',next_action=?,last_result=? WHERE fire=? AND source=?",
            (previous["next_action"], json.dumps(result), row["fire"], row["source"]),
        )
        connection.commit()


def scope_queue_summary(connection, scope):
    from historical_coverage_report import queue_status_summary

    eligible = set(scope["eligibleFireIds"])
    counts = {"eligible": {}, "archived": {}}
    for fire, status, count in connection.execute(
        "SELECT fire,status,COUNT(*) FROM jobs GROUP BY fire,status"
    ):
        group = counts["eligible" if fire in eligible else "archived"]
        group[status] = group.get(status, 0) + count
    result = {
        "checkedAt": datetime.now(timezone.utc).isoformat(),
        "catalogFiresBefore": scope["catalogFireCount"],
        "eligibleFires": len(eligible),
        "exclusionCounts": scope["exclusionCounts"],
        "unresolvedMtbsAssociations": scope.get("unresolvedMtbsAssociations", 0),
        "statuses": counts,
    }
    result["sources"] = queue_status_summary(connection, eligible)
    for name, statuses in counts.items():
        total = sum(statuses.values())
        pending = statuses.get("pending", 0)
        excluded = statuses.get("excluded_by_scope", 0)
        result[name + "Jobs"] = total
        result[name + "PendingJobs"] = pending
        result[name + "ExcludedJobs"] = excluded
        result[name + "CompletedJobs"] = total - pending - excluded
    return result


def supplied_source_urls(value):
    urls = set()
    if isinstance(value, list):
        for item in value:
            urls.update(supplied_source_urls(item))
    elif isinstance(value, dict):
        for key, item in value.items():
            if key == "previousChecks":
                continue
            if (
                key in ("sourceUrl", "url", "download_url")
                and isinstance(item, str)
                and item.startswith("https://")
            ):
                urls.add(item)
            elif key == "sourceUrls" and isinstance(item, list):
                for url in item:
                    if isinstance(url, str) and url.startswith("https://"):
                        urls.add(url)
            elif isinstance(item, (dict, list)):
                urls.update(supplied_source_urls(item))
    return urls


def usable_evidence_receipt(record, decision, source, result, evidence=None):
    if evidence is None:
        evidence = read_evidence(record)
    original_scope = result.get("scope")
    details = original_scope if isinstance(original_scope, dict) else {}
    product = receipt_product(record, evidence, source)
    urls = supplied_source_urls(result)
    urls.update(supplied_source_urls(product))
    metadata = retained_source_metadata(record, source)
    urls.update(supplied_source_urls(metadata))
    period, period_status = receipt_period(source, product, details, metadata)
    return {
        "fireId": record["id"],
        "source": source,
        "status": "available",
        "eligibilityBoundarySource": decision["boundarySource"],
        "productBoundarySource": details.get("boundarySource"),
        "spatialRelationship": details.get(
            "spatialRelationship",
            "Verified source linkage retained; see source-specific spatial limitations",
        ),
        "measurementPeriod": period,
        "periodStatus": period_status,
        "sourceLinks": sorted(urls),
        "evidenceUrl": record["evidenceUrl"],
        "preparedUrl": result.get("preparedUrl"),
        "sourceScope": original_scope,
        "sourceMetadata": metadata,
    }


def receipt_product(record, evidence, source):
    from build_historical_evidence import reviewed_snapshot

    snapshot = reviewed_snapshot(record) if record.get("replayId") else None
    if source in ("smoke", "hms"):
        return snapshot["smoke"] if snapshot else evidence.get("smoke", {})
    if source in ("damage", "water", "power"):
        return evidence.get("recovery", {}).get(source, {})
    if source == "slope":
        product = evidence.get("context", {})
        if not product.get("slope"):
            import build_historical_rasters as rasters

            originals = rasters.original_ground_products()
            replay = rasters.REPLAY_GROUND.get(record.get("replayId"))
            if replay:
                return replay
            return {"originalProducts": originals.get(record["id"], [])}
        return product
    if source == "severity":
        return retained_severity_source(record)
    if source in ("imagery", "dnbr"):
        return evidence.get("groundProducts", {})
    product = evidence.get(source, {})
    if source == "rain" and evidence.get("rainUrl"):
        if evidence["fireId"] != record["id"]:
            raise ValueError("Assessment evidence belongs to another fire")
        product = json.loads((PUBLIC / evidence["rainUrl"].lstrip("/")).read_text(encoding="utf-8"))

        product_id = product.get("fireId", product.get("caseId"))
        if product_id is not None and product_id not in (record["id"], record.get("replayId")):
            raise ValueError("Assessment provenance belongs to another fire")
    if source == "goes" and product.get("manifest"):
        product = json.loads((PUBLIC / product["manifest"].lstrip("/")).read_text(encoding="utf-8"))
        if product["caseId"] not in (record["id"], record.get("replayId")):
            raise ValueError("Satellite provenance belongs to another fire")
    return product


def retained_severity_source(record):
    from build_historical_rasters import severity_manifest

    manifest = severity_manifest()
    matches = []
    for row in manifest["records"]:
        if (
            row["mapId"] == record["mtbs"]["map_id"]
            and row["eventId"] == record["mtbs"]["event_id"]
        ):
            matches.append(row)
    if len(matches) != 1:
        raise ValueError("Numeric severity provenance is not uniquely linked")
    row = matches[0]
    sources = []
    for source in manifest["sources"]:
        if source.get("rasterSha256") == row["rasterSha256"]:
            sources.append(source)
    if len(sources) != 1:
        raise ValueError("Numeric severity raster source is not uniquely linked")
    return {
        "source": sources[0],
        "boundarySource": row.get("boundarySource"),
        "acquisitionSceneIds": {
            "pre": record["mtbs"].get("pre_id"),
            "post": record["mtbs"].get("post_id"),
        },
    }


def receipt_period(source, product, details, metadata):
    period = details.get("measurementPeriod")
    if period is None and source in ("smoke", "hms"):
        period = product.get("window")
    status = details.get(
        "periodStatus", "Not supplied in this check; source-specific details retained"
    )
    if source in ("rain", "thresholds", "travel"):
        status = "Agency scenarios, not measurements of rainfall events; release dates remain in source products"
    elif source == "slope":
        status = "Static elevation product; not a fire-date measurement"
    elif source == "goes":
        scans = []
        for frame in product.get("frames", []):
            if frame["status"] == "available":
                scans.append(
                    {"start": frame["start"], "end": frame["end"], "sourceUrl": frame["sourceUrl"]}
                )
        if scans:
            return scans, "Source scan measurement periods; missing frames remain missing"
    if period is None:
        periods = []
        for row in metadata:
            if (
                row.get("measurementPeriod")
                or row.get("period")
                or row.get("preDate")
                or row.get("postDate")
            ):
                periods.append(row)
        if periods:
            period = periods
            status = "Source-supplied dates/periods; not inferred from fire ignition"
    return period, status


def retained_source_metadata(record, source):
    rows = []
    if source in ("health", "soil", "soil_followup"):
        from build_recovery_data import limited_products, limited_items

        product = limited_products().get(record.get("replayId"))
        if product:
            rows = limited_items(product, source)
    elif source == "case_severity":
        from build_historical_rasters import original_ground_products

        for product in original_ground_products().get(record["id"], []):
            rows.append(product["layers"].get("severity", {}))
    elif source in ("observations", "measured_rain"):
        return inventory_period_metadata(record, source)
    keys = (
        "sourceUrl",
        "measurementPeriod",
        "period",
        "publicationDate",
        "retrievedAt",
        "preDate",
        "postDate",
    )
    metadata = []
    for row in rows:
        supplied = {}
        for key in keys:
            if key in row:
                supplied[key] = row[key]
        if supplied and supplied not in metadata:
            metadata.append(supplied)
    return metadata


def inventory_period_metadata(record, source):
    path = (
        PUBLIC / "data/historical-fires/observations" / (record["id"].replace(":", "-") + ".json")
    )
    if not path.exists():
        return []
    data = json.loads(path.read_text(encoding="utf-8"))
    if data["fireId"] != record["id"]:
        raise ValueError("Inventory provenance belongs to another fire")
    storms, recording = set(), set()
    for row in data["records"]:
        if source == "measured_rain" and (
            row["PeakI15"] is None or not row["gaugeStormIdentityVerified"]
        ):
            continue
        if row.get("stormDate"):
            storms.add(row["stormDate"])
        if source == "observations" and row.get("recordingDate"):
            recording.add(row["recordingDate"])
    return [
        {
            "sourceUrl": data["sourceUrl"],
            "publicationDate": data.get("publicationDate"),
            "retrievedAt": data.get("retrievedAt"),
            "measurementPeriod": {
                "stormDates": sorted(storms),
                "recordingDates": sorted(recording),
            },
            "limitation": "Storm dates do not supply missing observation recording dates or hourly rainfall.",
        }
    ]


def scoped_evidence_receipts(connection, scope, records):
    decisions = {row["fireId"]: row for row in scope["decisions"] if row["eligible"]}
    record_index = {record["id"]: record for record in records if record["id"] in decisions}
    receipts = []
    evidence_by_fire = {}
    for fire, source, value in connection.execute(
        "SELECT fire,source,last_result FROM jobs WHERE status='available'"
    ):
        if fire not in decisions:
            continue
        if fire not in evidence_by_fire:
            evidence_by_fire[fire] = read_evidence(record_index[fire])
        receipt = usable_evidence_receipt(
            record_index[fire], decisions[fire], source, json.loads(value), evidence_by_fire[fire]
        )
        receipts.append(receipt)
    return receipts


def evidence_file(record):
    return PUBLIC / record["evidenceUrl"].lstrip("/")


def read_evidence(record):
    path = evidence_file(record)
    return json.loads(path.read_text(encoding="utf-8")) if path.exists() else {}


def reviewed_replays(records):
    settings = json.loads((PUBLIC / "data/waves-cases.json").read_text(encoding="utf-8"))
    replays = {}
    for record in records:
        matches = [row for row in settings["cases"] if row["id"] == record.get("replayId")]
        if len(matches) > 1:
            raise ValueError("Ambiguous reviewed replay")
        if matches:
            replays[record["id"]] = matches[0]
    return replays


def coverage_report(records, state, replays, connection):
    from historical_coverage_report import make_report, reconcile_queue, eligible_coverage

    report = make_report(records, state, replays)
    baseline = json.loads((BASELINE / "coverage.json").read_text(encoding="utf-8"))
    reconcile_queue(report, connection, baseline)
    report["completion"]["auditCheckpoints"] = prior_audit_checkpoints()
    report["eligibleCoverage"] = eligible_coverage(
        records, state, replays, load_scope(), connection
    )
    save_json(DEST, report)
    return report


def prior_audit_checkpoints():
    checkpoints = []
    for path in sorted(BASELINE.parent.glob("eligible-resume-*/baseline/coverage.json")):
        snapshot = json.loads(path.read_text(encoding="utf-8"))
        categories = {}
        for source, values in snapshot["categories"].items():
            categories[source] = {
                "unit": values["unit"],
                "startingStatuses": values["statuses"],
                "startingMatchedRecords": values["matchedRecords"],
                "startingMatchedFires": values["fireCount"],
            }
        fingerprint = hashlib.sha256(json.dumps(snapshot, sort_keys=True).encode()).hexdigest()
        checkpoints.append(
            {
                "snapshot": path.relative_to(ROOT).as_posix(),
                "snapshotSha256": fingerprint,
                "categories": categories,
            }
        )
    return checkpoints


def main():
    args = arguments()
    capture_baseline()
    preserve_original_json()
    if args.retry_failed:
        os.environ["WILDFIRE_RETRY_SOURCES"] = "1"
    records = catalog_records()
    with open_queue() as connection:
        initialize_queue(connection, records)
        if args.apply_scope:
            scope = build_scope(records)
            excluded = apply_scope_to_queue(connection, scope)
            print(
                "Scope applied:",
                scope["eligibleFireCount"],
                "fires;",
                excluded,
                "pending jobs archived",
                flush=True,
            )
        if not args.initialize and not args.report_only and not args.apply_scope:
            eligible = set(load_scope()["eligibleFireIds"])
            active = [record for record in records if record["id"] in eligible]
            selected = pilot_records(active) if args.pilot else active
            run_queue(connection, selected, args.sources, args.retry_failed)
        if args.report_only:
            from build_historical_evidence import publish_completed_checks

            eligible = set(load_scope()["eligibleFireIds"])
            publish_completed_checks(
                connection, [record for record in records if record["id"] in eligible]
            )
            state = json.loads((BASELINE / "state.json").read_text(encoding="utf-8"))
            coverage_report(records, state, reviewed_replays(records), connection)
        if SCOPE.exists():
            scope = load_scope()
            scope["queue"] = scope_queue_summary(connection, scope)
            if args.report_only:
                scope["usableEvidenceUrl"] = "/data/historical-fires/usable-evidence.json"
                save_json(
                    PUBLIC / scope["usableEvidenceUrl"].lstrip("/"),
                    {
                        "description": "Provenance receipts for usable evidence, not a second work queue.",
                        "receives": "Completed eligible-fire checks and their existing source metadata.",
                        "eligibleFireCount": scope["eligibleFireCount"],
                        "records": scoped_evidence_receipts(connection, scope, records),
                    },
                )
            save_json(SCOPE, scope)
            write_fire_availability(scope)
            publish_scope_report(scope)
        print(json.dumps(queue_counts(connection)), flush=True)


def arguments():
    parser = argparse.ArgumentParser(
        description="Resume source checks across the existing resolved catalog, without selecting outcomes.\n\nUses the same per-fire builders as the browser. Heavy downloads can remain queued;\nan unchecked or inaccessible source is never recorded as absent.\n"
    )
    parser.add_argument("--sources", nargs="+", choices=SOURCES, default=list(SOURCES))
    parser.add_argument("--initialize", action="store_true")
    parser.add_argument("--pilot", action="store_true")
    parser.add_argument("--retry-failed", action="store_true")
    parser.add_argument("--report-only", action="store_true")
    parser.add_argument("--apply-scope", action="store_true")
    return parser.parse_args()


def write_fire_availability(scope):
    replay_catalog = json.loads((PUBLIC / "data/waves-cases.json").read_text(encoding="utf-8"))
    replays = {case["id"]: case for case in replay_catalog["cases"]}
    yearly_records = {}
    options = []
    for fire_id in scope["eligibleFireIds"]:
        year = int(fire_id.split(":")[1])
        if year not in yearly_records:
            path = PUBLIC / f"data/historical-fires/{year}.json"
            values = json.loads(path.read_text(encoding="utf-8"))
            yearly_records[year] = {row["id"]: row for row in values["records"]}
        record = yearly_records[year][fire_id]
        evidence_path = PUBLIC / record["evidenceUrl"].lstrip("/")
        evidence = {"smoke": {"status": "not_checked"}, "checks": {}}
        if evidence_path.exists():
            evidence = json.loads(evidence_path.read_text(encoding="utf-8"))
            if evidence["fireId"] != fire_id:
                raise ValueError("Selector evidence belongs to another fire")
        replay = replays.get(record.get("replayId"))
        snapshot = None
        if replay:
            snapshot_path = PUBLIC / replay["snapshot"].lstrip("/")
            if snapshot_path.exists():
                snapshot = json.loads(snapshot_path.read_text(encoding="utf-8"))
                if (
                    snapshot["case"]["name"] != replay["name"]
                    or snapshot["case"]["ignition"] != replay["ignition"]
                ):
                    raise ValueError("Selector replay belongs to another fire")
        options.append(
            {
                "fireId": fire_id,
                "steps": available_fire_steps(record, evidence, snapshot),
            }
        )
    save_json(
        PUBLIC / "data/historical-fires/fire-availability.json",
        {"schemaVersion": 1, "eligibleFireCount": len(options), "records": options},
    )


def available_fire_steps(record, evidence, snapshot):
    recovery = evidence.get("recovery") or {}
    ash = (snapshot or {}).get("ash") or {}
    rain_url = evidence.get("rainUrl")
    rain_file = bool(rain_url and (PUBLIC / rain_url.lstrip("/")).exists())
    snapshot_smoke = (snapshot or {}).get("smoke") or {}
    has_smoke = evidence["smoke"]["status"] == "available"
    has_smoke = has_smoke or snapshot_smoke.get("status") == "available"
    has_recovery = (recovery.get("damage") or {}).get("status") == "available"
    has_recovery = has_recovery or (recovery.get("power") or {}).get("status") == "available"
    has_recovery = has_recovery or (recovery.get("water") or {}).get("status") == "available"
    has_recovery = has_recovery or bool(
        ash.get("grids") or ash.get("followup") or ash.get("findings")
    )
    has_rain = rain_file and (evidence["checks"].get("rain") or {}).get("status") == "available"
    has_rain = has_rain or bool(record.get("runout") and record.get("coordinatedRain"))
    steps = []
    if has_smoke:
        steps.append("smoke")
    if has_recovery:
        steps.append("recovery")
    if has_rain:
        steps.append("rain")
    if record.get("mtbs"):
        steps.append("context")
    return steps


def publish_scope_report(scope):
    report = json.loads(DEST.read_text(encoding="utf-8"))
    report["historicalScope"] = {
        "yearRange": scope["yearRange"],
        "builtAt": scope["builtAt"],
        "eligibleFireCount": scope["eligibleFireCount"],
        "exclusionCounts": scope["exclusionCounts"],
        "unresolvedMtbsAssociations": scope["unresolvedMtbsAssociations"],
        "queue": scope["queue"],
        "proof": "/data/historical-fires/scope.json",
        "archivedEvidence": "The original catalog and evidence totals below remain archived; the active selector and remaining checks use this MTBS scope.",
    }
    save_json(DEST, report)


def pilot_records(records):
    state = json.loads((BASELINE / "state.json").read_text(encoding="utf-8"))
    audit = json.loads((BASELINE / "coverage.json").read_text(encoding="utf-8"))
    tags = {record["id"]: set() for record in records}
    for source, category in audit["categories"].items():
        for identifier in category["matchedFires"]:
            if identifier in tags:
                tags[identifier].add((source, "available"))
    for record in records:
        jobs = state.get("jobs", {}).get(record["id"], {})
        signatures = tags[record["id"]]
        signatures.update((source, job["status"]) for source, job in jobs.items())
        signatures.add(("year", record["year"] // 10))
        signatures.add(("identity", record["source"], bool(record.get("ignition"))))
    selected, seen = [], set()
    remaining = records.copy()
    while remaining and len(selected) < PILOT_FIRE_COUNT:
        best = max(remaining, key=lambda row: len(tags[row["id"]] - seen))
        if not tags[best["id"]] - seen:
            break
        selected.append(best)
        seen.update(tags[best["id"]])
        remaining.remove(best)
    save_json(BASELINE.parent / "pilot.json", [record["id"] for record in selected])
    return selected


def run_queue(connection, records, sources, retry_failed=False):
    from build_historical_evidence import check_source

    eligible = set(load_scope()["eligibleFireIds"])
    records = [record for record in records if record["id"] in eligible]
    for source in sources:
        for offset in range(0, len(records), BATCH_SIZE):
            completed = 0
            for record in records[offset : offset + BATCH_SIZE]:
                row = connection.execute(
                    "SELECT * FROM jobs WHERE fire=? AND source=?", (record["id"], source)
                ).fetchone()
                retry = retry_failed and row["status"] in (
                    "access_failed",
                    "processing_failed",
                    "quality_failed",
                )
                if row["status"] != "pending" and not retry:
                    continue
                result = execute_job(
                    connection, record, source, lambda fire: check_source(fire, source)
                )
                completed += 1
                if result["status"] == "processing_failed":
                    print(
                        source, record["id"], result["status"], result.get("reason", ""), flush=True
                    )
            if completed:
                print(
                    source,
                    "batch",
                    offset // BATCH_SIZE + 1,
                    "saved",
                    completed,
                    "jobs",
                    flush=True,
                )


if __name__ == "__main__":
    main()
