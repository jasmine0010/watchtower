import json
import re
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PUBLIC = ROOT / "frontend/public"


def read(path):
    return json.loads(path.read_text(encoding="utf-8"))


def prepared_urls(evidence, category, primary=None):
    urls = set()
    if primary:
        urls.add(primary)
    check = evidence.get("checks", {}).get(category, {})
    if check.get("preparedUrl"):
        urls.add(check["preparedUrl"])
    for url in check.get("preparedUrls", []):
        urls.add(url)
    if isinstance(evidence.get("fireId"), str):

        manifest = (
            "/data/historical-fires/evidence/" + evidence["fireId"].replace(":", "-") + ".json"
        )
        urls.discard(manifest)
    return sorted(urls)


def scenario_keys(data):
    keys, unmapped = [], 0
    for kind in ["basins", "segments"]:
        for feature in data[kind]["features"]:
            properties = feature["properties"]
            if not properties["mapped"]:
                unmapped += 1
                continue
            if data.get("identityKind") == "source-row":
                identity = (
                    properties["archiveSha256"],
                    properties["sourceLayer"],
                    properties["sourceFeatureIndex"],
                )
            else:
                identity = properties["SegmentID"]
            keys.append((data["sourceUrl"], kind, identity))
    return keys, unmapped


def threshold_key(value):
    source = value["sourceUrl"]
    release = re.search(r"(?:item/|USGS:)([0-9a-f]{24})", source)
    release_id = release.group(1) if release else source
    scope = value["scope"].removesuffix("s")
    return release_id, scope, str(value["assessmentId"])


def threshold_products(evidence, fire_id):
    keys, supplements, parts = set(), {}, set()
    for url in prepared_urls(evidence, "thresholds"):
        data = read(PUBLIC / url.lstrip("/"))
        if data.get("fireId") != fire_id:
            raise ValueError("Threshold product belongs to another fire")
        for row in data.get("records", []):
            identifier = row["observationId"]
            if identifier in supplements and supplements[identifier] != row:
                raise ValueError("Observation threshold supplements disagree")
            supplements[identifier] = row
        for index, feature in enumerate(data.get("features", [])):
            values = {**feature["properties"], "sourceUrl": data["sourceUrl"]}
            keys.add(threshold_key(values))
            parts.add((url, index))
    return keys, supplements, parts


def ground_product_keys(evidence, fire_id):
    product = evidence.get("groundProducts", {})
    if product and product.get("fireId") != fire_id:
        raise ValueError("Ground product belongs to another fire")
    result = []
    categories = {
        "pre": "imagery",
        "post": "imagery",
        "dnbr": "dnbr",
        "severity": "case_severity",
        "slope": "slope",
    }
    for name, layer in product.get("layers", {}).items():
        if layer.get("status") == "available":
            result.append((categories[name], layer["file"]))
    return result


def plume_geometry(path, cache):
    from build_historical_coverage import PLUME_CACHE_DAYS
    from shapely.geometry import shape

    if path not in cache:
        if len(cache) >= PLUME_CACHE_DAYS:
            oldest = next(iter(cache))
            del cache[oldest]
        features = read(path)["features"]
        cache[path] = [shape(feature["geometry"]) for feature in features]
    return cache[path]


def release_check_rows(result):
    rows = []
    for release in result.get("releaseChecks", []):
        source = release.get("sourceUrl", "")
        scope = "release" if source else "unidentified supplement"
        rows.append(
            (scope, release.get("status", "not_checked"), release.get("reason", ""), source, "")
        )
        checks = release.get("checks", [])
        if not isinstance(checks, list):
            continue
        for layer in checks:
            reason = layer.get("reason") or layer.get("metadataLimitation", "")
            name = layer.get("file") or layer.get("layer", "")
            rows.append(("source layer", layer.get("status", "not_checked"), reason, source, name))
    return rows


def queue_status_summary(connection, fire_ids=None):
    summary = {}
    condition, parameters = "", []
    if fire_ids is not None:
        parameters = list(fire_ids)
        condition = " WHERE 0"
        if parameters:
            condition = " WHERE fire IN (" + ",".join(["?"] * len(parameters)) + ")"
    rows = connection.execute(
        "SELECT source, status, COUNT(*) FROM jobs" + condition + " GROUP BY source, status",
        parameters,
    )
    for source, status, count in rows:
        group = summary.setdefault(source, {"statuses": {}, "blockedReasons": []})
        group["statuses"][status] = count
    for source, group in summary.items():
        counts = group["statuses"]
        group["total"] = sum(counts.values())
        group["queued"] = counts.get("pending", 0)
        group["excluded"] = counts.get("excluded_by_scope", 0)
        group["completed"] = group["total"] - group["queued"] - group["excluded"]
        group["usableData"] = counts.get("available", 0)
        group["completedNoMatch"] = counts.get("no_match", 0)
        blocked = group["completed"] - group["usableData"] - group["completedNoMatch"]
        group["blocked"] = blocked
    reasons, releases = {}, Counter()
    query = "SELECT source, status, last_result FROM jobs" + condition
    query += " AND status != 'pending'" if condition else " WHERE status != 'pending'"
    for source, status, result_json in connection.execute(query, parameters):
        result = json.loads(result_json) if result_json else {}
        if status not in ("available", "no_match", "excluded_by_scope"):
            key = (source, status, result.get("reason", "No reason recorded"))
            reasons[key] = reasons.get(key, 0) + 1
        for scope, release_status, reason, url, layer in release_check_rows(result):
            releases[(source, scope, release_status, reason, url, layer)] += 1
    for (source, status, reason), count in sorted(reasons.items()):
        summary[source]["blockedReasons"].append(
            {"status": status, "reason": reason, "fires": count}
        )
    for (source, scope, status, reason, url, layer), count in sorted(releases.items()):
        rows = summary[source].setdefault("subordinateChecks", [])
        rows.append(
            {
                "scope": scope,
                "status": status,
                "reason": reason,
                "checks": count,
                "sourceUrl": url,
                "layer": layer,
            }
        )
    return summary


