# Go Chat Application

A Slack/Discord-like real-time chat server built in Go. Covers WebSockets, JWT auth, PostgreSQL, Redis pub/sub, and S3 file uploads.

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Language | Go 1.27+   |
| HTTP Router | chi v5 |
| WebSockets | gorilla/websocket |
| Database | PostgreSQL 15+ (pgx driver) |
| Cache / Pub-Sub | Redis 7+ |
| File Storage | S3-compatible (MinIO in dev) |
| Auth | JWT (golang-jwt/jwt v5) |
| Password hashing | bcrypt |

## Prerequisites

- Go 1.27+
- Docker + Docker Compose (for local PostgreSQL, Redis, MinIO)
- `make` (optional but recommended)

## Project Structure

```
02-chat-application/
├── cmd/
│   └── server/
│       └── main.go          # Entry point - wires everything together
├── internal/
│   ├── api/
│   │   ├── handlers.go      # HTTP handlers (register, login, channels, messages)
│   │   ├── upload.go        # File upload handler
│   │   └── websocket.go     # WebSocket upgrade handler
│   ├── auth/
│   │   ├── jwt.go           # Token generation and validation
│   │   ├── middleware.go    # Auth middleware + context helpers
│   │   └── ratelimit.go     # Redis-backed rate limiter
│   ├── chat/
│   │   ├── client.go        # WebSocket client (one per connection)
│   │   ├── hub.go           # Central hub - routes messages between clients
│   │   ├── message.go       # WebSocket message types
│   │   ├── message_handler.go # Persists and dispatches messages
│   │   └── presence.go      # Online presence tracking via Redis
│   ├── config/
│   │   └── config.go        # Loads config from environment variables
│   ├── models/
│   │   ├── channel.go       # Channel + ChannelMember types
│   │   ├── message.go       # Message, Reaction, Attachment types
│   │   └── user.go          # User types + request/response structs
│   └── storage/
│       ├── postgres.go      # All SQL queries (users, channels, messages, reactions)
│       ├── redis.go         # Session, presence, rate-limit store
│       └── s3.go            # File upload / download via S3 API
├── migrations/
│   ├── 001_create_users.sql
│   ├── 002_create_channels.sql
│   └── 003_create_messages.sql
├── .env.example
├── docker-compose.yml
└── Makefile
```

---

## Step-by-Step Build Guide

Work through these steps in order. Each step is self-contained and testable before moving on.

---

### Step 1 - Project Setup

**Files to create:** `go.mod`, directory skeleton

```bash
mkdir -p cmd/server internal/{api,auth,chat,config,models,storage} migrations tests
go mod init github.com/example/chat-application
go get github.com/go-chi/chi/v5@v5.0.12
go get github.com/gorilla/websocket@v1.5.3
go get github.com/golang-jwt/jwt/v5@v5.2.1
go get github.com/google/uuid@v1.6.0
go get github.com/jackc/pgx/v5@v5.6.0
go get github.com/joho/godotenv@v1.5.1
go get github.com/redis/go-redis/v9@v9.5.3
go get github.com/aws/aws-sdk-go@v1.54.0
go get golang.org/x/crypto@v0.24.0
go get github.com/nfnt/resize@v0.0.0-20180221191011-83c6a9932646
```

**Test:** `go build ./...` compiles with no errors (nothing to build yet, just verifies module is valid).

---

### Step 2 - Configuration

**File:** `internal/config/config.go`

Define a `Config` struct with nested structs for Server, Database, Redis, S3, and JWT. Implement `Load()` which reads all values from environment variables with safe defaults.

Key design: no config is hard-coded - every value comes from `os.Getenv` with a fallback.

**Test:** Write a small `main.go` that calls `config.Load()` and prints the server port. Remove it after verifying.

---

### Step 3 - Data Models

**Files:** `internal/models/user.go`, `internal/models/channel.go`, `internal/models/message.go`

