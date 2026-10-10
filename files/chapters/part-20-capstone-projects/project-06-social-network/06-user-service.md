## User Service

The User Service is responsible for everything related to user accounts: registration, authentication, profile management, and search. It follows the repository pattern, where the service layer contains business logic and delegates all database access to a repository interface. This separation makes the code easier to test because you can swap in a mock repository during unit tests. The domain model uses pointer types for optional fields so that Go can distinguish between a field that was not provided and one that was set to its zero value.

### Domain Model
The user domain model defines the core `User` struct with profile fields, authentication state, and privacy settings. Optional fields use pointers to distinguish between "not set" and "set to zero value." ```go
// internal/domain/user.go
package domain

import (
    "time"
    "github.com/google/uuid"
)

type User struct {
    ID            uuid.UUID  `json:"id" db:"id"`
    Username      string     `json:"username" db:"username"`
    Email         string     `json:"email" db:"email"`
    PasswordHash  string     `json:"-" db:"password_hash"`
    DisplayName   string     `json:"display_name" db:"display_name"`
    Bio           *string    `json:"bio" db:"bio"`
    AvatarURL     *string    `json:"avatar_url" db:"avatar_url"`
    CoverURL      *string    `json:"cover_url" db:"cover_url"`
    Location      *string    `json:"location" db:"location"`
    Website       *string    `json:"website" db:"website"`
    BirthDate     *time.Time `json:"birth_date" db:"birth_date"`
    IsVerified    bool       `json:"is_verified" db:"is_verified"`
    IsPrivate     bool       `json:"is_private" db:"is_private"`
    FollowerCount int        `json:"follower_count" db:"follower_count"`
    FollowingCount int       `json:"following_count" db:"following_count"`
    PostCount     int        `json:"post_count" db:"post_count"`
    CreatedAt     time.Time  `json:"created_at" db:"created_at"`
    UpdatedAt     time.Time  `json:"updated_at" db:"updated_at"`
    LastSeenAt    *time.Time `json:"last_seen_at" db:"last_seen_at"`
    DeletedAt     *time.Time `json:"deleted_at" db:"deleted_at"`
}

// Public returns a public-safe user representation
func (u *User) Public() *PublicUser {
    return &PublicUser{
        ID:             u.ID,
        Username:       u.Username,
        DisplayName:    u.DisplayName,
        Bio:            u.Bio,
        AvatarURL:      u.AvatarURL,
        CoverURL:       u.CoverURL,
        Location:       u.Location,
        Website:        u.Website,
        IsVerified:     u.IsVerified,
        IsPrivate:      u.IsPrivate,
        FollowerCount:  u.FollowerCount,
        FollowingCount: u.FollowingCount,
        PostCount:      u.PostCount,
        CreatedAt:      u.CreatedAt,
    }
}

type PublicUser struct {
    ID             uuid.UUID  `json:"id"`
    Username       string     `json:"username"`
    DisplayName    string     `json:"display_name"`
    Bio            *string    `json:"bio"`
    AvatarURL      *string    `json:"avatar_url"`
    CoverURL       *string    `json:"cover_url"`
    Location       *string    `json:"location"`
    Website        *string    `json:"website"`
    IsVerified     bool       `json:"is_verified"`
    IsPrivate      bool       `json:"is_private"`
    FollowerCount  int        `json:"follower_count"`
    FollowingCount int        `json:"following_count"`
    PostCount      int        `json:"post_count"`
    CreatedAt      time.Time  `json:"created_at"`
}

type UserSettings struct {
    UserID              uuid.UUID `json:"user_id" db:"user_id"`
    PrivacyLevel        string    `json:"privacy_level" db:"privacy_level"`
    AllowMentions       bool      `json:"allow_mentions" db:"allow_mentions"`
    AllowDMs            bool      `json:"allow_dms" db:"allow_dms"`
    ShowActivity        bool      `json:"show_activity" db:"show_activity"`
    EmailNotifications  bool      `json:"email_notifications" db:"email_notifications"`
    PushNotifications   bool      `json:"push_notifications" db:"push_notifications"`
    Language            string    `json:"language" db:"language"`
    Timezone            string    `json:"timezone" db:"timezone"`
    Theme               string    `json:"theme" db:"theme"`
    CreatedAt           time.Time `json:"created_at" db:"created_at"`
    UpdatedAt           time.Time `json:"updated_at" db:"updated_at"`
}

type CreateUserRequest struct {
    Username    string    `json:"username" validate:"required,min=3,max=30,alphanum"`
    Email       string    `json:"email" validate:"required,email"`
    Password    string    `json:"password" validate:"required,min=8"`
    DisplayName string    `json:"display_name" validate:"required,min=1,max=100"`
    BirthDate   time.Time `json:"birth_date" validate:"required"`
}

type UpdateUserRequest struct {
    DisplayName *string `json:"display_name" validate:"omitempty,min=1,max=100"`
    Bio         *string `json:"bio" validate:"omitempty,max=500"`
    Location    *string `json:"location" validate:"omitempty,max=100"`
    Website     *string `json:"website" validate:"omitempty,url"`
}

type LoginRequest struct {
    Email    string `json:"email" validate:"required,email"`
    Password string `json:"password" validate:"required"`
}

type LoginResponse struct {
    User  *PublicUser `json:"user"`
    Token string      `json:"token"`
}
```

