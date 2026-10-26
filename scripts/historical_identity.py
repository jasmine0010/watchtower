import copy
import re
from collections import defaultdict

from shapely.geometry import Point, shape


def fire_name(value):
    return re.sub(r"\s+", " ", re.sub(r" Fire$", "", value.strip(), flags=re.I)).upper()


def location(record):
    if record.get("mtbs"):
        row = record["mtbs"]
        return row.get("burnbndlon"), row.get("burnbndlat")
    row = record.get("assessment", {})
    return row.get("lon"), row.get("lat")


def contained_match(record, candidates, polygons):
    matches = []
    lon, lat = location(record)
    if lon is None or lat is None or not record.get("ignition"):
        return None
    for candidate in candidates:
        if fire_name(record["name"]) != fire_name(candidate["name"]) or record[
            "ignition"
        ] != candidate.get("ignition"):
            continue
        geometry = polygons.get(candidate["sourceId"])
        if geometry and shape(geometry).contains(Point(float(lon), float(lat))):
            matches.append(candidate)
    return matches[0] if len(matches) == 1 else None


def consolidate(records, polygons, replays):
    by_id = {row["id"]: row for row in records}
    parent = {key: key for key in by_id}
    links = []

    def root(key):
        while parent[key] != key:
            key = parent[key]
        return key

    def join(left, right, reason):
        if left not in parent or right not in parent:
            return
        a, b = root(left), root(right)
        if a != b:
            parent[b] = a
            links.append({"left": left, "right": right, "method": reason})

    identities = {}
    for row in records:
        official = None
        if row.get("mtbs"):
            official = ("MTBS", row["mtbs"]["event_id"])
        elif row.get("assessment"):
            official = ("USGS", row["assessment"]["Fire_ID"])
        elif row.get("record", {}).get("IRWINID"):
            official = ("IRWIN", row["record"]["IRWINID"].strip("{}").upper())
        if official:
            if official in identities:
                join(identities[official], row["id"], "Same official incident identifier")
            identities[official] = row["id"]

    frap = defaultdict(list)
    for row in records:
        if row["source"] == "CAL FIRE":
            frap[(fire_name(row["name"]), row["ignition"])].append(row)
    for row in records:
        if row.get("mtbs") or row.get("assessment"):
            candidates = frap[(fire_name(row["name"]), row["ignition"])]
            match = contained_match(row, candidates, polygons)
            if match:
                join(
                    match["id"],
                    row["id"],
                    "Exact name/day; unique CAL FIRE polygon contains agency location",
                )

    archives = {row["sourceId"]: row for row in records if row["source"] == "USGS archive"}
    mtbs = {row["mtbs"]["map_id"]: row for row in records if row.get("mtbs")}
    agency = {row["assessment"]["Fire_ID"]: row for row in records if row.get("assessment")}
    runout = {row["sourceId"]: row for row in records if row.get("runout")}
    for row in agency.values():
        url = (row["assessment"].get("ScienceBaseURL") or "").strip()
        release = archives.get(url.rsplit("/", 1)[-1])
        if release and url == release["sourceUrl"]:
            join(row["id"], release["id"], "Assessment explicitly links this ScienceBase release")
    for row in runout.values():
        match = row["runout"].get("match")
        target = mtbs.get(match["mapId"]) if match else None
        if target and target["mtbs"]["event_id"] == match["eventId"]:
            join(target["id"], row["id"], "Previously verified runout-to-MTBS event identity")
        checked_agency = row["runout"].get("agencyMatch")
        if checked_agency and checked_agency["Fire_ID"] in agency:
            target = agency[checked_agency["Fire_ID"]]
            if target["assessment"]["start_date"] == checked_agency["start_date"]:
                join(
                    target["id"], row["id"], "Previously verified runout-to-USGS incident identity"
                )

    replay_sources = {}
    for replay in replays:
        linked = []
        if replay.get("usgsId") in agency:
            linked.append(agency[replay["usgsId"]]["id"])
        release = replay.get("coordinatedRain", {}).get("releaseId")
        if release in runout:
            linked.append(runout[release]["id"])
        for key in linked[1:]:
            join(
                linked[0],
                key,
                "Existing reviewed replay pins both source identities; source dates remain separate",
            )
        if linked:
            replay_sources[replay["id"]] = linked[0]

    groups = defaultdict(list)
    for row in records:
        groups[root(row["id"])].append(row)
    priorities = {"CAL FIRE": 0, "MTBS": 1, "USGS": 2, "USGS runout": 3, "USGS archive": 4}
    result = []
    for members in groups.values():
        members.sort(key=lambda row: (priorities[row["source"]], row["id"]))
        primary = members[0]
        entry = copy.deepcopy(primary)
        entry["aliases"] = [row["id"] for row in members]
        source_records = []
        for member in members:
            source_record = {}
            for field in (
                "id",
                "source",
                "sourceId",
                "sourceUrl",
                "ignition",
                "retrievedAt",
                "assessmentDate",
                "publicationDate",
            ):
                if field in member:
                    source_record[field] = copy.deepcopy(member[field])
            source_records.append(source_record)
        entry["sources"] = source_records
        entry["linkEvidence"] = [
            link
            for link in links
            if link["left"] in entry["aliases"] and link["right"] in entry["aliases"]
        ]
        for field in (
            "mtbs",
            "assessment",
            "runout",
            "coordinatedRain",
            "boundaryUrl",
            "bounds",
            "archiveFiles",
        ):
            options = [row for row in members if row.get(field)]
            if options:
                options.sort(key=lambda row: row.get("assessmentDate") or "", reverse=True)
                entry[field] = copy.deepcopy(options[0][field])
        if entry.get("boundaryUrl"):
            entry["boundaryId"] = next(row["sourceId"] for row in members if row.get("boundaryUrl"))
        matches = [
            key for key, source in replay_sources.items() if root(source) == root(primary["id"])
        ]
        if len(matches) > 1:
            raise ValueError("Multiple reviewed replays resolve to one fire; review required")
        if matches:
            entry["replayId"] = matches[0]
            entry["aliases"].append(matches[0])
        entry["evidenceUrl"] = (
            "/data/historical-fires/evidence/" + primary["id"].replace(":", "-") + ".json"
        )
        result.append(entry)

    names = defaultdict(list)
    for entry in result:
        names[(fire_name(entry["name"]), entry["year"])].append(entry)
    unresolved, visible = [], []
    for entries in names.values():
        anchors = [row for row in entries if row["source"] == "CAL FIRE"]
        for entry in entries:
            if anchors and entry not in anchors:
                reason = "Possible same-name/year fire; exact identity or containment not confirmed. Not merged."
                entry["associationStatus"] = "unresolved"
                unresolved.append(
                    {
                        "record": entry,
                        "status": "association_unresolved",
                        "reason": reason,
                        "candidates": [row["id"] for row in anchors],
                    }
                )
                for anchor in anchors:
                    anchor.setdefault("unconfirmedSources", []).append(
                        {
                            "id": entry["id"],
                            "sourceUrl": entry["sourceUrl"],
                            "source": entry["source"],
                            "reason": reason,
                        }
                    )
            else:
                visible.append(entry)
    return visible, {
        "links": links,
        "unresolved": unresolved,
        "sourceRecords": len(records),
        "fireEntries": len(visible),
        "rule": "Official identity or exact name/day plus strict polygon containment. No date tolerance or nearest-feature matching.",
    }
