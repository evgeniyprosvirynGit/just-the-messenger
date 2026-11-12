import { Cartesian2, Cartesian3, Ellipsoid, EllipsoidalOccluder } from "@cesium/core";
import type { CesiumWidget } from "@cesium/engine";
import { geohashCellsForView } from "./geo";
import { createMarkerCardLayouts, placeMarkerCards, type MarkerCardLayout } from "./markerLayout";
import type { PublicMessage } from "./types";

const MAX_GLOBE_MARKERS = 5;
const MARKER_HEIGHT_METERS = 50_000;
const VISIBLE_CELL_UPDATE_INTERVAL_MS = 160;

type CurrentValue<T> = { current: T };

type ProjectionCallbacks = {
  onVisibleCellsChange: (cells: string[]) => void;
};

type MarkerPosition = {
  latitude: number;
  longitude: number;
  world: Cartesian3;
  screen: Cartesian2;
};

type MarkerProjectionOptions = {
  viewer: CesiumWidget;
  container: HTMLElement;
  messagesRef: CurrentValue<PublicMessage[]>;
  markerRefs: CurrentValue<Map<string, HTMLDivElement>>;
  callbacksRef: CurrentValue<ProjectionCallbacks>;
};

/** Projects a bounded set of public messages into the non-React globe overlay. */
export class MarkerProjection {
  private readonly occluder = new EllipsoidalOccluder(Ellipsoid.WGS84);
  private readonly markerPositions = new Map<string, MarkerPosition>();
  private readonly markerLayouts = createMarkerCardLayouts(MAX_GLOBE_MARKERS);
  private readonly activeMarkerIds = new Set<string>();
  private readonly markerVisibility = new WeakMap<HTMLDivElement, boolean>();
  private markerCardWidth = 226;
  private markerCardHeight = 62;
  private lastCellKey = "";
  private lastCellUpdate = 0;

  constructor(private readonly options: MarkerProjectionOptions) {
    this.resize();
  }

  readonly update = () => {
    const { container, messagesRef, viewer } = this.options;
    const currentMessages = messagesRef.current;
    const markerCount = Math.min(currentMessages.length, MAX_GLOBE_MARKERS);
    const canvasWidth = container.clientWidth;
    const canvasHeight = container.clientHeight;

    this.activeMarkerIds.clear();
    this.occluder.cameraPosition = viewer.camera.positionWC;
    this.projectMarkerPositions(currentMessages, markerCount, canvasWidth, canvasHeight);
    this.layoutVisibleCards(markerCount, canvasWidth, canvasHeight);
    this.paintVisibleMarkers(currentMessages, markerCount);
    this.removeInactivePositions();
    this.updateVisibleCells();
  };

  resize() {
    const viewportWidth = window.innerWidth;
    this.markerCardWidth = viewportWidth <= 760 ? 140 : viewportWidth <= 1120 ? 205 : 226;
    this.markerCardHeight = viewportWidth <= 760 ? 48 : 62;
  }

  private projectMarkerPositions(
    currentMessages: PublicMessage[],
    markerCount: number,
    canvasWidth: number,
    canvasHeight: number,
  ) {
    const { markerRefs, viewer } = this.options;

    for (let index = 0; index < markerCount; index += 1) {
      const message = currentMessages[index];
      const marker = markerRefs.current.get(message.id);
      const layout = this.markerLayouts[index];
      this.resetLayoutForMessage(layout, message.id);
      this.activeMarkerIds.add(message.id);

      if (!marker) {
        layout.visible = false;
        continue;
      }

      const position = this.getMarkerPosition(message);
      const screenPosition = viewer.scene.cartesianToCanvasCoordinates(position.world, position.screen);
      const visible = screenPosition !== undefined
        && this.occluder.isPointVisible(position.world)
        && screenPosition.x >= -40
        && screenPosition.y >= -20
        && screenPosition.x <= canvasWidth + 40
        && screenPosition.y <= canvasHeight + 20;

      layout.x = screenPosition?.x ?? 0;
      layout.y = screenPosition?.y ?? 0;
      layout.visible = visible;
      this.setMarkerVisibility(marker, visible);
    }
  }