### Repository Interface

The repository interface defines the contract for all database operations on users. By coding against this interface rather than a concrete implementation, the service layer remains decoupled from the database. This means you can swap PostgreSQL for another database or use a mock implementation in tests without changing any service code.

```

```go
// internal/domain/repository/user.go
package repository

import (
    "context"
    "github.com/google/uuid"
    "github.com/yourname/socialnet/internal/domain"
)

type UserRepository interface {
    // Create operations
    Create(ctx context.Context, user *domain.User) error
    CreateSettings(ctx context.Context, settings *domain.UserSettings) error

    // Read operations
    GetByID(ctx context.Context, id uuid.UUID) (*domain.User, error)
    GetByUsername(ctx context.Context, username string) (*domain.User, error)
    GetByEmail(ctx context.Context, email string) (*domain.User, error)
    GetByIDs(ctx context.Context, ids []uuid.UUID) ([]*domain.User, error)
    GetSettings(ctx context.Context, userID uuid.UUID) (*domain.UserSettings, error)

    // Update operations
    Update(ctx context.Context, user *domain.User) error
    UpdateSettings(ctx context.Context, settings *domain.UserSettings) error
    UpdateLastSeen(ctx context.Context, userID uuid.UUID) error
    IncrementFollowerCount(ctx context.Context, userID uuid.UUID, delta int) error
    IncrementFollowingCount(ctx context.Context, userID uuid.UUID, delta int) error
    IncrementPostCount(ctx context.Context, userID uuid.UUID, delta int) error

    // Delete operations
    Delete(ctx context.Context, id uuid.UUID) error

    // Search operations
    Search(ctx context.Context, query string, limit, offset int) ([]*domain.User, error)

    // Utility
    UsernameExists(ctx context.Context, username string) (bool, error)
    EmailExists(ctx context.Context, email string) (bool, error)
}
```

### PostgreSQL Repository Implementation

This is the concrete implementation of the UserRepository interface using PostgreSQL and the sqlx library. Each method translates a business operation into a parameterized SQL query, which prevents SQL injection attacks. Soft deletes are used throughout: instead of removing rows, we set a `deleted_at` timestamp, which allows data recovery and keeps referential integrity intact.

```go
// internal/repository/postgres/user.go
package postgres

import (
    "context"
    "database/sql"
    "errors"
    "fmt"

    "github.com/google/uuid"
    "github.com/jmoiron/sqlx"
    "github.com/yourname/socialnet/internal/domain"
    "github.com/yourname/socialnet/internal/domain/repository"
)

type userRepository struct {
    db *sqlx.DB
}

func NewUserRepository(db *sqlx.DB) repository.UserRepository {
    return &userRepository{db: db}
}

