package main

import (
	"testing"
	"time"
)

func TestOnlinePresenceCountsSessionsAcrossReplicas(t *testing.T) {
	now := time.Date(2026, time.November, 12, 10, 0, 0, 0, time.UTC)
	first := newOnlinePresenceTracker("api-a")
	second := newOnlinePresenceTracker("api-b")

	first.addSession()
	first.addSession()
	second.addSession()

	if !second.apply(first.snapshot(), now) {
		t.Fatal("expected replica snapshot to be accepted")
	}
	if got := second.count(now); got != 3 {
		t.Fatalf("expected 3 active sessions across replicas, got %d", got)
	}

	first.removeSession()
	updated := first.snapshot()
	if !second.apply(updated, now.Add(time.Second)) {
		t.Fatal("expected newer replica snapshot to be accepted")
	}
	if got := second.count(now.Add(time.Second)); got != 2 {
		t.Fatalf("expected updated count of 2, got %d", got)
	}
}

func TestOnlinePresenceExpiresStaleReplicaLease(t *testing.T) {
	now := time.Date(2026, time.November, 12, 10, 0, 0, 0, time.UTC)
	tracker := newOnlinePresenceTracker("api-a")
	tracker.addSession()

	if !tracker.apply(onlinePresenceSnapshot{
		Type:     "online_presence",
		NodeID:   "api-b",
		Count:    5,
		Sequence: 1,
	}, now) {
		t.Fatal("expected replica snapshot to be accepted")
	}
	if got := tracker.count(now.Add(onlinePresenceLeaseTTL - time.Nanosecond)); got != 6 {
		t.Fatalf("expected active replica lease to contribute 5 sessions, got %d", got)
	}
	if got := tracker.count(now.Add(onlinePresenceLeaseTTL)); got != 1 {
		t.Fatalf("expected stale replica lease to expire, got %d sessions", got)
	}
}

func TestOnlinePresenceRejectsInvalidAndOutOfOrderSnapshots(t *testing.T) {
	now := time.Date(2026, time.November, 12, 10, 0, 0, 0, time.UTC)
	tracker := newOnlinePresenceTracker("api-a")
	invalid := []onlinePresenceSnapshot{
		{Type: "wrong_type", NodeID: "api-b", Count: 2, Sequence: 1},
		{Type: "online_presence", NodeID: "api-a", Count: 2, Sequence: 1},
		{Type: "online_presence", NodeID: "api-b", Count: -1, Sequence: 1},
		{Type: "online_presence", NodeID: "api-b", Count: maxSessionsPerNode + 1, Sequence: 1},
		{Type: "online_presence", NodeID: "api-b", Count: 2},
	}
	for _, snapshot := range invalid {
		if tracker.apply(snapshot, now) {
			t.Errorf("unexpectedly accepted invalid snapshot: %+v", snapshot)
		}
	}

	newer := onlinePresenceSnapshot{
		Type:     "online_presence",
		NodeID:   "api-b",
		Count:    3,
		Sequence: 2,
	}
	if !tracker.apply(newer, now) {
		t.Fatal("expected newer snapshot to be accepted")
	}
	older := newer
	older.Count = 20
	older.Sequence = 1
	if tracker.apply(older, now.Add(time.Second)) {
		t.Fatal("unexpectedly accepted out-of-order snapshot")
	}
	if got := tracker.count(now.Add(time.Second)); got != 3 {
		t.Fatalf("expected newest snapshot count of 3, got %d", got)
	}
}
