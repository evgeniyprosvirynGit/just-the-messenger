import type { Page } from "@playwright/test";
import { GUEST_MESSAGE_DISPLAY_SETTING_KEY, PUBLIC_MESSAGE_RETENTION_MS } from "../src/publicMessageSettings";

type TimedMessageFixture = {
  createdAt: string;
  expiresAt: string;
};

export function freshMessageFixtureTimes<T extends TimedMessageFixture>(messages: readonly T[]): T[] {
  const latestCreatedAt = Math.max(...messages.map((message) => new Date(message.createdAt).getTime()));
  const now = Date.now();
  const expiresAt = new Date(now + PUBLIC_MESSAGE_RETENTION_MS).toISOString();

  return messages.map((message) => ({
    ...message,
    createdAt: new Date(now - (latestCreatedAt - new Date(message.createdAt).getTime())).toISOString(),
    expiresAt,
  }));
}

export function keepFixtureMessagesVisible(page: Page) {
  return page.addInitScript((key) => localStorage.setItem(key, "24"), GUEST_MESSAGE_DISPLAY_SETTING_KEY);
}