func (r *userRepository) Create(ctx context.Context, user *domain.User) error {
    query := `
        INSERT INTO users (
            id, username, email, password_hash, display_name,
            bio, birth_date, is_private
        ) VALUES (
            $1, $2, $3, $4, $5, $6, $7, $8
        ) RETURNING created_at, updated_at
    `

    return r.db.QueryRowContext(
        ctx, query,
        user.ID, user.Username, user.Email, user.PasswordHash,
        user.DisplayName, user.Bio, user.BirthDate, user.IsPrivate,
    ).Scan(&user.CreatedAt, &user.UpdatedAt)
}

func (r *userRepository) CreateSettings(ctx context.Context, settings *domain.UserSettings) error {
    query := `
        INSERT INTO user_settings (
            user_id, privacy_level, allow_mentions, allow_dms,
            show_activity, email_notifications, push_notifications,
            language, timezone, theme
        ) VALUES (
            $1, $2, $3, $4, $5, $6, $7, $8, $9, $10
        ) RETURNING created_at, updated_at
    `

    return r.db.QueryRowContext(
        ctx, query,
        settings.UserID, settings.PrivacyLevel, settings.AllowMentions,
        settings.AllowDMs, settings.ShowActivity, settings.EmailNotifications,
        settings.PushNotifications, settings.Language, settings.Timezone,
        settings.Theme,
    ).Scan(&settings.CreatedAt, &settings.UpdatedAt)
}

func (r *userRepository) GetByID(ctx context.Context, id uuid.UUID) (*domain.User, error) {
    var user domain.User
    query := `
        SELECT id, username, email, password_hash, display_name,
               bio, avatar_url, cover_url, location, website, birth_date,
               is_verified, is_private, follower_count, following_count,
               post_count, created_at, updated_at, last_seen_at, deleted_at
        FROM users
        WHERE id = $1 AND deleted_at IS NULL
    `

    err := r.db.GetContext(ctx, &user, query, id)
    if err != nil {
        if errors.Is(err, sql.ErrNoRows) {
            return nil, domain.ErrUserNotFound
        }
        return nil, fmt.Errorf("get user by id: %w", err)
    }

    return &user, nil
}

func (r *userRepository) GetByUsername(ctx context.Context, username string) (*domain.User, error) {
    var user domain.User
    query := `
        SELECT id, username, email, password_hash, display_name,
               bio, avatar_url, cover_url, location, website, birth_date,
               is_verified, is_private, follower_count, following_count,
               post_count, created_at, updated_at, last_seen_at, deleted_at
        FROM users
        WHERE username = $1 AND deleted_at IS NULL
    `

    err := r.db.GetContext(ctx, &user, query, username)
    if err != nil {
        if errors.Is(err, sql.ErrNoRows) {
            return nil, domain.ErrUserNotFound
        }
        return nil, fmt.Errorf("get user by username: %w", err)
    }

    return &user, nil
}

func (r *userRepository) GetByEmail(ctx context.Context, email string) (*domain.User, error) {
    var user domain.User
    query := `
        SELECT id, username, email, password_hash, display_name,
               bio, avatar_url, cover_url, location, website, birth_date,
               is_verified, is_private, follower_count, following_count,
               post_count, created_at, updated_at, last_seen_at, deleted_at
        FROM users
        WHERE email = $1 AND deleted_at IS NULL
    `

    err := r.db.GetContext(ctx, &user, query, email)
    if err != nil {
        if errors.Is(err, sql.ErrNoRows) {
            return nil, domain.ErrUserNotFound
        }
        return nil, fmt.Errorf("get user by email: %w", err)
    }

    return &user, nil
}

func (r *userRepository) GetByIDs(ctx context.Context, ids []uuid.UUID) ([]*domain.User, error) {
    if len(ids) == 0 {
        return []*domain.User{}, nil
    }

    query := `
        SELECT id, username, email, password_hash, display_name,
               bio, avatar_url, cover_url, location, website, birth_date,
               is_verified, is_private, follower_count, following_count,
               post_count, created_at, updated_at, last_seen_at, deleted_at
        FROM users
        WHERE id = ANY($1) AND deleted_at IS NULL
    `

    var users []*domain.User
    err := r.db.SelectContext(ctx, &users, query, ids)
    if err != nil {
        return nil, fmt.Errorf("get users by ids: %w", err)
    }

    return users, nil
}

