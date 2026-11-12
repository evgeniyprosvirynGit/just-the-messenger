package main

import (
	"context"
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"errors"
	"math"
	"net/http"
	"strconv"
	"strings"
	"time"
)

const (
	maxFriendRequestsPerDay = 20
	defaultFriendPageSize   = 20
	maxFriendPageSize       = 50
	maxFriendRequestBody    = 1024
)

type createFriendRequestRequest struct {
	ProfileID string "json:\"profileId\""
}

type friendRelationship struct {
	ProfileID string "json:\"profileId\""
	RequestID string "json:\"requestId,omitempty\""
	State     string "json:\"state\""
}

type friendshipsResponse struct {
	Relationships []friendRelationship "json:\"relationships\""
}

type friendRequestItem struct {
	ID          string    "json:\"id\""
	ProfileID   string    "json:\"profileId\""
	Nickname    string    "json:\"nickname\""
	Handle      string    "json:\"handle\""
	Initials    string    "json:\"initials\""
	AvatarColor string    "json:\"avatarColor\""
	State       string    "json:\"state\""
	UpdatedAt   time.Time "json:\"updatedAt\""
}

type friendRequestPage struct {
	View       string              "json:\"view\""
	Items      []friendRequestItem "json:\"items\""
	NextCursor string              "json:\"nextCursor,omitempty\""
}

type friendRequestCursor struct {
	Timestamp time.Time "json:\"timestamp\""
	ID        string    "json:\"id\""
}

type friendRequestStateResponse struct {
	RequestID string "json:\"requestId\""
	ProfileID string "json:\"profileId\""
	State     string "json:\"state\""
}

type friendRequestReadRequest struct {
	RequestIDs []string "json:\"requestIds\""
}

type friendRequestUnreadCountResponse struct {
	UnreadCount int "json:\"unreadCount\""
}

type friendshipChangedEvent struct {
	Type      string "json:\"type\""
	RequestID string "json:\"requestId\""
	State     string "json:\"state\""
}

func enqueueFriendshipChanged(ctx context.Context, tx *sql.Tx, profileID, requestID, state string) error {
	payload, err := json.Marshal(friendshipChangedEvent{
		Type:      "friendship_changed",
		RequestID: requestID,
		State:     state,
	})
	if err != nil {
		return err
	}
	_, err = tx.ExecContext(ctx,
		"INSERT INTO realtime_outbox (subject, payload) VALUES ($1, $2::jsonb)",
		"social.profile."+profileID,
		string(payload),
	)
	return err
}

func (a *application) friendRequestUnreadCount(w http.ResponseWriter, r *http.Request) {
	identity, ok := a.guestIdentityForSocialRequest(w, r, "friendships")
	if !ok {
		return
	}

	var unreadCount int
	err := a.db.QueryRowContext(r.Context(), `
		SELECT count(*)
		FROM guest_friend_requests
		WHERE recipient_profile_id = $1::uuid
		  AND status = 'pending'
		  AND recipient_read_at IS NULL
	`, identity.ID).Scan(&unreadCount)
	if err != nil {
		a.logger.Error("count unread friend requests", "error", err)
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "friend_requests_unavailable"})
		return
	}
	writeJSON(w, http.StatusOK, friendRequestUnreadCountResponse{UnreadCount: unreadCount})
}

