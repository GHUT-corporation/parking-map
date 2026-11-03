"""Targeted offline paid-parking expansion, retaining all existing records.

python scripts/expand_paid_parking.py INPUT.pbf RAW_CACHE.json [--apply]
No network calls. The cache keeps original geometries/tags for review/reproduction.
Only --apply writes production data, after geometry/classification/dedup checks.
"""
import collections
import ctypes
import datetime
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys

import osmium
from shapely.geometry import LineString, shape, mapping
from shapely.ops import unary_union
import build_lviv_poi as base
from data_tool_io import write_files


def local_filename(path):
    path = str(Path(path).resolve())
    # libosmium's Windows native reader needs an ASCII/short path.
    if os.name == 'nt':
        buffer = ctypes.create_unicode_buffer(32768)
        if ctypes.windll.kernel32.GetShortPathNameW(path, buffer, len(buffer)):
            return buffer.value
    return path


def extract(pbf, cache):
    base.relevant = lambda tags: tags.get('amenity') in {'parking', 'parking_space'}

    class ParkingExtract(base.Extract):
        def way(self, obj):
            tags = dict(obj.tags)
            if tags.get('highway') and any(key.startswith(('parking:', 'parking:condition:')) for key in tags):
                try:
                    self.save(f'way/{obj.id}', tags, LineString([(n.lon, n.lat) for n in obj.nodes]), self.features)
                except (ValueError, RuntimeError):
                    self.invalid.add(f'way/{obj.id}')
            elif base.relevant(tags):
                super().way(obj)

    handler = ParkingExtract()
    filename = osmium.io.File(local_filename(pbf), 'pbf')
    keys = ['amenity'] + [f'parking:{side}{suffix}' for side in ('left', 'right', 'both') for suffix in ('', ':fee')] + [f'parking:{prefix}:{side}' for prefix in ('lane', 'condition') for side in ('left', 'right', 'both')]
    handler.apply_file(filename, locations=True, filters=[osmium.filter.KeyFilter(*keys)])
    with osmium.io.Reader(filename) as reader:
        snapshot = reader.header().get('osmosis_replication_timestamp')
    with Path(pbf).open('rb') as stream:
        checksum = hashlib.file_digest(stream, 'sha256').hexdigest()
    raw = {'source': base.SOURCE, 'snapshot': snapshot, 'pbfSha256': checksum, 'extractedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(),
           'bbox': base.BBOX, 'features': list(handler.features.values()), 'invalid': sorted(handler.invalid)}
    write_files({cache: json.dumps(raw, ensure_ascii=False, separators=(',', ':'))})
    return raw


