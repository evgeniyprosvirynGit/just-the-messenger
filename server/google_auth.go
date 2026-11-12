package main

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"database/sql"
	"encoding/hex"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/coreos/go-oidc/v3/oidc"
	"golang.org/x/oauth2"
)

const (
	googleIssuerURL           = "https://accounts.google.com"
	googleCallbackPath        = "/api/auth/google/callback"
	googleAuthAttemptLifetime = 10 * time.Minute
)

var errGoogleAccountConflict = errors.New("google account is linked to another profile")

type googleAuthSettings struct {
	ClientID            string
	ClientSecret        string
	RedirectURL         string
	IssuerURL           string
	AllowInsecureIssuer bool
}

type googleAuthClient struct {
	settings googleAuthSettings
	enabled  bool

	mu       sync.RWMutex
	provider *oidc.Provider
}

type googleAuthAttempt struct {
	sessionTokenHash []byte
	nonce            string
	pkceVerifier     string
	temporaryProfile bool
}

func newGoogleAuthClient(settings googleAuthSettings) (*googleAuthClient, error) {
	settings.ClientID = strings.TrimSpace(settings.ClientID)
	settings.ClientSecret = strings.TrimSpace(settings.ClientSecret)
	settings.RedirectURL = strings.TrimSpace(settings.RedirectURL)
	settings.IssuerURL = strings.TrimSpace(settings.IssuerURL)
	if settings.IssuerURL == "" {
		settings.IssuerURL = googleIssuerURL
	}

	if settings.ClientID == "" && settings.ClientSecret == "" {
		return &googleAuthClient{settings: settings}, nil
	}
	if settings.ClientID == "" || settings.ClientSecret == "" || settings.RedirectURL == "" {
		return nil, errors.New("Google sign-in requires client ID, client secret, and redirect URL")
	}
	if err := validateGoogleRedirectURL(settings.RedirectURL, settings.AllowInsecureIssuer); err != nil {
		return nil, err
	}
	if !settings.AllowInsecureIssuer && settings.IssuerURL != googleIssuerURL {
		return nil, errors.New("Google OIDC issuer must be https://accounts.google.com")
	}
	if err := validateGoogleIssuerURL(settings.IssuerURL, settings.AllowInsecureIssuer); err != nil {
		return nil, err
	}
	return &googleAuthClient{settings: settings, enabled: true}, nil
}

func (c *googleAuthClient) isEnabled() bool {
	return c != nil && c.enabled
}

func (c *googleAuthClient) providerFor(ctx context.Context) (*oidc.Provider, error) {
	c.mu.RLock()
	provider := c.provider
	c.mu.RUnlock()
	if provider != nil {
		return provider, nil
	}

	providerContext := ctx
	if c.settings.AllowInsecureIssuer {
		providerContext = oidc.InsecureIssuerURLContext(ctx, c.settings.IssuerURL)
	}
	loaded, err := oidc.NewProvider(providerContext, c.settings.IssuerURL)
	if err != nil {
		return nil, err
	}

	c.mu.Lock()
	if c.provider == nil {
		c.provider = loaded
	}
	provider = c.provider
	c.mu.Unlock()
	return provider, nil
}

func (c *googleAuthClient) authorizationURL(ctx context.Context, state, nonce, verifier string) (string, error) {
	provider, err := c.providerFor(ctx)
	if err != nil {
		return "", err
	}
	config := c.oauthConfig(provider)
	return config.AuthCodeURL(
		state,
		oauth2.S256ChallengeOption(verifier),
		oauth2.SetAuthURLParam("nonce", nonce),
	), nil
}

func (c *googleAuthClient) verifiedSubject(ctx context.Context, code, verifier, expectedNonce string) (string, error) {
	provider, err := c.providerFor(ctx)
	if err != nil {
		return "", err
	}

	exchangeContext, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	token, err := c.oauthConfig(provider).Exchange(exchangeContext, code, oauth2.VerifierOption(verifier))
	if err != nil {
		return "", err
	}
	rawIDToken, ok := token.Extra("id_token").(string)
	if !ok || rawIDToken == "" {
		return "", errors.New("Google token response did not contain an ID token")
	}

	idToken, err := provider.Verifier(&oidc.Config{ClientID: c.settings.ClientID}).Verify(exchangeContext, rawIDToken)
	if err != nil {
		return "", err
	}
	var claims struct {
		Subject string `json:"sub"`
		Nonce   string `json:"nonce"`
	}
	if err := idToken.Claims(&claims); err != nil {
		return "", err
	}
	if claims.Subject == "" || subtle.ConstantTimeCompare([]byte(claims.Nonce), []byte(expectedNonce)) != 1 {
		return "", errors.New("Google ID token subject or nonce is invalid")
	}
	return claims.Subject, nil
}

