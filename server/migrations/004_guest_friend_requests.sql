CREATE TABLE IF NOT EXISTS guest_friend_requests (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    requester_profile_id UUID NOT NULL REFERENCES guest_profiles(id) ON DELETE CASCADE,
    recipient_profile_id UUID NOT NULL REFERENCES guest_profiles(id) ON DELETE CASCADE,
    status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'accepted', 'declined', 'cancelled', 'removed')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT guest_friend_requests_not_self CHECK (requester_profile_id <> recipient_profile_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS guest_friend_requests_active_pair_idx
    ON guest_friend_requests (
        LEAST(requester_profile_id, recipient_profile_id),
        GREATEST(requester_profile_id, recipient_profile_id)
    )
    WHERE status IN ('pending', 'accepted');

CREATE INDEX IF NOT EXISTS guest_friend_requests_recipient_pending_idx
    ON guest_friend_requests (recipient_profile_id, created_at DESC, id DESC)
    WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS guest_friend_requests_requester_pending_idx
    ON guest_friend_requests (requester_profile_id, created_at DESC, id DESC)
    WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS guest_friend_requests_requester_created_idx
    ON guest_friend_requests (requester_profile_id, created_at DESC);

CREATE INDEX IF NOT EXISTS guest_friend_requests_requester_friends_idx
    ON guest_friend_requests (requester_profile_id, updated_at DESC, id DESC)
    WHERE status = 'accepted';

CREATE INDEX IF NOT EXISTS guest_friend_requests_recipient_friends_idx
    ON guest_friend_requests (recipient_profile_id, updated_at DESC, id DESC)
    WHERE status = 'accepted';
