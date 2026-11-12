import { useEffect, useRef, useState } from "react";
import { ApiError, apiErrorFromResponse } from "../apiError";
import type { GuestIdentity } from "../types";

const NICKNAME_STORAGE_KEY = "meridian-guest-nickname";

export function clearStoredGuestNickname() {
  try {
    window.localStorage.removeItem(NICKNAME_STORAGE_KEY);
  } catch {
    // A failed local cleanup must not block ending the server session.
  }
}

function readStoredNickname(): string {
  try {
    return window.localStorage.getItem(NICKNAME_STORAGE_KEY) ?? "";
  } catch {
    return "";
  }
}

function storeNickname(nickname: string) {
  try {
    window.localStorage.setItem(NICKNAME_STORAGE_KEY, nickname);
  } catch {
    // The HttpOnly server session remains authoritative when local storage is unavailable.
  }
}

function normalizeNicknameInput(nickname: string): string {
  return nickname.normalize("NFKC").trim().replace(/\s+/gu, " ");
}

export function useGuestIdentity() {
  const [identity, setIdentity] = useState<GuestIdentity | null>(null);
  const [nickname, setNicknameState] = useState(readStoredNickname);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const nicknameWasEdited = useRef(false);

  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/guest-session", { signal: controller.signal })
      .then(async (response) => {
        if (response.status === 204) return null;
        if (!response.ok) throw await apiErrorFromResponse(response, "guest_session_unavailable");
        return (await response.json()) as GuestIdentity;
      })
      .then((current) => {
        if (!current || controller.signal.aborted) return;
        setIdentity(current);
        if (!nicknameWasEdited.current) {
          setNicknameState(current.nickname);
          storeNickname(current.nickname);
        }
      })
      .catch(() => undefined)
      .finally(() => {
        if (!controller.signal.aborted) setIsLoading(false);
      });

    return () => controller.abort();
  }, []);

  function setNickname(value: string) {
    nicknameWasEdited.current = true;
    setNicknameState(value);
    storeNickname(value);
    setError(null);
  }

  async function saveNickname(): Promise<GuestIdentity> {
    const normalizedNickname = normalizeNicknameInput(nickname);
    setIsSaving(true);
    setError(null);
    try {
      const response = await fetch("/api/guest-session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ nickname: normalizedNickname }),
      });
      if (!response.ok) throw await apiErrorFromResponse(response, "guest_session_unavailable");
      const saved = (await response.json()) as GuestIdentity;
      setIdentity(saved);
      setNicknameState(saved.nickname);
      storeNickname(saved.nickname);
      return saved;
    } catch (cause) {
      const failure = cause instanceof ApiError ? cause : new ApiError("network");
      setError(failure.code);
      throw failure;
    } finally {
      setIsSaving(false);
    }
  }

  async function ensureGuestIdentity(): Promise<GuestIdentity> {
    const normalizedNickname = normalizeNicknameInput(nickname);
    if (identity?.nickname === normalizedNickname) return identity;
    return saveNickname();
  }

  return { identity, nickname, setNickname, ensureGuestIdentity, isLoading, isSaving, error };
}
