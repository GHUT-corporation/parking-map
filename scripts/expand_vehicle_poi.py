"""Targeted vehicle-only scan of the existing PBF; no parking geometry processing.
Usage: python scripts/expand_vehicle_poi.py INPUT.pbf CACHE.json
"""
import json
from pathlib import Path
import sys
import osmium
import build_lviv_poi as base
from data_tool_io import write_files

def candidate(tags):
    return (tags.get('amenity') in {'fuel', 'charging_station'} or
            tags.get('shop') in {'car', 'car_parts', 'tyres', 'car_repair'} or
            tags.get('craft') == 'car_repair' or
            any(k.startswith(('service:vehicle:', 'socket:')) for k in tags) or
            tags.get('charging_station') == 'yes')

if __name__ == '__main__':
    pbf, cache = map(Path, sys.argv[1:3])
    if not cache.exists():
        base.relevant = candidate
        handler = base.Extract()
        handler.apply_file(str(pbf), locations=True, filters=[osmium.filter.KeyFilter(
            'amenity', 'shop', 'craft', 'charging_station', 'socket:type2', 'socket:type2_combo',
            'socket:chademo', 'service:vehicle:car_repair', 'service:vehicle:repair',
            'service:vehicle:tyres', 'service:vehicle:oil_change')])
        with osmium.io.Reader(str(pbf)) as reader:
            snapshot = reader.header().get('osmosis_replication_timestamp')
        write_files({cache: json.dumps({'source': base.SOURCE, 'snapshot': snapshot, 'bbox': base.BBOX,
                     'features': list(handler.features.values()), 'invalid': sorted(handler.invalid)},
                     ensure_ascii=False, separators=(',', ':'))})
    result = json.loads(cache.read_text(encoding='utf-8'))
    known = {f['id'] for f in json.loads(Path('data/lviv-poi.geojson').read_text(encoding='utf-8'))['features']}
    print(json.dumps([{'id': f['id'], 'tags': f['properties']} for f in result['features'] if f['id'] not in known], ensure_ascii=False))
