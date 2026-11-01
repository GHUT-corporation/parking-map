import { insideUkraine } from "./poi.js?v=20261101-lviv";

const ROUTING_URL = "https://api.geoapify.com/v1/routing";
const empty = { type: "FeatureCollection", features: [] };
const rad = Math.PI / 180;
const meters = (a, b) => {
  const lat = (a[1] + b[1]) / 2 * rad;
  return Math.hypot((a[0] - b[0]) * 111320 * Math.cos(lat), (a[1] - b[1]) * 111320);
};
const readableDistance = (value) => value >= 1000 ? `${(value / 1000).toFixed(1)} км` : `${Math.round(value)} м`;
const validPoint = (p) => p && Number.isFinite(p[0]) && Number.isFinite(p[1]);

export function routingFailure(status, retryAfter) {
  if (status === 401) return { message: "Geoapify відхилив API-ключ (HTTP 401). Перевірте GEOAPIFY_KEY.", backoffMs: 0 };
  if (status === 403) return { message: "Geoapify заборонив доступ (HTTP 403). Перевірте обмеження ключа для домену сайту.", backoffMs: 0 };
  if (status === 429) {
    const seconds = Number(retryAfter);
    const suggested = Number.isFinite(seconds) && retryAfter !== null ? seconds * 1000 : Date.parse(retryAfter) - Date.now();
    return { message: "Geoapify обмежив запити (HTTP 429). Зачекайте перед новою спробою.",
      backoffMs: Math.max(60000, Number.isFinite(suggested) ? suggested : 0) };
  }
  return { message: `Geoapify повернув HTTP ${status}. Спробуйте пізніше.`, backoffMs: 0 };
}

