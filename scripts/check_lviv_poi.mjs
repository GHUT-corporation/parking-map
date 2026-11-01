// Data invariants against the real snapshot, without network requests or API keys.
// Run: node scripts/check_lviv_poi.mjs
import assert from "node:assert/strict";
import { readFileSync, statSync } from "node:fs";
import { CATEGORIES, categoryFor, isPaidParking, insideUkraine, boundsCovered, toFeatures } from "../poi.js";

const read = (name) => JSON.parse(readFileSync(new URL(`../data/${name}`, import.meta.url), "utf8"));
const data = read("lviv-poi.geojson");
const audit = read("lviv-poi-audit.json");
const coverage = read("lviv-poi-coverage.geojson");
const ukraine = read("ukraine-boundary.geojson").features[0].geometry;
const ids = new Set();
const counts = Object.fromEntries(Object.keys(CATEGORIES).map((key) => [key, 0]));
for (const feature of data.features) {
  const { osmId, category } = feature.properties;
  assert.match(osmId, /^(node|way|relation)\/\d+$/);
  assert.equal(ids.has(osmId), false, `Duplicate ${osmId}`);
  ids.add(osmId);
  assert.equal(feature.id, osmId);
  assert.equal(feature.geometry.type, "Point");
  assert.equal(feature.geometry.coordinates.length, 2);
  assert.ok(feature.geometry.coordinates.every(Number.isFinite));
  assert.ok(insideUkraine(feature.geometry.coordinates, ukraine), osmId);
  assert.equal(categoryFor(feature.properties), category, osmId);
  counts[category]++;
}
assert.deepEqual(counts, Object.fromEntries(Object.keys(CATEGORIES).map((key) => [key, audit.after[key]])));
assert.equal(ids.size, audit.afterCount);
assert.equal(audit.newUniqueIds, audit.addedOsmIds.length);
assert.equal(new Set(audit.addedOsmIds).size, audit.newUniqueIds);
assert.equal(audit.retainedPreviousIds + audit.newUniqueIds, ids.size);
assert.equal(audit.retainedPreviousIds + audit.removedPreviousIds.length, audit.beforeCount);
assert.equal(Object.values(audit.addedByCategory).reduce((sum, n) => sum + n, 0), audit.newUniqueIds);
for (const { id, after } of audit.categoryChanges) assert.equal(data.features.find(f => f.id === id).properties.category, after);
assert.ok(audit.addedOsmIds.every((id) => ids.has(id)));
assert.equal(statSync(new URL("../data/lviv-poi.geojson", import.meta.url)).size, audit.afterBytes);
assert.equal(audit.invalidGeometryIds.length, 0);
assert.equal(coverage.features.length, 8);
assert.ok(audit.administrativeCoverage.every((item) => item.fullyInsideProcessedRegion));
for (const boundary of coverage.features) {
  const actual = {};
  for (const feature of data.features) {
    if (insideUkraine(feature.geometry.coordinates, boundary.geometry)) {
      const category = feature.properties.category;
      actual[category] = (actual[category] || 0) + 1;
    }
  }
  assert.deepEqual(actual, audit.administrativeCoverage.find((item) => item.osmId === boundary.id).counts);
}
assert.equal(new Set(audit.nestedSpaces.map((item) => item.id)).size, audit.nestedSpaces.length);
for (const { id, parent } of [...audit.nestedSpaces, ...audit.duplicates]) {
  assert.equal(ids.has(id), false);
  assert.ok(ids.has(parent), parent);
}
for (const id of audit.removedPreviousIds) assert.ok(audit.duplicates.some((item) => item.id === id));
for (const { id, parent } of audit.duplicates) assert.equal(data.metadata.osmIdAliases[id], parent);
assert.equal(data.features.filter((item) => item.properties.amenity === "parking_space").length, audit.standaloneSpaces);
// An unknown or conditional fee must not become "free" or definitely paid.
for (const tags of [{}, { fee: "no" }, { fee: "donation" }, { fee: "Per month" }, { "fee:conditional": "yes @ (Mo-Fr)", charge: "20 UAH" }, { charge: "0 UAH" }]) {
  assert.equal(isPaidParking(tags), false);
}
for (const tags of [{ fee: "yes" }, { fee: "8 UAH per day" }, { charge: "20 UAH/hour" }, { charge: "2,50 EUR" }]) assert.equal(isPaidParking(tags), true);
assert.equal(categoryFor({ amenity: "parking", access: "private" }), "parking");
assert.equal(categoryFor({ shop: "tyres" }), null);
assert.equal(categoryFor({ shop: "tyres", "service:vehicle:tyres": "yes" }), null);
assert.equal(categoryFor({ shop: "tyres", "service:vehicle:tyres_repair": "yes" }), "repair");
const bounds = ([w, s, e, n]) => ({ getWest: () => w, getSouth: () => s, getEast: () => e, getNorth: () => n });
assert.ok(boundsCovered(bounds([23.76, 49.66, 24.34, 50.04]), data.metadata.bbox));
assert.equal(boundsCovered(bounds([23.74, 49.66, 24.34, 50.04]), data.metadata.bbox), false);
assert.equal(boundsCovered(bounds([23.76, 49.66, 24.36, 50.04]), data.metadata.bbox), false);
// Live node/way/relation normalization must use centers and keep type/id namespaces.
const elements = [
  { type: "node", id: 1, lon: 24.02, lat: 49.84, tags: { amenity: "fuel" } },
  { type: "way", id: 1, center: { lon: 24.02, lat: 49.84 }, tags: { amenity: "fuel" } },
  { type: "relation", id: 1, center: { lon: 24.02, lat: 49.84 }, tags: { amenity: "fuel" } },
];
assert.equal(toFeatures([...elements, ...elements], "fuel", ukraine).features.length, 3);
assert.equal(toFeatures([{ type: "node", id: 2, tags: { amenity: "fuel" } }], "fuel", ukraine).features.length, 0);
console.log(JSON.stringify({ result: "PASS", unique: ids.size, newOsmIds: audit.newUniqueIds, categories: counts,
  nestedSpacesSuppressed: audit.nestedSpaces.length, administrativePolygons: coverage.features.length }));
