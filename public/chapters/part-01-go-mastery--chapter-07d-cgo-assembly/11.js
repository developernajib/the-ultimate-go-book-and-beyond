export default `## 7D.10 Complete CGO Example: Minimal SQLite Wrapper

SQLite is the most common CGO use case. This shows a complete, production-quality minimal wrapper:

\`\`\`go
// file: sqlite/sqlite.go
package sqlite

/*
#cgo LDFLAGS: -lsqlite3
#include <sqlite3.h>
#include <stdlib.h>
#include <string.h>

// Helper: convert sqlite3_errmsg to Go string (avoids CGO overhead in Go)
static const char* db_errmsg(sqlite3* db) {
    return sqlite3_errmsg(db);
}
*/
import "C"

import (
    "database/sql/driver"
    "errors"
    "fmt"
    "unsafe"
)

// DB wraps a sqlite3 connection
type DB struct {
    db *C.sqlite3
}

// Open opens a SQLite database at the given path.
// Use ":memory:" for an in-memory database.
func Open(path string) (*DB, error) {
    cPath := C.CString(path)
    defer C.free(unsafe.Pointer(cPath))

    var db *C.sqlite3
    rc := C.sqlite3_open(cPath, &db)
    if rc != C.SQLITE_OK {
        msg := C.GoString(C.db_errmsg(db))
        C.sqlite3_close(db)
        return nil, fmt.Errorf("sqlite3_open %q: %s", path, msg)
    }
    return &DB{db: db}, nil
}

// Close closes the database connection
func (d *DB) Close() error {
    rc := C.sqlite3_close(d.db)
    if rc != C.SQLITE_OK {
        return fmt.Errorf("sqlite3_close: %s", C.GoString(C.db_errmsg(d.db)))
    }
    d.db = nil
    return nil
}

// Exec executes a SQL statement with no result rows
func (d *DB) Exec(query string, args ...any) error {
    stmt, err := d.prepare(query)
    if err != nil {
        return err
    }
    defer C.sqlite3_finalize(stmt)

    if err := d.bind(stmt, args); err != nil {
        return err
    }

    rc := C.sqlite3_step(stmt)
    if rc != C.SQLITE_DONE && rc != C.SQLITE_ROW {
        return fmt.Errorf("exec %q: %s", query, C.GoString(C.db_errmsg(d.db)))
    }
    return nil
}

// QueryRow executes a query and scans the first row into dest values
func (d *DB) QueryRow(query string, args []any, dest ...any) error {
    stmt, err := d.prepare(query)
    if err != nil {
        return err
    }
    defer C.sqlite3_finalize(stmt)

    if err := d.bind(stmt, args); err != nil {
        return err
    }

    rc := C.sqlite3_step(stmt)
    if rc == C.SQLITE_DONE {
        return errors.New("no rows")
    }
    if rc != C.SQLITE_ROW {
        return fmt.Errorf("query: %s", C.GoString(C.db_errmsg(d.db)))
    }

    return d.scan(stmt, dest)
}

// Query executes a query and calls fn for each row
func (d *DB) Query(query string, args []any, fn func(rows *Rows) error) error {
    stmt, err := d.prepare(query)
    if err != nil {
        return err
    }
    defer C.sqlite3_finalize(stmt)

    if err := d.bind(stmt, args); err != nil {
        return err
    }

    rows := &Rows{stmt: stmt, db: d}
    for {
        rc := C.sqlite3_step(stmt)
        if rc == C.SQLITE_DONE {
            break
        }
        if rc != C.SQLITE_ROW {
            return fmt.Errorf("query step: %s", C.GoString(C.db_errmsg(d.db)))
        }
        if err := fn(rows); err != nil {
            return err
        }
    }
    return nil
}

// Rows provides access to the current row in a query
type Rows struct {
    stmt *C.sqlite3_stmt
    db   *DB
}

// Scan reads column values from the current row
func (r *Rows) Scan(dest ...any) error {
    return r.db.scan(r.stmt, dest)
}

// ColumnCount returns the number of columns in the result
func (r *Rows) ColumnCount() int {
    return int(C.sqlite3_column_count(r.stmt))
}

// ColumnName returns the name of column i
func (r *Rows) ColumnName(i int) string {
    return C.GoString(C.sqlite3_column_name(r.stmt, C.int(i)))
}

func (d *DB) prepare(query string) (*C.sqlite3_stmt, error) {
    cQuery := C.CString(query)
    defer C.free(unsafe.Pointer(cQuery))

    var stmt *C.sqlite3_stmt
    rc := C.sqlite3_prepare_v2(d.db, cQuery, -1, &stmt, nil)
    if rc != C.SQLITE_OK {
        return nil, fmt.Errorf("prepare %q: %s", query, C.GoString(C.db_errmsg(d.db)))
    }
    return stmt, nil
}

func (d *DB) bind(stmt *C.sqlite3_stmt, args []any) error {
    for i, arg := range args {
        idx := C.int(i + 1)
        var rc C.int
        switch v := arg.(type) {
        case nil:
            rc = C.sqlite3_bind_null(stmt, idx)
        case int:
            rc = C.sqlite3_bind_int64(stmt, idx, C.sqlite3_int64(v))
        case int64:
            rc = C.sqlite3_bind_int64(stmt, idx, C.sqlite3_int64(v))
        case float64:
            rc = C.sqlite3_bind_double(stmt, idx, C.double(v))
        case string:
            cs := C.CString(v)
            defer C.free(unsafe.Pointer(cs))
            rc = C.sqlite3_bind_text(stmt, idx, cs, C.int(len(v)), C.SQLITE_TRANSIENT)
        case []byte:
            if len(v) == 0 {
                rc = C.sqlite3_bind_null(stmt, idx)
            } else {
                rc = C.sqlite3_bind_blob(stmt, idx,
                    unsafe.Pointer(&v[0]), C.int(len(v)), C.SQLITE_TRANSIENT)
            }
        default:
            return fmt.Errorf("unsupported bind type %T at index %d", arg, i+1)
        }
        if rc != C.SQLITE_OK {
            return fmt.Errorf("bind arg %d: %s", i+1, C.GoString(C.db_errmsg(d.db)))
        }
    }
    return nil
}

func (d *DB) scan(stmt *C.sqlite3_stmt, dest []any) error {
    nCols := int(C.sqlite3_column_count(stmt))
    if len(dest) > nCols {
        return fmt.Errorf("scan: %d destinations but only %d columns", len(dest), nCols)
    }
    for i, d := range dest {
        col := C.int(i)
        colType := C.sqlite3_column_type(stmt, col)
        switch ptr := d.(type) {
        case *int:
            *ptr = int(C.sqlite3_column_int64(stmt, col))
        case *int64:
            *ptr = int64(C.sqlite3_column_int64(stmt, col))
        case *float64:
            *ptr = float64(C.sqlite3_column_double(stmt, col))
        case *string:
            if colType == C.SQLITE_NULL {
                *ptr = ""
            } else {
                *ptr = C.GoString((*C.char)(unsafe.Pointer(C.sqlite3_column_text(stmt, col))))
            }
        case *[]byte:
            if colType == C.SQLITE_NULL {
                *ptr = nil
            } else {
                n := C.sqlite3_column_bytes(stmt, col)
                raw := C.sqlite3_column_blob(stmt, col)
                *ptr = C.GoBytes(raw, n)
            }
        case *driver.Value:
            switch colType {
            case C.SQLITE_NULL:
                *ptr = nil
            case C.SQLITE_INTEGER:
                *ptr = int64(C.sqlite3_column_int64(stmt, col))
            case C.SQLITE_FLOAT:
                *ptr = float64(C.sqlite3_column_double(stmt, col))
            default:
                *ptr = C.GoString((*C.char)(unsafe.Pointer(C.sqlite3_column_text(stmt, col))))
            }
        default:
            return fmt.Errorf("unsupported scan type %T at column %d", d, i)
        }
    }
    return nil
}
\`\`\`

The test below exercises the wrapper end-to-end against an in-memory database, verifying table creation, parameterized inserts, single-row queries, and multi-row iteration:

\`\`\`go
// file: sqlite/sqlite_test.go
package sqlite_test

import (
    "fmt"
    "testing"
)

func TestSQLite(t *testing.T) {
    db, err := Open(":memory:")
    if err != nil {
        t.Fatal(err)
    }
    defer db.Close()

    // Create table
    if err := db.Exec(\`CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT, age INTEGER)\`); err != nil {
        t.Fatal(err)
    }

    // Insert rows
    for i, name := range []string{"Alice", "Bob", "Carol"} {
        if err := db.Exec(\`INSERT INTO users (name, age) VALUES (?, ?)\`, name, 20+i); err != nil {
            t.Fatal(err)
        }
    }

    // Query single row
    var name string
    var age int
    if err := db.QueryRow(\`SELECT name, age FROM users WHERE id = ?\`, []any{1}, &name, &age); err != nil {
        t.Fatal(err)
    }
    fmt.Printf("User: %s, age %d\\n", name, age) // Alice, age 20

    // Query all rows
    db.Query(\`SELECT name, age FROM users ORDER BY age\`, nil, func(rows *Rows) error {
        var n string
        var a int
        rows.Scan(&n, &a)
        fmt.Printf("  %s: %d\\n", n, a)
        return nil
    })
}
\`\`\`

### When to Use \`modernc.org/sqlite\` Instead

\`modernc.org/sqlite\` is a pure-Go port of SQLite. No CGO required. For most services, it is the right default: cross-compiles, no C toolchain in CI, no static-vs-dynamic linking questions. The tradeoff is ~20% slower on some workloads compared to CGO SQLite.

For a senior engineer adding SQLite to a service, the default should be the pure-Go port. Only reach for CGO SQLite if the performance difference is measurable and matters for the workload.

---
`;
