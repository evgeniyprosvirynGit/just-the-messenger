package main

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"time"
	"unicode"

	"github.com/jackc/pgx/v5/pgconn"
	"golang.org/x/text/cases"
	"golang.org/x/text/unicode/norm"
)

const (
	guestSessionCookieName = "meridian_guest"
	guestSessionLifetime   = 30 * 24 * time.Hour
	guestProfileRetention  = 30 * 24 * time.Hour
	maxNicknameLength      = 24
)

var reservedGuestNames = map[string]struct{}{
	"admin": {}, "administrator": {}, "api": {}, "meridian": {}, "moderator": {},
	"official": {}, "root": {}, "staff": {}, "support": {}, "system": {},
}

type GuestIdentity struct {
	ID           string `json:"id"`
	Nickname     string `json:"nickname"`
	Handle       string `json:"handle"`
	AvatarColor  string `json:"avatarColor"`
	Initials     string `json:"initials"`
	AuthProvider string `json:"authProvider,omitempty"`
	handleKey    string
}

type createGuestSessionRequest struct {
	Nickname string `json:"nickname"`
}

func (a *application) getGuestSession(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	token, ok := readGuestSessionToken(r)
	if !ok {
		w.WriteHeader(http.StatusNoContent)
		return
	}

	identity, err := a.refreshGuestSession(r.Context(), token)
	if errors.Is(err, sql.ErrNoRows) {
		clearGuestSessionCookie(w, r)
		w.WriteHeader(http.StatusNoContent)
		return
	}
	if err != nil {
		a.logger.Error("load guest session", "error", err)
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "guest_session_unavailable"})
		return
	}
	setGuestSessionCookie(w, r, token)
	writeJSON(w, http.StatusOK, identity)
}

func (a *application) createGuestSession(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	r.Body = http.MaxBytesReader(w, r.Body, 1_024)
	decoder := json.NewDecoder(r.Body)
	decoder.DisallowUnknownFields()
	var request createGuestSessionRequest
	if err := decoder.Decode(&request); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid_guest_payload"})
		return
	}
	if err := ensureSingleJSONValue(decoder); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid_guest_payload"})
		return
	}

	nickname, handle, handleKey, err := normalizeGuestNickname(request.Nickname)
	if err != nil {
		writeJSON(w, http.StatusUnprocessableEntity, map[string]string{"error": "nickname_invalid"})
		return
	}
	identity := guestIdentityForName(nickname, handle, handleKey)

	if token, ok := readGuestSessionToken(r); ok {
		updated, updateErr := a.updateGuestProfile(r.Context(), token, identity)
		if updateErr == nil {
			setGuestSessionCookie(w, r, token)
			writeJSON(w, http.StatusOK, updated)
			return
		}
		if errors.Is(updateErr, errGuestNicknameTaken) {
			writeJSON(w, http.StatusConflict, map[string]string{"error": "nickname_taken"})
			return
		}
		if !errors.Is(updateErr, sql.ErrNoRows) {
			a.logger.Error("update guest profile", "error", updateErr)
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "guest_session_unavailable"})
			return
		}
	}

	token, err := newGuestSessionToken()
	if err != nil {
		a.logger.Error("generate guest session", "error", err)
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "guest_session_unavailable"})
		return
	}
	created, err := a.insertGuestProfile(r.Context(), identity, token)
	if errors.Is(err, errGuestNicknameTaken) {
		writeJSON(w, http.StatusConflict, map[string]string{"error": "nickname_taken"})
		return
	}
	if err != nil {
		a.logger.Error("create guest profile", "error", err)
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "guest_session_unavailable"})
		return
	}
	setGuestSessionCookie(w, r, token)
	writeJSON(w, http.StatusCreated, created)
}

func (a *application) guestIdentityFromRequest(r *http.Request) (GuestIdentity, error) {
	token, ok := readGuestSessionToken(r)
	if !ok {
		return GuestIdentity{}, sql.ErrNoRows
	}
	return a.refreshGuestSession(r.Context(), token)
}

