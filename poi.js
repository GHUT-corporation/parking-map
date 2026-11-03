// Independent OSM overlays. No MapTiler layers or sources are modified here.
const REPAIR_SERVICES = ["car_repair", "tyres_repair", "oil_change", "tyres", "diagnostics", "brakes", "body_repair", "air_conditioning", "painting", "glass", "electrical", "muffler", "transmission", "motor", "alignment"];
export function repairEvidence(tags) {
  if (tags.shop === "car_repair" || tags.craft === "car_repair") return "OSM: автомобільний ремонт";
  if (["car", "car_parts", "tyres"].includes(tags.shop)) {
    const service = REPAIR_SERVICES.find(s => tags[`service:vehicle:${s}`] === "yes");
    if (service) return `OSM: service:vehicle:${service}=yes`;
    if (tags.shop === "tyres" && [tags.name, tags["name:uk"], tags["name:en"]].some(n => /^(шиномонтаж|шино монтаж|вулканізація|car tire repair)$/iu.test(n ?? ""))) return "OSM: магазин шин із явною назвою послуги шиномонтажу";
  }
  return tags["service:vehicle:car_repair"] === "yes" && !["bicycle", "motorcycle", "motorcycle_repair"].includes(tags.shop) ? "OSM: service:vehicle:car_repair=yes" : null;
}
export const CATEGORIES = {
  parking: { label: "Парковки", zoom: 13, selector: '["amenity"="parking"]', color: "#53E6E1" },
  paid: { label: "Платні парковки", zoom: 13, selector: '["amenity"="parking"]', color: "#FFD279" },
  charging: { label: "Електрозаправки", zoom: 11, selector: '["amenity"="charging_station"]', color: "#A1E69A" },
  fuel: { label: "Заправки", zoom: 11, selector: '["amenity"="fuel"]', color: "#F6A474" },
  repair: { label: "СТО", zoom: 12, selector: '["shop"="car_repair"]',
    extraSelectors: ['["craft"="car_repair"]', '["service:vehicle:car_repair"="yes"]', '["shop"="tyres"]', ...REPAIR_SERVICES.map((service) => `["shop"~"^(car|car_parts|tyres)$"]["service:vehicle:${service}"="yes"]`)], color: "#B8A7FF" },
};
// Matches the processed region recorded by scripts/build_lviv_poi.py.
const LOCAL_POI_BBOX = [23.75, 49.65, 24.35, 50.05];
const ENDPOINT = "https://overpass-api.de/api/interpreter";
const DAILY_REQUEST_LIMIT = 30;
const DAILY_COUNTER_KEY = "parking-map-overpass-daily";
const empty = () => ({ type: "FeatureCollection", features: [] });

export function insideUkraine(point, geometry) {
  if (!Array.isArray(point) || point.length !== 2 || !point.every(Number.isFinite) ||
      Math.abs(point[0]) > 180 || Math.abs(point[1]) > 90 ||
      !["Polygon", "MultiPolygon"].includes(geometry?.type) || !Array.isArray(geometry.coordinates)) return false;
  const inRing = (ring) => {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [x, y] = ring[i], [px, py] = ring[j];
      if ((y > point[1]) !== (py > point[1]) &&
          point[0] < (px - x) * (point[1] - y) / (py - y) + x) inside = !inside;
    }
    return inside;
  };
  const polygons = geometry.type === "Polygon" ? [geometry.coordinates] : geometry.coordinates;
  try { return polygons.some(([outer, ...holes]) => inRing(outer) && !holes.some(inRing)); }
  catch { return false; }
}

