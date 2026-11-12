CREATE TABLE IF NOT EXISTS guest_profiles (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    nickname TEXT NOT NULL CHECK (char_length(nickname) BETWEEN 2 AND 24),
    handle TEXT NOT NULL,
    handle_key TEXT NOT NULL,
    avatar_color TEXT NOT NULL,
    initials TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_active_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_message_at TIMESTAMPTZ,
    CONSTRAINT guest_profiles_handle_key_unique UNIQUE (handle_key)
);

CREATE TABLE IF NOT EXISTS guest_sessions (
    token_hash BYTEA PRIMARY KEY CHECK (octet_length(token_hash) = 32),
    guest_profile_id UUID NOT NULL REFERENCES guest_profiles(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS guest_profiles_last_active_idx ON guest_profiles (last_active_at);
CREATE INDEX IF NOT EXISTS guest_sessions_expiry_idx ON guest_sessions (expires_at);
CREATE INDEX IF NOT EXISTS guest_sessions_profile_idx ON guest_sessions (guest_profile_id);

ALTER TABLE public_messages
    ADD COLUMN IF NOT EXISTS author_handle TEXT NOT NULL DEFAULT '@you';

ALTER TABLE public_messages
    ADD COLUMN IF NOT EXISTS guest_profile_id UUID REFERENCES guest_profiles(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS public_messages_guest_profile_idx ON public_messages (guest_profile_id);