Define plain Go structs - no ORM tags, just `json` and `db` struct tags.

- `user.go` - `User`, `PublicUser` (safe to return in API), `CreateUserRequest`, `LoginRequest`, `LoginResponse`
- `channel.go` - `Channel`, `ChannelMember`, `ChannelType` enum, `CreateChannelRequest`, `ChannelWithMembers`
- `message.go` - `Message`, `MessageType` enum, `Reaction`, `Attachment`, `SendMessageRequest`, `MessageListRequest`, `MessageSearchRequest`

**Test:** `go vet ./internal/models/...` - no errors.

---

### Step 4 - WebSocket Layer

**Files:** `internal/chat/message.go`, `internal/chat/client.go`, `internal/chat/hub.go`, `internal/chat/presence.go`

Build in this order:

1. `message.go` - define `WSMessage` struct (type string, payload JSON, channel ID, user ID). Define event type constants: `EventMessage`, `EventJoin`, `EventLeave`, `EventTyping`, `EventPresence`.

2. `client.go` - one `Client` per WebSocket connection. Owns a `send` channel (buffered). Has `readPump` (reads from WebSocket, sends to hub) and `writePump` (reads from `send` channel, writes to WebSocket). Runs both pumps as goroutines on connect.

3. `hub.go` - `Hub` manages all active clients, grouped by channel ID. Handles `register`, `unregister`, and `broadcast` via internal channels. Uses Redis pub/sub to fan out messages to other server instances. Run loop is a `select` over these channels.

4. `presence.go` - `PresenceService` wraps Redis. `SetOnline(userID)`, `SetOffline(userID)`, `GetOnlineUsers(channelID)`.

**Test:** Unit test `hub.go` - register two mock clients, broadcast a message, assert both receive it.

---

### Step 5 - Storage Layer

**Files:** `internal/storage/postgres.go`, `internal/storage/redis.go`, `internal/storage/s3.go`

`postgres.go` - `PostgresStore` wraps `*sql.DB`. Implement:
- `CreateUser`, `GetUserByUsername`, `GetUserByID`, `UpdateUserStatus`
- `CreateChannel`, `GetChannelByID`, `GetUserChannels`, `IsUserInChannel`
- `CreateMessage`, `GetMessages` (paginated by cursor), `SearchMessages` (full-text via `to_tsvector`)
- `AddReaction`, `RemoveReaction`, `GetReactions`

All queries use `$N` parameterized placeholders - never string concatenation.

`redis.go` - `RedisStore` wraps `*redis.Client`. Used for: presence keys, rate-limit counters, session cache.

`s3.go` - `S3Store` wraps `aws-sdk-go`. Implement `UploadFile(key, reader, size, contentType)` and `GetPresignedURL(key, expiry)`.

**Test:** Run migrations (Step 5b), then integration-test `CreateUser` → `GetUserByUsername` round-trip against a local PostgreSQL.

---

### Step 5b - SQL Migrations

**Files:** `migrations/001_create_users.sql`, `migrations/002_create_channels.sql`, `migrations/003_create_messages.sql`

Run against your local DB:

```bash
psql -U postgres -d gochat -f migrations/001_create_users.sql
psql -U postgres -d gochat -f migrations/002_create_channels.sql
psql -U postgres -d gochat -f migrations/003_create_messages.sql
```

Or via Docker Compose:

```bash
make docker-up
make migrate
```

---

### Step 6 - Authentication

**Files:** `internal/auth/jwt.go`, `internal/auth/middleware.go`, `internal/auth/ratelimit.go`

`jwt.go` - `JWTService` with `GenerateToken(userID, username)` and `ValidateToken(tokenString)`. Store `userID` and `username` in JWT claims. Use HS256.

`middleware.go` - `Middleware.Authenticate` reads `Authorization: Bearer <token>` header, validates the JWT, and stores `userID` in request context. Provide `GetUserID(ctx)` helper.

