package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"net/http"
	"strings"
	"time"
)

const maxMessageLength = 240

type PublicMessage struct {
	ID              string    `json:"id"`
	AuthorProfileID string    `json:"authorProfileId,omitempty"`
	AuthorName      string    `json:"authorName"`
	AuthorHandle    string    `json:"authorHandle"`
	Body            string    `json:"body"`
	Latitude        float64   `json:"latitude"`
	Longitude       float64   `json:"longitude"`
	City            string    `json:"city"`
	Country         string    `json:"country"`
	CreatedAt       time.Time `json:"createdAt"`
	ExpiresAt       time.Time `json:"expiresAt"`
	AvatarColor     string    `json:"avatarColor"`
	Initials        string    `json:"initials"`
}

type createMessageRequest struct {
	Body      string  `json:"body"`
	Latitude  float64 `json:"latitude"`
	Longitude float64 `json:"longitude"`
}

const publicMessageCooldownSeconds = 2
const publicMessageRetentionSeconds = 30

type publicMessageRateLimitError struct {
	retryAfterSeconds int
}

func (e publicMessageRateLimitError) Error() string {
	return errPublicMessageRateLimited.Error()
}

func (e publicMessageRateLimitError) Unwrap() error {
	return errPublicMessageRateLimited
}

type streamEnvelope struct {
	Type    string        `json:"type"`
	Message PublicMessage `json:"message"`
}

func (a *application) listMessages(w http.ResponseWriter, r *http.Request) {
	limit := 100
	if requested := r.URL.Query().Get("limit"); requested != "" {
		var value int
		if _, err := fmt.Sscanf(requested, "%d", &value); err != nil || value < 1 {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "limit must be a positive integer"})
			return
		}
		if value < limit {
			limit = value
		}
	}
	var cells []string
	if rawCells := strings.TrimSpace(r.URL.Query().Get("cells")); rawCells != "" {
		cells = strings.Split(rawCells, ",")
		if len(cells) > maxSubscribedCells {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "too many geocells"})
			return
		}
		for _, cell := range cells {
			if !validRegion.MatchString(cell) {
				writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid geocell"})
				return
			}
		}
	}

	query := `
		SELECT id::text, author_name, author_handle, body,
		       ST_Y(location::geometry), ST_X(location::geometry),
		       city, country, created_at, expires_at, avatar_color, initials, guest_profile_id::text
		FROM public_messages
		WHERE expires_at > now()
		ORDER BY created_at DESC
		LIMIT $1`
	args := []any{limit}
	if len(cells) > 0 {
		query = `
			SELECT id::text, author_name, author_handle, body,
			       ST_Y(location::geometry), ST_X(location::geometry),
			       city, country, created_at, expires_at, avatar_color, initials, guest_profile_id::text
			FROM public_messages
			WHERE expires_at > now() AND region_code = ANY($1::text[])
			ORDER BY created_at DESC
			LIMIT $2`
		args = []any{cells, limit}
	}
	rows, err := a.db.QueryContext(r.Context(), query, args...)
	if err != nil {
		a.logger.Error("list public messages", "error", err)
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "could not load messages"})
		return
	}
	defer rows.Close()

	messages := make([]PublicMessage, 0)
	for rows.Next() {
		var message PublicMessage
		var authorProfileID sql.NullString
		if err := rows.Scan(
			&message.ID,
			&message.AuthorName,
			&message.AuthorHandle,
			&message.Body,
			&message.Latitude,
			&message.Longitude,
			&message.City,
			&message.Country,
			&message.CreatedAt,
			&message.ExpiresAt,
			&message.AvatarColor,
			&message.Initials,
			&authorProfileID,
		); err != nil {
			a.logger.Error("scan public message", "error", err)
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "could not load messages"})
			return
		}
		if authorProfileID.Valid {
			message.AuthorProfileID = authorProfileID.String
		}
		messages = append(messages, message)
	}
	if err := rows.Err(); err != nil {
		a.logger.Error("iterate public messages", "error", err)
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "could not load messages"})
		return
	}
	writeJSON(w, http.StatusOK, messages)
}

