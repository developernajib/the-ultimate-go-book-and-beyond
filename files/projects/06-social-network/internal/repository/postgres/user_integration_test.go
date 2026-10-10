// internal/repository/postgres/user_integration_test.go
//go:build integration

package postgres_test

import (
	"context"
	"testing"

	"github.com/example/social-network/internal/domain"
	"github.com/example/social-network/internal/repository/postgres"
	_ "github.com/jackc/pgx/v5/stdlib"
	"github.com/jmoiron/sqlx"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"github.com/testcontainers/testcontainers-go"
	"github.com/testcontainers/testcontainers-go/wait"
)

func setupTestDB(t *testing.T) (*sqlx.DB, func()) {
	ctx := context.Background()

	req := testcontainers.ContainerRequest{
		Image:        "postgres:18-alpine",
		ExposedPorts: []string{"5432/tcp"},
		Env: map[string]string{
			"POSTGRES_USER":     "test",
			"POSTGRES_PASSWORD": "test",
			"POSTGRES_DB":       "testdb",
		},
		WaitingFor: wait.ForLog("database system is ready to accept connections"),
	}

	container, err := testcontainers.GenericContainer(ctx, testcontainers.GenericContainerRequest{
		ContainerRequest: req,
		Started:          true,
	})
	require.NoError(t, err)

	host, _ := container.Host(ctx)
	port, _ := container.MappedPort(ctx, "5432")

	dsn := fmt.Sprintf("host=%s port=%s user=test password=test dbname=testdb sslmode=disable",
		host, port.Port())

	db, err := sqlx.Connect("pgx", dsn)
	require.NoError(t, err)

	// Run migrations
	// ... (migration code)

	cleanup := func() {
		db.Close()
		container.Terminate(ctx)
	}

	return db, cleanup
}

func TestUserRepository_Create(t *testing.T) {
	db, cleanup := setupTestDB(t)
	defer cleanup()

	repo := postgres.NewUserRepository(db)

	user := &domain.User{
		ID:          uuid.New(),
		Username:    "testuser",
		Email:       "test@example.com",
		DisplayName: "Test User",
	}

	err := repo.Create(context.Background(), user)
	assert.NoError(t, err)

	// Verify user was created
	retrieved, err := repo.GetByID(context.Background(), user.ID)
	assert.NoError(t, err)
	assert.Equal(t, user.Username, retrieved.Username)
	assert.Equal(t, user.Email, retrieved.Email)
}
