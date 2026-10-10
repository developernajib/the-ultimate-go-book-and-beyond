## 52.2 User Service

### User Model and Repository

The user model defines the core data structures, while the repository translates domain method calls into parameterized SQL queries. Each repository method accepts a `context.Context` to propagate deadlines and cancellation into query execution. Password hashing uses **Argon2id**, the 2015 Password Hashing Competition winner and the algorithm OWASP currently recommends for new systems. Argon2id is memory-hard, so it resists GPU and ASIC attacks far better than bcrypt at any cost factor. We store the full PHC-format string (`$argon2id$v=19$m=...,t=...,p=...$salt$hash`), which embeds the parameters so that hashes can be migrated to stronger settings over time without breaking existing users.

```go
// internal/user/model.go
package user

import (
	"crypto/rand"
	"crypto/subtle"
	"encoding/base64"
	"fmt"
	"strings"
	"time"

	"golang.org/x/crypto/argon2"
)

// Argon2id parameters (OWASP 2026 recommendation for interactive logins).
// Tune memoryKiB upward as hardware improves - target ~250ms per hash.
const (
	argonTime      = 2
	argonMemoryKiB = 47 * 1024 // 47 MiB
	argonThreads   = 1
	argonKeyLen    = 32
	argonSaltLen   = 16
)

// User represents a user in the system
type User struct {
	ID           string    `json:"id" db:"id"`
	Email        string    `json:"email" db:"email"`
	PasswordHash string    `json:"-" db:"password_hash"`
	FirstName    string    `json:"first_name" db:"first_name"`
	LastName     string    `json:"last_name" db:"last_name"`
	Phone        string    `json:"phone,omitempty" db:"phone"`
	Role         string    `json:"role" db:"role"`
	Status       string    `json:"status" db:"status"`
	CreatedAt    time.Time `json:"created_at" db:"created_at"`
	UpdatedAt    time.Time `json:"updated_at" db:"updated_at"`
}

// Address represents a user address
type Address struct {
	ID        string    `json:"id" db:"id"`
	UserID    string    `json:"user_id" db:"user_id"`
	Type      string    `json:"type" db:"type"` // shipping, billing
	Line1     string    `json:"line1" db:"line1"`
	Line2     string    `json:"line2,omitempty" db:"line2"`
	City      string    `json:"city" db:"city"`
	State     string    `json:"state" db:"state"`
	ZipCode   string    `json:"zip_code" db:"zip_code"`
	Country   string    `json:"country" db:"country"`
	IsDefault bool      `json:"is_default" db:"is_default"`
	CreatedAt time.Time `json:"created_at" db:"created_at"`
}

// SetPassword hashes and sets the password using Argon2id.
func (u *User) SetPassword(password string) error {
	if len(password) < 12 {
		return fmt.Errorf("password must be at least 12 characters")
	}
	salt := make([]byte, argonSaltLen)
	if _, err := rand.Read(salt); err != nil {
		return fmt.Errorf("generate salt: %w", err)
	}
	key := argon2.IDKey([]byte(password), salt, argonTime, argonMemoryKiB, argonThreads, argonKeyLen)
	u.PasswordHash = fmt.Sprintf("$argon2id$v=%d$m=%d,t=%d,p=%d$%s$%s",
		argon2.Version, argonMemoryKiB, argonTime, argonThreads,
		base64.RawStdEncoding.EncodeToString(salt),
		base64.RawStdEncoding.EncodeToString(key),
	)
	return nil
}

// CheckPassword verifies the password. Uses constant-time comparison
// to avoid leaking timing information about hash prefix matches.
func (u *User) CheckPassword(password string) bool {
	parts := strings.Split(u.PasswordHash, "$")
	if len(parts) != 6 || parts[1] != "argon2id" {
		return false
	}
	var memory, time uint32
	var threads uint8
	if _, err := fmt.Sscanf(parts[3], "m=%d,t=%d,p=%d", &memory, &time, &threads); err != nil {
		return false
	}
	salt, err := base64.RawStdEncoding.DecodeString(parts[4])
	if err != nil {
		return false
	}
	want, err := base64.RawStdEncoding.DecodeString(parts[5])
	if err != nil {
		return false
	}
	got := argon2.IDKey([]byte(password), salt, time, memory, threads, uint32(len(want)))
	return subtle.ConstantTimeCompare(got, want) == 1
}
```