func (a *application) refreshGuestSession(ctx context.Context, token string) (GuestIdentity, error) {
	tx, err := a.db.BeginTx(ctx, nil)
	if err != nil {
		return GuestIdentity{}, err
	}
	defer tx.Rollback()

	var identity GuestIdentity
	err = tx.QueryRowContext(ctx, `
		UPDATE guest_sessions AS session
		SET last_seen_at = now(), expires_at = now() + ($2 * interval '1 second')
		FROM guest_profiles AS profile
		LEFT JOIN google_accounts AS linked ON linked.guest_profile_id = profile.id
		WHERE session.token_hash = $1
		  AND session.guest_profile_id = profile.id
		  AND session.expires_at > now()
		RETURNING profile.id::text, profile.nickname, profile.handle, profile.avatar_color, profile.initials,
		          CASE WHEN linked.google_subject IS NULL THEN '' ELSE 'google' END
	`, hashGuestSessionToken(token), int64(guestSessionLifetime/time.Second)).Scan(
		&identity.ID,
		&identity.Nickname,
		&identity.Handle,
		&identity.AvatarColor,
		&identity.Initials,
		&identity.AuthProvider,
	)
	if err != nil {
		return GuestIdentity{}, err
	}
	if _, err := tx.ExecContext(ctx, `UPDATE guest_profiles SET last_active_at = now() WHERE id = $1`, identity.ID); err != nil {
		return GuestIdentity{}, err
	}
	if err := tx.Commit(); err != nil {
		return GuestIdentity{}, err
	}
	return identity, nil
}

func (a *application) updateGuestProfile(ctx context.Context, token string, identity GuestIdentity) (GuestIdentity, error) {
	tx, err := a.db.BeginTx(ctx, nil)
	if err != nil {
		return GuestIdentity{}, err
	}
	defer tx.Rollback()

	err = tx.QueryRowContext(ctx, `
		UPDATE guest_profiles AS profile
		SET nickname = $1, handle = $2, handle_key = $3,
		    avatar_color = $4, initials = $5, last_active_at = now()
		FROM guest_sessions AS session
		LEFT JOIN google_accounts AS linked ON linked.guest_profile_id = session.guest_profile_id
		WHERE session.token_hash = $6
		  AND session.guest_profile_id = profile.id
		  AND session.expires_at > now()
		RETURNING profile.id::text,
		          CASE WHEN linked.google_subject IS NULL THEN '' ELSE 'google' END
	`, identity.Nickname, identity.Handle, identity.handleKey, identity.AvatarColor, identity.Initials, hashGuestSessionToken(token)).Scan(&identity.ID, &identity.AuthProvider)
	if errors.Is(err, sql.ErrNoRows) {
		return GuestIdentity{}, sql.ErrNoRows
	}
	if err != nil {
		if isGuestNicknameUniqueViolation(err) {
			return GuestIdentity{}, errGuestNicknameTaken
		}
		return GuestIdentity{}, err
	}
	if _, err := tx.ExecContext(ctx, `
		UPDATE guest_sessions
		SET last_seen_at = now(), expires_at = now() + ($2 * interval '1 second')
		WHERE token_hash = $1
	`, hashGuestSessionToken(token), int64(guestSessionLifetime/time.Second)); err != nil {
		return GuestIdentity{}, err
	}
	if err := tx.Commit(); err != nil {
		return GuestIdentity{}, err
	}
	return identity, nil
}

func (a *application) insertGuestProfile(ctx context.Context, identity GuestIdentity, token string) (GuestIdentity, error) {
	tx, err := a.db.BeginTx(ctx, nil)
	if err != nil {
		return GuestIdentity{}, err
	}
	defer tx.Rollback()
	if err := cleanupExpiredGuestData(ctx, tx); err != nil {
		return GuestIdentity{}, err
	}

	err = tx.QueryRowContext(ctx, `
		INSERT INTO guest_profiles (nickname, handle, handle_key, avatar_color, initials)
		VALUES ($1, $2, $3, $4, $5)
		RETURNING id::text
	`, identity.Nickname, identity.Handle, identity.handleKey, identity.AvatarColor, identity.Initials).Scan(&identity.ID)
	if err != nil {
		if isGuestNicknameUniqueViolation(err) {
			return GuestIdentity{}, errGuestNicknameTaken
		}
		return GuestIdentity{}, err
	}
	if _, err := tx.ExecContext(ctx, `
		INSERT INTO guest_sessions (token_hash, guest_profile_id, expires_at)
		VALUES ($1, $2, now() + ($3 * interval '1 second'))
	`, hashGuestSessionToken(token), identity.ID, int64(guestSessionLifetime/time.Second)); err != nil {
		return GuestIdentity{}, err
	}
	if err := tx.Commit(); err != nil {
		return GuestIdentity{}, err
	}
	return identity, nil
}

func cleanupExpiredGuestData(ctx context.Context, tx *sql.Tx) error {
	if _, err := tx.ExecContext(ctx, `DELETE FROM guest_sessions WHERE expires_at <= now()`); err != nil {
		return err
	}
	_, err := tx.ExecContext(ctx, `
		DELETE FROM guest_profiles AS profile
		WHERE profile.last_active_at <= now() - ($1 * interval '1 second')
		  AND NOT EXISTS (
		      SELECT 1 FROM guest_sessions AS session
		      WHERE session.guest_profile_id = profile.id AND session.expires_at > now()
		  )
		  AND NOT EXISTS (
		      SELECT 1 FROM public_messages AS message
		      WHERE message.guest_profile_id = profile.id AND message.expires_at > now()
		  )
	`, int64(guestProfileRetention/time.Second))
	return err
}