func (r *userRepository) GetSettings(ctx context.Context, userID uuid.UUID) (*domain.UserSettings, error) {
    var settings domain.UserSettings
    query := `
        SELECT user_id, privacy_level, allow_mentions, allow_dms,
               show_activity, email_notifications, push_notifications,
               language, timezone, theme, created_at, updated_at
        FROM user_settings
        WHERE user_id = $1
    `

    err := r.db.GetContext(ctx, &settings, query, userID)
    if err != nil {
        if errors.Is(err, sql.ErrNoRows) {
            return nil, domain.ErrSettingsNotFound
        }
        return nil, fmt.Errorf("get user settings: %w", err)
    }

    return &settings, nil
}

func (r *userRepository) Update(ctx context.Context, user *domain.User) error {
    query := `
        UPDATE users
        SET display_name = $1, bio = $2, location = $3, website = $4,
            avatar_url = $5, cover_url = $6, is_private = $7
        WHERE id = $8 AND deleted_at IS NULL
    `

    result, err := r.db.ExecContext(
        ctx, query,
        user.DisplayName, user.Bio, user.Location, user.Website,
        user.AvatarURL, user.CoverURL, user.IsPrivate, user.ID,
    )
    if err != nil {
        return fmt.Errorf("update user: %w", err)
    }

    rows, err := result.RowsAffected()
    if err != nil {
        return fmt.Errorf("get rows affected: %w", err)
    }

    if rows == 0 {
        return domain.ErrUserNotFound
    }

    return nil
}

func (r *userRepository) UpdateSettings(ctx context.Context, settings *domain.UserSettings) error {
    query := `
        UPDATE user_settings
        SET privacy_level = $1, allow_mentions = $2, allow_dms = $3,
            show_activity = $4, email_notifications = $5, push_notifications = $6,
            language = $7, timezone = $8, theme = $9
        WHERE user_id = $10
    `

    result, err := r.db.ExecContext(
        ctx, query,
        settings.PrivacyLevel, settings.AllowMentions, settings.AllowDMs,
        settings.ShowActivity, settings.EmailNotifications, settings.PushNotifications,
        settings.Language, settings.Timezone, settings.Theme, settings.UserID,
    )
    if err != nil {
        return fmt.Errorf("update user settings: %w", err)
    }

    rows, err := result.RowsAffected()
    if err != nil {
        return fmt.Errorf("get rows affected: %w", err)
    }

    if rows == 0 {
        return domain.ErrSettingsNotFound
    }

    return nil
}

func (r *userRepository) UpdateLastSeen(ctx context.Context, userID uuid.UUID) error {
    query := `UPDATE users SET last_seen_at = NOW() WHERE id = $1`
    _, err := r.db.ExecContext(ctx, query, userID)
    return err
}

func (r *userRepository) IncrementFollowerCount(ctx context.Context, userID uuid.UUID, delta int) error {
    query := `SELECT increment_user_followers($1, $2)`
    _, err := r.db.ExecContext(ctx, query, userID, delta)
    return err
}

func (r *userRepository) IncrementFollowingCount(ctx context.Context, userID uuid.UUID, delta int) error {
    query := `SELECT increment_user_following($1, $2)`
    _, err := r.db.ExecContext(ctx, query, userID, delta)
    return err
}

func (r *userRepository) IncrementPostCount(ctx context.Context, userID uuid.UUID, delta int) error {
    query := `UPDATE users SET post_count = post_count + $1 WHERE id = $2`
    _, err := r.db.ExecContext(ctx, query, delta, userID)
    return err
}

func (r *userRepository) Delete(ctx context.Context, id uuid.UUID) error {
    query := `UPDATE users SET deleted_at = NOW() WHERE id = $1 AND deleted_at IS NULL`

    result, err := r.db.ExecContext(ctx, query, id)
    if err != nil {
        return fmt.Errorf("delete user: %w", err)
    }

    rows, err := result.RowsAffected()
    if err != nil {
        return fmt.Errorf("get rows affected: %w", err)
    }

    if rows == 0 {
        return domain.ErrUserNotFound
    }

    return nil
}

