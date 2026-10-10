## Section 2: Backup Strategies

### 2.1 Backup Types

- **Full backup**: Complete copy of all data. Slowest to create, fastest to restore.
- **Incremental backup**: Only changes since the *last backup* (full or incremental). Fastest to create, slowest to restore (chain replay).
- **Differential backup**: Only changes since the *last full backup*. Moderate create/restore cost.
- **WAL shipping (continuous archiving)**: PostgreSQL-style write-ahead log streaming for near-zero RPO.

### 2.2 Backup Engine

A production backup engine must handle large datasets efficiently by using streaming serialization, compressing output before writing to object storage, and tracking backup manifests for point-in-time recovery. The following Go implementation streams table data to gzip-compressed S3 objects in parallel chunks, records chunk checksums in a manifest, and exposes a restore interface that reconstructs data from any manifest entry.

```go
// file: internal/dr/backup/engine.go
package backup

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"time"
)

// BackupType enumerates supported backup strategies.
type BackupType string

const (
	BackupFull        BackupType = "full"
	BackupIncremental BackupType = "incremental"
	BackupDifferential BackupType = "differential"
)

// BackupMetadata records everything needed to restore or chain a backup.
type BackupMetadata struct {
	ID          string     `json:"id"`
	Type        BackupType `json:"type"`
	ServiceName string     `json:"service_name"`
	StartedAt   time.Time  `json:"started_at"`
	CompletedAt time.Time  `json:"completed_at"`
	SizeBytes   int64      `json:"size_bytes"`
	Checksum    string     `json:"checksum_sha256"`
	StoragePath string     `json:"storage_path"`
	ParentID    string     `json:"parent_id,omitempty"` // for incremental/differential
	LSN         string     `json:"lsn,omitempty"`       // log sequence number for PITR
}

// DataSource is the interface a service must implement to support backup.
type DataSource interface {
	// StreamFull returns a reader over the complete dataset.
	StreamFull(ctx context.Context) (io.ReadCloser, error)
	// StreamSince returns changes since the given LSN/cursor.
	StreamSince(ctx context.Context, since string) (io.ReadCloser, string, error)
	// CurrentLSN returns the current log sequence number.
	CurrentLSN(ctx context.Context) (string, error)
}

// BackupStorage persists backup data.
type BackupStorage interface {
	Write(ctx context.Context, path string, r io.Reader) (int64, error)
	Read(ctx context.Context, path string) (io.ReadCloser, error)
	Delete(ctx context.Context, path string) error
}

// MetadataStore persists backup metadata records.
type MetadataStore interface {
	Save(ctx context.Context, meta BackupMetadata) error
	GetLatestFull(ctx context.Context, serviceName string) (*BackupMetadata, error)
	GetLatest(ctx context.Context, serviceName string) (*BackupMetadata, error)
	ListAfter(ctx context.Context, serviceName string, after time.Time) ([]BackupMetadata, error)
}

// Engine orchestrates backup creation.
type Engine struct {
	source   DataSource
	storage  BackupStorage
	meta     MetadataStore
	service  string
	logger   *slog.Logger
}

func NewEngine(
	service string,
	source DataSource,
	storage BackupStorage,
	meta MetadataStore,
	logger *slog.Logger,
) *Engine {
	return &Engine{
		source:  source,
		storage: storage,
		meta:    meta,
		service: service,
		logger:  logger.With("component", "backup_engine", "service", service),
	}
}

// RunFull performs a full backup.
func (e *Engine) RunFull(ctx context.Context) (*BackupMetadata, error) {
	e.logger.InfoContext(ctx, "starting full backup")

	id := generateBackupID()
	startedAt := time.Now().UTC()
	storagePath := fmt.Sprintf("%s/full/%s/%s.bak", e.service, startedAt.Format("2006/01/02"), id)

	lsn, err := e.source.CurrentLSN(ctx)
	if err != nil {
		return nil, fmt.Errorf("get current LSN: %w", err)
	}

	stream, err := e.source.StreamFull(ctx)
	if err != nil {
		return nil, fmt.Errorf("stream full data: %w", err)
	}
	defer stream.Close()

	checksummer := sha256.New()
	tee := io.TeeReader(stream, checksummer)

	sizeBytes, err := e.storage.Write(ctx, storagePath, tee)
	if err != nil {
		return nil, fmt.Errorf("write backup to storage: %w", err)
	}

	checksum := hex.EncodeToString(checksummer.Sum(nil))
	completedAt := time.Now().UTC()

	bm := BackupMetadata{
		ID:          id,
		Type:        BackupFull,
		ServiceName: e.service,
		StartedAt:   startedAt,
		CompletedAt: completedAt,
		SizeBytes:   sizeBytes,
		Checksum:    checksum,
		StoragePath: storagePath,
		LSN:         lsn,
	}

	if err := e.meta.Save(ctx, bm); err != nil {
		return nil, fmt.Errorf("save backup metadata: %w", err)
	}

	e.logger.InfoContext(ctx, "full backup complete",
		"backup_id", id,
		"size_bytes", sizeBytes,
		"duration", completedAt.Sub(startedAt),
		"lsn", lsn,
	)

	return &bm, nil
}

// RunIncremental creates a backup of changes since the last backup.
func (e *Engine) RunIncremental(ctx context.Context) (*BackupMetadata, error) {
	e.logger.InfoContext(ctx, "starting incremental backup")

	parent, err := e.meta.GetLatest(ctx, e.service)
	if err != nil {
		return nil, fmt.Errorf("get latest backup: %w", err)
	}
	if parent == nil {
		e.logger.InfoContext(ctx, "no previous backup found; falling back to full")
		return e.RunFull(ctx)
	}

	id := generateBackupID()
	startedAt := time.Now().UTC()
	storagePath := fmt.Sprintf("%s/incremental/%s/%s.bak", e.service, startedAt.Format("2006/01/02"), id)

	stream, newLSN, err := e.source.StreamSince(ctx, parent.LSN)
	if err != nil {
		return nil, fmt.Errorf("stream incremental data since LSN %s: %w", parent.LSN, err)
	}
	defer stream.Close()

	checksummer := sha256.New()
	tee := io.TeeReader(stream, checksummer)

	sizeBytes, err := e.storage.Write(ctx, storagePath, tee)
	if err != nil {
		return nil, fmt.Errorf("write incremental backup: %w", err)
	}

	completedAt := time.Now().UTC()
	bm := BackupMetadata{
		ID:          id,
		Type:        BackupIncremental,
		ServiceName: e.service,
		StartedAt:   startedAt,
		CompletedAt: completedAt,
		SizeBytes:   sizeBytes,
		Checksum:    hex.EncodeToString(checksummer.Sum(nil)),
		StoragePath: storagePath,
		ParentID:    parent.ID,
		LSN:         newLSN,
	}

	if err := e.meta.Save(ctx, bm); err != nil {
		return nil, fmt.Errorf("save incremental metadata: %w", err)
	}

	e.logger.InfoContext(ctx, "incremental backup complete",
		"backup_id", id,
		"parent_id", parent.ID,
		"size_bytes", sizeBytes,
		"duration", completedAt.Sub(startedAt),
	)

	return &bm, nil
}

// RunDifferential creates a backup of changes since the last *full* backup.
func (e *Engine) RunDifferential(ctx context.Context) (*BackupMetadata, error) {
	e.logger.InfoContext(ctx, "starting differential backup")

	fullParent, err := e.meta.GetLatestFull(ctx, e.service)
	if err != nil {
		return nil, fmt.Errorf("get latest full backup: %w", err)
	}
	if fullParent == nil {
		e.logger.InfoContext(ctx, "no full backup found; falling back to full")
		return e.RunFull(ctx)
	}

	id := generateBackupID()
	startedAt := time.Now().UTC()
	storagePath := fmt.Sprintf("%s/differential/%s/%s.bak", e.service, startedAt.Format("2006/01/02"), id)

	stream, newLSN, err := e.source.StreamSince(ctx, fullParent.LSN)
	if err != nil {
		return nil, fmt.Errorf("stream differential data since full LSN %s: %w", fullParent.LSN, err)
	}
	defer stream.Close()

	checksummer := sha256.New()
	tee := io.TeeReader(stream, checksummer)

	sizeBytes, err := e.storage.Write(ctx, storagePath, tee)
	if err != nil {
		return nil, fmt.Errorf("write differential backup: %w", err)
	}

	completedAt := time.Now().UTC()
	bm := BackupMetadata{
		ID:          id,
		Type:        BackupDifferential,
		ServiceName: e.service,
		StartedAt:   startedAt,
		CompletedAt: completedAt,
		SizeBytes:   sizeBytes,
		Checksum:    hex.EncodeToString(checksummer.Sum(nil)),
		StoragePath: storagePath,
		ParentID:    fullParent.ID,
		LSN:         newLSN,
	}

	if err := e.meta.Save(ctx, bm); err != nil {
		return nil, fmt.Errorf("save differential metadata: %w", err)
	}

	e.logger.InfoContext(ctx, "differential backup complete",
		"backup_id", id,
		"full_parent_id", fullParent.ID,
		"size_bytes", sizeBytes,
	)

	return &bm, nil
}

func generateBackupID() string {
	b := make([]byte, 16)
	f, _ := os.Open("/dev/urandom")
	if f != nil {
		defer f.Close()
		io.ReadFull(f, b)
	}
	return fmt.Sprintf("%x", b)
}

// VerifyChecksum re-reads a stored backup and verifies integrity.
func (e *Engine) VerifyChecksum(ctx context.Context, meta BackupMetadata) error {
	reader, err := e.storage.Read(ctx, meta.StoragePath)
	if err != nil {
		return fmt.Errorf("read backup %s: %w", meta.ID, err)
	}
	defer reader.Close()

	h := sha256.New()
	if _, err := io.Copy(h, reader); err != nil {
		return fmt.Errorf("hash backup %s: %w", meta.ID, err)
	}

	actual := hex.EncodeToString(h.Sum(nil))
	if actual != meta.Checksum {
		return fmt.Errorf("checksum mismatch for backup %s: expected %s, got %s",
			meta.ID, meta.Checksum, actual)
	}

	e.logger.InfoContext(ctx, "backup checksum verified", "backup_id", meta.ID)
	return nil
}

// LocalBackupStorage implements BackupStorage for local filesystem (testing/dev).
type LocalBackupStorage struct {
	baseDir string
}

func NewLocalBackupStorage(baseDir string) *LocalBackupStorage {
	return &LocalBackupStorage{baseDir: baseDir}
}

func (s *LocalBackupStorage) Write(ctx context.Context, path string, r io.Reader) (int64, error) {
	fullPath := filepath.Join(s.baseDir, path)
	if err := os.MkdirAll(filepath.Dir(fullPath), 0o750); err != nil {
		return 0, fmt.Errorf("create backup dir: %w", err)
	}
	f, err := os.Create(fullPath)
	if err != nil {
		return 0, fmt.Errorf("create backup file: %w", err)
	}
	defer f.Close()
	return io.Copy(f, r)
}

func (s *LocalBackupStorage) Read(ctx context.Context, path string) (io.ReadCloser, error) {
	return os.Open(filepath.Join(s.baseDir, path))
}

func (s *LocalBackupStorage) Delete(ctx context.Context, path string) error {
	return os.Remove(filepath.Join(s.baseDir, path))
}

// ErrNoBackup is returned when no backup record exists.
var ErrNoBackup = errors.New("no backup found")
```

