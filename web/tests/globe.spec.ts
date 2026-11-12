import { expect, test, type Locator, type Page, type TestInfo } from "@playwright/test";
import type { Cartesian3 } from "@cesium/core";
import { CAMERA_INPUT_SETTINGS, moveCameraToGlobalView, type CameraMotionCommands } from "../src/cameraMotion";
import { REDUCED_MOTION_QUERY } from "../src/motion";
import { GUEST_MESSAGE_DISPLAY_SETTING_KEY, PUBLIC_MESSAGE_RETENTION_MS } from "../src/publicMessageSettings";
import type { PublicMessage } from "../src/types";
import { freshMessageFixtureTimes, keepFixtureMessagesVisible } from "./messageFixtures";

type GlobePerformanceWindow = Window & {
  __globeDrawCalls?: number;
  __globeLongTasks?: number;
  __globeRafIntervals?: number[];
  __globeMarkerProjectionIntervals?: number[];
  __collectGlobeFrames?: boolean;
  __restoreGlobeDrawCalls?: () => void;
};

const MAX_CESIUM_COMPRESSED_BYTES = 1_120_000;

function percentile(sortedValues: number[], fraction: number) {
  const index = Math.min(sortedValues.length - 1, Math.ceil(sortedValues.length * fraction) - 1);
  return sortedValues[index] ?? 0;
}

async function attachScreenshot(
  page: Page,
  testInfo: TestInfo,
  fileName: string,
  title: string,
  animations: "allow" | "disabled" = "disabled",
) {
  const path = testInfo.outputPath(fileName);
  await page.screenshot({ path, fullPage: true, animations });
  await testInfo.attach(title, { path, contentType: "image/png" });
}

async function freezeExpiryAnimationAt(page: Page, currentTimeMs: number) {
  const opacity = await page.evaluate((currentTime) => {
    const selectors = [
      ".message-card--expiring",
      ".globe-marker--expiring .globe-marker__card",
    ];
    const elements = selectors
      .map((selector) => document.querySelector<HTMLElement>(selector))
      .filter((element): element is HTMLElement => element !== null);
    for (const element of elements) {
      for (const animation of element.getAnimations()) {
        if (animation.effect?.getTiming().duration !== 650) continue;
        animation.pause();
        animation.currentTime = currentTime;
      }
    }
    return selectors.map((selector) => {
      const element = document.querySelector<HTMLElement>(selector);
      return element ? Number.parseFloat(getComputedStyle(element).opacity) : null;
    });
  }, currentTimeMs);
  expect(opacity).toHaveLength(2);
  for (const value of opacity) {
    expect(value).not.toBeNull();
    expect(value).toBeGreaterThan(0);
    expect(value).toBeLessThan(1);
  }
}

async function expectNoCesiumIonBranding(page: Page) {
  await expect(page.locator('.globe-attribution img[title="Cesium ion"]')).toHaveCount(0);
  await expect(page.locator('.globe-attribution a[href="https://cesium.com/"]')).toHaveCount(0);
}

async function cardsDoNotOverlap(cards: Locator) {
  return cards.evaluateAll((elements) => {
    const bounds = elements.map((element) => element.getBoundingClientRect());
    for (let first = 0; first < bounds.length; first += 1) {
      for (let second = first + 1; second < bounds.length; second += 1) {
        const horizontalOverlap = Math.min(bounds[first].right, bounds[second].right)
          - Math.max(bounds[first].left, bounds[second].left);
        const verticalOverlap = Math.min(bounds[first].bottom, bounds[second].bottom)
          - Math.max(bounds[first].top, bounds[second].top);
        if (horizontalOverlap > 0 && verticalOverlap > 0) return false;
      }
    }
    return true;
  });
}

async function inspectGlobeMarkerCards(cards: Locator) {
  return cards.evaluateAll((elements) => {
    const globe = document.querySelector(".globe-canvas");
    if (!globe) return { visibleCount: 0, outside: [], bounds: null };
    const bounds = globe.getBoundingClientRect();
    const visibleCards = elements.filter((element) => {
      const marker = element.closest(".globe-marker");
      return marker !== null && getComputedStyle(marker).visibility === "visible";
    });
    const outside = visibleCards.flatMap((element) => {
      const card = element.getBoundingClientRect();
      if (card.left >= bounds.left + 7
        && card.top >= bounds.top + 7
        && card.right <= bounds.right - 7
        && card.bottom <= bounds.bottom - 7) return [];
      return [{
        label: element.textContent?.trim(),
        left: card.left,
        top: card.top,
        right: card.right,
        bottom: card.bottom,
      }];
    });
    return {
      visibleCount: visibleCards.length,
      outside,
      bounds: { left: bounds.left, top: bounds.top, right: bounds.right, bottom: bounds.bottom },
    };
  });
}

const fixtureMessages = [
  {
    id: "e2e-tbilisi",
    authorProfileId: "00000000-0000-4000-8000-000000000001",
    authorName: "Nino K.",
    authorHandle: "@ninowanders",
    body: "Ночной город сегодня звучит как любимая песня. Кто ещё не спит?",
    latitude: 41.7151,
    longitude: 44.8271,
    city: "Тбилиси",
    country: "Грузия",
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 300_000).toISOString(),
    avatarColor: "#d6a16d",
    initials: "NK",
  },
  {
    id: "e2e-london",
    authorProfileId: "00000000-0000-4000-8000-000000000002",
    authorName: "Elliot R.",
    authorHandle: "@ellinmotion",
    body: "A tiny reminder from London: you can start over at any hour.",
    latitude: 51.5072,
    longitude: -0.1276,
    city: "Лондон",
    country: "Великобритания",
    createdAt: new Date(Date.now() - 40_000).toISOString(),
    expiresAt: new Date(Date.now() + 300_000).toISOString(),
    avatarColor: "#8c9dcc",
    initials: "ER",
  },
];

test.beforeEach(async ({ page }) => {
  const followedProfileIds = new Set<string>();
  let guestIdentity: {
    id: string;
    nickname: string;
    handle: string;
    avatarColor: string;
    initials: string;
  } | null = null;
  await page.route("**/api/guest-session", async (route) => {
    if (route.request().method() === "GET") {
      await route.fulfill(guestIdentity
        ? { status: 200, contentType: "application/json", body: JSON.stringify(guestIdentity) }
        : { status: 204 });
      return;
    }
    const request = route.request().postDataJSON() as { nickname: string };
    if (request.nickname.toLocaleLowerCase() === "taken") {
      await route.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ error: "nickname_taken" }) });
      return;
    }
    if (request.nickname.length < 2 || /[^\p{L}\p{N}\p{M} _'’-]/u.test(request.nickname)) {
      await route.fulfill({ status: 422, contentType: "application/json", body: JSON.stringify({ error: "nickname_invalid" }) });
      return;
    }
    guestIdentity = {
      id: "e2e-guest-profile",
      nickname: request.nickname,
      handle: `@${request.nickname.toLocaleLowerCase().replaceAll(" ", "-")}`,
      avatarColor: "#8c9dcc",
      initials: request.nickname.slice(0, 2).toLocaleUpperCase(),
    };
    await route.fulfill({
      status: 201,
      contentType: "application/json",
      body: JSON.stringify(guestIdentity),
    });
  });

  await page.route("**/api/messages*", async (route) => {
    if (route.request().method() === "GET") {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(freshMessageFixtureTimes(fixtureMessages)) });
      return;
    }
    const body = route.request().postDataJSON() as { body: string; latitude: number; longitude: number };
    if (!guestIdentity) {
      await route.fulfill({ status: 401, contentType: "application/json", body: JSON.stringify({ error: "guest_session_required" }) });
      return;
    }
    await route.fulfill({
      status: 201,
      contentType: "application/json",
      body: JSON.stringify({
        ...fixtureMessages[0],
        id: "e2e-created-message",
        authorProfileId: guestIdentity.id,
        authorName: guestIdentity.nickname,
        authorHandle: guestIdentity.handle,
        body: body.body,
        latitude: body.latitude,
        longitude: body.longitude,
        city: "Тбилиси",
        country: "Грузия",
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + PUBLIC_MESSAGE_RETENTION_MS).toISOString(),
        avatarColor: guestIdentity.avatarColor,
        initials: guestIdentity.initials,
      }),
    });
  });

  await page.route("**/api/follows**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.method() === "GET") {
      const profileIds = (url.searchParams.get("profileIds") ?? "").split(",").filter(Boolean);
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ profileIds: profileIds.filter((profileId) => followedProfileIds.has(profileId)) }),
      });
      return;
    }

    const profileId = decodeURIComponent(url.pathname.split("/").pop() ?? "");
    if (request.method() === "PUT") {
      const wasFollowing = followedProfileIds.has(profileId);
      followedProfileIds.add(profileId);
      await route.fulfill({ status: wasFollowing ? 204 : 201 });
      return;
    }

    followedProfileIds.delete(profileId);
    await route.fulfill({ status: 204 });
  });

  await page.route("**/api/friendships**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ relationships: [] }),
    });
  });

  await page.route("**/api/friend-requests**", async (route) => {
    const view = new URL(route.request().url()).searchParams.get("view") ?? "incoming";
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ view, items: [] }),
    });
  });
});

async function loadMessageAfterGlobeReady(page: Page, id: string, body: string, keepClockPaused = false) {
  let releaseMessage!: () => void;
  let message: (typeof fixtureMessages)[number] | undefined;
  const messageGate = new Promise<void>((resolve) => { releaseMessage = resolve; });

  await page.route("**/api/messages*", async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    await messageGate;
    if (!message) throw new Error("Timed public message was not prepared before release");
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify([message]) });
  });
  await page.goto("/");
  await expect(page.locator(".globe-canvas")).toHaveAttribute("data-earth-texture", "loaded", { timeout: 30_000 });
  await expect(page.locator(".globe-canvas")).toHaveAttribute("data-globe-ready", "true", { timeout: 30_000 });

  const arrivalTime = await page.evaluate(() => Date.now() + 5_000);
  await page.clock.pauseAt(new Date(arrivalTime));
  message = {
    ...fixtureMessages[0],
    id,
    body,
    createdAt: new Date(arrivalTime).toISOString(),
    expiresAt: new Date(arrivalTime + PUBLIC_MESSAGE_RETENTION_MS).toISOString(),
  };
  releaseMessage();

  const card = page.locator(".message-card").filter({ hasText: body });
  const marker = page.locator(".globe-marker").filter({ hasText: body });
  await expect(card).toBeVisible();
  await page.clock.resume();
  await page.getByRole("button", { name: "Приблизить" }).click();
  // The marker root is a zero-sized geographic anchor; visibility belongs to its card.
  await expect(marker.locator(".globe-marker__card")).toBeVisible();
  if (keepClockPaused) {
    const pauseTime = await page.evaluate(() => Date.now() + 1_000);
    await page.clock.pauseAt(new Date(pauseTime));
  }

  return { arrivalTime, card, marker };
}

