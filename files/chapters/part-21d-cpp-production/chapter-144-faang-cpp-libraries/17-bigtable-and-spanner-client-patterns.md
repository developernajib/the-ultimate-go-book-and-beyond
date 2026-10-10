## Bigtable and Spanner Client Patterns

The Google Cloud C++ client libraries (`google-cloud-cpp`) ship the same access patterns Google engineers use internally for Bigtable and Spanner. The APIs are different, the semantics are different, and getting them wrong means data loss or silent inconsistency. This file covers the patterns that production code uses.

### Bigtable Mental Model

Bigtable is a sparse, distributed, persistent multi-dimensional sorted map. The dimensions:

- Row key (bytes, sorted, contiguous ranges live on the same tablet).
- Column family (declared at table creation, fixed schema for GC and encoding).
- Column qualifier (bytes, dynamic, no schema).
- Timestamp (microseconds, multi-version per cell).
- Value (bytes).

A table can have hundreds of column families. Each cell can have multiple timestamped versions (the GC policy decides retention).

Critical: row keys determine load distribution. A monotonically increasing key (timestamp prefix) creates a hot tablet. Reverse-timestamp or hash prefixes spread load.

### Bigtable C++ Client Basics

```cpp
#include "google/cloud/bigtable/table.h"
namespace cbt = ::google::cloud::bigtable;

auto data_client = cbt::MakeDataClient("my-project", "my-instance");
cbt::Table table(data_client, "my-table");

// Single-row mutation
auto status = table.Apply(cbt::SingleRowMutation(
    "user#42",
    cbt::SetCell("profile", "name", "alice"),
    cbt::SetCell("profile", "email", "alice@example.com")));
if (!status.ok()) { /* handle */ }

// Read one row
auto row = table.ReadRow("user#42", cbt::Filter::Latest(1));
if (!row.ok()) { /* RPC failed */ }
if (!row->first) { /* row missing */ }
for (const auto& cell : row->second.cells()) {
  // cell.family_name(), cell.column_qualifier(), cell.value()
}
```

Mutations are atomic per row, never across rows. There is no multi-row transaction in Bigtable.

### Scans

Range scans are the bread and butter:

```cpp
cbt::RowRange range = cbt::RowRange::Range("user#000", "user#999");
auto reader = table.ReadRows(range, cbt::Filter::Latest(1));
for (auto& row : reader) {
  if (!row) break;  // error or end
  Process(*row);
}
```

`RowRange::Prefix("user#")` is shorthand for the right-open range. Filters compose: `Chain`, `Interleave`, `Condition`, `ColumnRangeClosed`, `TimestampRangeMicros`, `ValueRegex`.

A reader streams as long as you iterate. Closing it cancels the underlying gRPC stream.

### Bigtable Retry Budgets

The client retries automatically on UNAVAILABLE, DEADLINE_EXCEEDED, ABORTED. For mutations, only idempotent mutations are retried by default. `SetCell` with an explicit timestamp is idempotent (same write twice produces the same result). `SetCell` with the default timestamp (server-assigned) is not idempotent, since two retries produce two cells.

Configure the retry budget:

```cpp
auto opts = google::cloud::Options{}
    .set<cbt::DataRetryPolicyOption>(
        cbt::LimitedTimeRetryPolicy(std::chrono::seconds(30)).clone())
    .set<cbt::DataBackoffPolicyOption>(
        cbt::ExponentialBackoffPolicy(
            std::chrono::milliseconds(10),
            std::chrono::seconds(2)).clone());
auto data_client = cbt::MakeDataClient("p", "i", opts);
```

The retry policy is per-operation. The backoff policy is per-attempt. The `LimitedTimeRetryPolicy` caps total wall time. `LimitedErrorCountRetryPolicy` caps attempt count.

### Spanner Mental Model

Spanner is a globally distributed SQL database with serializable transactions and external consistency (linearizability across regions). The client speaks SQL or a row-level mutation API.

Two transaction types:

- Read-only transactions: lock-free, MVCC at a snapshot. Fast, scalable, do not block writers.
- Read-write transactions: pessimistic locking, two-phase commit across replicas. Slower, can ABORT and require retry.

### Spanner C++ Client Read-Only

```cpp
#include "google/cloud/spanner/client.h"
namespace spanner = ::google::cloud::spanner;

auto client = spanner::Client(spanner::MakeConnection(
    spanner::Database("project", "instance", "database")));

auto reader = client.ExecuteQuery(
    spanner::SqlStatement("SELECT id, name FROM users WHERE region = @r",
                          {{"r", spanner::Value("us-east")}}));

for (auto& row : spanner::StreamOf<std::tuple<std::int64_t, std::string>>(reader)) {
  if (!row) break;
  auto [id, name] = *row;
}
```

By default reads use a strong read at "now". For reduced latency, use a stale read:

```cpp
auto opts = spanner::ReadOptions{};
auto txn = spanner::MakeReadOnlyTransaction(
    spanner::Transaction::ReadOnlyOptions(std::chrono::seconds(15)));
auto reader = client.ExecuteQuery(txn, statement);
```

The `15s` is exact-staleness: the read sees a snapshot 15 seconds in the past. Spanner replicates within seconds, so a 15-second stale read is served by any local replica without consulting Paxos. Massive latency win for read-heavy workloads.

### TrueTime

Spanner's external consistency depends on TrueTime: every node knows the current time within a bounded uncertainty (`TT.now()` returns `[earliest, latest]`). Commit timestamps are chosen after the uncertainty interval passes, so any later transaction sees a strictly greater timestamp.

In the public client, you do not see TrueTime directly. You see commit timestamps as `spanner::Timestamp`, monotonic across writes. For audit logs and event ordering, store commit timestamps from `client.Commit().value().commit_timestamp`.

### Spanner Read-Write Transactions

Read-write transactions in C++ use a callback that may be invoked multiple times (on ABORT):

```cpp
auto status = client.Commit(
    [&](spanner::Transaction txn) -> google::cloud::StatusOr<spanner::Mutations> {
      auto reader = client.ExecuteQuery(
          txn, spanner::SqlStatement(
                   "SELECT balance FROM accounts WHERE id = @id",
                   {{"id", spanner::Value(account_id)}}));
      // Read current balance.
      std::int64_t balance = 0;
      for (auto& row : spanner::StreamOf<std::tuple<std::int64_t>>(reader)) {
        if (!row) return std::move(row).status();
        balance = std::get<0>(*row);
      }
      if (balance < amount) return google::cloud::Status(
          google::cloud::StatusCode::kFailedPrecondition, "insufficient funds");

      return spanner::Mutations{
          spanner::UpdateMutationBuilder("accounts", {"id", "balance"})
              .EmplaceRow(account_id, balance - amount)
              .Build()};
    });
```

The callback returns mutations, which the client commits atomically. If commit fails with ABORTED, the client re-invokes the callback (with a fresh transaction) until it succeeds or hits the retry budget. Your callback must therefore be a pure function of the database state. Side effects (logging, sending an email) must be deferred until after Commit returns OK.

This is the most common bug. Engineers print "transferred $X" inside the callback. On retry, they print twice.

### Idempotency Keys

For external side effects that must happen exactly once, store an idempotency key in the transaction:

```cpp
// In the same RW transaction, insert an "operations" row with a unique client-supplied UUID.
// On retry from the application layer (e.g. user clicks twice), check if the UUID exists.
```

The key must be stored in the same transaction as the side effect. Otherwise you have a race where the key is recorded and the side effect fails (or vice versa).

### Partial-Failure Handling

Bigtable batch mutations partially succeed. `BulkApply` returns a list of failed mutations. You retry only the failed ones:

```cpp
cbt::BulkMutation bulk;
for (auto& [key, value] : updates) {
  bulk.emplace_back(cbt::SingleRowMutation(
      key, cbt::SetCell("data", "v", value)));
}
auto failures = table.BulkApply(std::move(bulk));
for (auto& f : failures) {
  if (f.status().code() == google::cloud::StatusCode::kFailedPrecondition) {
    // Permanent. Log, do not retry.
  } else {
    // Transient. Resubmit f.original_index().
  }
}
```

Spanner does not have partial commits. A read-write transaction either fully commits or fully aborts.

### Connection Pooling

Both libraries pool gRPC channels. Default is one channel per CPU core. For very high QPS, increase:

```cpp
auto opts = google::cloud::Options{}.set<spanner::SessionPoolMinSessionsOption>(100)
                                    .set<spanner::SessionPoolMaxSessionsOption>(400);
```

Spanner sessions are server-side state (one per active transaction). The session pool reuses them. Too few sessions means queuing. Too many means wasted memory on the server. Tune to peak concurrency.

### Junior to FAANG: Don't Treat NoSQL Like SQL

A junior engineer reads "Bigtable is a database" and reaches for SELECT, JOIN, UPDATE WHERE. None of those exist. A FAANG-track engineer designs the row key first, plans the column families with GC policies in mind, and accepts that joins happen in the application or in a downstream system (BigQuery, Spanner).

### Senior at FAANG: Choosing the Right Store

Senior engineers know which store fits which workload:

- Bigtable: time series, IoT, analytical scans, LSM-friendly writes, 100+ MB rows OK if you must.
- Spanner: anything needing transactions, secondary indexes, foreign keys, SQL.
- Firestore: small documents with deep paths, mobile sync use cases.
- Memorystore (Redis): hot caches, session state, ephemeral data.

The wrong choice early bakes in a year-long migration later. Get it right at the design review.