export function setupNavigation(map, { Marker, LngLatBounds, boundary }) {
  const ui = Object.fromEntries(["destination", "summary", "next", "status", "location", "pick", "start", "recenter", "stop", "clear"]
    .map((name) => [name, document.querySelector(`#nav-${name}`)]));
  const key = window.PARKING_MAP_CONFIG?.geoapifyKey;
  let position, accuracy, heading, destination, destinationMarker, userMarker;
  let watchId, navigating = false, follow = false, picking = false, controller, route, coords = [], steps = [];
  let lastReroute = 0, offRouteSince = 0, disposed = false, lastAngle = 0, compassExpiry, routingRetryAt = 0;
  const arrow = document.createElement("div");
  arrow.className = "navigation-arrow";
  arrow.innerHTML = '<span class="point"></span><span class="heading"></span>';

  if (!map.getSource("navigation-route")) map.addSource("navigation-route", { type: "geojson", data: empty });
  for (const [id, width, color] of [["navigation-outline", 10, "#0b315e"], ["navigation-line", 6, "#238BFF"]]) {
    if (!map.getLayer(id)) map.addLayer({ id, type: "line", source: "navigation-route",
      layout: { "line-join": "round", "line-cap": "round" },
      paint: { "line-color": color, "line-width": width, "line-opacity": .95 } });
  }

  function notice(message) { ui.status.textContent = message; }
  function renderHeading() {
    arrow.classList.toggle("directed", Number.isFinite(heading));
    if (!Number.isFinite(heading)) return;
    const delta = ((heading - lastAngle + 540) % 360) - 180;
    lastAngle += delta;
    arrow.style.setProperty("--heading", `${lastAngle - map.getBearing()}deg`);
  }
  function circle(center, radius) {
    const points = [];
    for (let i = 0; i <= 48; i++) {
      const angle = i / 48 * Math.PI * 2;
      points.push([center[0] + radius * Math.cos(angle) / (111320 * Math.cos(center[1] * rad)),
        center[1] + radius * Math.sin(angle) / 111320]);
    }
    return { type: "Feature", geometry: { type: "Polygon", coordinates: [points] }, properties: {} };
  }
  map.addSource("navigation-accuracy", { type: "geojson", data: empty });
  map.addLayer({ id: "navigation-accuracy", type: "fill", source: "navigation-accuracy",
    paint: { "fill-color": "#238BFF", "fill-opacity": .13 } });
  map.addLayer({ id: "navigation-accuracy-outline", type: "line", source: "navigation-accuracy",
    paint: { "line-color": "#238BFF", "line-opacity": .45, "line-width": 1 } });

  function setPosition(value) {
    const p = [value.coords.longitude, value.coords.latitude];
    if (!validPoint(p) || value.coords.accuracy > 1000 || value.coords.accuracy <= 0 ||
        !insideUkraine(p, boundary.geometry)) {
      notice("Точність місцеперебування недостатня. Зачекайте кращого GPS-сигналу.");
      return;
    }
    position = p; accuracy = value.coords.accuracy;
    if (!userMarker) {
      userMarker = new Marker({ element: arrow, anchor: "center" }).setLngLat(p).addTo(map);
      userMarker.getElement().style.transition = "transform .4s linear";
    }
    else userMarker.setLngLat(p);
    map.getSource("navigation-accuracy").setData({ type: "FeatureCollection", features: [circle(p, Math.min(accuracy, 500))] });
    const gpsHeading = value.coords.speed >= 1.5 && accuracy <= 40 && Number.isFinite(value.coords.heading)
      ? value.coords.heading : undefined;
    if (Date.now() - compassAt > 3000) compassHeading = undefined;
    if (!Number.isFinite(compassHeading)) heading = gpsHeading;
    renderHeading();
    notice(`Позицію визначено, точність приблизно ${Math.round(accuracy)} м. Дані про дороги можуть бути неповними.`);
    if (follow) map.easeTo({ center: p, bearing: Number.isFinite(heading) ? heading : map.getBearing(), duration: 650 });
    if (navigating && route) { updateProgress(); maybeReroute(); }
  }
  let compassHeading, compassAt = 0;
  function orientation(event) {
    let value;
    if (Number.isFinite(event.webkitCompassHeading) && Number.isFinite(event.webkitCompassAccuracy) && event.webkitCompassAccuracy <= 40) {
      value = event.webkitCompassHeading;
    } else if (event.absolute && Number.isFinite(event.alpha)) {
      value = (360 - event.alpha) % 360;
    }
    if (!Number.isFinite(value)) return;
    compassHeading = value; compassAt = Date.now(); heading = value; renderHeading();
    clearTimeout(compassExpiry);
    compassExpiry = setTimeout(() => { compassHeading = undefined; heading = undefined; renderHeading(); }, 3000);
  }
  function locationError(error) {
    const text = error.code === 1 ? "Доступ до геолокації відхилено." :
      error.code === 3 ? "Час очікування GPS вичерпано." : "Не вдалося визначити місцеперебування.";
    notice(text);
    heading = undefined; renderHeading();
    if (navigating && error.code === 1) { stop(); notice(text); }
  }
  function locate() {
    if (!navigator.geolocation || !isSecureContext) { notice("Геолокація доступна лише у HTTPS-браузері з підтримкою GPS."); return; }
    navigator.geolocation.getCurrentPosition((value) => {
      setPosition(value);
      if (position) map.easeTo({ center: position, zoom: Math.max(map.getZoom(), 14), duration: 600 });
      if (destination) calculate();
    }, locationError, { enableHighAccuracy: true, maximumAge: 0, timeout: 15000 });
  }
  function setDestination(point, label = "Точка на карті") {
    if (!validPoint(point) || !insideUkraine(point, boundary.geometry)) {
      notice("Виберіть точку в межах України.");
      return;
    }
    destination = point;
    destinationMarker?.remove();
    const pin = document.createElement("span"); pin.textContent = "●"; pin.style.cssText = "color:#ff686f;font-size:32px;text-shadow:0 2px 5px #000";
    destinationMarker = new Marker({ element: pin, anchor: "bottom" }).setLngLat(point).addTo(map);
    ui.destination.textContent = label;
    ui.clear.hidden = false;
    route = null; coords = []; steps = [];
    map.getSource("navigation-route").setData(empty);
    ui.start.disabled = true;
    ui.next.textContent = "";
    ui.summary.textContent = position ? "Розрахунок маршруту…" : "Спершу визначте місцеперебування.";
    if (position) calculate();
  }
  async function calculate(isReroute = false) {
    if (!position || !destination) return;
    if (!key) { notice("Для маршруту потрібен ключ Geoapify з обмеженням за доменом у налаштуваннях провайдера."); return; }
    if (Date.now() < routingRetryAt) {
      notice("Geoapify обмежив запити. Зачекайте перед повторним розрахунком маршруту.");
      return;
    }
    controller?.abort();
    controller = new AbortController();
    const request = controller;
    const timeout = setTimeout(() => request.abort(), 20000);
    try {
      const url = new URL(ROUTING_URL);
      url.searchParams.set("waypoints", `${position[1]},${position[0]}|${destination[1]},${destination[0]}`);
      url.searchParams.set("mode", "drive");
      url.searchParams.set("lang", "uk");
      url.searchParams.set("apiKey", key);
      const response = await fetch(url, { signal: request.signal });
      if (!response.ok) {
        const failure = routingFailure(response.status, response.headers.get("Retry-After"));
        if (failure.backoffMs) routingRetryAt = Date.now() + failure.backoffMs;
        throw new Error(failure.message);
      }
      const result = await response.json();
      const feature = result.features?.[0];
      if (feature?.geometry?.type !== "MultiLineString" || !Array.isArray(feature.geometry.coordinates?.[0]) ||
          !Number.isFinite(feature.properties?.distance) || !Number.isFinite(feature.properties?.time)) {
        throw new Error("Routing API не повернув коректний автомобільний маршрут.");
      }
      if (!feature.geometry.coordinates.flat().every((point) => validPoint(point) && insideUkraine(point, boundary.geometry))) {
        throw new Error("Маршрут виходить за межі України. Виберіть інший пункт призначення.");
      }
      if (request !== controller || disposed) return;
      routingRetryAt = 0;
      route = feature;
      coords = feature.geometry.coordinates.flat();
      steps = feature.properties.legs?.flatMap((leg) => leg.steps ?? []) ?? [];
      map.getSource("navigation-route").setData({ type: "FeatureCollection", features: [feature] });
      ui.summary.textContent = `${readableDistance(feature.properties.distance)} · близько ${Math.ceil(feature.properties.time / 60)} хв`;
      ui.start.disabled = false;
      notice("Маршрут розраховано за OSM. Перевіряйте актуальні дорожні обмеження самостійно.");
      if (!isReroute) {
        const bounds = new LngLatBounds(); coords.forEach((p) => bounds.extend(p));
        map.fitBounds(bounds, { padding: 70, maxZoom: 16, duration: 600 });
      }
      updateProgress();
    } catch (error) {
      if (request !== controller || disposed) return;
      route = null; coords = []; steps = [];
      map.getSource("navigation-route").setData(empty);
      ui.summary.textContent = "Маршрут недоступний";
      notice(error.name === "AbortError" ? "Час очікування Geoapify вичерпано." :
        error instanceof TypeError ? "Не вдалося зв’язатися з Geoapify. Перевірте мережу та CORS-обмеження ключа." :
          error.message || "Помилка сервісу маршрутизації.");
    } finally { clearTimeout(timeout); }
  }
  function nearest() {
    if (!position || coords.length < 2) return { distance: Infinity, index: 0, remaining: 0 };
    let closest = Infinity, index = 0, along = 0, total = 0, closestAlong = 0;
    for (let i = 0; i < coords.length - 1; i++) {
      const a = coords[i], b = coords[i + 1], lat = position[1] * rad;
      const dx = (b[0] - a[0]) * Math.cos(lat), dy = b[1] - a[1];
      const t = Math.max(0, Math.min(1, ((position[0] - a[0]) * Math.cos(lat) * dx + (position[1] - a[1]) * dy) / (dx * dx + dy * dy || 1)));
      const projected = [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])];
      const length = meters(a, b), distance = meters(position, projected);
      if (distance < closest) { closest = distance; index = i; closestAlong = along + length * t; }
      along += length; total += length;
    }
    return { distance: closest, index, remaining: Math.max(0, total - closestAlong) };
  }
  function updateProgress() {
    if (!route || !position) return;
    const progress = nearest();
    if (navigating) ui.summary.textContent = `Залишилося ${readableDistance(progress.remaining)}`;
    const step = steps.find((item) => item.from_index > progress.index && item.instruction?.text);
    ui.next.textContent = step?.instruction?.text ?? "";
  }
  function maybeReroute() {
    if (!position || accuracy > 80 || !route) return;
    const off = nearest().distance > Math.max(80, accuracy * 2);
    if (!off) { offRouteSince = 0; return; }
    if (!offRouteSince) offRouteSince = Date.now();
    if (Date.now() - offRouteSince < 15000 || Date.now() - lastReroute < 60000) return;
    lastReroute = Date.now(); offRouteSince = 0;
    notice("Ви відхилилися від маршруту. Перерахунок…");
    calculate(true);
  }
  async function start() {
    if (!position || !destination || !route || !navigator.geolocation) { notice("Спершу визначте позицію й побудуйте маршрут."); return; }
    if (typeof DeviceOrientationEvent !== "undefined" && typeof DeviceOrientationEvent.requestPermission === "function") {
      try { if (await DeviceOrientationEvent.requestPermission() !== "granted") compassHeading = undefined; } catch { compassHeading = undefined; }
    }
    window.addEventListener("deviceorientationabsolute", orientation);
    window.addEventListener("deviceorientation", orientation);
    navigating = true; follow = true;
    ui.start.hidden = true; ui.stop.hidden = false; ui.recenter.hidden = false;
    watchId = navigator.geolocation.watchPosition(setPosition, locationError,
      { enableHighAccuracy: true, maximumAge: 1000, timeout: 15000 });
    map.easeTo({ center: position, zoom: Math.max(map.getZoom(), 16), duration: 600 });
  }
  function stop() {
    navigating = false; follow = false; offRouteSince = 0;
    if (watchId !== undefined) navigator.geolocation.clearWatch(watchId);
    watchId = undefined;
    window.removeEventListener("deviceorientationabsolute", orientation);
    window.removeEventListener("deviceorientation", orientation);
    clearTimeout(compassExpiry);
    compassHeading = undefined; heading = undefined; renderHeading();
    ui.start.hidden = false; ui.stop.hidden = true; ui.recenter.hidden = true;
    notice("Навігацію завершено. Відстеження GPS зупинено.");
  }
  function clear() {
    stop(); controller?.abort(); destination = undefined; route = null; coords = []; steps = [];
    destinationMarker?.remove(); destinationMarker = undefined;
    map.getSource("navigation-route").setData(empty);
    ui.destination.textContent = "Пункт призначення не вибрано";
    ui.summary.textContent = "Оберіть POI або точку на карті.";
    ui.next.textContent = ""; ui.start.disabled = true; ui.clear.hidden = true;
  }
  ui.location.addEventListener("click", locate);
  ui.pick.addEventListener("click", () => { picking = true; notice("Натисніть на потрібне місце на карті."); });
  ui.start.addEventListener("click", start);
  ui.stop.addEventListener("click", stop);
  ui.clear.addEventListener("click", clear);
  ui.recenter.addEventListener("click", () => { if (position) { follow = true; map.easeTo({ center: position, duration: 500 }); } });
  map.on("click", (event) => { if (picking) { picking = false; setDestination(event.lngLat.toArray()); } });
  map.on("dragstart", () => { if (navigating) follow = false; });
  map.on("remove", () => { disposed = true; stop(); controller?.abort(); destinationMarker?.remove(); userMarker?.remove(); });
  return { setDestination };
}