`ratelimit.go` - `RateLimiter` uses a Redis counter per user per window. `LimitByUser` middleware increments the counter and returns `429` if the limit is exceeded.

**Test:** Generate a token, tamper with one byte, verify `ValidateToken` returns an error.

---

### Step 7 - HTTP API Handlers

**File:** `internal/api/handlers.go`

`Handlers` struct takes `*storage.PostgresStore`, `*storage.RedisStore`, `*auth.JWTService`.

Implement:
- `POST /api/register` - hash password with bcrypt, call `pgStore.CreateUser`, return JWT
- `POST /api/login` - look up user, compare hash, return JWT
- `GET /api/channels` - return channels for authenticated user
- `POST /api/channels` - create channel, add creator as owner
- `GET /api/channels/{id}` - verify membership, return channel
- `GET /api/channels/{channelId}/messages` - verify membership, paginate with `?before=<uuid>&limit=50`
- `GET /api/messages/search` - full-text search with `?q=<query>&channel_id=<uuid>`

Helper functions: `respondJSON(w, status, data)`, `respondError(w, status, message)`.

**Test:** Use `httptest.NewRecorder` to test register → login → get channels flow without a live server.

---

### Step 8 - File Upload

**File:** `internal/api/upload.go`

`UploadHandler` takes `*storage.S3Store` and `*storage.PostgresStore`.

`POST /api/upload`:
1. Parse multipart form (max 10 MB)
2. Validate MIME type (allow `image/*`, `application/pdf`, common document types)
3. Generate a UUID key: `uploads/<uuid>/<original-filename>`
4. Upload to S3 via `s3Store.UploadFile`
5. If image, generate thumbnail with `nfnt/resize`
6. Return `{ "url": "...", "key": "..." }`

**Test:** Upload a small PNG in a unit test using `httptest` and a mock S3 store.

---

### Step 9 - Message Handler Service

**File:** `internal/chat/message_handler.go`

`MessageHandler` takes `*storage.PostgresStore`.

`HandleMessage(ctx, wsMsg)`:
1. Validate the incoming `WSMessage`
2. Call `pgStore.CreateMessage` to persist
3. Return the persisted `*models.Message` (with user info populated)

The hub calls this on every inbound message before broadcasting, ensuring messages are stored before clients see them.

**Test:** Mock `PostgresStore`, send a `WSMessage`, assert `CreateMessage` was called with correct args.

---

### Step 10 - Wire It All Together

**File:** `cmd/server/main.go`

Initialization order:
1. Load `.env` with `godotenv.Load()`
2. Load `config.Load()`
3. Connect PostgreSQL - set pool limits from config
4. Connect Redis - ping to verify
5. Init `storage.NewS3Store(...)`
6. Create `storage.NewPostgresStore(db)` and `storage.NewRedisStore(client)`
7. Create `auth.NewJWTService(...)`, `chat.NewMessageHandler(pgStore)`, `chat.NewPresenceService(redisStore)`
8. Create `chat.NewHub(...)` and `go hub.Run()`
9. Create `api.NewHandlers(...)`, `api.NewWSHandler(hub, jwtService)`, `api.NewUploadHandler(s3Store, pgStore)`
10. Create `auth.NewMiddleware(jwtService)` and `auth.NewRateLimiter(redisStore, 100, time.Minute)`
11. Build chi router - wire all routes
12. Start `http.Server` in a goroutine
13. Block on `SIGINT`/`SIGTERM`, then graceful shutdown with timeout

**Test:** `go build ./...` - zero errors. Then `go run cmd/server/main.go` with services running.

---

## Running the Application

### 1. Start infrastructure

```bash
make docker-up
```

### 2. Run migrations

```bash
psql -U postgres -h localhost -d gochat -f migrations/001_create_users.sql
psql -U postgres -h localhost -d gochat -f migrations/002_create_channels.sql
psql -U postgres -h localhost -d gochat -f migrations/003_create_messages.sql
```

