import { useCallback, useEffect, useState } from "react";
import {
  DEFAULT_PUBLIC_MESSAGE_DISPLAY_SECONDS,
  GUEST_MESSAGE_DISPLAY_SETTING_KEY,
  isPublicMessageDisplaySeconds,
  readGuestMessageDisplaySeconds,
  type PublicMessageDisplaySeconds,
} from "../publicMessageSettings";

export type MessageDisplayPreferenceStatus = "guest" | "loading" | "account" | "saving" | "error";

type AccountPreferenceResponse = {
  publicMessageDisplaySeconds: PublicMessageDisplaySeconds;
  customized: boolean;
};

function isAccountPreferenceResponse(value: unknown): value is AccountPreferenceResponse {
  if (typeof value !== "object" || value === null) return false;
  const response = value as Partial<AccountPreferenceResponse>;
  return isPublicMessageDisplaySeconds(response.publicMessageDisplaySeconds)
    && typeof response.customized === "boolean";
}

async function saveAccountPreference(seconds: PublicMessageDisplaySeconds, signal?: AbortSignal) {
  const response = await fetch("/api/account/settings", {
    method: "PUT",
    cache: "no-store",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ publicMessageDisplaySeconds: seconds }),
    signal,
  });
  if (!response.ok) throw new Error("account_settings_save_failed");

  const result: unknown = await response.json();
  if (!isAccountPreferenceResponse(result) || result.publicMessageDisplaySeconds !== seconds) {
    throw new Error("account_settings_response_invalid");
  }
}

export function useMessageDisplayPreference(authProvider?: "google") {
  const [seconds, setSeconds] = useState<PublicMessageDisplaySeconds>(readGuestMessageDisplaySeconds);
  const [status, setStatus] = useState<MessageDisplayPreferenceStatus>("guest");

  useEffect(() => {
    if (authProvider !== "google") {
      setSeconds(readGuestMessageDisplaySeconds());
      setStatus("guest");
      return;
    }

    const controller = new AbortController();
    let isCurrent = true;
    setStatus("loading");

    void (async () => {
      const response = await fetch("/api/account/settings", {
        cache: "no-store",
        signal: controller.signal,
      });
      if (!response.ok) throw new Error("account_settings_load_failed");

      const result: unknown = await response.json();
      if (!isAccountPreferenceResponse(result)) throw new Error("account_settings_response_invalid");

      let resolvedSeconds = result.publicMessageDisplaySeconds;
      const guestSeconds = readGuestMessageDisplaySeconds();
      if (!result.customized && guestSeconds !== DEFAULT_PUBLIC_MESSAGE_DISPLAY_SECONDS) {
        await saveAccountPreference(guestSeconds, controller.signal);
        resolvedSeconds = guestSeconds;
      }

      if (!isCurrent) return;
      setSeconds(resolvedSeconds);
      setStatus("account");
    })().catch(() => {
      if (!isCurrent || controller.signal.aborted) return;
      setStatus("error");
    });

    return () => {
      isCurrent = false;
      controller.abort();
    };
  }, [authProvider]);

  const updateSeconds = useCallback(async (nextSeconds: PublicMessageDisplaySeconds) => {
    if (!isPublicMessageDisplaySeconds(nextSeconds)) return;
    const previousSeconds = seconds;

    if (authProvider !== "google") {
      try {
        window.localStorage.setItem(GUEST_MESSAGE_DISPLAY_SETTING_KEY, String(nextSeconds));
        setSeconds(nextSeconds);
        setStatus("guest");
      } catch {
        setStatus("error");
      }
      return;
    }

    setSeconds(nextSeconds);
    setStatus("saving");
    try {
      await saveAccountPreference(nextSeconds);
      setStatus("account");
    } catch {
      setSeconds(previousSeconds);
      setStatus("error");
    }
  }, [authProvider, seconds]);

  return { seconds, status, updateSeconds };
}