func (r *userRepository) Search(ctx context.Context, query string, limit, offset int) ([]*domain.User, error) {
    sqlQuery := `
        SELECT id, username, display_name, bio, avatar_url,
               is_verified, is_private, follower_count, following_count,
               post_count, created_at
        FROM users
        WHERE deleted_at IS NULL
          AND (username ILIKE $1 OR display_name ILIKE $1)
        ORDER BY follower_count DESC, created_at DESC
        LIMIT $2 OFFSET $3
    `

    var users []*domain.User
    searchPattern := "%" + query + "%"
    err := r.db.SelectContext(ctx, &users, sqlQuery, searchPattern, limit, offset)
    if err != nil {
        return nil, fmt.Errorf("search users: %w", err)
    }

    return users, nil
}

func (r *userRepository) UsernameExists(ctx context.Context, username string) (bool, error) {
    var exists bool
    query := `SELECT EXISTS(SELECT 1 FROM users WHERE username = $1 AND deleted_at IS NULL)`
    err := r.db.GetContext(ctx, &exists, query, username)
    return exists, err
}

func (r *userRepository) EmailExists(ctx context.Context, email string) (bool, error) {
    var exists bool
    query := `SELECT EXISTS(SELECT 1 FROM users WHERE email = $1 AND deleted_at IS NULL)`
    err := r.db.GetContext(ctx, &exists, query, email)
    return exists, err
}
```

### User Service Implementation

The User Service contains all business logic for user operations. It validates uniqueness constraints before creating users, hashes passwords with bcrypt for secure storage, and fires background goroutines for non-critical tasks like updating the last-seen timestamp. This keeps the main request path fast while ensuring secondary operations still happen.

```go
// internal/service/user.go
package service

import (
    "context"
    "errors"
    "fmt"
    "time"

    "github.com/google/uuid"
    "golang.org/x/crypto/bcrypt"
    "github.com/yourname/socialnet/internal/domain"
    "github.com/yourname/socialnet/internal/domain/repository"
    "go.uber.org/zap"
)

var (
    ErrInvalidCredentials = errors.New("invalid credentials")
    ErrUsernameExists     = errors.New("username already exists")
    ErrEmailExists        = errors.New("email already exists")
)

type UserService struct {
    userRepo repository.UserRepository
    logger   *zap.Logger
}

func NewUserService(userRepo repository.UserRepository, logger *zap.Logger) *UserService {
    return &UserService{
        userRepo: userRepo,
        logger:   logger,
    }
}

func (s *UserService) CreateUser(ctx context.Context, req *domain.CreateUserRequest) (*domain.User, error) {
    // Check if username exists
    exists, err := s.userRepo.UsernameExists(ctx, req.Username)
    if err != nil {
        return nil, fmt.Errorf("check username: %w", err)
    }
    if exists {
        return nil, ErrUsernameExists
    }

    // Check if email exists
    exists, err = s.userRepo.EmailExists(ctx, req.Email)
    if err != nil {
        return nil, fmt.Errorf("check email: %w", err)
    }
    if exists {
        return nil, ErrEmailExists
    }

    // Hash password
    passwordHash, err := bcrypt.GenerateFromPassword([]byte(req.Password), bcrypt.DefaultCost)
    if err != nil {
        return nil, fmt.Errorf("hash password: %w", err)
    }

    // Create user
    user := &domain.User{
        ID:           uuid.New(),
        Username:     req.Username,
        Email:        req.Email,
        PasswordHash: string(passwordHash),
        DisplayName:  req.DisplayName,
        BirthDate:    &req.BirthDate,
        IsPrivate:    false,
    }

    if err := s.userRepo.Create(ctx, user); err != nil {
        return nil, fmt.Errorf("create user: %w", err)
    }

    // Create default settings
    settings := &domain.UserSettings{
        UserID:             user.ID,
        PrivacyLevel:       "public",
        AllowMentions:      true,
        AllowDMs:           true,
        ShowActivity:       true,
        EmailNotifications: true,
        PushNotifications:  true,
        Language:           "en",
        Timezone:           "UTC",
        Theme:              "light",
    }

    if err := s.userRepo.CreateSettings(ctx, settings); err != nil {
        s.logger.Error("failed to create user settings",
            zap.String("user_id", user.ID.String()),
            zap.Error(err),
        )
        // Not critical, continue
    }

    s.logger.Info("user created",
        zap.String("user_id", user.ID.String()),
        zap.String("username", user.Username),
    )

    return user, nil
}

