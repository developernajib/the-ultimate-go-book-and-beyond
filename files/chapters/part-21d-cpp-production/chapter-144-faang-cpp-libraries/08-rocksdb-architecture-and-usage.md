## RocksDB: Architecture and Usage Patterns

RocksDB is an embedded key-value store developed at Meta (originally a fork of Google's LevelDB) optimized for fast, low-latency storage on SSDs. It powers MyRocks (MySQL storage engine), ZippyDB (Meta's distributed KV store), Manhattan (Twitter's distributed storage), Apache Kafka (log compaction), TiKV (TiDB's storage layer), and dozens of other systems. RocksDB knowledge is expected of anyone working in database infrastructure.

### LSM Tree Architecture

RocksDB uses a **Log-Structured Merge Tree (LSM tree)** rather than a B-tree. The insight: SSDs wear out from random writes but handle sequential writes much better. LSM trees convert all writes into sequential I/O.

```
Write path:
  PUT(key, val) → WAL (write-ahead log, sequential) → MemTable (in-memory skiplist)
                                                          ↓ when full
                                                   Immutable MemTable
                                                          ↓ background flush
                                                   L0 SST files (sorted)
                                                          ↓ background compaction
                                               L1 → L2 → L3 → ... → Ln SST files

Read path:
  GET(key) → MemTable → Immutable MemTable → L0 → L1 → ... → Ln
  (checked in order, stops at first match)
  Bloom filters eliminate most SST file checks
```

The trade-off: writes are fast, reads require checking multiple levels. Bloom filters (per SST file) make point reads fast by filtering out levels where the key cannot exist. Compaction merges overlapping SST files and removes tombstones, keeping the read path efficient.

### Core API

RocksDB's core API uses `rocksdb::Slice` rather than `std::string` for keys and values, avoiding copies when the data is already in memory. `options.create_if_missing = true` is the standard production setting for databases that should be bootstrapped on first run. Always check the returned `rocksdb::Status` from `Open`, `Put`, and `Get` rather than assuming success, since RocksDB errors often indicate I/O problems or SST file corruption.
```cpp
#include "rocksdb/db.h"
#include "rocksdb/options.h"
#include "rocksdb/slice.h"

rocksdb::DB*      db;
rocksdb::Options  options;

options.create_if_missing = true;
options.compression = rocksdb::kLZ4Compression;

// Open the database
rocksdb::Status s = rocksdb::DB::Open(options, "/data/mydb", &db);
assert(s.ok());

// Write
rocksdb::WriteOptions write_opts;
s = db->Put(write_opts, "user:1001:name", "Alice");
assert(s.ok());

// Read
rocksdb::ReadOptions read_opts;
std::string value;
s = db->Get(read_opts, "user:1001:name", &value);
if (s.IsNotFound()) {
    // Key doesn't exist
} else if (s.ok()) {
    // value == "Alice"
}

// Delete
s = db->Delete(write_opts, "user:1001:name");

// Always close properly
delete db;
```

### Column Families: Key-Space Partitioning

Column families are separate key spaces within a single RocksDB instance. They share the WAL but have independent MemTables, SST files, and compaction. Use them to isolate different data types (e.g., user records vs. session tokens) with different access patterns.

```cpp
#include "rocksdb/db.h"

// Open with multiple column families
std::vector<rocksdb::ColumnFamilyDescriptor> cf_descs = {
    {rocksdb::kDefaultColumnFamilyName, rocksdb::ColumnFamilyOptions()},
    {"users",    rocksdb::ColumnFamilyOptions()},
    {"sessions", rocksdb::ColumnFamilyOptions()},
};

std::vector<rocksdb::ColumnFamilyHandle*> handles;
rocksdb::DB* db;
rocksdb::DBOptions db_opts;
db_opts.create_if_missing = true;
db_opts.create_missing_column_families = true;

rocksdb::Status s = rocksdb::DB::Open(db_opts, "/data/mydb", cf_descs,
                                       &handles, &db);
assert(s.ok());

rocksdb::ColumnFamilyHandle* users_cf    = handles[1];
rocksdb::ColumnFamilyHandle* sessions_cf = handles[2];

// Read/Write with column family handle
db->Put(rocksdb::WriteOptions(), users_cf, "1001", serialized_user);
db->Get(rocksdb::ReadOptions(), sessions_cf, session_token, &session_data);

// Clean up handles
for (auto* handle : handles) db->DestroyColumnFamilyHandle(handle);
delete db;
```

### WriteBatch: Atomic Multi-Key Writes

C++ atomic operations provide lock-free access to shared variables with explicit memory ordering guarantees, replacing the need for a mutex in many low-level synchronization scenarios. Choosing the correct memory order, `relaxed`, `acquire`, `release`, or `seq_cst`, is critical for correctness and for extracting maximum performance on weakly-ordered architectures.
```cpp
#include "rocksdb/write_batch.h"

// All operations in a batch are applied atomically
rocksdb::WriteBatch batch;
batch.Put(users_cf, "user:1001", new_user_data);
batch.Put(sessions_cf, "sess:abc123", session_data);
batch.Delete(users_cf, "user:1000");  // remove old user
batch.Put("audit_log", "update:1001", timestamp);

rocksdb::WriteOptions wo;
wo.sync = true;  // fsync before returning -- durability guarantee
rocksdb::Status s = db->Write(wo, &batch);
```