def reconcile_queue(report, connection, baseline):
    summary = queue_status_summary(connection)
    if set(summary) != set(report["categories"]):
        raise ValueError("Queue categories differ from coverage report")
    if baseline["catalogFires"] != report["catalogFires"]:
        raise ValueError("Catalog denominator changed during coverage completion")
    comparisons = {}
    for source, counts in summary.items():
        if counts["total"] != report["catalogFires"]:
            raise ValueError("Incomplete or duplicate source queue: " + source)
        before = baseline["categories"][source]
        after = report["categories"][source]
        missing = set(before["matchedFires"]) - set(after["matchedFires"])
        if missing:
            raise ValueError("Previously matched fires disappeared: " + source)
        comparisons[source] = {
            "unit": before["unit"],
            "startingStatuses": before["statuses"],
            "startingMatchedRecords": before["matchedRecords"],
            "currentMatchedRecords": after["matchedRecords"],
            "matchedRecordChange": after["matchedRecords"] - before["matchedRecords"],
            "startingRetrievedPassing": before.get("retrievedPassing"),
            "currentRetrievedPassing": after.get("retrievedPassing"),
            "startingDiscovery": before.get("discovered"),
            "currentDiscovery": after.get("discovered"),
            "startingMatchedFires": before["fireCount"],
            "currentMatchedFires": after["fireCount"],
            "newMatchedFireIds": sorted(set(after["matchedFires"]) - set(before["matchedFires"])),
            "queue": counts,
        }
        after["priorAuditStatuses"] = after.get("statuses", {})
        after["priorAuditExplanation"] = after.get("auditExplanation", "")
        after["statuses"] = counts["statuses"]
        after["notCheckedReasons"] = []
        after["auditExplanation"] = (
            "Current results come from the durable fire/source queue. Queued jobs are unfinished; completed checks retain usable, no-match, source-access, identity, metadata, quality and coverage outcomes separately."
        )
    report["completion"] = {
        "queueTable": "jobs",
        "baselineSnapshot": "data/raw/historical-coverage/baseline/coverage.json",
        "startingSourceAndQualityCounts": baseline.get("sourceAndQualityCounts"),
        "startingOverlapByFire": baseline.get("overlapByFire"),
        "startingOverlapByObservation": baseline.get("overlapByObservation"),
        "startingObservations": baseline.get("observations"),
        "allChecksAttempted": all(group["queued"] == 0 for group in summary.values()),
        "finished": all(
            group["queued"] == 0 and group["statuses"].get("processing_failed", 0) == 0
            for group in summary.values()
        ),
        "categories": comparisons,
        "meaning": "Completed means a check returned a result, not that data were found. Blocked results retain source access, metadata, identity, coverage and quality reasons. Prepared-record counts and check-job counts have different units. Jobs excluded by scope are archived, not completed source checks.",
    }
    report["notCheckedMeaning"] = report["completion"]["meaning"]
    return report


