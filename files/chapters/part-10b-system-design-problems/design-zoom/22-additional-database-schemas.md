## Additional Database Schemas

These supplementary schemas support the quality monitoring and analytics features described in the deep-dive sections. The `meeting_quality_metrics` table stores per-participant network telemetry (packet loss, jitter, RTT, MOS score) time-stamped throughout the meeting, providing the raw data that the Quality Monitor aggregates in real time and that support engineers query when diagnosing call quality complaints after the fact. It is range-partitioned by day, which is what makes the 90-day retention policy a `DROP TABLE` on an old partition rather than a `DELETE` that has to walk billions of rows. The `meeting_analytics` table holds the post-meeting summary, and `transcription_segments` holds ASR output. Recordings are tracked by the `recordings` table defined in the main schema section, not duplicated here.

Note that `meeting_participants` is **extended**, not redefined. The table is created in the main schema section, and repeating a `CREATE TABLE` for it here with a different column list would give two conflicting definitions of one table, so the analytics columns arrive by `ALTER TABLE`.

```sql
-- Meeting quality metrics (per participant per meeting)
-- Note the primary key ends with sample_time. A partitioned table's key
-- must contain every partition column, so PRIMARY KEY (meeting_id,
-- user_id) alone would be rejected outright.
CREATE TABLE meeting_quality_metrics (
    meeting_id      VARCHAR(20)  NOT NULL,
    user_id         VARCHAR(36)  NOT NULL,
    sample_time     TIMESTAMPTZ  NOT NULL,
    audio_mos       DECIMAL(3,2),    -- 1.0 - 5.0
    packet_loss     DECIMAL(5,4),    -- 0.0000 - 1.0000
    jitter_ms       SMALLINT,
    rtt_ms          SMALLINT,
    bitrate_kbps    INT,
    frame_rate      SMALLINT,
    resolution      VARCHAR(10),     -- 180p, 360p, 720p
    PRIMARY KEY (meeting_id, user_id, sample_time)
) PARTITION BY RANGE (sample_time);

-- A partitioned table with no partitions accepts no rows: an INSERT that
-- matches no partition fails rather than landing anywhere. Create them
-- ahead of time (pg_partman, or a scheduled job) and never let the
-- scheduler fall behind the clock.
CREATE TABLE meeting_quality_metrics_2026_07_17 PARTITION OF meeting_quality_metrics
    FOR VALUES FROM ('2026-07-17') TO ('2026-07-18');
CREATE TABLE meeting_quality_metrics_2026_07_18 PARTITION OF meeting_quality_metrics
    FOR VALUES FROM ('2026-07-18') TO ('2026-07-19');

-- 90-day retention is then one cheap DDL statement per expired day:
--   DROP TABLE meeting_quality_metrics_2026_04_18;

-- Meeting analytics (post-meeting summary)
CREATE TABLE meeting_analytics (
    meeting_id          VARCHAR(20) PRIMARY KEY REFERENCES meetings (id),
    total_duration_sec  INT,
    unique_participants INT,
    peak_participants   INT,
    avg_audio_mos       DECIMAL(3,2),
    avg_video_quality   DECIMAL(3,2),
    audio_only_pct      DECIMAL(5,2),
    screen_share_pct    DECIMAL(5,2),
    reconnect_rate      DECIMAL(5,4),
    recording_size      BIGINT,
    created_at          TIMESTAMPTZ DEFAULT NOW()
);

-- Participant detailed metrics.
-- meeting_participants already exists (see the Database Schema section).
-- These are the analytics columns the reporting queries read.
ALTER TABLE meeting_participants
    ADD COLUMN audio_on_seconds     INT DEFAULT 0,
    ADD COLUMN video_on_seconds     INT DEFAULT 0,
    ADD COLUMN screen_share_seconds INT DEFAULT 0,
    ADD COLUMN speaking_seconds     INT DEFAULT 0,
    ADD COLUMN avg_audio_mos        DECIMAL(3,2),
    ADD COLUMN reconnect_count      SMALLINT DEFAULT 0;

-- Transcription segments
CREATE TABLE transcription_segments (
    id              BIGSERIAL PRIMARY KEY,
    meeting_id      VARCHAR(20) NOT NULL REFERENCES meetings (id),
    speaker_id      VARCHAR(36),
    speaker_name    VARCHAR(100),
    text            TEXT,
    confidence      DECIMAL(4,3),
    start_time_sec  DECIMAL(10,3),
    end_time_sec    DECIMAL(10,3),
    language        VARCHAR(5),
    created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- Again: no inline INDEX clause in PostgreSQL.
CREATE INDEX idx_transcription_meeting
    ON transcription_segments (meeting_id, start_time_sec);
```


---
