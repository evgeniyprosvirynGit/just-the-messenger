CREATE EXTENSION IF NOT EXISTS postgis;

CREATE TABLE IF NOT EXISTS public_messages (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    author_name TEXT NOT NULL,
    body VARCHAR(240) NOT NULL CHECK (length(btrim(body)) > 0),
    location GEOGRAPHY(POINT, 4326) NOT NULL,
    city TEXT NOT NULL,
    country TEXT NOT NULL,
    region_code TEXT NOT NULL CHECK (region_code ~ '^[0-9bcdefghjkmnpqrstuvwxyz]{2}$'),
    avatar_color TEXT NOT NULL DEFAULT '#82c8ba',
    initials TEXT NOT NULL DEFAULT 'ВЫ',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS public_messages_location_gix ON public_messages USING GIST (location);
CREATE INDEX IF NOT EXISTS public_messages_active_created_idx ON public_messages (expires_at, created_at DESC);
CREATE INDEX IF NOT EXISTS public_messages_region_active_idx ON public_messages (region_code, expires_at, created_at DESC);

CREATE TABLE IF NOT EXISTS realtime_outbox (
    id BIGSERIAL PRIMARY KEY,
    subject TEXT NOT NULL,
    payload JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    published_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS realtime_outbox_unpublished_idx ON realtime_outbox (id) WHERE published_at IS NULL;