def unchecked_reason(
    category,
    record,
    jobs,
    detail,
    has_observations,
    inventory_checked,
    threshold_checks,
    burn_reason,
    power_years,
    note,
):
    if category == "smoke":
        if not record.get("ignition"):
            return (
                "missing_date",
                "Exact ignition day is missing; the historical EPA window was not established.",
            )
        reason = detail or jobs.get("smoke", {}).get("reason")
        if reason and "not cached" in reason.lower():
            return "download_deferred", reason
        if reason and "perimeter" in reason.lower():
            return "missing_verified_geometry", reason
        return "prerequisite_or_retrieval_deferred", reason or note
    if category == "hms":
        if not record.get("ignition"):
            return (
                "missing_date",
                "Exact ignition day is missing; the historical NOAA window was not established.",
            )
        smoke = jobs.get("smoke", {})
        if smoke.get("status") == "not_checked":
            return (
                "coupled_build_deferred",
                "Independent NOAA checks were not run after smoke preflight deferred the combined build: "
                + smoke.get("reason", "reason not recorded"),
            )
        if smoke.get("status") == "unavailable":
            return (
                "epa_preflight_stopped_combined_build",
                "EPA preflight found no hourly archive for the fire year and stopped the combined build. Independent NOAA historical coverage was not checked; EPA absence does not establish NOAA absence.",
            )
        if detail:
            return (
                "upstream_check_failed",
                "No independent NOAA check completed after the smoke/perimeter check: " + detail,
            )
        return (
            "independent_search_not_run",
            "No independent NOAA window/intersection check was completed. EPA preflight or perimeter failure could stop the combined builder; NOAA absence was not established.",
        )
    if category == "damage" and jobs.get("recovery", {}).get("status") == "match_unresolved":
        return (
            "index_searched_match_unresolved",
            "Inspection index searched; no unique exact incident/name/source-day link established. Structure records were not exported. This is not an untouched source or evidence of no damage.",
        )
    if category == "observations" and inventory_checked:
        return (
            "inventory_searched_no_verified_export",
            "Public inventory searched; no qualifying resolved fire link exported. Records may be absent from that inventory or fail identity/date/spatial matching. Other observation sources were not exhaustively searched.",
        )
    if category in ["measured_rain", "unresolved_rain"]:
        if has_observations:
            if category == "measured_rain":
                return (
                    "assignment_not_verified",
                    "Inventory observations matched, but no numeric peak with a verified gauge identity was exported for this fire. Missing peaks and unresolved gauges are not zeros.",
                )
            return (
                "no_unresolved_assignment_exported",
                "Matched inventory contains no exported numeric peak with an unresolved gauge identity. This bookkeeping row is not a separate dataset awaiting retrieval.",
            )
        return (
            "no_verified_inventory_link",
            "No matched inventory observation file supplies this fire's gauge-storm assignments. The public inventory was searched; wider gauge archives were not queried.",
        )
    if category == "thresholds":
        if not has_observations:
            return (
                "no_verified_basin_segment_link",
                "No matched inventory basin/segment identity drives a threshold check. A catalog-wide extraction of thresholds for unobserved assessment locations was not performed.",
            )
        if "not_checked" in threshold_checks:
            return (
                "original_archive_not_retrieved",
                "Matched observations exist, but original threshold archives were not retrieved for some or all rows. See record-level checks; no design storm was substituted.",
            )
        return (
            "checks_completed_not_verified",
            "Observation-level checks did not yield an accepted threshold under the required identity, contributing-area, containment, duration, units and probability rules. See the per-record reasons; this is not an unsearched source.",
        )
    if category == "severity":
        if not record.get("mtbs"):
            return (
                "no_verified_mtbs_link",
                "No verified MTBS assessment identity is linked in the current catalog. No substitute fire or numeric raster was used; wider product discovery was not performed.",
            )
        if burn_reason:
            if "topology" in burn_reason:
                return (
                    "recorded_quality_exclusion",
                    "Source boundary topology failed checks; no automatic geometry repair or accepted numeric summary. Exact exclusion is retained in the complete JSON.",
                )
            if burn_reason.startswith("No assessed class"):
                return (
                    "recorded_numeric_product_exclusion",
                    "Numeric mosaic checked; no accepted assessed-severity cells were present in that snapshot. This is a recorded exclusion, not an unsearched source.",
                )
            return (
                "recorded_numeric_product_exclusion",
                "Existing numeric-product check did not yield an accepted summary: " + burn_reason,
            )
        return (
            "numeric_raster_not_processed",
            "An MTBS identity is linked, but its numeric product was not retrieved and processed. Only existing summaries and already cached annual mosaics were used.",
        )
    if category == "power" and record["year"] in power_years:
        return (
            "partial_year_file_no_prepared_window",
            "Only a partial-year export was verified for this year; no compatible outage file was prepared for this fire window. This is not an outage-free finding.",
        )
    stages = {
        "goes": "on_demand_not_requested",
        "slope": "on_demand_not_requested",
        "health": "shared_context_only",
        "soil": "limited_study_scope",
        "soil_followup": "study_specific",
        "water": "provider_search_not_completed",
        "power": "other_year_exports_not_verified",
        "rain": "missing_verified_release_link",
        "travel": "release_search_not_completed",
        "imagery": "bulk_raster_processing_not_run",
        "dnbr": "bulk_raster_processing_not_run",
        "case_severity": "bulk_raster_processing_not_run",
        "damage": "no_per_fire_export",
    }
    return stages.get(category, "not_checked"), note


