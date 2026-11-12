import { useEffect, useRef, useState } from "react";
import { ApiError, apiErrorFromResponse } from "../apiError";
import type { GuestIdentity } from "../types";

type FollowListResponse = { profileIds: string[] };
export type GuestFollowError = { code: string; source: "action" | "read" };

export function useGuestFollows(
  profileIds: string[],
  identity: GuestIdentity | null,
  ensureGuestIdentity: () => Promise<GuestIdentity>,
) {
  const [followingProfileIds, setFollowingProfileIds] = useState<Set<string>>(() => new Set());
  const [pendingProfileIds, setPendingProfileIds] = useState<Set<string>>(() => new Set());
  const [error, setError] = useState<GuestFollowError | null>(null);
  const pendingRef = useRef<Set<string>>(new Set());
  const identityPromiseRef = useRef<Promise<GuestIdentity> | null>(null);
  const requestRevisionRef = useRef(0);
  const currentIdentityIdRef = useRef<string | null>(null);
  const profileIdsKey = Array.from(new Set(profileIds)).sort().join(",");

  useEffect(() => {
    if (!identity) {
      currentIdentityIdRef.current = null;
      setFollowingProfileIds(new Set());
      setError((current) => current?.source === "read" ? null : current);
      return;
    }
    if (currentIdentityIdRef.current !== identity.id) {
      currentIdentityIdRef.current = identity.id;
      setFollowingProfileIds(new Set());
    }
    if (!profileIdsKey || pendingProfileIds.size > 0) return;

    const controller = new AbortController();
    const requestRevision = requestRevisionRef.current;
    const params = new URLSearchParams({ profileIds: profileIdsKey });

    fetch(`/api/follows?${params.toString()}`, { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw await apiErrorFromResponse(response, "follows_unavailable");
        return (await response.json()) as FollowListResponse;
      })
      .then((result) => {
        if (controller.signal.aborted || requestRevision !== requestRevisionRef.current) return;
        setFollowingProfileIds(new Set(result.profileIds));
        setError((current) => current?.source === "read" ? null : current);
      })
      .catch((cause: unknown) => {
        if (controller.signal.aborted || requestRevision !== requestRevisionRef.current) return;
        setError((current) => current?.source === "action"
          ? current
          : { code: cause instanceof ApiError ? cause.code : "network", source: "read" });
      });

    return () => controller.abort();
  }, [profileIdsKey, identity?.id, pendingProfileIds.size]);

  async function ensureIdentityOnce() {
    let identityPromise = identityPromiseRef.current;
    if (!identityPromise) {
      identityPromise = ensureGuestIdentity();
      identityPromiseRef.current = identityPromise;
    }
    try {
      return await identityPromise;
    } finally {
      if (identityPromiseRef.current === identityPromise) identityPromiseRef.current = null;
    }
  }

  async function toggleFollow(profileId: string) {
    if (pendingRef.current.has(profileId)) return;

    pendingRef.current = new Set(pendingRef.current).add(profileId);
    setPendingProfileIds(new Set(pendingRef.current));
    setError(null);
    requestRevisionRef.current += 1;

    try {
      await ensureIdentityOnce();

      const shouldFollow = !followingProfileIds.has(profileId);
      const response = await fetch(`/api/follows/${encodeURIComponent(profileId)}`, {
        method: shouldFollow ? "PUT" : "DELETE",
      });
      if (!response.ok) throw await apiErrorFromResponse(response, "follow_update_failed");

      requestRevisionRef.current += 1;
      setFollowingProfileIds((current) => {
        const next = new Set(current);
        if (shouldFollow) next.add(profileId);
        else next.delete(profileId);
        return next;
      });
    } catch (cause) {
      setError({ code: cause instanceof ApiError ? cause.code : "network", source: "action" });
    } finally {
      requestRevisionRef.current += 1;
      const nextPending = new Set(pendingRef.current);
      nextPending.delete(profileId);
      pendingRef.current = nextPending;
      setPendingProfileIds(nextPending);
    }
  }

  return { followingProfileIds, pendingProfileIds, error, toggleFollow };
}
