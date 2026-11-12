import { type CSSProperties, useEffect, useRef } from "react";
import {
  Cartesian2,
  Cartesian3,
  Cartographic,
  Color,
  Ellipsoid,
  JulianDate,
} from "@cesium/core";
import {
  CesiumWidget,
  Credit,
  CreditDisplay,
  GeographicTilingScheme,
  ImageryLayer,
  ScreenSpaceEventType,
  TileProviderError,
  UrlTemplateImageryProvider,
} from "@cesium/engine";
import "@cesium/engine/Source/Widget/CesiumWidget.css";
import { CAMERA_INPUT_SETTINGS, CAMERA_ZOOM_STEP_RATIO, moveCameraToGlobalView } from "../cameraMotion";
import { startSubtleGlobeRotation, type GlobeAutoRotationController } from "../globeAutoRotation";
import { MarkerProjection } from "../markerProjection";
import { prefersReducedMotion } from "../motion";
import { configureSolarLighting, SOLAR_RENDER_INTERVAL_SECONDS } from "../solarLighting";
import { createStarSkyBox } from "../starSkyBox";
import type { PublicMessage } from "../types";
import { Icon } from "./Icon";

const mapTilerApiKey = import.meta.env.VITE_MAPTILER_API_KEY?.trim() ?? "";
const mapTilerCredit = new Credit(
  '<a href="https://www.maptiler.com/copyright/" target="_blank" rel="noopener noreferrer">© MapTiler</a> '
    + '<a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">© OpenStreetMap contributors</a>',
  true,
);
CreditDisplay.cesiumCredit = new Credit("", true);
const detailedImageryZoomDistance = 4_000_000;
const nasaFallbackZoomDistance = 12_500_000;

function addLocalEarthImagery(viewer: CesiumWidget, container: HTMLElement): () => void {
  const provider = new UrlTemplateImageryProvider({
    url: "/earth/tiles/{z}/{x}/{y}.jpg",
    tileWidth: 512,
    tileHeight: 512,
    minimumLevel: 0,
    maximumLevel: 2,
    tilingScheme: new GeographicTilingScheme(),
    hasAlphaChannel: false,
  });
  const layer = viewer.imageryLayers.addImageryProvider(provider);
  let isActive = true;
  let hasPendingTiles = false;
  let hasLoadedTexture = false;
  let hasFailedTiles = false;
  let postRenderSequence = 0;
  let readyAfterPostRender = Number.POSITIVE_INFINITY;
  let removeProgressListener = () => {};
  let removePostRenderListener = () => {};
  let removeReadyRenderListener = () => {};

  const markTextureLoaded = () => {
    if (!isActive || hasLoadedTexture || hasFailedTiles || !hasPendingTiles) return;
    hasLoadedTexture = true;
    container.dataset.earthTexture = "loaded";
    readyAfterPostRender = postRenderSequence + 1;
    viewer.resize();
    viewer.scene.requestRender();
    removeProgressListener();
    removePostRenderListener();
  };

  removeReadyRenderListener = viewer.scene.postRender.addEventListener(() => {
    if (!isActive || viewer.isDestroyed()) return;
    postRenderSequence += 1;
    if (container.dataset.earthTexture !== "loaded" || postRenderSequence < readyAfterPostRender) return;
    container.dataset.globeReady = "true";
    removeReadyRenderListener();
  });
  removeProgressListener = viewer.scene.globe.tileLoadProgressEvent.addEventListener((pendingTiles) => {
    if (!isActive || viewer.isDestroyed()) return;
    if (pendingTiles > 0) {
      hasPendingTiles = true;
      return;
    }
    markTextureLoaded();
  });
  // Read the current queue once per rendered frame while tiles are pending in requestRenderMode.
  removePostRenderListener = viewer.scene.postRender.addEventListener(() => {
    if (!isActive || viewer.isDestroyed()) return;
    if (!viewer.scene.globe.tilesLoaded) {
      hasPendingTiles = true;
      return;
    }
    markTextureLoaded();
  });
  const removeErrorListener = provider.errorEvent.addEventListener((error: TileProviderError) => {
    if (!isActive || viewer.isDestroyed()) return;
    hasFailedTiles = true;
    container.dataset.earthTexture = "failed";
    removeReadyRenderListener();
    console.error("Local NASA imagery tile failed", error);
  });

  return () => {
    isActive = false;
    removeProgressListener();
    removePostRenderListener();
    removeReadyRenderListener();
    removeErrorListener();
    if (!viewer.isDestroyed()) viewer.imageryLayers.remove(layer, true);
  };
}