def make_report(records, state, replays, scoped=False):
    from shapely.geometry import shape
    from shapely.ops import unary_union

    source_config = read(ROOT / "data/historical_coverage_sources.json")
    registry = source_config["categories"]
    power_config = read(ROOT / "data/recovery_sources.json")["power"]
    power_releases = {r["year"]: r for r in power_config["releases"]}
    power_years = {r["year"] for r in power_config["annualExports"]}
    extensions = {
        "measured_rain": ("observations", "gauge-storm peak assignment"),
        "unresolved_rain": (
            "observations",
            "observation-level peak assignment with unresolved gauge identity",
        ),
        "thresholds": ("rain", "verified basin/segment threshold"),
        "travel": ("rain", "published contour-scenario feature"),
        "imagery": ("context", "dated rendered image crop"),
        "dnbr": ("context", "continuous dNBR crop"),
        "severity": ("context", "categorical severity summary"),
        "case_severity": ("context", "categorical severity crop"),
        "slope": ("context", "terrain crop"),
        "soil_followup": ("soil", "published cleanup-study percentage"),
    }
    for key, (parent, unit) in extensions.items():
        registry[key] = {**registry[parent], "unit": unit}
    del registry["context"]
    categories, matched, retrieved, fires, statuses, check_details = {}, {}, {}, {}, {}, {}
    for key, definition in registry.items():
        categories[key] = {**definition, "discovered": None}
        matched[key], retrieved[key], fires[key], statuses[key] = set(), set(), set(), {}
        check_details[key] = {}
        categories[key]["auditExplanation"] = source_config["auditNotes"][key]

    def add(category, fire_id, keys):
        keys = set(keys)
        retrieved[category].update(keys)
        matched[category].update(keys)
        if keys:
            fires[category].add(fire_id)

    def count_goes(fire_id, product):
        data = read(PUBLIC / product["manifest"].lstrip("/"))
        keys = []
        for frame in data["frames"]:
            if frame["status"] == "available":
                keys.append(frame["sourceUrl"])
        add("goes", fire_id, keys)

    subcounts = {
        "hourlySlots": set(),
        "missingHours": set(),
        "negativeHours": set(),
        "hmsFiles": set(),
        "hmsSourcePolygons": set(),
        "hmsFirePolygons": set(),
        "hmsMissingDays": set(),
        "hmsFailedDays": set(),
        "hmsFutureDays": set(),
        "structuresWithoutCoordinates": 0,
        "outsideStructures": 0,
        "soilReferenceCells": 0,
        "soilMeasuredCells": 0,
        "firesWithIntersectingPlumes": set(),
        "unmappedAssessmentLocations": 0,
        "thresholdSourceFeatureParts": set(),
        "scenarioSourceRowsWithoutWatershedIds": set(),
        "powerMissingSourceRecords": set(),
        "powerAllMissingCountyDays": set(),
    }
    observation_links, studies, all_observations, watersheds = {}, set(), {}, set()
    threshold_checks = {}
    plume_cache = {}
    linked_observations = {
        key: set()
        for key in [
            "observations",
            "measured_rain",
            "unresolved_rain",
            "thresholds",
            "imagery",
            "dnbr",
            "case_severity",
            "slope",
        ]
    }
    evidence_files = set((PUBLIC / "data/historical-fires/evidence").glob("*.json"))
    observation_files = set((PUBLIC / "data/historical-fires/observations").glob("*.json"))
    for record in records:
        identity = record["id"]
        path = PUBLIC / record["evidenceUrl"].lstrip("/")
        evidence = read(path) if path in evidence_files else {}
        replay = replays.get(identity)
        snapshot = read(PUBLIC / replay["snapshot"].lstrip("/")) if replay else None
        smoke = snapshot["smoke"] if snapshot else evidence.get("smoke", {})
        for station in smoke.get("stations", []):
            for row in station["series"]:
                key = (
                    station["id"],
                    station["parameter"],
                    station["poc"],
                    station["method"],
                    row["timestamp"],
                )
                subcounts["hourlySlots"].add(key)
                if row["value"] is None:
                    subcounts["missingHours"].add(key)
                else:
                    add("smoke", identity, [key])
                    if row["value"] < 0:
                        subcounts["negativeHours"].add(key)
        if smoke.get("plumes", {}).get("days"):
            boundary = (snapshot or evidence).get("perimeter", {}).get("value")
            polygon = (
                unary_union([shape(f["geometry"]) for f in boundary["features"]])
                if boundary
                else None
            )
            for day in smoke["plumes"]["days"]:
                if day["status"] != "available" or not day.get("path"):
                    if day["status"] == "not_elapsed":
                        subcounts["hmsFutureDays"].add(day["dateUtc"])
                    else:
                        subcounts[
                            (
                                "hmsFailedDays"
                                if day["status"] in ["failed", "quality_failed", "access_failed"]
                                else "hmsMissingDays"
                            )
                        ].add(day["dateUtc"])
                    continue
                geometry = plume_geometry(PUBLIC / day["path"].lstrip("/"), plume_cache)
                subcounts["hmsFiles"].add(day["dateUtc"])

                fires["hms"].add(identity)
                for index, plume in enumerate(geometry):
                    key = (day["dateUtc"], index)
                    subcounts["hmsSourcePolygons"].add(key)
                    retrieved["hms"].add(key)
                    if polygon and plume.intersects(polygon):
                        matched["hms"].add(key)
                        subcounts["hmsFirePolygons"].add(key)
                        subcounts["firesWithIntersectingPlumes"].add(identity)
        for finding in smoke.get("health", []):
            key = (finding["sourceUrl"], finding["title"], finding["period"])
            add("health", identity, [key])
            studies.add(finding["sourceUrl"])
        recovery = evidence.get("recovery", {})
        for category, product in [
            ("damage", recovery.get("damage", {})),
            ("water", recovery.get("water", {})),
            ("power", recovery.get("power", {})),
        ]:
            statuses[category][identity] = product.get("status", "not_checked")
            check_details[category][identity] = product.get("reason", "")
        damage = recovery.get("damage", {})
        if damage.get("status") == "available":
            geometry = read(PUBLIC / damage["geometryUrl"].lstrip("/"))
            add(
                "damage",
                identity,
                [(damage["sourceUrl"], f["properties"]["id"]) for f in geometry["features"]],
            )
            subcounts["structuresWithoutCoordinates"] += damage["audit"]["missingGeometry"]
            subcounts["outsideStructures"] += damage["audit"]["outside"]
        for notice in recovery.get("water", {}).get("notices", []):
            add(
                "water",
                identity,
                [
                    (notice["sourceUrl"], event["date"], event["label"])
                    for event in notice["events"]
                ],
            )
        power = recovery.get("power", {})
        if power.get("seriesUrl"):
            data = read(PUBLIC / power["seriesUrl"].lstrip("/"))
            for county in data["counties"]:
                add(
                    "power",
                    identity,
                    [(county["id"], row["timestamp"]) for row in county["series"]],
                )
                for row in county.get("missingRecords", []):
                    subcounts["powerMissingSourceRecords"].add((county["id"], row["timestamp"]))
                for row in county.get("missingDays", []):
                    subcounts["powerAllMissingCountyDays"].add((county["id"], row["dateUtc"]))
        for url in prepared_urls(evidence, "rain", evidence.get("rainUrl")):
            data = read(PUBLIC / url.lstrip("/"))
            keys, unmapped = scenario_keys(data)
            subcounts["unmappedAssessmentLocations"] += unmapped
            if data.get("identityKind") == "source-row":
                subcounts["scenarioSourceRowsWithoutWatershedIds"].update(keys)
            add("rain", identity, keys)
        threshold_keys, supplements, parts = threshold_products(evidence, identity)
        add("thresholds", identity, threshold_keys)
        subcounts["thresholdSourceFeatureParts"].update(parts)
        for category, file in ground_product_keys(evidence, identity):
            add(category, identity, [file])
        if record.get("coordinatedRain"):
            pin = record["coordinatedRain"]
            path = PUBLIC / ("data/runout/" + pin["releaseId"] + "-basins.json")
            if path.exists():
                data = read(path)
                add(
                    "rain",
                    identity,
                    [
                        (pin["releaseId"], "companion", f["properties"]["SegmentID"])
                        for f in data["basins"]["features"]
                        if f["properties"]["mapped"]
                    ],
                )
            manifest_path = PUBLIC / record.get("runout", {}).get("url", "missing-file").lstrip("/")
            if manifest_path.exists():
                manifest = read(manifest_path)
                if manifest["assessmentId"] != pin["releaseId"]:
                    raise ValueError("Travel/companion release identity differs")
                for scenario in manifest["scenarios"]:
                    contour = read(PUBLIC / scenario["url"].lstrip("/"))
                    add(
                        "travel",
                        identity,
                        [
                            (pin["releaseId"], scenario["intensity"], index)
                            for index, _ in enumerate(contour["features"])
                        ],
                    )
        if evidence.get("goes", {}).get("status") == "available":
            count_goes(identity, evidence["goes"])
        if evidence.get("context", {}).get("status") == "available":
            add("slope", identity, [evidence["context"]["slope"]["file"]])
        if replay:
            if replay.get("goes"):
                count_goes(identity, replay["goes"])
            if replay.get("soilMap"):
                soil = read(PUBLIC / replay["soilMap"].lstrip("/"))
                measured = set()
                for series in soil["mapSeries"]:
                    keys = [
                        (series["sourceUrl"], series["fireId"], series["id"], grid)
                        for grid in series["values"]
                    ]
                    add("soil", identity, keys)
                    measured.update(series["values"])
                subcounts["soilMeasuredCells"] += len(measured)
                subcounts["soilReferenceCells"] += len(
                    read(PUBLIC / soil["geometry"]["path"].lstrip("/"))["features"]
                )
            for finding in (snapshot or {}).get("ash", {}).get("followup", []):
                add("soil_followup", identity, [(finding["sourceUrl"], finding["title"])])
        observation_path = (
            PUBLIC / "data/historical-fires/observations" / (identity.replace(":", "-") + ".json")
        )
        if observation_path in observation_files:
            data = read(observation_path)
            threshold_checks[identity] = {
                row.get("rainfallThreshold", {}).get("status", "not_checked")
                for row in data["records"]
            }
            for row in data["records"]:
                add("observations", identity, [row["id"]])
                linked_observations["observations"].add(row["id"])
                all_observations[row["id"]] = row
                observation_links[row["id"]] = identity
                if row["PeakI15"] is not None:
                    category = (
                        "measured_rain"
                        if row.get("gaugeStormIdentityVerified")
                        else "unresolved_rain"
                    )
                    add(category, identity, [(row["gaugeStormId"], row["PeakI15"])])
                    linked_observations[category].add(row["id"])
                threshold = supplements.get(row["id"], row.get("rainfallThreshold", {}))
                if threshold.get("status") == "available":
                    add("thresholds", identity, [threshold_key(threshold)])
                    linked_observations["thresholds"].add(row["id"])
                    if threshold["scope"] == "basin":
                        watersheds.add(row["assessmentSegmentId"])
        for category in ["smoke", "rain", "goes", "slope"]:
            product = "context" if category == "slope" else category
            check = evidence.get("checks", {}).get(product) or state["jobs"].get(identity, {}).get(
                product, {}
            )
            statuses[category][identity] = check.get("status", "not_checked")
            check_details[category][identity] = check.get("reason", "")
        if smoke.get("epaStatus"):
            statuses["smoke"][identity] = smoke["epaStatus"]
        if smoke.get("plumes", {}).get("days"):
            days = smoke["plumes"]["days"]
            if any(day["status"] == "available" for day in days):
                statuses["hms"][identity] = "available"
            elif any(day["status"] in ["failed", "access_failed"] for day in days):
                statuses["hms"][identity] = "access_failed"
            elif any(day["status"] == "quality_failed" for day in days):
                statuses["hms"][identity] = "quality_failed"
            else:
                statuses["hms"][identity] = "unavailable"

    for original in read(PUBLIC / "data/catalog.json")["cases"]:
        fire = observation_links.get(original["observationId"])
        if fire is None:
            if scoped:
                continue
            raise ValueError("Original observation has no verified catalog association")
        for kind, layer in original.get("products", {}).get("layers", {}).items():
            if layer["status"] != "available":
                continue
            category = "imagery" if kind in ["pre", "post"] else kind
            if category == "severity":
                category = "case_severity"
            add(category, fire, [layer["file"]])
            linked_observations[category].add(original["observationId"])
        if original.get("rainfallThreshold", {}).get("status") == "available":
            add("thresholds", fire, [threshold_key(original["rainfallThreshold"])])
            linked_observations["thresholds"].add(original["observationId"])
    for supplement in read(PUBLIC / "data/waves/ground.json")["cases"]:
        ids = [r["id"] for r in records if r.get("replayId") == supplement["id"]]
        slope = supplement["layers"]["slope"]
        if len(ids) == 1 and slope["status"] == "available":
            add("slope", ids[0], [slope["file"]])
    burn = read(PUBLIC / "data/fire-burn-summaries.json")
    burn_exclusions = {(row["mapId"], row["eventId"]): row["reason"] for row in burn["exclusions"]}
    lookup = {
        (r["mtbs"]["map_id"], r["mtbs"]["event_id"]): r["id"] for r in records if r.get("mtbs")
    }
    for row in burn["records"]:
        key = (row["mapId"], row["eventId"])
        if not scoped or key in lookup:
            retrieved["severity"].add(key)
        if key in lookup:
            add("severity", lookup[key], [key])
    audit_path = PUBLIC / "data/historical-fires/observation-audit.json"
    inventory_checked = audit_path.exists()
    if audit_path.exists():
        audit = read(audit_path)
        categories["observations"]["discovered"] = audit["discovered"]
    categories["severity"]["discovered"] = sum(bool(r.get("mtbs")) for r in records)
    categories["damage"]["discoveredIncidentGroups"] = state.get("damageIndex", {}).get("groups")
    inspection_path = ROOT / "data/raw/historical-coverage/inspection-discovery.json"
    if inspection_path.exists():
        categories["damage"]["discoveredByRelease"] = read(inspection_path)
        categories["damage"][
            "discoveryNote"
        ] = "Statewide and dedicated public releases overlap; do not sum their counts. One chosen release per matched incident."
    power_path = PUBLIC / "data/historical-fires/power-audit.json"
    if power_path.exists():
        audit = read(power_path)
        categories["power"]["previousPartialExportAudit"] = audit
    annual_power = []
    for path in sorted((ROOT / "data/raw/waves").glob("ornl-annual-validation-*.json")):
        annual_power.append(read(path))
    categories["power"]["checkedAnnualFiles"] = annual_power
    categories["power"][
        "discoveryMeaning"
    ] = "Annual validation counts retain original row units and explicit missing counts. Earlier partial exports may overlap annual files; do not sum their discovery totals. MatchedRecords counts numeric county/time slots only."
    categories["power"][
        "license"
    ] = "CC BY 4.0, as supplied by the official ORNL alternative export and the paper-linked annual Figshare release."
    categories["thresholds"][
        "identityMeaning"
    ] = "Distinct source release, basin/segment scope, and agency assessment identifier; multipart source features are counted separately under sourceAndQualityCounts."
    categories["rain"][
        "identityMeaning"
    ] = "Modern products retain agency SegmentID. Legacy products without stable identifiers count original archive/layer/row references, not established watersheds."
    categories["rain"]["discoveredFireLinks"] = sum(
        bool(r.get("assessment") or r["source"] == "USGS archive") for r in records
    )
    categories["health"]["studies"] = len(studies)
    categories["health"]["relationship"] = "regional_event_context / general_research_context"
    categories["health"][
        "matchMeaning"
    ] = "Shared figures displayed as context; not additional fire-specific estimates or measurements."
    categories["health"]["regionalContextFigures"] = sum(
        "cdc.gov" in key[0] for key in matched["health"]
    )
    categories["health"]["generalResearchFigures"] = sum(
        "cdc.gov" not in key[0] for key in matched["health"]
    )
    observed_fires = set(observation_links.values())
    for key in categories:
        entries = categories[key]
        entries["retrievedPassing"] = len(retrieved[key])
        entries["matchedRecords"] = len(matched[key])
        entries["fireSpecificRecords"] = (
            len(matched[key]) if entries["relationship"] == "fire_specific" else 0
        )
        entries["matchedFires"] = sorted(fires[key])
        entries["fireCount"] = len(fires[key])
        effective = Counter()
        unchecked = Counter()
        for record in records:
            identity = record["id"]
            status = (
                "available"
                if identity in fires[key]
                else statuses[key].get(identity, "not_checked")
            )
            if key == "power" and status == "not_checked":
                status = power_releases.get(record["year"], {}).get("status", status)
            effective[status] += 1
            if status == "not_checked":
                mtbs = record.get("mtbs") or {}
                burn_reason = burn_exclusions.get((mtbs.get("map_id"), mtbs.get("event_id")), "")
                detail = check_details["smoke" if key == "hms" else key].get(identity, "")
                reason = unchecked_reason(
                    key,
                    record,
                    state["jobs"].get(identity, {}),
                    detail,
                    identity in observed_fires,
                    inventory_checked,
                    threshold_checks.get(identity, set()),
                    burn_reason,
                    power_years,
                    entries["auditExplanation"],
                )
                unchecked[reason] += 1
        entries["statuses"] = dict(effective)
        entries["notCheckedReasons"] = [
            {"stage": stage, "reason": reason, "fires": count}
            for (stage, reason), count in unchecked.most_common()
        ]
        if sum(unchecked.values()) != effective.get("not_checked", 0):
            raise ValueError("Not-checked explanation counts do not reconcile")
        entries["displayed"] = None
    built_at = datetime.now(timezone.utc).isoformat()
    overlap_by_fire = {}
    for left in fires:
        overlaps = {}
        for right in fires:
            overlaps[right] = len(fires[left] & fires[right])
        overlap_by_fire[left] = overlaps
    report = {
        "schemaVersion": 2,
        "builtAt": built_at,
        "catalogFires": len(records),
        "categories": categories,
        "sourceAndQualityCounts": {
            k: len(v) if isinstance(v, set) else v for k, v in subcounts.items()
        },
        "overlapByFire": overlap_by_fire,
        "overlapByObservation": {
            key: sum(fire in fires[key] for fire in observation_links.values()) for key in fires
        },
        "observationOverlapMeaning": "Same fire only, not an assertion that imagery, sampling grids, structures or assessment versions represent that observation's watershed or date.",
        "observations": {
            "uniqueAssessmentIds": len(
                {
                    r["assessmentSegmentId"]
                    for r in all_observations.values()
                    if r["assessmentSegmentId"] != "-9999"
                }
            ),
            "fireStormPairs": len(
                {(r["fireId"], r["stormDate"]) for r in all_observations.values()}
            ),
            "sourceBasinsWithCheckedAttributesAndContainment": len(watersheds),
            "rainfallTimeSeries": 0,
        },
        "jobs": state["jobs"],
        "limitation": "No mixed-unit grand total. Null discovery/display counts mean not established. Prepared is not proof of browser display. Fire-level overlap does not establish watershed, property or causal equivalence.",
    }
    catalog = read(PUBLIC / "data/historical-fires/index.json")
    report["catalog"] = {
        key: catalog[key]
        for key in ["sourceRecordCount", "counts", "sources", "auditUrl", "limitation"]
    }
    report["notCheckedMeaning"] = (
        "Legacy per-category fallback, not proof of missing source data. It mixes deferred retrieval, missing prerequisites, limited source scope and completed source/index searches without a verified export. Each category provides a reason breakdown."
    )
    observation_overlap = {}
    for left in linked_observations:
        overlaps = {}
        for right in linked_observations:
            overlaps[right] = len(linked_observations[left] & linked_observations[right])
        observation_overlap[left] = overlaps
    report["verifiedObservationLinks"] = {
        "unit": "inventory observation identifier",
        "meaning": "Explicit inventory rainfall/threshold assignments and original case display-product links only. A display crop does not establish a watershed, acquisition independence or a time-matched measurement. Other categories have no established observation-level link in this audit.",
        "counts": {
            key: len(linked_observations[key]) if key in linked_observations else None
            for key in categories
        },
        "ids": {key: sorted(ids) for key, ids in linked_observations.items()},
        "overlap": observation_overlap,
    }
    report["exclusions"] = {
        "observationAudit": "/data/historical-fires/observation-audit.json",
        "mtbs": burn["exclusions"],
        "soil": "Only approved LA County and EPA studies are in scope. No statewide chemical-sampling series is implied; per-fire checks distinguish study scope from an unperformed check.",
        "water": "Only exact existing fire-to-notice links are prepared. Approved provider pages are checked; absent provider/service-area crosswalks remain unresolved, not evidence of no historical notice.",
        "power": "The paper-linked ORNL annual release supplies public 2014-2025 CSVs. Annual checks retain source checksums, county/time joins, reported zero counts and explicit blank counts. Previously reviewed partial exports remain unchanged. Per-fire queue results record which checks finished.",
        "imagery": "Only linked, verified source acquisitions are processed. Existing case files remain unchanged; dates, scaling and numeric validation failures retain their specific reasons. No entire imagery archive or substitute fire is used.",
        "legacyAssessments": "Original GeoJSON and legacy shapefile layouts are inspected independently. Unsupported definitions, absent stable identifiers and geometry failures remain explicit; no scenarios or watershed identities are inferred.",
    }
    return report