func (s *UserService) Login(ctx context.Context, req *domain.LoginRequest) (*domain.User, error) {
    user, err := s.userRepo.GetByEmail(ctx, req.Email)
    if err != nil {
        if errors.Is(err, domain.ErrUserNotFound) {
            return nil, ErrInvalidCredentials
        }
        return nil, fmt.Errorf("get user: %w", err)
    }

    // Compare password
    if err := bcrypt.CompareHashAndPassword([]byte(user.PasswordHash), []byte(req.Password)); err != nil {
        return nil, ErrInvalidCredentials
    }

    // Update last seen
    go func() {
        ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
        defer cancel()
        _ = s.userRepo.UpdateLastSeen(ctx, user.ID)
    }()

    s.logger.Info("user logged in",
        zap.String("user_id", user.ID.String()),
        zap.String("username", user.Username),
    )

    return user, nil
}

func (s *UserService) GetUser(ctx context.Context, userID uuid.UUID) (*domain.User, error) {
    return s.userRepo.GetByID(ctx, userID)
}

func (s *UserService) GetUserByUsername(ctx context.Context, username string) (*domain.User, error) {
    return s.userRepo.GetByUsername(ctx, username)
}

func (s *UserService) UpdateUser(ctx context.Context, userID uuid.UUID, req *domain.UpdateUserRequest) (*domain.User, error) {
    user, err := s.userRepo.GetByID(ctx, userID)
    if err != nil {
        return nil, err
    }

    // Update fields if provided
    if req.DisplayName != nil {
        user.DisplayName = *req.DisplayName
    }
    if req.Bio != nil {
        user.Bio = req.Bio
    }
    if req.Location != nil {
        user.Location = req.Location
    }
    if req.Website != nil {
        user.Website = req.Website
    }

    if err := s.userRepo.Update(ctx, user); err != nil {
        return nil, fmt.Errorf("update user: %w", err)
    }

    s.logger.Info("user updated",
        zap.String("user_id", userID.String()),
    )

    return user, nil
}

func (s *UserService) SearchUsers(ctx context.Context, query string, limit, offset int) ([]*domain.User, error) {
    if limit <= 0 || limit > 50 {
        limit = 20
    }

    return s.userRepo.Search(ctx, query, limit, offset)
}

func (s *UserService) DeleteUser(ctx context.Context, userID uuid.UUID) error {
    if err := s.userRepo.Delete(ctx, userID); err != nil {
        return fmt.Errorf("delete user: %w", err)
    }

    s.logger.Info("user deleted",
        zap.String("user_id", userID.String()),
    )

    return nil
}
```

### HTTP Handlers

HTTP handlers are the thin layer between incoming HTTP requests and the service layer. Each handler parses the request body, validates the input using the validator library, calls the appropriate service method, and returns a JSON response. Handlers should contain no business logic themselves. Their only job is to translate between HTTP and Go function calls. Error handling maps domain errors to appropriate HTTP status codes like 404 for not found and 409 for conflicts.

```go
// internal/http/handler/user.go
package handler

import (
    "encoding/json"
    "net/http"
    "time"

    "github.com/go-chi/chi/v5"
    "github.com/go-chi/jwtauth/v5"
    "github.com/go-playground/validator/v10"
    "github.com/google/uuid"
    "github.com/yourname/socialnet/internal/domain"
    "github.com/yourname/socialnet/internal/service"
    "go.uber.org/zap"
)

type UserHandler struct {
    userService *service.UserService
    validator   *validator.Validate
    tokenAuth   *jwtauth.JWTAuth
    logger      *zap.Logger
}

