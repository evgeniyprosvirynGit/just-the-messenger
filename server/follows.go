package main

import (
	"database/sql"
	"errors"
	"net/http"
	"strings"
)

type followProfileIDsResponse struct {
	ProfileIDs []string `json:"profileIds"`
}

func (a *application) listFollows(w http.ResponseWriter, r *http.Request) {
	identity, ok := a.guestIdentityForSocialRequest(w, r, "follows")
	if !ok {
		return
	}

	profileIDs, err := parseProfileIDs(r.URL.Query().Get("profileIds"))
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid_follow_profile_ids"})
		return
	}
	if len(profileIDs) == 0 {
		writeJSON(w, http.StatusOK, followProfileIDsResponse{ProfileIDs: []string{}})
		return
	}

	rows, err := a.db.QueryContext(r.Context(), `
		SELECT followed.id::text
		FROM guest_follows AS follows
		JOIN guest_profiles AS followed ON followed.id = follows.followed_profile_id
		WHERE follows.follower_profile_id = $1
		  AND followed.id = ANY(string_to_array($2, ',')::uuid[])
	`, identity.ID, strings.Join(profileIDs, ","))
	if err != nil {
		a.logger.Error("list guest follows", "error", err)
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "follows_unavailable"})
		return
	}
	defer rows.Close()

	following := make([]string, 0, len(profileIDs))
	for rows.Next() {
		var profileID string
		if err := rows.Scan(&profileID); err != nil {
			a.logger.Error("read guest follows", "error", err)
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "follows_unavailable"})
			return
		}
		following = append(following, profileID)
	}
	if err := rows.Err(); err != nil {
		a.logger.Error("read guest follows", "error", err)
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "follows_unavailable"})
		return
	}

	writeJSON(w, http.StatusOK, followProfileIDsResponse{ProfileIDs: following})
}

func (a *application) createFollow(w http.ResponseWriter, r *http.Request) {
	a.setFollow(w, r, true)
}

func (a *application) deleteFollow(w http.ResponseWriter, r *http.Request) {
	a.setFollow(w, r, false)
}

func (a *application) setFollow(w http.ResponseWriter, r *http.Request, follow bool) {
	identity, ok := a.guestIdentityForSocialRequest(w, r, "follows")
	if !ok {
		return
	}

	profileID, valid := normalizeProfileID(r.PathValue("profileId"))
	if !valid {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid_follow_profile_id"})
		return
	}

	if !follow {
		_, err := a.db.ExecContext(r.Context(), `
			DELETE FROM guest_follows AS follows
			USING guest_profiles AS followed
			WHERE follows.follower_profile_id = $1
			  AND follows.followed_profile_id = followed.id
			  AND followed.id = $2::uuid
		`, identity.ID, profileID)
		if err != nil {
			a.logger.Error("delete guest follow", "error", err)
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "follow_update_failed"})
			return
		}
		w.WriteHeader(http.StatusNoContent)
		return
	}

	if identity.ID == profileID {
		writeJSON(w, http.StatusUnprocessableEntity, map[string]string{"error": "cannot_follow_self"})
		return
	}

	tx, err := a.db.BeginTx(r.Context(), nil)
	if err != nil {
		a.logger.Error("begin guest follow", "error", err)
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "follow_update_failed"})
		return
	}
	defer tx.Rollback()

	var followedProfileID string
	err = tx.QueryRowContext(r.Context(), `
		SELECT followed.id::text
		FROM guest_profiles AS followed
		WHERE followed.id = $1::uuid
		  AND EXISTS (
		      SELECT 1
		      FROM public_messages AS message
		      WHERE message.guest_profile_id = followed.id
		        AND message.expires_at > now()
		  )
		FOR KEY SHARE OF followed
	`, profileID).Scan(&followedProfileID)
	if errors.Is(err, sql.ErrNoRows) {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "follow_target_unavailable"})
		return
	}
	if err != nil {
		a.logger.Error("find public follow target", "error", err)
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "follow_update_failed"})
		return
	}

	result, err := tx.ExecContext(r.Context(), `
		INSERT INTO guest_follows (follower_profile_id, followed_profile_id)
		VALUES ($1, $2)
		ON CONFLICT (follower_profile_id, followed_profile_id) DO NOTHING
	`, identity.ID, followedProfileID)
	if err != nil {
		a.logger.Error("create guest follow", "error", err)
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "follow_update_failed"})
		return
	}
	inserted, err := result.RowsAffected()
	if err != nil {
		a.logger.Error("check guest follow result", "error", err)
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "follow_update_failed"})
		return
	}
	if err := tx.Commit(); err != nil {
		a.logger.Error("commit guest follow", "error", err)
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "follow_update_failed"})
		return
	}

	if inserted == 0 {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	w.WriteHeader(http.StatusCreated)
}

func (a *application) guestIdentityForSocialRequest(w http.ResponseWriter, r *http.Request, resource string) (GuestIdentity, bool) {
	identity, err := a.guestIdentityFromRequest(r)
	if errors.Is(err, sql.ErrNoRows) {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "guest_session_required"})
		return GuestIdentity{}, false
	}
	if err != nil {
		a.logger.Error("resolve guest identity for social action", "resource", resource, "error", err)
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": resource + "_unavailable"})
		return GuestIdentity{}, false
	}
	return identity, true
}
