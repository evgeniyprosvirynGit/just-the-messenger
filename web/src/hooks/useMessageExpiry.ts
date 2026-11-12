import { useEffect, useRef, useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import { prefersReducedMotion } from "../motion";
import type { PublicMessageDisplaySeconds } from "../publicMessageSettings";
import type { PublicMessage } from "../types";

const EXIT_ANIMATION_MS = 650;

type ExpirationTimers = {
  fade: number;
  remove: number;
};

function clearExpirationTimers(timers: ExpirationTimers) {
  window.clearTimeout(timers.fade);
  window.clearTimeout(timers.remove);
}

export function useMessageExpiry(
  messages: PublicMessage[],
  setMessages: Dispatch<SetStateAction<PublicMessage[]>>,
  onMessageExpired: (messageId: string) => void,
  displayDurationSeconds: PublicMessageDisplaySeconds,
) {
  const [expiringIds, setExpiringIds] = useState<Set<string>>(() => new Set());
  const expirationTimersRef = useRef(new Map<string, ExpirationTimers>());
  const messageArrivalTimesRef = useRef(new Map<string, number>());
  const previousDurationRef = useRef(displayDurationSeconds);

  useEffect(() => {
    const now = Date.now();
    const activeIds = new Set(messages.map((message) => message.id));
    const inactiveIds = new Set<string>();
    const durationChanged = previousDurationRef.current !== displayDurationSeconds;
    previousDurationRef.current = displayDurationSeconds;

    if (durationChanged) {
      for (const timers of expirationTimersRef.current.values()) clearExpirationTimers(timers);
      expirationTimersRef.current.clear();
      setExpiringIds(new Set());
    }

    for (const [id, timers] of expirationTimersRef.current) {
      if (activeIds.has(id)) continue;
      clearExpirationTimers(timers);
      expirationTimersRef.current.delete(id);
      messageArrivalTimesRef.current.delete(id);
      inactiveIds.add(id);
      onMessageExpired(id);
    }

    if (inactiveIds.size > 0) {
      setExpiringIds((current) => {
        let changed = false;
        const next = new Set(current);
        for (const id of inactiveIds) changed = next.delete(id) || changed;
        return changed ? next : current;
      });
    }

    for (const message of messages) {
      if (expirationTimersRef.current.has(message.id)) continue;
      const arrivalTime = messageArrivalTimesRef.current.get(message.id) ?? now;
      messageArrivalTimesRef.current.set(message.id, arrivalTime);
      const viewerExpiryTime = arrivalTime + (displayDurationSeconds * 1_000);
      const serverExpiryTime = new Date(message.expiresAt).getTime();
      const expiryTime = Number.isFinite(serverExpiryTime)
        ? Math.min(viewerExpiryTime, serverExpiryTime)
        : viewerExpiryTime;
      const untilExpiry = Math.max(0, expiryTime - now);
      const exitAnimationMs = prefersReducedMotion() ? 0 : EXIT_ANIMATION_MS;
      const fade = window.setTimeout(() => {
        setExpiringIds((current) => {
          if (current.has(message.id)) return current;
          const next = new Set(current);
          next.add(message.id);
          return next;
        });
      }, Math.max(0, untilExpiry - exitAnimationMs));
      const remove = window.setTimeout(() => {
        setMessages((current) => {
          const next = current.filter((item) => item.id !== message.id);
          return next.length === current.length ? current : next;
        });
        setExpiringIds((current) => {
          if (!current.has(message.id)) return current;
          const next = new Set(current);
          next.delete(message.id);
          return next;
        });
        onMessageExpired(message.id);
        expirationTimersRef.current.delete(message.id);
        messageArrivalTimesRef.current.delete(message.id);
      }, untilExpiry);
      expirationTimersRef.current.set(message.id, { fade, remove });
    }
  }, [displayDurationSeconds, messages, onMessageExpired, setMessages]);

  useEffect(() => () => {
    for (const timers of expirationTimersRef.current.values()) clearExpirationTimers(timers);
    expirationTimersRef.current.clear();
    messageArrivalTimesRef.current.clear();
  }, []);

  return expiringIds;
}
