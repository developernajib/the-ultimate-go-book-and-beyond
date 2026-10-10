# SocialNet - Distributed Social Network API

A production-grade social network backend built in Go. Covers the full feature set: user registration/auth, posts with media, timeline feed with ML-style ranking, follow graph (Neo4j), real-time notifications over WebSocket, full-text user search (Elasticsearch), and binary media storage (MinIO).

---

## Prerequisites

| Tool | Version |
|------|---------|
| Go | 1.27+   |
| Docker + Docker Compose | 20.10+ |
| make | any |
| `golang-migrate` CLI | latest (for migrations) |
| `redis-cli` | optional (for cache inspection) |

Install the migrate CLI:
```bash
go install -tags 'postgres' github.com/golang-migrate/migrate/v4/cmd/migrate@latest
```

---

## Infrastructure Stack

| Service | Purpose | Default Port |
|---------|---------|-------------|
| PostgreSQL 16 | User, post, follow, notification data | 5432 |
| Redis 7 | Feed cache, session store, rate-limit state | 6379 |
| Neo4j 5 | Social graph (follow relationships, recommendations) | 7687 |
| Elasticsearch 8 | Full-text user and post search | 9200 |
| MinIO | Object storage for media (images, video) | 9000 / 9001 |

---

## Architecture Overview

```
cmd/api/                HTTP server entrypoint
internal/
  config/               Environment-based configuration loader
  domain/               Pure domain models: User, Post, Feed, Media, Notification
    repository/         Repository interfaces (contracts, no implementation)
  database/             PostgreSQL connection factory (sqlx + pgx driver)
  cache/                Redis client wrapper
  repository/postgres/  PostgreSQL repository implementations
  service/              Business logic layer
    user.go             Registration, login, profile management
    post.go             Create/delete posts, hashtag extraction, mention parsing
    feed.go             Fan-out write, ranked timeline assembly
    feed_ranker.go      Wilson score / engagement-based feed ranking
    follow.go           Follow/unfollow, follower/following lists
    graph.go            Neo4j Cypher queries for the follow graph
    notification.go     Notification fan-out and WebSocket push
    media.go            Image resize (disintegration/imaging) + MinIO upload
    search.go           Elasticsearch index and search queries
  http/handler/         HTTP request handlers (chi router)
    user.go             Auth + profile endpoints
    websocket.go        WebSocket notification stream
  middleware/
    auth.go             JWT validation (jwtauth)
    cors.go             CORS policy
    ratelimit.go        Sliding-window rate limiting (go-chi/httprate)
  logging/              Structured Zap logger
  metrics/              Prometheus counters and histograms
migrations/             SQL schema migrations (up + down)
```

---

## Step-by-Step Build Guide

### Step 1 - Configuration

**What:** Load all service credentials and tuning parameters from environment variables with safe defaults.

**Files:** `internal/config/config.go`

**What it does:**
- `config.Load()` reads env vars and returns a typed `Config` struct
- No YAML or TOML files - 12-Factor App style
- Covers: `APP_ENV`, `PORT`, `JWT_SECRET`, database DSN fields, Redis URL, Neo4j URI, Elasticsearch URL, MinIO credentials

**Test it:**
```bash
cp .env.example .env
source .env
go run ./cmd/api   # should log "starting server port=8080"
```

---

### Step 2 - Domain Models

**What:** Define the canonical data structures that flow through every layer of the application.

**Files:** `internal/domain/user.go`, `internal/domain/post.go`, `internal/domain/feed.go`, `internal/domain/media.go`, `internal/domain/notification.go`, `internal/domain/errors.go`

**Key types:**

| Type | Fields |
|------|--------|
| `User` | UUID, username, email, password_hash, bio, avatar, follower/following counts, timestamps |
| `Post` | UUID, user_id, content (max 280 chars), media_urls, hashtags, mentions, reply/repost refs, visibility, engagement counts |
| `FeedEntry` | user_id, post_id, rank_score, hydrated Post |
| `Media` | UUID, user_id, original/thumbnail/medium/large URLs, mime_type, dimensions |
| `Notification` | UUID, user_id, actor_id, type (like/follow/mention/reply/repost), entity_id, is_read |

