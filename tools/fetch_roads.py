#!/usr/bin/env python3
"""Download the OpenStreetMap road network for a bounding box and build a
routing graph that the browser app can load without any network access.

Usage:
    python3 tools/fetch_roads.py                 # default area (north Kolkata)
    python3 tools/fetch_roads.py --bbox S,W,N,E   # any other area

Downloads are cached per tile in data/raw/, so an interrupted run resumes.

Writes data/graph.json with:
    meta   area, bbox, counts, attribution
    nodes  [[lat, lon], ...]              compacted to the largest component
    roads  [[name, highway], ...]         deduplicated road descriptors
    edges  [[u, v, metres, seconds, road], ...]   directed (oneway aware)
    places [[name, kind, lat, lon, node], ...]    offline place-name search
"""

import argparse
import json
import math
import os
import sys
import time
import urllib.parse
import urllib.request

DEFAULT_BBOX = (22.555, 88.355, 22.635, 88.495)  # S, W, N, E (Kolkata)
OVERPASS_ENDPOINTS = [
    "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
]
USER_AGENT = "Rasta-ShortestPathVisualizer/1.0 (student seminar project)"

HIGHWAY_SPEED_KMH = {
    "motorway": 80,
    "trunk": 70,
    "primary": 60,
    "secondary": 50,
    "tertiary": 40,
    "unclassified": 30,
    "residential": 30,
    "living_street": 15,
    "service": 20,
    "motorway_link": 45,
    "trunk_link": 40,
    "primary_link": 35,
    "secondary_link": 30,
    "tertiary_link": 25,
    "road": 25,
}
DRIVABLE = "|".join(HIGHWAY_SPEED_KMH.keys())

PLACE_FILTERS = [
    ('node["name"]["amenity"~"^(hospital|university|college|railway_station|bus_station|marketplace|place_of_worship|theatre|police|townhall|library)$"]', "amenity"),
    ('node["name"]["shop"="mall"]', "mall"),
    ('node["name"]["leisure"="park"]', "park"),
    ('node["name"]["tourism"~"^(attraction|museum)$"]', "tourism"),
]


def overpass(query):
    last_error = None
    for endpoint in OVERPASS_ENDPOINTS:
        for attempt in range(2):
            try:
                data = urllib.parse.urlencode({"data": query}).encode()
                req = urllib.request.Request(
                    endpoint, data=data, headers={"User-Agent": USER_AGENT}
                )
                with urllib.request.urlopen(req, timeout=200) as response:
                    return json.load(response)
            except Exception as error:  # noqa: BLE001 - report and try again
                last_error = error
                print(f"  ! {endpoint} (attempt {attempt + 1}) failed: {error}",
                      file=sys.stderr, flush=True)
                time.sleep(3)
    raise SystemExit(f"Overpass request failed: {last_error}")


def haversine(lat1, lon1, lat2, lon2):
    radius = 6371008.8
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp = p2 - p1
    dl = math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * radius * math.asin(math.sqrt(a))


def parse_maxspeed(value):
    if not value:
        return None
    raw = value.split(";")[0].strip().lower()
    if raw in ("none", "walk", "signals", "variable"):
        return None
    number = ""
    for char in raw:
        if char.isdigit() or char == ".":
            number += char
        elif number:
            break
    if not number:
        return None
    try:
        speed = float(number)
    except ValueError:
        return None
    if "mph" in raw:
        speed *= 1.609344
    elif "knot" in raw:
        speed *= 1.852
    return speed if 1 <= speed <= 160 else None


def way_speed(tags):
    highway = tags.get("highway", "road")
    if tags.get("maxspeed"):
        parsed = parse_maxspeed(tags["maxspeed"])
        if parsed:
            return parsed
    return HIGHWAY_SPEED_KMH.get(highway, 25)


def is_oneway(tags):
    if tags.get("oneway") in ("yes", "true", "1"):
        return 1
    if tags.get("oneway") in ("-1", "reverse"):
        return -1
    if tags.get("oneway") in ("no", "false", "0"):
        return 0
    if tags.get("junction") == "roundabout":
        return 1
    if tags.get("highway") == "motorway":
        return 1
    return 0


