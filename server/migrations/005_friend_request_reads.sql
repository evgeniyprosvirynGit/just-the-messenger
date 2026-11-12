ALTER TABLE guest_friend_requests
    ADD COLUMN IF NOT EXISTS recipient_read_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS guest_friend_requests_unread_recipient_idx
    ON guest_friend_requests (recipient_profile_id, created_at DESC, id DESC)
    WHERE status = 'pending' AND recipient_read_at IS NULL;
