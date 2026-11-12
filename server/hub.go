package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/coder/websocket"
	"github.com/nats-io/nats.go"
)

const maxSubscribedCells = 64

var validRegion = regexp.MustCompile(`^[0123456789bcdefghjkmnpqrstuvwxyz]{2}$`)

type Hub struct {
	mu               sync.Mutex
	subscriptionMu   sync.Mutex
	nats             *nats.Conn
	logger           *slog.Logger
	presence         *onlinePresenceTracker
	clients          map[*wsClient]struct{}
	clientsByCell    map[string]map[*wsClient]struct{}
	clientsByProfile map[string]map[*wsClient]struct{}
	subscriptions    map[string]*nats.Subscription
	lastOnlineCount  int
}

type wsClient struct {
	conn      *websocket.Conn
	send      chan []byte
	done      chan struct{}
	closeOnce sync.Once
	cells     map[string]struct{}
	profileID string
}

type clientControlMessage struct {
	Type  string   `json:"type"`
	Cells []string `json:"cells"`
}

type subscriptionReadyEvent struct {
	Type  string   `json:"type"`
	Cells []string `json:"cells"`
}

type onlineCountEvent struct {
	Type  string `json:"type"`
	Count int    `json:"count"`
}

func NewHub(connection *nats.Conn, logger *slog.Logger) *Hub {
	return &Hub{
		nats:             connection,
		logger:           logger,
		presence:         newOnlinePresenceTracker(nats.NewInbox()),
		clients:          make(map[*wsClient]struct{}),
		clientsByCell:    make(map[string]map[*wsClient]struct{}),
		clientsByProfile: make(map[string]map[*wsClient]struct{}),
		subscriptions:    make(map[string]*nats.Subscription),
	}
}

func (h *Hub) startFriendshipBroadcast() error {
	subscription, err := h.nats.Subscribe("social.profile.*", func(message *nats.Msg) {
		parts := strings.Split(message.Subject, ".")
		if len(parts) != 3 || parts[0] != "social" || parts[1] != "profile" {
			return
		}
		profileID, valid := normalizeProfileID(parts[2])
		if !valid {
			return
		}
		h.broadcastProfile(profileID, message.Data)
	})
	if err != nil {
		return fmt.Errorf("subscribe to friendship events: %w", err)
	}
	if err := h.nats.FlushTimeout(2 * time.Second); err != nil {
		_ = subscription.Unsubscribe()
		return fmt.Errorf("confirm friendship event subscription: %w", err)
	}
	return nil
}

func (h *Hub) startPresenceBroadcast(ctx context.Context) error {
	subscription, err := h.nats.Subscribe("planet-chat.presence.api", func(message *nats.Msg) {
		var snapshot onlinePresenceSnapshot
		if err := json.Unmarshal(message.Data, &snapshot); err != nil {
			h.logger.Debug("ignore malformed online presence snapshot", "error", err)
			return
		}
		h.presence.apply(snapshot, time.Now())
	})
	if err != nil {
		return fmt.Errorf("subscribe to online presence: %w", err)
	}
	if err := h.nats.FlushTimeout(2 * time.Second); err != nil {
		_ = subscription.Unsubscribe()
		return fmt.Errorf("confirm online presence subscription: %w", err)
	}

	go h.runPresenceBroadcast(ctx)
	h.publishPresence()
	return nil
}

func (h *Hub) runPresenceBroadcast(ctx context.Context) {
	heartbeatTicker := time.NewTicker(onlinePresenceHeartbeatInterval)
	defer heartbeatTicker.Stop()
	countTicker := time.NewTicker(onlineCountBroadcastInterval)
	defer countTicker.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-heartbeatTicker.C:
			h.publishPresence()
		case <-countTicker.C:
			h.broadcastOnlineCountIfChanged()
		}
	}
}

func (h *Hub) publishPresence() {
	payload, err := json.Marshal(h.presence.snapshot())
	if err != nil {
		h.logger.Error("encode online presence snapshot", "error", err)
		return
	}
	if err := h.nats.Publish("planet-chat.presence.api", payload); err != nil {
		h.logger.Debug("publish online presence snapshot failed", "error", err)
	}
}

