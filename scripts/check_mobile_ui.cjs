// Optional QA: Playwright + Chrome, real MapTiler/POI, controlled routing and GPS.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const vm = require('node:vm');
const { execFileSync } = require('node:child_process');
const assert = require('node:assert/strict');
const { chromium } = require(process.env.PARKING_PLAYWRIGHT_PATH || 'playwright');
const root = path.resolve(__dirname, '..');
const output = process.env.PARKING_SCREENSHOT_DIR || path.join(os.tmpdir(), 'parking-mobile-ui');
const keys = ['parking', 'paid', 'charging', 'fuel', 'repair'];
const data = JSON.parse(fs.readFileSync(path.join(root, 'data/lviv-poi.geojson')));
const redact = text => text.replace(/(?:api)?key=[^&\s]+/gi, 'key=HIDDEN');
async function until(page, fn, arg) {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    if (await page.evaluate(fn, arg)) return;
    await page.waitForTimeout(120);
  }
  throw new Error('Timed out waiting for UI state');
}
let browser, server;
(async () => {
  fs.mkdirSync(output, { recursive: true });
  const published = await fetch('https://ghut-corporation.github.io/parking-map/map-config.js', { signal: AbortSignal.timeout(15000) }).then(r => { assert.equal(r.status, 200); return r.text(); });
  const sandbox = { window: {} }; vm.runInNewContext(published, sandbox);
  const mapTilerKey = sandbox.window.PARKING_MAP_CONFIG?.mapTilerKey;
  assert.ok(mapTilerKey);
  const baseline = Object.fromEntries(['index.html', 'styles.css', 'script.js', 'navigation.js'].map(name => [name, execFileSync('git', ['show', 'HEAD:' + name], { cwd: root })]));
  server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const base = url.pathname.startsWith('/baseline/') ? '/baseline/' : '/parking-map/';
    if (!url.pathname.startsWith(base)) { res.writeHead(404); res.end(); return; }
    const name = decodeURI(url.pathname.slice(base.length)) || 'index.html';
    if (name === 'map-config.js') { res.writeHead(200, { 'content-type': 'text/javascript' }); res.end('window.PARKING_MAP_CONFIG=' + JSON.stringify({ mapTilerKey, geoapifyKey: 'test-only' }) + ';'); return; }
    const file = path.resolve(root, name);
    if (!file.startsWith(root + path.sep) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end(); return; }
    let content = base === '/baseline/' && baseline[name] ? baseline[name] : fs.readFileSync(file);
    if (name === 'script.js') content = Buffer.from(content.toString().replace('const map = new MapLibreMap({', 'const map = window.__map = new MapLibreMap({'));
    res.writeHead(200, { 'content-type': name.endsWith('.js') ? 'text/javascript' : name.endsWith('.css') ? 'text/css' : /\.(geo)?json$/.test(name) ? 'application/json' : name.endsWith('.html') ? 'text/html' : 'application/octet-stream' }); res.end(content);
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const origin = 'http://127.0.0.1:' + server.address().port;
  browser = await chromium.launch({ ...(process.env.PARKING_CHROME_PATH ? { executablePath: process.env.PARKING_CHROME_PATH } : {}), headless: true, args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-webgl'] });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, reducedMotion: 'reduce' });
  await context.addInitScript(() => {
    window.__gps = { requests: 0, watches: 0, clears: 0 };
    const position = () => ({ coords: { longitude: 24.0297, latitude: 49.8397, accuracy: 12, speed: 0, heading: null }, timestamp: Date.now() });
    Object.defineProperty(navigator, 'geolocation', { value: {
      getCurrentPosition(ok, fail) { window.__gps.requests++; setTimeout(() => window.__denyGPS ? fail({ code: 1 }) : ok(position()), 0); },
      watchPosition(ok) { window.__gps.watches++; setTimeout(() => ok(position()), 0); return 17; },
      clearWatch() { window.__gps.clears++; },
    } });
  });
  const page = await context.newPage(); page.setDefaultTimeout(15000);
  const errors = [], warnings = []; let localRequests = 0, routeRequests = 0, overpassRequests = 0, routingStatus = 200;
  page.on('pageerror', error => errors.push(redact(error.message)));
  page.on('console', msg => { if (msg.type() === 'error') errors.push(redact(msg.text())); if(msg.type()==='warning')warnings.push(redact(msg.text())); });
  page.on('request', r => { if (r.url().includes('/data/lviv-poi.geojson')) localRequests++; });
  await context.route('https://overpass-api.de/**', r => { overpassRequests++; return r.fulfill({ status: 200, contentType: 'application/json', body: '{"elements":[]}' }); });
  await context.route('https://api.geoapify.com/v1/routing**', r => {
    routeRequests++;
    if (routingStatus !== 200) return r.fulfill({ status: routingStatus, contentType: 'application/json', body: '{}' });
    const params = new URL(r.request().url()).searchParams;
    assert.equal(params.get('lang'), 'uk'); assert.equal(params.get('details'), 'instruction_details,route_details');
    const [a, b] = params.get('waypoints').split('|').map(s => s.split(',').map(Number)).map(([lat, lon]) => [lon, lat]);
    const turn = [a[0], b[1]];
    return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ type: 'FeatureCollection', features: [{ type: 'Feature', geometry: { type: 'MultiLineString', coordinates: [[a, turn, b]] }, properties: { distance: 1200, time: 360, legs: [{ steps: [
      { from_index: 0, to_index: 1, name: 'вулиця Івана Франка', instruction: { type: 'StartAt', text: 'Рухайтеся прямо.' } },
      { from_index: 1, to_index: 2, name: 'вулиця Князя Романа', instruction: { type: 'Right', streets: ['вулиця Князя Романа'], text: 'Поверніть праворуч на вулицю Князя Романа.' } },
    ] }] } }] }) });
  });
  await page.goto(origin + '/parking-map/', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !!window.__map?.getSource('parking-map-poi-parking'), null, { timeout: 60000 });
  assert.equal((await page.evaluate(() => window.__gps.requests)), 0, 'No automatic GPS');
  const boxes = () => Object.fromEntries(['.map-panel', '.tools-panel', '.safety-alert'].map(s => { const r = document.querySelector(s).getBoundingClientRect(); return [s, { x: r.x, y: r.y, width: r.width, height: r.height }]; }));
  const paints = () => window.__map.getStyle().layers.filter(l => l.source === 'maptiler_planet_v4').map(l => ({ id: l.id, colors: ['fill-color', 'fill-outline-color', 'fill-extrusion-color', 'line-color', 'text-color', 'text-halo-color', 'line-width'].map(p => l.paint?.[p] ?? null) }));
  const widths = [];
  for (const width of [320, 360, 375, 390, 430, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 844 });
    await until(page, () => Math.abs(document.querySelector('.map-viewport').getBoundingClientRect().width - document.querySelector('.maplibregl-canvas').getBoundingClientRect().width) <= 2);
    const state = await page.evaluate(() => {
      const rect = s => { const r = document.querySelector(s).getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; };
      return { overflow: document.documentElement.scrollWidth > innerWidth, map: rect('.map-panel'), viewport: rect('.map-viewport'), canvas: rect('.maplibregl-canvas'), dock: rect('.tools-panel'), labelsHidden: [...document.querySelectorAll('.tool-label')].every(e => getComputedStyle(e).display === 'none'), buttons: [...document.querySelectorAll('[data-poi]')].map(e => ({ label: e.getAttribute('aria-label'), y: e.getBoundingClientRect().y, h: e.getBoundingClientRect().height })), compass: getComputedStyle(document.querySelector('#map-compass')).display !== 'none' };
    });
    assert.equal(state.overflow, false); assert.equal(state.buttons.length, 5);
    assert.ok(Math.abs(state.viewport.w - state.canvas.w) <= 2, 'Canvas fills viewport at ' + width);
    if (width <= 768) { assert.equal(state.map.w, width); assert.equal(state.map.h, 844); assert.ok(state.labelsHidden && state.compass); assert.equal(new Set(state.buttons.map(b => b.y)).size, 1); assert.ok(state.buttons.every(b => b.h >= 44 && b.label)); }
    else {
      assert.equal(state.labelsHidden, false); assert.equal(state.compass, false);
      const old = await context.newPage(); await old.setViewportSize({ width, height: 844 });
      await old.goto(origin + '/baseline/', { waitUntil: 'domcontentloaded' });
      await old.waitForFunction(() => !!window.__map?.getSource('parking-map-poi-parking'), null, { timeout: 60000 });
      assert.deepEqual(await page.evaluate(boxes), await old.evaluate(boxes), 'Desktop boxes equal HEAD at ' + width);
      assert.deepEqual(await page.evaluate(paints), await old.evaluate(paints), 'Desktop map paints restored at ' + width); await old.close();
    }
    widths.push({ width, mobile: state.compass, mapHeight: state.map.h, horizontalOverflow: state.overflow });
  }
  await page.setViewportSize({ width: 390, height: 844 });
  for (const k of keys) {
    await page.locator('[data-poi="' + k + '"]').click();
    await until(page, async key => (await window.__map.getSource('parking-map-poi-' + key).getData()).features.length > 0, k);
    await page.locator('[data-poi="' + k + '"]').click();
    assert.equal(await page.evaluate(k => window.__map.getLayoutProperty('parking-map-poi-' + k, 'visibility'), k), 'none');
    await page.locator('[data-poi="' + k + '"]').click();
  }
  assert.equal(localRequests, 1); assert.equal(overpassRequests, 0);
  const external = JSON.parse(fs.readFileSync(path.join(root, 'data/lviv-charging-ocm.geojson')));
  for (const [index, feature] of external.features.entries()) {
    await page.evaluate(p => { window.__map.jumpTo({ center: p, zoom: 17 }); }, feature.geometry.coordinates);
    await until(page, async id => (await window.__map.getSource('parking-map-poi-charging').getData()).features.some(f => f.id === id), feature.id);
    await page.waitForTimeout(300);
    const point = await page.evaluate(p => { const q = window.__map.project(p); return { x: q.x, y: q.y }; }, feature.geometry.coordinates);
    await page.mouse.click(point.x, point.y);
    assert.ok((await page.locator('.poi-popup').innerText()).includes('Open Charge Map'));
    if (index === 0) {
      await page.locator('.popup-route-button').click();
      await until(page, () => document.querySelector('.workspace').dataset.navigationState === 'ready');
      await page.locator('#nav-clear').click();
    }
  }
  await page.locator('#nav-location').click(); await until(page, () => !!document.querySelector('.navigation-arrow'));
  await page.evaluate(() => { window.__map.jumpTo({ center: [24.0297, 49.8397], zoom: 14, bearing: 75 }); });
  assert.equal(await page.locator('#map-compass').evaluate(e => e.style.getPropertyValue('--north-angle')), '-75deg');
  await page.locator('#map-compass').click(); await until(page, () => Math.abs(window.__map.getBearing()) < .01);
  await until(page, () => document.querySelector('#poi-status').textContent.includes('Львів · OSM'));
  await page.screenshot({ path: path.join(output, 'mobile-map.png') });
  const f = data.features.find(f => f.properties.category === 'parking' && f.geometry.coordinates[0] > 24.04 && f.geometry.coordinates[0] < 24.06 && f.geometry.coordinates[1] > 49.845 && f.geometry.coordinates[1] < 49.855);
  assert.ok(f);
  await page.evaluate(p => { window.__map.jumpTo({ center: p, zoom: 17 }); }, f.geometry.coordinates);
  await until(page, async id => (await window.__map.getSource('parking-map-poi-parking').getData()).features.some(f => f.properties.osmId === id), f.properties.osmId);
  await page.waitForTimeout(300);
  const point = await page.evaluate(p => { const q = window.__map.project(p); return { x: q.x, y: q.y }; }, f.geometry.coordinates);
  await page.mouse.click(point.x, point.y);
  await page.locator('.popup-route-button').click();
  await until(page, () => document.querySelector('.workspace').dataset.navigationState === 'ready');
  assert.equal(await page.locator('#nav-street').innerText(), 'вулиця Князя Романа');
  assert.equal(await page.locator('#nav-maneuver').innerText(), '↱');
  assert.ok((await page.locator('#nav-next').innerText()).includes('Поверніть праворуч'));
  assert.match(await page.locator('#nav-turn-distance').innerText(), /м|км/);
  await page.locator('.mobile-tools-toggle').click();
  assert.equal(await page.locator('[data-poi]:visible').count(), 5);
  await page.setViewportSize({width:320,height:844});
  await until(page, () => document.querySelector('.tools-panel').getBoundingClientRect().width >= 246);
  const compactButtons = await page.locator('[data-poi]').evaluateAll(buttons => buttons.map(b => ({width:b.getBoundingClientRect().width,height:b.getBoundingClientRect().height})));
  assert.ok(compactButtons.every(b => b.width >= 44 && b.height >= 44), 'Expanded categories have 44px touch targets at 320px: '+JSON.stringify(compactButtons));
  await page.setViewportSize({width:390,height:844});
  await page.locator('.mobile-tools-toggle').click();
  await page.waitForTimeout(700);
  await page.screenshot({ path: path.join(output, 'mobile-route-ready.png') });
  await page.locator('#nav-start').click();
  await until(page, () => document.querySelector('.workspace').dataset.navigationState === 'navigating');
  assert.equal((await page.evaluate(() => window.__gps.watches)), 1);
  // Force full base-style replacement twice while navigation is active.
  await page.evaluate(async () => {
    const key=window.PARKING_MAP_CONFIG.mapTilerKey;
    const response=await fetch('https://api.maptiler.com/maps/streets-v4/style.json?key='+encodeURIComponent(key));
    if(!response.ok)throw new Error('Test base style unavailable');
    window.__auditBaseStyle=await response.json();
  });
  for(let pass=0;pass<2;pass++){
    await page.evaluate(() => { window.__map.setStyle(window.__auditBaseStyle,{diff:false}); });
    await until(page, () => !!window.__map.getSource('navigation-route') && !!window.__map.getSource('parking-map-poi-charging'));
    await until(page, async () => (await window.__map.getSource('navigation-route').getData()).features.length>0);
    assert.equal(await page.locator('[data-poi].active').count(),5);
    assert.equal((await page.evaluate(() => window.__gps.watches)),1);
    assert.equal(localRequests,1);
  }
  const routesBeforeResize = routeRequests;
  for (const size of [{ width: 844, height: 390 }, { width: 1440, height: 844 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(size); await page.waitForTimeout(250);
    assert.equal(await page.evaluate(() => document.querySelector('.workspace').dataset.navigationState), 'navigating');
  }
  assert.equal(routeRequests, routesBeforeResize); assert.equal(localRequests, 1);
  assert.equal(await page.locator('.maplibregl-canvas').count(), 1);
  const layerIds = await page.evaluate(() => window.__map.getStyle().layers.map(l => l.id));
  assert.equal(new Set(layerIds).size, layerIds.length);
  await page.waitForTimeout(700);
  await page.screenshot({ path: path.join(output, 'mobile-navigation.png') });
  await page.locator('#nav-clear').click();
  assert.equal(await page.evaluate(() => document.querySelector('.workspace').dataset.navigationState), 'browse');
  assert.equal((await page.evaluate(() => window.__gps.clears)), 1);
  assert.equal(await page.locator('[data-poi].active').count(), 5);
  assert.equal(await page.locator('[data-poi]:visible').count(), 5);
  await page.evaluate(() => { window.__denyGPS = true; }); await page.locator('#nav-location').click();
  await until(page, () => document.querySelector('#nav-status').textContent.includes('відхилено'));
  assert.deepEqual(errors, []);
  assert.ok(warnings.every(w => !/Expected value|could not be loaded|SDF/i.test(w)), 'No style expression / sprite / SDF warnings: '+JSON.stringify(warnings));
  // Real local paid POIs + actual MapLibre circles/popup; only GPS/routing are controlled.
  const { demoOccupancyIds } = await import('../poi.js');
  const occupiedPaid = demoOccupancyIds(data.features.filter(feature => feature.properties.category === 'paid').map(feature => feature.id));
  const paid = data.features.filter(f => f.properties.category === 'paid' && !occupiedPaid.has(f.id) && f.geometry.coordinates[0] > 24.01 && f.geometry.coordinates[0] < 24.07 && f.geometry.coordinates[1] > 49.82 && f.geometry.coordinates[1] < 49.86);
  assert.ok(paid.length >= 2);
  const openPaid = async feature => {
    await page.waitForTimeout(350);
    await page.evaluate(p => { window.__map.resize(); window.__map.jumpTo({center:p,zoom:17}); }, feature.geometry.coordinates);
    await until(page,()=>Math.abs(window.__map.getCanvas().getBoundingClientRect().width-window.__map.getContainer().getBoundingClientRect().width)<2);
    await until(page, async id => (await window.__map.getSource('parking-map-poi-paid').getData()).features.some(f=>f.properties.osmId===id), feature.id);
    await until(page, p => window.__map.queryRenderedFeatures(window.__map.project(p),{layers:['parking-map-poi-paid']}).length > 0, feature.geometry.coordinates);
    const point = await page.evaluate(p => { const q=window.__map.project(p),r=window.__map.getCanvas().getBoundingClientRect();return{x:q.x+r.left,y:q.y+r.top}; },feature.geometry.coordinates);
    await page.mouse.click(point.x,point.y);
    await page.locator('.poi-popup').waitFor();
  };
  const selected = async () => page.evaluate(async () => (await window.__map.getSource('parking-map-poi-paid').getData()).features.filter(f=>f.properties.demoSelected).map(f=>f.id));
  const confirmBooking = async () => { await page.getByRole('button',{name:'Забронювати',exact:true}).click();await page.getByRole('button',{name:'Підтвердити демо-вибір',exact:true}).click(); };
  await page.evaluate(() => { window.__denyGPS = false; });
  for (const width of [1440,390,320]) {
    await page.setViewportSize({width,height:844});
    await openPaid(paid[0]);
    const routes=routeRequests;
    await page.getByRole('button',{name:'Забронювати',exact:true}).click();
    assert.equal(routeRequests,routes);
    assert.ok((await page.locator('.popup-booking-confirmation').innerText()).includes('без резервування місця та оплати'));
    const confirm=page.getByRole('button',{name:'Підтвердити демо-вибір',exact:true});
    assert.ok((await confirm.boundingBox()).height>=44);
    await confirm.click();
    await until(page,()=>document.querySelector('.workspace').dataset.navigationState==='ready');
    await until(page,async id=>(await window.__map.getSource('parking-map-poi-paid').getData()).features.some(f=>f.id===id&&f.properties.demoSelected),paid[0].id);
    assert.equal(routeRequests,routes+1);
    assert.deepEqual(await selected(),[paid[0].id]);
    assert.ok(await page.evaluate(()=>window.__map.getPaintProperty('parking-map-poi-paid','circle-color').includes('#8A909C')));
    assert.ok(await page.evaluate(async ()=>(await window.__map.getSource('navigation-route').getData()).features.length===1));
    await openPaid(paid[0]);
    assert.ok((await page.locator('.poi-popup').innerText()).includes('Фактичне місце не зарезервовано'));
    if (width===390) await page.screenshot({path:path.join(output,'mobile-demo-booking.png')});
    if (width===1440) await page.screenshot({path:path.join(output,'desktop-demo-booking.png')});
    await page.getByRole('button',{name:'Скасувати бронювання',exact:true}).click();
    assert.deepEqual(await selected(),[]);
    assert.equal(await page.evaluate(async ()=>(await window.__map.getSource('navigation-route').getData()).features.length),0);
    await page.locator('.maplibregl-popup-close-button').click();
  }
  await page.setViewportSize({width:390,height:844});
  await openPaid(paid[0]);await confirmBooking();await until(page,()=>document.querySelector('.workspace').dataset.navigationState==='ready');
  await openPaid(paid[1]);await confirmBooking();await until(page,()=>document.querySelector('.workspace').dataset.navigationState==='ready');
  await openPaid(paid[1]);assert.deepEqual(await selected(),[paid[1].id]);
  await page.locator('.maplibregl-popup-close-button').click();
  await page.evaluate(()=>{window.__map.setStyle(structuredClone(window.__auditBaseStyle),{diff:false});});
  await until(page,async id=>{const source=window.__map.getSource('parking-map-poi-paid');return source&&(await source.getData()).features.some(f=>f.id===id&&f.properties.demoSelected);},paid[1].id);
  await openPaid(paid[1]);await page.locator('.popup-route-button').click();await until(page,()=>document.querySelector('.workspace').dataset.navigationState==='ready');
  await openPaid(paid[1]);await page.getByRole('button',{name:'Скасувати бронювання',exact:true}).click();
  assert.equal(await page.evaluate(async ()=>(await window.__map.getSource('navigation-route').getData()).features.length),1,'Cancellation preserves the later ordinary route to even the same POI');
  await page.locator('.maplibregl-popup-close-button').click();await page.locator('#nav-clear').click();
  routingStatus=403;
  await openPaid(paid[0]);await confirmBooking();await until(page,()=>document.querySelector('#nav-status').textContent.includes('HTTP 403'));
  assert.equal(await page.evaluate(async ()=>(await window.__map.getSource('navigation-route').getData()).features.length),0);
  assert.deepEqual(await selected(),[paid[0].id],'Failed route does not fabricate or remove the demo choice');
  await openPaid(paid[0]);await page.getByRole('button',{name:'Скасувати бронювання',exact:true}).click();
  await page.locator('.maplibregl-popup-close-button').click();routingStatus=200;
  assert.deepEqual(errors.filter(e=>!/403/.test(e)),[]);
  console.log('Demo booking PASS: 1440/390/320px, real paid POIs, confirmation, gray paint/data, automatic route, cancellation/ownership, switch, style reload, HTTP 403');
  const unavailable = await context.newPage();
  await unavailable.route('**/data/lviv-charging-ocm.geojson**', r => r.fulfill({status:503,body:'Controlled unavailable source'}));
  await unavailable.goto(origin + '/parking-map/', {waitUntil:'domcontentloaded'});
  await unavailable.waitForFunction(() => !!window.__map?.getSource('parking-map-poi-charging'), null, {timeout:60000});
  await unavailable.locator('[data-poi="charging"]').click();
  await until(unavailable, () => document.querySelector('#poi-status').textContent.includes('OCM недоступні'));
  assert.ok(await unavailable.evaluate(async () => (await window.__map.getSource('parking-map-poi-charging').getData()).features.length > 0));
  await unavailable.close();
  console.log(JSON.stringify({ result: 'PASS', widths, categories: 5, localRequests, routeRequests, gps: await page.evaluate(() => window.__gps), compass: true, popup: true, cancel: true, resizePreservesNavigation: true, styleReloads:3, expectedRouting403: true, errors, styleWarnings:warnings.filter(w=>/Expected value|could not be loaded|SDF/i.test(w)), screenshots: output }, null, 2));
})().catch(error => { console.error('FAIL:', redact(error.stack || error.message)); process.exitCode = 1; })
  .finally(async () => { if (browser) await browser.close(); if (server) await new Promise(r => server.close(r)); });
