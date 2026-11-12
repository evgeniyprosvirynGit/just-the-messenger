package main

import (
	"database/sql"
	"encoding/json"
	"errors"
	"net/http"
)

const defaultPublicMessageDisplaySeconds = 12

type accountSettingsResponse struct {
	PublicMessageDisplaySeconds int  `json:"publicMessageDisplaySeconds"`
	Customized                  bool `json:"customized"`
}

type updateAccountSettingsRequest struct {
	PublicMessageDisplaySeconds int `json:"publicMessageDisplaySeconds"`
}

func validPublicMessageDisplaySeconds(seconds int) bool {
	switch seconds {
	case 6, defaultPublicMessageDisplaySeconds, 24:
		return true
	default:
		return false
	}
}

func (a *application) accountSettingsIdentity(w http.ResponseWriter, r *http.Request) (GuestIdentity, bool) {
	identity, err := a.guestIdentityFromRequest(r)
	if errors.Is(err, sql.ErrNoRows) {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "guest_session_required"})
		return GuestIdentity{}, false
	}
	if err != nil {
		a.logger.Error("load account settings session", "error", err)
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "settings_unavailable"})
		return GuestIdentity{}, false
	}
	if identity.AuthProvider != "google" {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "account_required"})
		return GuestIdentity{}, false
	}
	return identity, true
}

func (a *application) getAccountSettings(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	identity, ok := a.accountSettingsIdentity(w, r)
	if !ok {
		return
	}

	settings := accountSettingsResponse{PublicMessageDisplaySeconds: defaultPublicMessageDisplaySeconds}
	err := a.db.QueryRowContext(r.Context(), `
		SELECT public_message_display_seconds
		FROM profile_preferences
		WHERE profile_id = $1
	`, identity.ID).Scan(&settings.PublicMessageDisplaySeconds)
	if err == nil {
		settings.Customized = true
	} else if !errors.Is(err, sql.ErrNoRows) {
		a.logger.Error("load account preferences", "error", err)
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "settings_unavailable"})
		return
	}
	writeJSON(w, http.StatusOK, settings)
}

func (a *application) updateAccountSettings(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	identity, ok := a.accountSettingsIdentity(w, r)
	if !ok {
		return
	}

	r.Body = http.MaxBytesReader(w, r.Body, 4_096)
	decoder := json.NewDecoder(r.Body)
	decoder.DisallowUnknownFields()
	var request updateAccountSettingsRequest
	if err := decoder.Decode(&request); err != nil || ensureSingleJSONValue(decoder) != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid_settings"})
		return
	}
	if !validPublicMessageDisplaySeconds(request.PublicMessageDisplaySeconds) {
		writeJSON(w, http.StatusUnprocessableEntity, map[string]string{"error": "invalid_message_display_duration"})
		return
	}

	_, err := a.db.ExecContext(r.Context(), `
		INSERT INTO profile_preferences (profile_id, public_message_display_seconds)
		VALUES ($1, $2)
		ON CONFLICT (profile_id) DO UPDATE
		SET public_message_display_seconds = EXCLUDED.public_message_display_seconds,
		    updated_at = now()
	`, identity.ID, request.PublicMessageDisplaySeconds)
	if err != nil {
		a.logger.Error("update account preferences", "error", err)
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "settings_unavailable"})
		return
	}
	writeJSON(w, http.StatusOK, accountSettingsResponse{
		PublicMessageDisplaySeconds: request.PublicMessageDisplaySeconds,
		Customized:                  true,
	})
}
