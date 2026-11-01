"""Fixture-only regressions. Never reads or writes the real data directory.
Run with the same optional shapely dependency as merge_vehicle_poi.py.
"""
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

from data_tool_io import write_files

SCRIPTS = Path(__file__).resolve().parent


class DataToolTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='parking-data-regression-')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        (self.root/'data').mkdir()
        (self.root/'scripts').mkdir()

    def put(self, name, value):
        (self.root/name).write_text(json.dumps(value), encoding='utf-8')

    def run_script(self, name, *args):
        env = {**os.environ, 'TEMP': str(self.root), 'TMP': str(self.root), 'PYTHONIOENCODING': 'utf-8'}
        executable = 'node' if name.endswith('.cjs') else sys.executable
        return subprocess.run([executable, str(self.root/'scripts'/name), *map(str,args)], cwd=self.root,
                              env=env, encoding='utf-8', capture_output=True, check=True)

    def test_failed_group_write_restores_both_files(self):
        first, second = self.root/'one.json', self.root/'two.json'
        first.write_bytes(b'old one'); second.write_bytes(b'old two')
        original_replace = os.replace
        count = 0
        def fail_second(source, target):
            nonlocal count
            count += 1
            if count == 2:
                raise OSError('controlled second rename failure')
            return original_replace(source,target)
        with patch('data_tool_io.os.replace', side_effect=fail_second):
            with self.assertRaises(OSError):
                write_files({first:'new one', second:'new two'})
        self.assertEqual(first.read_bytes(), b'old one')
        self.assertEqual(second.read_bytes(), b'old two')
        self.assertEqual(len(list(self.root.iterdir())),4)

    def test_changed_cache_is_processed_and_identical_run_is_noop(self):
        for name in ('merge_vehicle_poi.py','data_tool_io.py'):
            shutil.copyfile(SCRIPTS/name,self.root/'scripts'/name)
        (self.root/'poi.js').write_text('export const categoryFor=t=>t.amenity==="fuel"?"fuel":null; export const repairEvidence=()=>null;',encoding='utf-8')
        def feature(number, longitude):
            return {'type':'Feature','id':f'node/{number}','properties':{'osmId':f'node/{number}','amenity':'fuel','category':'fuel'},
                    'geometry':{'type':'Point','coordinates':[longitude,49.8]}}
        self.put('data/lviv-poi.geojson',{'type':'FeatureCollection','metadata':{'sourceUrl':'fixture','snapshot':'2026-10-31','bbox':[[23.75,49.65,24.35,50.05]],'osmIdAliases':{}},'features':[feature(1,24)]})
        self.put('data/lviv-poi-audit.json',{'vehicleExpansion':{'afterCount':1},'addedOsmIds':['node/1'],'administrativeCoverage':[],'unclassifiedCandidates':[]})
        self.put('data/ukraine-boundary.geojson',{'type':'FeatureCollection','features':[{'geometry':{'type':'Polygon','coordinates':[[[23,49],[25,49],[25,51],[23,51],[23,49]]]}}]})
        self.put('data/lviv-poi-coverage.geojson',{'type':'FeatureCollection','features':[]})
        self.put('cache.json',{'features':[feature(1,24)]})
        legacy={name:(self.root/'data'/name).read_bytes() for name in ('lviv-poi.geojson','lviv-poi-audit.json')}
        self.run_script('merge_vehicle_poi.py',self.root/'cache.json')
        self.assertEqual(legacy,{name:(self.root/'data'/name).read_bytes() for name in legacy})
        self.put('cache.json',{'source':'fixture-cache','snapshot':'2026-11-01','features':[feature(2,24.1)]})
        self.run_script('merge_vehicle_poi.py',self.root/'cache.json')
        result=json.loads((self.root/'data/lviv-poi.geojson').read_text())
        self.assertEqual(len(result['features']),2)  # old afterCount=1 must not skip this input
        self.assertEqual(result['features'][1]['properties']['sourceSnapshot'],'2026-11-01')
        self.put('cache.json',{'features':[feature(2,24.1),feature(3,24.2)]})
        self.run_script('merge_vehicle_poi.py',self.root/'cache.json')
        self.assertEqual(len(json.loads((self.root/'data/lviv-poi.geojson').read_text())['features']),3)
        before={name:(self.root/'data'/name).read_bytes() for name in ('lviv-poi.geojson','lviv-poi-audit.json')}
        self.run_script('merge_vehicle_poi.py',self.root/'cache.json')
        self.assertEqual(before,{name:(self.root/'data'/name).read_bytes() for name in before})

    def test_ocm_rejects_duplicate_id_outside_region_and_invalid_dates(self):
        shutil.copyfile(SCRIPTS/'import_ocm.cjs',self.root/'scripts/import_ocm.cjs')
        self.put('data/lviv-poi.geojson',{'metadata':{'bbox':[[23.75,49.65,24.35,50.05]]},'features':[]})
        cache=self.root/'cache'; cache.mkdir()
        self.put('cache/referencedata.json',{'DataProviders':[{'ID':1,'IsOpenDataLicensed':True,'License':'CC BY 4.0'}],'Operators':[],'UsageTypes':[],'ConnectionTypes':[]})
        def station(id, lon=24, lat=49.8, verified='2025-05-01'):
            return {'ID':id,'DataProviderID':1,'StatusTypeID':50,'SubmissionStatusTypeID':200,'DateLastVerified':verified,
                    'AddressInfo':{'Longitude':lon,'Latitude':lat,'Title':'Fixture'},'Connections':[]}
        self.put('cache/lviv-candidates.json',[station(1),station(1,24.3,49.9),station(2,25,52),station(3,verified='2025-not-a-date'),station(4,verified='2999-01-01'),station(5,lon='24'),station(6,lon=24.001)])
        self.run_script('import_ocm.cjs',cache)
        output=json.loads((self.root/'data/lviv-charging-ocm.geojson').read_text(encoding='utf-8'))
        self.assertEqual([f['id'] for f in output['features']],['ocm/1'])
        self.assertEqual(len(output['metadata']['excluded']),6)
        review=next(item for item in output['metadata']['excluded'] if item['id']==6)
        self.assertTrue(review['needsReview'])
        self.assertEqual(review['nearestID'],'ocm/1')
        self.assertIn('not a proven duplicate',review['reason'])
        self.assertEqual(list((self.root/'data').glob('*.tmp')),[])


if __name__=='__main__':
    unittest.main(verbosity=2)