func (h *Hub) broadcastOnlineCountIfChanged() {
	count := h.presence.count(time.Now())
	h.mu.Lock()
	if count == h.lastOnlineCount {
		h.mu.Unlock()
		return
	}
	h.lastOnlineCount = count
	clients := make([]*wsClient, 0, len(h.clients))
	for client := range h.clients {
		clients = append(clients, client)
	}
	h.mu.Unlock()
	h.sendOnlineCount(count, clients)
}

func (h *Hub) sendOnlineCount(count int, clients []*wsClient) {
	payload, err := json.Marshal(onlineCountEvent{Type: "online_count", Count: count})
	if err != nil {
		h.logger.Error("encode online count event", "error", err)
		return
	}
	for _, client := range clients {
		h.enqueue(client, payload)
	}
}

func (h *Hub) addClient(client *wsClient) {
	h.mu.Lock()
	h.clients[client] = struct{}{}
	if client.profileID != "" {
		if h.clientsByProfile[client.profileID] == nil {
			h.clientsByProfile[client.profileID] = make(map[*wsClient]struct{})
		}
		h.clientsByProfile[client.profileID][client] = struct{}{}
	}
	h.mu.Unlock()
	h.presence.addSession()
	h.sendOnlineCount(h.presence.count(time.Now()), []*wsClient{client})
}

func (a *application) websocket(w http.ResponseWriter, r *http.Request) {
	connection, err := websocket.Accept(w, r, &websocket.AcceptOptions{
		CompressionMode: websocket.CompressionDisabled,
	})
	if err != nil {
		a.logger.Debug("websocket handshake rejected", "error", err)
		return
	}
	identity, identityErr := a.guestIdentityFromRequest(r)
	if identityErr != nil && !errors.Is(identityErr, sql.ErrNoRows) {
		a.logger.Error("resolve websocket guest session", "error", identityErr)
		_ = connection.Close(websocket.StatusInternalError, "session unavailable")
		return
	}
	profileID := ""
	if identityErr == nil {
		profileID = identity.ID
	}
	connection.SetReadLimit(8 << 10)
	client := &wsClient{
		conn:      connection,
		send:      make(chan []byte, 64),
		done:      make(chan struct{}),
		cells:     make(map[string]struct{}),
		profileID: profileID,
	}
	a.hub.addClient(client)

	writerDone := make(chan struct{})
	go func() {
		defer close(writerDone)
		a.hub.writePump(r.Context(), client)
	}()

	for {
		_, payload, err := connection.Read(r.Context())
		if err != nil {
			if !errors.Is(err, context.Canceled) {
				a.logger.Debug("websocket read ended", "error", err)
			}
			break
		}
		var control clientControlMessage
		if err := json.Unmarshal(payload, &control); err != nil {
			continue
		}
		if control.Type == "subscribe" {
			if err := a.hub.updateSubscriptions(client, control.Cells); err != nil {
				a.logger.Debug("websocket subscription rejected", "error", err)
				client.close()
				break
			}
			payload, err := json.Marshal(subscriptionReadyEvent{Type: "subscription_ready", Cells: control.Cells})
			if err != nil {
				a.logger.Error("websocket subscription confirmation failed", "error", err)
				client.close()
				break
			}
			if !a.hub.enqueue(client, payload) {
				break
			}
		}
	}

	a.hub.removeClient(client)
	_ = connection.Close(websocket.StatusNormalClosure, "connection closed")
	select {
	case <-writerDone:
	case <-time.After(time.Second):
	}
}

