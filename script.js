import {
  LngLatBounds,
  Map as MapLibreMap,
  NavigationControl,
} from "https://unpkg.com/maplibre-gl@6.16.0/dist/maplibre-gl.mjs";

const MAPTILER_STYLE = "https://api.maptiler.com/maps/streets-v4/style.json";
const MAPTILER_ROAD_SOURCE = "maptiler_planet_v4";
const MAPTILER_ROAD_SOURCE_LAYER = "road";
const UKRAINE_BOUNDARY_URL = "./data/ukraine-boundary.geojson";
const EMPTY_GEOJSON = { type: "FeatureCollection", features: [] };
const statusPill = document.querySelector(".map-status");
const statusText = document.querySelector("#map-status-text");
const mapError = document.querySelector("#map-error");

function setStatus(message, state = "") {
  statusText.textContent = message;
  statusPill.classList.remove("ready", "error");
  if (state) statusPill.classList.add(state);
}

function showMapError(message) {
  mapError.textContent = message;
  mapError.hidden = false;
  setStatus("Помилка карти", "error");
}

function signedArea(ring) {
  let area = 0;
  for (let i = 0; i < ring.length - 1; i += 1) {
    area += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1];
  }
  return area / 2;
}

function orientRing(input, counterClockwise) {
  const ring = input.map(([longitude, latitude]) => [longitude, latitude]);
  if (ring.length && (ring[0][0] !== ring.at(-1)[0] || ring[0][1] !== ring.at(-1)[1])) {
    ring.push([...ring[0]]);
  }
  const isCounterClockwise = signedArea(ring) > 0;
  return isCounterClockwise === counterClockwise ? ring : ring.reverse();
}

function normalizeBoundary(collection) {
  const feature = collection.features?.find((item) =>
    item.properties?.boundaryISO === "UKR" || item.properties?.shapeISO === "UKR",
  ) ?? collection.features?.[0];
  if (!feature?.geometry || !["Polygon", "MultiPolygon"].includes(feature.geometry.type)) {
    throw new Error("Джерело меж не повернуло полігон України.");
  }

  const polygons = feature.geometry.type === "Polygon"
    ? [feature.geometry.coordinates]
    : feature.geometry.coordinates;
  const orientedPolygons = polygons.map((rings) => [
    orientRing(rings[0], true),
    ...rings.slice(1).map((ring) => orientRing(ring, false)),
  ]);
  const geometry = feature.geometry.type === "Polygon"
    ? { type: "Polygon", coordinates: orientedPolygons[0] }
    : { type: "MultiPolygon", coordinates: orientedPolygons };
  return {
    data: { type: "Feature", properties: feature.properties ?? {}, geometry },
    outerRings: orientedPolygons.map(([outer]) => outer),
  };
}

function makeWorldMask(outerRings) {
  const world = [
    [-180, -85.051129], [180, -85.051129], [180, 85.051129],
    [-180, 85.051129], [-180, -85.051129],
  ];
  return {
    type: "Feature",
    properties: {},
    geometry: { type: "Polygon", coordinates: [world, ...outerRings.map((ring) => orientRing(ring, false))] },
  };
}

function boundsFor(geometry) {
  const bounds = new LngLatBounds();
  const visit = (coordinates) => {
    if (typeof coordinates?.[0] === "number") {
      bounds.extend(coordinates);
      return;
    }
    coordinates?.forEach(visit);
  };
  visit(geometry.coordinates);
  if (bounds.isEmpty()) throw new Error("Не вдалося визначити межі України.");
  return bounds;
}

function readMapTilerKey() {
  const key = window.PARKING_MAP_CONFIG?.mapTilerKey;
  if (typeof key !== "string" || !key.trim()) {
    throw new Error("Не налаштовано ключ MapTiler. Додайте GitHub Actions secret MAPTILER_KEY і повторно опублікуйте сайт.");
  }
  return key.trim();
}

function supportsWebGL2() {
  if (!("WebGL2RenderingContext" in window)) return false;
  try {
    const canvas = document.createElement("canvas");
    const context = canvas.getContext("webgl2", { failIfMajorPerformanceCaveat: false });
    if (!context) return false;
    context.getExtension("WEBGL_lose_context")?.loseContext();
    return true;
  } catch {
    return false;
  }
}

async function readUkraineBoundary() {
  const response = await fetch(UKRAINE_BOUNDARY_URL, { cache: "force-cache" });
  if (!response.ok) throw new Error(`Локальні дані кордону України: HTTP ${response.status}.`);
  return normalizeBoundary(await response.json());
}