def eligible_coverage(records, state, replays, scope, connection):
    eligible_ids = set(scope["eligibleFireIds"])
    selected = [record for record in records if record["id"] in eligible_ids]
    if len(selected) != len(eligible_ids) or {record["id"] for record in selected} != eligible_ids:
        raise ValueError("Eligible audit identities do not match the catalog")
    report = make_report(selected, state, replays, scoped=True)
    summary = queue_status_summary(connection, eligible_ids)
    for source, category in report["categories"].items():
        counts = summary[source]
        if counts["total"] != len(selected):
            raise ValueError("Eligible audit source denominator differs")
        category["statuses"] = counts["statuses"]
        category["queue"] = counts
        category["notCheckedReasons"] = []
        category["auditExplanation"] = (
            "Completed checks for eligible fires only. Prepared evidence can remain available even when another part of a source check is blocked; check-job counts and prepared-record counts are different units."
        )
    fields = (
        "builtAt",
        "catalogFires",
        "categories",
        "sourceAndQualityCounts",
        "overlapByFire",
        "overlapByObservation",
        "observationOverlapMeaning",
        "observations",
        "verifiedObservationLinks",
        "limitation",
    )
    result = {field: report[field] for field in fields}
    result["fireIds"] = sorted(eligible_ids)
    result["scopeMeaning"] = (
        "Only the currently eligible California MTBS wildfires. Archived fire records and completed check history are retained separately, not counted here."
    )
    return result


