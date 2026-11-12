import { expect, test, type BrowserContext, type Page, type TestInfo, type WebSocketRoute } from "@playwright/test";
import { freshMessageFixtureTimes, keepFixtureMessagesVisible } from "./messageFixtures";

const profileIDs = {
  nino: "00000000-0000-4000-8000-000000000001",
  elliot: "00000000-0000-4000-8000-000000000002",
  guest: "00000000-0000-4000-8000-000000000099",
};

const messages = [
  {
    id: "friendship-e2e-nino",
    authorProfileId: profileIDs.nino,
    authorName: "Nino K.",
    authorHandle: "@ninowanders",
    body: "A quiet night above the city.",
    latitude: 41.7151,
    longitude: 44.8271,
    city: "Tbilisi",
    country: "Georgia",
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 300_000).toISOString(),
    avatarColor: "#d6a16d",
    initials: "NK",
  },
  {
    id: "friendship-e2e-elliot",
    authorProfileId: profileIDs.elliot,
    authorName: "Elliot R.",
    authorHandle: "@ellinmotion",
    body: "A new perspective from London.",
    latitude: 51.5072,
    longitude: -0.1276,
    city: "London",
    country: "United Kingdom",
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 300_000).toISOString(),
    avatarColor: "#829ab8",
    initials: "ER",
  },
];

type Identity = {
  id: string;
  nickname: string;
  handle: string;
  avatarColor: string;
  initials: string;
};

type RequestItem = {
  id: string;
  profileId: string;
  nickname: string;
  handle: string;
  initials: string;
  avatarColor: string;
  state: "incoming" | "outgoing" | "friends";
  updatedAt: string;
};

type FriendshipFixture = {
  seedIncoming: (profileId: string) => RequestItem;
  sendFriendshipChanged: (requestId: string, state?: string) => void;
  disconnect: () => Promise<void>;
  waitForConnection: (count: number) => Promise<void>;
};

const existingIdentity: Identity = {
  id: profileIDs.guest,
  nickname: "Mila Guest",
  handle: "@mila-guest",
  avatarColor: "#8c9dcc",
  initials: "MG",
};

async function attachScreenshot(page: Page, testInfo: TestInfo, fileName: string, title: string) {
  const path = testInfo.outputPath(fileName);
  await page.screenshot({ path, fullPage: true, animations: "disabled" });
  await testInfo.attach(title, { path, contentType: "image/png" });
}

async function openFriendshipTestSocket(page: Page) {
  await page.evaluate(() => {
    type FriendshipTestMessage = { type: string; requestId?: string; state?: string };
    type FriendshipTestWindow = Window & {
      __friendshipSocket?: WebSocket;
      __friendshipEvents?: FriendshipTestMessage[];
    };
    const testWindow = window as FriendshipTestWindow;
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const socket = new WebSocket(`${protocol}//${window.location.host}/ws`);
    testWindow.__friendshipSocket = socket;
    testWindow.__friendshipEvents = [];

    return new Promise<void>((resolve, reject) => {
      const timeout = window.setTimeout(() => reject(new Error("WebSocket subscription was not ready")), 15_000);
      socket.addEventListener("open", () => {
        socket.send(JSON.stringify({ type: "subscribe", cells: ["sz"] }));
      }, { once: true });
      socket.addEventListener("message", (event) => {
        try {
          const message = JSON.parse(String(event.data)) as FriendshipTestMessage;
          testWindow.__friendshipEvents?.push(message);
          if (message.type === "subscription_ready") {
            window.clearTimeout(timeout);
            resolve();
          }
        } catch {
          // Ignore non-JSON test frames.
        }
      });
      socket.addEventListener("error", () => {
        window.clearTimeout(timeout);
        reject(new Error("WebSocket connection failed"));
      }, { once: true });
    });
  });
}

