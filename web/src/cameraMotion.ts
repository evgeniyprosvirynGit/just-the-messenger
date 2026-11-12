import type { Cartesian3 } from "@cesium/core";
import type { Camera } from "@cesium/engine";

export type CameraMotionCommands = Pick<Camera, "flyTo" | "setView">;

export const CAMERA_ZOOM_STEP_RATIO = 0.16;
export const CAMERA_INPUT_SETTINGS = {
  // Keep fast pointer jumps bounded, especially on low frame rates.
  maximumMovementRatio: 0.025,
  // Stop a drag promptly instead of carrying the globe into a long spin.
  inertiaSpin: 0.06,
  inertiaZoom: 0.18,
  zoomFactor: 2.5,
} as const;
const GLOBAL_VIEW_FLIGHT_DURATION_SECONDS = 0.7;

export function moveCameraToGlobalView(
  camera: CameraMotionCommands,
  destination: Cartesian3,
  reducedMotion: boolean,
) {
  if (reducedMotion) {
    camera.setView({ destination });
    return;
  }

  camera.flyTo({ destination, duration: GLOBAL_VIEW_FLIGHT_DURATION_SECONDS });
}