func (a *application) markFriendRequestsRead(w http.ResponseWriter, r *http.Request) {
	identity, ok := a.guestIdentityForSocialRequest(w, r, "friendships")
	if !ok {
		return
	}

	var payload friendRequestReadRequest
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, maxFriendRequestBody))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&payload); err != nil || ensureSingleJSONValue(decoder) != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid_friend_request_read"})
		return
	}
	if len(payload.RequestIDs) > maxFriendPageSize {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "too_many_friend_request_ids"})
		return
	}

	requestIDs := make([]string, 0, len(payload.RequestIDs))
	seen := make(map[string]struct{}, len(payload.RequestIDs))
	for _, rawID := range payload.RequestIDs {
		requestID, valid := normalizeProfileID(rawID)
		if !valid {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid_friend_request_id"})
			return
		}
		if _, exists := seen[requestID]; exists {
			continue
		}
		seen[requestID] = struct{}{}
		requestIDs = append(requestIDs, requestID)
	}

	tx, err := a.db.BeginTx(r.Context(), nil)
	if err != nil {
		a.logger.Error("begin friend request read update", "error", err)
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "friend_requests_unavailable"})
		return
	}
	defer tx.Rollback()

	if len(requestIDs) > 0 {
		if _, err := tx.ExecContext(r.Context(), `
			UPDATE guest_friend_requests
			SET recipient_read_at = clock_timestamp()
			WHERE recipient_profile_id = $1::uuid
			  AND id = ANY(string_to_array($2, ',')::uuid[])
			  AND status = 'pending'
			  AND recipient_read_at IS NULL
		`, identity.ID, strings.Join(requestIDs, ",")); err != nil {
			a.logger.Error("mark friend requests read", "error", err)
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "friend_requests_unavailable"})
			return
		}
	}

	var unreadCount int
	if err := tx.QueryRowContext(r.Context(), `
		SELECT count(*)
		FROM guest_friend_requests
		WHERE recipient_profile_id = $1::uuid
		  AND status = 'pending'
		  AND recipient_read_at IS NULL
	`, identity.ID).Scan(&unreadCount); err != nil {
		a.logger.Error("read unread friend request count", "error", err)
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "friend_requests_unavailable"})
		return
	}
	if err := tx.Commit(); err != nil {
		a.logger.Error("commit friend request read update", "error", err)
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "friend_requests_unavailable"})
		return
	}
	writeJSON(w, http.StatusOK, friendRequestUnreadCountResponse{UnreadCount: unreadCount})
}

func (a *application) listFriendships(w http.ResponseWriter, r *http.Request) {
	identity, ok := a.guestIdentityForSocialRequest(w, r, "friendships")
	if !ok {
		return
	}

	profileIDs, err := parseProfileIDs(r.URL.Query().Get("profileIds"))
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid_friend_profile_ids"})
		return
	}
	if len(profileIDs) == 0 {
		writeJSON(w, http.StatusOK, friendshipsResponse{Relationships: []friendRelationship{}})
		return
	}

	rows, err := a.db.QueryContext(r.Context(),
		"SELECT CASE WHEN requests.requester_profile_id = $1::uuid THEN requests.recipient_profile_id::text ELSE requests.requester_profile_id::text END AS profile_id, "+
			"requests.id::text, "+
			"CASE WHEN requests.status = 'accepted' THEN 'friends' WHEN requests.requester_profile_id = $1::uuid THEN 'sent' ELSE 'received' END AS state "+
			"FROM guest_friend_requests AS requests "+
			"WHERE requests.status IN ('pending', 'accepted') AND "+
			"((requests.requester_profile_id = $1::uuid AND requests.recipient_profile_id = ANY(string_to_array($2, ',')::uuid[])) "+
			"OR (requests.recipient_profile_id = $1::uuid AND requests.requester_profile_id = ANY(string_to_array($2, ',')::uuid[])))",
		identity.ID, strings.Join(profileIDs, ","))
	if err != nil {
		a.logger.Error("list guest friendships", "error", err)
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "friendships_unavailable"})
		return
	}
	defer rows.Close()

	relationships := make([]friendRelationship, 0, len(profileIDs))
	for rows.Next() {
		var relationship friendRelationship
		if err := rows.Scan(&relationship.ProfileID, &relationship.RequestID, &relationship.State); err != nil {
			a.logger.Error("read guest friendships", "error", err)
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "friendships_unavailable"})
			return
		}
		relationships = append(relationships, relationship)
	}
	if err := rows.Err(); err != nil {
		a.logger.Error("read guest friendships", "error", err)
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "friendships_unavailable"})
		return
	}

	writeJSON(w, http.StatusOK, friendshipsResponse{Relationships: relationships})
}