async function waitForFriendshipEvent(page: Page, requestId: string, state: string) {
  return page.evaluate(({ requestId: targetRequestId, state: targetState }) => {
    type FriendshipTestMessage = { type: string; requestId?: string; state?: string };
    type FriendshipTestWindow = Window & {
      __friendshipSocket?: WebSocket;
      __friendshipEvents?: FriendshipTestMessage[];
    };
    const testWindow = window as FriendshipTestWindow;
    const socket = testWindow.__friendshipSocket;
    if (!socket) throw new Error("WebSocket test client is not connected");
    const existing = testWindow.__friendshipEvents?.find((message) =>
      message.type === "friendship_changed" && message.requestId === targetRequestId && message.state === targetState,
    );
    if (existing) return existing;

    return new Promise<FriendshipTestMessage>((resolve, reject) => {
      const timeout = window.setTimeout(() => {
        socket.removeEventListener("message", onMessage);
        reject(new Error(`Friendship event ${targetRequestId}/${targetState} was not received`));
      }, 15_000);
      const onMessage = (event: MessageEvent) => {
        try {
          const message = JSON.parse(String(event.data)) as FriendshipTestMessage;
          testWindow.__friendshipEvents?.push(message);
          if (message.type === "friendship_changed" && message.requestId === targetRequestId && message.state === targetState) {
            window.clearTimeout(timeout);
            socket.removeEventListener("message", onMessage);
            resolve(message);
          }
        } catch {
          // Ignore non-JSON test frames.
        }
      };
      socket.addEventListener("message", onMessage);
    });
  }, { requestId, state });
}

