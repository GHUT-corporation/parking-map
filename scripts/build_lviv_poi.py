"""Offline OSM snapshot builder. Requires osmium and shapely; never runs in the browser.

Usage: python scripts/build_lviv_poi.py INPUT.osm.pbf RAW_CACHE.json [BASELINE.geojson]
The cache allows repeatable validation without another download or PBF scan.
With a baseline, writes the regional GeoJSON, coverage polygons and deduplication audit.
"""
import collections
import datetime
import json
import hashlib
import re
from pathlib import Path
import sys

import osmium
from shapely.geometry import Point, LineString, Polygon, box, mapping, shape
from shapely import wkb
from shapely.strtree import STRtree
from shapely.ops import unary_union
from data_tool_io import write_files

BBOX = [23.75, 49.65, 24.35, 50.05]
REGION = box(*BBOX)
NAMES = {"Львів", "Винники", "Брюховичі", "Рудне", "Рудно", "Сокільники", "Зимна Вода", "Малехів", "Дубляни"}
REPAIR_SERVICES = ("car_repair", "tyres_repair", "oil_change", "tyres", "diagnostics", "brakes", "body_repair", "air_conditioning", "painting", "glass", "electrical", "muffler", "transmission", "motor", "alignment")
SOURCE = "https://download.geofabrik.de/europe/ukraine-latest.osm.pbf"


def relevant(tags):
    return (tags.get("amenity") in {"parking", "parking_space", "charging_station", "fuel"}
            or tags.get("shop") in {"car_repair", "tyres"}
            or any(tags.get("service:vehicle:" + service) == "yes" for service in REPAIR_SERVICES)
            or tags.get("site") == "parking" or tags.get("craft") == "car_repair")


class Extract(osmium.SimpleHandler):
    def __init__(self):
        super().__init__()
        self.features, self.boundaries, self.places, self.sites = {}, {}, {}, {}
        self.street_ways, self.invalid = set(), set()
        self.factory = osmium.geom.WKBFactory()

    def save(self, osm_id, tags, geom, target):
        if not geom.is_empty and geom.intersects(REGION):
            if not geom.is_valid:
                self.invalid.add(osm_id)
                return
            target[osm_id] = {"type": "Feature", "id": osm_id,
                              "properties": tags, "geometry": mapping(geom)}

    def node(self, obj):
        if not obj.location.valid():
            return
        tags = dict(obj.tags)
        point = Point(obj.location.lon, obj.location.lat)
        if relevant(tags):
            self.save(f"node/{obj.id}", tags, point, self.features)
        if tags.get("place") and tags.get("name") in NAMES:
            self.save(f"node/{obj.id}", tags, point, self.places)

    def way(self, obj):
        tags = dict(obj.tags)
        street = tags.get("highway") and any(
            tags.get(f"parking:{side}") in {"lane", "street_side", "on_kerb", "half_on_kerb", "shoulder"}
            or tags.get(f"parking:lane:{side}") in {"parallel", "diagonal", "perpendicular"}
            for side in ("left", "right", "both"))
        if not relevant(tags) and not street:
            return
        try:
            points = [(n.lon, n.lat) for n in obj.nodes]
            if len(points) < 2:
                return
            geom = Polygon(points) if len(points) >= 4 and points[0] == points[-1] else LineString(points)
            if street and geom.intersects(REGION):
                self.street_ways.add(obj.id)
            if relevant(tags):
                self.save(f"way/{obj.id}", tags, geom, self.features)
        except (RuntimeError, ValueError):
            self.invalid.add(f"way/{obj.id}")

    def relation(self, obj):
        if obj.tags.get("site") == "parking":
            self.sites[f"relation/{obj.id}"] = {"tags": dict(obj.tags), "members": [
                f"{'node' if m.type == 'n' else 'way' if m.type == 'w' else 'relation'}/{m.ref}" for m in obj.members]}

    def area(self, obj):
        tags = dict(obj.tags)
        boundary = tags.get("boundary") == "administrative" and tags.get("name") in NAMES
        if not relevant(tags) and not boundary:
            return
        osm_id = f"{'way' if obj.from_way() else 'relation'}/{obj.orig_id()}"
        try:
            geom = wkb.loads(self.factory.create_multipolygon(obj), hex=True)
            self.save(osm_id, tags, geom, self.boundaries if boundary else self.features)
        except (RuntimeError, ValueError):
            self.invalid.add(osm_id)


