"""Merge verified vehicle candidates, preserving every existing POI and parking record.
Usage: python scripts/merge_vehicle_poi.py CACHE.json
Classification is shared with poi.js, so browser and offline rules cannot drift.
"""
import collections
import datetime
import json
import os
from pathlib import Path
import subprocess
import sys
import hashlib
import tempfile
from shapely.geometry import shape, mapping, box
from shapely.ops import unary_union
from data_tool_io import write_files

root = Path(__file__).resolve().parents[1]
os.chdir(root)
path = root / 'data/lviv-poi.geojson'
data = json.loads(path.read_text(encoding='utf-8'))
audit_path = root / 'data/lviv-poi-audit.json'
audit = json.loads(audit_path.read_text(encoding='utf-8'))
cache_bytes = Path(sys.argv[1]).read_bytes()
input_hash = hashlib.sha256(cache_bytes).hexdigest()
rules_hash = hashlib.sha256((root / 'poi.js').read_bytes()).hexdigest()
output_hash = hashlib.sha256(path.read_bytes()).hexdigest()
previous = audit.get('vehicleExpansion', {})
if (previous.get('inputSha256') == input_hash and previous.get('rulesSha256') == rules_hash and
        previous.get('outputSha256') == output_hash and previous.get('afterCount') == len(data['features'])):
    print(json.dumps(audit['vehicleExpansion'], ensure_ascii=False)); sys.exit(0)
backup = Path(tempfile.gettempdir()) / f'parking-before-vehicle-{output_hash[:12]}.geojson'
if not backup.exists(): backup.write_bytes(path.read_bytes())
raw = json.loads(cache_bytes.decode('utf-8'))
classification = subprocess.run(['node', '--input-type=module', '-e', '''
import fs from 'node:fs'; import {categoryFor,repairEvidence} from './poi.js';
console.log(JSON.stringify(Object.fromEntries(JSON.parse(fs.readFileSync(0,'utf8')).features.map(f=>[f.id,{category:categoryFor(f.properties),evidence:repairEvidence(f.properties)}]))));
'''], input=json.dumps(raw, ensure_ascii=False), capture_output=True, encoding='utf-8', check=True)
classified = json.loads(classification.stdout)
existing = {f['id']: f for f in data['features']}
if previous and not previous.get('inputSha256') and previous.get('afterCount') == len(existing):
    # Preserve legacy audit history on a no-op run, but do not hide a genuinely new cache.
    accounted = set(existing) | set(data['metadata'].get('osmIdAliases', {})) | {item['id'] for item in previous.get('excluded', [])}
    pending = [id for id, info in classified.items() if info['category'] in {'repair','charging','fuel'} and id not in accounted]
    if not pending:
        print(json.dumps(previous, ensure_ascii=False)); sys.exit(0)
geometries = {f['id']: shape(f['geometry']) for f in raw['features']}
ukraine = unary_union([shape(f['geometry']) for f in json.loads((root/'data/ukraine-boundary.geojson').read_text(encoding='utf-8'))['features']])
region = box(*data['metadata']['bbox'][0])
report = {'source': raw.get('source', data['metadata']['sourceUrl']), 'snapshot': raw.get('snapshot', data['metadata']['snapshot']),
          'inputSha256': input_hash, 'rulesSha256': rules_hash,
          'processedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(),
          'beforeCount': len(existing), 'before': dict(collections.Counter(f['properties']['category'] for f in existing.values())),
          'added': [], 'excluded': [], 'accessNote': 'Missing access is unknown, not public. OSM snapshot, not live operational verification.'}
for f in sorted(raw['features'], key=lambda f: (f['geometry']['type'] == 'Point', f['id'])):
    info = classified[f['id']]
    if info['category'] not in {'repair','charging','fuel'} or f['id'] in existing: continue
    if f['id'] in data['metadata']['osmIdAliases']:
        report['excluded'].append({'id':f['id'],'reason':'Previously verified alias'}); continue
    geom = geometries[f['id']]; point = geom.representative_point()
    if not geom.is_valid or not region.covers(point) or not ukraine.covers(point):
        report['excluded'].append({'id':f['id'],'reason':'Invalid/outside geometry'}); continue
    duplicate = None
    for other in existing.values():
        if other['properties']['category'] != info['category']: continue
        op = other['properties']; og = geometries.get(other['id'],shape(other['geometry']))
        same_name = f['properties'].get('name') and f['properties']['name'] == op.get('name')
        distance = point.distance(shape(other['geometry'])) * 72000
        if (same_name and (og.covers(point) or geom.covers(shape(other['geometry'])) or distance < 20)) or (geom.geom_type != 'Point' and geom.equals(og)):
            duplicate = other['id']; break
    if duplicate:
        report['excluded'].append({'id':f['id'],'reason':'Same named facility / identical geometry','parent':duplicate}); continue
    props = {**f['properties'], 'osmId': f['id'], 'osmType':f['id'].split('/')[0], 'category':info['category'],
             'sourceRecord':'geofabrik', 'sourceSnapshot':report['snapshot'], 'categoryEvidence':info['evidence'] or 'OSM amenity tag'}
    feature = {'type':'Feature','id':f['id'],'geometry':mapping(point),'properties':props}
    existing[f['id']] = feature
    report['added'].append({'id':f['id'],'category':info['category'],'evidence':props['categoryEvidence'],'coordinates':list(point.coords[0]),'access':props.get('access','unknown')})
data['features'] = list(existing.values())
data['metadata']['vehicleExpansionAudit'] = './lviv-poi-audit.json#vehicleExpansion'
report['afterCount'] = len(existing)
report['after'] = dict(collections.Counter(f['properties']['category'] for f in existing.values()))
report['newByCategory'] = dict(collections.Counter(f['category'] for f in report['added']))
payload = json.dumps(data, ensure_ascii=False,separators=(',',':'))
report['outputSha256'] = hashlib.sha256(payload.encode('utf-8')).hexdigest()
if previous:
    audit.setdefault('vehicleExpansionHistory', []).append(previous)
audit['vehicleExpansion'] = report
audit['after'] = report['after']; audit['afterCount'] = report['afterCount']; audit['afterBytes'] = len(payload.encode('utf-8'))
audit['addedOsmIds'] = sorted(set(audit['addedOsmIds']) | {f['id'] for f in report['added']})
audit['newUniqueIds'] = len(audit['addedOsmIds'])
audit['addedByCategory'] = dict(collections.Counter(existing[id]['properties']['category'] for id in audit['addedOsmIds']))
audit['access'] = dict(collections.Counter(f['properties'].get('access','unknown') for f in existing.values()))
audit['unclassifiedCandidates'] = [c for c in audit['unclassifiedCandidates'] if c['id'] not in existing]
coverage = json.loads((root/'data/lviv-poi-coverage.geojson').read_text(encoding='utf-8'))
for c in audit['administrativeCoverage']:
    polygon = shape(next(f for f in coverage['features'] if f['id'] == c['osmId'])['geometry'])
    c['counts'] = dict(collections.Counter(f['properties']['category'] for f in existing.values() if polygon.covers(shape(f['geometry']))))
write_files({path: payload, audit_path: json.dumps(audit,ensure_ascii=False,indent=2)+'\n'})
print(json.dumps(report,ensure_ascii=False))