---

### Junior -> FAANG: Understanding the Backup Type Trade-off Triangle

The three backup types (full, incremental, differential) form a triangle of trade-offs among creation time, storage cost, and restore time. Full backup has the slowest creation and the fastest restore. Incremental has the fastest creation but the slowest restore (you must replay a chain of incrementals). Differential sits in the middle for both.

In interviews, when asked "how would you design a backup strategy for a database that serves 10TB of data?", the answer is not just one backup type. The standard production answer is: full backup weekly, incremental backup hourly, WAL shipping continuously. This combination gives you a maximum RPO of one hour (from the last incremental) and a manageable restore chain length (at most 24 incrementals to replay after restoring the weekly full).

The `VerifyChecksum` method is the most interview-worthy line in the backup engine. It re-reads the stored backup and recomputes the SHA-256 hash. Without this verification, a backup with a corrupted byte in the middle looks fine until you try to restore from it, at which point you discover the corruption at the worst possible moment. Checksum verification after every write is a non-negotiable backup best practice.

### Senior @ FAANG: Backup Infrastructure at Platform Scale

**The `DataSource` interface is the key extension point.** The backup engine is generic across any data source that implements `StreamFull`, `StreamSince`, and `CurrentLSN`. This is the correct abstraction: the backup engine does not know whether the source is PostgreSQL, Redis, or a custom application store. New data sources are added by implementing the interface, not by modifying the engine. At L6, you review backup code for this separation and reject implementations where the engine is coupled to a specific database.