def extract(pbf, cache):
    handler = Extract()
    with osmium.io.Reader(str(pbf)) as reader:
        timestamp = reader.header().get("osmosis_replication_timestamp")
    handler.apply_file(str(pbf), locations=True, filters=[osmium.filter.KeyFilter(
        "amenity", "shop", "craft", "service:vehicle:car_repair", "service:vehicle:tyres_repair", "service:vehicle:oil_change", "site", "boundary", "place",
        "parking:left", "parking:right", "parking:both", "parking:lane:left", "parking:lane:right", "parking:lane:both")])
    raw = {"source": SOURCE, "snapshot": timestamp, "bbox": BBOX,
           "downloadedAt": datetime.datetime.now(datetime.timezone.utc).isoformat(),
           "features": list(handler.features.values()), "boundaries": list(handler.boundaries.values()),
           "places": list(handler.places.values()), "sites": handler.sites,
           "streetWays": sorted(handler.street_ways), "invalid": sorted(handler.invalid)}
    write_files({cache: json.dumps(raw, ensure_ascii=False, separators=(",", ":"))})
    return raw


def paid(tags):
    if tags.get("fee") == "yes":
        return True
    def price(value):
        match = re.match(r"^\s*(\d+(?:[.,]\d+)?)\s*(?:UAH|EUR|USD|грн)(?:\b|/|\s|$)", str(value or ""), re.I)
        return bool(match and float(match[1].replace(",", ".")) > 0)
    if price(tags.get("fee")):
        return True
    return not tags.get("fee") and not tags.get("fee:conditional") and price(tags.get("charge"))


def category(tags):
    if tags.get("amenity") in {"parking", "parking_space"} or tags.get("site") == "parking":
        return "paid" if paid(tags) else "parking"
    if tags.get("amenity") == "charging_station":
        return "charging"
    if tags.get("amenity") == "fuel":
        return "fuel"
    named_tyre_service = tags.get('shop') == 'tyres' and any(re.fullmatch(r'(шиномонтаж|шино монтаж|вулканізація|car tire repair)', str(tags.get(k,'')), re.I) for k in ('name','name:uk','name:en'))
    explicit_repair = tags.get('service:vehicle:car_repair') == 'yes' and tags.get('shop') not in {'bicycle','motorcycle','motorcycle_repair'}
    if tags.get("shop") == "car_repair" or tags.get('craft') == 'car_repair' or named_tyre_service or explicit_repair or (tags.get("shop") in {"car", "car_parts", "tyres"} and
            any(tags.get("service:vehicle:" + service) == "yes" for service in REPAIR_SERVICES)):
        return "repair"
    return None


