## Deep Dive: Storage Optimization

Storage optimization is essential for a system that stores 500PB of data. This section covers two key concerns: tracking how much storage each user consumes (logical vs. physical after deduplication) and garbage collecting orphaned blocks that are no longer referenced by any file or version. The `GarbageCollect` function runs as a nightly batch job, identifying blocks that exist in the reference table but are not used by any active file or recent version. Because block uploads happen before the metadata commit, a freshly uploaded block briefly looks orphaned, so the collector only considers blocks older than 24 hours. That grace period prevents deleting blocks whose commit is still in flight, while still cleaning up blocks orphaned by interrupted uploads.

```go
package storage

import (
	"context"

	"github.com/jackc/pgx/v5/pgxpool"
)

// StorageAccountingService tracks usage and deduplication savings
type StorageAccountingService struct {
	db *pgxpool.Pool
}

type StorageStats struct {
	TotalFiles     int64   `json:"total_files"`
	TotalSize      int64   `json:"total_size"`      // logical
	PhysicalSize   int64   `json:"physical_size"`    // actual S3
	DedupSavings   int64   `json:"dedup_savings"`
	DedupRatio     float64 `json:"dedup_ratio"`      // logical / physical, e.g. 1.43 = ~30% savings
	VersionStorage int64   `json:"version_storage"`
}

func (s *StorageAccountingService) GetUserStorageStats(ctx context.Context, userID string) (*StorageStats, error) {
	var stats StorageStats

	s.db.QueryRow(ctx,
		"SELECT COUNT(*), COALESCE(SUM(size), 0) FROM file_nodes WHERE owner_id = $1 AND deleted = false AND type = 'file'",
		userID,
	).Scan(&stats.TotalFiles, &stats.TotalSize)

	// Deduplicate by block hash first, then sum sizes
	s.db.QueryRow(ctx, `
		SELECT COALESCE(SUM(br.size_bytes), 0)
		FROM block_references br
		WHERE br.block_hash IN (
			SELECT DISTINCT jsonb_array_elements_text(block_hashes::jsonb)
			FROM file_nodes
			WHERE owner_id = $1 AND deleted = false AND type = 'file'
		)`,
		userID,
	).Scan(&stats.PhysicalSize)

	stats.DedupSavings = stats.TotalSize - stats.PhysicalSize
	if stats.PhysicalSize > 0 {
		stats.DedupRatio = float64(stats.TotalSize) / float64(stats.PhysicalSize)
	}

	return &stats, nil
}

// GarbageCollect removes unreferenced blocks (nightly job)
func (s *StorageAccountingService) GarbageCollect(ctx context.Context) (int64, error) {
	rows, err := s.db.Query(ctx, `
		SELECT block_hash FROM block_references
		WHERE created_at < NOW() - INTERVAL '24 hours' -- grace period for in-flight commits
		AND block_hash NOT IN (
			SELECT jsonb_array_elements_text(block_hashes::jsonb) FROM file_nodes WHERE deleted = false
			UNION
			SELECT jsonb_array_elements_text(block_hashes::jsonb) FROM file_versions WHERE modified_at > NOW() - INTERVAL '30 days'
		)`)
	if err != nil {
		return 0, err
	}
	defer rows.Close()

	var count int64
	for rows.Next() {
		count++
		// Delete from S3 in batches
	}
	return count, nil
}
```

---