func normalizeGuestNickname(raw string) (nickname, handle, handleKey string, err error) {
	nickname = strings.Join(strings.Fields(norm.NFKC.String(raw)), " ")
	runes := []rune(nickname)
	if len(runes) < 2 || len(runes) > maxNicknameLength {
		return "", "", "", errors.New("nickname length is invalid")
	}
	if !unicode.IsLetter(runes[0]) && !unicode.IsDigit(runes[0]) {
		return "", "", "", errors.New("nickname must start with a letter or number")
	}
	if !unicode.IsLetter(runes[len(runes)-1]) && !unicode.IsDigit(runes[len(runes)-1]) {
		return "", "", "", errors.New("nickname must end with a letter or number")
	}
	for _, char := range runes {
		if unicode.IsLetter(char) || unicode.IsDigit(char) || unicode.IsMark(char) || char == ' ' || char == '_' || char == '-' || char == '\'' || char == '’' {
			continue
		}
		return "", "", "", errors.New("nickname contains unsupported characters")
	}

	handleKey = cases.Fold().String(nickname)
	if _, reserved := reservedGuestNames[handleKey]; reserved {
		return "", "", "", errors.New("nickname is reserved")
	}
	handle = "@" + strings.ReplaceAll(strings.ToLower(nickname), " ", "-")
	return nickname, handle, handleKey, nil
}

func guestIdentityForName(nickname, handle, handleKey string) GuestIdentity {
	colors := [...]string{"#d6a16d", "#8c9dcc", "#82c8ba", "#d18f9f", "#c0a56c", "#79a9bd", "#b092d0", "#9ba56c"}
	digest := sha256.Sum256([]byte(handleKey))
	return GuestIdentity{
		Nickname:    nickname,
		Handle:      handle,
		AvatarColor: colors[int(digest[0])%len(colors)],
		Initials:    guestInitials(nickname),
		handleKey:   handleKey,
	}
}

func guestInitials(nickname string) string {
	words := strings.Fields(nickname)
	if len(words) > 1 {
		return strings.ToUpper(string([]rune(words[0])[0]) + string([]rune(words[1])[0]))
	}
	runes := []rune(nickname)
	if len(runes) > 1 {
		return strings.ToUpper(string(runes[:2]))
	}
	return strings.ToUpper(nickname)
}

func readGuestSessionToken(r *http.Request) (string, bool) {
	cookie, err := r.Cookie(guestSessionCookieName)
	if err != nil {
		return "", false
	}
	decoded, err := base64.RawURLEncoding.DecodeString(cookie.Value)
	return cookie.Value, err == nil && len(decoded) == 32
}

func newGuestSessionToken() (string, error) {
	secret := make([]byte, 32)
	if _, err := rand.Read(secret); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(secret), nil
}

func hashGuestSessionToken(token string) []byte {
	digest := sha256.Sum256([]byte(token))
	return digest[:]
}

func setGuestSessionCookie(w http.ResponseWriter, r *http.Request, token string) {
	http.SetCookie(w, &http.Cookie{
		Name:     guestSessionCookieName,
		Value:    token,
		Path:     "/",
		HttpOnly: true,
		Secure:   requestUsesHTTPS(r),
		SameSite: http.SameSiteLaxMode,
		MaxAge:   int(guestSessionLifetime / time.Second),
		Expires:  time.Now().Add(guestSessionLifetime),
	})
}

func clearGuestSessionCookie(w http.ResponseWriter, r *http.Request) {
	http.SetCookie(w, &http.Cookie{
		Name:     guestSessionCookieName,
		Value:    "",
		Path:     "/",
		HttpOnly: true,
		Secure:   requestUsesHTTPS(r),
		SameSite: http.SameSiteLaxMode,
		MaxAge:   -1,
		Expires:  time.Unix(1, 0),
	})
}

func requestUsesHTTPS(r *http.Request) bool {
	forwardedProto := strings.TrimSpace(strings.Split(r.Header.Get("X-Forwarded-Proto"), ",")[0])
	return r.TLS != nil || strings.EqualFold(forwardedProto, "https")
}

func isGuestNicknameUniqueViolation(err error) bool {
	var postgresErr *pgconn.PgError
	return errors.As(err, &postgresErr) && postgresErr.Code == "23505" && postgresErr.ConstraintName == "guest_profiles_handle_key_unique"
}

var errGuestNicknameTaken = errors.New("guest nickname is already taken")
var errPublicMessageRateLimited = errors.New("public message rate limit exceeded")