test("follows and unfollows a public author on desktop and mobile without navigation", async ({ page }, testInfo) => {
  await keepFixtureMessagesVisible(page);
  await page.clock.install();
  await page.goto("/");
  await expect(page.locator(".globe-canvas")).toHaveAttribute("data-earth-texture", "loaded", { timeout: 30_000 });

  const feed = page.locator(".stream-panel");
  const followButton = feed.getByRole("button", { name: "Подписаться на Nino K." });
  await expect(followButton).toBeVisible();
  // This flow tests follow UX; keep the short-lived message fixture stable across screenshots.
  const freezeAt = await page.evaluate(() => Date.now() + 5_000);
  await page.clock.pauseAt(new Date(freezeAt));
  await expect(followButton).toHaveAttribute("aria-pressed", "false");
  await page.getByRole("textbox", { name: "Ваш никнейм" }).fill("Mila Follow");

  let navigationCount = 0;
  page.on("framenavigated", (frame) => {
    if (frame === page.mainFrame()) navigationCount += 1;
  });

  await followButton.click();
  const unfollowButton = feed.getByRole("button", { name: "Отписаться от Nino K." });
  await expect(unfollowButton).toHaveAttribute("aria-pressed", "true");
  await attachScreenshot(page, testInfo, "follow-author-desktop.png", "following a public author on desktop");

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(unfollowButton).toBeVisible();
  const hasHorizontalOverflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  expect(hasHorizontalOverflow).toBe(false);
  await attachScreenshot(page, testInfo, "follow-author-mobile.png", "following a public author on mobile");

  await page.setViewportSize({ width: 1280, height: 720 });
  await page.getByRole("combobox", { name: "Язык интерфейса" }).selectOption("en");
  await page.getByRole("button", { name: "Switch to light theme" }).click();
  const englishUnfollowButton = feed.getByRole("button", { name: "Unfollow Nino K." });
  await expect(englishUnfollowButton).toHaveAttribute("aria-pressed", "true");
  await englishUnfollowButton.click();
  await expect(feed.getByRole("button", { name: "Follow Nino K." })).toHaveAttribute("aria-pressed", "false");
  await attachScreenshot(page, testInfo, "follow-author-english-light-unfollowed.png", "unfollowed author in English light theme");
  expect(navigationCount).toBe(0);
});

test("shows a retryable, localized follow error on desktop and mobile", async ({ page }, testInfo) => {
  const followedProfileIds = new Set<string>();
  let failNextFollow = true;
  await page.unroute("**/api/follows**");
  await page.route("**/api/follows**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.method() === "GET") {
      const profileIds = (url.searchParams.get("profileIds") ?? "").split(",").filter(Boolean);
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({
        profileIds: profileIds.filter((profileId) => followedProfileIds.has(profileId)),
      }) });
      return;
    }
    if (request.method() === "PUT" && failNextFollow) {
      failNextFollow = false;
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ error: "follow_update_failed" }),
      });
      return;
    }
    const profileId = decodeURIComponent(url.pathname.split("/").pop() ?? "");
    if (request.method() === "PUT") followedProfileIds.add(profileId);
    else followedProfileIds.delete(profileId);
    await route.fulfill({ status: request.method() === "PUT" ? 201 : 204 });
  });

  await keepFixtureMessagesVisible(page);
  await page.clock.install();
  await page.goto("/");
  await expect(page.locator(".globe-canvas")).toHaveAttribute("data-earth-texture", "loaded", { timeout: 30_000 });
  const feed = page.locator(".stream-panel");
  await page.getByRole("textbox", { name: "Ваш никнейм" }).fill("Mila Retry");
  let followButton = feed.getByRole("button", { name: "Подписаться на Nino K." });
  await expect(followButton).toBeVisible();
  const freezeAt = await page.evaluate(() => Date.now() + 5_000);
  await page.clock.pauseAt(new Date(freezeAt));
  await followButton.click();
  const error = page.getByRole("alert");
  await expect(error).toHaveText("Не удалось изменить подписку. Проверьте соединение и попробуйте ещё раз");
  await expect(followButton).toHaveAttribute("aria-pressed", "false");
  await attachScreenshot(page, testInfo, "follow-error-desktop.png", "localized follow error on desktop");

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(error).toBeVisible();
  const hasHorizontalOverflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  expect(hasHorizontalOverflow).toBe(false);
  await attachScreenshot(page, testInfo, "follow-error-mobile.png", "localized follow error on mobile");

  await followButton.click();
  await expect(error).toHaveCount(0);
  followButton = feed.getByRole("button", { name: "Отписаться от Nino K." });
  await expect(followButton).toHaveAttribute("aria-pressed", "true");
});