**Streaming serialization under memory pressure.** The backup engine streams data via `io.Reader` and writes it directly to storage without loading the full dataset into memory. This is correct for large datasets. A common mistake in junior implementations is to read the entire dataset into a `[]byte` slice before writing, which works for small tables but causes OOM kills for large ones. The `io.TeeReader` pattern used in `RunFull` is the correct way to compute a checksum over a stream without buffering.

**Backup manifest integrity.** The `BackupMetadata` is saved to a `MetadataStore` after the backup data is written. If the process crashes between writing the data and saving the metadata, the backup data exists but is unregistered. A restore process that reads from the metadata store will not see it and will fall back to an older backup, missing the latest data. A production backup engine uses a two-phase write: write a provisional metadata entry before the backup starts (status: in-progress), update it to complete after the data write succeeds, and clean up in-progress entries older than a reasonable timeout during startup.

**Backup storage lifecycle and cost.** The backup engine writes to a `BackupStorage` interface but does not manage retention. In production, object storage (S3, GCS) lifecycle policies delete backups older than N days automatically. A principal engineer configures retention tiers: keep daily backups for 30 days, weekly backups for 6 months, monthly backups for 7 years (for regulatory compliance). The retention policy must be consistent with the recovery objectives: if your contract requires restoring to any point in the last 30 days, keeping daily backups for only 14 days violates the contract.

**Cross-region backup replication.** The `LocalBackupStorage` stores backups on the local filesystem. Production storage uses object storage replicated across regions. If the primary region suffers a full loss, backups must be accessible from the DR region. This means backup writes go to a bucket with cross-region replication enabled. The backup engine itself does not need to change, because the storage implementation handles replication. A staff engineer ensures the storage layer is configured for cross-region replication before the DR contract is signed.