**Repository interfaces** in `internal/domain/repository/` define the contract. Concrete PostgreSQL implementations live in `internal/repository/postgres/`.

---

### Step 3 - Database Layer

**What:** Connect to PostgreSQL and run schema migrations.

**Files:** `internal/database/postgres.go`, `migrations/`

**What it does:**
- `database.NewPostgresDB(cfg)` opens a `sqlx.DB` with `pgx` driver, configures pool (max 100 open, 25 idle), and pings
- Migrations use standard SQL files in `migrations/` - apply with `golang-migrate`

**Apply migrations:**
```bash
make migrate-up
# or manually:
migrate -path ./migrations -database "$DATABASE_URL" up
```

**Roll back one step:**
```bash
make migrate-down
```

---

### Step 4 - User Service

**What:** Registration, login (bcrypt + JWT), profile retrieval and update, soft-delete.

**Files:** `internal/service/user.go`, `internal/repository/postgres/user.go`, `internal/http/handler/user.go`

**Endpoints:**

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `POST` | `/api/v1/register` | - | Create account |
| `POST` | `/api/v1/login` | - | Get JWT |
| `GET` | `/api/v1/me` | JWT | Current user profile |
| `PUT` | `/api/v1/me` | JWT | Update display_name, bio, location, website |
| `GET` | `/api/v1/users/{username}` | JWT | Public profile |
| `GET` | `/api/v1/users/search?q=...` | JWT | Search users |

**Test it:**
```bash
# Register
curl -X POST http://localhost:8080/api/v1/register \
  -H "Content-Type: application/json" \
  -d '{"username":"alice","email":"alice@example.com","password":"secret123","display_name":"Alice","birth_date":"1990-01-01T00:00:00Z"}'

# Login → grab token
TOKEN=$(curl -s -X POST http://localhost:8080/api/v1/login \
  -d '{"email":"alice@example.com","password":"secret123"}' | jq -r .token)
```

---

### Step 5 - Post Service

**What:** Create, read, and delete posts. Extract hashtags and mentions from content. Trigger feed fan-out on every new post.

**Files:** `internal/service/post.go`, `internal/repository/postgres/post.go`

**What it does:**
- Parse `#hashtag` and `@username` mentions from post content
- Enforce 280-character limit and `visibility` enum (`public` / `followers` / `private`)
- After insert: calls `FeedService.FanOut` to push the post into followers' feeds
- After insert: calls `NotificationService.NotifyMentions` for every `@mention`

**Endpoints** (add to `cmd/api/main.go` router):

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/v1/posts` | Create a post |
| `GET` | `/api/v1/posts/{id}` | Get single post |
| `DELETE` | `/api/v1/posts/{id}` | Soft-delete own post |
| `POST` | `/api/v1/posts/{id}/like` | Like a post |
| `DELETE` | `/api/v1/posts/{id}/like` | Unlike a post |

---

### Step 6 - Feed Service

**What:** Maintain each user's personalized timeline using a fan-out-on-write strategy, cached in Redis.

**Files:** `internal/service/feed.go`, `internal/service/feed_ranker.go`

**What it does:**
- **Fan-out write:** When Alice posts, push the post_id into every follower's Redis sorted set (`feed:{userID}`) with a rank score as the member score. Sorted sets give O(log n) insertion and O(log n + k) range reads.
- **Rank score** (`feed_ranker.go`): Wilson score lower bound on engagement (likes, comments, reposts) blended with recency decay. Pure engagement metrics encourage a balanced feed.
- **Timeline read:** Fetch the top-N post IDs from the sorted set, then hydrate from the post store in a single batched query.
- Inactive users (>30 days) get their feeds rebuilt lazily on first read (fan-out-on-read fallback).

**Endpoint:**

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/v1/feed?cursor=...&limit=20` | Paginated home timeline |

---

### Step 7 - Graph Service (Neo4j)