func (a *application) createMessage(w http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(w, r.Body, 2_048)
	decoder := json.NewDecoder(r.Body)
	decoder.DisallowUnknownFields()
	var request createMessageRequest
	if err := decoder.Decode(&request); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid message payload"})
		return
	}
	if err := ensureSingleJSONValue(decoder); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "request must contain one JSON object"})
		return
	}

	request.Body = strings.TrimSpace(request.Body)
	if err := validateMessage(request); err != nil {
		writeJSON(w, http.StatusUnprocessableEntity, map[string]string{"error": err.Error()})
		return
	}
	identity, err := a.guestIdentityFromRequest(r)
	if errors.Is(err, sql.ErrNoRows) {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "guest_session_required"})
		return
	}
	if err != nil {
		a.logger.Error("resolve guest identity", "error", err)
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "could not send message"})
		return
	}
	// Public coordinates are intentionally coarsened before persistence and broadcast.
	request.Latitude = math.Round(request.Latitude*100) / 100
	request.Longitude = math.Round(request.Longitude*100) / 100

	message, err := a.insertMessage(r.Context(), request, identity.ID)
	if err != nil {
		var rateLimitError publicMessageRateLimitError
		if errors.As(err, &rateLimitError) {
			w.Header().Set("Cache-Control", "no-store")
			w.Header().Set("Retry-After", fmt.Sprint(rateLimitError.retryAfterSeconds))
			writeJSON(w, http.StatusTooManyRequests, map[string]string{"error": "public_message_rate_limited"})
			return
		}
		a.logger.Error("create public message", "error", err)
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "could not send message"})
		return
	}
	writeJSON(w, http.StatusCreated, message)
}

func (a *application) insertMessage(ctx context.Context, request createMessageRequest, guestProfileID string) (PublicMessage, error) {
	tx, err := a.db.BeginTx(ctx, nil)
	if err != nil {
		return PublicMessage{}, err
	}
	defer tx.Rollback()

	var message PublicMessage
	message.AuthorProfileID = guestProfileID
	err = tx.QueryRowContext(ctx, `
		UPDATE guest_profiles
		SET last_message_at = clock_timestamp(), last_active_at = clock_timestamp()
		WHERE id = $1
		  AND (last_message_at IS NULL OR last_message_at <= clock_timestamp() - ($2::double precision * interval '1 second'))
		RETURNING nickname, handle, avatar_color, initials
	`, guestProfileID, publicMessageCooldownSeconds).Scan(&message.AuthorName, &message.AuthorHandle, &message.AvatarColor, &message.Initials)
	if errors.Is(err, sql.ErrNoRows) {
		var retryAfterSeconds int
		if err := tx.QueryRowContext(ctx, `
			SELECT GREATEST(
				1,
				CEIL(EXTRACT(EPOCH FROM (
					last_message_at + ($2::double precision * interval '1 second') - clock_timestamp()
				)))::int
			)
			FROM guest_profiles
			WHERE id = $1
		`, guestProfileID, publicMessageCooldownSeconds).Scan(&retryAfterSeconds); err != nil {
			return PublicMessage{}, err
		}
		return PublicMessage{}, publicMessageRateLimitError{retryAfterSeconds: retryAfterSeconds}
	}
	if err != nil {
		return PublicMessage{}, err
	}

	err = tx.QueryRowContext(ctx, `
		INSERT INTO public_messages (
			author_name, author_handle, guest_profile_id, body, location, city, country,
			avatar_color, initials, expires_at, region_code
		) VALUES (
			$1, $2, $3, $4, ST_SetSRID(ST_MakePoint($5, $6), 4326)::geography,
			$7, $8, $9, $10, now() + ($11::double precision * interval '1 second'), $12
		)
		RETURNING id::text, author_name, author_handle, body,
		          ST_Y(location::geometry), ST_X(location::geometry),
		          city, country, created_at, expires_at, avatar_color, initials`,
		message.AuthorName,
		message.AuthorHandle,
		guestProfileID,
		request.Body,
		request.Longitude,
		request.Latitude,
		cityLabel(request.Latitude, request.Longitude),
		countryLabel(request.Latitude, request.Longitude),
		message.AvatarColor,
		message.Initials,
		publicMessageRetentionSeconds,
		regionFor(request.Latitude, request.Longitude),
	).Scan(
		&message.ID,
		&message.AuthorName,
		&message.AuthorHandle,
		&message.Body,
		&message.Latitude,
		&message.Longitude,
		&message.City,
		&message.Country,
		&message.CreatedAt,
		&message.ExpiresAt,
		&message.AvatarColor,
		&message.Initials,
	)
	if err != nil {
		return PublicMessage{}, err
	}
	payload, err := json.Marshal(streamEnvelope{Type: "public_message", Message: message})
	if err != nil {
		return PublicMessage{}, err
	}
	subject := "public.messages." + regionFor(message.Latitude, message.Longitude)
	if _, err := tx.ExecContext(ctx, `INSERT INTO realtime_outbox (subject, payload) VALUES ($1, $2::jsonb)`, subject, string(payload)); err != nil {
		return PublicMessage{}, err
	}
	if err := tx.Commit(); err != nil {
		return PublicMessage{}, err
	}
	return message, nil
}