// Documented OSM street-parking schemes; a marker represents this exact OSM
// segment, never a whole named street or an inferred separately mapped lot.
export function paidParkingSides(tags) {
  if (!tags.highway) return [];
  const present = new Set(["lane", "street_side", "on_kerb", "half_on_kerb", "shoulder"]);
  const orientation = new Set(["parallel", "diagonal", "perpendicular"]);
  return ["left", "right"].flatMap(side => {
    const get = suffix => tags[`parking:${side}${suffix}`] ?? tags[`parking:both${suffix}`];
    const physical = get("");
    const oldLane = tags[`parking:lane:${side}`] ?? tags["parking:lane:both"];
    if (physical !== undefined ? !present.has(physical) : !orientation.has(oldLane)) return [];
    const fee = get(":fee");
    if (fee === "yes") return [{ side, evidence: `parking:${tags[`parking:${side}:fee`] === undefined ? "both" : side}:fee=yes` }];
    if (fee !== undefined || get(":fee:conditional")) return [];
    const prefix = tags[`parking:condition:${side}`] !== undefined ? `parking:condition:${side}` : "parking:condition:both";
    const condition = tags[prefix];
    if (!["ticket", "ticket;residents", "residents;ticket"].includes(condition) ||
        tags[`${prefix}:time_interval`] || tags[`${prefix}:default`] || tags[`${prefix}:conditional`]) return [];
    return [{ side, evidence: `${prefix}=${condition}` }];
  });
}

export function isPaidParking(tags) {
  if (tags.highway && !["parking", "parking_space"].includes(tags.amenity) && tags.site !== "parking") return paidParkingSides(tags).length > 0;
  if (tags.fee === "yes") return true;
  const positivePrice = (value) => {
    const price = String(value ?? "").match(/^\s*(\d+(?:[.,]\d+)?)\s*(?:UAH|EUR|USD|грн)(?:\b|\/|\s|$)/i);
    return !!price && Number(price[1].replace(",", ".")) > 0;
  };
  if (positivePrice(tags.fee)) return true;
  if (tags.fee || tags["fee:conditional"]) return false;
  return positivePrice(tags.charge);
}

export function categoryFor(tags) {
  if (["parking", "parking_space"].includes(tags.amenity) || tags.site === "parking") return isPaidParking(tags) ? "paid" : "parking";
  if (tags.amenity === "charging_station") return "charging";
  if (tags.amenity === "fuel") return "fuel";
  if (repairEvidence(tags)) return "repair";
  if (paidParkingSides(tags).length) return "paid";
  return null;
}

export function matchesCategory(tags, key) {
  return categoryFor(tags) === key;
}

export function toFeatures(elements, key, geometry) {
  const unique = new Map();
  for (const element of elements) {
    if (!element || !["node", "way", "relation"].includes(element.type) ||
        !Number.isSafeInteger(element.id) || element.id <= 0) continue;
    const tags = element.tags && typeof element.tags === "object" ? element.tags : {};
    const position = element.center ?? element;
    const coordinates = [position.lon, position.lat];
    if (!matchesCategory(tags, key) || !coordinates.every(Number.isFinite) ||
        !insideUkraine(coordinates, geometry)) continue;
    const id = `${element.type}/${element.id}`;
    unique.set(id, {
      type: "Feature", id,
      geometry: { type: "Point", coordinates },
      properties: { ...tags, category: key, osmId: id },
    });
  }
  return { type: "FeatureCollection", features: [...unique.values()] };
}

// A viewport may span several adjacent local extracts; no single bbox needs to contain it.
export function boundsCovered(bounds, boxes) {
  const west = bounds.getWest(), east = bounds.getEast();
  const south = bounds.getSouth(), north = bounds.getNorth();
  if (![west, east, south, north].every(Number.isFinite) || west >= east || south >= north) return false;
  const epsilon = 1e-9;
  const xs = [west, east];
  for (const [left, , right] of boxes) {
    if (left > west && left < east) xs.push(left);
    if (right > west && right < east) xs.push(right);
  }
  xs.sort((a, b) => a - b);
  for (let i = 1; i < xs.length; i++) {
    const x = (xs[i - 1] + xs[i]) / 2;
    const spans = boxes.filter(([left, , right]) => left - epsilon <= x && x <= right + epsilon)
      .map(([, bottom, , top]) => [bottom, top]).sort((a, b) => a[0] - b[0]);
    let coveredUntil = south;
    for (const [bottom, top] of spans) {
      if (bottom > coveredUntil + epsilon) break;
      coveredUntil = Math.max(coveredUntil, top);
      if (coveredUntil >= north - epsilon) break;
    }
    if (coveredUntil < north - epsilon) return false;
  }
  return true;
}