func (a *application) listFriendRequests(w http.ResponseWriter, r *http.Request) {
	identity, ok := a.guestIdentityForSocialRequest(w, r, "friendships")
	if !ok {
		return
	}

	view := r.URL.Query().Get("view")
	where, sortColumn, state := friendRequestListQuery(view)
	if where == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid_friend_request_view"})
		return
	}
	limit, err := parseFriendRequestPageSize(r.URL.Query().Get("limit"))
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid_friend_request_limit"})
		return
	}
	cursor, err := decodeFriendRequestCursor(r.URL.Query().Get("cursor"))
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid_friend_request_cursor"})
		return
	}

	query := "SELECT requests.id::text, " +
		"CASE WHEN requests.requester_profile_id = $1::uuid THEN recipient.id::text ELSE requester.id::text END AS profile_id, " +
		"CASE WHEN requests.requester_profile_id = $1::uuid THEN recipient.nickname ELSE requester.nickname END AS nickname, " +
		"CASE WHEN requests.requester_profile_id = $1::uuid THEN recipient.handle ELSE requester.handle END AS handle, " +
		"CASE WHEN requests.requester_profile_id = $1::uuid THEN recipient.initials ELSE requester.initials END AS initials, " +
		"CASE WHEN requests.requester_profile_id = $1::uuid THEN recipient.avatar_color ELSE requester.avatar_color END AS avatar_color, " +
		"$3::text AS state, requests." + sortColumn + " AS updated_at " +
		"FROM guest_friend_requests AS requests " +
		"JOIN guest_profiles AS requester ON requester.id = requests.requester_profile_id " +
		"JOIN guest_profiles AS recipient ON recipient.id = requests.recipient_profile_id " +
		"WHERE " + where
	args := []any{identity.ID, limit + 1, state}
	if cursor != nil {
		query += " AND (requests." + sortColumn + ", requests.id) < ($4::timestamptz, $5::uuid)"
		args = append(args, cursor.Timestamp, cursor.ID)
	}
	query += " ORDER BY requests." + sortColumn + " DESC, requests.id DESC LIMIT $2"

	rows, err := a.db.QueryContext(r.Context(), query, args...)
	if err != nil {
		a.logger.Error("list guest friend requests", "view", view, "error", err)
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "friend_requests_unavailable"})
		return
	}
	defer rows.Close()

	items := make([]friendRequestItem, 0, limit+1)
	for rows.Next() {
		var item friendRequestItem
		if err := rows.Scan(
			&item.ID,
			&item.ProfileID,
			&item.Nickname,
			&item.Handle,
			&item.Initials,
			&item.AvatarColor,
			&item.State,
			&item.UpdatedAt,
		); err != nil {
			a.logger.Error("read guest friend requests", "view", view, "error", err)
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "friend_requests_unavailable"})
			return
		}
		items = append(items, item)
	}
	if err := rows.Err(); err != nil {
		a.logger.Error("read guest friend requests", "view", view, "error", err)
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "friend_requests_unavailable"})
		return
	}

	page := friendRequestPage{View: view, Items: items}
	if len(items) > limit {
		page.Items = items[:limit]
		last := page.Items[len(page.Items)-1]
		page.NextCursor = encodeFriendRequestCursor(friendRequestCursor{Timestamp: last.UpdatedAt, ID: last.ID})
	}
	writeJSON(w, http.StatusOK, page)
}