def explain_saved_report():
    path = PUBLIC / "data/historical-fires/coverage.json"
    report = read(path)
    before = {}
    for key, value in report["categories"].items():
        saved = {}
        for field in [
            "retrievedPassing",
            "matchedRecords",
            "fireCount",
            "matchedFires",
            "statuses",
        ]:
            saved[field] = value[field]
        before[key] = saved
    index = read(PUBLIC / "data/historical-fires/index.json")
    records = []
    for year in index["years"]:
        records.extend(read(PUBLIC / year["url"].lstrip("/"))["records"])
    notes = read(ROOT / "data/historical_coverage_sources.json")["auditNotes"]
    power = read(ROOT / "data/recovery_sources.json")["power"]
    power_years = {row["year"] for row in power["annualExports"]}
    power_releases = {row["year"]: row for row in power["releases"]}
    burn = read(PUBLIC / "data/fire-burn-summaries.json")
    exclusions = {(row["mapId"], row["eventId"]): row["reason"] for row in burn["exclusions"]}
    inventory_checked = (PUBLIC / "data/historical-fires/observation-audit.json").exists()
    groups = {category: Counter() for category in report["categories"]}
    matched = {
        category: set(data["matchedFires"]) for category, data in report["categories"].items()
    }
    for record in records:
        identity = record["id"]
        evidence_path = PUBLIC / record["evidenceUrl"].lstrip("/")
        evidence = read(evidence_path) if evidence_path.exists() else {}
        jobs = report["jobs"].get(identity, {})
        checks = {}
        for category in ["smoke", "rain", "goes", "slope"]:
            product = "context" if category == "slope" else category
            checks[category] = evidence.get("checks", {}).get(product) or jobs.get(product, {})
        for category in ["damage", "water", "power"]:
            checks[category] = evidence.get("recovery", {}).get(category, {})
        smoke = evidence.get("smoke", {})
        if smoke.get("epaStatus"):
            checks["smoke"] = {"status": smoke["epaStatus"], "reason": smoke.get("reason", "")}
        days = smoke.get("plumes", {}).get("days", [])
        if days:
            status = "unavailable"
            for priority in ["quality_failed", "access_failed", "failed", "available"]:
                if any(day["status"] == priority for day in days):
                    status = "access_failed" if priority == "failed" else priority
            checks["hms"] = {"status": status}
        observation_path = (
            PUBLIC / "data/historical-fires/observations" / (identity.replace(":", "-") + ".json")
        )
        observed = observation_path.exists()
        thresholds = set()
        if observed:
            thresholds = {
                row.get("rainfallThreshold", {}).get("status", "not_checked")
                for row in read(observation_path)["records"]
            }
        mtbs = record.get("mtbs") or {}
        burn_reason = exclusions.get((mtbs.get("map_id"), mtbs.get("event_id")), "")
        for category in groups:
            if identity in matched[category]:
                continue
            check = checks.get(category, {})
            status = check.get("status", "not_checked")
            if category == "power" and status == "not_checked":
                status = power_releases.get(record["year"], {}).get("status", status)
            if status != "not_checked":
                continue
            detail = (
                checks.get("smoke", {}).get("reason", "")
                if category == "hms"
                else check.get("reason", "")
            )
            reason = unchecked_reason(
                category,
                record,
                jobs,
                detail,
                observed,
                inventory_checked,
                thresholds,
                burn_reason,
                power_years,
                notes[category],
            )
            groups[category][reason] += 1
    for category, counts in groups.items():
        data = report["categories"][category]
        if sum(counts.values()) != data["statuses"].get("not_checked", 0):
            raise ValueError("Saved not-checked counts differ from check logs: " + category)
        data["auditExplanation"] = notes[category]
        data["notCheckedReasons"] = [
            {"stage": stage, "reason": reason, "fires": count}
            for (stage, reason), count in counts.most_common()
        ]
        for field, original in before[category].items():
            if data[field] != original:
                raise ValueError("Audit wording changed a coverage count: " + category)
    report["notCheckedMeaning"] = (
        "Legacy per-category fallback, not proof of missing source data. It mixes deferred retrieval, missing prerequisites, limited source scope and completed source/index searches without a verified export. Each category provides a reason breakdown."
    )
    report["explanationsUpdatedAt"] = datetime.now(timezone.utc).isoformat()
    temporary = path.with_suffix(".json.tmp")
    temporary.write_text(
        json.dumps(report, ensure_ascii=False, allow_nan=False, separators=(",", ":")),
        encoding="utf-8",
    )
    temporary.replace(path)
    print(
        "Explanations added for",
        len(groups),
        "categories.",
    )


if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser(
        description="Count prepared historical evidence in its own units and preserve stage uncertainty.\n\nReceives resolved catalog records and the resumable check ledger; no network requests.\n"
    )
    parser.add_argument(
        "--explain-existing",
        action="store_true",
        required=True,
        help="Annotate existing coverage counts without loading geospatial libraries or retrieving sources",
    )
    parser.parse_args()
    explain_saved_report()
