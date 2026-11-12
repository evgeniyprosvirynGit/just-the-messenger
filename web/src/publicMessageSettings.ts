export const PUBLIC_MESSAGE_DISPLAY_OPTIONS_SECONDS = [6, 12, 24] as const;
export type PublicMessageDisplaySeconds = (typeof PUBLIC_MESSAGE_DISPLAY_OPTIONS_SECONDS)[number];

export const DEFAULT_PUBLIC_MESSAGE_DISPLAY_SECONDS: PublicMessageDisplaySeconds = 12;
export const PUBLIC_MESSAGE_RETENTION_MS = 30_000;
export const GUEST_MESSAGE_DISPLAY_SETTING_KEY = "meridian-message-display-seconds";

export function isPublicMessageDisplaySeconds(value: unknown): value is PublicMessageDisplaySeconds {
  return typeof value === "number"
    && PUBLIC_MESSAGE_DISPLAY_OPTIONS_SECONDS.includes(value as PublicMessageDisplaySeconds);
}

export function readGuestMessageDisplaySeconds(): PublicMessageDisplaySeconds {
  if (typeof window === "undefined") return DEFAULT_PUBLIC_MESSAGE_DISPLAY_SECONDS;
  try {
    const stored = Number(window.localStorage.getItem(GUEST_MESSAGE_DISPLAY_SETTING_KEY));
    return isPublicMessageDisplaySeconds(stored) ? stored : DEFAULT_PUBLIC_MESSAGE_DISPLAY_SECONDS;
  } catch {
    return DEFAULT_PUBLIC_MESSAGE_DISPLAY_SECONDS;
  }
}