func (a *application) createFriendRequest(w http.ResponseWriter, r *http.Request) {
	identity, ok := a.guestIdentityForSocialRequest(w, r, "friendships")
	if !ok {
		return
	}

	var payload createFriendRequestRequest
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, maxFriendRequestBody))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&payload); err != nil || ensureSingleJSONValue(decoder) != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid_friend_request"})
		return
	}
	targetID, valid := normalizeProfileID(payload.ProfileID)
	if !valid {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid_friend_profile_id"})
		return
	}
	if targetID == identity.ID {
		writeJSON(w, http.StatusUnprocessableEntity, map[string]string{"error": "cannot_request_self"})
		return
	}

	tx, err := a.db.BeginTx(r.Context(), nil)
	if err != nil {
		a.logger.Error("begin guest friend request", "error", err)
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "friend_request_failed"})
		return
	}
	defer tx.Rollback()

	profileIDs := []string{identity.ID, targetID}
	if profileIDs[1] < profileIDs[0] {
		profileIDs[0], profileIDs[1] = profileIDs[1], profileIDs[0]
	}
	for _, profileID := range profileIDs {
		var lockedProfileID string
		err := tx.QueryRowContext(r.Context(),
			"SELECT id::text FROM guest_profiles WHERE id = $1::uuid FOR NO KEY UPDATE",
			profileID).Scan(&lockedProfileID)
		if errors.Is(err, sql.ErrNoRows) {
			writeJSON(w, http.StatusNotFound, map[string]string{"error": "friend_target_unavailable"})
			return
		}
		if err != nil {
			a.logger.Error("lock friend request profiles", "error", err)
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "friend_request_failed"})
			return
		}
	}

	var existingID, existingRequesterID, existingStatus string
	err = tx.QueryRowContext(r.Context(),
		"SELECT id::text, requester_profile_id::text, status FROM guest_friend_requests "+
			"WHERE LEAST(requester_profile_id, recipient_profile_id) = LEAST($1::uuid, $2::uuid) "+
			"AND GREATEST(requester_profile_id, recipient_profile_id) = GREATEST($1::uuid, $2::uuid) "+
			"AND status IN ('pending', 'accepted') FOR UPDATE",
		identity.ID, targetID).Scan(&existingID, &existingRequesterID, &existingStatus)
	if err == nil {
		if existingStatus == "accepted" {
			writeJSON(w, http.StatusConflict, map[string]string{"error": "already_friends", "requestId": existingID, "state": "friends"})
			return
		}
		if existingRequesterID == identity.ID {
			writeJSON(w, http.StatusOK, friendRequestStateResponse{RequestID: existingID, ProfileID: targetID, State: "sent"})
			return
		}
		writeJSON(w, http.StatusConflict, map[string]string{"error": "friend_request_received", "requestId": existingID, "state": "received"})
		return
	}
	if !errors.Is(err, sql.ErrNoRows) {
		a.logger.Error("find active guest friend request", "error", err)
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "friend_request_failed"})
		return
	}

	var requestCount int
	var oldestRequest sql.NullTime
	var databaseNow time.Time
	err = tx.QueryRowContext(r.Context(),
		"SELECT count(*), min(created_at), now() FROM guest_friend_requests "+
			"WHERE requester_profile_id = $1::uuid AND created_at > now() - interval '24 hours'",
		identity.ID).Scan(&requestCount, &oldestRequest, &databaseNow)
	if err != nil {
		a.logger.Error("check friend request rate limit", "error", err)
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "friend_request_failed"})
		return
	}
	if requestCount >= maxFriendRequestsPerDay {
		retryAfter := int(math.Ceil(oldestRequest.Time.Add(24 * time.Hour).Sub(databaseNow).Seconds()))
		if retryAfter < 1 {
			retryAfter = 1
		}
		w.Header().Set("Retry-After", strconv.Itoa(retryAfter))
		writeJSON(w, http.StatusTooManyRequests, map[string]any{
			"error":             "friend_request_rate_limited",
			"retryAfterSeconds": retryAfter,
		})
		return
	}

	var requestID string
	err = tx.QueryRowContext(r.Context(),
		"INSERT INTO guest_friend_requests (requester_profile_id, recipient_profile_id) "+
			"VALUES ($1::uuid, $2::uuid) RETURNING id::text",
		identity.ID, targetID).Scan(&requestID)
	if err != nil {
		a.logger.Error("create guest friend request", "error", err)
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "friend_request_failed"})
		return
	}
	if err := enqueueFriendshipChanged(r.Context(), tx, targetID, requestID, "pending"); err != nil {
		a.logger.Error("enqueue friend request event", "error", err)
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "friend_request_failed"})
		return
	}
	if err := tx.Commit(); err != nil {
		a.logger.Error("commit guest friend request", "error", err)
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "friend_request_failed"})
		return
	}

	writeJSON(w, http.StatusCreated, friendRequestStateResponse{RequestID: requestID, ProfileID: targetID, State: "sent"})
}

