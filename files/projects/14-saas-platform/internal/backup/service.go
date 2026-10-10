// internal/backup/service.go
package backup

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"time"

	"github.com/google/uuid"
	"github.com/jmoiron/sqlx"
	"github.com/example/saas-platform/pkg/logger"
)

// StorageService handles file storage for backups
type StorageService interface {
	Upload(ctx context.Context, path string, data []byte) (string, error)
}

// Service handles database backups
type Service struct {
	db      *sqlx.DB
	storage StorageService
	logger  logger.Logger
}

func NewService(db *sqlx.DB, storage StorageService, logger logger.Logger) *Service {
	return &Service{
		db:      db,
		storage: storage,
		logger:  logger,
	}
}

// BackupTenant creates a backup of a tenant's data
func (s *Service) BackupTenant(ctx context.Context, tenantID uuid.UUID) error {
	s.logger.Info("starting tenant backup", "tenant_id", tenantID)

	filename := fmt.Sprintf("backups/tenant_%s_%s.sql",
		tenantID.String(),
		time.Now().Format("20060102_150405"))

	cmd := exec.CommandContext(ctx, "pg_dump",
		"--schema", fmt.Sprintf("tenant_%s", tenantID),
		"--file", filename,
		os.Getenv("DATABASE_URL"))

	if err := cmd.Run(); err != nil {
		return fmt.Errorf("backup failed: %w", err)
	}

	data, err := os.ReadFile(filename)
	if err != nil {
		return err
	}

	url, err := s.storage.Upload(ctx, filename, data)
	if err != nil {
		return err
	}

	s.logger.Info("tenant backup completed", "tenant_id", tenantID, "url", url)
	return nil
}

// ScheduleBackups runs periodic backups
func (s *Service) ScheduleBackups(ctx context.Context) {
	ticker := time.NewTicker(24 * time.Hour)
	defer ticker.Stop()

	for {
		select {
		case <-ticker.C:
			s.runBackups(ctx)
		case <-ctx.Done():
			return
		}
	}
}

func (s *Service) runBackups(ctx context.Context) {
	var tenantIDs []uuid.UUID
	err := s.db.SelectContext(ctx, &tenantIDs,
		"SELECT id FROM tenants WHERE status = $1", "active")
	if err != nil {
		s.logger.Error("failed to get tenants for backup", "error", err)
		return
	}

	for _, tenantID := range tenantIDs {
		if err := s.BackupTenant(ctx, tenantID); err != nil {
			s.logger.Error("backup failed", "tenant_id", tenantID, "error", err)
		}
	}
}