  private resetLayoutForMessage(layout: MarkerCardLayout, messageID: string) {
    if (layout.messageId === messageID) return;
    layout.messageId = messageID;
    layout.lastAnchorX = Number.NaN;
    layout.lastAnchorY = Number.NaN;
    layout.lastLabelLeft = Number.NaN;
    layout.lastLabelTop = Number.NaN;
  }

  private getMarkerPosition(message: PublicMessage) {
    let position = this.markerPositions.get(message.id);
    if (position && position.latitude === message.latitude && position.longitude === message.longitude) {
      return position;
    }

    position = {
      latitude: message.latitude,
      longitude: message.longitude,
      world: new Cartesian3(),
      screen: new Cartesian2(),
    };
    Cartesian3.fromDegrees(message.longitude, message.latitude, MARKER_HEIGHT_METERS, Ellipsoid.WGS84, position.world);
    this.markerPositions.set(message.id, position);
    return position;
  }

  private setMarkerVisibility(marker: HTMLDivElement, visible: boolean) {
    if (this.markerVisibility.get(marker) === visible) return;
    marker.style.visibility = visible ? "visible" : "hidden";
    this.markerVisibility.set(marker, visible);
  }

  private layoutVisibleCards(markerCount: number, canvasWidth: number, canvasHeight: number) {
    placeMarkerCards(
      this.markerLayouts,
      markerCount,
      this.markerCardWidth,
      this.markerCardHeight,
      canvasWidth,
      canvasHeight,
    );
  }

  private paintVisibleMarkers(currentMessages: PublicMessage[], markerCount: number) {
    const { markerRefs } = this.options;

    for (let index = 0; index < markerCount; index += 1) {
      const message = currentMessages[index];
      const marker = markerRefs.current.get(message.id);
      const layout = this.markerLayouts[index];
      if (!marker || !layout.visible) continue;

      this.updateMarkerAnchor(marker, layout);
      this.updateMarkerLabel(marker, layout);
    }
  }

  private updateMarkerAnchor(marker: HTMLDivElement, layout: MarkerCardLayout) {
    if (layout.x === layout.lastAnchorX && layout.y === layout.lastAnchorY) return;
    marker.style.transform = `translate3d(${layout.x}px, ${layout.y}px, 0)`;
    layout.lastAnchorX = layout.x;
    layout.lastAnchorY = layout.y;
  }

  private updateMarkerLabel(marker: HTMLDivElement, layout: MarkerCardLayout) {
    const labelLeft = layout.left - layout.x;
    const labelTop = layout.top - layout.y;
    if (labelLeft === layout.lastLabelLeft && labelTop === layout.lastLabelTop) return;

    const leaderX = Math.max(labelLeft, Math.min(0, labelLeft + this.markerCardWidth));
    const leaderY = Math.max(labelTop, Math.min(0, labelTop + this.markerCardHeight));
    const leaderLength = Math.hypot(leaderX, leaderY);
    const leaderAngle = Math.atan2(-leaderY, -leaderX);

    marker.style.setProperty("--marker-card-left", `${labelLeft}px`);
    marker.style.setProperty("--marker-card-top", `${labelTop}px`);
    marker.style.setProperty("--marker-leader-left", `${leaderX}px`);
    marker.style.setProperty("--marker-leader-top", `${leaderY}px`);
    marker.style.setProperty("--marker-leader-length", `${leaderLength}px`);
    marker.style.setProperty("--marker-leader-angle", `${leaderAngle}rad`);
    layout.lastLabelLeft = labelLeft;
    layout.lastLabelTop = labelTop;
  }

  private removeInactivePositions() {
    for (const id of this.markerPositions.keys()) {
      if (!this.activeMarkerIds.has(id)) this.markerPositions.delete(id);
    }
  }

  private updateVisibleCells() {
    const now = performance.now();
    if (this.lastCellUpdate !== 0 && now - this.lastCellUpdate < VISIBLE_CELL_UPDATE_INTERVAL_MS) return;
    this.lastCellUpdate = now;

    const { viewer } = this.options;
    const view = viewer.camera.computeViewRectangle(Ellipsoid.WGS84);
    if (!view) return;

    const cells = geohashCellsForView(view.west, view.south, view.east, view.north).sort();
    const key = cells.join(",");
    if (key === this.lastCellKey) return;
    this.lastCellKey = key;
    this.options.callbacksRef.current.onVisibleCellsChange(cells);
  }
}