export function setupPoi(map, boundary, Popup, onDestination, { cancelDestination = () => {} } = {}) {
  const status = document.querySelector("#poi-status");
  const buttons = [...document.querySelectorAll("[data-poi]")];
  const active = new Set();
  // Session-only demo choice. A future operator API must supply its own verified
  // booking result; neither this object nor fee tags assert a reserved space.
  let reservation;
  let localData = null;
  const canonicalId = id => localData?.metadata.osmIdAliases?.[id] ?? id;
  let localPromise, chargingPromise, chargingComplete = false, localError = false, chargingError = false;
  const localByCategory = new Map();
  const localInsideCache = new Map();
  const dataRequests = new Set();
  async function readJson(url, timeoutMs = 15000) {
    const request = new AbortController();
    dataRequests.add(request);
    const timeout = setTimeout(() => request.abort(), timeoutMs);
    try {
      const response = await fetch(url, { cache: "force-cache", signal: request.signal });
      if (!response.ok) throw new Error(`Local POI HTTP ${response.status}`);
      return await response.json();
    } finally { clearTimeout(timeout); dataRequests.delete(request); }
  }
  const validFeature = (f, external = false) => f?.type === "Feature" &&
    typeof f.id === "string" && (external ? /^ocm\/\d+$/.test(f.id) : /^(node|way|relation)\/\d+$/.test(f.id)) &&
    f.geometry?.type === "Point" && Array.isArray(f.geometry.coordinates) &&
    f.geometry.coordinates.length === 2 && f.geometry.coordinates.every(Number.isFinite) &&
    Math.abs(f.geometry.coordinates[0]) <= 180 && Math.abs(f.geometry.coordinates[1]) <= 90 &&
    (external ? f.properties?.category === "charging" : CATEGORIES[f.properties?.category] && f.properties.osmId === f.id && categoryFor(f.properties) === f.properties.category);
  function readLocal() {
    if (localPromise) return localPromise;
    localPromise = readJson("./data/lviv-poi.geojson?v=20261103-paid-booking", 30000)
    .then((data) => {
      if (data.type !== "FeatureCollection" || !Array.isArray(data.features) ||
          !Array.isArray(data.metadata?.bbox) || !data.metadata.bbox.length ||
          !data.metadata.bbox.every(b => Array.isArray(b) && b.length === 4 && b.every(Number.isFinite) && b[0] < b[2] && b[1] < b[3])) throw new Error("Invalid local POI GeoJSON");
      if (disposed) return;
      localData = data;
      const valid = [...new Map(data.features.filter(f => validFeature(f)).map(f => [f.id, f])).values()];
      for (const key of Object.keys(CATEGORIES)) {
        localByCategory.set(key, valid.filter((feature) => feature.properties.category === key));
      }
    })
    .catch(() => { localError = true; });
    return localPromise;
  }
  function readExternalCharging() {
    if (chargingPromise) return chargingPromise;
    chargingPromise = readJson("./data/lviv-charging-ocm.geojson?v=20261101-vehicle-poi")
      .then(data => {
        if (data.type !== "FeatureCollection" || !Array.isArray(data.features)) throw new Error("Invalid OCM data");
        if (disposed) return;
        const valid = [...new Map(data.features.filter(f => validFeature(f, true)).map(f => [f.id, f])).values()];
        localByCategory.set("charging", [...(localByCategory.get("charging") ?? []), ...valid]);
      }).catch(() => { chargingError = true; }).finally(() => { chargingComplete = true; });
    return chargingPromise;
  }
  const extent = [Infinity, Infinity, -Infinity, -Infinity];
  const visit = (coordinates) => {
    if (typeof coordinates[0] === "number") {
      extent[0] = Math.min(extent[0], coordinates[1]);
      extent[1] = Math.min(extent[1], coordinates[0]);
      extent[2] = Math.max(extent[2], coordinates[1]);
      extent[3] = Math.max(extent[3], coordinates[0]);
    } else coordinates.forEach(visit);
  };
  visit(boundary.geometry.coordinates);
  const cache = new Map();
  const liveFeatures = new Map();
  let timer, retryTimer, controller, popup, revision = 0, nextRequestAt = 0,
    blockedUntil = 0, consecutiveFailures = 0, requiresManualRetry = false, disposed = false;
  const handlers = [];
  const listen = (...args) => { map.on(...args); handlers.push(args); };
  const sourceId = (key) => `parking-map-poi-${key}`;

  function restoreStyle() {
    if (disposed) return;
    for (const [key, category] of Object.entries(CATEGORIES)) {
    const id = sourceId(key);
    if (!map.getSource(id)) map.addSource(id, {
      type: "geojson", data: empty(),
      attribution: 'POI © <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap contributors</a>' + (key === "charging" ? ' · <a href="https://openchargemap.org" target="_blank" rel="noopener">Open Charge Map contributors</a> (CC BY 4.0)' : ''),
    });
    if (!map.getLayer(id)) map.addLayer({
      id, type: "circle", source: id, minzoom: category.zoom,
      layout: { visibility: "none" },
      paint: {
        "circle-radius": ["interpolate", ["linear"], ["zoom"], 11, 6, 13, 7, 16, 8, 20, 10],
        "circle-color": key === "paid" ? ["case", ["==", ["get", "demoSelected"], true], "#8A909C", category.color] : category.color,
        "circle-stroke-color": key === "paid" ? ["case", ["==", ["get", "demoSelected"], true], "#C5CAD4", "#10182C"] : "#10182C",
        "circle-stroke-width": 2, "circle-opacity": 0.95,
      },
    }, "outside-ukraine");
    }
    updateVisibility();
    showAvailable(eligible());
  }
  restoreStyle();
  function openPopup(feature, key) {
      if (disposed || !feature || !insideUkraine(feature.geometry?.coordinates, boundary.geometry)) return;
      const category = CATEGORIES[key];
      popup?.remove();
      const props = feature.properties;
      const confirmedPaid = key === "paid" && categoryFor(props) === "paid";
      const streetParking = confirmedPaid && props.highway && !["parking", "parking_space"].includes(props.amenity) && props.site !== "parking";
      const selected = confirmedPaid && reservation?.id === canonicalId(props.osmId);
      const content = document.createElement("div");
      const title = document.createElement("strong");
      title.textContent = props.name || category.label;
      content.append(title);
      const add = (label, value) => {
        if (!value) return;
        const row = document.createElement("p");
        row.textContent = `${label}: ${value}`;
        content.append(row);
      };
      add("Тип", streetParking ? "Платне паркування на цьому сегменті вулиці (не окремий майданчик)" : props.amenity === "parking_space" ? "Окреме паркувальне місце" : category.label);
      add("Адреса", [props["addr:city"], props["addr:street"], props["addr:housenumber"]].filter(Boolean).join(", "));
      add("Оплата", isPaidParking(props) ? "Платно" : props.fee === "no" ? "Безкоштовно" : props.fee || (["parking", "paid"].includes(key) ? "Невідома" : ""));
      add("Тариф OSM", props.charge);
      add("Умови оплати", props["fee:conditional"]);
      const sides = streetParking ? paidParkingSides(props) : [];
      for (const { side, evidence } of sides) {
        add(side === "left" ? "Ліва сторона за напрямком OSM" : "Права сторона за напрямком OSM", evidence);
        for (const [tag, label] of [["fee:conditional", "Умови оплати"], ["charge", "Тариф OSM"], ["access", "Доступ"], ["access:conditional", "Умови доступу"], ["restriction", "Обмеження"], ["restriction:conditional", "Часові обмеження"], ["capacity", "Місць (OSM)"], ["maxstay", "Максимальна тривалість"]]) {
          add(label, props[`parking:${side}:${tag}`] ?? props[`parking:both:${tag}`]);
        }
      }
      add("Доступ", ({ private: "Приватний — не для загального користування", no: "Доступ заборонений", customers: "Лише для клієнтів", permit: "За дозволом", yes: "Загальний", permissive: "З дозволу власника" })[props.access] || props.access);
      add("Умови доступу", props["access:conditional"]);
      add("Місць (OSM)", props.capacity);
      add("Місць для людей з інвалідністю", props["capacity:disabled"]);
      add("Тип паркування", ({ surface: "Наземне", underground: "Підземне", multi_storey: "Багаторівневе", street_side: "Уздовж вулиці", lane: "Паркувальна смуга", rooftop: "На даху" })[props.parking] || props.parking);
      add("Окремо нанесених місць усередині", props.mapped_spaces);
      add("Оператор", props.operator);
      add("Години роботи", props.opening_hours);
      add("Телефон", props.phone || props["contact:phone"] || props["phone:UA"] || props["contact:phone:UA"]);
      add("Вебсайт", props.website || props["contact:website"]);
      const taggedDetails = (prefix) => Object.entries(props)
        .filter(([tag, value]) => tag.startsWith(prefix) && value && value !== "no" && value !== "0")
        .map(([tag, value]) => `${tag.slice(prefix.length)}: ${value}`).join("; ");
      if (key === "charging") {
        add("Роз’єми / потужність OSM", taggedDetails("socket:"));
        add("Потужність", props["charging_station:output"] || props.output);
      }
      if (key === "fuel") add("Пальне OSM", taggedDetails("fuel:"));
      if (key === "repair") add("Послуги OSM", taggedDetails("service:vehicle:"));
      if (key === "repair") add("Підстава категорії", repairEvidence(props));
      add("Дата зрізу джерела", props.sourceSnapshot || (props.sourceRecord === "geofabrik" ? localData?.metadata.snapshot : localData?.metadata.sources?.[props.sourceRecord]?.extractedAt));
      add("Роз’єми та потужність", props.connectors);
      add("Доступ за джерелом", props.usage);
      add("Перевірено джерелом", props.sourceVerified);
      add("Статус", props.sourceStatus);
      const source = document.createElement("small");
      source.textContent = props.sourceName ? `Джерело: ${props.sourceName} · ${props.sourceId} · ${props.license}` : `Джерело: OSM ${props.osmId}`;
      content.append(source);
      const routeButton = document.createElement("button");
      const actions = confirmedPaid ? document.createElement("div") : content;
      if (confirmedPaid) actions.className = "popup-parking-actions";
      routeButton.type = "button";
      routeButton.className = "popup-route-button";
      routeButton.textContent = "Прокласти маршрут";
      add("Маршрут", "Координати буде передано Geoapify. Дорожні дані можуть бути неповними.");
      routeButton.addEventListener("click", () => {
        onDestination(feature.geometry.coordinates, props.name || category.label);
        popup?.remove();
      });
      actions.append(routeButton);
      if (confirmedPaid) {
        const demo = document.createElement("p");
        demo.className = "popup-demo-note";
        demo.textContent = selected
          ? "Демо-вибір для вас. Фактичне місце не зарезервовано; наявність вільних місць невідома."
          : "Доступний демонстраційний вибір. Фактичне місце не резервується.";
        actions.append(demo);
        const bookingButton = document.createElement("button");
        bookingButton.type = "button";
        bookingButton.className = "popup-booking-button";
        bookingButton.textContent = selected ? "Скасувати бронювання" : "Забронювати";
        bookingButton.addEventListener("click", () => {
          if (disposed) return;
          if (selected) {
            const owner = reservation?.owner;
            reservation = undefined;
            showAvailable(eligible());
            cancelDestination(owner);
            openPopup(feature, key);
            return;
          }
          bookingButton.hidden = true;
          routeButton.hidden = true;
          demo.hidden = true;
          const confirmation = document.createElement("div");
          confirmation.className = "popup-booking-confirmation";
          confirmation.setAttribute("role", "group");
          confirmation.setAttribute("aria-label", "Підтвердження демонстраційного вибору парковки");
          const explanation = document.createElement("p");
          explanation.textContent = "Це демонстраційний вибір лише для вас, без резервування місця та оплати. Після підтвердження GPS-координати буде передано Geoapify для маршруту. Підтвердити?";
          const confirm = document.createElement("button");
          confirm.type = "button";
          confirm.className = "popup-booking-button";
          confirm.textContent = "Підтвердити демо-вибір";
          const dismiss = document.createElement("button");
          dismiss.type = "button";
          dismiss.className = "popup-booking-dismiss";
          dismiss.textContent = "Назад";
          confirm.addEventListener("click", () => {
            if (disposed || confirm.disabled) return;
            confirm.disabled = true;
            // Identity token prevents cancelling a later ordinary POI/map route,
            // even when it has exactly the same destination coordinates.
            const owner = {};
            reservation = { id: canonicalId(props.osmId), owner };
            showAvailable(eligible());
            onDestination(feature.geometry.coordinates, props.name || category.label, { owner });
            popup?.remove();
          });
          dismiss.addEventListener("click", () => openPopup(feature, key));
          confirmation.append(explanation); confirmation.append(confirm); confirmation.append(dismiss);
          actions.append(confirmation);
          confirm.focus?.();
          // Keep the confirmation in view inside the small mobile popup scroller.
          confirmation.scrollIntoView?.({ block: "nearest" });
        });
        actions.append(bookingButton);
        content.append(actions);
      }
      popup = new Popup({ maxWidth: "290px", className: "poi-popup" }).setLngLat(feature.geometry.coordinates).setDOMContent(content).addTo(map);
  }
  for (const key of Object.keys(CATEGORIES)) {
    const id = sourceId(key);
    listen("click", id, (event) => openPopup(event.features?.[0], key));
    listen("mouseenter", id, () => { map.getCanvas().style.cursor = "pointer"; });
    listen("mouseleave", id, () => { map.getCanvas().style.cursor = ""; });
  }

  function eligible() {
    return [...active].filter((key) => map.getZoom() >= CATEGORIES[key].zoom).sort();
  }
  function hint() {
    if (!active.size) return "Оберіть категорії. Точки з’являться після наближення карти.";
    return [...active].map((key) => `${CATEGORIES[key].label}: zoom ${CATEGORIES[key].zoom}+`).join(" · ");
  }
  function updateVisibility() {
    for (const key of Object.keys(CATEGORIES)) {
      if (map.getLayer(sourceId(key))) map.setLayoutProperty(sourceId(key), "visibility", active.has(key) ? "visible" : "none");
    }
  }
  function showAvailable(keys) {
    let count = 0;
    const bounds = map.getBounds();
    for (const key of keys) {
      const combined = new Map();
      for (const feature of liveFeatures.get(key) ?? []) {
        if (bounds.contains(feature.geometry.coordinates)) {
          const canonical = canonicalId(feature.properties.osmId);
          combined.set(canonical, feature);
        }
      }
      for (const feature of localByCategory.get(key) ?? []) {
        if (bounds.contains(feature.geometry.coordinates)) {
          const id = feature.id;
          if (!localInsideCache.has(id)) localInsideCache.set(id, insideUkraine(feature.geometry.coordinates, boundary.geometry));
          if (!localInsideCache.get(id)) continue;
          combined.set(id, feature);
        }
      }
      const features = [...combined.values()].map(feature => key === "paid" ? {
        ...feature, properties: { ...feature.properties, demoSelected: reservation?.id === canonicalId(feature.properties.osmId) },
      } : feature);
      map.getSource(sourceId(key))?.setData({ type: "FeatureCollection", features });
      count += combined.size;
    }
    return count;
  }
  function dailyRequestCount() {
    try {
      const saved = JSON.parse(localStorage.getItem(DAILY_COUNTER_KEY) || "null");
      return saved?.day === new Date().toISOString().slice(0, 10) ? saved.count : 0;
    } catch { return 0; }
  }
  function recordDailyRequest() {
    try {
      localStorage.setItem(DAILY_COUNTER_KEY, JSON.stringify({
        day: new Date().toISOString().slice(0, 10), count: dailyRequestCount() + 1,
      }));
    } catch { /* Private browsing can disable storage; session rate limiting still applies. */ }
  }
  function schedule() {
    revision += 1;
    clearTimeout(timer);
    clearTimeout(retryTimer);
    controller?.abort();
    popup?.remove();
    status.textContent = hint();
    timer = setTimeout(load, 700);
  }
  async function load() {
    if (disposed) return;
    const keys = eligible();
    if (!keys.length) return;
    const version = revision;
    const currentBounds = map.getBounds();
    const intersectsLocal = currentBounds.getEast() >= LOCAL_POI_BBOX[0] && currentBounds.getWest() <= LOCAL_POI_BBOX[2] &&
      currentBounds.getNorth() >= LOCAL_POI_BBOX[1] && currentBounds.getSouth() <= LOCAL_POI_BBOX[3];
    if (intersectsLocal) {
      await readLocal();
      if (version !== revision || disposed) return;
      if (keys.includes("charging") && !localError) {
        // Only the optional network wait needs an early render; cached pans render once.
        if (!chargingComplete) showAvailable(keys);
        await readExternalCharging();
      }
    }
    if (version !== revision || disposed) return;
    const bounds = map.getBounds();
    const availableCount = showAvailable(keys);
    if (localError && intersectsLocal) {
      status.textContent = "Не вдалося прочитати локальну базу POI. Збережені точки доступні; перезавантажте сторінку, щоб повторити завантаження.";
      return;
    }
    const fullyCovered = localData && boundsCovered(bounds, localData.metadata.bbox);
    if (fullyCovered) {
      status.textContent = `Львів · OSM${keys.includes("charging") && !chargingError ? " / OCM" : ""}: точок ${availableCount}. Видима область повністю покрита локальними даними.${keys.includes("charging") && chargingError ? " Додаткові зарядки OCM недоступні; точки OSM збережено." : ""}`;
      return;
    }
    // Limit queries to the visible bbox intersected with Ukraine's extent.
    const box = [Math.max(extent[0], Math.floor(bounds.getSouth() * 50) / 50),
      Math.max(extent[1], Math.floor(bounds.getWest() * 50) / 50),
      Math.min(extent[2], Math.ceil(bounds.getNorth() * 50) / 50),
      Math.min(extent[3], Math.ceil(bounds.getEast() * 50) / 50)];
    if (box[0] >= box[2] || box[1] >= box[3]) {
      status.textContent = "У цій області немає території України.";
      return;
    }
    if ((box[2] - box[0]) * (box[3] - box[1]) > 0.6) {
      status.textContent = "Наблизьте карту: область завелика для завантаження POI.";
      return;
    }
    const signature = `${keys.join(",")}:${box.map((n) => n.toFixed(5)).join(",")}`;
    let elements = cache.get(signature)?.elements;
    if (Date.now() - (cache.get(signature)?.time ?? 0) > 300000) elements = undefined;
    if (!elements) {
      if (requiresManualRetry) {
        status.textContent = "Overpass призупинено після повторних помилок. Збережені точки доступні; через 5 хвилин перемкніть категорію для нової спроби.";
        return;
      }
      if (Date.now() < nextRequestAt && Date.now() >= blockedUntil) {
        status.textContent = "Локальні точки доступні. Overpass тимчасово очікує перед наступним запитом.";
        timer = setTimeout(() => { if (revision === version && !disposed) load(); }, nextRequestAt - Date.now());
        return;
      }
      if (Date.now() < blockedUntil) {
        status.textContent = "Overpass тимчасово недоступний. Збережені точки залишаються на карті; нові запити призупинено на кілька хвилин.";
        return;
      }
      if (dailyRequestCount() >= DAILY_REQUEST_LIMIT) {
        status.textContent = "Досягнуто денний ліміт запитів POI в цьому браузері. Уже завантажені точки доступні; спробуйте завтра.";
        return;
      }
      controller = new AbortController();
      const request = controller;
      const timeout = setTimeout(() => request.abort(), 30000);
      status.textContent = "Завантаження об’єктів OpenStreetMap…";
      nextRequestAt = Date.now() + 5000;
      recordDailyRequest();
      try {
        const selectors = [...new Set(keys.flatMap((key) => [CATEGORIES[key].selector, ...(CATEGORIES[key].extraSelectors ?? [])]))];
        const query = `[out:json][timeout:25];(${selectors.map((selector) => `nwr${selector}(${box.join(",")});`).join("")});out body center;`;
        const response = await fetch(ENDPOINT, {
          method: "POST", body: new URLSearchParams({ data: query }), signal: request.signal,
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const result = await response.json();
        if (result.remark || !Array.isArray(result.elements)) throw new Error("Неповна відповідь Overpass");
        if (version !== revision || disposed) return;
        elements = result.elements;
        consecutiveFailures = 0;
        cache.set(signature, { time: Date.now(), elements });
        if (cache.size > 16) cache.delete(cache.keys().next().value);
      } catch (error) {
        if (version !== revision || disposed) return;
        const httpStatus = Number(error?.message.match(/^HTTP (\d+)$/)?.[1]);
        consecutiveFailures += 1;
        const backoff = httpStatus === 502 || httpStatus === 429 || httpStatus === 406 ||
          error?.name === "TimeoutError" || error?.name === "AbortError" ? 30000 : 15000;
        nextRequestAt = Date.now() + backoff;
        if ((httpStatus === 502 && consecutiveFailures >= 2) || consecutiveFailures >= 3) {
          blockedUntil = Date.now() + 5 * 60 * 1000;
          requiresManualRetry = true;
        }
        if (httpStatus === 502) {
          status.textContent = blockedUntil > Date.now()
            ? "Overpass відповів HTTP 502 повторно. Нові запити призупинено; через 5 хвилин перемкніть категорію. Наявні точки залишаються на карті."
            : "Overpass тимчасово відповів HTTP 502. Наявні точки залишаються на карті; одна повторна спроба через 30 секунд.";
          if (blockedUntil <= Date.now()) {
            retryTimer = setTimeout(() => { if (revision === version && !disposed) load(); }, backoff);
          }
        } else if (httpStatus === 406) {
          status.textContent = "Overpass відхилив запит (HTTP 406). Зачекайте щонайменше 30 секунд і спробуйте знову; уже завантажені точки збережено.";
        } else if (httpStatus === 429) {
          status.textContent = "Overpass обмежив частоту запитів (HTTP 429). Зачекайте щонайменше 30 секунд; уже завантажені точки збережено.";
        } else if (error?.name === "TimeoutError" || error?.name === "AbortError") {
          status.textContent = "Overpass не відповів вчасно. Зачекайте 30 секунд і спробуйте знову; уже завантажені точки збережено.";
        } else {
          status.textContent = `Не вдалося завантажити POI${httpStatus ? ` (HTTP ${httpStatus})` : " через мережеву помилку або CORS"}. Зачекайте ${backoff / 1000} секунд і спробуйте знову; уже завантажені точки збережено.`;
        }
        return;
      } finally { clearTimeout(timeout); }
    }
    if (version !== revision || disposed) return;
    for (const key of keys) {
      const data = toFeatures(elements, key, boundary.geometry);
      liveFeatures.set(key, data.features);
    }
    const count = showAvailable(keys);
    status.textContent = `Об’єктів: ${count}. ${hint()} Парковки без fee — з невідомою оплатою.`;
  }
  const clicks = buttons.map((button) => {
    const key = button.dataset.poi;
    button.disabled = false;
    button.querySelector(".tool-icon").style.color = CATEGORIES[key].color;
    const click = () => {
      if (active.has(key)) active.delete(key); else active.add(key);
      if (requiresManualRetry && Date.now() >= blockedUntil) {
        requiresManualRetry = false;
        consecutiveFailures = 0;
      }
      button.classList.toggle("active", active.has(key));
      button.setAttribute("aria-pressed", String(active.has(key)));
      updateVisibility(); schedule();
    };
    button.addEventListener("click", click);
    return [button, click];
  });
  listen("movestart", () => { revision += 1; controller?.abort(); clearTimeout(timer); clearTimeout(retryTimer); popup?.remove(); });
  listen("moveend", schedule);
  function dispose() {
    if (disposed) return;
    disposed = true; revision += 1; clearTimeout(timer); clearTimeout(retryTimer); controller?.abort(); popup?.remove(); cache.clear(); liveFeatures.clear(); localByCategory.clear(); localInsideCache.clear();
    dataRequests.forEach(request => request.abort()); dataRequests.clear(); localData = null;
    reservation = undefined;
    handlers.forEach((args) => map.off(...args));
    clicks.forEach(([button, click]) => button.removeEventListener("click", click));
    map.off("remove", dispose);
  }
  map.on("remove", dispose);
  status.textContent = hint();
  return { restoreStyle, dispose };
}