func (c *googleAuthClient) oauthConfig(provider *oidc.Provider) *oauth2.Config {
	return &oauth2.Config{
		ClientID:     c.settings.ClientID,
		ClientSecret: c.settings.ClientSecret,
		RedirectURL:  c.settings.RedirectURL,
		Endpoint:     provider.Endpoint(),
		Scopes:       []string{oidc.ScopeOpenID},
	}
}

func validateGoogleRedirectURL(raw string, allowInsecure bool) error {
	parsed, err := url.Parse(raw)
	if err != nil || parsed == nil || !parsed.IsAbs() || parsed.Hostname() == "" || parsed.User != nil {
		return errors.New("Google redirect URL must be an absolute callback URL")
	}
	if parsed.Path != googleCallbackPath || parsed.RawQuery != "" || parsed.Fragment != "" {
		return fmt.Errorf("Google redirect URL path must be exactly %s", googleCallbackPath)
	}
	if parsed.Scheme == "https" {
		return nil
	}
	if parsed.Scheme != "http" {
		return errors.New("Google redirect URL must use HTTPS")
	}
	if isLoopbackHost(parsed.Hostname()) || allowInsecure {
		return nil
	}
	return errors.New("HTTP Google redirect URLs are allowed only on loopback or in explicit local test mode")
}

func validateGoogleIssuerURL(raw string, allowInsecure bool) error {
	parsed, err := url.Parse(raw)
	if err != nil || parsed == nil || !parsed.IsAbs() || parsed.Hostname() == "" || parsed.User != nil {
		return errors.New("Google OIDC issuer must be an absolute URL")
	}
	if parsed.Path != "" && parsed.Path != "/" || parsed.RawQuery != "" || parsed.Fragment != "" {
		return errors.New("Google OIDC issuer URL must not contain a path, query, or fragment")
	}
	if parsed.Scheme == "https" || parsed.Scheme == "http" && allowInsecure {
		return nil
	}
	return errors.New("Google OIDC issuer must use HTTPS outside explicit local test mode")
}

func isLoopbackHost(host string) bool {
	if strings.EqualFold(host, "localhost") {
		return true
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}

func googleOAuthStateHash(state string) []byte {
	digest := sha256.Sum256([]byte(state))
	return digest[:]
}

func newOAuthRandomValue() (string, error) {
	secret := make([]byte, 32)
	if _, err := rand.Read(secret); err != nil {
		return "", err
	}
	return hex.EncodeToString(secret), nil
}

func (a *application) googleAuthConfig(w http.ResponseWriter, _ *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, http.StatusOK, map[string]bool{"googleEnabled": a.googleAuth.isEnabled()})
}

func (a *application) startGoogleAuth(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	if !a.googleAuth.isEnabled() {
		redirectGoogleAuthNotice(w, r, "google-failed")
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), 15*time.Second)
	defer cancel()
	token, temporaryProfile, err := a.googleAuthSession(ctx, r)
	if err != nil {
		a.logger.Error("prepare Google sign-in", "error", err)
		redirectGoogleAuthNotice(w, r, "google-failed")
		return
	}

	state, err := newOAuthRandomValue()
	if err != nil {
		a.logger.Error("generate Google OAuth state", "error", err)
		redirectGoogleAuthNotice(w, r, "google-failed")
		return
	}
	nonce, err := newOAuthRandomValue()
	if err != nil {
		a.logger.Error("generate Google OIDC nonce", "error", err)
		redirectGoogleAuthNotice(w, r, "google-failed")
		return
	}
	verifier := oauth2.GenerateVerifier()
	authorizationURL, err := a.googleAuth.authorizationURL(ctx, state, nonce, verifier)
	if err != nil {
		a.logger.Warn("Google OIDC discovery failed")
		redirectGoogleAuthNotice(w, r, "google-failed")
		return
	}
	attempt := googleAuthAttempt{
		sessionTokenHash: hashGuestSessionToken(token),
		nonce:            nonce,
		pkceVerifier:     verifier,
		temporaryProfile: temporaryProfile,
	}
	if err := a.createGoogleAuthAttempt(ctx, googleOAuthStateHash(state), attempt); err != nil {
		a.logger.Error("save Google OAuth attempt", "error", err)
		redirectGoogleAuthNotice(w, r, "google-failed")
		return
	}

	setGuestSessionCookie(w, r, token)
	http.Redirect(w, r, authorizationURL, http.StatusFound)
}

