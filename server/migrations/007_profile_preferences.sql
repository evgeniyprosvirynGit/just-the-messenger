CREATE TABLE IF NOT EXISTS profile_preferences (
    profile_id UUID PRIMARY KEY REFERENCES guest_profiles(id) ON DELETE CASCADE,
    public_message_display_seconds SMALLINT NOT NULL DEFAULT 12
        CONSTRAINT profile_preferences_public_message_display_seconds_check
        CHECK (public_message_display_seconds IN (6, 12, 24)),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
