// Independent OSM overlays. No MapTiler layers or sources are modified here.
export const CATEGORIES = {
  parking: { label: "Парковки", zoom: 13, selector: '["amenity"="parking"]', color: "#53E6E1" },
  paid: { label: "Платні парковки", zoom: 13, selector: '["amenity"="parking"]["fee"="yes"]', color: "#FFD279" },
  charging: { label: "Електрозаправки", zoom: 11, selector: '["amenity"="charging_station"]', color: "#A1E69A" },
  fuel: { label: "Заправки", zoom: 11, selector: '["amenity"="fuel"]', color: "#F6A474" },
  repair: { label: "СТО", zoom: 12, selector: '["shop"="car_repair"]', color: "#B8A7FF" },
};
const ENDPOINT = "https://overpass-api.de/api/interpreter";
const DAILY_REQUEST_LIMIT = 30;
const DAILY_COUNTER_KEY = "parking-map-overpass-daily";
const empty = () => ({ type: "FeatureCollection", features: [] });

export function insideUkraine(point, geometry) {
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
  return polygons.some(([outer, ...holes]) => inRing(outer) && !holes.some(inRing));
}

export function matchesCategory(tags, key) {
  if (key === "parking") return tags.amenity === "parking" && tags.fee !== "yes";
  if (key === "paid") return tags.amenity === "parking" && tags.fee === "yes";
  if (key === "repair") return tags.shop === "car_repair";
  return tags.amenity === (key === "charging" ? "charging_station" : "fuel");
}