function addMapTilerSatelliteLayer(viewer: CesiumWidget, container: HTMLElement): () => void {
  const provider = new UrlTemplateImageryProvider({
    url: `https://api.maptiler.com/maps/satellite-v4/{z}/{x}/{y}.jpg?key=${encodeURIComponent(mapTilerApiKey)}`,
    tileWidth: 512,
    tileHeight: 512,
    minimumLevel: 4,
    maximumLevel: 22,
    hasAlphaChannel: false,
  });
  const layer: ImageryLayer = viewer.imageryLayers.addImageryProvider(provider);
  let failedTiles = 0;
  let isActive = true;
  let hasVisibleCredit = false;
  let removeErrorListener = () => {};
  let removeCameraListener = () => {};

  layer.show = false;
  container.dataset.imageryStatus = "awaiting-zoom";

  const updateVisibility = () => {
    if (!isActive || viewer.isDestroyed()) return;
    const shouldShow = viewer.camera.positionCartographic.height <= detailedImageryZoomDistance;
    if (layer.show === shouldShow) return;

    layer.show = shouldShow;
    container.dataset.imagerySource = shouldShow ? "maptiler" : "nasa";
    container.dataset.imageryStatus = shouldShow ? "configured" : "awaiting-zoom";
    if (shouldShow) {
      viewer.creditDisplay.addStaticCredit(mapTilerCredit);
      hasVisibleCredit = true;
    } else if (hasVisibleCredit) {
      viewer.creditDisplay.removeStaticCredit(mapTilerCredit);
      hasVisibleCredit = false;
    }
    viewer.scene.requestRender();
  };

  const removeLayer = () => {
    if (!isActive) return;
    isActive = false;
    removeErrorListener();
    removeCameraListener();
    if (hasVisibleCredit) viewer.creditDisplay.removeStaticCredit(mapTilerCredit);
  };

  removeErrorListener = provider.errorEvent.addEventListener((error: TileProviderError) => {
    if (!isActive || viewer.isDestroyed() || !layer.show) return;
    if (error.timesRetried < 2) {
      error.retry = true;
      return;
    }

    failedTiles += 1;
    if (failedTiles < 3) return;

    viewer.imageryLayers.remove(layer, true);
    removeLayer();
    container.dataset.imagerySource = "nasa-fallback";
    container.dataset.imageryStatus = "recovering";
    viewer.scene.screenSpaceCameraController.minimumZoomDistance = 2_500_000;
    const cameraPosition = viewer.camera.positionCartographic;
    viewer.camera.flyTo({
      destination: Cartesian3.fromRadians(
        cameraPosition.longitude,
        cameraPosition.latitude,
        window.matchMedia("(max-width: 760px)").matches ? 15_000_000 : nasaFallbackZoomDistance,
      ),
      duration: 0.7,
      complete: () => {
        if (viewer.isDestroyed()) return;
        container.dataset.imageryStatus = "provider-unavailable";
        viewer.scene.requestRender();
      },
    });
    viewer.scene.requestRender();
  });

  removeCameraListener = viewer.camera.changed.addEventListener(updateVisibility);
  updateVisibility();
  return removeLayer;
}

type GlobeCanvasProps = {
  messages: PublicMessage[];
  expiringIds: Set<string>;
  theme: "dark" | "light";
  errorText: string;
  markersLabel: string;
  controlsLabel: string;
  zoomInLabel: string;
  zoomOutLabel: string;
  resetViewLabel: string;
  pickingLocation: boolean;
  onVisibleCellsChange: (cells: string[]) => void;
  onLocationPick: (latitude: number, longitude: number) => void;
  onMessageSelect: (message: PublicMessage) => void;
};