function applyUkraineOnlyStyle(map, boundary, mask) {
  const styleLayers = map.getStyle().layers ?? [];
  const roadSource = map.getSource(MAPTILER_ROAD_SOURCE);
  if (!roadSource) throw new Error(`MapTiler vector source "${MAPTILER_ROAD_SOURCE}" is missing.`);

  const roadLayers = styleLayers.filter((layer) =>
    layer.source === MAPTILER_ROAD_SOURCE &&
    layer["source-layer"] === MAPTILER_ROAD_SOURCE_LAYER &&
    layer.type === "line",
  );
  if (!roadLayers.length) {
    throw new Error(`MapTiler style has no line layers for source-layer "${MAPTILER_ROAD_SOURCE_LAYER}".`);
  }
  const malformedRoadLayers = roadLayers.filter((layer) => !layer.paint?.["line-width"]);
  if (malformedRoadLayers.length) {
    throw new Error(`Road layers are missing zoom/class line-width styling: ${malformedRoadLayers.map(({ id }) => id).join(", ")}`);
  }

  for (const layer of styleLayers) {
    if (layer.type === "background") {
      map.setPaintProperty(layer.id, "background-color", "#080F25");
    }
  }

  for (const layer of roadLayers) {
    // Keep MapTiler's class filters, zoom stops, bridge/tunnel order and road casing.
    map.setPaintProperty(layer.id, "line-color", "#BABABA");
  }

  if (map.getSource("ukraine-boundary")) {
    map.getSource("ukraine-boundary").setData(boundary);
  } else {
    map.addSource("ukraine-boundary", { type: "geojson", data: boundary });
  }
  if (map.getSource("ukraine-mask")) {
    map.getSource("ukraine-mask").setData(mask);
  } else {
    map.addSource("ukraine-mask", { type: "geojson", data: mask });
  }

  const firstMapLayer = styleLayers.find((layer) => layer.type !== "background");
  if (!map.getLayer("ukraine-territory")) {
    map.addLayer({
      id: "ukraine-territory", type: "fill", source: "ukraine-boundary",
      paint: { "fill-color": "#2B325E", "fill-opacity": 1 },
    }, firstMapLayer?.id);
  }
  if (!map.getLayer("outside-ukraine")) {
    map.addLayer({
      id: "outside-ukraine", type: "fill", source: "ukraine-mask",
      paint: { "fill-color": "#080F25" },
    });
  }
  if (!map.getLayer("ukraine-outline")) {
    map.addLayer({
      id: "ukraine-outline", type: "line", source: "ukraine-boundary",
      paint: { "line-color": "#E3E8F5", "line-width": 1.1, "line-opacity": 0.95 },
    });
  }

  return MAPTILER_ROAD_SOURCE;
}

async function startMap() {
  try {
    setStatus("Підключення MapTiler");
    const mapTilerKey = readMapTilerKey();
    if (!supportsWebGL2()) {
      throw new Error("Цей браузер або пристрій не підтримує WebGL2, потрібний для відображення карти.");
    }
    setStatus("Завантаження меж України");
    const { data: boundary, outerRings } = await readUkraineBoundary();
    const mask = makeWorldMask(outerRings);
    const bounds = boundsFor(boundary.geometry);
    const styleUrl = `${MAPTILER_STYLE}?key=${encodeURIComponent(mapTilerKey)}`;
    const map = new MapLibreMap({
      container: "interactive-map",
      style: styleUrl,
      center: [31.0, 48.5],
      zoom: 4.5,
      minZoom: 3.3,
      maxZoom: 20,
      renderWorldCopies: false,
      attributionControl: { compact: true },
      dragRotate: false,
      touchPitch: false,
      cooperativeGestures: false,
      fadeDuration: 120,
    });

    map.addControl(new NavigationControl({ showCompass: false, showZoom: true }), "top-right");
    let sourceHasLoaded = false;
    map.on("error", (event) => {
      const error = event.error;
      console.error("MapLibre / MapTiler:", error?.message ?? error ?? event);
      const status = error?.status ?? error?.statusCode;
      if (status === 401 || status === 403) {
        showMapError("MapTiler відхилив ключ. Перевірте GitHub Actions secret MAPTILER_KEY та дозволені для ключа адреси сайту.");
      } else if (status === 429) {
        showMapError("MapTiler тимчасово обмежив запити. Перевірте ліміт використання ключа.");
      } else if (status === 404) {
        showMapError("MapTiler не знайшов стиль або тайл. Перевірте URL стилю та доступність сервісу.");
      } else if (!sourceHasLoaded && error) {
        showMapError("Не вдалося отримати стиль або векторні тайли MapTiler. Перевірте інтернет, ключ та мережеві запити в консолі браузера.");
      }
    });

    map.once("style.load", () => {
      try {
        setStatus("Налаштування карти");
        const roadSource = applyUkraineOnlyStyle(map, boundary, mask);
        map.fitBounds(bounds, { padding: { top: 72, right: 54, bottom: 72, left: 54 }, maxZoom: 5.3, duration: 0 });
        map.on("sourcedata", (event) => {
          if (event.sourceId === roadSource && event.isSourceLoaded) {
            sourceHasLoaded = true;
            mapError.hidden = true;
            setStatus("Карта України · MapTiler", "ready");
          }
        });
        map.once("idle", () => {
          if (!sourceHasLoaded) {
            showMapError("Стиль завантажено, але векторні тайли доріг не надійшли. Перевірте HTTP-помилки MapTiler у консолі браузера.");
          }
        });
        map.resize();
      } catch (error) {
        console.error("Не вдалося оформити карту України:", error);
        showMapError(error.message || "Не вдалося налаштувати шари карти.");
      }
    });
  } catch (error) {
    console.error("Не вдалося запустити карту:", error);
    showMapError(error.message || "Не вдалося завантажити карту.");
  }
}

startMap();