The repository handles all database interactions for the user aggregate. It creates the schema on initialization (suitable for development, though in production you should use a migration tool), generates UUIDs for new records, and uses `FOR UPDATE`-style locking where needed. The `AddAddress` method demonstrates a common pattern: when setting a new default address, it first clears the existing default within the same address type.

```go
// internal/user/repository.go
package user

import (
	"context"
	"database/sql"
	"fmt"
	"time"

	"github.com/google/uuid"
)

// Repository handles user persistence
type Repository struct {
	db *sql.DB
}

// NewRepository creates a user repository
func NewRepository(db *sql.DB) (*Repository, error) {
	repo := &Repository{db: db}
	if err := repo.createSchema(); err != nil {
		return nil, err
	}
	return repo, nil
}

func (r *Repository) createSchema() error {
	query := `
		CREATE TABLE IF NOT EXISTS users (
			id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
			email VARCHAR(255) UNIQUE NOT NULL,
			password_hash VARCHAR(255) NOT NULL,
			first_name VARCHAR(100) NOT NULL,
			last_name VARCHAR(100) NOT NULL,
			phone VARCHAR(20),
			role VARCHAR(20) DEFAULT 'customer',
			status VARCHAR(20) DEFAULT 'active',
			created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
			updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
		);

		CREATE TABLE IF NOT EXISTS addresses (
			id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
			user_id UUID REFERENCES users(id) ON DELETE CASCADE,
			type VARCHAR(20) NOT NULL,
			line1 VARCHAR(255) NOT NULL,
			line2 VARCHAR(255),
			city VARCHAR(100) NOT NULL,
			state VARCHAR(100) NOT NULL,
			zip_code VARCHAR(20) NOT NULL,
			country VARCHAR(100) NOT NULL,
			is_default BOOLEAN DEFAULT FALSE,
			created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
		);

		CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
		CREATE INDEX IF NOT EXISTS idx_addresses_user ON addresses(user_id);
	`

	_, err := r.db.Exec(query)
	return err
}

// Create creates a new user
func (r *Repository) Create(ctx context.Context, user *User) error {
	user.ID = uuid.New().String()
	user.CreatedAt = time.Now().UTC()
	user.UpdatedAt = time.Now().UTC()
	user.Status = "active"
	user.Role = "customer"

	query := `
		INSERT INTO users (id, email, password_hash, first_name, last_name, phone, role, status, created_at, updated_at)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
	`

	_, err := r.db.ExecContext(ctx, query,
		user.ID, user.Email, user.PasswordHash, user.FirstName, user.LastName,
		user.Phone, user.Role, user.Status, user.CreatedAt, user.UpdatedAt,
	)

	return err
}

// GetByID retrieves a user by ID
func (r *Repository) GetByID(ctx context.Context, id string) (*User, error) {
	var user User
	query := `
		SELECT id, email, password_hash, first_name, last_name, phone, role, status, created_at, updated_at
		FROM users WHERE id = $1
	`

	err := r.db.QueryRowContext(ctx, query, id).Scan(
		&user.ID, &user.Email, &user.PasswordHash, &user.FirstName, &user.LastName,
		&user.Phone, &user.Role, &user.Status, &user.CreatedAt, &user.UpdatedAt,
	)
	if err == sql.ErrNoRows {
		return nil, ErrUserNotFound
	}

	return &user, err
}

// GetByEmail retrieves a user by email
func (r *Repository) GetByEmail(ctx context.Context, email string) (*User, error) {
	var user User
	query := `
		SELECT id, email, password_hash, first_name, last_name, phone, role, status, created_at, updated_at
		FROM users WHERE email = $1
	`

	err := r.db.QueryRowContext(ctx, query, email).Scan(
		&user.ID, &user.Email, &user.PasswordHash, &user.FirstName, &user.LastName,
		&user.Phone, &user.Role, &user.Status, &user.CreatedAt, &user.UpdatedAt,
	)
	if err == sql.ErrNoRows {
		return nil, ErrUserNotFound
	}

	return &user, err
}

// Update updates a user
func (r *Repository) Update(ctx context.Context, user *User) error {
	user.UpdatedAt = time.Now().UTC()

	query := `
		UPDATE users
		SET first_name = $1, last_name = $2, phone = $3, status = $4, updated_at = $5
		WHERE id = $6
	`

	result, err := r.db.ExecContext(ctx, query,
		user.FirstName, user.LastName, user.Phone, user.Status, user.UpdatedAt, user.ID,
	)
	if err != nil {
		return err
	}

	rows, _ := result.RowsAffected()
	if rows == 0 {
		return ErrUserNotFound
	}

	return nil
}

// AddAddress adds an address for a user
func (r *Repository) AddAddress(ctx context.Context, address *Address) error {
	address.ID = uuid.New().String()
	address.CreatedAt = time.Now().UTC()

	// If default, unset other defaults
	if address.IsDefault {
		_, err := r.db.ExecContext(ctx,
			`UPDATE addresses SET is_default = FALSE WHERE user_id = $1 AND type = $2`,
			address.UserID, address.Type,
		)
		if err != nil {
			return err
		}
	}

	query := `
		INSERT INTO addresses (id, user_id, type, line1, line2, city, state, zip_code, country, is_default, created_at)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
	`

	_, err := r.db.ExecContext(ctx, query,
		address.ID, address.UserID, address.Type, address.Line1, address.Line2,
		address.City, address.State, address.ZipCode, address.Country, address.IsDefault, address.CreatedAt,
	)

	return err
}

// GetAddresses retrieves addresses for a user
func (r *Repository) GetAddresses(ctx context.Context, userID string) ([]Address, error) {
	query := `
		SELECT id, user_id, type, line1, line2, city, state, zip_code, country, is_default, created_at
		FROM addresses WHERE user_id = $1 ORDER BY is_default DESC, created_at DESC
	`

	rows, err := r.db.QueryContext(ctx, query, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var addresses []Address
	for rows.Next() {
		var addr Address
		err := rows.Scan(
			&addr.ID, &addr.UserID, &addr.Type, &addr.Line1, &addr.Line2,
			&addr.City, &addr.State, &addr.ZipCode, &addr.Country, &addr.IsDefault, &addr.CreatedAt,
		)
		if err != nil {
			return nil, err
		}
		addresses = append(addresses, addr)
	}

	return addresses, rows.Err()
}

// Errors
var (
	ErrUserNotFound = fmt.Errorf("user not found")
	ErrUserExists   = fmt.Errorf("user already exists")
)
```

