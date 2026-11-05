import { insideUkraine } from "./poi.js?v=20261105-always-demo";

const ROUTING_URL = "https://api.geoapify.com/v1/routing";
const empty = { type: "FeatureCollection", features: [] };
const rad = Math.PI / 180;
const meters = (a, b) => {
  const lat = (a[1] + b[1]) / 2 * rad;
  return Math.hypot((a[0] - b[0]) * 111320 * Math.cos(lat), (a[1] - b[1]) * 111320);
};
const readableDistance = (value) => value >= 1000 ? `${(value / 1000).toFixed(1)} км` : `${Math.round(value)} м`;
const validPoint = (p) => Array.isArray(p) && p.length >= 2 && Number.isFinite(p[0]) && Number.isFinite(p[1]) && Math.abs(p[0]) <= 180 && Math.abs(p[1]) <= 90;

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
  const ui = Object.fromEntries(["destination", "summary", "next", "status", "location", "start", "recenter", "stop", "clear"]
    .map((name) => [name, document.querySelector(`#nav-${name}`)]));
  const key = window.PARKING_MAP_CONFIG?.geoapifyKey;
  const workspace = document.querySelector(".workspace");
  const mobile = Object.fromEntries(["maneuver", "street", "turn-distance", "duration"]
    .map((name) => [name, document.querySelector(`#nav-${name}`)]));
  const tools = document.querySelector(".tools-panel");
  const toolsToggle = document.querySelector(".mobile-tools-toggle");
  const toggleTools = () => {
    const expanded = tools.classList.toggle("tools-expanded");
    toolsToggle.setAttribute("aria-expanded", String(expanded));
    toolsToggle.setAttribute("aria-label", expanded ? "Сховати категорії POI" : "Показати категорії POI");
  };
  toolsToggle.addEventListener("click", toggleTools);
  const headerObserver = new ResizeObserver(([entry]) => {
    workspace.style.setProperty("--mobile-header-height", `${entry.target.getBoundingClientRect().height}px`);
  });
  headerObserver.observe(document.querySelector(".navigation-details"));
  let position, positionAt = 0, accuracy, heading, destination, destinationOwner, destinationMarker, userMarker;
  let watchId, navigating = false, starting = false, routingPending = false, follow = false, controller, route, coords = [], steps = [], routeDistances = [];
  let lastReroute = 0, offRouteSince = 0, disposed = false, lastAngle = 0, compassExpiry, routingRetryAt = 0;
  let locationRevision = 0, watchRevision = 0, startRevision = 0;
  const arrow = document.createElement("div");
  arrow.className = "navigation-arrow";
  arrow.innerHTML = '<span class="point"></span><span class="heading"></span>';

  // A shared MultiLineString source keeps every stroke on the original route geometry.
  // Layered colors avoid restarting a line-progress gradient on each route segment.
  const routeLayers = [
    { id: "navigation-glow", color: "#7D41FF", opacity: .20,
      width: [8, 12, 16, 20, 24], blur: [3, 4, 6, 8, 10] },
    { id: "navigation-outline", color: "#7938FF", opacity: .95,
      width: [2.5, 4, 5.5, 7, 8], blur: [0, 0, 0, 0, 0] },
    { id: "navigation-line", color: "#8261FF", opacity: 1,
      width: [1.2, 2, 3, 4, 4.5], blur: [0, 0, 0, 0, 0] },
  ];
  const byZoom = (values) => ["interpolate", ["linear"], ["zoom"],
    5, values[0], 10, values[1], 13, values[2], 16, values[3], 20, values[4]];
  function restoreStyle() {
    if (disposed) return;
    const before = map.getLayer("outside-ukraine") ? "outside-ukraine" : undefined;
    if (!map.getSource("navigation-route")) map.addSource("navigation-route", { type: "geojson", data: empty,
      attribution: 'Powered by <a href="https://www.geoapify.com/" target="_blank" rel="noopener">Geoapify</a>' });
    for (const { id, width, color, blur } of routeLayers) {
      if (!map.getLayer(id)) map.addLayer({ id, type: "line", source: "navigation-route",
        layout: { "line-join": "round", "line-cap": "round" },
        paint: { "line-color": color, "line-width": byZoom(width), "line-blur": byZoom(blur),
          "line-opacity": 0, "line-opacity-transition": { duration: 0, delay: 0 } } }, before);
    }
    if (!map.getSource("navigation-accuracy")) map.addSource("navigation-accuracy", { type: "geojson", data: empty });
    if (!map.getLayer("navigation-accuracy")) map.addLayer({ id: "navigation-accuracy", type: "fill", source: "navigation-accuracy",
      paint: { "fill-color": "#238BFF", "fill-opacity": .13 } }, before);
    if (!map.getLayer("navigation-accuracy-outline")) map.addLayer({ id: "navigation-accuracy-outline", type: "line", source: "navigation-accuracy",
      paint: { "line-color": "#238BFF", "line-opacity": .45, "line-width": 1 } }, before);
    map.getSource("navigation-route").setData(route ? { type: "FeatureCollection", features: [route] } : empty);
    map.getSource("navigation-accuracy").setData(position ? { type: "FeatureCollection", features: [circle(position, accuracy)] } : empty);
    setRouteVisible(!!route);
  }
  function setRouteVisible(visible) {
    const duration = visible && !window.matchMedia("(prefers-reduced-motion: reduce)").matches ? 280 : 0;
    for (const { id, opacity } of routeLayers) {
      if (!map.getLayer(id)) continue;
      map.setPaintProperty(id, "line-opacity-transition", { duration, delay: 0 });
      map.setPaintProperty(id, "line-opacity", visible ? opacity : 0);
    }
  }

  function notice(message, level = "info") { ui.status.textContent = message; ui.status.dataset.level = level; ui.status.hidden = false; }
  function syncMode() {
    workspace.classList.toggle("has-destination", !!destination);
    workspace.dataset.navigationState = !destination ? "browse" : navigating ? "navigating" : route && !routingPending ? "ready" : "planning";
    if (!destination) {
      tools.classList.remove("tools-expanded");
      toolsToggle.setAttribute("aria-expanded", "false");
      toolsToggle.setAttribute("aria-label", "Показати категорії POI");
    }
  }
  syncMode();
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
  restoreStyle();

  function setPosition(value) {
    const p = [value?.coords?.longitude, value?.coords?.latitude];
    if (!validPoint(p) || !Number.isFinite(value?.coords?.accuracy) || value.coords.accuracy > 1000 || value.coords.accuracy <= 0 ||
        !insideUkraine(p, boundary.geometry)) {
      notice("Точність місцеперебування недостатня. Зачекайте кращого GPS-сигналу.", "warning");
      return false;
    }
    position = p; positionAt = Date.now(); accuracy = value.coords.accuracy;
    if (!userMarker) {
      userMarker = new Marker({ element: arrow, anchor: "center" }).setLngLat(p).addTo(map);
      userMarker.getElement().style.transition = "transform .4s linear";
    }
    else userMarker.setLngLat(p);
    map.getSource("navigation-accuracy")?.setData({ type: "FeatureCollection", features: [circle(p, accuracy)] });
    const gpsHeading = Number.isFinite(value.coords.speed) && value.coords.speed >= 1.5 && accuracy <= 40 && Number.isFinite(value.coords.heading) && value.coords.heading >= 0 && value.coords.heading < 360
      ? value.coords.heading : undefined;
    if (Date.now() - compassAt > 3000) compassHeading = undefined;
    if (!Number.isFinite(compassHeading)) heading = gpsHeading;
    renderHeading();
    notice(`Позицію визначено, точність приблизно ${Math.round(accuracy)} м. Дані про дороги можуть бути неповними.`);
    if (follow) map.easeTo({ center: p, bearing: Number.isFinite(heading) ? heading : map.getBearing(), duration: 650 });
    if (navigating && route) { updateProgress(); maybeReroute(); }
    return true;
  }
  let compassHeading, compassAt = 0;
  function orientation(event) {
    let value;
    if (Number.isFinite(event.webkitCompassHeading) && event.webkitCompassHeading >= 0 && event.webkitCompassHeading < 360 && Number.isFinite(event.webkitCompassAccuracy) && event.webkitCompassAccuracy >= 0 && event.webkitCompassAccuracy <= 40) {
      value = event.webkitCompassHeading;
    } else if (event.absolute && Number.isFinite(event.alpha) && event.alpha >= 0 && event.alpha < 360) {
      value = (360 - event.alpha) % 360;
    }
    if (!Number.isFinite(value)) return;
    compassHeading = value; compassAt = Date.now(); heading = value; renderHeading();
    clearTimeout(compassExpiry);
    compassExpiry = setTimeout(() => { compassHeading = undefined; heading = undefined; renderHeading(); }, 3000);
  }
  function locationError(error) {
    const text = error.code === 1 ? "Доступ до геолокації відхилено. Дозвольте його в налаштуваннях браузера й натисніть кнопку місцеперебування на карті." :
      error.code === 3 ? "Час очікування GPS вичерпано." : "Не вдалося визначити місцеперебування.";
    notice(text, "error");
    heading = undefined; renderHeading();
    if (navigating && error.code === 1) { stop(); notice(text, "error"); }
  }
  function locate() {
    if (disposed) return;
    if (!navigator.geolocation || !isSecureContext) { notice("Геолокація доступна лише у HTTPS-браузері з підтримкою GPS.", "error"); return; }
    const revision = ++locationRevision;
    navigator.geolocation.getCurrentPosition((value) => {
      if (disposed || revision !== locationRevision || !setPosition(value)) return;
      map.easeTo({ center: position, zoom: Math.max(map.getZoom(), 14), duration: 600 });
      if (destination) calculate();
    }, error => { if (!disposed && revision === locationRevision) locationError(error); }, { enableHighAccuracy: true, maximumAge: 0, timeout: 15000 });
  }
  function setDestination(point, label = "Точка на карті", { owner } = {}) {
    if (disposed) return false;
    if (!validPoint(point) || !insideUkraine(point, boundary.geometry)) {
      notice("Виберіть точку в межах України.");
      return false;
    }
    controller?.abort(); controller = undefined; routingPending = false;
    destination = [...point];
    // Ownership identifies a demo selection, never an operator booking or payment.
    destinationOwner = owner;
    document.querySelector(".navigation-panel").hidden = false;
    destinationMarker?.remove();
    const pin = document.createElement("span"); pin.textContent = "●";
    pin.style.cssText = `color:${owner ? "#8A909C" : "#ff686f"};font-size:32px;text-shadow:0 2px 5px #000`;
    destinationMarker = new Marker({ element: pin, anchor: "bottom" }).setLngLat(point).addTo(map);
    ui.destination.textContent = label;
    ui.clear.hidden = false;
    route = null; coords = []; steps = [];
    map.getSource("navigation-route")?.setData(empty);
    setRouteVisible(false);
    ui.start.disabled = true;
    ui.next.textContent = "";
    ui.summary.textContent = position ? "Розрахунок маршруту…" : "Спершу визначте місцеперебування.";
    mobile.street.textContent = label;
    mobile.maneuver.textContent = "•";
    mobile["turn-distance"].textContent = "—";
    mobile.duration.textContent = "";
    ui.next.textContent = position ? "Розрахунок маршруту…" : "Потрібен дозвіл на геолокацію.";
    syncMode();
    if (position && Date.now() - positionAt <= 60000) calculate();
    else locate();
    return true;
  }
  async function calculate(isReroute = false) {
    if (disposed || !position || !destination) return;
    if (!key) { notice("Для маршруту потрібен ключ Geoapify з обмеженням за доменом у налаштуваннях провайдера.", "error"); return; }
    if (Date.now() < routingRetryAt) {
      notice("Geoapify обмежив запити. Зачекайте перед повторним розрахунком маршруту.", "warning");
      return;
    }
    controller?.abort();
    controller = new AbortController();
    const request = controller;
    routingPending = true; ui.start.disabled = true; syncMode();
    const timeout = setTimeout(() => request.abort(), 20000);
    try {
      const url = new URL(ROUTING_URL);
      url.searchParams.set("waypoints", `${position[1]},${position[0]}|${destination[1]},${destination[0]}`);
      url.searchParams.set("mode", "drive");
      url.searchParams.set("lang", "uk");
      // Geoapify supplies actual road names and maneuver types with these details.
      url.searchParams.set("details", "instruction_details,route_details");
      url.searchParams.set("apiKey", key);
      const response = await fetch(url, { signal: request.signal });
      if (request !== controller || disposed) return;
      if (!response.ok) {
        const failure = routingFailure(response.status, response.headers.get("Retry-After"));
        if (failure.backoffMs) routingRetryAt = Date.now() + failure.backoffMs;
        throw new Error(failure.message);
      }
      const result = await response.json();
      const feature = result.features?.[0];
      if (feature?.geometry?.type !== "MultiLineString" || !Array.isArray(feature.geometry.coordinates) || !feature.geometry.coordinates.length ||
          !feature.geometry.coordinates.every(line => Array.isArray(line) && line.length >= 2) ||
          !Number.isFinite(feature.properties?.distance) || feature.properties.distance < 0 || !Number.isFinite(feature.properties?.time) || feature.properties.time < 0) {
        throw new Error("Routing API не повернув коректний автомобільний маршрут.");
      }
      if (!feature.geometry.coordinates.flat().every((point) => validPoint(point) && insideUkraine(point, boundary.geometry))) {
        throw new Error("Маршрут виходить за межі України. Виберіть інший пункт призначення.");
      }
      if (request !== controller || disposed) return;
      routingRetryAt = 0;
      route = feature;
      coords = feature.geometry.coordinates.flat();
      let offset = 0;
      steps = (Array.isArray(feature.properties.legs) ? feature.properties.legs : []).flatMap((leg, index) => {
        const line = feature.geometry.coordinates[index];
        const result = (Array.isArray(leg?.steps) ? leg.steps : [])
          .filter(step => Number.isInteger(step?.from_index) && step.from_index >= 0 && step.from_index < (line?.length ?? 0))
          .map(step => ({ ...step, routeIndex: offset + step.from_index }));
        offset += feature.geometry.coordinates[index]?.length ?? 0;
        return result;
      });
      routeDistances = [0];
      for (let i = 1; i < coords.length; i++) routeDistances.push(routeDistances[i - 1] + meters(coords[i - 1], coords[i]));
      map.getSource("navigation-route")?.setData({ type: "FeatureCollection", features: [feature] });
      setRouteVisible(true);
      ui.summary.textContent = `${readableDistance(feature.properties.distance)} · близько ${Math.ceil(feature.properties.time / 60)} хв`;
      ui.start.disabled = false;
      routingPending = false; syncMode();
      notice("Маршрут розраховано за OSM. Перевіряйте актуальні дорожні обмеження самостійно.");
      if (!isReroute) {
        const bounds = new LngLatBounds(); coords.forEach((p) => bounds.extend(p));
        map.fitBounds(bounds, { padding: 70, maxZoom: 16, duration: 600 });
      }
      updateProgress();
    } catch (error) {
      if (request !== controller || disposed) return;
      const message = error.name === "AbortError" ? "Час очікування Geoapify вичерпано." :
        error instanceof TypeError ? "Не вдалося зв’язатися з Geoapify. Перевірте мережу та CORS-обмеження ключа." :
          error.message || "Помилка сервісу маршрутизації.";
      // A temporary reroute failure must not erase the usable route being followed.
      if (isReroute && route) {
        notice(`${message} Попередній маршрут збережено.`, "error");
        return;
      }
      route = null; coords = []; steps = [];
      map.getSource("navigation-route")?.setData(empty);
      ui.summary.textContent = "Маршрут недоступний";
      ui.start.disabled = true;
      ui.next.textContent = "Маршрут недоступний. Перевірте повідомлення на карті.";
      mobile["turn-distance"].textContent = "—";
      mobile.duration.textContent = "";
      syncMode();
      notice(message, "error");
    } finally {
      clearTimeout(timeout);
      if (request === controller && !disposed) { routingPending = false; ui.start.disabled = !route; syncMode(); }
    }
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
    return { distance: closest, index, remaining: Math.max(0, total - closestAlong), travelled: closestAlong };
  }
  function updateProgress() {
    if (!route || !position) return;
    const progress = nearest();
    if (navigating) ui.summary.textContent = `Залишилося ${readableDistance(progress.remaining)}`;
    const step = steps.find((item) => item.routeIndex > progress.index && typeof item.instruction?.text === "string" && item.instruction.text.trim());
    ui.next.textContent = step?.instruction?.text ?? "Покрокові інструкції недоступні.";
    const streets = step?.instruction?.streets;
    mobile.street.textContent = (typeof step?.name === "string" ? step.name : "") || (Array.isArray(streets) ? streets.filter(s => typeof s === "string").join(", ") : "") || ui.destination.textContent;
    mobile.maneuver.textContent = maneuverSymbol(step?.instruction?.type);
    const distance = routeDistances[step?.routeIndex];
    mobile["turn-distance"].textContent = Number.isFinite(distance) ? readableDistance(Math.max(0, distance - progress.travelled)) : "—";
    const total = routeDistances.at(-1);
    const remainingTime = navigating && total > 0 ? route.properties.time * progress.remaining / total : route.properties.time;
    mobile.duration.textContent = `≈ ${Math.max(1, Math.ceil(remainingTime / 60))} хв`;
  }
  function maybeReroute() {
    if (!position || accuracy > 80 || !route) return;
    const off = nearest().distance > Math.max(80, accuracy * 2);
    if (!off) { offRouteSince = 0; return; }
    if (!offRouteSince) offRouteSince = Date.now();
    if (Date.now() - offRouteSince < 15000 || Date.now() - lastReroute < 60000) return;
    lastReroute = Date.now(); offRouteSince = 0;
    notice("Ви відхилилися від маршруту. Перерахунок…", "warning");
    calculate(true);
  }
  async function start() {
    if (navigating || starting) return;
    if (routingPending) { notice("Зачекайте завершення розрахунку маршруту.", "warning"); return; }
    if (!position || !destination || !route || !navigator.geolocation) { notice("Спершу визначте позицію й побудуйте маршрут."); return; }
    starting = true;
    const revision = ++startRevision;
    if (typeof DeviceOrientationEvent !== "undefined" && typeof DeviceOrientationEvent.requestPermission === "function") {
      try { if (await DeviceOrientationEvent.requestPermission() !== "granted") compassHeading = undefined; } catch { compassHeading = undefined; }
    }
    if (revision !== startRevision) return;
    starting = false;
    if (disposed || !destination || !route) return;
    window.addEventListener("deviceorientationabsolute", orientation);
    window.addEventListener("deviceorientation", orientation);
    navigating = true; follow = true;
    ui.start.hidden = true; ui.stop.hidden = false; ui.recenter.hidden = false;
    syncMode(); updateProgress();
    const watch = ++watchRevision;
    watchId = navigator.geolocation.watchPosition(
      value => { if (!disposed && navigating && watch === watchRevision) setPosition(value); },
      error => { if (!disposed && navigating && watch === watchRevision) locationError(error); },
      { enableHighAccuracy: true, maximumAge: 1000, timeout: 15000 });
    map.easeTo({ center: position, zoom: Math.max(map.getZoom(), 16), duration: 600 });
  }
  function stop() {
    ++locationRevision; ++watchRevision; ++startRevision; starting = false;
    controller?.abort(); controller = undefined; routingPending = false;
    navigating = false; follow = false; offRouteSince = 0;
    if (watchId !== undefined) navigator.geolocation.clearWatch(watchId);
    watchId = undefined;
    window.removeEventListener("deviceorientationabsolute", orientation);
    window.removeEventListener("deviceorientation", orientation);
    clearTimeout(compassExpiry);
    compassHeading = undefined; heading = undefined; renderHeading();
    ui.start.hidden = false; ui.stop.hidden = true; ui.recenter.hidden = true;
    syncMode();
    notice("Навігацію завершено. Відстеження GPS зупинено.");
  }
  function clear() {
    stop(); controller?.abort(); controller = undefined; destination = undefined; destinationOwner = undefined; route = null; coords = []; steps = [];
    destinationMarker?.remove(); destinationMarker = undefined;
    map.getSource("navigation-route")?.setData(empty);
    setRouteVisible(false);
    ui.destination.textContent = "Пункт призначення не вибрано";
    ui.summary.textContent = "Оберіть POI або місце на карті правою кнопкою миші.";
    ui.next.textContent = ""; ui.start.disabled = true; ui.clear.hidden = true;
    document.querySelector(".navigation-panel").hidden = true;
    ui.status.hidden = true;
    syncMode();
  }
  ui.location.addEventListener("click", locate);
  ui.start.addEventListener("click", start);
  ui.stop.addEventListener("click", stop);
  ui.clear.addEventListener("click", clear);
  const recenter = () => { if (position) { follow = true; map.easeTo({ center: position, duration: 500 }); } };
  const contextmenu = event => setDestination(event.lngLat.toArray());
  const dragstart = () => { if (navigating) follow = false; };
  ui.recenter.addEventListener("click", recenter);
  map.on("contextmenu", contextmenu);
  map.on("dragstart", dragstart);
  map.on("rotate", renderHeading);
  function dispose() {
    if (disposed) return;
    disposed = true; stop(); controller?.abort(); destinationMarker?.remove(); userMarker?.remove();
    destination = undefined; destinationOwner = undefined; route = null; coords = []; steps = []; syncMode();
    document.querySelector(".navigation-panel").hidden = true;
    ui.status.hidden = true; ui.start.disabled = true;
    headerObserver.disconnect(); toolsToggle.removeEventListener("click", toggleTools); map.off("rotate", renderHeading);
    ui.location.removeEventListener("click", locate); ui.start.removeEventListener("click", start);
    ui.stop.removeEventListener("click", stop); ui.clear.removeEventListener("click", clear);
    ui.recenter.removeEventListener("click", recenter);
    map.off("contextmenu", contextmenu); map.off("dragstart", dragstart); map.off("remove", dispose);
  }
  map.on("remove", dispose);
  function clearDestinationFor(owner) {
    if (disposed || !owner || destinationOwner !== owner) return false;
    clear();
    return true;
  }
  return { setDestination, clearDestinationFor, restoreStyle, dispose };
}

export function maneuverSymbol(type) {
  if (typeof type !== "string") return "•";
  if (type?.startsWith("DestinationReached")) return "⚑";
  if (["TurnAroundLeft", "TurnAroundRight"].includes(type)) return "↶";
  if (type === "Roundabout") return "↻";
  if (["Right", "SharpRight", "ExitRight"].includes(type)) return "↱";
  if (["Left", "SharpLeft", "ExitLeft"].includes(type)) return "↰";
  if (["SlightRight", "StayRight", "MergeRight"].includes(type)) return "↗";
  if (["SlightLeft", "StayLeft", "MergeLeft"].includes(type)) return "↖";
  return ["Straight", "StartAt", "StartAtRight", "StartAtLeft", "Merge"].includes(type) ? "↑" : "•";
}