func NewUserHandler(
    userService *service.UserService,
    validator *validator.Validate,
    tokenAuth *jwtauth.JWTAuth,
    logger *zap.Logger,
) *UserHandler {
    return &UserHandler{
        userService: userService,
        validator:   validator,
        tokenAuth:   tokenAuth,
        logger:      logger,
    }
}

func (h *UserHandler) Register(w http.ResponseWriter, r *http.Request) {
    var req domain.CreateUserRequest
    if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
        respondError(w, http.StatusBadRequest, "invalid request body")
        return
    }

    if err := h.validator.Struct(req); err != nil {
        respondError(w, http.StatusBadRequest, err.Error())
        return
    }

    user, err := h.userService.CreateUser(r.Context(), &req)
    if err != nil {
        switch err {
        case service.ErrUsernameExists:
            respondError(w, http.StatusConflict, "username already exists")
        case service.ErrEmailExists:
            respondError(w, http.StatusConflict, "email already exists")
        default:
            h.logger.Error("failed to create user", zap.Error(err))
            respondError(w, http.StatusInternalServerError, "internal server error")
        }
        return
    }

    // Generate JWT token
    token, err := h.generateToken(user)
    if err != nil {
        h.logger.Error("failed to generate token", zap.Error(err))
        respondError(w, http.StatusInternalServerError, "internal server error")
        return
    }

    respondJSON(w, http.StatusCreated, domain.LoginResponse{
        User:  user.Public(),
        Token: token,
    })
}

func (h *UserHandler) Login(w http.ResponseWriter, r *http.Request) {
    var req domain.LoginRequest
    if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
        respondError(w, http.StatusBadRequest, "invalid request body")
        return
    }

    if err := h.validator.Struct(req); err != nil {
        respondError(w, http.StatusBadRequest, err.Error())
        return
    }

    user, err := h.userService.Login(r.Context(), &req)
    if err != nil {
        if err == service.ErrInvalidCredentials {
            respondError(w, http.StatusUnauthorized, "invalid credentials")
            return
        }
        h.logger.Error("failed to login", zap.Error(err))
        respondError(w, http.StatusInternalServerError, "internal server error")
        return
    }

    // Generate JWT token
    token, err := h.generateToken(user)
    if err != nil {
        h.logger.Error("failed to generate token", zap.Error(err))
        respondError(w, http.StatusInternalServerError, "internal server error")
        return
    }

    respondJSON(w, http.StatusOK, domain.LoginResponse{
        User:  user.Public(),
        Token: token,
    })
}

func (h *UserHandler) GetCurrentUser(w http.ResponseWriter, r *http.Request) {
    userID := getUserIDFromContext(r.Context())

    user, err := h.userService.GetUser(r.Context(), userID)
    if err != nil {
        if err == domain.ErrUserNotFound {
            respondError(w, http.StatusNotFound, "user not found")
            return
        }
        h.logger.Error("failed to get user", zap.Error(err))
        respondError(w, http.StatusInternalServerError, "internal server error")
        return
    }

    respondJSON(w, http.StatusOK, user.Public())
}

func (h *UserHandler) GetUserByUsername(w http.ResponseWriter, r *http.Request) {
    username := chi.URLParam(r, "username")

    user, err := h.userService.GetUserByUsername(r.Context(), username)
    if err != nil {
        if err == domain.ErrUserNotFound {
            respondError(w, http.StatusNotFound, "user not found")
            return
        }
        h.logger.Error("failed to get user", zap.Error(err))
        respondError(w, http.StatusInternalServerError, "internal server error")
        return
    }

    respondJSON(w, http.StatusOK, user.Public())
}

func (h *UserHandler) UpdateUser(w http.ResponseWriter, r *http.Request) {
    userID := getUserIDFromContext(r.Context())

    var req domain.UpdateUserRequest
    if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
        respondError(w, http.StatusBadRequest, "invalid request body")
        return
    }

    if err := h.validator.Struct(req); err != nil {
        respondError(w, http.StatusBadRequest, err.Error())
        return
    }

    user, err := h.userService.UpdateUser(r.Context(), userID, &req)
    if err != nil {
        h.logger.Error("failed to update user", zap.Error(err))
        respondError(w, http.StatusInternalServerError, "internal server error")
        return
    }

    respondJSON(w, http.StatusOK, user.Public())
}

