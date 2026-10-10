## 7. Documentation Tools

### 7.1 godoc

`godoc` extracts documentation from Go source comments and serves it as HTML. It reads the same doc comments that appear on pkg.go.dev, so writing good comments gives you both online and local documentation.

```bash
# Install (Go 1.13+)
go install golang.org/x/tools/cmd/godoc@latest

# Run local server
godoc -http=:6060

# Browse documentation
open http://localhost:6060/pkg/

# View package documentation
godoc fmt
godoc fmt Printf

# Export as text
godoc fmt > fmt.txt
```

### 7.2 pkgsite (pkg.go.dev locally)

`pkgsite` runs the same rendering engine as pkg.go.dev on your local machine. This lets you preview how your documentation will look before publishing.

```bash
# Install
go install golang.org/x/pkgsite/cmd/pkgsite@latest

# Run local server
pkgsite

# Open browser
open http://localhost:8080

# Run on different port
pkgsite -http=:3000
```

### 7.3 Documentation Comments

```go
// Package user provides user management functionality.
//
// This package handles user authentication, authorization,
// and profile management.
//
// Example usage:
//
//     u, err := user.Create("john@example.com")
//     if err != nil {
//         log.Fatal(err)
//     }
//     fmt.Println(u.ID)
//
package user

// User represents a system user.
//
// Users must have a unique email address and cannot
// be deleted if they have active sessions.
type User struct {
    // ID is the unique identifier for the user.
    ID int64

    // Email is the user's email address.
    // It must be valid and unique.
    Email string

    // CreatedAt is when the user was created.
    CreatedAt time.Time
}

// Create creates a new user with the given email.
//
// The email address must be valid and not already in use.
// Returns an error if validation fails or the email is taken.
//
// Example:
//
//     user, err := Create("alice@example.com")
//     if err != nil {
//         return err
//     }
//
func Create(email string) (*User, error) {
    // Implementation...
}

// Deprecated: Use CreateWithContext instead.
//
// This function does not respect context cancellation
// and will be removed in v2.0.0.
func CreateUser(email string) (*User, error) {
    // Implementation...
}
```

### 7.4 Generate Documentation

```bash
# Generate markdown docs
go install github.com/davecheney/godoc2md@latest
godoc2md github.com/user/project > README.md

# Generate API documentation
go install github.com/swaggo/swag/cmd/swag@latest
swag init

# Generate from comments
# File: main.go
//  @title           API Documentation
//  @version         1.0
//  @description     This is a sample server.
//  @host            localhost:8080
//  @BasePath        /api/v1

# OpenAPI/Swagger
swag init -g cmd/api/main.go --output ./docs
```

---