async function installRoutes(page: Page, initialIdentity: Identity | null = null): Promise<FriendshipFixture> {
  await keepFixtureMessagesVisible(page);
  let identity = initialIdentity;
  const relationships = new Map<string, { requestId?: string; state: "sent" | "received" | "friends" }>();
  const requests: Record<"incoming" | "outgoing" | "friends", RequestItem[]> = {
    incoming: [],
    outgoing: [],
    friends: [],
  };
  const unreadRequestIDs = new Set<string>();
  let activeSocket: WebSocketRoute | null = null;
  let connectionCount = 0;

  await page.routeWebSocket("**/ws", (socket) => {
    activeSocket = socket;
    connectionCount += 1;
    socket.onMessage((message) => {
      try {
        const control = JSON.parse(String(message)) as { type: string; cells?: string[] };
        if (control.type === "subscribe") {
          socket.send(JSON.stringify({ type: "subscription_ready", cells: control.cells ?? [] }));
        }
      } catch {
        // Keep the fixture socket open for unrelated or malformed controls.
      }
    });
  });

  await page.route("**/api/guest-session", async (route) => {
    if (route.request().method() === "GET") {
      await route.fulfill(identity
        ? { status: 200, contentType: "application/json", body: JSON.stringify(identity) }
        : { status: 204 });
      return;
    }
    const body = route.request().postDataJSON() as { nickname: string };
    identity = {
      id: profileIDs.guest,
      nickname: body.nickname,
      handle: `@${body.nickname.toLowerCase().replaceAll(" ", "-")}`,
      avatarColor: "#8c9dcc",
      initials: body.nickname.slice(0, 2).toUpperCase(),
    };
    await route.fulfill({ status: 201, contentType: "application/json", body: JSON.stringify(identity) });
  });

  await page.route("**/api/messages**", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(freshMessageFixtureTimes(messages)) });
  });

  await page.route("**/api/follows**", async (route) => {
    if (route.request().method() === "GET") {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ profileIds: [] }) });
      return;
    }
    await route.fulfill({ status: route.request().method() === "PUT" ? 201 : 204 });
  });

  await page.route("**/api/friendships**", async (route) => {
    if (route.request().method() !== "GET") {
      await route.fulfill({ status: 405 });
      return;
    }
    const url = new URL(route.request().url());
    const profileList = (url.searchParams.get("profileIds") ?? "").split(",").filter(Boolean);
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        relationships: profileList.flatMap((profileId) => {
          const relationship = relationships.get(profileId);
          return relationship ? [{ profileId, ...relationship }] : [];
        }),
      }),
    });
  });

  await page.route("**/api/friend-requests**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const pathParts = url.pathname.split("/").filter(Boolean);
    const requestID = request.method() === "PUT" ? pathParts.at(-2) : pathParts.at(-1);
    if (request.method() === "GET") {
      if (url.pathname.endsWith("/unread-count")) {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ unreadCount: unreadRequestIDs.size }),
        });
        return;
      }
      const view = url.searchParams.get("view") as keyof typeof requests | null;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ view, items: view ? requests[view] : [] }),
      });
      return;
    }
    if (request.method() === "PUT" && url.pathname.endsWith("/friend-requests/read")) {
      const body = request.postDataJSON() as { requestIds: string[] };
      for (const id of body.requestIds) unreadRequestIDs.delete(id);
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ unreadCount: unreadRequestIDs.size }),
      });
      return;
    }
    if (request.method() === "POST") {
      const body = request.postDataJSON() as { profileId: string };
      const person = messages.find((message) => message.authorProfileId === body.profileId)!;
      const requestItem: RequestItem = {
        id: `request-${body.profileId}`,
        profileId: body.profileId,
        nickname: person.authorName,
        handle: person.authorHandle,
        initials: person.initials,
        avatarColor: person.avatarColor,
        state: "outgoing",
        updatedAt: new Date().toISOString(),
      };
      relationships.set(body.profileId, { requestId: requestItem.id, state: "sent" });
      requests.outgoing.unshift(requestItem);
      await route.fulfill({ status: 201, contentType: "application/json", body: JSON.stringify({
        requestId: requestItem.id,
        profileId: body.profileId,
        state: "sent",
      }) });
      return;
    }
    if (request.method() === "DELETE" && requestID) {
      const outgoing = requests.outgoing.find((item) => item.id === requestID);
      if (outgoing) relationships.delete(outgoing.profileId);
      requests.outgoing = requests.outgoing.filter((item) => item.id !== requestID);
      await route.fulfill({ status: 204 });
      return;
    }
    if (request.method() === "PUT" && requestID) {
      const action = url.pathname.endsWith("/accept") ? "accept" : "decline";
      const incoming = requests.incoming.find((item) => item.id === requestID);
      if (incoming) {
        requests.incoming = requests.incoming.filter((item) => item.id !== requestID);
        unreadRequestIDs.delete(requestID);
        if (action === "accept") {
          relationships.set(incoming.profileId, { requestId: requestID, state: "friends" });
          requests.friends.unshift({ ...incoming, state: "friends", updatedAt: new Date().toISOString() });
        } else {
          relationships.delete(incoming.profileId);
        }
      }
      await route.fulfill({ status: 204 });
      return;
    }
    await route.fulfill({ status: 405 });
  });

  await page.route("**/api/friends/**", async (route) => {
    const profileId = new URL(route.request().url()).pathname.split("/").at(-1) ?? "";
    relationships.delete(decodeURIComponent(profileId));
    requests.friends = requests.friends.filter((item) => item.profileId !== decodeURIComponent(profileId));
    await route.fulfill({ status: 204 });
  });

  return {
    seedIncoming(profileId) {
      const person = messages.find((message) => message.authorProfileId === profileId)!;
      const item: RequestItem = {
        id: `incoming-${profileId}`,
        profileId,
        nickname: person.authorName,
        handle: person.authorHandle,
        initials: person.initials,
        avatarColor: person.avatarColor,
        state: "incoming",
        updatedAt: new Date().toISOString(),
      };
      relationships.set(profileId, { requestId: item.id, state: "received" });
      requests.incoming.unshift(item);
      unreadRequestIDs.add(item.id);
      return item;
    },
    sendFriendshipChanged(requestId, state = "pending") {
      activeSocket?.send(JSON.stringify({ type: "friendship_changed", requestId, state }));
    },
    async disconnect() {
      await activeSocket?.close({ code: 1001, reason: "simulate reconnect" });
      activeSocket = null;
    },
    async waitForConnection(count) {
      await expect.poll(() => connectionCount, { timeout: 20_000 }).toBeGreaterThanOrEqual(count);
    },
  };
}