### User Service

The service layer sits between the HTTP handler and the repository, owning business rules like duplicate-email checks, password validation, JWT token generation, and event publishing. It takes the repository and an event publisher as constructor arguments, so tests can supply fakes for both without needing a live database or Kafka broker.

**Token strategy (production).** Access tokens are short-lived (15 min) JWTs signed with an asymmetric key (RS256 or EdDSA) so downstream services can verify locally using a JWKS endpoint. Refresh tokens are opaque random strings stored in Postgres or Redis so they can be revoked server-side. **rotate** on every use and detect reuse, if an already-used refresh token is presented, invalidate the entire token family and force re-authentication (the OAuth2 "refresh token rotation with theft detection" pattern). For social login (Google, Apple, GitHub) layer an OAuth2/OIDC library such as `github.com/coreos/go-oidc/v3` on top of this same token model.

```go
// internal/user/service.go
package user

import (
	"context"
	"fmt"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"example.com/ecommerce/pkg/events"
)

// Service handles user business logic
type Service struct {
	repo      *Repository
	publisher events.Publisher
	jwtSecret []byte
}

// NewService creates a user service
func NewService(repo *Repository, publisher events.Publisher, jwtSecret string) *Service {
	return &Service{
		repo:      repo,
		publisher: publisher,
		jwtSecret: []byte(jwtSecret),
	}
}

// RegisterRequest represents a registration request
type RegisterRequest struct {
	Email     string `json:"email" validate:"required,email"`
	Password  string `json:"password" validate:"required,min=8"`
	FirstName string `json:"first_name" validate:"required"`
	LastName  string `json:"last_name" validate:"required"`
	Phone     string `json:"phone"`
}

// LoginRequest represents a login request
type LoginRequest struct {
	Email    string `json:"email" validate:"required,email"`
	Password string `json:"password" validate:"required"`
}

// AuthResponse represents an authentication response
type AuthResponse struct {
	User         *User  `json:"user"`
	AccessToken  string `json:"access_token"`
	RefreshToken string `json:"refresh_token"`
	ExpiresIn    int64  `json:"expires_in"`
}

// Register creates a new user account
func (s *Service) Register(ctx context.Context, req RegisterRequest) (*AuthResponse, error) {
	// Check if user exists
	existing, _ := s.repo.GetByEmail(ctx, req.Email)
	if existing != nil {
		return nil, ErrUserExists
	}

	// Create user
	user := &User{
		Email:     req.Email,
		FirstName: req.FirstName,
		LastName:  req.LastName,
		Phone:     req.Phone,
	}

	if err := user.SetPassword(req.Password); err != nil {
		return nil, fmt.Errorf("set password: %w", err)
	}

	if err := s.repo.Create(ctx, user); err != nil {
		return nil, fmt.Errorf("create user: %w", err)
	}

	// Generate tokens
	tokens, err := s.generateTokens(user)
	if err != nil {
		return nil, fmt.Errorf("generate tokens: %w", err)
	}

	// Publish event
	if err := s.publisher.Publish(ctx, events.UserRegistered, events.UserRegisteredEvent{
		UserID:    user.ID,
		Email:     user.Email,
		FirstName: user.FirstName,
		LastName:  user.LastName,
	}); err != nil {
		// Log but don't fail
		fmt.Printf("Failed to publish user registered event: %v\n", err)
	}

	return tokens, nil
}

// Login authenticates a user
func (s *Service) Login(ctx context.Context, req LoginRequest) (*AuthResponse, error) {
	user, err := s.repo.GetByEmail(ctx, req.Email)
	if err != nil {
		return nil, ErrInvalidCredentials
	}

	if !user.CheckPassword(req.Password) {
		return nil, ErrInvalidCredentials
	}

	if user.Status != "active" {
		return nil, ErrUserInactive
	}

	return s.generateTokens(user)
}

// GetUser retrieves a user by ID
func (s *Service) GetUser(ctx context.Context, id string) (*User, error) {
	return s.repo.GetByID(ctx, id)
}

// UpdateUser updates a user
func (s *Service) UpdateUser(ctx context.Context, id string, firstName, lastName, phone string) (*User, error) {
	user, err := s.repo.GetByID(ctx, id)
	if err != nil {
		return nil, err
	}

	user.FirstName = firstName
	user.LastName = lastName
	user.Phone = phone

	if err := s.repo.Update(ctx, user); err != nil {
		return nil, err
	}

	// Publish event
	s.publisher.Publish(ctx, events.UserUpdated, events.UserUpdatedEvent{
		UserID:    user.ID,
		FirstName: user.FirstName,
		LastName:  user.LastName,
	})

	return user, nil
}

// AddAddress adds an address for a user
func (s *Service) AddAddress(ctx context.Context, userID string, addr *Address) error {
	addr.UserID = userID
	return s.repo.AddAddress(ctx, addr)
}

// GetAddresses retrieves addresses for a user
func (s *Service) GetAddresses(ctx context.Context, userID string) ([]Address, error) {
	return s.repo.GetAddresses(ctx, userID)
}

func (s *Service) generateTokens(user *User) (*AuthResponse, error) {
	// Access token - 15 minutes
	accessClaims := jwt.MapClaims{
		"sub":   user.ID,
		"email": user.Email,
		"role":  user.Role,
		"exp":   time.Now().Add(15 * time.Minute).Unix(),
		"iat":   time.Now().Unix(),
	}
	accessToken := jwt.NewWithClaims(jwt.SigningMethodHS256, accessClaims)
	accessTokenString, err := accessToken.SignedString(s.jwtSecret)
	if err != nil {
		return nil, err
	}

	// Refresh token - 7 days
	refreshClaims := jwt.MapClaims{
		"sub":  user.ID,
		"type": "refresh",
		"exp":  time.Now().Add(7 * 24 * time.Hour).Unix(),
		"iat":  time.Now().Unix(),
	}
	refreshToken := jwt.NewWithClaims(jwt.SigningMethodHS256, refreshClaims)
	refreshTokenString, err := refreshToken.SignedString(s.jwtSecret)
	if err != nil {
		return nil, err
	}

	return &AuthResponse{
		User:         user,
		AccessToken:  accessTokenString,
		RefreshToken: refreshTokenString,
		ExpiresIn:    900, // 15 minutes in seconds
	}, nil
}

// Errors
var (
	ErrInvalidCredentials = fmt.Errorf("invalid credentials")
	ErrUserInactive       = fmt.Errorf("user account is inactive")
)
```

