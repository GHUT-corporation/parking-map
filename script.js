import { setupPoi } from "./poi.js?v=20261105-demo-occupancy";
import { setupNavigation } from "./navigation.js?v=20261105-demo-occupancy";
import {
  LngLatBounds,
  Map as MapLibreMap,
  Marker,
  NavigationControl,
  Popup,
} from "https://unpkg.com/maplibre-gl@6.16.0/dist/maplibre-gl.mjs";

const MAPTILER_STYLE = "https://api.maptiler.com/maps/streets-v4/style.json";
const MAPTILER_ROAD_SOURCE = "maptiler_planet_v4";
const MAPTILER_ROAD_SOURCE_LAYER = "road";
const MAPTILER_POI_SOURCE_LAYERS = new Set([
  "poi_accommodation",
  "poi_culture",
  "poi_education",
  "poi_food",
  "poi_healthcare",
  "poi_public",
  "poi_shopping",
  "poi_sport",
  "poi_station",
  "poi_tourism",
  "poi_transport",
  "street_furniture",
]);
const UKRAINE_BOUNDARY_URL = "./data/ukraine-boundary.geojson";
const EMPTY_GEOJSON = { type: "FeatureCollection", features: [] };
const statusText = document.querySelector("#map-status-text");
const mapError = document.querySelector("#map-error");

function setStatus(message) {
  statusText.textContent = message;
}

function showMapError(message) {
  mapError.textContent = safeMapError(message);
  mapError.hidden = false;
  setStatus("Помилка карти");
}