func (a *application) acceptFriendRequest(w http.ResponseWriter, r *http.Request) {
	a.setFriendRequestStatus(w, r, "recipient", "accepted")
}

func (a *application) declineFriendRequest(w http.ResponseWriter, r *http.Request) {
	a.setFriendRequestStatus(w, r, "recipient", "declined")
}

func (a *application) cancelFriendRequest(w http.ResponseWriter, r *http.Request) {
	a.setFriendRequestStatus(w, r, "requester", "cancelled")
}

func (a *application) setFriendRequestStatus(w http.ResponseWriter, r *http.Request, actorRole, nextStatus string) {
	identity, ok := a.guestIdentityForSocialRequest(w, r, "friendships")
	if !ok {
		return
	}
	requestID, valid := normalizeProfileID(r.PathValue("requestId"))
	if !valid {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "friend_request_not_found"})
		return
	}

	roleColumn := "recipient_profile_id"
	if actorRole == "requester" {
		roleColumn = "requester_profile_id"
	}
	query := "SELECT status, requester_profile_id::text, recipient_profile_id::text FROM guest_friend_requests WHERE id = $1::uuid AND " + roleColumn + " = $2::uuid FOR UPDATE"
	tx, err := a.db.BeginTx(r.Context(), nil)
	if err != nil {
		a.logger.Error("begin guest friend request update", "error", err)
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "friend_request_update_failed"})
		return
	}
	defer tx.Rollback()

	var currentStatus, requesterProfileID, recipientProfileID string
	err = tx.QueryRowContext(r.Context(), query, requestID, identity.ID).
		Scan(&currentStatus, &requesterProfileID, &recipientProfileID)
	if errors.Is(err, sql.ErrNoRows) {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "friend_request_not_found"})
		return
	}
	if err != nil {
		a.logger.Error("read guest friend request", "error", err)
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "friend_request_update_failed"})
		return
	}
	if currentStatus == nextStatus {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	if currentStatus != "pending" {
		writeJSON(w, http.StatusConflict, map[string]string{"error": "friend_request_no_longer_pending"})
		return
	}

	if _, err := tx.ExecContext(r.Context(),
		"UPDATE guest_friend_requests SET status = $2, updated_at = now() WHERE id = $1::uuid",
		requestID, nextStatus); err != nil {
		a.logger.Error("update guest friend request", "error", err)
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "friend_request_update_failed"})
		return
	}
	otherProfileID := requesterProfileID
	if actorRole == "requester" {
		otherProfileID = recipientProfileID
	}
	if err := enqueueFriendshipChanged(r.Context(), tx, otherProfileID, requestID, nextStatus); err != nil {
		a.logger.Error("enqueue friend request state event", "error", err)
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "friend_request_update_failed"})
		return
	}
	if err := tx.Commit(); err != nil {
		a.logger.Error("commit guest friend request update", "error", err)
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "friend_request_update_failed"})
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (a *application) removeFriend(w http.ResponseWriter, r *http.Request) {
	identity, ok := a.guestIdentityForSocialRequest(w, r, "friendships")
	if !ok {
		return
	}
	profileID, valid := normalizeProfileID(r.PathValue("profileId"))
	if !valid {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid_friend_profile_id"})
		return
	}
	if profileID == identity.ID {
		writeJSON(w, http.StatusUnprocessableEntity, map[string]string{"error": "cannot_remove_self"})
		return
	}
	tx, err := a.db.BeginTx(r.Context(), nil)
	if err != nil {
		a.logger.Error("begin remove guest friendship", "error", err)
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "friendship_update_failed"})
		return
	}
	defer tx.Rollback()

	var requestID, requesterProfileID, recipientProfileID string
	err = tx.QueryRowContext(r.Context(), `
		SELECT id::text, requester_profile_id::text, recipient_profile_id::text
		FROM guest_friend_requests
		WHERE status = 'accepted'
		  AND LEAST(requester_profile_id, recipient_profile_id) = LEAST($1::uuid, $2::uuid)
		  AND GREATEST(requester_profile_id, recipient_profile_id) = GREATEST($1::uuid, $2::uuid)
		FOR UPDATE
	`, identity.ID, profileID).Scan(&requestID, &requesterProfileID, &recipientProfileID)
	if errors.Is(err, sql.ErrNoRows) {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	if err != nil {
		a.logger.Error("read guest friendship before removal", "error", err)
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "friendship_update_failed"})
		return
	}
	if _, err := tx.ExecContext(r.Context(),
		"UPDATE guest_friend_requests SET status = 'removed', updated_at = now() WHERE id = $1::uuid",
		requestID); err != nil {
		a.logger.Error("remove guest friendship", "error", err)
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "friendship_update_failed"})
		return
	}
	otherProfileID := requesterProfileID
	if requesterProfileID == identity.ID {
		otherProfileID = recipientProfileID
	}
	if err := enqueueFriendshipChanged(r.Context(), tx, otherProfileID, requestID, "removed"); err != nil {
		a.logger.Error("enqueue removed friendship event", "error", err)
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "friendship_update_failed"})
		return
	}
	if err := tx.Commit(); err != nil {
		a.logger.Error("commit remove guest friendship", "error", err)
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "friendship_update_failed"})
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func friendRequestListQuery(view string) (where, sortColumn, state string) {
	switch view {
	case "incoming":
		return "requests.status = 'pending' AND requests.recipient_profile_id = $1::uuid", "created_at", "incoming"
	case "outgoing":
		return "requests.status = 'pending' AND requests.requester_profile_id = $1::uuid", "created_at", "outgoing"
	case "friends":
		return "requests.status = 'accepted' AND (requests.requester_profile_id = $1::uuid OR requests.recipient_profile_id = $1::uuid)", "updated_at", "friends"
	default:
		return "", "", ""
	}
}