### Range Scans with Iterators

Iterators abstract over traversal, decoupling algorithms from container implementations and enabling the standard algorithms to work uniformly across arrays, linked lists, trees, and custom data structures. Implementing the required iterator concept integrates a custom type with the entire standard library algorithm suite.
```cpp
#include "rocksdb/iterator.h"

// Prefix scan: all keys starting with "user:"
rocksdb::ReadOptions read_opts;
std::unique_ptr<rocksdb::Iterator> it(db->NewIterator(read_opts, users_cf));

std::string prefix = "user:";
for (it->Seek(prefix);
     it->Valid() && it->key().starts_with(prefix);
     it->Next()) {
    rocksdb::Slice key   = it->key();
    rocksdb::Slice value = it->value();
    process_record(key.data(), key.size(), value.data(), value.size());
}

if (!it->status().ok()) {
    LOG(ERROR) << "Iterator error: " << it->status().ToString();
}

// Reverse scan
it->SeekForPrev("user:~");  // '~' is after all alphanumerics
while (it->Valid() && it->key().starts_with(prefix)) {
    process_record(it->key(), it->value());
    it->Prev();
}
```

### Snapshots: Point-in-Time Reads

A RocksDB snapshot captures a consistent read view at the moment it is created. All reads through a `ReadOptions` struct pointing to that snapshot see a stable version of the database even as concurrent writers commit new data. Snapshots must be explicitly released with `db->ReleaseSnapshot(snap)` to allow RocksDB to garbage-collect old SST files, failing to release long-lived snapshots is the most common source of unexpected disk space growth in production RocksDB deployments.
```cpp
// Create a snapshot -- reads from this point, even as new writes arrive
const rocksdb::Snapshot* snap = db->GetSnapshot();

rocksdb::ReadOptions snap_read;
snap_read.snapshot = snap;

// This iterator sees the database as it was at snapshot time
std::unique_ptr<rocksdb::Iterator> it(db->NewIterator(snap_read));
// ... scan or read ...

// Release when done -- allows compaction to reclaim space
db->ReleaseSnapshot(snap);
```

### Tuning for Production

The three most impactful RocksDB production tuning knobs are: block cache size (30-50% of RAM for read-heavy workloads), `write_buffer_size` (the memtable size before flush), and `max_background_compactions` (parallel compaction threads). Setting `compression_per_level` to use Snappy or LZ4 on the upper levels and Zstd on the bottommost level balances CPU overhead against the dramatic space savings that matter most for cold data stored on SSDs.
```cpp
rocksdb::Options options;

// Block cache -- cache frequently read SST blocks in memory
// Sizing: 30-50% of available RAM for read-heavy workloads
auto cache = rocksdb::NewLRUCache(4ULL * 1024 * 1024 * 1024);  // 4GB
rocksdb::BlockBasedTableOptions table_opts;
table_opts.block_cache = cache;
// Bloom filter: 10 bits per key, reduces disk reads by ~95%
table_opts.filter_policy.reset(rocksdb::NewBloomFilterPolicy(10));
table_opts.block_size = 16 * 1024;  // 16KB blocks -- balance read/cache use
options.table_factory.reset(rocksdb::NewBlockBasedTableFactory(table_opts));

// Write buffer -- larger = less frequent flushes = less write amplification
options.write_buffer_size = 128 * 1024 * 1024;  // 128MB MemTable
options.max_write_buffer_number = 3;

// Compaction style
options.compaction_style = rocksdb::kCompactionStyleLevel;
options.max_bytes_for_level_base = 512 * 1024 * 1024;  // 512MB for L1
options.level_compaction_dynamic_level_bytes = true;    // auto-scale levels

// Parallelism
options.max_background_jobs = 4;       // compaction + flush threads
options.IncreaseParallelism(cpus / 2); // background thread pool

// Compression per level -- fast for hot data, aggressive for cold
options.compression_per_level = {
    rocksdb::kNoCompression,    // L0 -- written and compacted fast
    rocksdb::kNoCompression,    // L1
    rocksdb::kLZ4Compression,   // L2+
    rocksdb::kLZ4Compression,
    rocksdb::kZSTD,             // Ln -- cold data, max compression
};
```

### Go Comparison

The Go ecosystem has two relevant options:

1. **`github.com/linxGnu/grocksdb`**: CGo bindings to RocksDB. Same API, FFI overhead on every call, requires RocksDB to be compiled and linked. Used when you need RocksDB's exact performance characteristics.

2. **`github.com/dgraph-io/badger`**: Pure Go LSM store inspired by WiscKey (a RocksDB variant). No CGo, idiomatic Go API, slightly lower peak performance but easier to deploy and reason about.

```go
// Badger -- idiomatic Go API, same LSM concepts
db, _ := badger.Open(badger.DefaultOptions("/data/mydb"))
defer db.Close()

// Write
db.Update(func(txn *badger.Txn) error {
    return txn.Set([]byte("key"), []byte("value"))
})

// Read
db.View(func(txn *badger.Txn) error {
    item, err := txn.Get([]byte("key"))
    if err != nil { return err }
    return item.Value(func(val []byte) error {
        fmt.Println(string(val))
        return nil
    })
})
```

The LSM concepts, MemTable, L0-Ln levels, bloom filters, compaction, column families, are identical between RocksDB and Badger. Learning one transfers directly to the other.

---