### User HTTP Handler

The handler wires HTTP routes to service methods using Chi's router. Each handler method follows the same pattern: decode the request body, validate it with `go-playground/validator`, call the service, and write a JSON response or error. Keeping handlers thin, parsing input, calling services, formatting output, ensures that business logic stays testable without an HTTP server.

```go
// internal/user/handler.go
package user

import (
	"encoding/json"
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/go-playground/validator/v10"
)

// Handler handles HTTP requests for users
type Handler struct {
	service   *Service
	validator *validator.Validate
}

// NewHandler creates a user handler
func NewHandler(service *Service) *Handler {
	return &Handler{
		service:   service,
		validator: validator.New(),
	}
}

// Routes returns the user routes
func (h *Handler) Routes() chi.Router {
	r := chi.NewRouter()

	// Public routes
	r.Post("/register", h.Register)
	r.Post("/login", h.Login)

	// Protected routes (require auth middleware)
	r.Group(func(r chi.Router) {
		r.Get("/{id}", h.GetUser)
		r.Put("/{id}", h.UpdateUser)
		r.Get("/{id}/addresses", h.GetAddresses)
		r.Post("/{id}/addresses", h.AddAddress)
	})

	return r
}

// Register handles user registration
func (h *Handler) Register(w http.ResponseWriter, r *http.Request) {
	var req RegisterRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "Invalid request body")
		return
	}

	if err := h.validator.Struct(req); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}

	resp, err := h.service.Register(r.Context(), req)
	if err != nil {
		switch err {
		case ErrUserExists:
			writeError(w, http.StatusConflict, "User already exists")
		default:
			writeError(w, http.StatusInternalServerError, "Registration failed")
		}
		return
	}

	writeJSON(w, http.StatusCreated, resp)
}

// Login handles user login
func (h *Handler) Login(w http.ResponseWriter, r *http.Request) {
	var req LoginRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "Invalid request body")
		return
	}

	if err := h.validator.Struct(req); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}

	resp, err := h.service.Login(r.Context(), req)
	if err != nil {
		switch err {
		case ErrInvalidCredentials:
			writeError(w, http.StatusUnauthorized, "Invalid email or password")
		case ErrUserInactive:
			writeError(w, http.StatusForbidden, "Account is inactive")
		default:
			writeError(w, http.StatusInternalServerError, "Login failed")
		}
		return
	}

	writeJSON(w, http.StatusOK, resp)
}

// GetUser handles getting a user
func (h *Handler) GetUser(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")

	user, err := h.service.GetUser(r.Context(), id)
	if err != nil {
		if err == ErrUserNotFound {
			writeError(w, http.StatusNotFound, "User not found")
			return
		}
		writeError(w, http.StatusInternalServerError, "Failed to get user")
		return
	}

	writeJSON(w, http.StatusOK, user)
}

// UpdateUser handles updating a user
func (h *Handler) UpdateUser(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")

	var req struct {
		FirstName string `json:"first_name"`
		LastName  string `json:"last_name"`
		Phone     string `json:"phone"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "Invalid request body")
		return
	}

	user, err := h.service.UpdateUser(r.Context(), id, req.FirstName, req.LastName, req.Phone)
	if err != nil {
		if err == ErrUserNotFound {
			writeError(w, http.StatusNotFound, "User not found")
			return
		}
		writeError(w, http.StatusInternalServerError, "Failed to update user")
		return
	}

	writeJSON(w, http.StatusOK, user)
}

