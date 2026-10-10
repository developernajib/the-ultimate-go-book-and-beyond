## 21.5 Database Connection Cleanup

### Closing Database Connections

Using `defer` to close the database connection covers the paths where `main` **returns**, whether that is a normal return or a signal-triggered cancellation that unwinds `run`. The deferred closure captures the `db` variable and logs any error returned by `db.Close`, making silent failures visible in production logs.

```go
func main() {
    db, err := sql.Open("postgres", connString)
    if err != nil {
        log.Fatal(err)
    }

    // Ensure cleanup on exit
    defer func() {
        log.Println("Closing database connection")
        if err := db.Close(); err != nil {
            log.Printf("Error closing database: %v", err)
        }
    }()

    // Handle signals
    ctx, cancel := context.WithCancel(context.Background())
    defer cancel()
    go handleSignals(cancel)

    if err := run(ctx, db); err != nil {
        log.Printf("run: %v", err) // NOT log.Fatal: that would skip the defers
    }
}
```

**`defer` is not a guarantee, it is a guarantee about returns.** `os.Exit` and `log.Fatal` (which calls `os.Exit(1)`) terminate the process immediately and run **no** deferred functions. So does an uncaught signal once you have restored default handling. This is why the `log.Fatal` calls that litter most `main` functions quietly defeat the cleanup sitting right above them.

The standard fix is to keep `main` trivial and put everything that needs cleanup in a function that returns an error:

```go
func main() {
    if err := realMain(); err != nil {
        log.Printf("fatal: %v", err)
        os.Exit(1) // the only os.Exit, and it runs after realMain's defers
    }
}

func realMain() error {
    db, err := sql.Open("postgres", connString)
    if err != nil {
        return err
    }
    defer db.Close() // now actually runs
    ...
}
```

For the same reason, `db.Close()` on a `*sql.DB` is not the interesting part of database shutdown. `Close` waits for connections currently in use to be returned to the pool, so it is only safe once the workers holding them have stopped. That ordering is the subject of the staff lens below.

### Transaction Cleanup

An open transaction holds database locks and consumes a connection from the pool, so it must always be resolved, either committed or rolled back, before the function returns. The deferred anonymous function shown here handles the edge case of a panic mid-transaction, ensuring the rollback occurs even when control leaves the function abnormally. Notice that a normal error path calls `tx.Rollback` explicitly before returning, keeping the defer as a safety net rather than the primary cleanup path.

```go
func processWithTransaction(ctx context.Context, db *sql.DB) error {
    tx, err := db.BeginTx(ctx, nil)
    if err != nil {
        return err
    }

    // Ensure rollback on any error or cancellation
    defer func() {
        if p := recover(); p != nil {
            tx.Rollback()
            panic(p)
        }
    }()

    if err := doWork(ctx, tx); err != nil {
        tx.Rollback()
        return err
    }

    return tx.Commit()
}
```

### Staff Lens: Cleanup Order Matters

On shutdown, close resources in reverse order of dependency: HTTP server first (stop accepting requests), then workers that might query the database, then the database connection pool itself, then logger, then telemetry. Closing the database before workers finish produces connection-closed errors in the middle of legitimate in-flight work.

Document the shutdown order for each service, and verify in review that cleanup happens in the documented order.

---
