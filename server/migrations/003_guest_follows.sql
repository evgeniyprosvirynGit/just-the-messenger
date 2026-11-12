CREATE TABLE IF NOT EXISTS guest_follows (
    follower_profile_id UUID NOT NULL REFERENCES guest_profiles(id) ON DELETE CASCADE,
    followed_profile_id UUID NOT NULL REFERENCES guest_profiles(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT guest_follows_pk PRIMARY KEY (follower_profile_id, followed_profile_id),
    CONSTRAINT guest_follows_not_self CHECK (follower_profile_id <> followed_profile_id)
);

CREATE INDEX IF NOT EXISTS guest_follows_followed_idx
    ON guest_follows (followed_profile_id, follower_profile_id);
