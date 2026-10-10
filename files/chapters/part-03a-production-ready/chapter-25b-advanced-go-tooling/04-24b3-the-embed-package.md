## 25B.3 The embed Package

### Embedding Files into Your Binary

The `//go:embed` directive must immediately precede a `var` declaration of type `string`, `[]byte`, or `embed.FS`. A single string or `[]byte` variable holds exactly one file's contents, while `embed.FS` can hold an entire directory tree and supports the full `fs.FS` interface, including `http.FileServer`, `template.ParseFS`, and `fs.WalkDir`, without any runtime I/O.

```go
// file: server.go
package main

import (
    "embed"
    "html/template"
    "io/fs"
    "net/http"
)

// Embed a single file
//go:embed static/logo.png
var logoData []byte

// Embed a single file as a string
//go:embed VERSION
var version string

// Embed an entire directory tree
//go:embed static
var staticFiles embed.FS

// Embed multiple patterns
//go:embed templates/*.html templates/*.txt
var templateFiles embed.FS

func main() {
    mux := http.NewServeMux()

    // Serve embedded static files
    staticFS, _ := fs.Sub(staticFiles, "static")
    mux.Handle("/static/", http.StripPrefix("/static/",
        http.FileServer(http.FS(staticFS))))

    // Parse embedded templates
    tmpl, err := template.ParseFS(templateFiles, "templates/*.html")
    if err != nil {
        panic(err)
    }

    mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
        tmpl.ExecuteTemplate(w, "index.html", map[string]any{
            "Version": version,
        })
    })

    // Serve embedded logo directly
    mux.HandleFunc("/logo.png", func(w http.ResponseWriter, r *http.Request) {
        w.Header().Set("Content-Type", "image/png")
        w.Write(logoData)
    })

    http.ListenAndServe(":8080", mux)
}
```

### Embedding Pattern Rules

The `//go:embed` directive follows `filepath.Match` glob syntax but has a few non-obvious rules that trip up developers. Naming a directory embeds it recursively, but any file whose name begins with `.` or `_` is silently skipped, which matters for frontend build artifacts (`.gitkeep`, `_headers`) the binary actually needs to serve. Prefixing the pattern with `all:` opts the entire subtree back in.

The exception nobody expects is that this exclusion applies to *directory* patterns, not to globs. A `*` is an ordinary glob and matches dotfiles like any other name, so `static/*` quietly behaves like `all:static`:

| Pattern | `app.js` | `.hidden` | `_internal.js` |
|---|---|---|---|
| `//go:embed static` | yes | no | no |
| `//go:embed static/*` | yes | **yes** | **yes** |
| `//go:embed all:static` | yes | yes | yes |

That asymmetry is a security detail rather than a curiosity. `//go:embed static/*` on a directory that happens to contain a `.env` compiles it into your binary, where anyone with the artifact can recover it with `strings`. Prefer naming the directory, keep embed roots free of anything that is not a build output, and if you glob, walk the FS once and read what you actually shipped.

Additionally, the path in the directive is always relative to the `.go` source file containing it, never to the module root or the build working directory, and it cannot escape that directory: `../assets` is rejected.

```go
// //go:embed PATTERNS rules:
//
// 1. Pattern is relative to the file containing the directive
// 2. Directories are embedded recursively
// 3. Files beginning with . or _ are excluded by default
//    To include them: //go:embed all:dirname
// 4. Patterns follow filepath.Match syntax
// 5. Must be applied to a variable of type string, []byte, or embed.FS

//go:embed config/production.yaml
var prodConfig []byte

//go:embed migrations
var migrations embed.FS

// all: includes files starting with . and _
// (the comment goes on its own line: everything after `//go:embed` on the
// directive line is parsed as patterns, so a trailing comment fails the
// build with `pattern .: invalid pattern syntax`)
//go:embed all:web/dist
var webDist embed.FS

