## Write-Ahead Log (WAL): Crash Recovery and Durability

The Write-Ahead Log is the mechanism that gives databases their durability guarantee. The golden rule is simple and absolute: **a WAL record describing a change must be flushed to disk before the corresponding data page is modified**. If the system crashes at any point, the WAL provides enough information to reconstruct exactly which transactions committed and which did not.

Without a WAL, a database that crashes mid-write could leave a data page in a partially-written state with no way to determine whether it represents a committed transaction. This is a silent data corruption that the user might never detect.

### WAL Record Structure

Every operation that modifies data, INSERT, UPDATE, DELETE, produces a WAL record. Each record has a Log Sequence Number (LSN), a monotonically increasing 64-bit integer that globally orders all operations.

```cpp
#include <cassert>
#include <cstdint>
#include <cstring>
#include <fstream>
#include <functional>
#include <iostream>
#include <stdexcept>
#include <string>
#include <vector>

enum class WALRecordType : uint8_t {
    INSERT     = 1,
    UPDATE     = 2,
    DELETE     = 3,
    COMMIT     = 4,
    ABORT      = 5,
    CHECKPOINT = 6,
    BEGIN      = 7,
};

struct WALRecord {
    uint64_t      lsn;         // Log Sequence Number
    uint64_t      txn_id;      // Transaction that produced this record
    WALRecordType type;
    uint32_t      data_length;
    // Variable-length payload follows: key + value for INSERT/UPDATE,
    // key only for DELETE, nothing for COMMIT/ABORT/CHECKPOINT
    uint32_t      checksum;    // CRC32 over everything above

    // Serialized total size (not including variable data here for brevity)
    static constexpr size_t HEADER_SIZE = sizeof(uint64_t) * 2
                                        + sizeof(WALRecordType)
                                        + sizeof(uint32_t) * 2;
};

// Simple CRC32 (production uses zlib or hardware-accelerated CRC32C)
static uint32_t crc32_simple(const void* data, size_t len) {
    const auto* p = static_cast<const uint8_t*>(data);
    uint32_t crc = 0xFFFFFFFF;
    for (size_t i = 0; i < len; ++i) {
        crc ^= p[i];
        for (int j = 0; j < 8; ++j) {
            crc = (crc >> 1) ^ (0xEDB88320 & -(crc & 1));
        }
    }
    return crc ^ 0xFFFFFFFF;
}
```

### WAL Implementation: Append, Sync, Recover

The WAL class maintains an in-memory write buffer to batch log records before calling `fsync`, trading per-record durability for throughput when multiple transactions are in flight. The `recover()` method replays all records with LSN greater than the last checkpoint LSN, reconstructing the in-memory state after a crash without touching the data files, the core guarantee that makes WAL the standard durability mechanism in databases like PostgreSQL and SQLite.
```cpp
class WAL {
    std::fstream file_;
    std::string  path_;
    uint64_t     next_lsn_ = 1;
    uint64_t     checkpoint_lsn_ = 0;

    // In-memory write buffer to batch records before fsync
    std::vector<char> write_buffer_;
    static constexpr size_t BUFFER_CAP = 64 * 1024;  // 64KB

public:
    explicit WAL(const std::string& path) : path_(path) {
        // Open for read+write+append - create if absent
        file_.open(path, std::ios::in | std::ios::out |
                         std::ios::binary | std::ios::app);
        if (!file_.is_open()) {
            file_.open(path, std::ios::out | std::ios::binary);
            file_.close();
            file_.open(path, std::ios::in | std::ios::out |
                             std::ios::binary | std::ios::app);
        }
        write_buffer_.reserve(BUFFER_CAP);
    }

    // Append a record to the WAL buffer. Does NOT fsync yet.
    uint64_t append(uint64_t txn_id, WALRecordType type,
                    const std::string& key   = "",
                    const std::string& value = "")
    {
        uint64_t lsn = next_lsn_++;

        WALRecord hdr;
        hdr.lsn         = lsn;
        hdr.txn_id      = txn_id;
        hdr.type        = type;
        hdr.data_length = static_cast<uint32_t>(key.size() + value.size() + 8);
        hdr.checksum    = crc32_simple(&hdr, WALRecord::HEADER_SIZE - 4);

        // Serialize header
        auto append_bytes = [&](const void* src, size_t n) {
            const char* p = static_cast<const char*>(src);
            write_buffer_.insert(write_buffer_.end(), p, p + n);
        };

        append_bytes(&hdr.lsn,         8);
        append_bytes(&hdr.txn_id,      8);
        append_bytes(&hdr.type,        1);
        append_bytes(&hdr.data_length, 4);

        uint32_t klen = key.size(), vlen = value.size();
        append_bytes(&klen, 4);
        append_bytes(key.data(), key.size());
        append_bytes(&vlen, 4);
        append_bytes(value.data(), value.size());
        append_bytes(&hdr.checksum, 4);

        return lsn;
    }

    // Flush buffer to disk and fsync. Called on COMMIT.
    // Group commit: multiple transactions share one fsync by accumulating
    // in the buffer and syncing together, amortizes I/O latency.
    void sync() {
        if (write_buffer_.empty()) return;
        file_.write(write_buffer_.data(), write_buffer_.size());
        file_.flush();
        // In production: call fsync(fd) here to guarantee durability.
        // file_.flush() only flushes the C++ stream buffer, not the OS cache.
        // Real code: int fd = ...; fsync(fd);
        write_buffer_.clear();
    }

    // Write a CHECKPOINT record and record the LSN floor.
    // Recovery only needs to replay from checkpoint_lsn_ forward.
    void checkpoint(uint64_t dirty_page_lsn) {
        append(0, WALRecordType::CHECKPOINT);
        sync();
        checkpoint_lsn_ = dirty_page_lsn;
    }

    // Replay WAL from checkpoint_lsn_ forward.
    // apply_fn receives (lsn, txn_id, type, key, value) for each record.
    void recover(std::function<void(uint64_t, uint64_t, WALRecordType,
                                    const std::string&, const std::string&)>
                 apply_fn)
    {
        std::ifstream in(path_, std::ios::binary);
        if (!in.is_open()) return;

        // Scan forward, collecting all records
        struct Entry {
            uint64_t      lsn, txn_id;
            WALRecordType type;
            std::string   key, value;
        };
        std::vector<Entry> records;

        while (in.peek() != EOF) {
            Entry e;
            uint32_t klen = 0, vlen = 0, checksum = 0, data_len = 0;
            uint8_t  type_byte = 0;

            if (!in.read(reinterpret_cast<char*>(&e.lsn),    8)) break;
            if (!in.read(reinterpret_cast<char*>(&e.txn_id), 8)) break;
            if (!in.read(reinterpret_cast<char*>(&type_byte),1)) break;
            e.type = static_cast<WALRecordType>(type_byte);
            if (!in.read(reinterpret_cast<char*>(&data_len), 4)) break;
            if (!in.read(reinterpret_cast<char*>(&klen),     4)) break;
            e.key.resize(klen);
            if (klen && !in.read(e.key.data(), klen)) break;
            if (!in.read(reinterpret_cast<char*>(&vlen),     4)) break;
            e.value.resize(vlen);
            if (vlen && !in.read(e.value.data(), vlen)) break;
            if (!in.read(reinterpret_cast<char*>(&checksum), 4)) break;

            if (e.lsn >= checkpoint_lsn_) {
                records.push_back(std::move(e));
            }
        }

        // ARIES-style recovery: three passes
        // Pass 1: Analysis, find the set of committed transactions
        std::unordered_set<uint64_t> committed;
        for (auto& r : records) {
            if (r.type == WALRecordType::COMMIT) committed.insert(r.txn_id);
        }

        // Pass 2: REDO, replay all operations of committed transactions
        for (auto& r : records) {
            if (r.type != WALRecordType::COMMIT &&
                r.type != WALRecordType::ABORT  &&
                r.type != WALRecordType::CHECKPOINT &&
                committed.count(r.txn_id))
            {
                apply_fn(r.lsn, r.txn_id, r.type, r.key, r.value);
            }
        }

        // Pass 3: UNDO, in reverse order, undo uncommitted transactions
        // (omitted here for brevity - real UNDO uses compensation log records)
    }
};
```

