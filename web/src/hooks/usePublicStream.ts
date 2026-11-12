import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, apiErrorFromResponse } from "../apiError";
import { demoMessages } from "../data/demoMessages";
import { encodeGeohash } from "../geo";
import { PUBLIC_MESSAGE_RETENTION_MS, type PublicMessageDisplaySeconds } from "../publicMessageSettings";
import type { GuestIdentity, NewPublicMessage, PublicMessage } from "../types";
import { useMessageExpiry } from "./useMessageExpiry";

type StreamStatus = "connecting" | "live" | "offline";
type StreamEvent =
  | { type: "public_message"; message: PublicMessage }
  | { type: "subscription_ready"; cells: string[] }
  | { type: "friendship_changed"; requestId: string; state: string }
  | { type: "online_count"; count: number };

function matchesCellSubscription(actual: string[], expected: string[]) {
  const actualCells = new Set(actual);
  const expectedCells = new Set(expected);
  if (actualCells.size !== expectedCells.size) return false;
  for (const cell of expectedCells) {
    if (!actualCells.has(cell)) return false;
  }
  return true;
}

const MAX_STREAM_MESSAGES = 120;

function createLocalMessageId() {
  if (typeof globalThis.crypto?.randomUUID === "function") {
    return `local-${globalThis.crypto.randomUUID()}`;
  }
  return `local-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

export function usePublicStream(
  cells: string[],
  identityId: string | null,
  displayDurationSeconds: PublicMessageDisplaySeconds,
) {
  const [messages, setMessages] = useState<PublicMessage[]>(
    import.meta.env.VITE_DEMO_MODE === "true" ? demoMessages : [],
  );
  const [status, setStatus] = useState<StreamStatus>("connecting");
  const [onlineCount, setOnlineCount] = useState<number | null>(null);
  const [friendshipRevision, setFriendshipRevision] = useState(0);
  const socketRef = useRef<WebSocket | null>(null);
  const syncedSocketRef = useRef<WebSocket | null>(null);
  const latestCellsRef = useRef(cells);
  const latestCellsKeyRef = useRef(cells.join(","));
  const recentMessagesRef = useRef(new Map<string, PublicMessage>());
  const activeMessagesRequestRef = useRef<{ cellsKey: string; controller: AbortController } | null>(null);
  const cellsKey = cells.join(",");
  const forgetRecentMessage = useCallback((messageId: string) => {
    recentMessagesRef.current.delete(messageId);
  }, []);
  const expiringIds = useMessageExpiry(messages, setMessages, forgetRecentMessage, displayDurationSeconds);
  const sendSubscription = useCallback((socket: WebSocket, subscribedCells: string[]) => {
    if (socket.readyState !== WebSocket.OPEN) return;
    setStatus("connecting");
    socket.send(JSON.stringify({ type: "subscribe", cells: subscribedCells }));
  }, []);
  const refreshActiveMessages = useCallback((requestedCellsKey: string) => {
    activeMessagesRequestRef.current?.controller.abort();
    const controller = new AbortController();
    activeMessagesRequestRef.current = { cellsKey: requestedCellsKey, controller };

    void fetch(`/api/messages?cells=${encodeURIComponent(requestedCellsKey)}`, { signal: controller.signal })
      .then(async (response) => response.ok ? response.json() as Promise<unknown> : undefined)
      .then((data: unknown) => {
        if (controller.signal.aborted || !Array.isArray(data)) return;
        const fetchedMessages = data.length > 0
          ? data as PublicMessage[]
          : import.meta.env.VITE_DEMO_MODE === "true"
            ? demoMessages
            : [];
        const now = Date.now();
        const requestedCells = new Set(requestedCellsKey.split(",").filter(Boolean));
        setMessages((current) => {
          const recentMessages = [...recentMessagesRef.current.values()].filter(
            (message) => new Date(message.expiresAt).getTime() > now,
          );
          const currentMessages = current.filter((message) =>
            requestedCells.has(encodeGeohash(message.latitude, message.longitude)),
          );
          const seen = new Set<string>();
          return [...recentMessages, ...currentMessages, ...fetchedMessages].filter((message) => {
            if (seen.has(message.id) || new Date(message.expiresAt).getTime() <= now) return false;
            seen.add(message.id);
            return true;
          }).slice(0, MAX_STREAM_MESSAGES);
        });
      })
      .catch(() => undefined)
      .finally(() => {
        if (activeMessagesRequestRef.current?.controller === controller) {
          activeMessagesRequestRef.current = null;
        }
      });
  }, []);

  useEffect(() => {
    latestCellsRef.current = cells;
    latestCellsKeyRef.current = cellsKey;
    if (socketRef.current?.readyState === WebSocket.OPEN) {
      sendSubscription(socketRef.current, cells);
    }
  }, [cellsKey, sendSubscription]);

  useEffect(() => {
    const timeout = import.meta.env.VITE_DISABLE_REALTIME === "true"
      ? window.setTimeout(() => refreshActiveMessages(cellsKey), 120)
      : undefined;

    return () => {
      if (timeout !== undefined) window.clearTimeout(timeout);
      if (activeMessagesRequestRef.current?.cellsKey === cellsKey) {
        activeMessagesRequestRef.current.controller.abort();
        activeMessagesRequestRef.current = null;
      }
    };
  }, [cellsKey, refreshActiveMessages]);

  useEffect(() => () => {
    activeMessagesRequestRef.current?.controller.abort();
    activeMessagesRequestRef.current = null;
  }, []);

  useEffect(() => {
    let disposed = false;
    if (import.meta.env.VITE_DISABLE_REALTIME === "true") {
      setStatus("offline");
      return () => {
        disposed = true;
      };
    }

    let reconnectTimer = 0;
    let retryDelay = 800;

    const connect = () => {
      if (disposed) return;
      setOnlineCount(null);
      const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
      const socket = new WebSocket(`${protocol}//${window.location.host}/ws`);
      socketRef.current = socket;
      setStatus("connecting");

      socket.addEventListener("open", () => {
        retryDelay = 800;
        sendSubscription(socket, latestCellsRef.current);
      });

      socket.addEventListener("message", (event) => {
        try {
          const payload = JSON.parse(String(event.data)) as StreamEvent;
          if (payload.type === "subscription_ready") {
            if (socketRef.current === socket && matchesCellSubscription(payload.cells, latestCellsRef.current)) {
              setStatus("live");
              refreshActiveMessages(latestCellsKeyRef.current);
              if (syncedSocketRef.current !== socket) {
                syncedSocketRef.current = socket;
                setFriendshipRevision((current) => current + 1);
              }
            }
            return;
          }
          if (payload.type === "friendship_changed") {
            setFriendshipRevision((current) => current + 1);
            return;
          }
          if (payload.type === "online_count") {
            if (Number.isSafeInteger(payload.count) && payload.count >= 0) {
              setOnlineCount(payload.count);
            }
            return;
          }
          if (payload.type === "public_message") {
            setMessages((current) => [payload.message, ...current.filter((message) => message.id !== payload.message.id)]
              .slice(0, MAX_STREAM_MESSAGES));
          }
        } catch {
          // Ignore malformed events and keep the stream connection alive.
        }
      });

      socket.addEventListener("close", () => {
        if (disposed) return;
        setStatus("offline");
        setOnlineCount(null);
        reconnectTimer = window.setTimeout(connect, retryDelay);
        retryDelay = Math.min(retryDelay * 1.8, 12_000);
      });

      socket.addEventListener("error", () => socket.close());
    };

    connect();

    return () => {
      disposed = true;
      window.clearTimeout(reconnectTimer);
      socketRef.current?.close();
      socketRef.current = null;
    };
  }, [identityId, refreshActiveMessages, sendSubscription]);

  const sendMessage = useCallback(async (input: NewPublicMessage, identity: GuestIdentity) => {
    const now = new Date();
    const optimistic: PublicMessage = {
      id: createLocalMessageId(),
      authorName: identity.nickname,
      authorHandle: identity.handle,
      body: input.body,
      latitude: input.latitude,
      longitude: input.longitude,
      city: "Тбилиси",
      country: "Грузия",
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + PUBLIC_MESSAGE_RETENTION_MS).toISOString(),
      avatarColor: identity.avatarColor,
      initials: identity.initials,
    };

    recentMessagesRef.current.set(optimistic.id, optimistic);
    setMessages((current) => [optimistic, ...current].slice(0, MAX_STREAM_MESSAGES));

    try {
      const response = await fetch("/api/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      });
      if (!response.ok) throw await apiErrorFromResponse(response, "message_send_failed");
      const saved = (await response.json()) as PublicMessage;
      recentMessagesRef.current.delete(optimistic.id);
      recentMessagesRef.current.set(saved.id, saved);
      setMessages((current) => [saved, ...current.filter((message) => message.id !== optimistic.id)]
        .slice(0, MAX_STREAM_MESSAGES));
    } catch (cause) {
      recentMessagesRef.current.delete(optimistic.id);
      setMessages((current) => current.filter((message) => message.id !== optimistic.id));
      throw cause instanceof ApiError ? cause : new ApiError("network");
    }
  }, []);

  return { messages, expiringIds, sendMessage, status, friendshipRevision, onlineCount };
}