test("sends and cancels a friend request, with responsive localized panel screenshots", async ({ page }, testInfo) => {
  await installRoutes(page);
  await page.goto("/");
  await expect(page.locator(".globe-canvas")).toHaveAttribute("data-earth-texture", "loaded", { timeout: 30_000 });
  await page.getByRole("textbox", { name: "Ваш никнейм" }).fill("Mila Connect");

  const requestResponse = page.waitForResponse((response) =>
    response.url().includes("/api/friend-requests") && response.request().method() === "POST");
  await page.getByRole("button", { name: "Добавить Nino K." }).click();
  expect((await requestResponse).status()).toBe(201);
  await expect(page.getByText("Запрос отправлен", { exact: true })).toBeVisible();
  await attachScreenshot(page, testInfo, "friends-request-sent-desktop.png", "friend request sent from the public feed");

  await page.locator(".sidebar-nav").getByRole("button", { name: "Друзья" }).click();
  await expect(page.getByRole("heading", { name: "Друзья" })).toBeVisible();
  await expect(page.getByText("Входящих запросов пока нет.")).toBeVisible();
  await attachScreenshot(page, testInfo, "friends-incoming-empty-desktop.png", "incoming friends panel empty state");

  await page.getByRole("button", { name: "Отправленные" }).click();
  const cancelButton = page.getByRole("button", { name: "Отменить Nino K." });
  await expect(cancelButton).toBeVisible();
  await attachScreenshot(page, testInfo, "friends-outgoing-desktop.png", "outgoing friend request");
  await cancelButton.click();
  await expect(page.getByText("Вы ещё не отправляли запросы.")).toBeVisible();

  await page.getByRole("button", { name: "Включить светлую тему" }).click();
  await page.getByRole("combobox", { name: "Язык интерфейса" }).selectOption("en");
  await expect(page.getByRole("heading", { name: "Friends" })).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await attachScreenshot(page, testInfo, "friends-panel-mobile-light-en.png", "friends panel on mobile in English light theme");
});

test("accepts an incoming request from the message card and manages accepted friends", async ({ page }, testInfo) => {
  const fixture = await installRoutes(page, existingIdentity);
  fixture.seedIncoming(profileIDs.nino);
  await page.goto("/");
  await expect(page.locator(".globe-canvas")).toHaveAttribute("data-earth-texture", "loaded", { timeout: 30_000 });

  const acceptButton = page.getByRole("button", { name: "Принять Nino K." });
  await expect(acceptButton).toBeVisible();
  await acceptButton.click();
  await expect(page.locator(".friendship-status--active")).toHaveText("В друзьях");
  await attachScreenshot(page, testInfo, "friends-accepted-from-feed.png", "friendship accepted from the public feed");

  await page.locator(".sidebar-nav").getByRole("button", { name: "Друзья" }).click();
  await page.locator(".friends-panel").getByRole("button", { name: "Друзья", exact: true }).click();
  await expect(page.getByRole("button", { name: "Удалить Nino K." })).toBeVisible();
  await attachScreenshot(page, testInfo, "friends-list-desktop.png", "accepted friends list");
});

test("refreshes friendship notifications live and recovers missed updates after reconnect", async ({ page }, testInfo) => {
  const fixture = await installRoutes(page, existingIdentity);
  await page.goto("/");
  await expect(page.locator(".globe-canvas")).toHaveAttribute("data-earth-texture", "loaded", { timeout: 30_000 });
  await fixture.waitForConnection(1);
  await expect(page.locator(".connection-pill--live")).toBeVisible();

  const incoming = fixture.seedIncoming(profileIDs.nino);
  fixture.sendFriendshipChanged(incoming.id, "pending");
  const friendsNavigation = page.locator(".sidebar-nav").getByRole("button", { name: "Друзья" });
  await expect(friendsNavigation.locator(".side-nav-count")).toHaveText("1");
  await friendsNavigation.click();
  await expect(page.locator(".friends-panel").getByText("Nino K.", { exact: true })).toBeVisible();
  await expect(friendsNavigation.locator(".side-nav-count")).toHaveCount(0);

  const missed = fixture.seedIncoming(profileIDs.elliot);
  await fixture.disconnect();
  await fixture.waitForConnection(2);
  await expect(page.locator(".friends-panel").getByText("Elliot R.", { exact: true })).toBeVisible({ timeout: 20_000 });
  await expect(friendsNavigation.locator(".side-nav-count")).toHaveCount(0);
  await attachScreenshot(page, testInfo, "friends-live-and-reconnected-desktop.png", "friendship state refreshed after live event and reconnect");

  await page.getByRole("button", { name: "Включить светлую тему" }).click();
  await page.getByRole("combobox", { name: "Язык интерфейса" }).selectOption("en");
  await page.setViewportSize({ width: 390, height: 844 });
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await attachScreenshot(page, testInfo, "friends-live-mobile-light-en.png", "live friends panel on mobile in English light theme");
  expect(missed.id).not.toBe(incoming.id);
});

