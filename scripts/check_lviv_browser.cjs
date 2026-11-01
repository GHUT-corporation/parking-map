// Optional browser QA: install Playwright separately and set PARKING_PLAYWRIGHT_PATH.
// Uses the published MapTiler configuration in memory; routing and Overpass are mocked.
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const { chromium } = require(process.env.PARKING_PLAYWRIGHT_PATH || 'playwright');
const root = path.resolve(__dirname, '..');
const data = JSON.parse(fs.readFileSync(path.join(root, 'data/lviv-poi.geojson')));
const audit = JSON.parse(fs.readFileSync(path.join(root, 'data/lviv-poi-audit.json')));
const fresh = new Set(audit.addedOsmIds);
const keys = ['parking', 'paid', 'charging', 'fuel', 'repair'];
async function poll(page, predicate, arg) {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    const value = await Promise.race([page.evaluate(predicate, arg),
      new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error('Browser data read timed out')), 10000); timer.unref(); })]);
    if (value) return;
    await page.waitForTimeout(150);
  }
  throw new Error('Timed out waiting for map data');
}
let browser, server;
(async () => {
  const published = await fetch('https://ghut-corporation.github.io/parking-map/map-config.js', { signal: AbortSignal.timeout(15000) })
    .then(r => { assert.equal(r.status, 200); return r.text(); });
  const sandbox = { window: {} };
  vm.runInNewContext(published, sandbox);
  const key = sandbox.window.PARKING_MAP_CONFIG?.mapTilerKey;
  assert.ok(key, 'Published MapTiler configuration present');
  server = http.createServer((req, res) => {
    let pathname = decodeURI(new URL(req.url, 'http://localhost').pathname);
    if (!pathname.startsWith('/parking-map/')) { res.writeHead(404); res.end(); return; }
    pathname = pathname.slice('/parking-map'.length);
    if (pathname === '/map-config.js') {
      res.writeHead(200, { 'content-type': 'text/javascript' });
      res.end('window.PARKING_MAP_CONFIG=Object.freeze(' + JSON.stringify({ mapTilerKey: key, geoapifyKey: 'test-only' }) + ');');
      return;
    }
    const file = path.resolve(root, pathname === '/' ? 'index.html' : pathname.slice(1));
    if (!file.startsWith(root + path.sep) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end(); return; }
    let body = fs.readFileSync(file);
    if (pathname === '/script.js') body = Buffer.from(body.toString().replace('const map = new MapLibreMap({', 'const map = window.__parkingTestMap = new MapLibreMap({'));
    const mime = pathname.endsWith('.js') ? 'text/javascript' : pathname.endsWith('.css') ? 'text/css' : /\.(geo)?json$/.test(pathname) ? 'application/json' : pathname === '/' ? 'text/html' : 'application/octet-stream';
    res.writeHead(200, { 'content-type': mime }); res.end(body);
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const url = 'http://127.0.0.1:' + server.address().port + '/parking-map/';
  browser = await chromium.launch({ ...(process.env.PARKING_CHROME_PATH ? { executablePath: process.env.PARKING_CHROME_PATH } : {}), headless: true,
    args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-webgl'] });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, geolocation: { longitude: 24.02, latitude: 49.84, accuracy: 20 }, permissions: ['geolocation'] });
  const page = await ctx.newPage();
  page.setDefaultTimeout(15000);
  let localFetches = 0, overpass = 0, routing = 0, maptilerFailures = 0, tileResponses = 0;
  const errors = [];
  const redact = text => text.replace(/key=[^&\s]+/g, 'key=HIDDEN');
  page.on('pageerror', e => errors.push(redact(e.message)));
  page.on('console', m => { if (m.type() === 'error' && !m.text().includes('502 (Bad Gateway)')) errors.push(redact(m.text())); });
  page.on('request', r => { if (r.url().includes('/data/lviv-poi.geojson')) localFetches++; });
  page.on('response', r => { if (r.url().includes('api.maptiler.com')) { if (r.status() >= 400) maptilerFailures++; if (r.url().includes('.pbf') && r.status() === 200) tileResponses++; } });
  await page.route('https://overpass-api.de/**', r => { overpass++; return r.fulfill({ status: 502, contentType: 'text/plain', body: 'Controlled test: unavailable' }); });
  await page.route('https://api.geoapify.com/v1/routing**', r => {
    routing++;
    const p = new URL(r.request().url()).searchParams.get('waypoints').split('|').map(s => s.split(',').map(Number)).map(([lat, lon]) => [lon, lat]);
    return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ type: 'FeatureCollection', features: [{ type: 'Feature', geometry: { type: 'MultiLineString', coordinates: [p] }, properties: { distance: 4000, time: 600, legs: [] } }] }) });
  });
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__parkingTestMap?.getSource('parking-map-poi-parking'), null, { timeout: 60000 });
  console.log('Map ready; checking categories.');
  assert.equal(localFetches, 0, 'Lazy loading before category click');
  const initial = await page.evaluate(() => ({ center: window.__parkingTestMap.getCenter().toArray(), zoom: window.__parkingTestMap.getZoom() }));
  assert.deepEqual(initial, { center: [24.0297, 49.8397], zoom: 13 });
  const categories = {};
  for (const k of keys) {
    await page.locator('[data-poi="' + k + '"]').click();
    await poll(page, async key => (await window.__parkingTestMap.getSource('parking-map-poi-' + key).getData()).features.length > 0, k);
    categories[k] = await page.evaluate(async key => ({ visible: window.__parkingTestMap.getLayoutProperty('parking-map-poi-' + key, 'visibility'), count: (await window.__parkingTestMap.getSource('parking-map-poi-' + key).getData()).features.length }), k);
    console.log('Category diagnostic:', k, JSON.stringify(categories[k]), await page.locator('#poi-status').innerText());
    assert.equal(categories[k].visible, 'visible'); assert.ok(categories[k].count > 0, k);
  }
  assert.equal(localFetches, 1); assert.equal(overpass, 0);
  console.log('Categories ready; checking new POI popups and mocked routes.');
  const newPoiChecks = [];
  for (const k of keys) {
    // Choose an isolated real marker so an overlapping category cannot capture the click.
    const options = data.features.filter(f => fresh.has(f.properties.osmId) && f.properties.category === k);
    const distance = (a, b) => Math.hypot((a[0] - b[0]) * 72000, (a[1] - b[1]) * 111000);
    const nearest = f => Math.min(...data.features.filter(g => g !== f).map(g => distance(f.geometry.coordinates, g.geometry.coordinates)));
    const f = options.map(feature => ({ feature, isolation: nearest(feature) })).sort((a, b) => b.isolation - a.isolation)[0]?.feature;
    console.log('Checking new POI category:', k);
    assert.ok(f, k + ' has new real object');
    await page.evaluate(p => { window.__parkingTestMap.jumpTo({ center: p, zoom: 17 }); }, f.geometry.coordinates);
    await page.waitForTimeout(1400);
    await poll(page, async ({ k, id }) => (await window.__parkingTestMap.getSource('parking-map-poi-' + k).getData()).features.some(f => f.properties.osmId === id), { k, id: f.properties.osmId });
    const p = await page.evaluate(f => { const m = window.__parkingTestMap, p = m.project(f.geometry.coordinates), b = document.querySelector('#interactive-map').getBoundingClientRect(); return { x: b.left + p.x, y: b.top + p.y }; }, f);
    await page.mouse.click(p.x, p.y);
    await page.locator('.popup-route-button').waitFor({ state: 'visible', timeout: 5000 });
    assert.ok((await page.locator('.poi-popup').innerText()).includes(f.properties.osmId), 'Popup belongs to selected real POI');
    await page.locator('.popup-route-button').click();
    await poll(page, async () => (await window.__parkingTestMap.getSource('navigation-route').getData()).features.length > 0);
    newPoiChecks.push({ category: k, osmId: f.properties.osmId, popup: true, route: true });
    await page.locator('#nav-clear').click();
  }
  // Route fitBounds may reveal territory outside the processed rectangle.
  assert.equal(localFetches, 1);
  const { insideUkraine } = await import('../poi.js');
  const coverage = JSON.parse(fs.readFileSync(path.join(root, 'data/lviv-poi-coverage.geojson')));
  const suburbChecks = [];
  for (const area of coverage.features) {
    console.log('Checking administrative area:', area.properties.name);
    const f = data.features.find(f => insideUkraine(f.geometry.coordinates, area.geometry));
    assert.ok(f, area.properties.name);
    await page.evaluate(p => { window.__parkingTestMap.jumpTo({ center: p, zoom: 16 }); }, f.geometry.coordinates);
    await poll(page, async ({ id, category }) => (await window.__parkingTestMap.getSource('parking-map-poi-' + category).getData()).features.some(f => f.properties.osmId === id), { id: f.properties.osmId, category: f.properties.category });
    suburbChecks.push(area.properties.name);
  }
  await page.evaluate(() => { window.__parkingTestMap.jumpTo({ center: [24.0297, 49.8397], zoom: 13 }); });
  for (const k of keys) {
    await page.locator('[data-poi="' + k + '"]').click();
    const visibility = await page.evaluate(() => Object.fromEntries(['parking', 'paid', 'charging', 'fuel', 'repair'].map(key => [key, window.__parkingTestMap.getLayoutProperty('parking-map-poi-' + key, 'visibility')])));
    assert.equal(visibility[k], 'none'); assert.ok(Object.entries(visibility).every(([other, v]) => other === k || v === 'visible'));
    await page.locator('[data-poi="' + k + '"]').click();
  }
  const zoomChecks = [];
  for (const z of [10, 11, 12, 13]) {
    console.log('Checking zoom:', z);
    await page.evaluate(z => { window.__parkingTestMap.jumpTo({ zoom: z }); }, z); await page.waitForTimeout(900);
    zoomChecks.push(await page.evaluate(() => ({ zoom: window.__parkingTestMap.getZoom(), rendered: Object.fromEntries(['parking', 'paid', 'charging', 'fuel', 'repair'].map(k => [k, window.__parkingTestMap.queryRenderedFeatures({ layers: ['parking-map-poi-' + k] }).length])) })));
  }
  assert.ok(Object.values(zoomChecks[0].rendered).every(n => n === 0));
  assert.equal(zoomChecks[1].rendered.parking, 0); assert.equal(zoomChecks[1].rendered.repair, 0); assert.equal(zoomChecks[2].rendered.parking, 0);
  await page.evaluate(() => { window.__parkingTestMap.jumpTo({ center: [24.34, 49.84], zoom: 13 }); }); await page.waitForTimeout(2000);
  const firstFallback = overpass; assert.ok(firstFallback >= 1);
  for (let i = 0; i < 3; i++) { await page.evaluate(i => { window.__parkingTestMap.jumpTo({ center: [24.34, 49.84 + i * .001], zoom: 13 }); }, i); await page.waitForTimeout(900); }
  assert.equal(overpass, firstFallback, 'No repeat during backoff');
  const failureNotice = await page.locator('#poi-status').innerText(); assert.ok(/Overpass/.test(failureNotice));
  await page.evaluate(() => { window.__parkingTestMap.jumpTo({ center: [24.0297, 49.8397], zoom: 13 }); }); await page.waitForTimeout(1200);
  assert.equal(overpass, firstFallback);
  assert.equal(errors.length, 0, JSON.stringify(errors)); assert.equal(maptilerFailures, 0); assert.ok(tileResponses > 0, 'Real vector tiles downloaded');
  const mobile = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const mp = await mobile.newPage(); let mobileFetch = 0;
  mp.on('request', r => { if (r.url().includes('/data/lviv-poi.geojson')) mobileFetch++; });
  await mp.route('https://overpass-api.de/**', r => r.abort());
  await mp.goto(url, { waitUntil: 'domcontentloaded' });
  await mp.waitForFunction(() => window.__parkingTestMap?.getSource('parking-map-poi-parking'), null, { timeout: 60000 }); assert.equal(mobileFetch, 0);
  for (const k of keys) await mp.locator('[data-poi="' + k + '"]').click(); await mp.waitForTimeout(1800);
  const mobileChecks = await mp.evaluate(async () => ({ overflow: document.documentElement.scrollWidth > innerWidth, mapHeight: Math.round(document.querySelector('.map-viewport').getBoundingClientRect().height), gps: !!document.querySelector('#nav-location'), categories: Object.fromEntries(await Promise.all(['parking', 'paid', 'charging', 'fuel', 'repair'].map(async k => [k, (await window.__parkingTestMap.getSource('parking-map-poi-' + k).getData()).features.length]))) }));
  assert.equal(mobileChecks.overflow, false); assert.ok(mobileChecks.mapHeight >= 380); assert.ok(mobileChecks.gps); assert.equal(mobileFetch, 1); assert.ok(Object.values(mobileChecks.categories).every(n => n > 0));
  console.log(JSON.stringify({ result: 'PASS', initial, categories, newPoiChecks, suburbChecks, zoomChecks,
    requests: { localFetches, overpass, routingMock: routing, realTileResponses: tileResponses, maptilerFailures }, failureNotice, mobile: mobileChecks, errors }, null, 2));
  await mobile.close(); await ctx.close();
})().catch(e => { console.error('TEST FAILED:', e.message.replace(/key=[^&\s]+/g, 'key=HIDDEN')); process.exitCode = 1; })
  .finally(async () => { if (browser) await browser.close(); if (server) await new Promise(r => server.close(r)); });