func parseFriendRequestPageSize(raw string) (int, error) {
	if raw == "" {
		return defaultFriendPageSize, nil
	}
	limit, err := strconv.Atoi(raw)
	if err != nil || limit < 1 || limit > maxFriendPageSize {
		return 0, errors.New("invalid friend request page size")
	}
	return limit, nil
}

func encodeFriendRequestCursor(cursor friendRequestCursor) string {
	encoded, _ := json.Marshal(cursor)
	return base64.RawURLEncoding.EncodeToString(encoded)
}

func decodeFriendRequestCursor(raw string) (*friendRequestCursor, error) {
	if raw == "" {
		return nil, nil
	}
	if len(raw) > 256 {
		return nil, errors.New("friend request cursor is too long")
	}
	decoded, err := base64.RawURLEncoding.DecodeString(raw)
	if err != nil {
		return nil, err
	}
	var cursor friendRequestCursor
	decoder := json.NewDecoder(strings.NewReader(string(decoded)))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&cursor); err != nil || ensureSingleJSONValue(decoder) != nil {
		return nil, errors.New("invalid friend request cursor")
	}
	if cursor.Timestamp.IsZero() {
		return nil, errors.New("invalid friend request cursor timestamp")
	}
	if _, valid := normalizeProfileID(cursor.ID); !valid {
		return nil, errors.New("invalid friend request cursor ID")
	}
	return &cursor, nil
}