**What:** Model follow relationships as a graph to enable friend-of-friend recommendations and second-degree discovery.

**Files:** `internal/service/graph.go`

**Cypher queries used:**
```cypher
-- Follow
MERGE (a:User {id: $followerID})
MERGE (b:User {id: $followeeID})
MERGE (a)-[:FOLLOWS]->(b)

-- Second-degree suggestions (FOAF)
MATCH (me:User {id: $userID})-[:FOLLOWS]->(:User)-[:FOLLOWS]->(suggestion:User)
WHERE NOT (me)-[:FOLLOWS]->(suggestion) AND suggestion.id <> $userID
RETURN suggestion.id, count(*) AS mutualCount
ORDER BY mutualCount DESC LIMIT 10
```

**Endpoints:**

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/v1/users/{username}/follow` | Follow a user |
| `DELETE` | `/api/v1/users/{username}/follow` | Unfollow a user |
| `GET` | `/api/v1/users/{username}/followers` | Follower list |
| `GET` | `/api/v1/users/{username}/following` | Following list |
| `GET` | `/api/v1/suggestions` | FOAF recommendations |

---

### Step 8 - Notification Service

**What:** Create and deliver notifications for likes, follows, mentions, reposts, and replies. Deliver them in real-time via WebSocket.

**Files:** `internal/service/notification.go`, `internal/http/handler/websocket.go`

**What it does:**
- `NotificationService.Send(ctx, notif)` persists to the `notifications` table then pushes to the user's WebSocket channel via an in-process pub-sub hub
- `WebSocketHandler` upgrades the HTTP connection (gorilla/websocket) and subscribes the connection to the user's notification channel
- Unread count is cached in Redis key `notif:unread:{userID}`

**Endpoint:**

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/v1/ws/notifications` | WebSocket stream (upgrade) |
| `GET` | `/api/v1/notifications` | List notifications (paginated) |
| `PUT` | `/api/v1/notifications/{id}/read` | Mark as read |
| `PUT` | `/api/v1/notifications/read-all` | Mark all as read |

---

### Step 9 - Media Service

**What:** Accept image/video uploads, resize to multiple variants, and store in MinIO.

**Files:** `internal/service/media.go`

**What it does:**
- Accepts multipart form uploads (max 10 MB per file, max 4 files per post)
- Validates MIME type (jpeg, png, gif, mp4 only)
- Resizes images to thumbnail (150×150), medium (600px wide), and large (1200px wide) via `disintegration/imaging`
- Uploads all variants to MinIO using the `minio-go` SDK; returns public URLs

**Endpoint:**

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/v1/media/upload` | Upload media files, get back URLs |

---

### Step 10 - Search Service (Elasticsearch)

**What:** Full-text search over users and posts using Elasticsearch.

**Files:** `internal/service/search.go`

**What it does:**
- On user registration/update: upserts a document in the `users` ES index
- On post creation: upserts a document in the `posts` ES index
- `SearchUsers(query)`: BM25-ranked multi-match over `username` and `display_name`
- `SearchPosts(query)`: BM25 over `content` with hashtag boosting

**Endpoints:**

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/v1/search/users?q=...` | Search users |
| `GET` | `/api/v1/search/posts?q=...` | Search posts |

---

### Step 11 - HTTP Handlers and Middleware

**What:** Wire all services to chi routes, protect them with JWT, add CORS and rate limiting.

**Files:** `internal/http/handler/user.go`, `internal/middleware/auth.go`, `internal/middleware/cors.go`, `internal/middleware/ratelimit.go`, `cmd/api/main.go`

**Middleware stack (applied in order):**
1. `middleware.RequestID` - inject `X-Request-ID`
2. `middleware.RealIP` - trust `X-Forwarded-For`
3. `middleware.Logger` - structured request logging
4. `middleware.Recoverer` - panic → 500 (no crash)
5. `custommw.CORS()` - configurable allowed origins
6. `custommw.RateLimit()` - 100 req/min per IP (sliding window)
7. `custommw.Authenticator(tokenAuth)` - JWT validation on protected routes

---

## Running the Full Stack

