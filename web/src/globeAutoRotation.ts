import { Cartesian3 } from "@cesium/core";
import type { Camera, Scene } from "@cesium/engine";
import { REDUCED_MOTION_QUERY } from "./motion";

const ROTATION_INTERVAL_MS = 1_000;
const ROTATION_SPEED_RADIANS_PER_SECOND = (0.008 * Math.PI) / 180;
const MINIMUM_GLOBAL_VIEW_HEIGHT_METERS = 9_000_000;
const RESUME_DELAY_MS = 2_500;

type GlobeRotationState = "active" | "paused" | "disabled";

export interface GlobeAutoRotationController {
  pauseForUserInput(): void;
  destroy(): void;
}

export function startSubtleGlobeRotation(
  camera: Pick<Camera, "positionCartographic" | "rotate">,
  scene: Pick<Scene, "requestRender">,
  container: HTMLElement,
  interactionSurface: HTMLElement,
): GlobeAutoRotationController {
  const motionPreference = window.matchMedia(REDUCED_MOTION_QUERY);
  let timer: number | null = null;
  let destroyed = false;
  let pointerIsDown = false;
  let isInViewport = true;
  let resumeAt = 0;
  let previousTickAt = performance.now();

  function setState(state: GlobeRotationState) {
    if (container.dataset.autoRotation !== state) container.dataset.autoRotation = state;
  }

  container.dataset.cameraLongitude = camera.positionCartographic.longitude.toFixed(6);

  function clearTimer() {
    if (timer === null) return;
    window.clearTimeout(timer);
    timer = null;
  }

  function hasBlockingDialog() {
    if (document.querySelector("dialog:modal")) return true;

    for (const element of document.querySelectorAll<HTMLElement>('[aria-modal="true"]')) {
      if (element.hidden || element.getAttribute("aria-hidden") === "true") continue;
      const style = window.getComputedStyle(element);
      const bounds = element.getBoundingClientRect();
      if (style.display !== "none"
        && style.visibility !== "hidden"
        && bounds.width > 0
        && bounds.height > 0) return true;
    }

    return false;
  }

  function currentState(now: number): GlobeRotationState {
    if (motionPreference.matches || camera.positionCartographic.height < MINIMUM_GLOBAL_VIEW_HEIGHT_METERS) {
      return "disabled";
    }
    if (document.visibilityState !== "visible"
      || !isInViewport
      || pointerIsDown
      || now < resumeAt
      || hasBlockingDialog()) {
      return "paused";
    }
    return "active";
  }

  function schedule(delay = ROTATION_INTERVAL_MS) {
    if (destroyed || timer !== null) return;
    timer = window.setTimeout(tick, delay);
  }

  function tick() {
    timer = null;
    if (destroyed) return;

    const now = performance.now();
    const state = currentState(now);
    setState(state);
    if (state === "active") {
      const elapsedMs = Math.min(now - previousTickAt, ROTATION_INTERVAL_MS * 2);
      previousTickAt = now;
      camera.rotate(Cartesian3.UNIT_Z, ROTATION_SPEED_RADIANS_PER_SECOND * (elapsedMs / 1_000));
      scene.requestRender();
      container.dataset.cameraLongitude = camera.positionCartographic.longitude.toFixed(6);
      schedule();
      return;
    }

    previousTickAt = now;
    if (state === "paused" && hasBlockingDialog()) schedule();
    else if (state === "paused" && now < resumeAt) schedule(Math.max(ROTATION_INTERVAL_MS, resumeAt - now));
  }

  function pauseForUserInput() {
    if (destroyed) return;
    pointerIsDown = false;
    resumeAt = performance.now() + RESUME_DELAY_MS;
    previousTickAt = performance.now();
    clearTimer();
    setState("paused");
    schedule(RESUME_DELAY_MS);
  }

  function handlePointerDown() {
    pointerIsDown = true;
    resumeAt = Number.POSITIVE_INFINITY;
    clearTimer();
    setState("paused");
  }

  function handlePointerEnd() {
    if (!pointerIsDown || destroyed) return;
    pointerIsDown = false;
    resumeAt = performance.now() + RESUME_DELAY_MS;
    previousTickAt = performance.now();
    schedule(RESUME_DELAY_MS);
  }

  function handleVisibilityChange() {
    clearTimer();
    previousTickAt = performance.now();
    if (document.visibilityState === "visible") {
      schedule();
      return;
    }

    pointerIsDown = false;
    resumeAt = 0;
    setState("paused");
  }

  function handleMotionPreferenceChange() {
    clearTimer();
    previousTickAt = performance.now();
    if (motionPreference.matches) setState("disabled");
    else schedule();
  }

  function handleIntersection(entries: IntersectionObserverEntry[]) {
    const entry = entries[entries.length - 1];
    if (!entry) return;
    isInViewport = entry.isIntersecting;
    if (isInViewport) schedule();
    else {
      clearTimer();
      setState("paused");
    }
  }

  const observer = typeof IntersectionObserver === "undefined"
    ? null
    : new IntersectionObserver(handleIntersection, { threshold: 0.1 });
  observer?.observe(container);
  interactionSurface.addEventListener("pointerdown", handlePointerDown);
  interactionSurface.addEventListener("wheel", pauseForUserInput, { passive: true });
  window.addEventListener("pointerup", handlePointerEnd);
  window.addEventListener("pointercancel", handlePointerEnd);
  document.addEventListener("visibilitychange", handleVisibilityChange);
  motionPreference.addEventListener("change", handleMotionPreferenceChange);

  setState(currentState(performance.now()));
  schedule();

  return {
    pauseForUserInput,
    destroy() {
      if (destroyed) return;
      destroyed = true;
      clearTimer();
      observer?.disconnect();
      interactionSurface.removeEventListener("pointerdown", handlePointerDown);
      interactionSurface.removeEventListener("wheel", pauseForUserInput);
      window.removeEventListener("pointerup", handlePointerEnd);
      window.removeEventListener("pointercancel", handlePointerEnd);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      motionPreference.removeEventListener("change", handleMotionPreferenceChange);
      delete container.dataset.autoRotation;
      delete container.dataset.cameraLongitude;
    },
  };
}
