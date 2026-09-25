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
  scene.screenSpaceCameraController.enableCollisionDetection = true;
  scene.screenSpaceCameraController.minimumZoomDistance = 40;

  onStatus('tiles');
  const { tileset, route } = await loadPhotorealisticTileset(Cesium, {
    googleApiKey,
    cesiumToken,
  });
  if (tileset) {
    scene.primitives.add(tileset);
  } else {
    // Keyless fallback: OpenStreetMap on the ellipsoid.
    scene.globe.show = true;
    viewer.imageryLayers.addImageryProvider(
      new Cesium.OpenStreetMapImageryProvider({
        url: 'https://tile.openstreetmap.org/',
      }),
    );
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
          material:
            seg.mode === 'WALK'
              ? new Cesium.PolylineDashMaterialProperty({ color, dashLength: 14 })
              : new Cesium.PolylineOutlineMaterialProperty({
                  color,
                  outlineColor: Cesium.Color.fromCssColorString('rgba(0,0,0,.6)'),
                  outlineWidth: 2,
                }),
        },
      });
    }
    scene.requestRender();
  }

  function flyTo({ lat, lon, height = 700, heading = 20, pitch = -40, duration = 1.8 }) {
    viewer.camera.flyTo({
      destination: Cesium.Cartesian3.fromDegrees(lon, lat, height),
      orientation: {
        heading: Cesium.Math.toRadians(heading),
        pitch: Cesium.Math.toRadians(pitch),
        roll: 0,
      },
      duration,
    });
  }

  /** Frame two points (e.g. hotel and destination). */
  function flyToBounds(points, { padding = 1.35, duration = 1.8 } = {}) {
    const lats = points.map((p) => p.lat);
    const lons = points.map((p) => p.lon);
    const rect = Cesium.Rectangle.fromDegrees(
      Math.min(...lons), Math.min(...lats), Math.max(...lons), Math.max(...lats),
    );
    const center = Cesium.Rectangle.center(rect);
    const spanM = Math.max(
      Cesium.Rectangle.computeWidth(rect) * 6371000,
      Cesium.Rectangle.computeHeight(rect) * 6371000,
      400,
    );
    viewer.camera.flyTo({
      destination: Cesium.Cartesian3.fromRadians(
        center.longitude,
        center.latitude - Cesium.Math.toRadians(spanM / 6371000 / 2.4),
        spanM * padding,
      ),
      orientation: {
        heading: 0,
        pitch: Cesium.Math.toRadians(-52),
        roll: 0,
      },
      duration,
    });
  }

  function setHome({ lat, lon, height, heading, pitch }) {
    viewer.camera.setView({
      destination: Cesium.Cartesian3.fromDegrees(lon, lat, height),
      orientation: {
        heading: Cesium.Math.toRadians(heading),
        pitch: Cesium.Math.toRadians(pitch),
        roll: 0,
      },
    });
  }

  const api = {
    onPick,
    viewer,
    Cesium,
    tilesRoute: route,
    addMarker,
    removeMarkers,
    setSelected,
    drawRoute,
    clearRoute,
    flyTo,
    flyToBounds,
    setHome,
  };
  return api;
}
