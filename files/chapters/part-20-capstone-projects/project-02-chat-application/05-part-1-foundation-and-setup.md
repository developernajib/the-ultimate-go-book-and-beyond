## Part 1: Foundation and Setup

> **Why `github.com/google/uuid` and not the Go 1.27 stdlib `uuid` package?** This project stores `uuid.UUID` values in struct fields that are scanned from the database and passed as query arguments. That path requires the `sql.Scanner` and `driver.Valuer` interfaces, which the standard library type deliberately does not implement. The third-party package remains the right choice wherever UUIDs cross a `database/sql` boundary. Projects in this book whose UUIDs stay in memory or serialize as strings (the URL shortener, API gateway, and ML platform) use the stdlib package instead.


In this first part, you will create the project skeleton, install all required dependencies, set up configuration management, write the database migration, and define a Docker Compose environment for local development. These foundational pieces ensure that every subsequent part of the application has a consistent, reproducible infrastructure to build upon. Getting the foundation right early prevents painful refactoring later when the codebase grows.

### 1.1 Project Initialization
Create the project structure:

```bash
mkdir -p gochat/{cmd/{server,migrate},internal/{auth,chat,storage,api,models,config},migrations,web/static}
cd gochat
go mod init github.com/yourusername/gochat
```

Install dependencies:

```bash
go get -u github.com/gorilla/websocket
go get -u github.com/go-chi/chi/v5
go get -u github.com/jackc/pgx/v5
go get -u github.com/redis/go-redis/v9
go get -u github.com/golang-jwt/jwt/v5
go get -u github.com/google/uuid
go get -u github.com/aws/aws-sdk-go-v2/service/s3
go get -u golang.org/x/crypto/bcrypt
go get -u github.com/joho/godotenv
```

### 1.2 Configuration (`internal/config/config.go`)

The following configuration defines the deployment parameters for 1.2 Configuration (`internal/config/config.go`), including resource allocation, environment-specific overrides, and dependency bindings. These settings are the primary operational knobs for tuning behavior between staging and production.

```go
package config

import (
	"os"
	"strconv"
	"time"
)

type Config struct {
	Server   ServerConfig
	Database DatabaseConfig
	Redis    RedisConfig
	S3       S3Config
	JWT      JWTConfig
}

type ServerConfig struct {
	Port            string
	ReadTimeout     time.Duration
	WriteTimeout    time.Duration
	ShutdownTimeout time.Duration
}

type DatabaseConfig struct {
	Host            string
	Port            int
	User            string
	Password        string
	DBName          string
	SSLMode         string
	MaxOpenConns    int
	MaxIdleConns    int
	ConnMaxLifetime time.Duration
}

type RedisConfig struct {
	Addr         string
	Password     string
	DB           int
	PoolSize     int
	MinIdleConns int
}

type S3Config struct {
	Endpoint        string
	AccessKeyID     string
	SecretAccessKey string
	Bucket          string
	Region          string
	UseSSL          bool
}

type JWTConfig struct {
	Secret     string
	Expiration time.Duration
}

// Load loads configuration from environment variables
func Load() (*Config, error) {
	cfg := &Config{
		Server: ServerConfig{
			Port:            getEnv("SERVER_PORT", "8080"),
			ReadTimeout:     getDuration("SERVER_READ_TIMEOUT", 15*time.Second),
			WriteTimeout:    getDuration("SERVER_WRITE_TIMEOUT", 15*time.Second),
			ShutdownTimeout: getDuration("SERVER_SHUTDOWN_TIMEOUT", 10*time.Second),
		},
		Database: DatabaseConfig{
			Host:            getEnv("DB_HOST", "localhost"),
			Port:            getEnvInt("DB_PORT", 5432),
			User:            getEnv("DB_USER", "postgres"),
			Password:        getEnv("DB_PASSWORD", "postgres"),
			DBName:          getEnv("DB_NAME", "gochat"),
			SSLMode:         getEnv("DB_SSLMODE", "disable"),
			MaxOpenConns:    getEnvInt("DB_MAX_OPEN_CONNS", 25),
			MaxIdleConns:    getEnvInt("DB_MAX_IDLE_CONNS", 5),
			ConnMaxLifetime: getDuration("DB_CONN_MAX_LIFETIME", 5*time.Minute),
		},
		Redis: RedisConfig{
			Addr:         getEnv("REDIS_ADDR", "localhost:6379"),
			Password:     getEnv("REDIS_PASSWORD", ""),
			DB:           getEnvInt("REDIS_DB", 0),
			PoolSize:     getEnvInt("REDIS_POOL_SIZE", 10),
			MinIdleConns: getEnvInt("REDIS_MIN_IDLE_CONNS", 2),
		},
		S3: S3Config{
			Endpoint:        getEnv("S3_ENDPOINT", "localhost:9000"),
			AccessKeyID:     getEnv("S3_ACCESS_KEY_ID", "minioadmin"),
			SecretAccessKey: getEnv("S3_SECRET_ACCESS_KEY", "minioadmin"),
			Bucket:          getEnv("S3_BUCKET", "gochat-uploads"),
			Region:          getEnv("S3_REGION", "us-east-1"),
			UseSSL:          getEnvBool("S3_USE_SSL", false),
		},
		JWT: JWTConfig{
			Secret:     getEnv("JWT_SECRET", "your-secret-key-change-this"),
			Expiration: getDuration("JWT_EXPIRATION", 24*time.Hour),
		},
	}

	return cfg, nil
}

func getEnv(key, defaultValue string) string {
	if value := os.Getenv(key); value != "" {
		return value
	}
	return defaultValue
}

func getEnvInt(key string, defaultValue int) int {
	if value := os.Getenv(key); value != "" {
		if intVal, err := strconv.Atoi(value); err == nil {
			return intVal
		}
	}
	return defaultValue
}

func getEnvBool(key string, defaultValue bool) bool {
	if value := os.Getenv(key); value != "" {
		if boolVal, err := strconv.ParseBool(value); err == nil {
			return boolVal
		}
	}
	return defaultValue
}

func getDuration(key string, defaultValue time.Duration) time.Duration {
	if value := os.Getenv(key); value != "" {
		if duration, err := time.ParseDuration(value); err == nil {
			return duration
		}
	}
	return defaultValue
}
```

