import { ClockStep, type Clock } from "@cesium/core";
import type { Globe } from "@cesium/engine";

export const SOLAR_RENDER_INTERVAL_SECONDS = 30;

export function configureSolarLighting(globe: Globe, clock: Clock): void {
  globe.enableLighting = true;
  globe.dynamicAtmosphereLighting = true;
  globe.dynamicAtmosphereLightingFromSun = true;
  clock.clockStep = ClockStep.SYSTEM_CLOCK;
}
