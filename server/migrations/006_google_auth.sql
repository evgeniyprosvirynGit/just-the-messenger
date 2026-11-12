CREATE TABLE IF NOT EXISTS google_accounts (
    google_subject TEXT PRIMARY KEY CHECK (char_length(google_subject) BETWEEN 1 AND 255),
    guest_profile_id UUID NOT NULL UNIQUE REFERENCES guest_profiles(id) ON DELETE CASCADE,
    linked_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS google_auth_attempts (
    state_hash BYTEA PRIMARY KEY CHECK (octet_length(state_hash) = 32),
    session_token_hash BYTEA NOT NULL REFERENCES guest_sessions(token_hash) ON DELETE CASCADE,
    nonce TEXT NOT NULL,
    pkce_verifier TEXT NOT NULL,
    temporary_profile BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS google_auth_attempts_expiry_idx ON google_auth_attempts (expires_at);
