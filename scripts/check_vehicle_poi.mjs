import fs from 'node:fs';
import assert from 'node:assert/strict';
import { insideUkraine, repairEvidence } from '../poi.js';
const read = n => JSON.parse(fs.readFileSync(new URL('../data/'+n,import.meta.url)));
const main=read('lviv-poi.geojson'), audit=read('lviv-poi-audit.json').vehicleExpansion, external=read('lviv-charging-ocm.geojson');
const boundary=read('ukraine-boundary.geojson').features[0].geometry;
assert.equal(audit.afterCount-audit.beforeCount,audit.added.length);
assert.equal(audit.added.length,26);
for(const record of audit.added){const f=main.features.find(f=>f.id===record.id);assert.ok(f);assert.ok(repairEvidence(f.properties));assert.deepEqual(f.geometry.coordinates,record.coordinates);}
const distance=(a,b)=>Math.hypot((a[0]-b[0])*72000,(a[1]-b[1])*111000);
const known=main.features.filter(f=>f.properties.category==='charging');
const ids=new Set();
for(const f of external.features){
 assert.match(f.id,/^ocm\/\d+$/); assert.ok(!ids.has(f.id));ids.add(f.id);
 assert.equal(f.properties.license,'CC BY 4.0'); assert.ok(f.properties.sourceVerified>='2025-01-01');
 assert.ok(insideUkraine(f.geometry.coordinates,boundary));
 for(const g of known)assert.ok(distance(g.geometry.coordinates,f.geometry.coordinates)>=250);
 known.push(f);
}
assert.equal(external.metadata.reviewed,external.features.length+external.metadata.excluded.length);
assert.equal(external.features.length,5);
console.log(JSON.stringify({result:'PASS',newRepair:audit.added.length,externalCharging:ids.size,totalCharging:known.length,allChargingDistancesAtLeast250m:true}));
