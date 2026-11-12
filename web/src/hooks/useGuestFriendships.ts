import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { apiErrorFromResponse, ApiError } from "../apiError";
import type { GuestIdentity } from "../types";

export type FriendshipView = "incoming" | "outgoing" | "friends";
export type FriendshipState = "none" | "sent" | "received" | "friends";

export type FriendRequestItem = {
  id: string;
  profileId: string;
  nickname: string;
  handle: string;
  initials: string;
  avatarColor: string;
  state: FriendshipView;
  updatedAt: string;
};

type FriendRequestPage = {
  items: FriendRequestItem[];
  nextCursor: string | null;
  loading: boolean;
  loaded: boolean;
};

type RelationshipResponse = {
  relationships: Array<{ profileId: string; requestId?: string; state: Exclude<FriendshipState, "none"> }>;
};

type FriendRequestPageResponse = {
  items: FriendRequestItem[];
  nextCursor?: string;
};

type FriendRequestUnreadCountResponse = {
  unreadCount: number;
};

export type GuestFriendshipError = {
  code: string;
  source: "read" | "action";
  retryAfterSeconds?: number;
};

const VIEWS: FriendshipView[] = ["incoming", "outgoing", "friends"];
const EMPTY_PAGE: FriendRequestPage = { items: [], nextCursor: null, loading: false, loaded: false };

function emptyPages(): Record<FriendshipView, FriendRequestPage> {
  return { incoming: { ...EMPTY_PAGE }, outgoing: { ...EMPTY_PAGE }, friends: { ...EMPTY_PAGE } };
}

async function fetchRelationships(profileIds: string[], signal?: AbortSignal) {
  if (profileIds.length === 0) return {};
  const query = new URLSearchParams({ profileIds: profileIds.join(",") });
  const response = await fetch(`/api/friendships?${query.toString()}`, { signal });
  if (!response.ok) throw await apiErrorFromResponse(response, "friendships_unavailable");

  const payload = await response.json() as RelationshipResponse;
  return Object.fromEntries(payload.relationships.map((relationship) => [relationship.profileId, {
    state: relationship.state,
    requestId: relationship.requestId ?? null,
  }]));
}