### 1.3 Database Schema (`migrations/001_initial_schema.up.sql`)

The database schema models the core entities, short codes, original URLs, owner accounts, and click events, with indexes tuned for the dominant query patterns. Schema choices made here affect both the scalability of redirect lookups and the flexibility of analytics queries performed offline.

```sql
-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Users table
CREATE TABLE users (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    username VARCHAR(50) UNIQUE NOT NULL,
    email VARCHAR(255) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    display_name VARCHAR(100),
    avatar_url TEXT,
    status VARCHAR(20) DEFAULT 'offline', -- online, offline, away, busy
    custom_status TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    last_seen_at TIMESTAMP WITH TIME ZONE,
    deleted_at TIMESTAMP WITH TIME ZONE
);

CREATE INDEX idx_users_username ON users(username);
CREATE INDEX idx_users_email ON users(email);
CREATE INDEX idx_users_status ON users(status);

-- Channels/Rooms table
CREATE TABLE channels (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name VARCHAR(100) NOT NULL,
    description TEXT,
    channel_type VARCHAR(20) NOT NULL, -- public, private, dm
    created_by UUID REFERENCES users(id),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    deleted_at TIMESTAMP WITH TIME ZONE
);

CREATE INDEX idx_channels_type ON channels(channel_type);
CREATE INDEX idx_channels_created_by ON channels(created_by);

-- Channel members table
CREATE TABLE channel_members (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    channel_id UUID REFERENCES channels(id) ON DELETE CASCADE,
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    role VARCHAR(20) DEFAULT 'member', -- owner, admin, member
    joined_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    last_read_at TIMESTAMP WITH TIME ZONE,
    notifications_enabled BOOLEAN DEFAULT true,
    UNIQUE(channel_id, user_id)
);

CREATE INDEX idx_channel_members_channel ON channel_members(channel_id);
CREATE INDEX idx_channel_members_user ON channel_members(user_id);

-- Messages table
CREATE TABLE messages (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    channel_id UUID REFERENCES channels(id) ON DELETE CASCADE,
    user_id UUID REFERENCES users(id),
    content TEXT NOT NULL,
    message_type VARCHAR(20) DEFAULT 'text', -- text, file, image, system
    metadata JSONB, -- file info, mentions, etc.
    parent_message_id UUID REFERENCES messages(id), -- for threads
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    deleted_at TIMESTAMP WITH TIME ZONE
);

CREATE INDEX idx_messages_channel ON messages(channel_id, created_at DESC);
CREATE INDEX idx_messages_user ON messages(user_id);
CREATE INDEX idx_messages_parent ON messages(parent_message_id);
CREATE INDEX idx_messages_created_at ON messages(created_at DESC);

-- Full-text search index
CREATE INDEX idx_messages_content_gin ON messages USING gin(to_tsvector('english', content));

-- Reactions table
CREATE TABLE reactions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    message_id UUID REFERENCES messages(id) ON DELETE CASCADE,
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    emoji VARCHAR(50) NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    UNIQUE(message_id, user_id, emoji)
);

CREATE INDEX idx_reactions_message ON reactions(message_id);
CREATE INDEX idx_reactions_user ON reactions(user_id);

-- Read receipts table
CREATE TABLE read_receipts (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    message_id UUID REFERENCES messages(id) ON DELETE CASCADE,
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    read_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    UNIQUE(message_id, user_id)
);

CREATE INDEX idx_read_receipts_message ON read_receipts(message_id);
CREATE INDEX idx_read_receipts_user ON read_receipts(user_id);

-- Attachments table
CREATE TABLE attachments (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    message_id UUID REFERENCES messages(id) ON DELETE CASCADE,
    filename VARCHAR(255) NOT NULL,
    file_size BIGINT NOT NULL,
    mime_type VARCHAR(100) NOT NULL,
    storage_key TEXT NOT NULL, -- S3 key
    thumbnail_key TEXT, -- S3 key for thumbnail
    width INT, -- for images
    height INT, -- for images
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX idx_attachments_message ON attachments(message_id);

-- Typing indicators (in-memory, but we'll use Redis for real-time)
-- This table is for audit/analytics only
CREATE TABLE typing_events (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    channel_id UUID REFERENCES channels(id) ON DELETE CASCADE,
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX idx_typing_events_channel ON typing_events(channel_id, created_at DESC);

-- Invites table
CREATE TABLE invites (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    channel_id UUID REFERENCES channels(id) ON DELETE CASCADE,
    invited_by UUID REFERENCES users(id),
    invited_user UUID REFERENCES users(id),
    invite_code VARCHAR(50) UNIQUE,
    expires_at TIMESTAMP WITH TIME ZONE,
    accepted_at TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX idx_invites_channel ON invites(channel_id);
CREATE INDEX idx_invites_code ON invites(invite_code);

-- Updated at trigger function
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Apply updated_at trigger to tables
CREATE TRIGGER update_users_updated_at BEFORE UPDATE ON users
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_channels_updated_at BEFORE UPDATE ON channels
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_messages_updated_at BEFORE UPDATE ON messages
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
```