async function createGuestIdentityWithRetry(
  context: BrowserContext,
  baseUrl: string,
  nickname: string,
) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const response = await context.request.post(`${baseUrl}/api/guest-session`, { data: { nickname } });
    if (response.status() === 429) {
      const retryAfter = Number(response.headers()["retry-after"] ?? "6");
      await new Promise((resolve) => setTimeout(resolve, (retryAfter + 0.1) * 1_000));
      continue;
    }
    expect(response.status(), await response.text()).toBe(201);
    return await response.json() as Identity;
  }
  throw new Error("Could not create a guest identity within the retry window");
}

test("enforces guest ownership and persists the complete friend request lifecycle", async ({ browser }, testInfo) => {
  test.skip(!process.env.E2E_BASE_URL, "requires the Docker web and API services");
  test.setTimeout(90_000);
  const baseUrl = process.env.E2E_BASE_URL!;
  const senderContext = await browser.newContext();
  const recipientContext = await browser.newContext();

  try {
    const suffix = Date.now().toString(36);
    const sender = await createGuestIdentityWithRetry(senderContext, baseUrl, `Sender ${suffix}`);
    const recipient = await createGuestIdentityWithRetry(recipientContext, baseUrl, `Recipient ${suffix}`);
    const senderPage = await senderContext.newPage();
    const recipientPage = await recipientContext.newPage();
    await Promise.all([senderPage.goto(baseUrl), recipientPage.goto(baseUrl)]);
    await Promise.all([openFriendshipTestSocket(senderPage), openFriendshipTestSocket(recipientPage)]);
    const requests = senderContext.request;
    const recipientRequests = recipientContext.request;

    const unauthenticated = await browser.newContext();
    const anonymousList = await unauthenticated.request.get(`${baseUrl}/api/friend-requests?view=incoming`);
    expect(anonymousList.status()).toBe(401);
    await unauthenticated.close();

    const selfRequest = await requests.post(`${baseUrl}/api/friend-requests`, { data: { profileId: sender.id } });
    expect(selfRequest.status()).toBe(422);

    const firstRequest = await requests.post(`${baseUrl}/api/friend-requests`, { data: { profileId: recipient.id } });
    expect(firstRequest.status()).toBe(201);
    expect(firstRequest.headers()["cache-control"]).toBe("no-store");
    const created = await firstRequest.json() as { requestId: string; profileId: string; state: string };
    expect(created).toMatchObject({ profileId: recipient.id, state: "sent" });
    const incomingEvent = await waitForFriendshipEvent(recipientPage, created.requestId, "pending");
    expect(incomingEvent).toMatchObject({ type: "friendship_changed", requestId: created.requestId, state: "pending" });
    expect(await senderPage.evaluate((requestId) => {
      type TestWindow = Window & { __friendshipEvents?: Array<{ type: string; requestId?: string }> };
      return (window as TestWindow).__friendshipEvents?.filter((event) =>
        event.type === "friendship_changed" && event.requestId === requestId,
      ) ?? [];
    }, created.requestId)).toEqual([]);

    const recipientUnread = await recipientRequests.get(`${baseUrl}/api/friend-requests/unread-count`);
    expect(recipientUnread.status()).toBe(200);
    expect(await recipientUnread.json()).toEqual({ unreadCount: 1 });
    const wrongOwnerRead = await requests.put(`${baseUrl}/api/friend-requests/read`, { data: { requestIds: [created.requestId] } });
    expect(wrongOwnerRead.status()).toBe(200);
    expect(await wrongOwnerRead.json()).toEqual({ unreadCount: 0 });
    const markedRead = await recipientRequests.put(`${baseUrl}/api/friend-requests/read`, { data: { requestIds: [created.requestId] } });
    expect(markedRead.status()).toBe(200);
    expect(await markedRead.json()).toEqual({ unreadCount: 0 });

    const duplicateRequest = await requests.post(`${baseUrl}/api/friend-requests`, { data: { profileId: recipient.id } });
    expect(duplicateRequest.status()).toBe(200);
    expect((await duplicateRequest.json()).requestId).toBe(created.requestId);

    const reverseRequest = await recipientRequests.post(`${baseUrl}/api/friend-requests`, { data: { profileId: sender.id } });
    expect(reverseRequest.status()).toBe(409);
    expect((await reverseRequest.json()).error).toBe("friend_request_received");

    const recipientList = await recipientRequests.get(`${baseUrl}/api/friend-requests?view=incoming&limit=10`);
    expect(recipientList.status()).toBe(200);
    const incoming = await recipientList.json() as { items: Array<Record<string, unknown>> };
    expect(incoming.items).toHaveLength(1);
    expect(incoming.items[0]).toMatchObject({ id: created.requestId, profileId: sender.id, state: "incoming" });
    expect(Object.keys(incoming.items[0]).sort()).toEqual([
      "avatarColor", "handle", "id", "initials", "nickname", "profileId", "state", "updatedAt",
    ]);
    expect(JSON.stringify(incoming.items[0])).not.toMatch(/latitude|longitude|city|country|email/i);

    const wrongOwnerAccept = await requests.put(`${baseUrl}/api/friend-requests/${created.requestId}/accept`);
    expect(wrongOwnerAccept.status()).toBe(404);
    const acceptedEventPromise = waitForFriendshipEvent(senderPage, created.requestId, "accepted");
    const accepted = await recipientRequests.put(`${baseUrl}/api/friend-requests/${created.requestId}/accept`);
    expect(accepted.status()).toBe(204);
    expect(await acceptedEventPromise).toMatchObject({ type: "friendship_changed", requestId: created.requestId, state: "accepted" });
    expect((await recipientRequests.put(`${baseUrl}/api/friend-requests/${created.requestId}/accept`)).status()).toBe(204);

    const senderFriends = await requests.get(`${baseUrl}/api/friend-requests?view=friends`);
    const recipientFriends = await recipientRequests.get(`${baseUrl}/api/friend-requests?view=friends`);
    expect((await senderFriends.json()).items[0].profileId).toBe(recipient.id);
    expect((await recipientFriends.json()).items[0].profileId).toBe(sender.id);

    const removed = await recipientRequests.delete(`${baseUrl}/api/friends/${sender.id}`);
    expect(removed.status()).toBe(204);
    expect((await recipientRequests.get(`${baseUrl}/api/friendships?profileIds=${sender.id}`).then((response) => response.json())).relationships).toEqual([]);

    const declinedRequest = await requests.post(`${baseUrl}/api/friend-requests`, { data: { profileId: recipient.id } });
    expect(declinedRequest.status()).toBe(201);
    const declinedID = (await declinedRequest.json()).requestId as string;
    expect((await recipientRequests.put(`${baseUrl}/api/friend-requests/${declinedID}/decline`)).status()).toBe(204);
    expect((await recipientRequests.put(`${baseUrl}/api/friend-requests/${declinedID}/decline`)).status()).toBe(204);

    const cancelledRequest = await requests.post(`${baseUrl}/api/friend-requests`, { data: { profileId: recipient.id } });
    expect(cancelledRequest.status()).toBe(201);
    const cancelledID = (await cancelledRequest.json()).requestId as string;
    expect((await requests.delete(`${baseUrl}/api/friend-requests/${cancelledID}`)).status()).toBe(204);
    expect((await requests.delete(`${baseUrl}/api/friend-requests/${cancelledID}`)).status()).toBe(204);

    const outgoing = await requests.get(`${baseUrl}/api/friend-requests?view=outgoing`);
    expect((await outgoing.json()).items).toHaveLength(0);
    for (let requestNumber = 3; requestNumber < 20; requestNumber += 1) {
      const rateLimitRequest = await requests.post(`${baseUrl}/api/friend-requests`, { data: { profileId: recipient.id } });
      expect(rateLimitRequest.status()).toBe(201);
      const rateLimitID = (await rateLimitRequest.json()).requestId as string;
      expect((await requests.delete(`${baseUrl}/api/friend-requests/${rateLimitID}`)).status()).toBe(204);
    }
    const rateLimitedRequest = await requests.post(`${baseUrl}/api/friend-requests`, { data: { profileId: recipient.id } });
    expect(rateLimitedRequest.status()).toBe(429);
    expect(rateLimitedRequest.headers()["cache-control"]).toBe("no-store");
    expect(rateLimitedRequest.headers()["retry-after"]).toMatch(/^[1-9]\d*$/);
    expect((await rateLimitedRequest.json()).error).toBe("friend_request_rate_limited");
    await testInfo.attach("friend-request-api.json", {
      body: JSON.stringify({ senderID: sender.id, recipientID: recipient.id, lifecycle: ["pending", "accepted", "removed", "declined", "cancelled"], rateLimit: "20 per profile per 24 hours" }, null, 2),
      contentType: "application/json",
    });
  } finally {
    await senderContext.close();
    await recipientContext.close();
  }
});
