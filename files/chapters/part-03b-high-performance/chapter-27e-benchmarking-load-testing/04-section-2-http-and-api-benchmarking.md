## Section 2: HTTP and API Benchmarking

### 2.1 httptest-Based Benchmarks

Benchmarking HTTP handlers through `httptest.NewRecorder` and `httptest.NewRequest` exercises the full handler stack, middleware, routing, serialization, without a real network socket, producing measurements of handler logic free from network jitter. Adding `b.ReportAllocs()` reveals allocation hotspots in middleware chains, JSON encoding, and context propagation that throughput-only measurements miss. The benchmark below covers request parsing, a simulated database lookup, and response serialization as an integrated micro-benchmark.

```go
package api_bench_test

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
)

// UserHandler is the handler being benchmarked.
func UserHandler(w http.ResponseWriter, r *http.Request) {
	// Simulate typical API: parse body, validate, lookup, respond.
	var req struct {
		UserID string `json:"user_id"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}
	// Simulated DB lookup (fast path from cache).
	resp := struct {
		ID   string `json:"id"`
		Name string `json:"name"`
	}{ID: req.UserID, Name: "John Doe"}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(resp)
}

// BenchmarkUserHandler measures handler throughput.
func BenchmarkUserHandler(b *testing.B) {
	body := []byte(`{"user_id":"user-123"}`)
	handler := http.HandlerFunc(UserHandler)
	b.ReportAllocs()

	for b.Loop() {
		req := httptest.NewRequest(http.MethodPost, "/api/users", bytes.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		rw := httptest.NewRecorder()
		handler.ServeHTTP(rw, req)
		// Always assert the status. A handler that starts 400ing on every
		// request gets dramatically "faster", and without this check the
		// benchmark reports that speedup as good news.
		if rw.Code != http.StatusOK {
			b.Fatalf("unexpected status %d", rw.Code)
		}
	}
}

// BenchmarkUserHandler_parallel tests under concurrent load.
func BenchmarkUserHandler_parallel(b *testing.B) {
	body := []byte(`{"user_id":"user-123"}`)
	handler := http.HandlerFunc(UserHandler)

	b.RunParallel(func(pb *testing.PB) {
		for pb.Next() {
			req := httptest.NewRequest(http.MethodPost, "/api/users", bytes.NewReader(body))
			req.Header.Set("Content-Type", "application/json")
			rw := httptest.NewRecorder()
			handler.ServeHTTP(rw, req)
		}
	})
}

// BenchmarkRouter measures router lookup overhead.
func BenchmarkRouter(b *testing.B) {
	// Register 1000 routes to simulate a real application.
	mux := http.NewServeMux()
	for i := 0; i < 1000; i++ {
		path := fmt.Sprintf("/api/v1/resource%d/", i)
		mux.HandleFunc(path, func(w http.ResponseWriter, r *http.Request) {})
	}

	req := httptest.NewRequest(http.MethodGet, "/api/v1/resource500/item", nil)
	rw := httptest.NewRecorder()

	for b.Loop() {
		mux.ServeHTTP(rw, req)
	}
}

// BenchmarkJSONMarshal compares JSON libraries.
//
// FastJSONEncoder and its ObjectStart/StringField/IntField methods are the
// hand-rolled encoder built in Chapter 27D, section 4. This benchmark only
// measures it.
type User struct {
	ID      string   `json:"id"`
	Name    string   `json:"name"`
	Email   string   `json:"email"`
	Age     int      `json:"age"`
	Tags         []string `json:"tags"`
	Active       bool     `json:"active"`
	BalanceCents int64    `json:"balance_cents"`
}

func BenchmarkJSONMarshal(b *testing.B) {
	user := User{
		ID:           "user-12345",
		Name:         "John Doe",
		Email:        "john@example.com",
		Age:          35,
		Tags:         []string{"premium", "verified", "us-east"},
		Active:       true,
		BalanceCents: 123456,
	}

	// Both arms MUST encode the same fields, or the comparison is theatre.
	// encodeUser below writes id, name, email, and age. So the encoding/json
	// arm marshals a struct with exactly those four fields, not the full User
	// with its Tags slice, Active flag, and BalanceCents int64. Marshalling seven
	// fields and calling it a fair fight against an encoder that writes four is
	// how hand-rolled code "wins" by 3x on paper and by nothing in production.
	// If you extend encodeUser, extend userSubset in the same commit.
	subset := userSubset{ID: user.ID, Name: user.Name, Email: user.Email, Age: user.Age}

	b.Run("encoding/json", func(b *testing.B) {
		b.ReportAllocs()
		for b.Loop() {
			data, err := json.Marshal(subset)
			if err != nil {
				b.Fatal(err)
			}
			sink = data
		}
	})

	b.Run("manual-encoder", func(b *testing.B) {
		b.ReportAllocs()
		pool := sync.Pool{New: func() any {
			return &FastJSONEncoder{buf: make([]byte, 0, 256)}
		}}
		for b.Loop() {
			enc := pool.Get().(*FastJSONEncoder)
			enc.buf = enc.buf[:0]
			encodeUser(enc, user)
			// Copy out, because the pooled buffer is about to be reused. This
			// copy is part of the cost and belongs inside the timed region.
			result := make([]byte, len(enc.buf))
			copy(result, enc.buf)
			pool.Put(enc)
			sink = result
		}
	})
}

var sink []byte

// userSubset mirrors exactly the fields encodeUser writes.
type userSubset struct {
	ID    string `json:"id"`
	Name  string `json:"name"`
	Email string `json:"email"`
	Age   int    `json:"age"`
}

func encodeUser(e *FastJSONEncoder, u User) {
	e.ObjectStart()
	e.StringField("id", u.ID)
	e.Comma()
	e.StringField("name", u.Name)
	e.Comma()
	e.StringField("email", u.Email)
	e.Comma()
	e.IntField("age", int64(u.Age))
	e.ObjectEnd()
}
```

### 2.2 Database Benchmarks

Database benchmarks must account for connection pool contention. Benchmarks that open a new connection per operation measure connection overhead rather than query performance, while benchmarks using `b.RunParallel` stress the pool under realistic concurrent load. Spinning up a real Postgres instance via `testcontainers-go` in `TestMain` ensures the benchmark exercises actual query plan execution rather than a mock. The suite below covers single-row reads and batch inserts with tuned connection pool settings.

```go
package db_bench_test

import (
	"context"
	"database/sql"
	"fmt"
	"strings"
	"testing"
	"time"
)

// BenchmarkDBQuery benchmarks database query performance.
// Requires a running PostgreSQL instance.
func BenchmarkDBQuery(b *testing.B) {
	db, err := sql.Open("pgx", "postgres://localhost/benchmark?sslmode=disable")
	if err != nil {
		b.Skip("postgres not available:", err)
	}
	defer db.Close()

	// Tune connection pool for benchmark.
	db.SetMaxOpenConns(50)
	db.SetMaxIdleConns(50)
	db.SetConnMaxLifetime(5 * time.Minute)

	ctx := context.Background()

	// Prepare once, reuse for all iterations: the server parses and plans the
	// SQL once, then executes it with bound parameters.
	// How much this saves is entirely query-dependent and not worth quoting a
	// ratio for. On a primary-key lookup like this one, parsing is trivial next
	// to the network round trip and the win is small. On a query with a complex
	// join whose planning dominates execution, it can be large. Measure it on
	// YOUR query against YOUR data. Anyone offering you a universal multiplier
	// for prepared statements is selling something.
	stmt, err := db.PrepareContext(ctx, "SELECT id, name, email FROM users WHERE id = $1")
	if err != nil {
		b.Fatal("prepare:", err)
	}
	defer stmt.Close()

	b.ReportAllocs()

	b.RunParallel(func(pb *testing.PB) {
		for pb.Next() {
			row := stmt.QueryRowContext(ctx, 12345)
			var id int64
			var name, email string
			if err := row.Scan(&id, &name, &email); err != nil {
				b.Error(err)
			}
		}
	})
}

// BenchmarkDBInsert compares single insert vs batch insert.
func BenchmarkDBInsert(b *testing.B) {
	db, err := sql.Open("pgx", "postgres://localhost/benchmark?sslmode=disable")
	if err != nil {
		b.Skip("postgres not available:", err)
	}
	defer db.Close()

	ctx := context.Background()

	b.Run("single-insert", func(b *testing.B) {
		i := 0
		for b.Loop() {
			_, err := db.ExecContext(ctx,
				"INSERT INTO metrics (ts, value) VALUES ($1, $2)",
				time.Now(), float64(i))
			if err != nil {
				b.Error(err)
			}
			i++
		}
	})

	b.Run("batch-1000", func(b *testing.B) {
		// Careful: one b.Loop iteration here is 1000 rows, so this arm's ns/op
		// is per batch and is NOT comparable with single-insert's per-row ns/op
		// until you divide by 1000.
		for b.Loop() {
			if err := batchInsert(ctx, db, 1000); err != nil {
				b.Error(err)
			}
		}
		// ns/op is per batch. Divide by 1000 by hand, or use b.ReportMetric:
		// b.ReportMetric(float64(b.Elapsed().Nanoseconds())/float64(1000*b.N), "ns/row")
	})
}

// batchInsert inserts n rows in a single statement:
// INSERT INTO metrics (ts, value) VALUES ($1,$2),($3,$4),...
//
// It must genuinely insert n rows. An earlier draft of this function ignored n
// and inserted exactly one row, which made "batch-1000" and "single-insert"
// measure the identical operation while appearing to prove batching wins. If
// your batch benchmark does not scale its work with n, it is not a batch
// benchmark.
//
// Postgres binds a maximum of 65535 parameters per statement, so at two columns
// per row this caps out at 32767 rows. Past that, or for bulk loads generally,
// use pgx.CopyFrom, which uses the COPY protocol and avoids parameter binding.
func batchInsert(ctx context.Context, db *sql.DB, n int) error {
	var sb strings.Builder
	sb.WriteString("INSERT INTO metrics (ts, value) VALUES ")
	args := make([]any, 0, n*2)
	now := time.Now()
	for i := 0; i < n; i++ {
		if i > 0 {
			sb.WriteByte(',')
		}
		fmt.Fprintf(&sb, "($%d,$%d)", i*2+1, i*2+2)
		args = append(args, now, float64(i))
	}
	_, err := db.ExecContext(ctx, sb.String(), args...)
	return err
}

// Redis pipeline vs individual commands: deliberately described, not stubbed.
//
// The tempting version of this benchmark has two b.Run arms whose bodies are
// entirely commented out. Do not write it. A b.Loop whose body is comments is
// an empty loop: it compiles, it runs, it prints a confident sub-nanosecond
// number, and it measures the benchmark harness. That is worse than having no
// benchmark, because it looks like evidence. If the dependency will not run,
// ship the explanation instead of the skeleton.
//
// What the real comparison measures, against a live Redis with go-redis:
//
//   - single-get: N commands, N round trips, so cost ~= N x RTT.
//   - pipeline-N: N commands, one round trip, so cost ~= RTT + N x server time.
//
// The ratio between them is therefore governed by RTT, which is a property of
// your network rather than of Redis. On loopback, RTT is tens of microseconds
// and pipelining looks modest. Across availability zones it approaches a
// millisecond and pipelining looks heroic. That is why no honest fixed number
// exists for "how much does pipelining help", and why any book quoting one
// (including this one) would be lying to you. Measure it on your own path, and
// always report the RTT next to the result or the number cannot be interpreted.
```

### 2.3 The gap between `httptest` and production

A handler that benchmarks at 2 us in `httptest` will rarely sustain 500K RPS in production, because `httptest.NewRecorder` skips the entire network stack (TCP accept, TLS handshake, HTTP/1.1 or H2 framing, response buffer flush) and ignores middleware latency from tracing, auth, metrics, and logging. A realistic performance picture needs both micro-benchmarks (to pinpoint handler-level regressions) and end-to-end load tests (to measure the full path). A common mistake is reporting the `httptest` number as if it were service throughput. It always overstates capacity, and by how much is not a constant anyone can hand you: it depends on how much of your real cost sits in TLS, in the middleware chain, and in downstream calls that `httptest` never makes. That gap is measured, not assumed. Use `httptest` benchmarks as regression guards for handler logic and as first-pass evidence for optimization PRs, but never as your capacity number. The capacity number comes from a coordinated-omission-corrected load test against a real server on representative hardware.

### 2.4 Database benchmark realism checklist

Database benchmarks are uniquely prone to lying. Four failure modes to prevent. First, benchmarking against an empty table or a warm cache, when production has 100 million rows and cold reads. Populate representative data volumes and run queries against cold caches (restart the database or use `DISCARD ALL` between runs). Second, using a single connection where production uses a pool. Call `SetMaxOpenConns` with realistic numbers and use `b.RunParallel`. Third, running on local loopback when production hits a remote host with 1 to 2 ms RTT. Compose the benchmark to include the network path, or add the RTT back to interpreted results. Fourth, running on a laptop SSD when production runs on a provisioned-IOPS cloud volume. Disk throughput differences dominate SQL cost on write-heavy workloads. A benchmark that fails to match production on any of these four dimensions produces numbers that will not predict real behavior. When you inherit a database benchmark suite, check each dimension before trusting a single digit.

### 2.5 Junior → FAANG: the handler benchmark you should commit first

For any HTTP service you own or inherit, commit one benchmark per hot handler following this template:

```go
func BenchmarkHandlerFoo(b *testing.B) {
    body := []byte(`realistic request payload`)
    handler := buildHandler()  // full middleware chain
    b.ReportAllocs()
    for b.Loop() {
        req := httptest.NewRequest("POST", "/foo", bytes.NewReader(body))
        rw := httptest.NewRecorder()
        handler.ServeHTTP(rw, req)
        if rw.Code != 200 {
            b.Fatal(rw.Code)
        }
    }
}
```

This single benchmark, committed with a known-good baseline, is the cheapest performance insurance an HTTP service can buy. It will not catch everything: it cannot see network effects, contention between concurrent requests, or anything downstream of your process. What it does catch reliably is the most common regression of all, an allocation appearing in the hot path because someone added a `fmt.Sprintf` to the middleware. Add it to CI, compare against the previous build with `benchstat`, and watch `allocs/op` in particular, since that is the number that stays honest even on a noisy shared runner.

### 2.6 Senior @ FAANG: the benchmark-as-spec pattern

Treat the benchmark as part of the handler's contract. The `ns/op` and `allocs/op` numbers are informal SLO commitments to the operational behavior of the handler. When a PR changes the handler, the benchmark tells the reviewer immediately whether the change meets or breaks the commitment. If the benchmark regresses by 20 percent, the PR needs justification before it merges. If the benchmark regresses by 100 percent, the PR is a change of commitment that needs stakeholder sign-off. Encoding this into the review process makes performance a shared responsibility rather than a specialist concern. Teams that adopt this pattern ship at predictable performance and rarely have "mysterious" regressions. Teams that do not end up treating benchmarks as reference material, consulted during incidents and ignored the rest of the time, while performance drifts unnoticed until a customer complains.

---