test("renders the interactive globe, live markers and stream", async ({ page }, testInfo) => {
  test.setTimeout(120_000);
  expect(CAMERA_INPUT_SETTINGS.maximumMovementRatio).toBe(0.025);
  expect(CAMERA_INPUT_SETTINGS.inertiaSpin).toBe(0.06);
  const externalImageryRequests: string[] = [];
  const localEarthTileRequests: string[] = [];
  let emitFixtureMessage!: (message: (typeof fixtureMessages)[number]) => void;
  let resolveSocketReady!: () => void;
  const socketReady = new Promise<void>((resolve) => { resolveSocketReady = resolve; });
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.hostname === "api.maptiler.com") externalImageryRequests.push(request.url());
    if (url.pathname.startsWith("/earth/tiles/")) localEarthTileRequests.push(request.url());
  });
  await page.addInitScript(() => {
    const counter = window as GlobePerformanceWindow;
    counter.__globeDrawCalls = 0;
    counter.__globeLongTasks = 0;
    counter.__globeRafIntervals = [];
    counter.__globeMarkerProjectionIntervals = [];
    counter.__collectGlobeFrames = false;
    if (PerformanceObserver.supportedEntryTypes.includes("longtask")) {
      const observer = new PerformanceObserver((entries) => {
        counter.__globeLongTasks = (counter.__globeLongTasks ?? 0) + entries.getEntries().length;
      });
      observer.observe({ entryTypes: ["longtask"] });
    }
  });
  await page.setViewportSize({ width: 1440, height: 960 });
  await keepFixtureMessagesVisible(page);
  await page.routeWebSocket("**/ws", (socket) => {
    socket.onMessage((rawMessage) => {
      const request = JSON.parse(String(rawMessage)) as { type?: string; cells?: string[] };
      if (request.type !== "subscribe") return;
      socket.send(JSON.stringify({ type: "online_count", count: 1 }));
      socket.send(JSON.stringify({ type: "subscription_ready", cells: request.cells ?? [] }));
      resolveSocketReady();
    });
    emitFixtureMessage = (message) => socket.send(JSON.stringify({ type: "public_message", message }));
  });
  await page.route("**/api/messages*", async (route) => {
    if (route.request().method() === "GET") {
      await route.fulfill({ status: 200, contentType: "application/json", body: "[]" });
      return;
    }
    await route.fallback();
  });
  await page.goto("/");
  await socketReady;

  await expect(page.getByRole("heading", { name: "Карта" })).toBeVisible();
  await expect(page.getByRole("region", { name: "Глобус сообщений" })).toBeVisible();
  await expect(page.locator(".globe-canvas canvas").first()).toBeVisible({ timeout: 30_000 });
  await expect(page.locator(".globe-canvas")).toHaveAttribute("data-earth-texture", "loaded", { timeout: 30_000 });
  await expect(page.locator(".globe-canvas")).toHaveAttribute("data-globe-ready", "true", { timeout: 30_000 });
  await expect(page.locator(".globe-canvas")).toHaveAttribute("data-imagery-source", "nasa");
  expect(externalImageryRequests).toEqual([]);
  expect(localEarthTileRequests.length).toBeGreaterThan(0);
  expect(localEarthTileRequests.every((url) => {
    const tileUrl = new URL(url);
    return tileUrl.origin === new URL(page.url()).origin
      && /^\/earth\/tiles\/\d+\/\d+\/\d+\.jpg$/.test(tileUrl.pathname);
  })).toBe(true);
  await expectNoCesiumIonBranding(page);
  await expect(page.locator(".globe-attribution")).toBeHidden();
  // Let Cesium finish its first imagery and terrain pass before measuring its idle loop.
  await page.waitForTimeout(2_500);
  const imageryMetrics = await page.evaluate(() => {
    const tileResources = performance.getEntriesByType("resource")
      .filter((entry): entry is PerformanceResourceTiming =>
        new URL(entry.name).pathname.startsWith("/earth/tiles/"));
    return {
      requestCount: tileResources.length,
      uniqueTileCount: new Set(tileResources.map((entry) => new URL(entry.name).pathname)).size,
      encodedBodyBytes: tileResources.reduce((total, entry) => total + entry.encodedBodySize, 0),
    };
  });
  await testInfo.attach("globe-imagery-metrics.json", {
    body: Buffer.from(JSON.stringify(imageryMetrics, null, 2)),
    contentType: "application/json",
  });
  console.info("[globe-imagery-baseline]", JSON.stringify(imageryMetrics));
  expect(imageryMetrics.requestCount).toBeGreaterThan(0);
  expect(imageryMetrics.uniqueTileCount).toBeGreaterThan(0);
  expect(imageryMetrics.encodedBodyBytes).toBeLessThan(1_884_678);
  const cesiumBundleMetrics = await page.evaluate(() => {
    const chunks = performance.getEntriesByType("resource")
      .filter((entry): entry is PerformanceResourceTiming =>
        /^\/assets\/cesium-engine-[^/]+\.js$/.test(new URL(entry.name).pathname));
    return {
      chunkCount: chunks.length,
      encodedBodyBytes: chunks.reduce((total, entry) => total + entry.encodedBodySize, 0),
      decodedBodyBytes: chunks.reduce((total, entry) => total + entry.decodedBodySize, 0),
    };
  });
  await testInfo.attach("cesium-bundle-metrics.json", {
    body: Buffer.from(JSON.stringify(cesiumBundleMetrics, null, 2)),
    contentType: "application/json",
  });
  console.info("[cesium-bundle-baseline]", JSON.stringify(cesiumBundleMetrics));
  expect(cesiumBundleMetrics.chunkCount).toBeGreaterThan(0);
  expect(cesiumBundleMetrics.encodedBodyBytes).toBeLessThan(MAX_CESIUM_COMPRESSED_BYTES);
  await page.evaluate(() => {
    const metrics = window as GlobePerformanceWindow;
    const restorers: Array<() => void> = [];
    const contexts = [window.WebGLRenderingContext, window.WebGL2RenderingContext].filter(Boolean);
    for (const context of contexts) {
      for (const method of ["drawArrays", "drawElements"] as const) {
        const prototype = context!.prototype as unknown as Record<string, (...args: unknown[]) => unknown>;
        const originalDescriptor = Object.getOwnPropertyDescriptor(prototype, method);
        const original = originalDescriptor?.value;
        if (typeof original !== "function") continue;
        Object.defineProperty(prototype, method, {
          configurable: true,
          value: function (this: WebGLRenderingContext) {
            metrics.__globeDrawCalls = (metrics.__globeDrawCalls ?? 0) + 1;
            return original.apply(this, arguments as unknown as unknown[]);
          },
        });
        restorers.push(() => {
          if (originalDescriptor) Object.defineProperty(prototype, method, originalDescriptor);
          else Reflect.deleteProperty(prototype, method);
        });
      }
    }
    metrics.__restoreGlobeDrawCalls = () => {
      for (const restore of restorers) restore();
      metrics.__restoreGlobeDrawCalls = undefined;
    };
    metrics.__globeDrawCalls = 0;
  });
  const idleStart = await page.evaluate(() => {
    const metrics = window as GlobePerformanceWindow;
    const globe = document.querySelector<HTMLElement>(".globe-canvas");
    return {
      sampledAt: performance.now(),
      drawCalls: metrics.__globeDrawCalls ?? 0,
      longTasks: metrics.__globeLongTasks ?? 0,
      cameraLongitude: globe?.dataset.cameraLongitude,
    };
  });
  const idleSampleDurationMs = 5_000;
  await page.waitForTimeout(idleSampleDurationMs);
  const idleEnd = await page.evaluate(() => {
    const metrics = window as GlobePerformanceWindow;
    const globe = document.querySelector<HTMLElement>(".globe-canvas");
    return {
      sampledAt: performance.now(),
      drawCalls: metrics.__globeDrawCalls ?? 0,
      longTasks: metrics.__globeLongTasks ?? 0,
      cameraLongitude: globe?.dataset.cameraLongitude,
    };
  });
  await page.evaluate(() => {
    const metrics = window as GlobePerformanceWindow;
    metrics.__restoreGlobeDrawCalls?.();
  });
  const idleMetrics = {
    durationMs: idleSampleDurationMs,
    drawCalls: idleEnd.drawCalls - idleStart.drawCalls,
    longTasks: idleEnd.longTasks - idleStart.longTasks,
    drawCallsPerSecond: ((idleEnd.drawCalls - idleStart.drawCalls) * 1_000) / idleSampleDurationMs,
    longTasksPerSecond: ((idleEnd.longTasks - idleStart.longTasks) * 1_000) / idleSampleDurationMs,
  };
  await testInfo.attach("idle-render-metrics.json", {
    body: Buffer.from(JSON.stringify(idleMetrics, null, 2)),
    contentType: "application/json",
  });
  expect(idleMetrics.drawCallsPerSecond).toBeLessThan(30);
  expect(idleMetrics.longTasksPerSecond).toBeLessThan(2);
  console.info("[globe-idle-baseline]", JSON.stringify(idleMetrics));
  await expect(page.locator(".globe-canvas")).toHaveAttribute("data-auto-rotation", "active");
  expect(idleEnd.cameraLongitude).not.toBe(idleStart.cameraLongitude);
  const longitudeDeltaRadians = Math.atan2(
    Math.sin(Number(idleEnd.cameraLongitude) - Number(idleStart.cameraLongitude)),
    Math.cos(Number(idleEnd.cameraLongitude) - Number(idleStart.cameraLongitude)),
  );
  const observedRotationSpeedDegreesPerSecond = Math.abs(longitudeDeltaRadians * 180 / Math.PI)
    / ((idleEnd.sampledAt - idleStart.sampledAt) / 1_000);
  expect(observedRotationSpeedDegreesPerSecond).toBeGreaterThan(0);
  expect(observedRotationSpeedDegreesPerSecond).toBeLessThanOrEqual(0.0102);
  emitFixtureMessage(freshMessageFixtureTimes(fixtureMessages)[0]);
  await expect(page.getByRole("complementary", { name: "Публичные сообщения" }).getByText(
    "Ночной город сегодня звучит как любимая песня. Кто ещё не спит?",
  )).toBeVisible();
  await expect(page.locator(".globe-marker__copy strong").filter({ hasText: "@ninowanders" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Сообщения" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Приблизить" })).toBeVisible();

  const marker = page.locator(".globe-marker").filter({ hasText: "@ninowanders" });
  await expect(marker.locator(".globe-marker__card")).toBeVisible();
  const canvasBounds = await page.locator(".globe-canvas canvas").first().boundingBox();
  expect(canvasBounds).not.toBeNull();
  const dragStart = {
    x: canvasBounds!.x + canvasBounds!.width * 0.27,
    y: canvasBounds!.y + canvasBounds!.height * 0.58,
  };
  const transformBeforeDrag = await marker.evaluate((element) => (element as HTMLElement).style.transform);
  await page.mouse.move(dragStart.x, dragStart.y);
  await page.evaluate(() => {
    const metrics = window as GlobePerformanceWindow;
    metrics.__globeRafIntervals = [];
    metrics.__globeMarkerProjectionIntervals = [];
    metrics.__collectGlobeFrames = true;
    const marker = Array.from(document.querySelectorAll<HTMLElement>(".globe-marker"))
      .find((element) => element.querySelector(".globe-marker__copy strong")?.textContent === "@ninowanders");
    if (!marker) throw new Error("The fixture globe marker is missing");

    let previousFrameTimestamp: number | undefined;
    let previousProjectionTimestamp: number | undefined;
    let previousTransform = marker.style.transform;

    const sampleFrame = (timestamp: number) => {
      if (!metrics.__collectGlobeFrames) return;
      if (previousFrameTimestamp !== undefined) {
        metrics.__globeRafIntervals?.push(timestamp - previousFrameTimestamp);
      }
      previousFrameTimestamp = timestamp;

      const transform = marker.style.transform;
      if (transform !== previousTransform) {
        if (previousProjectionTimestamp !== undefined) {
          metrics.__globeMarkerProjectionIntervals?.push(timestamp - previousProjectionTimestamp);
        }
        previousProjectionTimestamp = timestamp;
        previousTransform = transform;
      }
      window.requestAnimationFrame(sampleFrame);
    };

    window.requestAnimationFrame(sampleFrame);
  });
  await page.mouse.down();
  await expect(page.locator(".globe-canvas")).toHaveAttribute("data-auto-rotation", "paused");
  await page.mouse.move(dragStart.x + 150, dragStart.y + 20, { steps: 4 });
  await page.mouse.up();
  await page.evaluate(() => {
    const metrics = window as GlobePerformanceWindow;
    metrics.__collectGlobeFrames = false;
  });
  const { rafIntervals, projectionIntervals } = await page.evaluate(() => {
    const metrics = window as GlobePerformanceWindow;
    return {
      rafIntervals: metrics.__globeRafIntervals ?? [],
      projectionIntervals: metrics.__globeMarkerProjectionIntervals ?? [],
    };
  });
  const sortedRafIntervals = [...rafIntervals].sort((first, second) => first - second);
  const sortedProjectionIntervals = [...projectionIntervals].sort((first, second) => first - second);
  const interactionMetrics = {
    interaction: "globe-drag",
    measurement: "requestAnimationFrame callback cadence and visible marker transform updates from Cesium postRender; neither value is presented-frame FPS or GPU completion time",
    rafCallbackSamples: sortedRafIntervals.length,
    rafCallbackIntervalP50Ms: percentile(sortedRafIntervals, 0.5),
    rafCallbackIntervalP95Ms: percentile(sortedRafIntervals, 0.95),
    markerProjectionUpdateSamples: sortedProjectionIntervals.length,
    markerProjectionUpdateIntervalP50Ms: percentile(sortedProjectionIntervals, 0.5),
    markerProjectionUpdateIntervalP95Ms: percentile(sortedProjectionIntervals, 0.95),
  };
  await testInfo.attach("globe-interaction-render-metrics.json", {
    body: Buffer.from(JSON.stringify(interactionMetrics, null, 2)),
    contentType: "application/json",
  });
  console.info("[globe-interaction-baseline]", JSON.stringify(interactionMetrics));

  await expect.poll(
    () => marker.evaluate((element) => (element as HTMLElement).style.transform),
    { timeout: 8_000 },
  ).not.toBe(transformBeforeDrag);
  await attachScreenshot(page, testInfo, "planet-chat-desktop.png", "desktop globe with a live marker after drag");
  await expect(page.locator(".globe-canvas")).toHaveAttribute("data-auto-rotation", "active", { timeout: 5_000 });

  const transformBeforeZoom = await marker.evaluate((element) => (element as HTMLElement).style.transform);
  const zoomIn = page.getByRole("button", { name: "Приблизить" });
  await zoomIn.click();
  await expect.poll(() => marker.evaluate((element) => (element as HTMLElement).style.transform)).not.toBe(transformBeforeZoom);
  await attachScreenshot(page, testInfo, "planet-chat-desktop-zoomed.png", "zoomed globe and reprojected marker");

  for (let step = 0; step < 4; step += 1) await zoomIn.click();
  await expect(page.locator(".globe-canvas")).toHaveAttribute("data-auto-rotation", "disabled", { timeout: 5_000 });
  await attachScreenshot(page, testInfo, "planet-chat-desktop-close-zoom.png", "closer globe view");

  await page.getByRole("button", { name: "Вернуться к планете" }).click();
  await expect(page.locator(".globe-canvas")).toHaveAttribute("data-auto-rotation", "active", { timeout: 5_000 });
});

