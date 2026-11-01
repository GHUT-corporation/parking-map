"""Safe Pages artifact/config audit. Uses fixture keys only, never repository secrets."""
import hashlib
import json
from pathlib import Path
import re
import shlex
import shutil
import subprocess
import tempfile
import yaml

root = Path(__file__).resolve().parents[1]
workflow = yaml.load((root/'.github/workflows/pages.yml').read_text(encoding='utf-8'), Loader=yaml.BaseLoader)
assert workflow['permissions'] == {'contents':'read','pages':'write','id-token':'write'}
steps = workflow['jobs']['deploy']['steps']
prepare = next(s for s in steps if s.get('name') == 'Prepare static site')
assert prepare['env']['MAPTILER_KEY'] == '${{ secrets.MAPTILER_KEY }}'
assert prepare['env']['GEOAPIFY_KEY'] == '${{ secrets.GEOAPIFY_KEY }}'
assert next(s for s in steps if s.get('uses','').startswith('actions/upload-pages-artifact'))['with']['path'] == 'dist'
allowed = {'index.html','styles.css','script.js','poi.js','navigation.js','favicon.ico',
           'data/ukraine-boundary.geojson','data/lviv-poi.geojson','data/lviv-charging-ocm.geojson',
           'data/lviv-poi-audit.json','data/lviv-poi-coverage.geojson'}
with tempfile.TemporaryDirectory(prefix='parking-pages-audit-') as tmp:
    copied = set()
    for line in prepare['run'].splitlines():
        if not line.strip().startswith('cp '): continue
        args = shlex.split(line)
        destination = Path(tmp)/args[-1]
        destination.mkdir(parents=True,exist_ok=True)
        for name in args[1:-1]:
            source = root/name
            target = destination/source.name
            shutil.copyfile(source,target)
            assert hashlib.sha256(source.read_bytes()).digest() == hashlib.sha256(target.read_bytes()).digest()
            copied.add(target.relative_to(Path(tmp)/'dist').as_posix())
    assert copied == allowed
    config = {'mapTilerKey':'fixture-only-map','geoapifyKey':'fixture-only-route'}
    (Path(tmp)/'dist/map-config.js').write_text('window.PARKING_MAP_CONFIG = Object.freeze('+json.dumps(config)+');\n',encoding='utf-8')
    validation = prepare['run'].split("node <<'NODE'\n",1)[1].split('\nNODE',1)[0]
    result = subprocess.run(['node','-e',validation],cwd=tmp,capture_output=True,text=True,check=True)
    assert 'values hidden' in result.stdout
    for relative in allowed:
        assert (Path(tmp)/'dist'/relative).stat().st_size > 0

# Check source literals without displaying suspected values, even on failure.
suspect = []
for name in subprocess.check_output(['git','ls-files','--cached','--others','--exclude-standard'],cwd=root,text=True,encoding='utf-8').splitlines():
    if Path(name).suffix not in {'.js','.mjs','.cjs','.html','.md','.yml','.json'}: continue
    text = (root/name).read_text(encoding='utf-8')
    if re.search(r'''(?:mapTilerKey|geoapifyKey)\s*:\s*["'][A-Za-z0-9_-]{16,}["']''',text): suspect.append(name)
assert not suspect, 'Potential embedded credential literal: filenames only: '+', '.join(suspect)
for match in re.finditer(r'(?:src|href)="(\./[^"?]+)(?:\?[^\"]*)?"',(root/'index.html').read_text(encoding='utf-8')):
    assert (root/match[1]).is_file()
print('Pages audit: PASS (YAML, permissions, secret references, 11 copied assets, fixture config validator, relative paths, no credential literals)')
