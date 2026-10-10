-- Migration: 000005_create_notifications (up)

CREATE TABLE IF NOT EXISTS notifications (
    id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id     UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    actor_id    UUID        REFERENCES users(id) ON DELETE SET NULL,
    type        VARCHAR(30) NOT NULL
                            CHECK (type IN ('like','comment','follow','mention','repost','reply')),
    entity_type VARCHAR(30),
    entity_id   UUID,
    message     TEXT        NOT NULL DEFAULT '',
    is_read     BOOLEAN     NOT NULL DEFAULT FALSE,
    read_at     TIMESTAMPTZ,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_notifications_user_id    ON notifications (user_id, created_at DESC);
CREATE INDEX idx_notifications_is_read    ON notifications (user_id, is_read) WHERE is_read = FALSE;
CREATE INDEX idx_notifications_entity     ON notifications (entity_type, entity_id);