test("publishes without a page reload and restores the nickname on revisit", async ({ page }, testInfo) => {
  let mainFrameNavigations = 0;
  page.on("framenavigated", (frame) => {
    if (frame === page.mainFrame()) mainFrameNavigations += 1;
  });
  await page.goto("/");
  const initialNavigations = mainFrameNavigations;

  const nickname = page.getByRole("textbox", { name: "Ваш никнейм" });
  await expect(nickname).toBeVisible();
  const sendButton = page.getByRole("button", { name: "Отправить сообщение" });
  await expect(sendButton).toBeDisabled();
  await nickname.fill("Mila Rivera");
  const composer = page.getByRole("textbox", { name: "Ваше сообщение" });
  await composer.fill("Привет с тестовой орбиты");
  await expect(composer).toHaveValue("Привет с тестовой орбиты");
  await expect(sendButton).toBeEnabled();
  await expect(page.locator(".globe-canvas")).toHaveAttribute("data-earth-texture", "loaded", { timeout: 30_000 });
  await expectNoCesiumIonBranding(page);
  await expect(page.locator(".globe-attribution")).toBeHidden();
  await attachScreenshot(page, testInfo, "guest-nickname-composer.png", "guest nickname and composer");
  let messagePayload: Record<string, unknown> | undefined;
  page.on("request", (request) => {
    if (request.url().includes("/api/messages") && request.method() === "POST") {
      messagePayload = request.postDataJSON() as Record<string, unknown>;
    }
  });
  const postResponse = page.waitForResponse(
    (response) => response.url().includes("/api/messages") && response.request().method() === "POST",
  );
  await sendButton.click();
  await postResponse;

  await expect(page.getByRole("complementary", { name: "Публичные сообщения" }).getByText("Привет с тестовой орбиты")).toBeVisible();
  await expect(page.locator(".message-card").filter({ hasText: "Привет с тестовой орбиты" }).getByText("Mila Rivera")).toBeVisible();
  const guestMarker = page.locator(".globe-marker").filter({ hasText: "@mila-rivera" });
  await expect.poll(() => guestMarker.evaluate((marker) => getComputedStyle(marker).visibility)).toBe("visible");
  await expect.poll(() => guestMarker.evaluate((marker) => (marker as HTMLElement).style.transform)).not.toBe("");
  const markerCards = page.locator(".globe-marker__card");
  await expect.poll(async () => (await inspectGlobeMarkerCards(markerCards)).visibleCount).toBeGreaterThan(0);
  const markerLayout = await inspectGlobeMarkerCards(markerCards);
  expect(markerLayout.outside, JSON.stringify(markerLayout, null, 2)).toEqual([]);
  await attachScreenshot(page, testInfo, "guest-message-on-globe.png", "guest message on the globe");
  await expect(page.getByRole("textbox", { name: "Ваше сообщение" })).toHaveValue("");
  expect(messagePayload).toEqual({ body: "Привет с тестовой орбиты", latitude: 41.7151, longitude: 44.8271 });
  expect(await page.evaluate(() => localStorage.getItem("meridian-guest-nickname"))).toBe("Mila Rivera");
  expect(mainFrameNavigations).toBe(initialNavigations);

  await page.reload();
  await expect(page.getByRole("textbox", { name: "Ваш никнейм" })).toHaveValue("Mila Rivera");
});

test("shows the server retry time for public message cooldown in both locales", async ({ page }, testInfo) => {
  test.setTimeout(120_000);
  await page.route("**/api/messages", async (route) => {
    if (route.request().method() !== "POST") {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 429,
      headers: { "Cache-Control": "no-store", "Retry-After": "2" },
      contentType: "application/json",
      body: JSON.stringify({ error: "public_message_rate_limited" }),
    });
  });
  await page.goto("/");
  await expect(page.locator(".globe-canvas")).toHaveAttribute("data-earth-texture", "loaded", { timeout: 30_000 });

  await page.getByRole("textbox", { name: "Ваш никнейм" }).fill("Mila Rivera");
  await page.getByRole("textbox", { name: "Ваше сообщение" }).fill("Еще одно короткое сообщение");
  await page.getByRole("button", { name: "Отправить сообщение" }).click();
  await expect(page.getByRole("alert")).toHaveText("Подождите 2 сек. перед следующим сообщением");
  await attachScreenshot(page, testInfo, "message-cooldown-ru-desktop.png", "public message cooldown in Russian on desktop");

  await page.setViewportSize({ width: 390, height: 844 });
  await attachScreenshot(page, testInfo, "message-cooldown-ru-mobile.png", "public message cooldown in Russian on mobile");

  await page.evaluate(() => localStorage.setItem("meridian-language", "en"));
  await page.reload();
  await expect(page.locator(".globe-canvas")).toHaveAttribute("data-earth-texture", "loaded", { timeout: 30_000 });
  await page.getByRole("textbox", { name: "Your message" }).fill("One more short message");
  await page.getByRole("button", { name: "Send message" }).click();
  await expect(page.getByRole("alert")).toHaveText("Please wait 2s before sending another message");
  await attachScreenshot(page, testInfo, "message-cooldown-en-mobile.png", "public message cooldown in English on mobile");

  await page.setViewportSize({ width: 1440, height: 960 });
  await attachScreenshot(page, testInfo, "message-cooldown-en-desktop.png", "public message cooldown in English on desktop");
});

test("explains guest session throttling in both locales and preserves the draft", async ({ page }, testInfo) => {
  await page.route("**/api/guest-session", async (route) => {
    if (route.request().method() !== "POST") {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 429,
      headers: { "Cache-Control": "no-store", "Retry-After": "6" },
      contentType: "application/json",
      body: JSON.stringify({ error: "guest_session_rate_limited" }),
    });
  });
  await page.goto("/");
  await expect(page.locator(".globe-canvas")).toHaveAttribute("data-earth-texture", "loaded", { timeout: 30_000 });

  await page.getByRole("textbox", { name: "Ваш никнейм" }).fill("Mila Rivera");
  const composer = page.getByRole("textbox", { name: "Ваше сообщение" });
  await composer.fill("Сообщение останется в черновике");
  await page.getByRole("button", { name: "Отправить сообщение" }).click();
  await expect(page.getByRole("alert")).toHaveText("Слишком много попыток. Подождите перед созданием новой сессии");
  await expect(composer).toHaveValue("Сообщение останется в черновике");
  await attachScreenshot(page, testInfo, "guest-session-rate-limit-ru-desktop.png", "guest session throttling in Russian on desktop");

  await page.setViewportSize({ width: 390, height: 844 });
  await attachScreenshot(page, testInfo, "guest-session-rate-limit-ru-mobile.png", "guest session throttling in Russian on mobile");

  await page.evaluate(() => localStorage.setItem("meridian-language", "en"));
  await page.reload();
  await expect(page.locator(".globe-canvas")).toHaveAttribute("data-earth-texture", "loaded", { timeout: 30_000 });
  const englishComposer = page.getByRole("textbox", { name: "Your message" });
  await englishComposer.fill("Keep this draft for me");
  await page.getByRole("button", { name: "Send message" }).click();
  await expect(page.getByRole("alert")).toHaveText("Too many attempts. Wait before creating another session");
  await expect(englishComposer).toHaveValue("Keep this draft for me");
  await attachScreenshot(page, testInfo, "guest-session-rate-limit-en-mobile.png", "guest session throttling in English on mobile");

  await page.setViewportSize({ width: 1440, height: 960 });
  await attachScreenshot(page, testInfo, "guest-session-rate-limit-en-desktop.png", "guest session throttling in English on desktop");
});

test("explains when a public nickname is already taken and keeps the draft", async ({ page }, testInfo) => {
  await page.goto("/");
  await page.getByRole("textbox", { name: "Ваш никнейм" }).fill("Taken");
  await page.getByRole("textbox", { name: "Ваше сообщение" }).fill("Не потеряй этот текст");
  await page.getByRole("button", { name: "Отправить сообщение" }).click();

  await expect(page.getByRole("alert")).toHaveText("Этот никнейм уже занят");
  await expect(page.getByRole("textbox", { name: "Ваше сообщение" })).toHaveValue("Не потеряй этот текст");
  await attachScreenshot(page, testInfo, "guest-nickname-conflict.png", "nickname conflict feedback");
});

