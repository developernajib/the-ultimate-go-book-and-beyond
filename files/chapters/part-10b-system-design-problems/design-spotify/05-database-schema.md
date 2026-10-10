## Database Schema

The database schema below captures the core entities: tracks, playlists, and play history. This is PostgreSQL, so indexes are declared with `CREATE INDEX` after the table rather than inline in the column list. Inline `INDEX` clauses are MySQL syntax and PostgreSQL rejects them outright, which is a syntax error worth recognizing on sight because the two dialects are mixed together constantly.

Three choices carry most of the weight here. The `play_history` table is partitioned by time because it takes billions of writes per day, and royalty runs and model training both read it as date ranges. Note that its primary key has to include `played_at`: PostgreSQL requires the partition key to be part of every unique constraint on a partitioned table, since it cannot enforce uniqueness across partitions it would have to scan. The `playlist_tracks` table keys on `(playlist_id, track_id)` to make a track appear at most once per playlist, with a separate index on `(playlist_id, position)` serving the ordered read. And `playlist_collaborators` exists as its own table because edit rights are per user, not a boolean on the playlist.

```sql
-- Tracks metadata
CREATE TABLE tracks (
    id               VARCHAR(36) PRIMARY KEY,
    title            VARCHAR(500) NOT NULL,
    artist_ids       TEXT[],
    artist_names     TEXT[],
    album_id         VARCHAR(36),
    album_name       VARCHAR(500),
    duration_seconds INT NOT NULL,
    genres           TEXT[],
    popularity       DECIMAL(5,2) NOT NULL DEFAULT 0,
    explicit         BOOLEAN NOT NULL DEFAULT FALSE,
    release_date     DATE,
    thumbnail_url    TEXT,
    has_drm          BOOLEAN NOT NULL DEFAULT FALSE,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- artist_ids is an array, so it needs GIN. A default B-tree index would index
-- the array as one opaque value and never serve a containment query.
CREATE INDEX idx_tracks_artists ON tracks USING GIN (artist_ids);
CREATE INDEX idx_tracks_album ON tracks (album_id);

-- Playlists
CREATE TABLE playlists (
    id               VARCHAR(36) PRIMARY KEY,
    owner_id         VARCHAR(36) NOT NULL,
    name             VARCHAR(300) NOT NULL,
    description      TEXT NOT NULL DEFAULT '',
    is_public        BOOLEAN NOT NULL DEFAULT TRUE,
    is_collaborative BOOLEAN NOT NULL DEFAULT FALSE,
    track_count      INT NOT NULL DEFAULT 0,
    duration_seconds INT NOT NULL DEFAULT 0,
    followers        INT NOT NULL DEFAULT 0,
    cover_url        TEXT,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_playlists_owner ON playlists (owner_id, updated_at DESC);
-- Partial index: the public browse query only ever reads is_public = TRUE, so
-- there is no reason to carry every private playlist in the index.
CREATE INDEX idx_playlists_public ON playlists (followers DESC) WHERE is_public;

-- Playlist tracks (ordered)
CREATE TABLE playlist_tracks (
    playlist_id VARCHAR(36) NOT NULL REFERENCES playlists (id) ON DELETE CASCADE,
    track_id    VARCHAR(36) NOT NULL,
    position    INT NOT NULL,
    added_by    VARCHAR(36),
    added_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (playlist_id, track_id)
);

CREATE INDEX idx_playlist_tracks_pos ON playlist_tracks (playlist_id, position);

-- Per-user edit rights on a collaborative playlist. The is_collaborative flag
-- on playlists says the playlist accepts collaborators. Membership lives here.
CREATE TABLE playlist_collaborators (
    playlist_id VARCHAR(36) NOT NULL REFERENCES playlists (id) ON DELETE CASCADE,
    user_id     VARCHAR(36) NOT NULL,
    added_by    VARCHAR(36),
    added_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (playlist_id, user_id)
);

-- Play history (write-heavy, partitioned by month)
CREATE TABLE play_history (
    user_id          VARCHAR(36)  NOT NULL,
    track_id         VARCHAR(36)  NOT NULL,
    played_at        TIMESTAMPTZ  NOT NULL,
    listened_seconds INT          NOT NULL,
    is_counted_play  BOOLEAN      NOT NULL,
    quality          VARCHAR(10)  NOT NULL,
    -- played_at is in the key because PostgreSQL requires the partition key in
    -- every unique constraint on a partitioned table.
    PRIMARY KEY (user_id, played_at, track_id)
) PARTITION BY RANGE (played_at);

-- Partitions are not created automatically. A parent with no matching child
-- rejects the insert, so provisioning runs ahead of the calendar.
CREATE TABLE play_history_2026_07 PARTITION OF play_history
    FOR VALUES FROM ('2026-07-01') TO ('2026-08-01');
CREATE TABLE play_history_2026_08 PARTITION OF play_history
    FOR VALUES FROM ('2026-08-01') TO ('2026-09-01');

-- The royalty run reads a month of plays for one track. Indexes on a
-- partitioned parent are created on each partition automatically.
CREATE INDEX idx_play_history_track ON play_history (track_id, played_at)
    WHERE is_counted_play;
```

---
