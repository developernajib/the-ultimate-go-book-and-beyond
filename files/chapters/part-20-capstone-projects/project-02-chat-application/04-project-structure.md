## Project Structure

A well-organized project structure is essential for any non-trivial Go application, especially one involving real-time communication. The layout below follows the standard Go project convention of placing application entry points in `cmd/` and internal business logic in `internal/`. Each package has a single, clear responsibility -- for example, `chat/` handles WebSocket logic while `storage/` abstracts away database and cache interactions. This separation makes the codebase easier to navigate, test, and extend as you add new features.

```
gochat/
├── cmd/
│   ├── server/
│   │   └── main.go
│   └── migrate/
│       └── main.go
├── internal/
│   ├── auth/
│   │   ├── jwt.go
│   │   ├── middleware.go
│   │   └── service.go
│   ├── chat/
│   │   ├── hub.go           # WebSocket hub
│   │   ├── client.go        # WebSocket client
│   │   ├── room.go          # Chat rooms
│   │   ├── message.go       # Message handling
│   │   └── presence.go      # User presence
│   ├── storage/
│   │   ├── postgres.go      # Database layer
│   │   ├── redis.go         # Cache layer
│   │   └── s3.go            # File storage
│   ├── api/
│   │   ├── handlers.go      # HTTP handlers
│   │   └── websocket.go     # WebSocket upgrade
│   ├── models/
│   │   ├── user.go
│   │   ├── message.go
│   │   ├── channel.go
│   │   └── room.go
│   └── config/
│       └── config.go
├── migrations/
│   ├── 001_initial_schema.up.sql
│   └── 001_initial_schema.down.sql
├── web/
│   └── static/
│       ├── index.html
│       └── app.js
├── docker-compose.yml
├── Dockerfile
├── go.mod
└── README.md
```

---

### Junior → FAANG: Project Structure as a Collaboration Signal

A clean project structure is the first thing a reviewer sees when they open your repository. The `cmd/` for entry points, `internal/` for private business logic convention is the standard Go project layout. Using it signals that you have read the community conventions and follow them.

Each package in `internal/` should have a single, clear responsibility. When you find yourself creating a package called `utils` or `helpers`, that is a sign that you have not decomposed your concerns clearly. `chat/` handles WebSocket logic, `storage/` handles data access, `auth/` handles authentication. The package names should make the dependency graph obvious.

In an interview, you can describe this structure in 60 seconds. That is the right length: long enough to show you have thought about it, short enough to not waste interview time on layout instead of substance.

### Senior @ FAANG: Structure as an Enforced Architectural Boundary

At senior level, the project structure encodes architectural rules. The `internal/` package restriction (cannot be imported by external modules) is a Go language-enforced boundary. But within `internal/`, additional boundaries must be enforced by convention and code review: the `chat/` package should not import `storage/` directly (that would create coupling between transport and persistence layers). Instead, `chat/` depends on an interface, and the concrete storage implementation is injected at startup.

For a production service, the project structure is also a team ownership map. The `auth/` package may be owned by a security team, `storage/` by a data platform team, and `chat/` by the product engineering team. Clear package boundaries make that ownership explicit and reduce the coordination required for changes that cross ownership boundaries. Designing the project structure with future ownership in mind is a staff-level concern, not just a code quality concern.

---
