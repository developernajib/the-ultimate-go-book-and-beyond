## Go Implementation: Selective Sync Manager

Selective sync lets users choose which folders to sync to each device, which is essential when a user's Dropbox contains more data than a device has disk space for. The manager maintains a per-device configuration that specifies which folders to include and which file patterns to exclude (such as temporary files or dependency directories). When the sync service processes changes, it consults this configuration to filter out changes the device does not care about, avoiding unnecessary downloads and saving both bandwidth and local storage.

```go
package sync

import (
	"context"
	"fmt"
	"strings"
)

// DatabaseClient defines persistence operations for selective sync state
type DatabaseClient interface {
	Exec(ctx context.Context, query string, args ...any) error
}

// RedisClient defines cache invalidation operations
type RedisClient interface {
	Del(ctx context.Context, keys ...string) error
}

// SelectiveSyncManager controls which folders sync to which devices
type SelectiveSyncManager struct {
	db  DatabaseClient
	rdb RedisClient
}

type DeviceSyncConfig struct {
	DeviceID     string   `json:"device_id"`
	UserID       string   `json:"user_id"`
	DeviceName   string   `json:"device_name"`
	Platform     string   `json:"platform"` // windows, mac, linux, ios, android
	SyncFolders  []string `json:"sync_folders"` // empty = sync all
	ExcludePatterns []string `json:"exclude_patterns"` // "*.tmp", "node_modules"
}

// ShouldSync checks if a path should be synced to a specific device
func (m *SelectiveSyncManager) ShouldSync(config *DeviceSyncConfig, path string) bool {
	// Check exclude patterns first
	for _, pattern := range config.ExcludePatterns {
		if matchPattern(path, pattern) {
			return false
		}
	}

	// If no folder restrictions, sync everything
	if len(config.SyncFolders) == 0 {
		return true
	}

	// Check if path is under any synced folder
	// Match on the "/" boundary so "/docs" does not match "/docs-backup"
	for _, folder := range config.SyncFolders {
		if path == folder || strings.HasPrefix(path, strings.TrimSuffix(folder, "/")+"/") {
			return true
		}
	}

	return false
}

// UpdateDeviceConfig changes sync configuration for a device
func (m *SelectiveSyncManager) UpdateDeviceConfig(ctx context.Context, config DeviceSyncConfig) error {
	// Save to database
	if err := m.db.Exec(ctx, `
		INSERT INTO device_sync_state (device_id, user_id, device_name, platform, sync_folders)
		VALUES ($1, $2, $3, $4, $5)
		ON CONFLICT (device_id) DO UPDATE SET sync_folders = EXCLUDED.sync_folders`,
		config.DeviceID, config.UserID, config.DeviceName, config.Platform,
		config.SyncFolders); err != nil {
		return fmt.Errorf("save device config: %w", err)
	}

	// Invalidate device's change filter cache
	m.rdb.Del(ctx, fmt.Sprintf("device:config:%s", config.DeviceID))

	return nil
}

func matchPattern(path, pattern string) bool {
	// Simplified glob matching
	if strings.HasPrefix(pattern, "*") {
		return strings.HasSuffix(path, pattern[1:])
	}
	return strings.Contains(path, pattern)
}
```