Down migration (`migrations/001_initial_schema.down.sql`):

```sql
DROP TRIGGER IF EXISTS update_messages_updated_at ON messages;
DROP TRIGGER IF EXISTS update_channels_updated_at ON channels;
DROP TRIGGER IF EXISTS update_users_updated_at ON users;
DROP FUNCTION IF EXISTS update_updated_at_column();

DROP TABLE IF EXISTS invites;
DROP TABLE IF EXISTS typing_events;
DROP TABLE IF EXISTS attachments;
DROP TABLE IF EXISTS read_receipts;
DROP TABLE IF EXISTS reactions;
DROP TABLE IF EXISTS messages;
DROP TABLE IF EXISTS channel_members;
DROP TABLE IF EXISTS channels;
DROP TABLE IF EXISTS users;

DROP EXTENSION IF EXISTS "uuid-ossp";
```

### Junior → FAANG: Why the Foundation Work Matters

Junior developers often want to skip directly to the interesting WebSocket code and add "boring" foundation work later. This is the wrong order. Configuration management, database migrations, and local Docker Compose setup are the scaffolding that makes the rest of the work possible. Building them first means you can develop and test in a consistent environment from day one.

Versioned database migrations are a first-job discipline worth establishing immediately. Every schema change should be a migration file, not a manual `ALTER TABLE` statement. This creates an auditable history of schema changes and makes it possible to reproduce the exact database state at any point in the project's history.

For interviews, being able to describe how you set up a local development environment that mirrors production (via Docker Compose) shows operational awareness beyond just coding skill.

### Senior @ FAANG: Foundation as a Platform Template

At senior level, the "foundation" work in this chapter is what platform engineering teams productize. A new service at FAANG does not start with `mkdir` and `go mod init`. It starts from a service template that includes: standard configuration management (with secrets injection from the company's vault), database migration tooling (with approval gates for production), observability hooks (structured logging, metrics, traces pre-wired), and a CI/CD pipeline definition.

The value of a service template is consistency: every service exposes the same health endpoints, uses the same logging format, follows the same secret management pattern. This consistency means on-call engineers can navigate any service's codebase and infrastructure without relearning foundational patterns. Building and maintaining the service template is platform engineering work. Ensuring teams use it is governance work. Both are staff-level concerns.

---
