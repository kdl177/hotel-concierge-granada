/**
 * The 3D map for the guest app: Cesium viewer, Google Photorealistic 3D Tiles
 * when a key is configured (OSM imagery otherwise), place markers, route lines
 * and camera moves. Reuses the viewer factory and tileset loader of the base
 * project so behaviour matches the original console.
 */
import * as Cesium from 'cesium';
import { createApplicationViewer } from '../app/viewer.js';
import { loadPhotorealisticTileset } from '../maps/google3d.js';

const MARKER_COLORS = {
  hotel: '#f5b642',
  poi: '#ffffff',
  result: '#7dd3fc',
  selected: '#ff5c7a',
  stop: '#ff9f43',
};

function markerSvg(fill, glyph = '') {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="44" height="56" viewBox="0 0 44 56">
    <path d="M22 54C22 54 4 32.5 4 20a18 18 0 0 1 36 0c0 12.5-18 34-18 34z" fill="${fill}" stroke="rgba(0,0,0,.45)" stroke-width="2"/>
    <circle cx="22" cy="20" r="7" fill="rgba(0,0,0,.55)"/>
    ${glyph}
  </svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

export async function createGlobe({
  container,
  googleApiKey = '',
  cesiumToken = '',
  onStatus = () => {},
  onPick = () => {},
}) {
  const creditContainer = document.createElement('div');
  creditContainer.id = 'cesium-credits';
  document.body.appendChild(creditContainer);

  const viewer = createApplicationViewer({ container, creditContainer });
  const { scene } = viewer;
  const lowEnd =
    window.matchMedia('(max-width: 899px)').matches ||
    (navigator.hardwareConcurrency || 8) <= 4 ||
    (navigator.deviceMemory || 8) <= 4;

  // Render only when something changed (camera, data, animation) instead of
  // 60 fps forever: the single biggest CPU/GPU saver for a mostly static map.
  scene.requestRenderMode = true;
  scene.maximumRenderTimeChange = Infinity;
  viewer.targetFrameRate = lowEnd ? 30 : 60;
  viewer.useBrowserRecommendedResolution = true;
  viewer.resolutionScale = lowEnd ? 0.85 : 1;
  scene.msaaSamples = lowEnd ? 1 : 2;
  scene.postProcessStages.fxaa.enabled = !lowEnd;
  scene.skyAtmosphere.show = !lowEnd;
  scene.fog.enabled = true;
  scene.globe.enableLighting = false;
  scene.screenSpaceCameraController.enableCollisionDetection = true;
  scene.screenSpaceCameraController.minimumZoomDistance = 40;
  scene.screenSpaceCameraController.inertiaSpin = 0.7;
  scene.screenSpaceCameraController.inertiaTranslate = 0.7;

  onStatus('tiles');
  const { tileset, route } = await loadPhotorealisticTileset(Cesium, {
    googleApiKey,
    cesiumToken,
  });
  if (tileset) {
    // Coarser tiles on phones: far fewer requests and triangles.
    tileset.maximumScreenSpaceError = lowEnd ? 28 : 16;
    tileset.cacheBytes = lowEnd ? 256 * 1024 * 1024 : 768 * 1024 * 1024;
    tileset.skipLevelOfDetail = true;
    tileset.dynamicScreenSpaceError = true;
    tileset.dynamicScreenSpaceErrorFactor = lowEnd ? 8 : 4;
    tileset.foveatedScreenSpaceError = true;
    scene.primitives.add(tileset);
  } else {
    // Keyless fallback: OpenStreetMap on the ellipsoid.
    scene.globe.show = true;
    viewer.imageryLayers.addImageryProvider(
      new Cesium.OpenStreetMapImageryProvider({
        url: 'https://tile.openstreetmap.org/',
        maximumLevel: 19,
      }),
    );
    scene.globe.maximumScreenSpaceError = lowEnd ? 3 : 2;
    scene.globe.tileCacheSize = lowEnd ? 60 : 120;
  }

  const markers = viewer.entities;
  const routeSource = new Cesium.CustomDataSource('routes');
  await viewer.dataSources.add(routeSource);

  const handler = new Cesium.ScreenSpaceEventHandler(scene.canvas);
  handler.setInputAction(({ position }) => {
    const picked = scene.pick(position);
    const id = picked?.id;
    if (id?.properties?.conciergeId) api.onPick?.(id.properties.conciergeId.getValue());
  }, Cesium.ScreenSpaceEventType.LEFT_CLICK);

  const clamp = tileset
    ? Cesium.HeightReference.CLAMP_TO_3D_TILE
    : Cesium.HeightReference.CLAMP_TO_GROUND;

  function addMarker({ id, lat, lon, label, kind = 'poi' }) {
    scene.requestRender();
    markers.removeById(`marker:${id}`); // idempotent: a transfer stop can appear twice
    return markers.add({
      id: `marker:${id}`,
      position: Cesium.Cartesian3.fromDegrees(lon, lat, 0),
      properties: { conciergeId: id, kind },
      billboard: {
        image: markerSvg(MARKER_COLORS[kind] || MARKER_COLORS.poi),
        width: kind === 'hotel' ? 44 : kind === 'stop' ? 24 : 34,
        height: kind === 'hotel' ? 56 : kind === 'stop' ? 31 : 44,
        verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
        heightReference: clamp,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
        scaleByDistance: new Cesium.NearFarScalar(500, 1.2, 12000, 0.6),
      },
      label: {
        text: label,
        font: '600 13px Inter, sans-serif',
        fillColor: Cesium.Color.WHITE,
        outlineColor: Cesium.Color.fromCssColorString('rgba(0,0,0,.85)'),
        outlineWidth: 4,
        style: Cesium.LabelStyle.FILL_AND_OUTLINE,
        verticalOrigin: Cesium.VerticalOrigin.TOP,
        pixelOffset: new Cesium.Cartesian2(0, 4),
        heightReference: clamp,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
        scaleByDistance: new Cesium.NearFarScalar(500, 1, 12000, 0.5),
        translucencyByDistance: new Cesium.NearFarScalar(3000, 1, 15000, 0),
      },
    });
  }

  function setSelected(id) {
    for (const entity of markers.values) {
      const kind = entity.properties?.kind?.getValue();
      if (!kind || kind === 'hotel') continue;
      const isSel = entity.properties.conciergeId.getValue() === id;
      entity.billboard.image = markerSvg(
        isSel ? MARKER_COLORS.selected : MARKER_COLORS[kind],
      );
    }
    scene.requestRender();
  }

  function removeMarkers(kind) {
    for (const entity of [...markers.values]) {
      if (entity.properties?.kind?.getValue() === kind) markers.remove(entity);
    }
    scene.requestRender();
  }

  function clearRoute() {
    routeSource.entities.removeAll();
    scene.requestRender();
  }

  /**
   * Draw a route: `segments` = [{ coords: [[lon,lat],...], mode, color }].
   */
  function drawRoute(segments) {
    clearRoute();
    for (const seg of segments) {
      if (!seg.coords?.length) continue;
      const flat = seg.coords.flatMap(([lon, lat]) => [lon, lat]);
      const color = Cesium.Color.fromCssColorString(seg.color || '#4cc3ff');
      routeSource.entities.add({
        polyline: {
          positions: Cesium.Cartesian3.fromDegreesArray(flat),
          width: seg.mode === 'WALK' ? 6 : 9,
          clampToGround: true,
          material: seg.mode === 'WALK' ? color.withAlpha(0.85) : color,
        },
      });
    }
    scene.requestRender();
  }

  // ---------- ground height ----------
  // Google 3D tiles sit at real elevation (Granada ≈ 700 m above sea level),
  // so every camera target must be placed on the ground, not at height 0.
  const heightCache = new Map();
  let baseHeight = 0;
  const cartoKey = (lat, lon) => `${lat.toFixed(4)},${lon.toFixed(4)}`;
  async function groundHeight(lat, lon) {
    const key = cartoKey(lat, lon);
    if (heightCache.has(key)) return heightCache.get(key);
    let h = null;
    try {
      if (tileset && scene.sampleHeightSupported) {
        const [c] = await Promise.race([
          scene.sampleHeightMostDetailed([Cesium.Cartographic.fromDegrees(lon, lat)], routeExclusions()),
          new Promise((r) => setTimeout(() => r([null]), 2500)),
        ]);
        if (c && Number.isFinite(c.height)) h = c.height;
      } else if (scene.globe.show) {
        const g = scene.globe.getHeight(Cesium.Cartographic.fromDegrees(lon, lat));
        if (Number.isFinite(g)) h = g;
      }
    } catch {}
    if (h === null) return baseHeight; // not cached: retry once tiles are loaded
    heightCache.set(key, h);
    return h;
  }
  // Don't let our own route lines / markers be mistaken for the ground.
  function routeExclusions() {
    return [...routeSource.entities.values, ...guideSource.entities.values, ...markers.values];
  }
  async function calibrate(lat, lon) {
    const h = await groundHeight(lat, lon);
    if (h) baseHeight = h;
    return h;
  }

  // ---------- camera ----------
  let flightToken = 0;
  /** Centre `target` on screen, seen from `heading`/`pitch` at `range` metres. */
  async function lookAt({ lat, lon, heading = 0, pitch = -40, range = 600, duration = 1.4 }) {
    const token = ++flightToken;
    const h = await groundHeight(lat, lon);
    if (token !== flightToken) return; // a newer request superseded this one
    viewer.camera.cancelFlight();
    viewer.camera.flyToBoundingSphere(new Cesium.BoundingSphere(Cesium.Cartesian3.fromDegrees(lon, lat, h), 1), {
      offset: new Cesium.HeadingPitchRange(Cesium.Math.toRadians(heading), Cesium.Math.toRadians(pitch), range),
      duration,
      easingFunction: Cesium.EasingFunction.QUADRATIC_IN_OUT,
    });
  }

  /** Kept for callers: interpret `height` as viewing distance around the point. */
  function flyTo({ lat, lon, height = 900, heading = 20, pitch = -40, duration = 1.8 }) {
    return lookAt({ lat, lon, heading, pitch, range: height, duration });
  }

  /** Frame a set of points (hotel + destination, or a whole route). */
  async function flyToBounds(points, { duration = 1.6, pitch = -55 } = {}) {
    const pts = points.filter((p) => Number.isFinite(p?.lat) && Number.isFinite(p?.lon));
    if (!pts.length) return;
    const token = ++flightToken;
    const h = await groundHeight(pts[0].lat, pts[0].lon);
    if (token !== flightToken) return;
    const sphere = Cesium.BoundingSphere.fromPoints(pts.map((p) => Cesium.Cartesian3.fromDegrees(p.lon, p.lat, h)));
    const range = Math.max(450, sphere.radius * (lowEnd ? 3.4 : 3));
    viewer.camera.cancelFlight();
    viewer.camera.flyToBoundingSphere(sphere, {
      offset: new Cesium.HeadingPitchRange(0, Cesium.Math.toRadians(pitch), range),
      duration,
      easingFunction: Cesium.EasingFunction.QUADRATIC_IN_OUT,
    });
  }

  /** Frame a drawn route by its geometry (all vertices), not just its ends. */
  function flyToRoute(coords, extra = []) {
    const step = Math.max(1, Math.floor(coords.length / 60));
    const pts = coords.filter((_, i) => i % step === 0).map(([lon, lat]) => ({ lat, lon }));
    return flyToBounds([...pts, ...extra]);
  }

  async function setHome({ lat, lon, height = 900, heading = 35, pitch = -38 }) {
    const h = await calibrate(lat, lon);
    const center = Cesium.Cartesian3.fromDegrees(lon, lat, h);
    viewer.camera.lookAt(center, new Cesium.HeadingPitchRange(Cesium.Math.toRadians(heading), Cesium.Math.toRadians(pitch), height));
    viewer.camera.lookAtTransform(Cesium.Matrix4.IDENTITY); // release the lock so the user can move freely
  }

  // ---------- step-by-step guide on the map ----------
  const guideSource = new Cesium.CustomDataSource('guide');
  viewer.dataSources.add(guideSource);
  const pointClamp = tileset ? Cesium.HeightReference.CLAMP_TO_3D_TILE : Cesium.HeightReference.CLAMP_TO_GROUND;

  /** Numbered dots for every step; `current` is enlarged and its segment highlighted. */
  function showGuide(steps, current) {
    guideSource.entities.removeAll();
    steps.forEach((s, i) => {
      const isCur = i === current;
      const done = i < current;
      guideSource.entities.add({
        position: Cesium.Cartesian3.fromDegrees(s.lon, s.lat),
        point: {
          pixelSize: isCur ? 26 : 16,
          color: Cesium.Color.fromCssColorString(isCur ? '#f5b642' : done ? '#6b7280' : '#4cc3ff'),
          outlineColor: Cesium.Color.fromCssColorString('#0b1020'),
          outlineWidth: 3,
          heightReference: pointClamp,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        },
        label: {
          text: String(i + 1),
          font: `700 ${isCur ? 14 : 11}px Inter, sans-serif`,
          fillColor: Cesium.Color.fromCssColorString('#0b1020'),
          heightReference: pointClamp,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
          verticalOrigin: Cesium.VerticalOrigin.CENTER,
          horizontalOrigin: Cesium.HorizontalOrigin.CENTER,
        },
      });
    });
    const seg = steps[current]?.seg;
    if (seg?.length > 1) {
      guideSource.entities.add({
        polyline: {
          positions: Cesium.Cartesian3.fromDegreesArray(seg.flatMap(([lon, lat]) => [lon, lat])),
          width: 12,
          clampToGround: true,
          material: Cesium.Color.fromCssColorString('#f5b642'),
          zIndex: 10,
        },
      });
    }
    scene.requestRender();
  }
  function clearGuide() {
    guideSource.entities.removeAll();
    scene.requestRender();
  }

  const api = {
    onPick,
    viewer,
    Cesium,
    lowEnd,
    tilesRoute: route,
    addMarker,
    removeMarkers,
    setSelected,
    drawRoute,
    clearRoute,
    flyTo,
    lookAt,
    flyToBounds,
    flyToRoute,
    setHome,
    showGuide,
    clearGuide,
    groundHeight,
  };
  return api;
}