### The ARIES Algorithm

ARIES (Algorithm for Recovery and Isolation Exploiting Semantics), published by Mohan et al. In 1992, is the recovery algorithm used by IBM DB2, SQL Server, and forms the basis of PostgreSQL's WAL recovery. It has three phases:

**Analysis pass**: Scan WAL from the last checkpoint forward. Rebuild the "dirty page table" (which pages were modified after the checkpoint) and the "active transaction table" (which transactions were in progress at crash time).

**Redo pass**: Start from the oldest LSN in the dirty page table. Re-apply every logged operation, even those already on disk, to bring all pages to their state at crash time. This is safe because WAL records are idempotent given an LSN check: if the page's current LSN ≥ the record's LSN, skip it.

**Undo pass**: Walk backwards through the WAL. For every uncommitted transaction (those in the active transaction table that never got a COMMIT record), apply the undo operation. Each undo step writes a Compensation Log Record (CLR) so that if the system crashes again during undo, the already-undone work is not repeated.

### Group Commit

A naive WAL calls `fsync()` once per committed transaction. On a typical NVMe SSD, `fsync()` takes 50-100µs. This means a single-threaded transaction rate of at most 10,000-20,000 transactions per second.

Group commit batches multiple transactions into one `fsync()` call:

```cpp
// Group commit: accumulate COMMIT records from multiple transactions
// in the WAL buffer, then issue one fsync for all of them.
// PostgreSQL's group commit is controlled by commit_delay and
// synchronous_commit GUC parameters.
class GroupCommitWAL : public WAL {
    std::mutex   mu_;
    std::condition_variable cv_;
    uint64_t     pending_commits_ = 0;
    static constexpr int GROUP_SIZE = 64;    // sync after 64 commits
    static constexpr int DELAY_US   = 100;   // or after 100µs

public:
    using WAL::WAL;

    void commit_and_sync(uint64_t txn_id) {
        std::unique_lock lock(mu_);
        append(txn_id, WALRecordType::COMMIT);
        ++pending_commits_;

        if (pending_commits_ >= GROUP_SIZE) {
            sync();        // one fsync for GROUP_SIZE transactions
            pending_commits_ = 0;
            cv_.notify_all();
        } else {
            // Wait briefly for more transactions to join the group
            cv_.wait_for(lock, std::chrono::microseconds(DELAY_US),
                [this] { return pending_commits_ == 0; });
            if (pending_commits_ > 0) {
                sync();
                pending_commits_ = 0;
                cv_.notify_all();
            }
        }
    }
};
```

With a group of 64 transactions sharing one `fsync()`, throughput jumps from ~20,000 to ~1,280,000 transactions per second, a 64× improvement for the same hardware.

### Go Comparison

`go.etcd.io/etcd/server/wal` is etcd's WAL implementation, written in Go. It serializes `raftpb.Entry` protobufs rather than database records. The sync model is the same: append to an in-memory buffer, flush to disk on commit. Because etcd does not need ARIES-style UNDO (Raft consensus ensures only committed entries are applied), it can use a simpler two-pass recovery: replay all committed entries in order. The WAL files are capped at a configurable size (default 64 MB) and older files are deleted after a snapshot.

---