export function useGuestFriendships(
  profileIds: string[],
  identity: GuestIdentity | null,
  ensureGuestIdentity: () => Promise<GuestIdentity>,
) {
  const profileIdsKey = useMemo(() => [...new Set(profileIds.filter(Boolean))].sort().join(","), [profileIds]);
  const currentProfileIds = useMemo(() => profileIdsKey ? profileIdsKey.split(",") : [], [profileIdsKey]);
  const [relationships, setRelationships] = useState<Record<string, { state: FriendshipState; requestId: string | null }>>({});
  const [pages, setPages] = useState<Record<FriendshipView, FriendRequestPage>>(emptyPages);
  const [unreadCount, setUnreadCount] = useState(0);
  const [pendingKeys, setPendingKeys] = useState<Set<string>>(() => new Set());
  const [error, setError] = useState<GuestFriendshipError | null>(null);
  const pendingRef = useRef(new Set<string>());
  const loadedViewsRef = useRef(new Set<FriendshipView>());
  const identityIdRef = useRef(identity?.id);
  const ensureGuestIdentityRef = useRef(ensureGuestIdentity);

  useEffect(() => {
    ensureGuestIdentityRef.current = ensureGuestIdentity;
  }, [ensureGuestIdentity]);

  useEffect(() => {
    const controller = new AbortController();
    const currentIdentityId = identity?.id;
    if (identityIdRef.current !== currentIdentityId) {
      identityIdRef.current = currentIdentityId;
      setRelationships({});
      setPages(emptyPages());
      loadedViewsRef.current.clear();
    }
    if (!currentIdentityId || currentProfileIds.length === 0) {
      setRelationships({});
      return () => controller.abort();
    }

    void fetchRelationships(currentProfileIds, controller.signal)
      .then((result) => {
        if (!controller.signal.aborted) {
          setRelationships(Object.fromEntries(Object.entries(result).map(([profileId, value]) => [
            profileId,
            value as { state: FriendshipState; requestId: string | null },
          ])));
        }
      })
      .catch((cause: unknown) => {
        if (!controller.signal.aborted) {
          setError({
            code: cause instanceof ApiError ? cause.code : "network",
            source: "read",
          });
        }
      });

    return () => controller.abort();
  }, [currentProfileIds, identity?.id]);

  const refreshRelationships = useCallback(async (ids = currentProfileIds) => {
    if (ids.length === 0) return;
    try {
      const result = await fetchRelationships(ids);
      setRelationships((current) => {
        const next = { ...current };
        for (const profileId of ids) delete next[profileId];
        return Object.assign(next, Object.fromEntries(Object.entries(result).map(([profileId, value]) => [
          profileId,
          value as { state: FriendshipState; requestId: string | null },
        ])));
      });
    } catch (cause) {
      setError({ code: cause instanceof ApiError ? cause.code : "network", source: "read" });
      throw cause;
    }
  }, [currentProfileIds]);

  const loadUnreadCount = useCallback(async (signal?: AbortSignal) => {
    if (!identity?.id) {
      setUnreadCount(0);
      return;
    }
    try {
      const response = await fetch("/api/friend-requests/unread-count", { signal });
      if (!response.ok) throw await apiErrorFromResponse(response, "friend_requests_unavailable");
      const result = await response.json() as FriendRequestUnreadCountResponse;
      setUnreadCount(result.unreadCount);
    } catch (cause) {
      if (signal?.aborted) return;
      setError({ code: cause instanceof ApiError ? cause.code : "network", source: "read" });
      throw cause;
    }
  }, [identity?.id]);

  const markFriendRequestsRead = useCallback(async (requestIds: string[]) => {
    if (!identity?.id || requestIds.length === 0) return;
    const response = await fetch("/api/friend-requests/read", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ requestIds }),
    });
    if (!response.ok) throw await apiErrorFromResponse(response, "friend_requests_unavailable");
    const result = await response.json() as FriendRequestUnreadCountResponse;
    setUnreadCount(result.unreadCount);
  }, [identity?.id]);

  useEffect(() => {
    const controller = new AbortController();
    void loadUnreadCount(controller.signal).catch(() => undefined);
    return () => controller.abort();
  }, [identity?.id, loadUnreadCount]);

  const loadView = useCallback(async (view: FriendshipView, cursor?: string, markRead = false) => {
    loadedViewsRef.current.add(view);
    setPages((current) => ({
      ...current,
      [view]: { ...current[view], loading: true },
    }));
    setError(null);

    try {
      await ensureGuestIdentityRef.current();
      const query = new URLSearchParams({ view, limit: "20" });
      if (cursor) query.set("cursor", cursor);
      const response = await fetch(`/api/friend-requests?${query.toString()}`);
      if (!response.ok) throw await apiErrorFromResponse(response, "friend_requests_unavailable");
      const page = await response.json() as FriendRequestPageResponse;
      setPages((current) => ({
        ...current,
        [view]: {
          items: cursor ? [...current[view].items, ...page.items] : page.items,
          nextCursor: page.nextCursor ?? null,
          loading: false,
          loaded: true,
        },
      }));
      if (view === "incoming" && markRead) {
        await markFriendRequestsRead(page.items.map((item) => item.id));
      }
    } catch (cause) {
      setPages((current) => ({
        ...current,
        [view]: { ...current[view], loading: false },
      }));
      setError({
        code: cause instanceof ApiError ? cause.code : "network",
        source: "read",
        retryAfterSeconds: cause instanceof ApiError ? cause.retryAfterSeconds : undefined,
      });
    }
  }, [markFriendRequestsRead]);

  const refreshLoadedViews = useCallback(async () => {
    const loadedViews = VIEWS.filter((view) => loadedViewsRef.current.has(view));
    await Promise.all(loadedViews.map((view) => loadView(view)));
  }, [loadView]);

  const refreshSocialState = useCallback(async (visibleView: FriendshipView | null) => {
    await Promise.allSettled([
      refreshRelationships(),
      loadUnreadCount(),
      ...(visibleView ? [loadView(visibleView, undefined, visibleView === "incoming")] : []),
    ]);
  }, [loadUnreadCount, loadView, refreshRelationships]);

  async function performAction(key: string, action: () => Promise<void>) {
    if (pendingRef.current.has(key)) return;
    pendingRef.current.add(key);
    setPendingKeys(new Set(pendingRef.current));
    setError(null);
    try {
      await ensureGuestIdentity();
      await action();
      await refreshRelationships();
      await refreshLoadedViews();
      await loadUnreadCount().catch(() => undefined);
    } catch (cause) {
      if (cause instanceof ApiError && (cause.code === "friend_request_received" || cause.code === "already_friends")) {
        await refreshRelationships().catch(() => undefined);
      }
      setError({
        code: cause instanceof ApiError ? cause.code : "network",
        source: "action",
        retryAfterSeconds: cause instanceof ApiError ? cause.retryAfterSeconds : undefined,
      });
    } finally {
      pendingRef.current.delete(key);
      setPendingKeys(new Set(pendingRef.current));
    }
  }

  async function requestFriend(profileId: string) {
    await performAction(`profile:${profileId}`, async () => {
      const response = await fetch("/api/friend-requests", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ profileId }),
      });
      if (!response.ok) throw await apiErrorFromResponse(response, "friend_request_failed");
    });
  }

  async function updateRequest(requestId: string, action: "accept" | "decline" | "cancel") {
    await performAction(`request:${requestId}`, async () => {
      const response = await fetch(`/api/friend-requests/${encodeURIComponent(requestId)}${action === "cancel" ? "" : `/${action}`}`, {
        method: action === "cancel" ? "DELETE" : "PUT",
      });
      if (!response.ok) throw await apiErrorFromResponse(response, "friend_request_update_failed");
    });
  }

  async function removeFriend(profileId: string) {
    await performAction(`profile:${profileId}`, async () => {
      const response = await fetch(`/api/friends/${encodeURIComponent(profileId)}`, { method: "DELETE" });
      if (!response.ok) throw await apiErrorFromResponse(response, "friendship_update_failed");
    });
  }

  return {
    relationships,
    pages,
    unreadCount,
    pendingKeys,
    error,
    clearError: () => setError(null),
    loadView,
    refreshSocialState,
    loadNextPage: (view: FriendshipView) => {
      const page = pages[view];
      if (page.nextCursor && !page.loading) void loadView(view, page.nextCursor, view === "incoming");
    },
    requestFriend,
    acceptRequest: (requestId: string) => updateRequest(requestId, "accept"),
    declineRequest: (requestId: string) => updateRequest(requestId, "decline"),
    cancelRequest: (requestId: string) => updateRequest(requestId, "cancel"),
    removeFriend,
  };
}