test("keeps the globe and message composer usable with touch camera input on a phone", async ({ browser }, testInfo) => {
  const context = await browser.newContext({
    baseURL: testInfo.project.use.baseURL,
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  });
  const page = await context.newPage();
  let emitTouchMessage!: () => void;
  let resolveSocketReady!: () => void;
  const socketReady = new Promise<void>((resolve) => { resolveSocketReady = resolve; });
  await page.routeWebSocket("**/ws", (socket) => {
    socket.onMessage((rawMessage) => {
      const request = JSON.parse(String(rawMessage)) as { type?: string; cells?: string[] };
      if (request.type !== "subscribe") return;
      socket.send(JSON.stringify({ type: "online_count", count: 1 }));
      socket.send(JSON.stringify({ type: "subscription_ready", cells: request.cells ?? [] }));
      resolveSocketReady();
    });
    emitTouchMessage = () => {
      const now = Date.now();
      const message: PublicMessage = {
        id: "e2e-mobile-touch-camera",
        authorName: "Touch Guest",
        authorHandle: "@touchguest",
        body: "Hello from touch",
        latitude: 41.7151,
        longitude: 44.8271,
        city: "Tbilisi",
        country: "Georgia",
        createdAt: new Date(now).toISOString(),
        expiresAt: new Date(now + 24_000).toISOString(),
        avatarColor: "#25c9b6",
        initials: "TG",
      };
      socket.send(JSON.stringify({ type: "public_message", message }));
    };
  });
  await keepFixtureMessagesVisible(page);
  await page.goto("/");
  await socketReady;
  await page.getByRole("button", { name: "Открыть меню" }).click();
  await expect(page.locator(".workspace")).toHaveClass(/workspace--mobile-open/);
  await expect(page.getByRole("button", { name: "Лента сообщений" })).toBeVisible();
  await page.locator(".sidebar-toggle").click();
  await expect(page.locator(".workspace")).not.toHaveClass(/workspace--mobile-open/);
  await expect.poll(async () => {
    const sidebar = await page.locator(".sidebar").boundingBox();
    return sidebar ? sidebar.x + sidebar.width : 0;
  }).toBeLessThanOrEqual(0);
  await expect(page.getByRole("region", { name: "Глобус сообщений" })).toBeVisible();
  await expect(page.locator(".globe-canvas canvas").first()).toBeVisible({ timeout: 30_000 });
  await expect(page.locator(".globe-canvas")).toHaveAttribute("data-globe-ready", "true", { timeout: 30_000 });
  await expect(page.getByRole("textbox", { name: "Ваше сообщение" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Выбрать место на карте" })).toBeVisible();
  emitTouchMessage();
  const touchMarker = page.locator(".globe-marker").filter({ hasText: "@touchguest" });
  await expect(touchMarker.locator(".globe-marker__card")).toBeVisible();
  const touchCanvasBounds = await page.locator(".globe-canvas canvas").first().boundingBox();
  expect(touchCanvasBounds).not.toBeNull();
  const touchStart = {
    x: touchCanvasBounds!.x + touchCanvasBounds!.width * 0.72,
    y: touchCanvasBounds!.y + touchCanvasBounds!.height * 0.34,
  };
  const transformBeforeTouch = await touchMarker.evaluate((element) => (element as HTMLElement).style.transform);
  const touchSession = await context.newCDPSession(page);
  const touchPoint = (x: number, y: number) => ({ x, y, id: 1, radiusX: 1, radiusY: 1, force: 1 });
  await touchSession.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: [touchPoint(touchStart.x, touchStart.y)],
  });
  await touchSession.send("Input.dispatchTouchEvent", {
    type: "touchMove",
    touchPoints: [touchPoint(touchStart.x - 64, touchStart.y + 24)],
  });
  await touchSession.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await expect.poll(
    () => touchMarker.evaluate((element) => (element as HTMLElement).style.transform),
    { timeout: 8_000 },
  ).not.toBe(transformBeforeTouch);
  await touchSession.detach();

  await page.getByRole("textbox", { name: "Ваш никнейм" }).fill("Ari");
  await page.getByRole("textbox", { name: "Ваше сообщение" }).fill("Hello from mobile");
  const nicknameHint = page.locator(".composer-identity__hint");
  await expect(nicknameHint).toBeVisible();
  await expect(nicknameHint).toHaveCSS("white-space", "normal");
  await expect.poll(() => nicknameHint.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);

  const dimensions = await page.evaluate(() => ({
    viewport: document.documentElement.clientWidth,
    document: document.documentElement.scrollWidth,
  }));
  expect(dimensions.document).toBeLessThanOrEqual(dimensions.viewport + 1);

  await attachScreenshot(page, testInfo, "planet-chat-mobile.png", "mobile interface");
  await context.close();
});

test("keeps clustered map message cards readable across viewport sizes", async ({ page }, testInfo) => {
  await keepFixtureMessagesVisible(page);
  const clusteredMessages = Array.from({ length: 5 }, (_, index) => ({
    ...fixtureMessages[0],
    id: `e2e-cluster-${index + 1}`,
    authorName: `Guest ${index + 1}`,
    authorHandle: `@guest${index + 1}`,
    body: `Short message ${index + 1}`,
    initials: `G${index + 1}`,
  }));
  await page.route("**/api/messages*", async (route) => {
    if (route.request().method() === "GET") {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(freshMessageFixtureTimes(clusteredMessages)) });
      return;
    }
    await route.continue();
  });

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await expect(page.locator(".globe-canvas")).toHaveAttribute("data-earth-texture", "loaded", { timeout: 30_000 });
  const cards = page.locator(".globe-marker__card");
  await expect(cards).toHaveCount(5);
  await expect(cards.first()).toBeVisible();
  await expect.poll(() => cards.evaluateAll((elements) => elements.every((card) =>
    card.getAnimations().every((animation) => animation.playState === "finished"),
  ))).toBe(true);
  await expect.poll(() => cardsDoNotOverlap(cards)).toBe(true);
  const mobileAnchorTransforms = await page.locator(".globe-marker").evaluateAll((elements) =>
    elements.map((element) => (element as HTMLElement).style.transform),
  );
  expect(new Set(mobileAnchorTransforms).size).toBe(1);
  await attachScreenshot(page, testInfo, "planet-chat-mobile-clustered-messages.png", "mobile clustered messages");

  await page.setViewportSize({ width: 1440, height: 960 });
  await expect(cards.first()).toHaveCSS("width", "226px");
  await expect.poll(() => cardsDoNotOverlap(cards)).toBe(true);
  const desktopAnchorTransforms = await page.locator(".globe-marker").evaluateAll((elements) =>
    elements.map((element) => (element as HTMLElement).style.transform),
  );
  expect(new Set(desktopAnchorTransforms).size).toBe(1);
  await attachScreenshot(page, testInfo, "planet-chat-desktop-clustered-messages.png", "desktop clustered messages");
});

test("lets people change theme and language and collapse the navigation", async ({ page }, testInfo) => {
  await page.goto("/");
  await expect(page.locator(".globe-canvas")).toHaveAttribute("data-earth-texture", "loaded", { timeout: 30_000 });

  const collapseButton = page.getByRole("button", { name: "Свернуть меню" });
  await collapseButton.click();
  await expect(page.getByRole("button", { name: "Развернуть меню" })).toHaveAttribute("aria-expanded", "false");
  await attachScreenshot(page, testInfo, "planet-chat-sidebar-collapsed.png", "collapsed navigation");

  await page.getByRole("button", { name: "Включить светлую тему" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await attachScreenshot(page, testInfo, "planet-chat-light-theme.png", "light theme");

  await page.getByRole("combobox", { name: "Язык интерфейса" }).selectOption("en");
  await expect(page.getByRole("heading", { name: "Map" })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Your nickname" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Switch to dark theme" })).toBeVisible();
  await attachScreenshot(page, testInfo, "planet-chat-english-interface.png", "English interface");
});

