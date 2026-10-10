// internal/storage/migrations/runner.go
package migrations

import (
	"database/sql"
	"embed"
	"fmt"
	"io/fs"
	"sort"
	"strings"
)

//go:embed *.sql
var migrationFS embed.FS

// RunMigrations applies all pending migrations using simple SQL execution
func RunMigrations(db *sql.DB) error {
	// Ensure migrations table exists
	_, err := db.Exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
		version TEXT PRIMARY KEY,
		applied_at TIMESTAMP DEFAULT NOW()
	)`)
	if err != nil {
		return fmt.Errorf("creating migrations table: %w", err)
	}

	// Get applied migrations
	rows, err := db.Query("SELECT version FROM schema_migrations ORDER BY version")
	if err != nil {
		return fmt.Errorf("getting applied migrations: %w", err)
	}
	defer rows.Close()

	applied := make(map[string]bool)
	for rows.Next() {
		var version string
		if err := rows.Scan(&version); err != nil {
			return err
		}
		applied[version] = true
	}

	// Get all migration files
	entries, err := fs.ReadDir(migrationFS, ".")
	if err != nil {
		return fmt.Errorf("reading migrations: %w", err)
	}

	var files []string
	for _, e := range entries {
		if strings.HasSuffix(e.Name(), ".sql") {
			files = append(files, e.Name())
		}
	}
	sort.Strings(files)

	// Apply pending migrations
	for _, file := range files {
		if applied[file] {
			continue
		}

		content, err := migrationFS.ReadFile(file)
		if err != nil {
			return fmt.Errorf("reading migration %s: %w", file, err)
		}

		if _, err := db.Exec(string(content)); err != nil {
			return fmt.Errorf("applying migration %s: %w", file, err)
		}

		if _, err := db.Exec("INSERT INTO schema_migrations (version) VALUES ($1)", file); err != nil {
			return fmt.Errorf("recording migration %s: %w", file, err)
		}
	}

	return nil
}