def build(raw, baseline_path, pbf):
    root = Path(__file__).resolve().parents[1]
    baseline = json.loads(baseline_path.read_text(encoding="utf-8-sig"))
    old = {f["properties"]["osmId"]: f for f in baseline["features"]}
    source_geometries = {f["id"]: shape(f["geometry"]) for f in raw["features"]}
    candidates = {}
    ignored = []
    for f in raw["features"]:
        key = category(f["properties"])
        geometry = source_geometries[f["id"]]
        if not key:
            ignored.append({"id": f["id"], "reason": "No confirmed category tags"})
            continue
        point = geometry.representative_point()
        if not REGION.covers(point):
            continue
        candidates[f["id"]] = {"type": "Feature", "id": f["id"], "geometry": mapping(point),
            "properties": {**f["properties"], "osmId": f["id"], "osmType": f["id"].split("/")[0],
                           "category": key, "sourceRecord": "geofabrik"}}
    # The existing API snapshot is newer than this Geofabrik extract. Keep its values.
    corrected_markers = []
    for osm_id, f in old.items():
        candidates[osm_id] = {**f, "properties": {**f["properties"], "category": category(f["properties"]),
                                                "sourceRecord": "previous-osm-api"}}
        source_geometries.setdefault(osm_id, shape(f["geometry"]))
        geom = source_geometries[osm_id]
        if geom.geom_type in {"Polygon", "MultiPolygon"} and not geom.covers(shape(f["geometry"])):
            candidates[osm_id]["geometry"] = mapping(geom.representative_point())
            corrected_markers.append(osm_id)
    site_groups = []
    for osm_id, site in raw["sites"].items():
        present = [member for member in site["members"] if member in candidates]
        if not present:
            continue
        # Site relations are groupings, not additional parking lots.
        site_groups.append({"id": osm_id, "mappedMembers": present,
                            "completeMembership": len(present) == len(site["members"])})
        if osm_id in candidates and candidates[osm_id]["properties"].get("amenity") != "parking":
            del candidates[osm_id]

    lots = [osm_id for osm_id, f in candidates.items() if f["properties"].get("amenity") == "parking"
            and source_geometries[osm_id].geom_type in {"Polygon", "MultiPolygon"}]
    tree = STRtree([source_geometries[osm_id] for osm_id in lots])
    nested = []
    for osm_id, f in list(candidates.items()):
        if f["properties"].get("amenity") != "parking_space":
            continue
        geom = source_geometries[osm_id]
        parents = [lots[int(i)] for i in tree.query(geom) if source_geometries[lots[int(i)]].covers(geom)]
        if parents:
            parent = min(parents, key=lambda item: source_geometries[item].area)
            props = candidates[parent]["properties"]
            props["mapped_spaces"] = props.get("mapped_spaces", 0) + 1
            nested.append({"id": osm_id, "parent": parent})
            del candidates[osm_id]

    # Merge only demonstrable duplicate representations, not merely nearby businesses.
    ids = sorted(candidates, key=lambda item: (source_geometries[item].geom_type == "Point",
                                             item not in old, not item.startswith("relation/"), item))
    tree = STRtree([source_geometries[item] for item in ids])
    kept, duplicates = set(), []
    for index, osm_id in enumerate(ids):
        geom, props = source_geometries[osm_id], candidates[osm_id]["properties"]
        duplicate = None
        for other_index in tree.query(geom):
            other_id = ids[int(other_index)]
            if other_id not in kept:
                continue
            other_geom, other_props = source_geometries[other_id], candidates[other_id]["properties"]
            if props["category"] != other_props["category"] or props.get("amenity") == "parking_space":
                continue
            same_name = bool(props.get("name")) and props.get("name") == other_props.get("name")
            conflicting_names = props.get("name") and other_props.get("name") and not same_name
            same_polygon = not conflicting_names and geom.geom_type in {"Polygon", "MultiPolygon"} and geom.equals(other_geom)
            named_node = same_name and geom.geom_type == "Point" and other_geom.geom_type in {"Polygon", "MultiPolygon"} and other_geom.covers(geom)
            if same_polygon or named_node:
                duplicate = other_id
                break
        if duplicate:
            parent_props = candidates[duplicate]["properties"]
            for tag, value in props.items():
                if tag not in {"osmId", "osmType", "category", "sourceRecord"}:
                    parent_props.setdefault(tag, value)
            duplicates.append({"id": osm_id, "parent": duplicate, "reason": "Identical polygon or same-name node inside facility"})
        else:
            kept.add(osm_id)
    features = [candidates[item] for item in sorted(kept)]
    ukr = json.loads((root / "data/ukraine-boundary.geojson").read_text(encoding="utf-8"))
    ukr_features = ukr.get("features", [ukr])
    ukraine = unary_union([shape(f["geometry"]) for f in ukr_features])
    for feature in features:
        point = shape(feature["geometry"])
        assert REGION.covers(point) and ukraine.covers(point), feature["id"]
        geom = source_geometries[feature["id"]]
        if geom.geom_type in {"Polygon", "MultiPolygon"}:
            assert geom.covers(point), feature["id"]
        assert feature["properties"]["category"] is not None, feature["id"]
        feature["geometry"]["coordinates"] = [round(n, 7) for n in point.coords[0]]
    boundary_checks = []
    for boundary in raw["boundaries"]:
        geometry = shape(boundary["geometry"])
        boundary_checks.append({"osmId": boundary["id"], "name": boundary["properties"]["name"],
            "admin_level": boundary["properties"].get("admin_level"), "fullyInsideProcessedRegion": REGION.covers(geometry),
            "counts": dict(collections.Counter(f["properties"]["category"] for f in features if geometry.covers(shape(f["geometry"]))))})
    with pbf.open("rb") as stream:
        checksum = hashlib.file_digest(stream, "sha256").hexdigest()
    metadata = {"source": "OpenStreetMap via Geofabrik, retaining the newer local OSM API records",
        "sourceUrl": SOURCE, "license": "Open Database License 1.0 (ODbL)", "attribution": "© OpenStreetMap contributors",
        "extractedAt": raw["downloadedAt"], "snapshot": raw["snapshot"], "bbox": [BBOX],
        "sources": {"geofabrik": {"url": SOURCE, "snapshot": raw["snapshot"], "sha256": checksum},
                    "previous-osm-api": baseline["metadata"]},
        "note": "All candidate OSM data in this rectangle were processed. This is not a guarantee of complete real-world POI mapping.",
        "osmIdAliases": {item["id"]: item["parent"] for item in duplicates},
        "coverageAudit": "./lviv-poi-audit.json"}
    output = {"type": "FeatureCollection", "metadata": metadata, "features": features}
    target = root / "data/lviv-poi.geojson"
    output_payload = json.dumps(output, ensure_ascii=False, separators=(",", ":"))
    new_ids = {f["id"] for f in features}
    audit = {"snapshot": raw["snapshot"], "processedBbox": BBOX,
        "before": dict(collections.Counter(f["properties"]["category"] for f in old.values())),
        "after": dict(collections.Counter(f["properties"]["category"] for f in features)),
        "beforeCount": len(old), "afterCount": len(features), "newUniqueIds": len(new_ids - old.keys()),
        "addedOsmIds": sorted(new_ids - old.keys()),
        "addedByCategory": dict(collections.Counter(f["properties"]["category"] for f in features if f["id"] not in old)),
        "categoryChanges": [{"id": f["id"], "before": old[f["id"]]["properties"]["category"],
                             "after": f["properties"]["category"]} for f in features if f["id"] in old and
                            old[f["id"]]["properties"]["category"] != f["properties"]["category"]],
        "retainedPreviousIds": len(new_ids & old.keys()), "removedPreviousIds": sorted(old.keys() - new_ids),
        "beforeBytes": baseline_path.stat().st_size, "afterBytes": len(output_payload.encode('utf-8')),
        "administrativeCoverage": boundary_checks, "nestedSpaces": nested, "duplicates": duplicates,
        "siteGroups": site_groups, "unclassifiedCandidates": ignored,
        "streetWaysNotConvertedToMarkers": raw["streetWays"],
        "invalidGeometryIds": raw["invalid"],
        "correctedPreviousMarkerIds": corrected_markers,
        "standaloneSpaces": sum(f["properties"].get("amenity") == "parking_space" for f in features),
        "access": dict(collections.Counter(f["properties"].get("access", "unknown") for f in features))}
    coverage_payload = json.dumps({"type": "FeatureCollection", "metadata": {
        "source": SOURCE, "snapshot": raw["snapshot"], "license": "ODbL-1.0", "attribution": "© OpenStreetMap contributors"},
        "features": raw["boundaries"]}, ensure_ascii=False, separators=(",", ":"))
    write_files({target: output_payload, root / "data/lviv-poi-audit.json": json.dumps(audit, ensure_ascii=False, indent=2) + "\n",
                 root / "data/lviv-poi-coverage.geojson": coverage_payload})
    print(json.dumps({key: value for key, value in audit.items() if key not in {
        "nestedSpaces", "duplicates", "unclassifiedCandidates", "streetWaysNotConvertedToMarkers", "invalidGeometryIds", "siteGroups", "addedOsmIds", "correctedPreviousMarkerIds"}}, ensure_ascii=False), flush=True)


if __name__ == "__main__":
    pbf, cache = Path(sys.argv[1]), Path(sys.argv[2])
    raw = json.loads(cache.read_text(encoding="utf-8")) if cache.exists() else extract(pbf, cache)
    if len(sys.argv) > 3:
        build(raw, Path(sys.argv[3]), pbf)
        sys.exit(0)
    print(json.dumps({"features": len(raw["features"]), "snapshot": raw["snapshot"],
                      "boundaries": [{"id": f["id"], "name": f["properties"].get("name"),
                                      "level": f["properties"].get("admin_level"),
                                      "bounds": shape(f["geometry"]).bounds} for f in raw["boundaries"]],
                      "places": [f["properties"].get("name") for f in raw["places"]],
                      "streetWays": len(raw["streetWays"])}, ensure_ascii=False), flush=True)