test("saves guest message display settings locally and restores them across language, theme, and reload", async ({ page }, testInfo) => {
  test.setTimeout(60_000);
  const browserContext = page.context();
  let accountSettingsRequests = 0;
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === "/api/account/settings") accountSettingsRequests += 1;
  });
  await page.route("**/api/messages*", async (route) => {
    if (route.request().method() === "GET") {
      await route.fulfill({ status: 200, contentType: "application/json", body: "[]" });
      return;
    }
    await route.fallback();
  });
  await page.setViewportSize({ width: 1440, height: 960 });
  await page.goto("/");
  await expect(page.locator(".globe-canvas")).toHaveAttribute("data-earth-texture", "loaded", { timeout: 30_000 });

  const settingsButton = page.getByRole("button", { name: "Настройки" });
  await settingsButton.click();
  const dialog = page.getByRole("dialog", { name: "Настройки" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("radio", { name: "12 сек" })).toBeChecked();
  await expect(dialog.getByRole("status")).toHaveText("Сохранено на этом устройстве");
  await attachScreenshot(page, testInfo, "message-display-settings-ru-dark-desktop.png", "guest display settings in Russian, dark desktop");

  await dialog.getByText("24 сек", { exact: true }).click();
  await expect(dialog.getByRole("radio", { name: "24 сек" })).toBeChecked();
  await expect.poll(() => page.evaluate((key) => localStorage.getItem(key), GUEST_MESSAGE_DISPLAY_SETTING_KEY)).toBe("24");
  await page.getByRole("button", { name: "Закрыть настройки" }).click();

  await page.getByRole("combobox", { name: "Язык интерфейса" }).selectOption("en");
  await expect(page.getByRole("heading", { name: "Map" })).toBeVisible();
  await page.getByRole("button", { name: "Switch to light theme" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await page.getByRole("button", { name: "Preferences" }).click();
  const englishDesktopDialog = page.getByRole("dialog", { name: "Preferences" });
  await expect(englishDesktopDialog.getByRole("radio", { name: "24 sec" })).toBeChecked();
  await attachScreenshot(page, testInfo, "message-display-settings-en-light-desktop.png", "guest display settings in English, light desktop");
  await page.keyboard.press("Escape");
  await expect(englishDesktopDialog).toBeHidden();
  await page.close();

  const mobilePage = await browserContext.newPage();
  await mobilePage.setViewportSize({ width: 390, height: 844 });
  mobilePage.on("request", (request) => {
    if (new URL(request.url()).pathname === "/api/account/settings") accountSettingsRequests += 1;
  });
  await mobilePage.route("**/api/messages*", async (route) => {
    if (route.request().method() === "GET") {
      await route.fulfill({ status: 200, contentType: "application/json", body: "[]" });
      return;
    }
    await route.fallback();
  });
  await mobilePage.goto("/");
  await expect(mobilePage.locator(".globe-canvas")).toHaveAttribute("data-earth-texture", "loaded", { timeout: 30_000 });
  await mobilePage.getByRole("button", { name: "Open menu" }).click();
  await mobilePage.getByRole("button", { name: "Preferences" }).click();
  const englishDialog = mobilePage.getByRole("dialog", { name: "Preferences" });
  await expect(englishDialog.getByRole("radio", { name: "24 sec" })).toBeChecked();
  await attachScreenshot(mobilePage, testInfo, "message-display-settings-en-light-mobile.png", "guest display settings in English, light mobile");
  expect(accountSettingsRequests).toBe(0);

  await mobilePage.reload();
  await mobilePage.getByRole("button", { name: "Open menu" }).click();
  await mobilePage.getByRole("button", { name: "Preferences" }).click();
  const restoredDialog = mobilePage.getByRole("dialog", { name: "Preferences" });
  await expect(restoredDialog.getByRole("radio", { name: "24 sec" })).toBeChecked();
  await expect(restoredDialog.getByRole("status")).toHaveText("Saved on this device");
  await attachScreenshot(mobilePage, testInfo, "message-display-settings-restored-mobile.png", "guest display settings restored after reload");
  await mobilePage.keyboard.press("Escape");
  await expect(restoredDialog).toBeHidden();
  expect(accountSettingsRequests).toBe(0);
});

test("applies a changed guest display duration to a message already on the globe", async ({ page }, testInfo) => {
  const exitAnimationMs = 650;
  const displayDurationMs = 12_000;
  await page.clock.install({ time: new Date() });
  await page.addInitScript(({ key }) => localStorage.setItem(key, "24"), { key: GUEST_MESSAGE_DISPLAY_SETTING_KEY });
  const { arrivalTime, card, marker } = await loadMessageAfterGlobeReady(
    page,
    "e2e-updated-display-duration",
    "Настройка времени применяется к уже открытому сообщению",
    true,
  );

  await page.getByRole("button", { name: "Настройки" }).click();
  const settings = page.getByRole("dialog", { name: "Настройки" });
  await settings.getByText("12 сек", { exact: true }).click();
  await expect(settings.getByRole("status")).toHaveText("Сохранено на этом устройстве");
  await expect.poll(() => page.evaluate((key) => localStorage.getItem(key), GUEST_MESSAGE_DISPLAY_SETTING_KEY)).toBe("12");
  await page.getByRole("button", { name: "Закрыть настройки" }).click();

  const fadeAt = arrivalTime + displayDurationMs - exitAnimationMs;
  await page.clock.pauseAt(new Date(fadeAt - 1));
  await expect(card).not.toHaveClass(/message-card--expiring/);
  await page.clock.fastForward(1);
  await expect(card).toHaveClass(/message-card--expiring/);
  await expect(marker).toHaveClass(/globe-marker--expiring/);
  await page.clock.runFor(Math.floor(exitAnimationMs / 2));
  await freezeExpiryAnimationAt(page, Math.floor(exitAnimationMs / 2));
  await attachScreenshot(page, testInfo, "existing-message-updated-duration-fade.png", "existing message fading after the guest shortens its display time", "allow");
  await page.clock.fastForward(exitAnimationMs - Math.floor(exitAnimationMs / 2) - 1);
  await expect(card).toHaveCount(1);
  await page.clock.fastForward(1);
  await expect(card).toHaveCount(0);
  await expect(marker).toHaveCount(0);
});

test("animates public messages out after the selected display lifetime", async ({ page }, testInfo) => {
  const exitAnimationMs = 650;
  const displayDurationMs = 24_000;
  await page.clock.install({ time: new Date() });
  await page.addInitScript(({ key }) => localStorage.setItem(key, "24"), { key: GUEST_MESSAGE_DISPLAY_SETTING_KEY });
  const { arrivalTime, card, marker } = await loadMessageAfterGlobeReady(
    page,
    "e2e-expiring-message",
    "Короткое сообщение на карте",
  );
  const fadeAt = arrivalTime + displayDurationMs - exitAnimationMs;
  await page.clock.pauseAt(new Date(fadeAt - 1));
  await expect(card).not.toHaveClass(/message-card--expiring/);
  await expect(marker).not.toHaveClass(/globe-marker--expiring/);
  await page.clock.fastForward(1);
  await expect(card).toHaveClass(/message-card--expiring/, { timeout: 6_000 });
  await expect(marker).toHaveClass(/globe-marker--expiring/);
  await page.clock.runFor(Math.floor(exitAnimationMs / 2));
  await freezeExpiryAnimationAt(page, Math.floor(exitAnimationMs / 2));
  await attachScreenshot(page, testInfo, "message-expiry-mid-fade.png", "public message halfway through expiry fade", "allow");
  await page.clock.fastForward(exitAnimationMs - Math.floor(exitAnimationMs / 2) - 1);
  await expect(card).toHaveCount(1);
  await page.clock.fastForward(1);
  await expect(card).toHaveCount(0, { timeout: 3_000 });
  await expect(marker).toHaveCount(0);
});

test("honors reduced motion when a public message reaches its selected lifetime", async ({ page }, testInfo) => {
  const displayDurationMs = 24_000;
  await page.clock.install({ time: new Date() });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.addInitScript(({ key }) => localStorage.setItem(key, "24"), { key: GUEST_MESSAGE_DISPLAY_SETTING_KEY });
  const { arrivalTime, card, marker } = await loadMessageAfterGlobeReady(
    page,
    "e2e-reduced-motion-expiry",
    "Сообщение исчезнет без анимации",
  );
  await page.clock.pauseAt(new Date(arrivalTime + displayDurationMs - 1));
  await expect(card).not.toHaveClass(/message-card--expiring/);
  await attachScreenshot(page, testInfo, "message-expiry-reduced-motion-before.png", "public message before reduced-motion expiry");
  await page.clock.fastForward(1);
  await expect(card).toHaveCount(0, { timeout: 3_000 });
  await expect(marker).toHaveCount(0);
});

test("uses the selected guest duration to fade a new public message from the map", async ({ page }, testInfo) => {
  test.setTimeout(60_000);
  const exitAnimationMs = 650;
  const displayDurationMs = 6_000;
  await page.clock.install({ time: new Date() });
  await page.route("**/api/messages*", async (route) => {
    if (route.request().method() === "GET") {
      await route.fulfill({ status: 200, contentType: "application/json", body: "[]" });
      return;
    }
    await route.fallback();
  });
  await page.setViewportSize({ width: 1440, height: 960 });
  await page.goto("/");
  await expect(page.locator(".globe-canvas")).toHaveAttribute("data-earth-texture", "loaded", { timeout: 30_000 });
  await expect(page.locator(".globe-canvas")).toHaveAttribute("data-globe-ready", "true", { timeout: 30_000 });

  await page.getByRole("button", { name: "Настройки" }).click();
  const settings = page.getByRole("dialog", { name: "Настройки" });
  await settings.getByText("6 сек", { exact: true }).click();
  await expect.poll(() => page.evaluate((key) => localStorage.getItem(key), GUEST_MESSAGE_DISPLAY_SETTING_KEY)).toBe("6");
  await page.getByRole("button", { name: "Закрыть настройки" }).click();

  await page.getByRole("textbox", { name: "Ваш никнейм" }).fill("Mila Expiry");
  await page.getByRole("textbox", { name: "Ваше сообщение" }).fill("Карта сохранит это сообщение на шесть секунд");
  const messageArrivalTime = await page.evaluate(() => Date.now() + 100);
  await page.clock.pauseAt(new Date(messageArrivalTime));
  await page.getByRole("button", { name: "Отправить сообщение" }).click();

  const card = page.locator(".message-card").filter({ hasText: "Карта сохранит это сообщение на шесть секунд" });
  const marker = page.locator(".globe-marker").filter({ hasText: "Карта сохранит это сообщение на шесть секунд" });
  await expect(card).toBeVisible();
  await page.getByRole("button", { name: "Приблизить" }).click();
  await page.clock.runFor(16);
  await expect(marker.locator(".globe-marker__card")).toBeVisible();
  const fadeAt = messageArrivalTime + displayDurationMs - exitAnimationMs;

  await page.clock.pauseAt(new Date(fadeAt - 1));
  await expect(card).not.toHaveClass(/message-card--expiring/);
  await page.clock.fastForward(1);
  await expect(card).toHaveClass(/message-card--expiring/);
  await expect(marker).toHaveClass(/globe-marker--expiring/);
  await page.clock.runFor(Math.floor(exitAnimationMs / 2));
  await freezeExpiryAnimationAt(page, Math.floor(exitAnimationMs / 2));
  await attachScreenshot(page, testInfo, "message-display-six-second-fade.png", "six-second public message fading from globe", "allow");
  await page.clock.fastForward(exitAnimationMs - Math.floor(exitAnimationMs / 2) - 1);
  await expect(card).toHaveCount(1);
  await page.clock.fastForward(1);
  await expect(card).toHaveCount(0);
  await expect(marker).toHaveCount(0);
});

test("keeps the connection status pending until the current map subscription is ready", async ({ page }, testInfo) => {
  test.skip(!process.env.E2E_BASE_URL, "requires the production WebSocket connection mode");
  test.setTimeout(60_000);
  const pendingConfirmations: Array<() => void> = [];
  let releaseConfirmations = false;
  let webSocketConnections = 0;
  let closeInitialConnection: (() => Promise<void>) | undefined;
  await page.routeWebSocket("**/ws", (socket) => {
    webSocketConnections += 1;
    if (webSocketConnections === 1) closeInitialConnection = () => socket.close();
    socket.onMessage((message) => {
      const request = JSON.parse(String(message)) as { type?: string; cells?: string[] };
      if (request.type !== "subscribe") return;
      const response = JSON.stringify({ type: "subscription_ready", cells: request.cells ?? [] });
      const confirm = () => {
        socket.send(JSON.stringify({ type: "online_count", count: 7 }));
        socket.send(response);
      };
      if (releaseConfirmations) confirm();
      else pendingConfirmations.push(confirm);
    });
  });
  await page.goto("/");

  await expect.poll(() => pendingConfirmations.length, { timeout: 10_000 }).toBeGreaterThan(0);
  await expect(page.locator(".globe-canvas")).toHaveAttribute("data-earth-texture", "loaded", { timeout: 30_000 });
  await expect(page.locator(".connection-pill--connecting")).toBeVisible();
  await expect(page.locator(".connection-pill--live")).toHaveCount(0);
  await expect(page.getByTestId("online-session-count")).toHaveAttribute("data-online-count", "");
  await expect(page.getByTestId("online-session-count")).toContainText("— онлайн");
  await attachScreenshot(page, testInfo, "realtime-awaiting-subscription.png", "realtime connection awaiting subscription readiness");

  const isMessagesBackfill = (response: { url(): string; request(): { method(): string } }) =>
    response.request().method() === "GET" && response.url().includes("/api/messages?cells=");
  const initialBackfill = page.waitForResponse(isMessagesBackfill);
  releaseConfirmations = true;
  for (const confirm of pendingConfirmations.splice(0)) confirm();
  expect((await initialBackfill).status()).toBe(200);
  await expect(page.locator(".connection-pill--live")).toBeVisible();
  await expect(page.getByTestId("online-session-count")).toHaveAttribute("data-online-count", "7");
  await attachScreenshot(page, testInfo, "realtime-subscription-ready.png", "realtime connection after subscription readiness");

  const reconnectBackfill = page.waitForResponse(isMessagesBackfill);
  expect(closeInitialConnection).toBeDefined();
  releaseConfirmations = false;
  await closeInitialConnection!();
  await expect.poll(() => webSocketConnections, { timeout: 10_000 }).toBeGreaterThan(1);
  await expect.poll(() => pendingConfirmations.length, { timeout: 10_000 }).toBeGreaterThan(0);
  await expect(page.locator(".connection-pill--connecting")).toBeVisible();
  await expect(page.getByTestId("online-session-count")).toContainText("— онлайн");
  await attachScreenshot(page, testInfo, "realtime-reconnect-pending.png", "realtime reconnect awaiting subscription readiness");
  releaseConfirmations = true;
  for (const confirm of pendingConfirmations.splice(0)) confirm();
  expect((await reconnectBackfill).status()).toBe(200);
  await expect(page.locator(".connection-pill--live")).toBeVisible();
  await expect(page.getByTestId("online-session-count")).toHaveAttribute("data-online-count", "7");
});

test("respects reduced motion during globe navigation", async ({ page }, testInfo) => {
  test.setTimeout(60_000);
  await page.setViewportSize({ width: 1440, height: 960 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/");

  const reducedMotion = await page.evaluate((query) => window.matchMedia(query).matches, REDUCED_MOTION_QUERY);
  expect(reducedMotion).toBe(true);
  const cameraCalls: string[] = [];
  const camera = {
    setView: () => cameraCalls.push("setView"),
    flyTo: () => cameraCalls.push("flyTo"),
  } as unknown as CameraMotionCommands;
  moveCameraToGlobalView(camera, {} as Cartesian3, reducedMotion);
  expect(cameraCalls).toEqual(["setView"]);

  await expect(page.getByRole("region", { name: "Глобус сообщений" })).toBeVisible();
  await expect(page.locator(".globe-canvas canvas").first()).toBeVisible({ timeout: 30_000 });
  await expect(page.locator(".globe-canvas")).toHaveAttribute("data-earth-texture", "loaded", { timeout: 30_000 });
  await expect(page.locator(".globe-canvas")).toHaveAttribute("data-auto-rotation", "disabled");
  const maximumAnimationDurationMs = await page.evaluate(() => {
    const elements = document.querySelectorAll(
      ".app-shell, .globe-canvas-wrap, .composer, .message-card, .globe-marker__card, .globe-marker__halo",
    );
    const durations = Array.from(elements).flatMap((element) =>
      getComputedStyle(element).animationDuration.split(",").map((duration) => {
        const trimmed = duration.trim();
        const value = Number.parseFloat(trimmed);
        return trimmed.endsWith("ms") ? value : value * 1_000;
      }),
    );
    return Math.max(0, ...durations);
  });
  expect(maximumAnimationDurationMs).toBeLessThanOrEqual(0.01);

  await attachScreenshot(page, testInfo, "planet-chat-reduced-motion-desktop.png", "reduced motion desktop");

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole("textbox", { name: "Ваше сообщение" })).toBeVisible();
  await attachScreenshot(page, testInfo, "planet-chat-reduced-motion-mobile.png", "reduced motion mobile");
});

test("renders a starfield and solar lighting for fixed UTC day, night, and seasons", async ({ page }, testInfo) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 1440, height: 960 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  const starfieldTextureResponses = new Map<string, number>();
  page.on("response", (response) => {
    const pathname = new URL(response.url()).pathname;
    if (pathname.startsWith("/skybox/")) starfieldTextureResponses.set(pathname, response.status());
  });

  const scenarios = [
    { name: "equinox-day", time: "2026-03-20T12:00:00.000Z" },
    { name: "equinox-night", time: "2026-03-20T00:00:00.000Z" },
    { name: "summer-solstice", time: "2026-06-21T12:00:00.000Z" },
    { name: "winter-solstice", time: "2026-12-21T12:00:00.000Z" },
  ];

  for (const [index, scenario] of scenarios.entries()) {
    await page.clock.setFixedTime(new Date(scenario.time));
    if (index === 0) await page.goto("/");
    else await page.reload();

    const globe = page.locator(".globe-canvas");
    await expect(globe).toHaveAttribute("data-earth-texture", "loaded", { timeout: 30_000 });
    await expect(globe).toHaveAttribute("data-globe-ready", "true");
    await expect(globe).toHaveAttribute("data-starfield", "visible");
    await expect(globe).toHaveAttribute("data-globe-lighting", "solar");
    await expect(globe).toHaveAttribute("data-solar-time", new RegExp(`^${scenario.time.slice(0, 19)}`));
    if (index === 0) {
      await expect.poll(() => starfieldTextureResponses.size).toBe(6);
      expect([...starfieldTextureResponses.values()].every((status) => status === 200)).toBe(true);
    }
    await attachScreenshot(
      page,
      testInfo,
      `planet-chat-${scenario.name}.png`,
      `globe ${scenario.name}`,
    );
  }

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator(".globe-canvas")).toHaveAttribute("data-globe-ready", "true");
  await attachScreenshot(page, testInfo, "planet-chat-solar-mobile.png", "solar globe mobile");
});