func (a *application) googleAuthSession(ctx context.Context, r *http.Request) (string, bool, error) {
	if token, ok := readGuestSessionToken(r); ok {
		if _, err := a.refreshGuestSession(ctx, token); err == nil {
			return token, false, nil
		} else if !errors.Is(err, sql.ErrNoRows) {
			return "", false, err
		}
	}

	for attempt := 0; attempt < 3; attempt++ {
		randomName, err := newOAuthRandomValue()
		if err != nil {
			return "", false, err
		}
		nickname, handle, handleKey, err := normalizeGuestNickname("Guest " + strings.ToUpper(randomName[:16]))
		if err != nil {
			return "", false, err
		}
		identity := guestIdentityForName(nickname, handle, handleKey)
		token, err := newGuestSessionToken()
		if err != nil {
			return "", false, err
		}
		if _, err := a.insertGuestProfile(ctx, identity, token); errors.Is(err, errGuestNicknameTaken) {
			continue
		} else if err != nil {
			return "", false, err
		}
		return token, true, nil
	}
	return "", false, errors.New("could not reserve a temporary Google sign-in profile")
}

func (a *application) createGoogleAuthAttempt(ctx context.Context, stateHash []byte, attempt googleAuthAttempt) error {
	tx, err := a.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err := tx.ExecContext(ctx, `DELETE FROM google_auth_attempts WHERE expires_at <= now()`); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `
		INSERT INTO google_auth_attempts (state_hash, session_token_hash, nonce, pkce_verifier, temporary_profile, expires_at)
		VALUES ($1, $2, $3, $4, $5, now() + ($6 * interval '1 second'))
	`, stateHash, attempt.sessionTokenHash, attempt.nonce, attempt.pkceVerifier, attempt.temporaryProfile, int64(googleAuthAttemptLifetime/time.Second)); err != nil {
		return err
	}
	return tx.Commit()
}

func (a *application) consumeGoogleAuthAttempt(ctx context.Context, stateHash []byte) (googleAuthAttempt, error) {
	var attempt googleAuthAttempt
	err := a.db.QueryRowContext(ctx, `
		DELETE FROM google_auth_attempts
		WHERE state_hash = $1 AND expires_at > now()
		RETURNING session_token_hash, nonce, pkce_verifier, temporary_profile
	`, stateHash).Scan(&attempt.sessionTokenHash, &attempt.nonce, &attempt.pkceVerifier, &attempt.temporaryProfile)
	return attempt, err
}

func (a *application) googleAuthCallback(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Referrer-Policy", "no-referrer")
	state := r.URL.Query().Get("state")
	token, ok := readGuestSessionToken(r)
	if state == "" || !ok {
		redirectGoogleAuthNotice(w, r, "google-failed")
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), 20*time.Second)
	defer cancel()
	attempt, err := a.consumeGoogleAuthAttempt(ctx, googleOAuthStateHash(state))
	if err != nil || subtle.ConstantTimeCompare(attempt.sessionTokenHash, hashGuestSessionToken(token)) != 1 {
		redirectGoogleAuthNotice(w, r, "google-failed")
		return
	}
	if r.URL.Query().Get("error") != "" {
		redirectGoogleAuthNotice(w, r, "google-cancelled")
		return
	}
	code := r.URL.Query().Get("code")
	if code == "" {
		redirectGoogleAuthNotice(w, r, "google-failed")
		return
	}

	subject, err := a.googleAuth.verifiedSubject(ctx, code, attempt.pkceVerifier, attempt.nonce)
	if err != nil {
		a.logger.Warn("Google OIDC response rejected")
		redirectGoogleAuthNotice(w, r, "google-failed")
		return
	}
	rotatedToken, err := newGuestSessionToken()
	if err != nil {
		a.logger.Error("rotate Google session", "error", err)
		redirectGoogleAuthNotice(w, r, "google-failed")
		return
	}
	if _, err := a.linkGoogleIdentityAndRotateSession(ctx, token, rotatedToken, subject, attempt.temporaryProfile); err != nil {
		if errors.Is(err, errGoogleAccountConflict) {
			redirectGoogleAuthNotice(w, r, "google-conflict")
			return
		}
		a.logger.Error("link Google identity", "error", err)
		redirectGoogleAuthNotice(w, r, "google-failed")
		return
	}

	setGuestSessionCookie(w, r, rotatedToken)
	redirectGoogleAuthNotice(w, r, "google-connected")
}