### 3. Configure environment

```bash
cp .env.example .env
# Edit .env as needed
```

### 4. Run the server

```bash
go run cmd/server/main.go
# or
make run
```

Server listens on `http://localhost:8080` by default.

---

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `SERVER_PORT` | `8080` | HTTP listen port |
| `SERVER_READ_TIMEOUT` | `15s` | HTTP read timeout |
| `SERVER_WRITE_TIMEOUT` | `15s` | HTTP write timeout |
| `SERVER_SHUTDOWN_TIMEOUT` | `10s` | Graceful shutdown window |
| `DB_HOST` | `localhost` | PostgreSQL host |
| `DB_PORT` | `5432` | PostgreSQL port |
| `DB_USER` | `postgres` | PostgreSQL user |
| `DB_PASSWORD` | `postgres` | PostgreSQL password |
| `DB_NAME` | `gochat` | Database name |
| `DB_SSLMODE` | `disable` | SSL mode (`disable`, `require`, `verify-full`) |
| `DB_MAX_OPEN_CONNS` | `25` | Max open DB connections |
| `DB_MAX_IDLE_CONNS` | `5` | Max idle DB connections |
| `DB_CONN_MAX_LIFETIME` | `5m` | Max connection lifetime |
| `REDIS_ADDR` | `localhost:6379` | Redis address |
| `REDIS_PASSWORD` | `` | Redis password (empty = none) |
| `REDIS_DB` | `0` | Redis database index |
| `REDIS_POOL_SIZE` | `10` | Redis connection pool size |
| `REDIS_MIN_IDLE_CONNS` | `2` | Redis min idle connections |
| `S3_ENDPOINT` | `localhost:9000` | S3/MinIO endpoint |
| `S3_ACCESS_KEY_ID` | `minioadmin` | S3 access key |
| `S3_SECRET_ACCESS_KEY` | `minioadmin` | S3 secret key |
| `S3_BUCKET` | `gochat-uploads` | S3 bucket name |
| `S3_REGION` | `us-east-1` | S3 region |
| `S3_USE_SSL` | `false` | Use HTTPS for S3 |
| `JWT_SECRET` | `your-secret-key-change-this` | JWT signing secret - **change in production** |
| `JWT_EXPIRATION` | `24h` | JWT token lifetime |

---

## API Endpoints

### Public

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/register` | Register a new user |
| `POST` | `/api/login` | Login, returns JWT |
| `GET` | `/ws?token=<jwt>` | Upgrade to WebSocket |

### Protected (requires `Authorization: Bearer <token>`)

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/channels` | List channels for current user |
| `POST` | `/api/channels` | Create a new channel |
| `GET` | `/api/channels/{id}` | Get channel details |
| `GET` | `/api/channels/{channelId}/messages` | Get messages (paginated) |
| `GET` | `/api/messages/search?q=<query>` | Full-text message search |
| `POST` | `/api/upload` | Upload a file (multipart/form-data) |

### WebSocket Events

Once connected via `/ws`, send and receive JSON messages with this shape:

```json
{
  "type": "message",
  "channel_id": "<uuid>",
  "content": "Hello!",
  "message_type": "text"
}
```

Event types: `message`, `join`, `leave`, `typing`, `presence`.

---

## Running Tests

```bash
make test
# or
go test ./...
```

Integration tests require PostgreSQL and Redis running (`make docker-up` first).

---

## Makefile Targets

| Target | Description |
|--------|-------------|
| `make build` | Compile binary to `bin/server` |
| `make run` | Run server directly with `go run` |
| `make test` | Run all tests |
| `make lint` | Run `go vet` and `staticcheck` |
| `make docker-build` | Build Docker image |
| `make docker-up` | Start PostgreSQL + Redis + MinIO |
| `make docker-down` | Stop and remove containers |