test("pauses ambient globe rotation while an accessible dialog is open", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.setViewportSize({ width: 1440, height: 960 });
  await page.goto("/");

  const globe = page.locator(".globe-canvas");
  await expect(globe).toHaveAttribute("data-globe-ready", "true", { timeout: 30_000 });
  await expect(globe).toHaveAttribute("data-auto-rotation", "active", { timeout: 5_000 });

  await page.evaluate(() => {
    const dialog = document.createElement("dialog");
    dialog.setAttribute("aria-modal", "true");
    document.body.append(dialog);
    dialog.showModal();
  });
  await expect(globe).toHaveAttribute("data-auto-rotation", "paused", { timeout: 5_000 });
  const longitudeWhilePaused = await globe.getAttribute("data-camera-longitude");
  await page.waitForTimeout(2_100);
  await expect(globe).toHaveAttribute("data-camera-longitude", longitudeWhilePaused ?? "");

  await page.evaluate(() => document.querySelector("dialog:modal")?.remove());
  await expect(globe).toHaveAttribute("data-auto-rotation", "active", { timeout: 2_500 });
});

test("resumes ambient globe rotation after a hidden tab interrupts camera input", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.setViewportSize({ width: 1440, height: 960 });
  await page.goto("/");

  const globe = page.locator(".globe-canvas");
  await expect(globe).toHaveAttribute("data-globe-ready", "true", { timeout: 30_000 });
  await expect(globe).toHaveAttribute("data-auto-rotation", "active", { timeout: 5_000 });
  await globe.locator("canvas").first().dispatchEvent("pointerdown", {
    pointerId: 1,
    pointerType: "mouse",
    button: 0,
    buttons: 1,
  });
  await expect(globe).toHaveAttribute("data-auto-rotation", "paused");

  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await expect(globe).toHaveAttribute("data-auto-rotation", "paused");
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await expect(globe).toHaveAttribute("data-auto-rotation", "active", { timeout: 5_000 });

  const longitudeAfterResume = await globe.getAttribute("data-camera-longitude");
  await expect.poll(() => globe.getAttribute("data-camera-longitude"), { timeout: 3_000 })
    .not.toBe(longitudeAfterResume);
});

test("falls back to the local globe when configured satellite tiles fail", async ({ page }, testInfo) => {
  test.skip(process.env.MAPTILER_E2E_ENABLED !== "true", "requires the isolated MapTiler provider build");

  const tileRequests: string[] = [];
  let releaseTileFailures: (() => void) | undefined;
  const tileFailureBarrier = new Promise<void>((resolve) => { releaseTileFailures = resolve; });
  await page.route("https://api.maptiler.com/maps/satellite-v4/**", async (route) => {
    tileRequests.push(route.request().url());
    await tileFailureBarrier;
    await route.fulfill({ status: 503, contentType: "text/plain", body: "Simulated tile outage" });
  });
  await page.goto("/");

  const globe = page.locator(".globe-canvas");
  await expect(globe).toHaveAttribute("data-earth-texture", "loaded", { timeout: 30_000 });
  await expect(globe).toHaveAttribute("data-imagery-source", "nasa");
  expect(tileRequests).toEqual([]);

  await page.evaluate(() => {
    const zoomButton = document.querySelector<HTMLButtonElement>("[data-globe-zoom='in']");
    for (let step = 0; step < 15; step += 1) zoomButton?.click();
  });

  await expect(globe).toHaveAttribute("data-imagery-source", "maptiler");
  await expectNoCesiumIonBranding(page);
  await expect(page.locator(".globe-attribution")).toBeVisible();
  await expect(page.locator(".globe-attribution").getByRole("link", { name: "© MapTiler" })).toBeVisible();
  await expect(page.locator(".globe-attribution").getByRole("link", { name: "© OpenStreetMap contributors" })).toBeVisible();

  releaseTileFailures?.();
  await expect.poll(() => tileRequests.length, { timeout: 30_000 }).toBeGreaterThan(0);
  const failedTile = new URL(tileRequests[0]);
  expect(failedTile.pathname).toMatch(/^\/maps\/satellite-v4\/\d+\/\d+\/\d+\.jpg$/);
  expect(failedTile.searchParams.get("key")).toBe("e2e-maptiler-public-key");
  await expect(globe).toHaveAttribute("data-imagery-source", "nasa-fallback", { timeout: 30_000 });
  await expect(globe).toHaveAttribute("data-imagery-status", "provider-unavailable");
  await expect(globe).toHaveAttribute("data-earth-texture", "loaded");
  await expect(page.locator(".globe-attribution").getByRole("link", { name: "© MapTiler" })).toHaveCount(0);
  await attachScreenshot(page, testInfo, "maptiler-unavailable-nasa-fallback.png", "local globe fallback after provider outage");
});