```bash
# 1. Copy env and configure
cp .env.example .env

# 2. Start infrastructure
make docker-up

# 3. Apply database migrations
make migrate-up

# 4. Build and run the API
make run
```

Server starts on `http://localhost:8080`.

---

## Environment Variables

Copy `.env.example` to `.env`. All variables are listed there with descriptions.

| Variable | Default | Description |
|----------|---------|-------------|
| `APP_ENV` | `development` | Environment name |
| `PORT` | `8080` | HTTP listen port |
| `JWT_SECRET` | *(required)* | HMAC-SHA256 signing secret |
| `DB_HOST` | `localhost` | PostgreSQL host |
| `DB_PORT` | `5432` | PostgreSQL port |
| `DB_USER` | `postgres` | PostgreSQL user |
| `DB_PASSWORD` | *(required)* | PostgreSQL password |
| `DB_NAME` | `social_network` | PostgreSQL database |
| `REDIS_URL` | `redis://localhost:6379/0` | Redis connection URL |
| `NEO4J_URI` | `bolt://localhost:7687` | Neo4j Bolt URI |
| `NEO4J_USER` | `neo4j` | Neo4j username |
| `NEO4J_PASSWORD` | *(required)* | Neo4j password |
| `ELASTICSEARCH_URL` | `http://localhost:9200` | Elasticsearch base URL |
| `MINIO_ENDPOINT` | `localhost:9000` | MinIO endpoint |
| `MINIO_ACCESS_KEY` | *(required)* | MinIO access key |
| `MINIO_SECRET_KEY` | *(required)* | MinIO secret key |
| `MINIO_BUCKET` | `social-media` | MinIO bucket name |
| `MINIO_USE_SSL` | `false` | Enable TLS for MinIO |

---

## API Reference

### Authentication

All protected endpoints require:
```
Authorization: Bearer <jwt_token>
```

### User Endpoints

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `POST` | `/api/v1/register` | - | Create account |
| `POST` | `/api/v1/login` | - | Get JWT token |
| `GET` | `/api/v1/me` | JWT | Current user profile |
| `PUT` | `/api/v1/me` | JWT | Update profile |
| `GET` | `/api/v1/users/{username}` | JWT | Public profile |
| `GET` | `/api/v1/users/search?q=` | JWT | Search users |

### Post Endpoints

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `POST` | `/api/v1/posts` | JWT | Create post |
| `GET` | `/api/v1/posts/{id}` | JWT | Get post |
| `DELETE` | `/api/v1/posts/{id}` | JWT | Delete own post |
| `POST` | `/api/v1/posts/{id}/like` | JWT | Like post |
| `DELETE` | `/api/v1/posts/{id}/like` | JWT | Unlike post |

### Feed Endpoints

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/api/v1/feed` | JWT | Home timeline |
| `GET` | `/api/v1/feed/explore` | JWT | Public discover feed |

### Social Graph Endpoints

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `POST` | `/api/v1/users/{username}/follow` | JWT | Follow user |
| `DELETE` | `/api/v1/users/{username}/follow` | JWT | Unfollow user |
| `GET` | `/api/v1/users/{username}/followers` | JWT | Follower list |
| `GET` | `/api/v1/users/{username}/following` | JWT | Following list |
| `GET` | `/api/v1/suggestions` | JWT | Friend suggestions |

### Notification Endpoints

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/api/v1/notifications` | JWT | List notifications |
| `PUT` | `/api/v1/notifications/{id}/read` | JWT | Mark read |
| `PUT` | `/api/v1/notifications/read-all` | JWT | Mark all read |
| `GET` | `/api/v1/ws/notifications` | JWT | WebSocket stream |

### Media Endpoints

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `POST` | `/api/v1/media/upload` | JWT | Upload media (multipart) |

### Search Endpoints

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/api/v1/search/users?q=` | JWT | Full-text user search |
| `GET` | `/api/v1/search/posts?q=` | JWT | Full-text post search |

### System

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/health` | - | Liveness check |
| `GET` | `/metrics` | - | Prometheus metrics |
