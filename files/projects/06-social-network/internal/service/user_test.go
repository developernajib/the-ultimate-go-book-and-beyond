// internal/service/user_test.go
package service_test

import (
    "context"
    "testing"

    "github.com/google/uuid"
    "github.com/stretchr/testify/assert"
    "github.com/stretchr/testify/mock"
    "github.com/example/social-network/internal/domain"
    "github.com/example/social-network/internal/service"
    "go.uber.org/zap/zaptest"
)

type MockUserRepository struct {
    mock.Mock
}

func (m *MockUserRepository) Create(ctx context.Context, user *domain.User) error {
    args := m.Called(ctx, user)
    return args.Error(0)
}

func (m *MockUserRepository) GetByID(ctx context.Context, id uuid.UUID) (*domain.User, error) {
    args := m.Called(ctx, id)
    if args.Get(0) == nil {
        return nil, args.Error(1)
    }
    return args.Get(0).(*domain.User), args.Error(1)
}

func (m *MockUserRepository) CreateSettings(ctx context.Context, settings *domain.UserSettings) error {
    args := m.Called(ctx, settings)
    return args.Error(0)
}

func (m *MockUserRepository) GetByUsername(ctx context.Context, username string) (*domain.User, error) {
    args := m.Called(ctx, username)
    if args.Get(0) == nil {
        return nil, args.Error(1)
    }
    return args.Get(0).(*domain.User), args.Error(1)
}

func (m *MockUserRepository) GetByEmail(ctx context.Context, email string) (*domain.User, error) {
    args := m.Called(ctx, email)
    if args.Get(0) == nil {
        return nil, args.Error(1)
    }
    return args.Get(0).(*domain.User), args.Error(1)
}

func (m *MockUserRepository) GetByIDs(ctx context.Context, ids []uuid.UUID) ([]*domain.User, error) {
    args := m.Called(ctx, ids)
    if args.Get(0) == nil {
        return nil, args.Error(1)
    }
    return args.Get(0).([]*domain.User), args.Error(1)
}

func (m *MockUserRepository) GetSettings(ctx context.Context, userID uuid.UUID) (*domain.UserSettings, error) {
    args := m.Called(ctx, userID)
    if args.Get(0) == nil {
        return nil, args.Error(1)
    }
    return args.Get(0).(*domain.UserSettings), args.Error(1)
}

func (m *MockUserRepository) Update(ctx context.Context, user *domain.User) error {
    args := m.Called(ctx, user)
    return args.Error(0)
}

func (m *MockUserRepository) UpdateSettings(ctx context.Context, settings *domain.UserSettings) error {
    args := m.Called(ctx, settings)
    return args.Error(0)
}

func (m *MockUserRepository) UpdateLastSeen(ctx context.Context, userID uuid.UUID) error {
    args := m.Called(ctx, userID)
    return args.Error(0)
}

func (m *MockUserRepository) IncrementFollowerCount(ctx context.Context, userID uuid.UUID, delta int) error {
    args := m.Called(ctx, userID, delta)
    return args.Error(0)
}

func (m *MockUserRepository) IncrementFollowingCount(ctx context.Context, userID uuid.UUID, delta int) error {
    args := m.Called(ctx, userID, delta)
    return args.Error(0)
}

func (m *MockUserRepository) IncrementPostCount(ctx context.Context, userID uuid.UUID, delta int) error {
    args := m.Called(ctx, userID, delta)
    return args.Error(0)
}

func (m *MockUserRepository) Delete(ctx context.Context, id uuid.UUID) error {
    args := m.Called(ctx, id)
    return args.Error(0)
}

func (m *MockUserRepository) Search(ctx context.Context, query string, limit, offset int) ([]*domain.User, error) {
    args := m.Called(ctx, query, limit, offset)
    if args.Get(0) == nil {
        return nil, args.Error(1)
    }
    return args.Get(0).([]*domain.User), args.Error(1)
}

func (m *MockUserRepository) UsernameExists(ctx context.Context, username string) (bool, error) {
    args := m.Called(ctx, username)
    return args.Bool(0), args.Error(1)
}

func (m *MockUserRepository) EmailExists(ctx context.Context, email string) (bool, error) {
    args := m.Called(ctx, email)
    return args.Bool(0), args.Error(1)
}

func TestUserService_CreateUser(t *testing.T) {
    mockRepo := new(MockUserRepository)
    logger := zaptest.NewLogger(t)
    userService := service.NewUserService(mockRepo, logger)

    req := &domain.CreateUserRequest{
        Username:    "testuser",
        Email:       "test@example.com",
        Password:    "password123",
        DisplayName: "Test User",
    }

    mockRepo.On("UsernameExists", mock.Anything, req.Username).Return(false, nil)
    mockRepo.On("EmailExists", mock.Anything, req.Email).Return(false, nil)
    mockRepo.On("Create", mock.Anything, mock.AnythingOfType("*domain.User")).Return(nil)
    mockRepo.On("CreateSettings", mock.Anything, mock.AnythingOfType("*domain.UserSettings")).Return(nil)

    user, err := userService.CreateUser(context.Background(), req)

    assert.NoError(t, err)
    assert.NotNil(t, user)
    assert.Equal(t, req.Username, user.Username)
    assert.Equal(t, req.Email, user.Email)
    mockRepo.AssertExpectations(t)
}