function safeMapError(error) {
  return String(error?.message ?? error ?? "Невідома помилка")
    .replace(/([?&](?:api)?key=)[^\s&#"'<>]+/gi, "$1[hidden]");
}

function signedArea(ring) {
  let area = 0;
  for (let i = 0; i < ring.length - 1; i += 1) {
    area += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1];
  }
  return area / 2;
}

function orientRing(input, counterClockwise) {
  if (!Array.isArray(input) || input.length < 3 || input.some(point => !Array.isArray(point) || point.length < 2 ||
      !Number.isFinite(point[0]) || !Number.isFinite(point[1]) || Math.abs(point[0]) > 180 || Math.abs(point[1]) > 90)) {
    throw new Error("Некоректні координати полігона України.");
  }
  const ring = input.map(([longitude, latitude]) => [longitude, latitude]);
  if (ring.length && (ring[0][0] !== ring.at(-1)[0] || ring[0][1] !== ring.at(-1)[1])) {
    ring.push([...ring[0]]);
  }
  if (ring.length < 4 || signedArea(ring) === 0) throw new Error("Порожній або вироджений полігон України.");
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
  if (!orientedPolygons.length) throw new Error("Джерело меж містить порожній полігон України.");
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

function rewriteExpressionGet(expression, field, replacement) {
  if (!Array.isArray(expression)) return expression;
  if (
    expression[0] === "coalesce" &&
    expression.length === 3 &&
    Array.isArray(expression[1]) &&
    expression[1][0] === "to-number" &&
    expression[1].length === 2 &&
    Array.isArray(expression[1][1]) &&
    expression[1][1][0] === "get" &&
    expression[1][1][1] === field &&
    expression[2] === 0
  ) return expression;
  if (expression.length === 2 && expression[0] === "get" && expression[1] === field) {
    return replacement();
  }
  return expression.map((item) => rewriteExpressionGet(item, field, replacement));
}

function transformMapTilerStyle(_previousStyle, nextStyle) {
  if (!Array.isArray(nextStyle?.layers)) return nextStyle;

  let changed = false;
  const layers = nextStyle.layers.map((layer) => {
    let transformedLayer = layer;

    if (layer.source === MAPTILER_ROAD_SOURCE && MAPTILER_POI_SOURCE_LAYERS.has(layer["source-layer"])) {
      transformedLayer = {
        ...transformedLayer,
        layout: { ...transformedLayer.layout, visibility: "none" },
      };
      changed = true;
    }

    if (layer.id === "Sea labels" && layer.layout?.["text-size"]) {
      const textSize = rewriteExpressionGet(
        layer.layout["text-size"],
        "lenght",
        () => ["coalesce", ["to-number", ["get", "length"]], 0],
      );
      if (JSON.stringify(textSize) !== JSON.stringify(layer.layout["text-size"])) {
        transformedLayer = {
          ...transformedLayer,
          layout: { ...transformedLayer.layout, "text-size": textSize },
        };
        changed = true;
      }
    }

    if (layer.id === "Disputed country labels" && layer.paint?.["text-opacity"]) {
      const textOpacity = rewriteExpressionGet(
        layer.paint["text-opacity"],
        "rank",
        () => ["coalesce", ["to-number", ["get", "rank"]], 0],
      );
      if (JSON.stringify(textOpacity) !== JSON.stringify(layer.paint["text-opacity"])) {
        transformedLayer = {
          ...transformedLayer,
          paint: { ...transformedLayer.paint, "text-opacity": textOpacity },
        };
        changed = true;
      }
    }

    return transformedLayer;
  });

  return changed ? { ...nextStyle, layers } : nextStyle;
}

async function readUkraineBoundary() {
  const request = new AbortController();
  const timeout = setTimeout(() => request.abort(), 30000);
  try {
    const response = await fetch(UKRAINE_BOUNDARY_URL, { cache: "force-cache", signal: request.signal });
    if (!response.ok) throw new Error(`Локальні дані кордону України: HTTP ${response.status}.`);
    return normalizeBoundary(await response.json());
  } catch (error) {
    if (error?.name === "AbortError") throw new Error("Час очікування локальних меж України вичерпано. Перевірте з’єднання та перезавантажте сторінку.");
    throw error;
  } finally { clearTimeout(timeout); }
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

  const poiLayers = styleLayers.filter((layer) =>
    layer.source === MAPTILER_ROAD_SOURCE &&
    MAPTILER_POI_SOURCE_LAYERS.has(layer["source-layer"]),
  );
  if (!poiLayers.length) {
    throw new Error("MapTiler Streets style contains no recognized POI source layers.");
  }
  const protectedLayers = new Set(["road", "road_label", "road_exit"]);
  const accidentalRoadLayers = poiLayers.filter((layer) => protectedLayers.has(layer["source-layer"]));
  if (accidentalRoadLayers.length) {
    throw new Error(`Refusing to hide road layers: ${accidentalRoadLayers.map(({ id }) => id).join(", ")}`);
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
  for (const layer of poiLayers) map.setLayoutProperty(layer.id, "visibility", "none");

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

function setupMobilePalette(map) {
  const media = window.matchMedia("(max-width: 768px), (hover: none) and (pointer: coarse) and (max-height: 500px)");
  const changes = [];
  // These source-layer names were checked against the actual Streets v4 JSON.
  // Capture all original expressions so switching back restores the desktop style.
  for (const layer of map.getStyle().layers) {
    if (layer.source !== MAPTILER_ROAD_SOURCE) continue;
    const sourceLayer = layer["source-layer"];
    const add = (property, color) => changes.push({ id: layer.id, property, original: map.getPaintProperty(layer.id, property) ?? null, color });
    if (layer.type === "fill") add("fill-color", sourceLayer === "water" ? "#454560" : sourceLayer === "building" ? "#2D2D49" : sourceLayer === "pedestrian" ? "#34354E" : "#23263E");
    if (layer.type === "fill" && sourceLayer === "building") add("fill-outline-color", "#414361");
    if (layer.type === "fill-extrusion" && sourceLayer === "building") add("fill-extrusion-color", "#2D2D49");
    if (layer.type === "line" && ["waterway", "pathway", "railway"].includes(sourceLayer)) add("line-color", sourceLayer === "waterway" ? "#585878" : "#7C7D99");
    if (layer.type === "symbol" && layer.layout?.["text-field"]) {
      add("text-color", "#D9D5E9"); add("text-halo-color", "#25263F");
    }
  }
  const apply = () => {
    for (const { id, property, original, color } of changes) {
      if (map.getLayer(id)) map.setPaintProperty(id, property, media.matches ? color : original);
    }
  };
  apply(); media.addEventListener("change", apply);
  const dispose = () => { media.removeEventListener("change", apply); map.off("remove", dispose); };
  map.on("remove", dispose);
  return dispose;
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
    const styleUrl = `${MAPTILER_STYLE}?key=${encodeURIComponent(mapTilerKey)}`;
    const map = new MapLibreMap({
      container: "interactive-map",
      style: styleUrl,
      transformStyle: transformMapTilerStyle,
      center: [24.0297, 49.8397],
      zoom: 13,
      minZoom: 3.3,
      maxZoom: 20,
      renderWorldCopies: false,
      attributionControl: { compact: true },
      dragRotate: false,
      touchPitch: false,
      cooperativeGestures: false,
      fadeDuration: 120,
    });

    // Preserve MapTiler's intentional blank and text-only fallback for records with no shield length.
    const transparentFallbackIds = new Set([" ", "transportation:road_"]);
    map.setMissingStyleImageResolver((id) => {
      if (!transparentFallbackIds.has(id) || map.hasImage(id)) return;
      // Streets' default/transportation sprites are SDF; a bitmap fallback mixes
      // incompatible icon types in the same road-shield buffer.
      map.addImage(id, { width: 1, height: 1, data: new Uint8Array([0, 0, 0, 0]) }, { sdf: true });
    });

    map.addControl(new NavigationControl({ showCompass: false, showZoom: true }), "top-right");
    // CSS switches the existing UI; this observer only resizes the same map canvas.
    let resizeFrame;
    const viewportObserver = new ResizeObserver(() => {
      cancelAnimationFrame(resizeFrame);
      resizeFrame = requestAnimationFrame(() => map.resize());
    });
    viewportObserver.observe(document.querySelector(".map-viewport"));
    const compass = document.querySelector("#map-compass");
    const renderCompass = () => compass.style.setProperty("--north-angle", `${-map.getBearing()}deg`);
    const resetNorth = () => map.rotateTo(0, { duration: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 300 });
    compass.addEventListener("click", resetNorth);
    map.on("rotate", renderCompass);
    renderCompass();
    map.once("remove", () => {
      viewportObserver.disconnect(); cancelAnimationFrame(resizeFrame);
      compass.removeEventListener("click", resetNorth); map.off("rotate", renderCompass);
    });
    let sourceHasLoaded = false;
    map.on("error", (event) => {
      const error = event.error;
      console.error("MapLibre / MapTiler:", safeMapError(error ?? event));
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

    let navigation, poi, disposePalette, pendingIdle, roadSource;
    map.on("sourcedata", (event) => {
      if (event.sourceId === roadSource && event.isSourceLoaded) {
        sourceHasLoaded = true;
        mapError.hidden = true;
        setStatus("Карта завантажена");
      }
    });
    const initializeStyle = () => {
      try {
        sourceHasLoaded = false;
        if (pendingIdle) map.off("idle", pendingIdle);
        disposePalette?.();
        setStatus("Налаштування карти");
        roadSource = applyUkraineOnlyStyle(map, boundary, mask);
        disposePalette = setupMobilePalette(map);
        pendingIdle = () => {
          if (!sourceHasLoaded) {
            showMapError("Стиль завантажено, але векторні тайли доріг не надійшли. Перевірте HTTP-помилки MapTiler у консолі браузера.");
          }
        };
        map.once("idle", pendingIdle);
        if (navigation) navigation.restoreStyle();
        else navigation = setupNavigation(map, { Marker, LngLatBounds, boundary });
        if (poi) poi.restoreStyle();
        else poi = setupPoi(map, boundary, Popup, navigation.setDestination, { cancelDestination: navigation.clearDestinationFor });
        if (map.isSourceLoaded(roadSource)) {
          sourceHasLoaded = true; mapError.hidden = true; setStatus("Карта завантажена");
        }
        map.resize();
      } catch (error) {
        console.error("Не вдалося оформити карту України:", safeMapError(error));
        showMapError(error.message || "Не вдалося налаштувати шари карти.");
      }
    };
    map.on("style.load", initializeStyle);
    map.once("remove", () => { disposePalette?.(); map.off("style.load", initializeStyle); if (pendingIdle) map.off("idle", pendingIdle); });
  } catch (error) {
    console.error("Не вдалося запустити карту:", safeMapError(error));
    showMapError(error.message || "Не вдалося завантажити карту.");
  }
}

startMap();