func validateMessage(request createMessageRequest) error {
	if request.Body == "" {
		return errors.New("message cannot be empty")
	}
	if len([]rune(request.Body)) > maxMessageLength {
		return fmt.Errorf("message must be %d characters or fewer", maxMessageLength)
	}
	if math.IsNaN(request.Latitude) || math.IsInf(request.Latitude, 0) || request.Latitude < -90 || request.Latitude > 90 {
		return errors.New("latitude must be between -90 and 90")
	}
	if math.IsNaN(request.Longitude) || math.IsInf(request.Longitude, 0) || request.Longitude < -180 || request.Longitude > 180 {
		return errors.New("longitude must be between -180 and 180")
	}
	return nil
}

func ensureSingleJSONValue(decoder *json.Decoder) error {
	var extra any
	if err := decoder.Decode(&extra); !errors.Is(err, io.EOF) {
		if err == nil {
			return errors.New("multiple JSON values")
		}
		return err
	}
	return nil
}

func cityLabel(latitude, longitude float64) string {
	if math.Abs(latitude-41.7151) < 0.5 && math.Abs(longitude-44.8271) < 0.5 {
		return "Тбилиси"
	}
	return "Выбранная точка"
}

func countryLabel(latitude, longitude float64) string {
	if cityLabel(latitude, longitude) == "Тбилиси" {
		return "Грузия"
	}
	return "Планета Земля"
}

func (a *application) startOutboxPublisher(ctx context.Context) {
	go func() {
		ticker := time.NewTicker(250 * time.Millisecond)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				if err := a.publishOutboxBatch(ctx); err != nil && !errors.Is(err, context.Canceled) {
					a.logger.Warn("publish realtime outbox", "error", err)
				}
			}
		}
	}()
}

type outboxEvent struct {
	id      int64
	subject string
	payload []byte
}

func (a *application) publishOutboxBatch(ctx context.Context) error {
	queryCtx, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()
	tx, err := a.db.BeginTx(queryCtx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()

	rows, err := tx.QueryContext(queryCtx, `
		SELECT id, subject, payload
		FROM realtime_outbox
		WHERE published_at IS NULL
		ORDER BY id
		FOR UPDATE SKIP LOCKED
		LIMIT 50`)
	if err != nil {
		return err
	}
	events := make([]outboxEvent, 0, 50)
	for rows.Next() {
		var event outboxEvent
		if err := rows.Scan(&event.id, &event.subject, &event.payload); err != nil {
			rows.Close()
			return err
		}
		events = append(events, event)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return err
	}
	rows.Close()

	if len(events) == 0 {
		return tx.Commit()
	}
	for _, event := range events {
		if err := a.nats.Publish(event.subject, event.payload); err != nil {
			return err
		}
	}
	if err := a.nats.FlushTimeout(2 * time.Second); err != nil {
		return err
	}
	for _, event := range events {
		if _, err := tx.ExecContext(queryCtx, `UPDATE realtime_outbox SET published_at = now() WHERE id = $1`, event.id); err != nil {
			return err
		}
	}
	return tx.Commit()
}

func (a *application) startExpiredMessageCleanup(ctx context.Context) {
	go func() {
		ticker := time.NewTicker(time.Minute)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				cleanupCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
				if err := a.cleanupExpiredData(cleanupCtx); err != nil && !errors.Is(err, context.Canceled) {
					a.logger.Warn("clean expired messages and guest sessions", "error", err)
				}
				cancel()
			}
		}
	}()
}

func (a *application) cleanupExpiredData(ctx context.Context) error {
	tx, err := a.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err := tx.ExecContext(ctx, `DELETE FROM public_messages WHERE expires_at <= now()`); err != nil {
		return err
	}
	if err := cleanupExpiredGuestData(ctx, tx); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `DELETE FROM realtime_outbox WHERE published_at < now() - interval '2 days'`); err != nil {
		return err
	}
	return tx.Commit()
}
