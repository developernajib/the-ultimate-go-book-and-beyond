## 10C.21 init() Function Ordering Surprises

Go's `init()` functions run automatically before `main()`. Start with what Go actually guarantees, because the folklore here is wrong in both directions:

- **Imported packages are fully initialized before the importing package.** If your package imports `database`, then `database`'s variables and every one of its `init()` functions have completed before a single line of your package's initialization runs. This is a hard guarantee, and it is not fragile.
- **Within a package, variables initialize in dependency order**, not declaration order. The compiler builds the graph and sorts it. Declaration order only breaks ties.
- **Within a package, `init()` functions run in file order** (files presented to the compiler sorted by name), and in declaration order within a file. This is the part that is genuinely brittle, because renaming a file reorders it.
- **Among packages with no import relationship, the relative order is unspecified.** Nothing connects two siblings, so nothing orders them.

The real problem with `init()` is not ordering. It is that `init()` cannot return an error, cannot be passed a dependency, cannot be skipped by a test, and runs before `main` has parsed a flag or read a config. That combination is what turns a package-level `sql.Open` into a process that dies at startup with no way to intervene. `sync.Once` fixes it by moving the work to first use, where a caller exists to receive the error.

```go
// package main

// ============ pkg/database/db.go ============
// var DB *sql.DB
//
// func init() {
//     var err error
//     DB, err = sql.Open("postgres", os.Getenv("DATABASE_URL"))
//     if err != nil {
//         // init() has no caller and no error return, so this is the only
//         // option available: kill the process. Note what that means for
//         // `go test ./pkg/models` on a laptop with no DATABASE_URL set.
//         // The test binary dies before a single test runs, and there is
//         // nowhere to inject a fake.
//         log.Fatal(err)
//     }
// }

// ============ pkg/models/user.go ============
// import "pkg/database"
//
// var users = loadUsers() // runs during pkg/models initialization
//
// func loadUsers() []User {
//     // database.DB IS initialized here. models imports database, so
//     // database is fully initialized first. That part is guaranteed.
//     //
//     // The trap is elsewhere: this runs at process start, before main()
//     // has parsed flags, read config, or set up logging. There is no way
//     // to not run it, no way to run it later, and no way for a test to
//     // substitute anything. A package-level var has quietly made a
//     // network call a precondition of importing the package.
//     return database.DB.Query("SELECT * FROM users")
// }

// ============ the ordering that IS fragile ============
// Within one package, init() functions run in sorted filename order:
//
//   a_config.go: func init() { Registry = map[string]H{} }
//   b_http.go:   func init() { Registry["http"] = httpHandler }
//
// This works. Rename a_config.go to z_config.go and it panics on a nil map
// write, with no compiler complaint. Never let one init() depend on another
// init() in the same package having already run.

// SAFE ALTERNATIVE: lazy initialization via sync.Once.
// The work now happens on first use, where there is a caller to hand the
// error to. Capture the error rather than panicking: Once.Do runs the
// function exactly once whether it succeeded or not, so a panic inside it
// is just log.Fatal with extra steps.
// var (
//     dbOnce sync.Once
//     db     *sql.DB
//     dbErr  error
// )
//
// func GetDB() (*sql.DB, error) {
//     dbOnce.Do(func() {
//         db, dbErr = sql.Open("postgres", os.Getenv("DATABASE_URL"))
//     })
//     return db, dbErr
// }

// BETTER STILL: no package-level state at all. Construct the dependency in
// main() and pass it down. Then order is just the order you wrote, tests
// inject whatever they like, and there is no init() to reason about.
//
// func NewUserStore(db *sql.DB) *UserStore { return &UserStore{db: db} }
//
// func main() {
//     cfg := loadConfig()          // flags parsed, env read, errors handled
//     db, err := sql.Open(...)     // failure is a value, not a process exit
//     if err != nil { ... }
//     store := NewUserStore(db)
//     ...
// }
```

---