func (a *application) linkGoogleIdentityAndRotateSession(ctx context.Context, oldToken, newToken, subject string, temporaryProfile bool) (GuestIdentity, error) {
	tx, err := a.db.BeginTx(ctx, nil)
	if err != nil {
		return GuestIdentity{}, err
	}
	defer tx.Rollback()

	oldHash := hashGuestSessionToken(oldToken)
	var currentProfileID string
	if err := tx.QueryRowContext(ctx, `
		SELECT guest_profile_id::text
		FROM guest_sessions
		WHERE token_hash = $1 AND expires_at > now()
		FOR UPDATE
	`, oldHash).Scan(&currentProfileID); err != nil {
		return GuestIdentity{}, err
	}

	targetProfileID := currentProfileID
	var linkedProfileID string
	err = tx.QueryRowContext(ctx, `
		SELECT guest_profile_id::text FROM google_accounts WHERE google_subject = $1
	`, subject).Scan(&linkedProfileID)
	if err == nil {
		if linkedProfileID != currentProfileID {
			if !temporaryProfile {
				return GuestIdentity{}, errGoogleAccountConflict
			}
			targetProfileID = linkedProfileID
		}
	} else if !errors.Is(err, sql.ErrNoRows) {
		return GuestIdentity{}, err
	} else {
		var existingSubject string
		err := tx.QueryRowContext(ctx, `
			SELECT google_subject FROM google_accounts WHERE guest_profile_id = $1 FOR UPDATE
		`, currentProfileID).Scan(&existingSubject)
		if err == nil && existingSubject != subject {
			return GuestIdentity{}, errGoogleAccountConflict
		}
		if err != nil && !errors.Is(err, sql.ErrNoRows) {
			return GuestIdentity{}, err
		}
		if errors.Is(err, sql.ErrNoRows) {
			insertErr := tx.QueryRowContext(ctx, `
				INSERT INTO google_accounts (google_subject, guest_profile_id)
				VALUES ($1, $2)
				ON CONFLICT DO NOTHING
				RETURNING guest_profile_id::text
			`, subject, currentProfileID).Scan(&linkedProfileID)
			if errors.Is(insertErr, sql.ErrNoRows) {
				if lookupErr := tx.QueryRowContext(ctx, `
					SELECT guest_profile_id::text FROM google_accounts WHERE google_subject = $1
				`, subject).Scan(&linkedProfileID); lookupErr != nil {
					return GuestIdentity{}, errGoogleAccountConflict
				}
				if linkedProfileID != currentProfileID {
					if !temporaryProfile {
						return GuestIdentity{}, errGoogleAccountConflict
					}
					targetProfileID = linkedProfileID
				}
			} else if insertErr != nil {
				return GuestIdentity{}, insertErr
			}
		}
	}

	if _, err := tx.ExecContext(ctx, `
		UPDATE guest_sessions
		SET token_hash = $1, guest_profile_id = $2, last_seen_at = now(), expires_at = now() + ($3 * interval '1 second')
		WHERE token_hash = $4 AND expires_at > now()
	`, hashGuestSessionToken(newToken), targetProfileID, int64(guestSessionLifetime/time.Second), oldHash); err != nil {
		return GuestIdentity{}, err
	}
	if _, err := tx.ExecContext(ctx, `UPDATE guest_profiles SET last_active_at = now() WHERE id = $1`, targetProfileID); err != nil {
		return GuestIdentity{}, err
	}

	var identity GuestIdentity
	if err := tx.QueryRowContext(ctx, `
		SELECT profile.id::text, profile.nickname, profile.handle, profile.avatar_color, profile.initials, 'google'
		FROM guest_profiles AS profile
		JOIN google_accounts AS linked ON linked.guest_profile_id = profile.id
		WHERE profile.id = $1 AND linked.google_subject = $2
	`, targetProfileID, subject).Scan(
		&identity.ID,
		&identity.Nickname,
		&identity.Handle,
		&identity.AvatarColor,
		&identity.Initials,
		&identity.AuthProvider,
	); err != nil {
		return GuestIdentity{}, err
	}
	if err := tx.Commit(); err != nil {
		return GuestIdentity{}, err
	}
	return identity, nil
}

func (a *application) logout(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	if token, ok := readGuestSessionToken(r); ok {
		if _, err := a.db.ExecContext(r.Context(), `DELETE FROM guest_sessions WHERE token_hash = $1`, hashGuestSessionToken(token)); err != nil {
			a.logger.Error("revoke guest session", "error", err)
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "logout_unavailable"})
			return
		}
	}
	clearGuestSessionCookie(w, r)
	w.WriteHeader(http.StatusNoContent)
}

func redirectGoogleAuthNotice(w http.ResponseWriter, r *http.Request, notice string) {
	if r.Method != http.MethodGet {
		w.WriteHeader(http.StatusMethodNotAllowed)
		return
	}
	http.Redirect(w, r, "/?auth="+url.QueryEscape(notice), http.StatusSeeOther)
}
