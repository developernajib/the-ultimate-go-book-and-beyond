## Database Schema

The database schema stores the persistent state of meetings, participant history, and recordings. Note that real-time meeting state (who is currently connected, which media server is handling the call) lives in Redis for speed, while PostgreSQL handles durable records that survive restarts. The `meetings` table uses a human-readable ID format (like 123-456-7890) instead of UUIDs because users need to type and share these IDs easily. Participant records track join and leave times so the system can generate attendance reports and billing data. Every timestamp is `TIMESTAMPTZ`. Participants join one meeting from a dozen time zones, and a bare `TIMESTAMP` silently drops the offset, which turns billing and attendance reports into fiction the first time a meeting crosses midnight somewhere.

```sql
-- Meetings
CREATE TABLE meetings (
    id           VARCHAR(20) PRIMARY KEY,   -- e.g., 123-456-7890
    host_id      VARCHAR(36) NOT NULL,
    title        VARCHAR(300),
    scheduled_at TIMESTAMPTZ,
    started_at   TIMESTAMPTZ,
    ended_at     TIMESTAMPTZ,
    duration_min SMALLINT DEFAULT 60,
    status       VARCHAR(20) DEFAULT 'scheduled',
    pass_code    VARCHAR(10),
    settings     JSONB,
    created_at   TIMESTAMPTZ DEFAULT NOW()
);

-- PostgreSQL has no inline INDEX clause inside CREATE TABLE. That syntax is
-- MySQL's, and Postgres rejects it outright, so indexes are their own
-- statements.
CREATE INDEX idx_meetings_host ON meetings (host_id, scheduled_at DESC);
CREATE INDEX idx_meetings_status ON meetings (status, started_at);

-- Participants (per meeting session)
CREATE TABLE meeting_participants (
    meeting_id   VARCHAR(20) NOT NULL REFERENCES meetings (id),
    user_id      VARCHAR(36) NOT NULL,
    display_name VARCHAR(100),
    joined_at    TIMESTAMPTZ NOT NULL,
    left_at      TIMESTAMPTZ,
    duration_sec INT,
    PRIMARY KEY (meeting_id, user_id, joined_at)
);

-- Attendance reports read every row for one meeting, and the primary key
-- already leads with meeting_id, so that access path is covered. This index
-- serves the other direction: one user's meeting history.
CREATE INDEX idx_participants_user ON meeting_participants (user_id, joined_at DESC);

-- Recordings
CREATE TABLE recordings (
    id           VARCHAR(36) PRIMARY KEY,
    meeting_id   VARCHAR(20) NOT NULL REFERENCES meetings (id),
    host_id      VARCHAR(36) NOT NULL,
    s3_key       TEXT,
    layout       VARCHAR(20),   -- speaker, gallery
    duration_sec INT,
    size_bytes   BIGINT,
    status       VARCHAR(20),   -- recording, processing, ready, failed
    created_at   TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_recordings_meeting ON recordings (meeting_id);
CREATE INDEX idx_recordings_host ON recordings (host_id, created_at DESC);
```

---