def tiles_for(bbox, tiles):
    south, west, north, east = bbox
    dlat = (north - south) / tiles
    dlon = (east - west) / tiles
    for row in range(tiles):
        for col in range(tiles):
            yield (
                south + row * dlat,
                west + col * dlon,
                south + (row + 1) * dlat,
                west + (col + 1) * dlon,
            )


def box_of(bbox):
    return ",".join(f"{value:.6f}" for value in bbox)


def cached_query(label, query, cache_dir):
    path = os.path.join(cache_dir, f"{label}.json")
    if os.path.exists(path):
        print(f"  using cached {path}", flush=True)
        with open(path, "r", encoding="utf-8") as handle:
            return json.load(handle)
    print(f"  querying Overpass for {label} ...", flush=True)
    data = overpass(query)
    os.makedirs(cache_dir, exist_ok=True)
    with open(path, "w", encoding="utf-8") as handle:
        json.dump(data, handle, separators=(",", ":"))
    return data


def road_query(bbox):
    return (
        f'[out:json][timeout:180];'
        f'way["highway"~"^({DRIVABLE})$"]["area"!~"yes"]({box_of(bbox)});'
        f"out body;>;out skel qt;"
    )


def place_query(bbox):
    union = "\n".join(f"  {selector}({box_of(bbox)});"
                      for selector, _ in PLACE_FILTERS)
    return f"[out:json][timeout:120];\n(\n{union}\n);\nout body;"


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--bbox", default=",".join(str(v) for v in DEFAULT_BBOX),
                        help="south,west,north,east")
    parser.add_argument("--out", default="data/graph.json")
    parser.add_argument("--tiles", type=int, default=3,
                        help="split the area into tiles x tiles requests")
    parser.add_argument("--no-places", action="store_true")
    args = parser.parse_args()

    bbox = tuple(float(v) for v in args.bbox.split(","))
    if len(bbox) != 4:
        raise SystemExit("--bbox needs four values: south,west,north,east")
    south, west, north, east = bbox
    cache_dir = os.path.join(os.path.dirname(args.out) or ".", "raw")
    print(f"Fetching road network for bbox {box_of(bbox)} ...", flush=True)

    nodes = {}
    ways = {}
    for tile in tiles_for(bbox, args.tiles):
        label = "roads_" + "_".join(f"{value:.3f}" for value in tile).replace(".", "p")
        payload = cached_query(label, road_query(tile), cache_dir)
        for element in payload.get("elements", []):
            if element.get("type") == "node":
                nodes[element["id"]] = (element["lat"], element["lon"])
            elif element.get("type") == "way":
                ways[element["id"]] = element
        print(f"    running total: {len(ways)} ways, {len(nodes)} nodes",
              flush=True)

    roads = []
    road_index = {}
    edges = []  # (u_osm, v_osm, metres, seconds, road_idx)

    for way in ways.values():
        tags = way.get("tags", {})
        highway = tags.get("highway")
        if highway not in HIGHWAY_SPEED_KMH:
            continue
        if tags.get("access") == "private" and tags.get("motor_vehicle") == "no":
            continue
        speed_ms = way_speed(tags) / 3.6
        name = tags.get("name") or tags.get("ref") or "Unnamed road"
        key = (name, highway)
        if key not in road_index:
            road_index[key] = len(roads)
            roads.append([name, highway])
        road = road_index[key]
        direction = is_oneway(tags)

        node_ids = [n for n in way.get("nodes", []) if n in nodes]
        for a, b in zip(node_ids, node_ids[1:]):
            if a == b:
                continue
            lat1, lon1 = nodes[a]
            lat2, lon2 = nodes[b]
            metres = haversine(lat1, lon1, lat2, lon2)
            if metres < 0.4 or metres > 3000:
                continue
            seconds = metres / speed_ms
            if direction >= 0:
                edges.append((a, b, metres, seconds, road))
            if direction <= 0:
                edges.append((b, a, metres, seconds, road))

    print(f"  raw: {len(nodes)} nodes, {len(edges)} directed edges", flush=True)

    # Keep only the largest weakly connected component so any two snaps route.
    parent = {node: node for node in nodes}

    def find(node):
        while parent[node] != node:
            parent[node] = parent[parent[node]]
            node = parent[node]
        return node

    def union(a, b):
        ra, rb = find(a), find(b)
        if ra != rb:
            parent[rb] = ra

    for u, v, _, _, _ in edges:
        union(u, v)

    component_sizes = {}
    for node in nodes:
        root = find(node)
        component_sizes[root] = component_sizes.get(root, 0) + 1
    if not component_sizes:
        raise SystemExit("No routable roads found in that bounding box.")
    largest_root = max(component_sizes, key=component_sizes.get)
    keep = {node for node in nodes if find(node) == largest_root}
    dropped = len(nodes) - len(keep)
    print(f"  kept largest component: {len(keep)} nodes (dropped {dropped})",
          flush=True)

    index = {osm_id: i for i, osm_id in enumerate(sorted(keep))}
    final_nodes = [[round(nodes[osm_id][0], 6), round(nodes[osm_id][1], 6)]
                   for osm_id in index]

    final_edges = []
    for u, v, metres, seconds, road in edges:
        if u in index and v in index:
            final_edges.append([index[u], index[v], round(metres, 1),
                                round(seconds, 1), road])

    places = []
    if not args.no_places:
        print("Fetching named places for offline search ...", flush=True)
        place_payload = cached_query(
            "places_" + "_".join(f"{value:.3f}" for value in bbox).replace(".", "p"),
            place_query(bbox), cache_dir)

        seen = set()
        for element in place_payload.get("elements", []):
            if element.get("type") != "node":
                continue
            name = (element.get("tags", {}).get("name") or "").strip()
            if not name or len(name) > 60:
                continue
            lat, lon = element.get("lat"), element.get("lon")
            if lat is None or lon is None:
                continue
            tags = element.get("tags", {})
            kind = tags.get("amenity") or tags.get("shop") or tags.get("leisure") \
                or tags.get("tourism") or "place"
            dedupe = (name.lower(), round(lat, 3), round(lon, 3))
            if dedupe in seen:
                continue
            seen.add(dedupe)
            best_node, best_distance = None, 1e18
            for i, (nlat, nlon) in enumerate(final_nodes):
                dx = (nlon - lon) * math.cos(math.radians(nlat)) * 111320
                dy = (nlat - lat) * 110540
                d2 = dx * dx + dy * dy
                if d2 < best_distance:
                    best_distance, best_node = d2, i
            if best_node is None or best_distance > 400 ** 2:
                continue
            places.append([name, kind, round(lat, 6), round(lon, 6), best_node])

        places.sort(key=lambda place: place[0].lower())
        print(f"  {len(places)} searchable places", flush=True)

    meta = {
        "name": "North, central & east Kolkata",
        "bbox": [south, west, north, east],
        "generated": time.strftime("%Y-%m-%d"),
        "source": "OpenStreetMap via Overpass API",
        "attribution": "© OpenStreetMap contributors (ODbL)",
        "nodeCount": len(final_nodes),
        "edgeCount": len(final_edges),
        "roadCount": len(roads),
    }

    result = {"meta": meta, "nodes": final_nodes, "roads": roads,
              "edges": final_edges, "places": places}

    out_path = args.out
    os.makedirs(os.path.dirname(out_path) or ".", exist_ok=True)
    with open(out_path, "w", encoding="utf-8") as handle:
        json.dump(result, handle, separators=(",", ":"), ensure_ascii=False)

    size_mb = os.path.getsize(out_path) / 1024 / 1024
    print(f"Wrote {out_path} ({size_mb:.2f} MB)")
    print(f"  {len(final_nodes)} nodes, {len(final_edges)} directed edges, "
          f"{len(roads)} road names")


if __name__ == "__main__":
    main()