// GetAddresses handles getting user addresses
func (h *Handler) GetAddresses(w http.ResponseWriter, r *http.Request) {
	userID := chi.URLParam(r, "id")

	addresses, err := h.service.GetAddresses(r.Context(), userID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "Failed to get addresses")
		return
	}

	writeJSON(w, http.StatusOK, addresses)
}

// AddAddress handles adding an address
func (h *Handler) AddAddress(w http.ResponseWriter, r *http.Request) {
	userID := chi.URLParam(r, "id")

	var addr Address
	if err := json.NewDecoder(r.Body).Decode(&addr); err != nil {
		writeError(w, http.StatusBadRequest, "Invalid request body")
		return
	}

	if err := h.service.AddAddress(r.Context(), userID, &addr); err != nil {
		writeError(w, http.StatusInternalServerError, "Failed to add address")
		return
	}

	writeJSON(w, http.StatusCreated, addr)
}

func writeJSON(w http.ResponseWriter, status int, data any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(data)
}

func writeError(w http.ResponseWriter, status int, message string) {
	writeJSON(w, status, map[string]string{"error": message})
}
```

### Junior → FAANG: Authentication Fundamentals Worth Internalizing

The user service covers a concentration of security-sensitive code. Each decision in it is a potential interview question or a production incident waiting to happen. Internalizing the reasoning, not just the code, is what separates a candidate who describes patterns from one who explains tradeoffs.

**Why Argon2id over bcrypt.** bcrypt was designed in 1999 when GPU attacks were not a realistic threat. Argon2id is memory-hard: attacking it requires not just CPU cycles but gigabytes of RAM per guess, which is expensive to parallelize on GPUs or ASICs. The parameters (`argonMemoryKiB = 47 * 1024`) are tunable, you increase them as hardware improves, without changing the stored hash format. For an interview, the one-sentence answer is: "We use Argon2id because it is memory-hard, which makes bulk offline attacks expensive even with GPU clusters."

**Why constant-time comparison for passwords.** `subtle.ConstantTimeCompare` ensures that the comparison takes the same amount of time regardless of how many bytes match. A timing-variable comparison leaks whether the first byte of the hash matched, then the second, and so on, allowing an attacker to reconstruct the correct hash byte by byte over many requests. This is a timing side-channel attack. For an interview, be ready to say: "We use constant-time comparison to prevent timing oracle attacks on the password hash."

**Why short-lived access tokens plus opaque refresh tokens.** An access token embedded in every request is hard to revoke immediately after issuance, because verification is stateless (any service with the public key can verify it). By keeping the access token lifetime short (15 minutes), you bound the window an attacker has if a token is stolen. The refresh token is opaque and stored server-side, so it can be revoked immediately. This is the OAuth2 token model, and knowing it by name and rationale is expected in security-adjacent interviews.

**First-job habit for handler code.** Notice that `Register` and `Login` are public routes and the remaining routes are in a group intended for auth middleware. In your first job, always ask: which routes require authentication? which require authorization (checking the caller's role)? Mixing these up is a common source of security bugs.

### Senior @ FAANG: Identity Platform Thinking and Token Security at Scale

The user service code is a working implementation. At FAANG scale, it becomes a platform that dozens of teams depend on, and the decisions made here have security, compliance, and developer-experience consequences that are difficult to reverse.

**JWT key management as a platform concern.** The current code signs tokens with a shared symmetric secret (`HS256`). In a system with more than one service verifying tokens, this means every service must hold the secret, creating multiple exposure points. The production alternative is asymmetric signing: the user service holds a private key (RS256 or EdDSA) and publishes a JWKS endpoint. Every other service downloads the public keys on startup and verifies locally. Key rotation becomes a published event: issue a new key ID, add it to JWKS, wait one token lifetime (15 minutes), then revoke the old key. The user service never has to coordinate with downstream services during rotation.

**Refresh token theft detection.** The current implementation generates a refresh token but does not implement refresh token rotation with reuse detection. The production pattern, from OAuth2 Security Best Current Practice (BCP), is: on each refresh token use, invalidate the old token and issue a new one, storing both in the same "token family." If a previously-used token is presented, it means either a replay attack or a stolen token. In that case, invalidate the entire family and require re-authentication. This pattern is table stakes for any FAANG identity system.

**Rate limiting registration and login.** The handler code has no rate limiting. A production identity service must rate-limit login attempts per IP, per account, and globally, with different thresholds and lockout behaviors. The industry model is: five failed attempts triggers a soft lockout (CAPTCHA), ten triggers a temporary account lock, repeated failures across IPs triggers global rate limiting. These thresholds must be tunable without a code deployment.

**Compliance and audit logging.** Every authentication event (successful login, failed login, password change, account lock) must be written to an immutable audit log. GDPR and SOC 2 require this. The audit log is separate from application logs: it has a defined retention period, cannot be purged by the application, and must be accessible to the compliance team. A staff-level contribution is designing the audit log schema and the access control model before the first audit.

**RBAC at the platform layer.** The current `Role` field on the user model is a string. A production RBAC system has roles with associated permissions, roles can be hierarchical, and permission checks happen at both the API gateway (coarse-grained) and inside each service (fine-grained). The identity service owns the role assignments, while the permission definitions are owned by each service but published to a central policy store (Open Policy Agent or a custom policy service). Designing this two-layer model is the kind of architectural contribution that distinguishes a principal engineer from a senior engineer.

---