func (h *UserHandler) SearchUsers(w http.ResponseWriter, r *http.Request) {
    query := r.URL.Query().Get("q")
    if query == "" {
        respondError(w, http.StatusBadRequest, "query parameter 'q' is required")
        return
    }

    limit := parseIntQuery(r, "limit", 20)
    offset := parseIntQuery(r, "offset", 0)

    users, err := h.userService.SearchUsers(r.Context(), query, limit, offset)
    if err != nil {
        h.logger.Error("failed to search users", zap.Error(err))
        respondError(w, http.StatusInternalServerError, "internal server error")
        return
    }

    // Convert to public users
    publicUsers := make([]*domain.PublicUser, len(users))
    for i, user := range users {
        publicUsers[i] = user.Public()
    }

    respondJSON(w, http.StatusOK, map[string]any{
        "users":  publicUsers,
        "limit":  limit,
        "offset": offset,
    })
}

func (h *UserHandler) generateToken(user *domain.User) (string, error) {
    claims := map[string]any{
        "user_id":  user.ID.String(),
        "username": user.Username,
        "exp":      time.Now().Add(24 * time.Hour).Unix(),
    }

    _, tokenString, err := h.tokenAuth.Encode(claims)
    return tokenString, err
}

// Helper functions
func respondJSON(w http.ResponseWriter, status int, data any) {
    w.Header().Set("Content-Type", "application/json")
    w.WriteHeader(status)
    json.NewEncoder(w).Encode(data)
}

func respondError(w http.ResponseWriter, status int, message string) {
    respondJSON(w, status, map[string]string{"error": message})
}

func getUserIDFromContext(ctx context.Context) uuid.UUID {
    _, claims, _ := jwtauth.FromContext(ctx)
    userIDStr := claims["user_id"].(string)
    userID, _ := uuid.Parse(userIDStr)
    return userID
}

func parseIntQuery(r *http.Request, key string, defaultValue int) int {
    value := r.URL.Query().Get(key)
    if value == "" {
        return defaultValue
    }

    var result int
    if _, err := fmt.Sscanf(value, "%d", &result); err != nil {
        return defaultValue
    }

    return result
}
```

### Junior → FAANG: User Service as the Trust Boundary

The User Service is the trust anchor for the entire social network. Every other service depends on it to validate that a user exists and has the right to perform an action. This makes the User Service the highest-priority service for reliability: if User Service is down, no other service can authenticate requests.

The domain model's pointer types for optional profile fields (bio, website, profile picture) is a Go idiom worth understanding. A `*string` bio can be nil (user has not set a bio) or a pointer to an empty string (user explicitly set their bio to empty). These are different states with different display behaviors. Using value types (`string`) would conflate these states.

The repository pattern in the User Service (service layer depends on `UserRepository` interface, concrete PostgreSQL implementation injected at startup) is the testability pattern that makes unit testing possible without a real database. Know how to write this pattern and why it exists.

### Senior @ FAANG: User Service as a Platform Identity System

At senior level, the User Service is the foundation for the organization's identity and access management. User identities created in the social network may be reused across other products (if the company builds related products). The User Service must be designed for this eventual reuse: stable user IDs, versioned API, clear privacy controls, and well-documented data ownership.

Account lifecycle management (account creation, email verification, two-factor authentication enrollment, session management, account suspension, account deletion) is a complex state machine with multiple actors (user, admin, automated systems). The state transitions must be idempotent, auditable, and reversible where appropriate. Building a full account lifecycle system requires careful coordination between the User Service team, the security team, and the legal/compliance team.

Privacy settings in the user domain model (public, private, followers-only) must be enforced consistently across all services that access user data. A privacy setting change (switching from public to private) must propagate to the feed service (which should stop including this user's posts in non-follower feeds), the search service (which should stop indexing this user's posts), and the notification service (which should suppress notifications to non-followers). This cross-service privacy enforcement is a governance concern, not just a User Service concern.

---