export function GlobeCanvas({ messages, expiringIds, theme, errorText, markersLabel, controlsLabel, zoomInLabel, zoomOutLabel, resetViewLabel, pickingLocation, onVisibleCellsChange, onLocationPick, onMessageSelect }: GlobeCanvasProps) {
  const mountRef = useRef<HTMLDivElement>(null);
  const creditsRef = useRef<HTMLDivElement>(null);
  const viewerRef = useRef<CesiumWidget | null>(null);
  const autoRotationRef = useRef<GlobeAutoRotationController | null>(null);
  const messagesRef = useRef(messages);
  const pickingRef = useRef(pickingLocation);
  const themeRef = useRef(theme);
  const callbacksRef = useRef({ onVisibleCellsChange, onLocationPick, onMessageSelect });
  const markerRefs = useRef(new Map<string, HTMLDivElement>());

  function handleZoomIn() {
    const viewer = viewerRef.current;
    if (!viewer || viewer.isDestroyed()) return;
    autoRotationRef.current?.pauseForUserInput();
    viewer.camera.zoomIn(viewer.camera.positionCartographic.height * CAMERA_ZOOM_STEP_RATIO);
  }

  function handleZoomOut() {
    const viewer = viewerRef.current;
    if (!viewer || viewer.isDestroyed()) return;
    autoRotationRef.current?.pauseForUserInput();
    viewer.camera.zoomOut(viewer.camera.positionCartographic.height * CAMERA_ZOOM_STEP_RATIO);
  }

  function handleResetView() {
    const viewer = viewerRef.current;
    if (!viewer || viewer.isDestroyed()) return;
    autoRotationRef.current?.pauseForUserInput();
    const altitude = window.matchMedia("(max-width: 760px)").matches ? 15_000_000 : 12_500_000;
    const reducedMotion = prefersReducedMotion();
    moveCameraToGlobalView(viewer.camera, Cartesian3.fromDegrees(27, 32, altitude), reducedMotion);
    if (reducedMotion) viewer.scene.requestRender();
  }

  useEffect(() => {
    messagesRef.current = messages;
    viewerRef.current?.scene.requestRender();
  }, [messages]);
  useEffect(() => { pickingRef.current = pickingLocation; }, [pickingLocation]);
  useEffect(() => {
    themeRef.current = theme;
    const viewer = viewerRef.current;
    if (!viewer || viewer.isDestroyed()) return;
    viewer.scene.backgroundColor = Color.fromCssColorString(theme === "dark" ? "#08141d" : "#e8eeeb");
    viewer.scene.requestRender();
  }, [theme]);
  useEffect(() => { callbacksRef.current = { onVisibleCellsChange, onLocationPick, onMessageSelect }; }, [onVisibleCellsChange, onLocationPick, onMessageSelect]);

  useEffect(() => {
    const container = mountRef.current;
    if (!container) return;
    const globeAltitude = window.matchMedia("(max-width: 760px)").matches ? 15_000_000 : 12_500_000;
    let removeMapTilerLayer: (() => void) | undefined;
    let removeEarthImagery: (() => void) | undefined;

    let viewer: CesiumWidget;
    try {
      viewer = new CesiumWidget(container, {
        baseLayer: false,
        scene3DOnly: true,
        skyBox: createStarSkyBox(),
        creditContainer: creditsRef.current ?? undefined,
        requestRenderMode: true,
        maximumRenderTimeChange: SOLAR_RENDER_INTERVAL_SECONDS,
        orderIndependentTranslucency: false,
      });
    } catch (error) {
      console.error("Unable to initialize Cesium globe", error);
      container.dataset.error = errorText;
      container.classList.add("globe-failed");
      return;
    }

    viewerRef.current = viewer;
    try {
      viewer.resolutionScale = 1;
      viewer.scene.backgroundColor = Color.fromCssColorString(themeRef.current === "dark" ? "#08141d" : "#e8eeeb");
      if (viewer.scene.skyBox) viewer.scene.skyBox.show = true;
      viewer.scene.globe.baseColor = Color.fromCssColorString("#183b4b");
      configureSolarLighting(viewer.scene.globe, viewer.clock);
      viewer.scene.globe.showGroundAtmosphere = true;
      viewer.scene.globe.atmosphereLightIntensity = 8;
      viewer.scene.globe.depthTestAgainstTerrain = false;
      const cameraController = viewer.scene.screenSpaceCameraController;
      cameraController.maximumMovementRatio = CAMERA_INPUT_SETTINGS.maximumMovementRatio;
      cameraController.inertiaSpin = CAMERA_INPUT_SETTINGS.inertiaSpin;
      cameraController.inertiaZoom = CAMERA_INPUT_SETTINGS.inertiaZoom;
      cameraController.zoomFactor = CAMERA_INPUT_SETTINGS.zoomFactor;
      viewer.scene.screenSpaceCameraController.minimumZoomDistance = mapTilerApiKey ? 750 : 2_500_000;
      viewer.scene.screenSpaceCameraController.maximumZoomDistance = 50_000_000;
      container.dataset.imagerySource = "nasa";
      container.dataset.imageryStatus = "local";
      container.dataset.earthTexture = "loading";
      container.dataset.starfield = viewer.scene.skyBox?.show ? "visible" : "hidden";
      container.dataset.globeLighting = viewer.scene.globe.enableLighting
        && viewer.scene.globe.dynamicAtmosphereLightingFromSun
        ? "solar"
        : "disabled";
      container.dataset.solarTime = JulianDate.toIso8601(viewer.clock.currentTime);
      viewer.camera.setView({ destination: Cartesian3.fromDegrees(27, 32, globeAltitude) });
      removeEarthImagery = addLocalEarthImagery(viewer, container);
      if (mapTilerApiKey) {
        try {
          removeMapTilerLayer = addMapTilerSatelliteLayer(viewer, container);
        } catch (error) {
          container.dataset.imagerySource = "nasa";
          container.dataset.imageryStatus = "provider-error";
          console.error("MapTiler imagery could not be initialized", error);
        }
      }
      viewer.scene.requestRender();
    } catch (error) {
      console.error("Unable to configure Cesium globe", error);
      viewer.destroy();
      viewerRef.current = null;
      container.dataset.error = errorText;
      container.classList.add("globe-failed");
      return;
    }

    const autoRotation = startSubtleGlobeRotation(
      viewer.camera,
      viewer.scene,
      container,
      container.parentElement ?? container,
    );
    autoRotationRef.current = autoRotation;

    const markerProjection = new MarkerProjection({
      viewer,
      container,
      messagesRef,
      markerRefs,
      callbacksRef,
    });

    const onCanvasClick = (movement: { position: Cartesian2 }) => {
      if (!pickingRef.current) return;
      const picked = viewer.camera.pickEllipsoid(movement.position, Ellipsoid.WGS84);
      if (!picked) return;
      const cartographic = Cartographic.fromCartesian(picked);
      callbacksRef.current.onLocationPick(
        (cartographic.latitude * 180) / Math.PI,
        (cartographic.longitude * 180) / Math.PI,
      );
    };

    viewer.screenSpaceEventHandler.setInputAction(onCanvasClick, ScreenSpaceEventType.LEFT_CLICK);
    const removePostRender = viewer.scene.postRender.addEventListener(markerProjection.update);
    const resizeObserver = new ResizeObserver(() => {
      viewer.resize();
      markerProjection.resize();
      viewer.scene.requestRender();
    });
    resizeObserver.observe(container);

    return () => {
      autoRotation.destroy();
      if (autoRotationRef.current === autoRotation) autoRotationRef.current = null;
      resizeObserver.disconnect();
      removePostRender();
      removeMapTilerLayer?.();
      removeEarthImagery?.();
      viewer.destroy();
      viewerRef.current = null;
    };
  }, []);

  return (
    <>
      <div className={`globe-canvas-wrap${pickingLocation ? " globe-canvas-wrap--picking" : ""}`}>
        <div className="globe-canvas" ref={mountRef} />
        <div className="globe-attribution" ref={creditsRef} />
        <div className="globe-markers" aria-label={markersLabel}>
          {messages.slice(0, 5).map((message, index) => (
            <div
              key={message.id}
              className={`globe-marker globe-marker--${index + 1}${expiringIds.has(message.id) ? " globe-marker--expiring" : ""}`}
              ref={(node) => {
                if (node) markerRefs.current.set(message.id, node);
                else markerRefs.current.delete(message.id);
              }}
            >
              <span className="globe-marker__halo" />
              <span className="globe-marker__stem" />
              <button
                className="globe-marker__card"
                type="button"
                aria-label={`${message.authorName}: ${message.body}`}
                title={`${message.authorHandle}: ${message.body}`}
                onClick={() => callbacksRef.current.onMessageSelect(message)}
              >
                <span className="globe-marker__avatar" style={{ "--avatar-color": message.avatarColor } as CSSProperties}>{message.initials}</span>
                <span className="globe-marker__copy"><strong>{message.authorHandle}</strong><small>{message.body}</small></span>
                <span className="globe-marker__spark" />
              </button>
              <span className="globe-marker__point" />
            </div>
          ))}
        </div>
      </div>
      <div className="globe-controls" aria-label={controlsLabel}>
        <button type="button" aria-label={zoomInLabel} data-globe-zoom="in" onClick={handleZoomIn}>+</button>
        <button type="button" aria-label={zoomOutLabel} data-globe-zoom="out" onClick={handleZoomOut}>−</button>
        <button type="button" aria-label={resetViewLabel} data-globe-home onClick={handleResetView}>
          <Icon name="compass" />
        </button>
      </div>
    </>
  );
}
