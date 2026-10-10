// internal/service/user.go
package service

import (
    "context"
    "errors"
    "fmt"
    "time"

    "github.com/google/uuid"
    "golang.org/x/crypto/bcrypt"
    "github.com/example/social-network/internal/domain"
    "github.com/example/social-network/internal/domain/repository"
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
