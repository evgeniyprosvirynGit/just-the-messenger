import { expect, test, type Page, type TestInfo } from "@playwright/test";

async function attachScreenshot(page: Page, testInfo: TestInfo, name: string) {
  const path = testInfo.outputPath(name);
  await page.screenshot({ path, fullPage: true, animations: "disabled" });
  await testInfo.attach(name, { path, contentType: "image/png" });
}

test("Google sign-in controls and callback notices adapt to language and mobile", async ({ page }, testInfo) => {
  await page.route("**/api/auth/google/config", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ googleEnabled: true }),
  }));

  await page.goto("/?auth=google-conflict");
  await expect(page.locator(".globe-canvas")).toHaveAttribute("data-earth-texture", "loaded", { timeout: 30_000 });
  await expect(page.locator(".globe-canvas")).toHaveAttribute("data-globe-ready", "true", { timeout: 30_000 });
  const russianSignIn = page.getByRole("link", { name: "Войти через Google" });
  await expect(russianSignIn).toBeVisible();
  await expect(page.getByRole("status").filter({ hasText: "Этот Google-аккаунт связан с другим профилем" })).toBeVisible();
  await expect(page).not.toHaveURL(/auth=/);
  await attachScreenshot(page, testInfo, "google-auth-russian-desktop.png");

  await page.getByRole("combobox", { name: "Язык интерфейса" }).selectOption("en");
  await expect(page.getByRole("link", { name: "Continue with Google" })).toBeVisible();
  await expect(page.getByRole("status").filter({ hasText: "This Google account is linked to another profile" })).toBeVisible();
  await attachScreenshot(page, testInfo, "google-auth-english-desktop.png");

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole("link", { name: "Continue with Google" })).toBeVisible();
  await attachScreenshot(page, testInfo, "google-auth-english-mobile.png");
});

test("Google sign-in links a guest profile, rotates the session, and restores it after sign-out", async ({ page }, testInfo) => {
  test.skip(!process.env.E2E_BASE_URL, "requires the Docker API and local OIDC provider");
  test.setTimeout(90_000);
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));

  const baseURL = process.env.GOOGLE_E2E_BASE_URL ?? process.env.E2E_BASE_URL!;
  await page.goto(baseURL);
  await expect(page.locator(".globe-canvas")).toHaveAttribute("data-earth-texture", "loaded", { timeout: 60_000 });
  await expect(page.locator(".globe-canvas")).toHaveAttribute("data-globe-ready", "true", { timeout: 30_000 });
  await expect(page.getByRole("link", { name: "Войти через Google" })).toBeVisible();

  const nickname = `Playwright ${Math.random().toString(36).slice(2, 9)}`;
  const created = await page.evaluate(async (value) => {
    const response = await fetch("/api/guest-session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ nickname: value }),
    });
    return { status: response.status, identity: response.ok ? await response.json() : null };
  }, nickname);
  expect(created.status).toBe(201);
  expect(created.identity).not.toBeNull();
  await page.reload();
  await expect(page.locator("#guest-nickname")).toHaveValue(nickname);

  await page.getByRole("button", { name: "Настройки" }).click();
  const guestSettings = page.getByRole("dialog", { name: "Настройки" });
  await guestSettings.getByText("6 сек", { exact: true }).click();
  await expect(guestSettings.getByRole("radio", { name: "6 сек" })).toBeChecked();
  await page.getByRole("button", { name: "Закрыть настройки" }).click();

  const originalSession = await page.evaluate(async () => {
    const response = await fetch("/api/guest-session", { cache: "no-store" });
    return response.ok ? response.json() : null;
  });
  expect(originalSession?.id).toBe(created.identity.id);

  await page.getByRole("link", { name: "Войти через Google" }).click();
  await expect(page.getByRole("button", { name: "Выйти" })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole("status").filter({ hasText: "Профиль связан с Google" })).toBeVisible();
  const linkedSession = await page.evaluate(async () => {
    const response = await fetch("/api/guest-session", { cache: "no-store" });
    return response.ok ? response.json() : null;
  });
  expect(linkedSession?.id).toBe(originalSession.id);
  expect(linkedSession?.authProvider).toBe("google");

  await page.getByRole("button", { name: "Настройки" }).click();
  const accountSettings = page.getByRole("dialog", { name: "Настройки" });
  await expect(accountSettings.getByRole("radio", { name: "6 сек" })).toBeChecked({ timeout: 10_000 });
  await expect(accountSettings.getByRole("status")).toHaveText("Синхронизировано с профилем");
  const savedPreference = page.waitForResponse((response) => (
    new URL(response.url()).pathname === "/api/account/settings"
      && response.request().method() === "PUT"
      && response.status() === 200
  ));
  await accountSettings.getByText("24 сек", { exact: true }).click();
  await savedPreference;
  await expect(accountSettings.getByRole("radio", { name: "24 сек" })).toBeChecked();
  await page.reload();
  await page.getByRole("button", { name: "Настройки" }).click();
  await expect(page.getByRole("dialog", { name: "Настройки" }).getByRole("radio", { name: "24 сек" })).toBeChecked();
  await page.getByRole("button", { name: "Закрыть настройки" }).click();
  await expect(page.locator(".globe-canvas")).toHaveAttribute("data-earth-texture", "loaded", { timeout: 30_000 });
  await expect(page.locator(".globe-canvas")).toHaveAttribute("data-globe-ready", "true", { timeout: 30_000 });
  await expect(page.locator(".globe-canvas canvas").first()).toBeVisible();
  await attachScreenshot(page, testInfo, "google-auth-linked-desktop.png");

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole("button", { name: "Выйти" })).toBeVisible();
  await attachScreenshot(page, testInfo, "google-auth-linked-mobile.png");

  await page.getByRole("button", { name: "Выйти" }).click();
  await expect(page.getByRole("link", { name: "Войти через Google" })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole("status").filter({ hasText: "Вы вышли из профиля" })).toBeVisible();
  await expect(page.locator("#guest-nickname")).toHaveValue("");
  const afterLogout = await page.evaluate(async () => (await fetch("/api/guest-session", { cache: "no-store" })).status);
  expect(afterLogout).toBe(204);

  await page.getByRole("link", { name: "Войти через Google" }).click();
  await expect(page.getByRole("button", { name: "Выйти" })).toBeVisible({ timeout: 30_000 });
  const restoredSession = await page.evaluate(async () => {
    const response = await fetch("/api/guest-session", { cache: "no-store" });
    return response.ok ? response.json() : null;
  });
  expect(restoredSession?.id).toBe(originalSession.id);
  expect(restoredSession?.authProvider).toBe("google");
  await page.getByRole("button", { name: "Открыть меню" }).click();
  await page.getByRole("button", { name: "Настройки" }).click();
  await expect(page.getByRole("dialog", { name: "Настройки" }).getByRole("radio", { name: "24 сек" })).toBeChecked();
  expect(pageErrors).toEqual([]);
});