def merge(raw, cache, apply=False):
    root = Path(__file__).resolve().parents[1]
    path, audit_path = root/'data/lviv-poi.geojson', root/'data/lviv-poi-audit.json'
    original = path.read_bytes()
    data = json.loads(original)
    audit = json.loads(audit_path.read_text(encoding='utf-8'))
    classes = subprocess.run(['node', '--input-type=module', '-e', """
import fs from 'node:fs'; import {categoryFor,paidParkingSides} from './poi.js';
console.log(JSON.stringify(Object.fromEntries(JSON.parse(fs.readFileSync(0,'utf8')).features.map(f=>[f.id,{category:categoryFor(f.properties),sides:paidParkingSides(f.properties)}]))));
"""], input=json.dumps(raw, ensure_ascii=False), capture_output=True, encoding='utf-8', cwd=root, check=True)
    classified = json.loads(classes.stdout)
    existing = {f['id']: f for f in data['features']}
    geometries = {f['id']: shape(f['geometry']) for f in raw['features']}
    ukraine = unary_union([shape(f['geometry']) for f in json.loads((root/'data/ukraine-boundary.geojson').read_text(encoding='utf-8'))['features']])
    report = {'source': raw['source'], 'snapshot': raw['snapshot'], 'pbfSha256': raw.get('pbfSha256'), 'extractedAt': raw['extractedAt'], 'license': 'ODbL-1.0',
              'inputSha256': hashlib.sha256(Path(cache).read_bytes()).hexdigest(), 'beforeCount': len(existing),
              'before': dict(collections.Counter(f['properties']['category'] for f in existing.values())), 'added': [], 'excluded': [], 'feeUpdatesForReview': []}
    aliases = data['metadata'].get('osmIdAliases', {})
    for f in sorted(raw['features'], key=lambda f: (f['geometry']['type'] not in {'Polygon', 'MultiPolygon'}, f['id'])):
        info = classified[f['id']]
        if info['category'] != 'paid':
            continue
        if f['id'] in existing:
            if existing[f['id']]['properties']['category'] != 'paid':
                report['feeUpdatesForReview'].append({'id': f['id'], 'tags': f['properties']})
            continue
        if f['id'] in aliases:
            report['excluded'].append({'id': f['id'], 'parent': aliases[f['id']], 'reason': 'Previously verified alias'})
            continue
        geom = geometries[f['id']]
        street = bool(f['properties'].get('highway'))
        point = geom.interpolate(.5, normalized=True) if street else geom.representative_point()
        if not geom.is_valid or geom.is_empty or not base.REGION.covers(geom) or not ukraine.covers(geom):
            report['excluded'].append({'id': f['id'], 'reason': 'Invalid or partly outside processed region/Ukraine'})
            continue
        duplicate = None
        for other in existing.values():
            op = other['properties']
            if op['category'] not in {'paid', 'parking'}:
                continue
            og = geometries.get(other['id'], shape(other['geometry']))
            same_name = bool(f['properties'].get('name')) and f['properties']['name'] == op.get('name')
            polygon = og.geom_type in {'Polygon', 'MultiPolygon'}
            nested_space = f['properties'].get('amenity') == 'parking_space' and polygon and og.covers(geom)
            same_representation = not street and (geom.equals(og) or (same_name and ((polygon and og.covers(geom)) or (geom.geom_type in {'Polygon','MultiPolygon'} and geom.covers(og)))))
            # A street segment wholly inside a separately mapped parking facility
            # cannot safely be counted again. Partial overlap needs manual review.
            street_overlap = street and ((polygon and geom.intersects(og)) or
                (op.get('highway') and geom.intersection(og).length > 1e-9))
            if nested_space or same_representation or street_overlap:
                duplicate = other['id']
                break
        if duplicate:
            report['excluded'].append({'id': f['id'], 'parent': duplicate, 'reason': 'Nested space / same facility / street intersects separately mapped facility; no extra marker'})
            continue
        coordinates = [round(n, 7) for n in point.coords[0]]
        evidence = '; '.join(s['evidence'] for s in info['sides']) if street else f"fee={f['properties'].get('fee', '')}; charge={f['properties'].get('charge', '')}"
        props = {**f['properties'], 'osmId': f['id'], 'osmType': f['id'].split('/')[0], 'category': 'paid',
                 'sourceRecord': 'geofabrik', 'sourceSnapshot': raw['snapshot'], 'categoryEvidence': evidence}
        existing[f['id']] = {'type': 'Feature', 'id': f['id'], 'geometry': {'type': 'Point', 'coordinates': coordinates}, 'properties': props}
        report['added'].append({'id': f['id'], 'coordinates': coordinates, 'evidence': evidence, 'streetSegment': street,
                                'sourceGeometry': mapping(geom), 'access': props.get('access', 'unknown')})
    report['afterCount'] = len(existing)
    report['after'] = dict(collections.Counter(f['properties']['category'] for f in existing.values()))
    write_files({Path(cache).with_suffix('.review.json'): json.dumps(report, ensure_ascii=False, indent=2)+'\n'})
    if apply and report['added']:
        backup = root/'.local-cache'/f'parking-before-paid-{hashlib.sha256(original).hexdigest()[:12]}.geojson'
        backup.parent.mkdir(exist_ok=True)
        if not backup.exists():
            backup.write_bytes(original)
        data['features'] = list(existing.values())
        data['metadata']['paidExpansionAudit'] = './lviv-poi-audit.json#paidExpansion'
        payload = json.dumps(data, ensure_ascii=False, separators=(',', ':'))
        if audit.get('paidExpansion'):
            audit.setdefault('paidExpansionHistory', []).append(audit['paidExpansion'])
        audit['paidExpansion'] = report
        audit.update(after=report['after'], afterCount=report['afterCount'], afterBytes=len(payload.encode('utf-8')))
        audit['addedOsmIds'] = sorted(set(audit['addedOsmIds']) | {f['id'] for f in report['added']})
        audit['newUniqueIds'] = len(audit['addedOsmIds'])
        audit['addedByCategory'] = dict(collections.Counter(existing[id]['properties']['category'] for id in audit['addedOsmIds']))
        audit['access'] = dict(collections.Counter(f['properties'].get('access', 'unknown') for f in existing.values()))
        audit['standaloneSpaces'] = sum(f['properties'].get('amenity') == 'parking_space' for f in existing.values())
        audit['streetWaysNotConvertedToMarkers'] = [id for id in audit['streetWaysNotConvertedToMarkers'] if f'way/{id}' not in existing]
        coverage = json.loads((root/'data/lviv-poi-coverage.geojson').read_text(encoding='utf-8'))
        for c in audit['administrativeCoverage']:
            polygon = shape(next(f for f in coverage['features'] if f['id'] == c['osmId'])['geometry'])
            c['counts'] = dict(collections.Counter(f['properties']['category'] for f in existing.values() if polygon.covers(shape(f['geometry']))))
        write_files({path: payload, audit_path: json.dumps(audit, ensure_ascii=False, indent=2)+'\n'})
    print(json.dumps({k: v for k, v in report.items() if k not in {'added', 'excluded', 'feeUpdatesForReview'}}, ensure_ascii=False))
    print(json.dumps({'newRecords': len(report['added']), 'excluded': len(report['excluded']), 'feeUpdatesForReview': report['feeUpdatesForReview'],
                      'applied': bool(apply and report['added'])}, ensure_ascii=False))


if __name__ == '__main__':
    pbf, cache = map(Path, sys.argv[1:3])
    raw = json.loads(cache.read_text(encoding='utf-8')) if cache.exists() else extract(pbf, cache)
    merge(raw, cache, '--apply' in sys.argv)