// Reading files from embed.FS
func readEmbedded() {
    data, err := migrations.ReadFile("migrations/001_init.sql")
    if err != nil {
        panic(err)
    }
    _ = data

    // Walk all embedded files
    fs.WalkDir(migrations, ".", func(path string, d fs.DirEntry, err error) error {
        if err != nil {
            return err
        }
        if !d.IsDir() {
            fmt.Println("embedded:", path)
        }
        return nil
    })
}
```

### embed for Database Migrations

Embedding SQL migration files in the binary ensures that the database schema and the application code travel together, so deploying the binary carries everything needed to bring the schema up to date. Reading the embedded directory, sorting by filename to enforce ordering, and executing each file in sequence shows the shape of a migration runner without an external dependency.

Read the next snippet as a demonstration of `embed.FS`, not as a migration tool, because it is missing the three things that make one safe. It records nothing, so every start re-runs every migration and the second start fails on `CREATE TABLE`. It runs each file outside a transaction, so a migration that fails halfway leaves the schema in a state no one designed. And it takes no lock, so two instances starting together race each other. Building those properly is a real project: a `schema_migrations` table, per-migration transactions where the engine supports DDL in a transaction, and an advisory lock.

In practice, embed the files and hand the `fs.FS` to a library that has already solved this. `golang-migrate` accepts one via its `iofs` source driver, and `goose` takes an `fs.FS` directly. You keep the single-artifact benefit and skip re-inventing the bookkeeping.

```go
package database

import (
    "database/sql"
    "embed"
    "fmt"
    "sort"
    "strings"
)

//go:embed migrations/*.sql
var migrationFiles embed.FS

// RunMigrations applies all SQL migrations in order.
//
// DEMONSTRATION ONLY. This runs every migration on every call: it keeps no
// record of what has already been applied, wraps nothing in a transaction,
// and takes no lock against concurrent instances. Use golang-migrate (via
// its iofs source) or goose, both of which accept the embed.FS below.
func RunMigrations(db *sql.DB) error {
    entries, err := migrationFiles.ReadDir("migrations")
    if err != nil {
        return fmt.Errorf("read migrations dir: %w", err)
    }

    // Sort by filename (001_init.sql, 002_users.sql, etc.)
    sort.Slice(entries, func(i, j int) bool {
        return entries[i].Name() < entries[j].Name()
    })

    for _, entry := range entries {
        if !strings.HasSuffix(entry.Name(), ".sql") {
            continue
        }
        // Not named `sql`: that would shadow the database/sql import
        // for the rest of the block.
        stmt, err := migrationFiles.ReadFile("migrations/" + entry.Name())
        if err != nil {
            return fmt.Errorf("read %s: %w", entry.Name(), err)
        }

        if _, err := db.Exec(string(stmt)); err != nil {
            return fmt.Errorf("run %s: %w", entry.Name(), err)
        }
        fmt.Printf("Applied migration: %s\n", entry.Name())
    }
    return nil
}
```

> **Senior track**: Three production patterns worth internalizing. (1) Templates: `template.ParseFS(embedded, "templates/*.html")` lets you ship HTML without shipping a template directory. (2) Static sites: use `fs.Sub` to re-root an `embed.FS` so `/static/` URLs map cleanly without exposing the directory prefix. (3) Migrations: pair `embed.FS` with a migration library that accepts `fs.FS` (golang-migrate supports `iofs`, goose supports `fs.FS` since v3.15) so the embedded tree is the single source of truth. Keep per-asset size small (under a few MB each), link-time bloat affects startup via the loader. For large assets, use a CDN and embed only a manifest.

> **Senior track**: `embed` runs at compile time, the Go compiler reads the referenced files directly. Two operational consequences: your build system must see those files (watch out for `.dockerignore` excluding them from the build context), and changes to embedded files invalidate the build cache for the package, which is correct but can surprise teams optimizing incremental builds. `go:embed` plus `-trimpath` plus reproducible builds composes cleanly, the embedded bytes are content-addressed in the binary.

### Staff Lens: Embed for Self-Contained Binaries

`embed` is how you ship a single-binary service with templates, migrations, and assets. Self-contained binaries are operationally simpler (one artifact, no external file dependencies). Use for the assets where shipping-with-binary makes sense. Use CDN for assets that change frequently or are large.

---
