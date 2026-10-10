## 9. Third-Party Essential Tools

### 9.1 Air (Hot Reload)

Air watches your source files for changes and automatically rebuilds and restarts the binary. This eliminates the manual stop-build-run cycle during development.

```bash
# Install
go install github.com/air-verse/air@latest

# Initialize
air init

# Run
air

# Configuration file: .air.toml
root = "."
tmp_dir = "tmp"

[build]
  cmd = "go build -o ./tmp/main ./cmd/api"
  bin = "tmp/main"
  full_bin = "APP_ENV=dev APP_USER=air ./tmp/main"
  include_ext = ["go", "tpl", "tmpl", "html"]
  exclude_dir = ["assets", "tmp", "vendor"]
  include_dir = []
  exclude_file = []
  delay = 1000
  stop_on_error = true
  send_interrupt = false
  kill_delay = 500

[log]
  time = false

[color]
  main = "magenta"
  watcher = "cyan"
  build = "yellow"
  runner = "green"
```

### 9.2 mockgen (Mocking)

```bash
# Install
go install go.uber.org/mock/mockgen@latest

# Generate mocks from interface
mockgen -source=internal/user/repository.go -destination=mocks/user_repository_mock.go

# Generate from package
mockgen -package=mocks database/sql/driver Conn,Driver

# With go:generate
//go:generate mockgen -source=repository.go -destination=mocks/repository_mock.go
go generate ./...
```

#### Using Mocks

```go
package user_test

import (
    "testing"
    "github.com/golang/mock/gomock"
    "myapp/mocks"
)

func TestUserService(t *testing.T) {
    ctrl := gomock.NewController(t)
    defer ctrl.Finish()

    mockRepo := mocks.NewMockUserRepository(ctrl)

    // Set expectations
    mockRepo.EXPECT().
        GetByID(gomock.Any(), int64(1)).
        Return(&User{ID: 1, Email: "test@example.com"}, nil).
        Times(1)

    service := NewUserService(mockRepo)
    user, err := service.GetUser(context.Background(), 1)

    require.NoError(t, err)
    assert.Equal(t, "test@example.com", user.Email)
}
```

### 9.3 Wire (Dependency Injection)

```bash
# Install
go install github.com/google/wire/cmd/wire@latest

# Define providers
// File: wire.go
//go:build wireinject

package main

import "github.com/google/wire"

func InitializeServer() (*Server, error) {
    wire.Build(
        NewDB,
        NewUserRepository,
        NewUserService,
        NewServer,
    )
    return nil, nil
}

# Generate code
wire

# Generated file: wire_gen.go (do not edit)
```

### 9.4 sqlc (SQL Code Generator)

```bash
# Install
go install github.com/sqlc-dev/sqlc/cmd/sqlc@latest

# Initialize
sqlc init

# Configuration: sqlc.yaml
version: "2"
sql:
  - engine: "postgresql"
    queries: "internal/db/queries/"
    schema: "internal/db/schema/"
    gen:
      go:
        package: "db"
        out: "internal/db"
        sql_package: "pgx/v5"
        emit_json_tags: true
        emit_prepared_queries: false
        emit_interface: true
        emit_exact_table_names: false

# Generate code
sqlc generate
```

#### SQL Files

```sql
-- File: queries/users.sql
-- name: GetUser :one
SELECT * FROM users WHERE id = $1;

-- name: ListUsers :many
SELECT * FROM users ORDER BY created_at DESC LIMIT $1 OFFSET $2;

-- name: CreateUser :one
INSERT INTO users (email, name)
VALUES ($1, $2)
RETURNING *;

-- name: UpdateUser :exec
UPDATE users SET email = $1, name = $2 WHERE id = $3;

-- name: DeleteUser :exec
DELETE FROM users WHERE id = $1;
```

### 9.5 Buf (Protocol Buffers)

```bash
# Install
go install github.com/bufbuild/buf/cmd/buf@latest

# Initialize
buf mod init

# Configuration: buf.yaml
version: v1
breaking:
  use:
    - FILE
lint:
  use:
    - DEFAULT

# buf.gen.yaml
version: v1
managed:
  enabled: true
plugins:
  - plugin: go
    out: gen/go
    opt:
      - paths=source_relative
  - plugin: go-grpc
    out: gen/go
    opt:
      - paths=source_relative

# Generate
buf generate

# Lint proto files
buf lint

# Breaking change detection
buf breaking --against '.git#branch=main'

# Format proto files
buf format -w
```

### 9.6 Additional Tools

```bash
# Database migrations
go install github.com/golang-migrate/migrate/v4/cmd/migrate@latest
migrate create -ext sql -dir migrations -seq create_users_table

# GraphQL code generation
go install github.com/99designs/gqlgen@latest
gqlgen init
gqlgen generate

# Swagger/OpenAPI
go install github.com/swaggo/swag/cmd/swag@latest
swag init

# Testify (assertions)
go get github.com/stretchr/testify

# Viper (configuration)
go get github.com/spf13/viper

# Cobra (CLI)
go install github.com/spf13/cobra-cli@latest
cobra-cli init

# Task runner (alternative to Make)
go install github.com/go-task/task/v3/cmd/task@latest

# Linting imports
go install github.com/daixiang0/gci@latest
gci write -s standard -s default -s "prefix(github.com/myorg)" .

# Vulnerability checking
go install golang.org/x/vuln/cmd/govulncheck@latest
govulncheck ./...

# Coverage tools
go install github.com/axw/gocov/gocov@latest
go install github.com/AlekSi/gocov-xml@latest
gocov test ./... | gocov-xml > coverage.xml
```

---
