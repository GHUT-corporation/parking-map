// Actual regional data plus documented street-parking semantics; no network/API keys.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { categoryFor, isPaidParking, paidParkingSides, insideUkraine } from '../poi.js';
const read = name => JSON.parse(fs.readFileSync(new URL('../data/'+name,import.meta.url),'utf8'));
const data=read('lviv-poi.geojson'),audit=read('lviv-poi-audit.json').paidExpansion;
const ukraine=read('ukraine-boundary.geojson').features[0].geometry;
const street=extra=>({highway:'residential',...extra});
for(const tags of [street({fee:'yes'}),street({'parking:right':'separate','parking:right:fee':'yes'}),street({'parking:right':'no','parking:right:fee':'yes'}),street({'parking:right':'lane','parking:right:fee':'no'}),street({'parking:right':'lane','parking:right:fee:conditional':'yes @ (Mo-Fr)'}),street({'parking:lane:right':'parallel','parking:condition:right':'residents'}),street({'parking:lane:right':'parallel','parking:condition:right':'ticket','parking:condition:right:time_interval':'Mo-Fr 09:00-18:00','parking:condition:right:default':'free'})]) {
  assert.equal(isPaidParking(tags),false,JSON.stringify(tags));
  assert.equal(categoryFor(tags),null);
}
for(const tags of [street({'parking:right':'lane','parking:right:fee':'yes'}),street({'parking:lane:left':'parallel','parking:condition:left':'ticket'}),street({'parking:lane:both':'parallel','parking:condition:both':'ticket;residents'})])assert.equal(categoryFor(tags),'paid');
assert.deepEqual(paidParkingSides(street({'parking:both':'lane','parking:both:fee':'yes','parking:left:fee':'no'})).map(s=>s.side),['right'],'Side-specific fee overrides both');
assert.deepEqual(paidParkingSides(street({'parking:both':'lane','parking:both:fee':'yes','parking:left':'separate'})).map(s=>s.side),['right'],'Separately mapped side is not counted');
assert.equal(categoryFor({amenity:'parking',fee:'no',charge:'40 UAH/hour'}),'parking');
assert.equal(categoryFor({amenity:'parking'}),'parking');
assert.equal(categoryFor(street({amenity:'charging_station','parking:right':'lane','parking:right:fee':'yes'})),'charging','Street parking tags cannot reclassify another POI category');
assert.equal(audit.before.paid,106);
assert.equal(audit.added.length,31);
assert.equal(audit.after.paid,137);
assert.equal(audit.afterCount-audit.beforeCount,audit.added.length);
assert.match(audit.pbfSha256,/^[a-f0-9]{64}$/);
assert.equal(new Set(audit.added.map(f=>f.id)).size,audit.added.length);
for(const item of audit.added){
  const feature=data.features.find(f=>f.id===item.id);assert.ok(feature,item.id);
  assert.equal(categoryFor(feature.properties),'paid');
  assert.equal(feature.properties.sourceSnapshot,audit.snapshot);
  assert.equal(feature.properties.categoryEvidence,item.evidence);
  assert.deepEqual(feature.geometry.coordinates,item.coordinates);
  assert.equal(item.sourceGeometry.type,'LineString');
  assert.ok(item.sourceGeometry.coordinates.length>=2);
  assert.ok(item.sourceGeometry.coordinates.every(p=>p.length===2&&p.every(Number.isFinite)&&insideUkraine(p,ukraine)));
  assert.ok(insideUkraine(item.coordinates,ukraine));
  assert.equal(item.streetSegment,true);
  assert.ok(paidParkingSides(feature.properties).length>0);
  assert.equal(Object.hasOwn(feature.properties,'demoSelected'),false,'User selection never enters source data');
}
assert.ok(audit.excluded.every(item=>!data.features.some(f=>f.id===item.id)));
const coverage=read('lviv-poi-audit.json').administrativeCoverage;
assert.equal(coverage.find(c=>c.name==='Львів').counts.paid, data.features.filter(f=>f.properties.category==='paid'&&insideUkraine(f.geometry.coordinates,read('lviv-poi-coverage.geojson').features.find(b=>b.properties.name==='Львів').geometry)).length);
console.log(JSON.stringify({result:'PASS',paidBefore:audit.before.paid,newStreetSegments:audit.added.length,paidAfter:audit.after.paid,sourceSnapshot:audit.snapshot,excludedOverlaps:audit.excluded.length}));