export function toFeatures(elements, key, geometry) {
  const unique = new Map();
  for (const element of elements) {
    const tags = element.tags ?? {};
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

export function setupPoi(map, boundary, Popup) {
  const status = document.querySelector("#poi-status");
  const buttons = [...document.querySelectorAll("[data-poi]")];
  const active = new Set();
  let localData = null;
  const localPromise = fetch("./data/lviv-poi.geojson", { cache: "force-cache" })
    .then((response) => {
      if (!response.ok) throw new Error(`Local POI HTTP ${response.status}`);
      return response.json();
    })
    .then((data) => {
      if (data.type !== "FeatureCollection" || !Array.isArray(data.features) ||
          !Array.isArray(data.metadata?.bbox)) throw new Error("Invalid local POI GeoJSON");
      localData = data;
    })
    .catch(() => { /* Outside the local extract, Overpass remains available. */ });
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
  let timer, controller, popup, revision = 0, nextRequestAt = 0, disposed = false;
  const handlers = [];
  const listen = (...args) => { map.on(...args); handlers.push(args); };
  const sourceId = (key) => `parking-map-poi-${key}`;

  for (const [key, category] of Object.entries(CATEGORIES)) {
    const id = sourceId(key);
    if (!map.getSource(id)) map.addSource(id, {
      type: "geojson", data: empty(),
      attribution: 'POI © <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap contributors</a>',
    });
    if (!map.getLayer(id)) map.addLayer({
      id, type: "circle", source: id, minzoom: category.zoom,
      layout: { visibility: "none" },
      paint: {
        "circle-radius": ["interpolate", ["linear"], ["zoom"], 11, 4, 16, 6, 20, 8],
        "circle-color": category.color, "circle-stroke-color": "#10182C",
        "circle-stroke-width": 2, "circle-opacity": 0.95,
      },
    }, "outside-ukraine");
    listen("click", id, (event) => {
      const feature = event.features?.[0];
      if (!feature) return;
      popup?.remove();
      const props = feature.properties;
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
      add("Тип", category.label);
      add("Адреса", [props["addr:city"], props["addr:street"], props["addr:housenumber"]].filter(Boolean).join(", "));
      add("Оплата", props.fee === "yes" ? "Платно" : props.fee === "no" ? "Безкоштовно" : props.fee || (key === "parking" ? "Невідома" : ""));
      add("Умови оплати", props["fee:conditional"]);
      add("Доступ", props.access);
      add("Оператор", props.operator);
      add("Години роботи", props.opening_hours);
      const link = document.createElement("a");
      link.textContent = "Об’єкт в OpenStreetMap";
      link.href = `https://www.openstreetmap.org/${props.osmId}`;
      link.target = "_blank"; link.rel = "noopener noreferrer";
      content.append(link);
      popup = new Popup({ maxWidth: "290px" }).setLngLat(feature.geometry.coordinates).setDOMContent(content).addTo(map);
    });
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
      map.setLayoutProperty(sourceId(key), "visibility", active.has(key) ? "visible" : "none");
    }
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
    controller?.abort();
    popup?.remove();
    status.textContent = hint();
    timer = setTimeout(load, Math.max(700, nextRequestAt - Date.now()));
  }
  async function load() {
    if (disposed) return;
    const keys = eligible();
    if (!keys.length) return;
    const version = revision;
    await localPromise;
    if (version !== revision || disposed) return;
    const center = map.getCenter();
    const withinLocalArea = localData?.metadata.bbox.some(([west, south, east, north]) =>
      center.lng >= west && center.lng <= east && center.lat >= south && center.lat <= north);
    if (withinLocalArea) {
      let count = 0;
      for (const key of keys) {
        const features = localData.features.filter((feature) =>
          feature.properties?.category === key &&
          insideUkraine(feature.geometry.coordinates, boundary.geometry));
        map.getSource(sourceId(key)).setData({ type: "FeatureCollection", features });
        count += features.length;
      }
      status.textContent = `Львів · OSM: ${count} об’єктів у двох ділянках центру. Дані за межами цих ділянок можуть бути відсутніми.`;
      return;
    }
    const bounds = map.getBounds();
    // Limit queries to the visible bbox intersected with Ukraine's extent.
    const box = [Math.max(extent[0], Math.floor(bounds.getSouth() * 50) / 50),
      Math.max(extent[1], Math.floor(bounds.getWest() * 50) / 50),
      Math.min(extent[2], Math.ceil(bounds.getNorth() * 50) / 50),
      Math.min(extent[3], Math.ceil(bounds.getEast() * 50) / 50)];
    if (box[0] >= box[2] || box[1] >= box[3]) {
      keys.forEach((key) => map.getSource(sourceId(key)).setData(empty()));
      status.textContent = "У цій області немає території України.";
      return;
    }
    if ((box[2] - box[0]) * (box[3] - box[1]) > 0.6) {
      status.textContent = "Наблизьте карту: область завелика для завантаження POI.";
      keys.forEach((key) => map.getSource(sourceId(key)).setData(empty()));
      return;
    }
    const signature = `${keys.join(",")}:${box.map((n) => n.toFixed(5)).join(",")}`;
    let elements = cache.get(signature)?.elements;
    if (Date.now() - (cache.get(signature)?.time ?? 0) > 300000) elements = undefined;
    if (!elements) {
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
        const selectors = [...new Set(keys.map((key) => CATEGORIES[key].selector))];
        const query = `[out:json][timeout:25];(${selectors.map((selector) => `nwr${selector}(${box.join(",")});`).join("")});out body center;`;
        const response = await fetch(ENDPOINT, {
          method: "POST", body: new URLSearchParams({ data: query }), signal: request.signal,
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const result = await response.json();
        if (result.remark || !Array.isArray(result.elements)) throw new Error("Неповна відповідь Overpass");
        elements = result.elements;
        cache.set(signature, { time: Date.now(), elements });
        if (cache.size > 16) cache.delete(cache.keys().next().value);
      } catch (error) {
        if (version !== revision || disposed) return;
        const httpStatus = Number(error?.message.match(/^HTTP (\d+)$/)?.[1]);
        const backoff = httpStatus === 429 || httpStatus === 406 || error?.name === "TimeoutError" || error?.name === "AbortError" ? 30000 : 15000;
        nextRequestAt = Date.now() + backoff;
        if (httpStatus === 406) {
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
    let count = 0;
    for (const key of keys) {
      const data = toFeatures(elements, key, boundary.geometry);
      map.getSource(sourceId(key)).setData(data);
      count += data.features.length;
    }
    status.textContent = `Об’єктів: ${count}. ${hint()} Парковки без fee — з невідомою оплатою.`;
  }
  const clicks = buttons.map((button) => {
    const key = button.dataset.poi;
    button.disabled = false;
    button.querySelector(".tool-icon").style.color = CATEGORIES[key].color;
    const click = () => {
      if (active.has(key)) active.delete(key); else active.add(key);
      button.classList.toggle("active", active.has(key));
      button.setAttribute("aria-pressed", String(active.has(key)));
      updateVisibility(); schedule();
    };
    button.addEventListener("click", click);
    return [button, click];
  });
  listen("movestart", () => { revision += 1; controller?.abort(); clearTimeout(timer); popup?.remove(); });
  listen("moveend", schedule);
  map.once("remove", () => {
    disposed = true; revision += 1; clearTimeout(timer); controller?.abort(); popup?.remove(); cache.clear();
    handlers.forEach((args) => map.off(...args));
    clicks.forEach(([button, click]) => button.removeEventListener("click", click));
  });
  status.textContent = hint();
}