func (h *Hub) updateSubscriptions(client *wsClient, requested []string) error {
	if len(requested) > maxSubscribedCells {
		return errors.New("too many geocells")
	}
	wanted := make(map[string]struct{}, len(requested))
	for _, cell := range requested {
		if !validRegion.MatchString(cell) {
			return errors.New("invalid geocell")
		}
		wanted[cell] = struct{}{}
	}

	h.subscriptionMu.Lock()
	defer h.subscriptionMu.Unlock()

	h.mu.Lock()
	newSubscriptions := make([]string, 0, len(wanted))
	for cell := range wanted {
		if _, alreadySubscribed := client.cells[cell]; alreadySubscribed || h.clientsByCell[cell] != nil {
			continue
		}
		subscription, err := h.nats.Subscribe("public.messages."+cell, func(message *nats.Msg) {
			h.broadcast(cell, message.Data)
		})
		if err != nil {
			for _, subscribedCell := range newSubscriptions {
				_ = h.subscriptions[subscribedCell].Unsubscribe()
				delete(h.subscriptions, subscribedCell)
			}
			h.mu.Unlock()
			return fmt.Errorf("subscribe to geocell %q: %w", cell, err)
		}
		h.subscriptions[cell] = subscription
		newSubscriptions = append(newSubscriptions, cell)
	}

	for cell := range client.cells {
		if _, keep := wanted[cell]; keep {
			continue
		}
		h.removeClientFromCellLocked(client, cell)
	}

	for cell := range wanted {
		if h.clientsByCell[cell] == nil {
			h.clientsByCell[cell] = make(map[*wsClient]struct{})
		}
		h.clientsByCell[cell][client] = struct{}{}
	}
	client.cells = wanted
	h.mu.Unlock()

	if len(newSubscriptions) > 0 {
		if err := h.nats.FlushTimeout(2 * time.Second); err != nil {
			h.mu.Lock()
			h.removeClientSubscriptionsLocked(client)
			h.mu.Unlock()
			return fmt.Errorf("confirm geocell subscriptions: %w", err)
		}
	}
	return nil
}

func (h *Hub) removeClient(client *wsClient) {
	h.subscriptionMu.Lock()
	defer h.subscriptionMu.Unlock()

	h.mu.Lock()
	h.removeClientSubscriptionsLocked(client)
	delete(h.clients, client)
	if client.profileID != "" {
		delete(h.clientsByProfile[client.profileID], client)
		if len(h.clientsByProfile[client.profileID]) == 0 {
			delete(h.clientsByProfile, client.profileID)
		}
	}
	h.mu.Unlock()
	h.presence.removeSession()
	client.close()
}

func (h *Hub) removeClientSubscriptionsLocked(client *wsClient) {
	for cell := range client.cells {
		h.removeClientFromCellLocked(client, cell)
	}
	client.cells = make(map[string]struct{})
}

func (h *Hub) removeClientFromCellLocked(client *wsClient, cell string) {
	delete(h.clientsByCell[cell], client)
	if len(h.clientsByCell[cell]) != 0 {
		return
	}
	delete(h.clientsByCell, cell)
	if subscription := h.subscriptions[cell]; subscription != nil {
		_ = subscription.Unsubscribe()
		delete(h.subscriptions, cell)
	}
}

func (h *Hub) broadcast(cell string, payload []byte) {
	h.mu.Lock()
	clients := make([]*wsClient, 0, len(h.clientsByCell[cell]))
	for client := range h.clientsByCell[cell] {
		clients = append(clients, client)
	}
	h.mu.Unlock()

	for _, client := range clients {
		h.enqueue(client, payload)
	}
}

func (h *Hub) broadcastProfile(profileID string, payload []byte) {
	h.mu.Lock()
	clients := make([]*wsClient, 0, len(h.clientsByProfile[profileID]))
	for client := range h.clientsByProfile[profileID] {
		clients = append(clients, client)
	}
	h.mu.Unlock()

	for _, client := range clients {
		h.enqueue(client, payload)
	}
}

func (h *Hub) enqueue(client *wsClient, payload []byte) bool {
	select {
	case client.send <- payload:
		return true
	case <-client.done:
		return false
	default:
		// A slow client reconnects and backfills active messages from the API.
		h.logger.Warn("closing slow websocket client", "reason", "outbound queue full")
		client.close()
		return false
	}
}

func (h *Hub) writePump(ctx context.Context, client *wsClient) {
	for {
		select {
		case <-ctx.Done():
			return
		case <-client.done:
			return
		case payload := <-client.send:
			writeCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
			err := client.conn.Write(writeCtx, websocket.MessageText, payload)
			cancel()
			if err != nil {
				client.close()
				return
			}
		}
	}
}

func (c *wsClient) close() {
	c.closeOnce.Do(func() {
		close(c.done)
		_ = c.conn.CloseNow()
	})
}
