package main

import (
	"sync"
	"time"
)

const (
	onlinePresenceHeartbeatInterval = 2 * time.Second
	onlinePresenceLeaseTTL          = 8 * time.Second
	onlineCountBroadcastInterval    = time.Second
	maxPresenceNodeIDLength         = 128
	maxSessionsPerNode              = 1_000_000
)

type onlinePresenceSnapshot struct {
	Type     string `json:"type"`
	NodeID   string `json:"nodeId"`
	Count    int    `json:"count"`
	Sequence uint64 `json:"sequence"`
}

type nodePresenceLease struct {
	count      int
	sequence   uint64
	observedAt time.Time
}

// onlinePresenceTracker keeps local socket sessions and short-lived snapshots
// from the other API replicas. The count is deliberately aggregate only.
type onlinePresenceTracker struct {
	mu            sync.Mutex
	nodeID        string
	localSessions int
	sequence      uint64
	nodes         map[string]nodePresenceLease
}

func newOnlinePresenceTracker(nodeID string) *onlinePresenceTracker {
	return &onlinePresenceTracker{
		nodeID: nodeID,
		nodes:  make(map[string]nodePresenceLease),
	}
}

func (p *onlinePresenceTracker) addSession() {
	p.mu.Lock()
	p.localSessions++
	p.mu.Unlock()
}

func (p *onlinePresenceTracker) removeSession() {
	p.mu.Lock()
	if p.localSessions > 0 {
		p.localSessions--
	}
	p.mu.Unlock()
}

func (p *onlinePresenceTracker) snapshot() onlinePresenceSnapshot {
	p.mu.Lock()
	defer p.mu.Unlock()

	p.sequence++
	return onlinePresenceSnapshot{
		Type:     "online_presence",
		NodeID:   p.nodeID,
		Count:    p.localSessions,
		Sequence: p.sequence,
	}
}

func (p *onlinePresenceTracker) apply(snapshot onlinePresenceSnapshot, observedAt time.Time) bool {
	if snapshot.Type != "online_presence" ||
		snapshot.NodeID == "" ||
		len(snapshot.NodeID) > maxPresenceNodeIDLength ||
		snapshot.NodeID == p.nodeID ||
		snapshot.Count < 0 ||
		snapshot.Count > maxSessionsPerNode ||
		snapshot.Sequence == 0 {
		return false
	}

	p.mu.Lock()
	defer p.mu.Unlock()

	if current, ok := p.nodes[snapshot.NodeID]; ok && snapshot.Sequence <= current.sequence {
		return false
	}
	p.nodes[snapshot.NodeID] = nodePresenceLease{
		count:      snapshot.Count,
		sequence:   snapshot.Sequence,
		observedAt: observedAt,
	}
	return true
}

func (p *onlinePresenceTracker) count(now time.Time) int {
	p.mu.Lock()
	defer p.mu.Unlock()

	total := p.localSessions
	for nodeID, lease := range p.nodes {
		if now.Sub(lease.observedAt) >= onlinePresenceLeaseTTL {
			delete(p.nodes, nodeID)
			continue
		}
		total += lease.count
	}
	return total
}