test("connects to the Docker API, persists a guest identity and broadcasts a real message over WebSocket", async ({ page, browser }) => {
  test.skip(!process.env.E2E_BASE_URL, "requires the Docker web and API services");
  await page.unrouteAll();
  await page.goto("/");
  await expect(page.getByRole("status", { name: "Подключено" })).toBeVisible({ timeout: 10_000 });

  const baseUrl = process.env.E2E_BASE_URL!;
  const nickname = `Guest-${Date.now()}`;
  const socketUrl = new URL("/ws", baseUrl);
  socketUrl.protocol = socketUrl.protocol === "https:" ? "wss:" : "ws:";
  const socket = new WebSocket(socketUrl.toString());
  const body = `Проверка сервера ${Date.now()}`;
  const subscriptionReady = new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("WebSocket subscription was not confirmed")), 10_000);
    socket.addEventListener("open", () => socket.send(JSON.stringify({ type: "subscribe", cells: ["sz"] })));
    socket.addEventListener("message", (event) => {
      const payload = JSON.parse(String(event.data)) as { type?: string; cells?: string[] };
      if (payload.type === "subscription_ready" && payload.cells?.includes("sz")) {
        clearTimeout(timeout);
        resolve();
      }
    });
    socket.addEventListener("error", () => {
      clearTimeout(timeout);
      reject(new Error("WebSocket connection failed"));
    });
  });

  try {
    await subscriptionReady;
    const broadcast = new Promise<string>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("WebSocket message was not broadcast")), 10_000);
      socket.addEventListener("message", (event) => {
        const payload = JSON.parse(String(event.data)) as {
          type?: string;
          message?: { body?: string; authorName?: string; authorHandle?: string; authorProfileId?: string };
        };
        if (payload.type === "public_message" && payload.message?.body === body) {
          clearTimeout(timeout);
          resolve(JSON.stringify(payload.message));
        }
      });
    });
    await expect(page.getByRole("textbox", { name: "Ваше сообщение" })).toBeVisible();
    const nicknameInput = page.getByRole("textbox", { name: "Ваш никнейм" });
    await nicknameInput.fill(nickname);
    const composer = page.getByRole("textbox", { name: "Ваше сообщение" });
    await composer.fill(body);
    await expect(composer).toHaveValue(body);
    const sendButton = page.getByRole("button", { name: "Отправить сообщение" });
    await expect(sendButton).toBeEnabled();
    const postResponse = page.waitForResponse(
      (response) => response.url().includes("/api/messages") && response.request().method() === "POST",
    );
    const identityResponse = page.waitForResponse(
      (response) => response.url().includes("/api/guest-session") && response.request().method() === "POST",
    );
    await sendButton.click();
    const createdIdentityResponse = await identityResponse;
    expect(createdIdentityResponse.status()).toBe(201);
    const createdIdentity = await createdIdentityResponse.json() as { id: string };
    const savedResponse = await postResponse;
    expect(savedResponse.status()).toBe(201);
    const savedMessage = await savedResponse.json() as {
      authorName: string;
      authorHandle: string;
      authorProfileId: string;
    };
    expect(savedMessage.authorName).toBe(nickname);
    expect(savedMessage.authorHandle).toBe(`@${nickname.toLocaleLowerCase()}`);
    expect(savedMessage.authorProfileId).toBe(createdIdentity.id);
    expect(savedMessage.authorProfileId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    const rateLimited = await page.context().request.post(`${baseUrl}/api/messages`, {
      data: { body: "Слишком быстро", latitude: 41.7151, longitude: 44.8271 },
    });
    expect(rateLimited.status()).toBe(429);
    expect(rateLimited.headers()["cache-control"]).toBe("no-store");
    expect(rateLimited.headers()["retry-after"]).toMatch(/^[1-9]\d*$/);
    await expect(page.getByRole("complementary", { name: "Публичные сообщения" }).getByText(body)).toBeVisible();
    const broadcastMessage = JSON.parse(await broadcast) as {
      body: string;
      authorName: string;
      authorHandle: string;
      authorProfileId: string;
    };
    expect(broadcastMessage.body).toBe(body);
    expect(broadcastMessage.authorName).toBe(nickname);
    expect(broadcastMessage.authorHandle).toBe(`@${nickname.toLocaleLowerCase()}`);
    expect(broadcastMessage.authorProfileId).toBe(createdIdentity.id);
    const cookie = (await page.context().cookies()).find((item) => item.name === "meridian_guest");
    expect(cookie?.httpOnly).toBe(true);
    expect(cookie?.sameSite).toBe("Lax");
    await expect(page.locator(".message-card").filter({ hasText: body }).getByText(nickname, { exact: true })).toBeVisible();
    const listedResponse = await page.context().request.get(`${baseUrl}/api/messages?cells=sz`);
    expect(listedResponse.status()).toBe(200);
    const listedMessages = await listedResponse.json() as Array<{
      body: string;
      authorName: string;
      authorHandle: string;
      authorProfileId: string;
    }>;
    const listedMessage = listedMessages.find((message) => message.body === body);
    expect(listedMessage?.authorName).toBe(nickname);
    expect(listedMessage?.authorHandle).toBe(`@${nickname.toLocaleLowerCase()}`);
    expect(listedMessage?.authorProfileId).toBe(createdIdentity.id);

    const followPath = `/api/follows/${encodeURIComponent(savedMessage.authorProfileId)}`;
    const selfFollow = await page.context().request.put(`${baseUrl}${followPath}`);
    expect(selfFollow.status()).toBe(422);
    const invalidFollow = await page.context().request.put(`${baseUrl}/api/follows/not-a-uuid`);
    expect(invalidFollow.status()).toBe(400);

    const followerContext = await browser.newContext();
    try {
      const followerNickname = `Follower-${Date.now()}`;
      const followerSession = await followerContext.request.post(`${baseUrl}/api/guest-session`, {
        data: { nickname: followerNickname },
      });
      expect(followerSession.status()).toBe(201);

      const firstFollow = await followerContext.request.put(`${baseUrl}${followPath}`);
      expect(firstFollow.status()).toBe(201);
      const repeatedFollow = await followerContext.request.put(`${baseUrl}${followPath}`);
      expect(repeatedFollow.status()).toBe(204);

      const maximumProfileIDBatch = Array.from({ length: 100 }, () => savedMessage.authorProfileId).join(",");
      const maximumBatchResponse = await followerContext.request.get(
        `${baseUrl}/api/follows?profileIds=${maximumProfileIDBatch}`,
      );
      expect(maximumBatchResponse.status()).toBe(200);
      expect(await maximumBatchResponse.json()).toEqual({ profileIds: [savedMessage.authorProfileId] });
      const oversizedProfileIDBatch = Array.from({ length: 101 }, () => savedMessage.authorProfileId).join(",");
      const oversizedBatchResponse = await followerContext.request.get(
        `${baseUrl}/api/follows?profileIds=${oversizedProfileIDBatch}`,
      );
      expect(oversizedBatchResponse.status()).toBe(400);

      const followingResponse = await followerContext.request.get(`${baseUrl}/api/follows?profileIds=${encodeURIComponent(savedMessage.authorProfileId)}`);
      expect(followingResponse.status()).toBe(200);
      expect(await followingResponse.json()).toEqual({ profileIds: [savedMessage.authorProfileId] });

      const authorFollows = await page.context().request.get(
        `${baseUrl}/api/follows?profileIds=${encodeURIComponent(savedMessage.authorProfileId)}`,
      );
      expect(authorFollows.status()).toBe(200);
      expect(await authorFollows.json()).toEqual({ profileIds: [] });

      const firstUnfollow = await followerContext.request.delete(`${baseUrl}${followPath}`);
      expect(firstUnfollow.status()).toBe(204);
      const repeatedUnfollow = await followerContext.request.delete(`${baseUrl}${followPath}`);
      expect(repeatedUnfollow.status()).toBe(204);
      const followingAfterDelete = await followerContext.request.get(`${baseUrl}/api/follows?profileIds=${encodeURIComponent(savedMessage.authorProfileId)}`);
      expect(followingAfterDelete.status()).toBe(200);
      expect(await followingAfterDelete.json()).toEqual({ profileIds: [] });
    } finally {
      await followerContext.close();
    }

    const duplicateContext = await browser.newContext();
    try {
      const anonymousFollows = await duplicateContext.request.get(
        `${baseUrl}/api/follows?profileIds=${encodeURIComponent(savedMessage.authorProfileId)}`,
      );
      expect(anonymousFollows.status()).toBe(401);
      const duplicate = await duplicateContext.request.post(`${baseUrl}/api/guest-session`, { data: { nickname } });
      expect(duplicate.status()).toBe(409);
      const spoofedMessage = await duplicateContext.request.post(`${baseUrl}/api/messages`, {
        data: { body: "Spoofed author", latitude: 41.7151, longitude: 44.8271, authorName: "Administrator" },
      });
      expect(spoofedMessage.status()).toBe(400);
    } finally {
      await duplicateContext.close();
    }

    let guestSessionRateLimit: { headers: Record<string, string>; body: unknown } | null = null;
    for (let attempt = 0; attempt < 8 && guestSessionRateLimit === null; attempt += 1) {
      const unauthenticatedContext = await browser.newContext();
      try {
        const response = await unauthenticatedContext.request.post(`${baseUrl}/api/guest-session`, {
          headers: { "X-Forwarded-For": `198.51.100.${attempt + 1}` },
          data: { nickname: `Burst-${Date.now()}-${attempt}` },
        });
        if (response.status() === 429) {
          guestSessionRateLimit = {
            headers: response.headers(),
            body: await response.json() as unknown,
          };
        } else {
          expect(response.status()).toBe(201);
        }
      } finally {
        await unauthenticatedContext.close();
      }
    }
    expect(guestSessionRateLimit).not.toBeNull();
    expect(guestSessionRateLimit?.body).toEqual({ error: "guest_session_rate_limited" });
    expect(guestSessionRateLimit?.headers["cache-control"]).toBe("no-store");
    expect(guestSessionRateLimit?.headers["retry-after"]).toBe("6");

    await page.evaluate(() => localStorage.removeItem("meridian-guest-nickname"));
    await page.reload();
    await expect(page.getByRole("textbox", { name: "Ваш никнейм" })).toHaveValue(nickname);
  } finally {
    socket.close();
  }
});

test("broadcasts live online session counts across API replicas", async ({ page }, testInfo) => {
  test.skip(!process.env.E2E_BASE_URL, "requires two Docker API replicas");
  test.setTimeout(90_000);
  await page.unrouteAll();
  await page.setViewportSize({ width: 1440, height: 960 });
  await page.goto("/");

  const onlineCount = page.getByTestId("online-session-count");
  await expect(page.getByRole("status", { name: "Подключено" })).toBeVisible({ timeout: 10_000 });
  await expect(page.locator(".globe-canvas")).toHaveAttribute("data-globe-ready", "true", { timeout: 30_000 });
  const startingCount = Number(await onlineCount.getAttribute("data-online-count"));
  expect(startingCount).toBeGreaterThanOrEqual(1);

  let secondarySocket: WebSocket | null = null;
  const connectSecondary = async () => {
    const socket = new WebSocket("ws://api-secondary:8080/ws");
    secondarySocket = socket;
    const connected = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Secondary API WebSocket did not open")), 10_000);
      socket.addEventListener("open", () => {
        clearTimeout(timeout);
        resolve();
      }, { once: true });
      socket.addEventListener("error", () => {
        clearTimeout(timeout);
        reject(new Error("Secondary API WebSocket failed"));
      }, { once: true });
    });
    await connected;
  };
  const disconnectSecondary = async () => {
    const socket = secondarySocket;
    secondarySocket = null;
    if (!socket || socket.readyState === WebSocket.CLOSED) return;
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(resolve, 3_000);
      socket.addEventListener("close", () => {
        clearTimeout(timeout);
        resolve();
      }, { once: true });
      socket.close(1000, "presence test complete");
    });
  };

  try {
    await connectSecondary();
    // Cross-replica presence converges on a 2s heartbeat; leave room for Docker scheduling jitter.
    await expect.poll(async () => Number(await onlineCount.getAttribute("data-online-count")), { timeout: 10_000 })
      .toBeGreaterThan(startingCount);
    await expect(onlineCount).toContainText("онлайн");
    await attachScreenshot(page, testInfo, "online-sessions-russian-desktop.png", "live sessions from two API replicas");

    await page.getByRole("combobox", { name: "Язык интерфейса" }).selectOption("en");
    await expect(onlineCount).toContainText("online");
    await attachScreenshot(page, testInfo, "online-sessions-english-desktop.png", "live session count in English");

    await page.setViewportSize({ width: 390, height: 844 });
    await attachScreenshot(page, testInfo, "online-sessions-english-mobile.png", "live session count on mobile");

    await disconnectSecondary();
    await expect.poll(async () => Number(await onlineCount.getAttribute("data-online-count")), { timeout: 10_000 })
      .toBe(startingCount);
    await connectSecondary();
    await expect.poll(async () => Number(await onlineCount.getAttribute("data-online-count")), { timeout: 10_000 })
      .toBeGreaterThan(startingCount);
  } finally {
    await disconnectSecondary();
  }

  await expect.poll(async () => Number(await onlineCount.getAttribute("data-online-count")), { timeout: 10_000 })
    .toBe(startingCount);
});
