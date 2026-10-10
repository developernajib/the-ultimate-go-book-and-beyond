## Building a Simple Key-Value Store in C++

The best way to consolidate everything in this chapter is to build a production-inspired key-value store that uses the structures we have covered. This implementation has a WAL for durability, a skip list as the in-memory memtable, SST flush when the memtable exceeds a size threshold, and a bloom filter to avoid unnecessary disk reads. It is intentionally simplified, no compaction, no block compression, no concurrent flush, but the architecture is authentic.

### Architecture

The KV store's data path follows the LSM-tree model: `Put` appends to the WAL for durability then inserts into the in-memory memtable. When the memtable exceeds a size threshold it is flushed to an immutable SST file and the WAL is truncated. `Get` checks the memtable first, then probes SST files from newest to oldest using a Bloom filter to skip files that definitely do not contain the key, bounding the worst-case read to a small number of SST files.
```
Put(k, v)  →  WAL.append(k, v)  →  memtable.insert(k, v)
                                         │ when size > threshold
                                         ▼
                                    flush_to_sst()
                                    WAL.truncate()

Get(k)     →  memtable.find(k)
                   │ not found
                   ▼
              for each SST (newest first):
                  bloom_filter.maybe_contains(k)?
                      yes → binary search in SST
                      no  → skip SST
```

### Implementation

The `KVStore` implementation combines the three subsystems, WAL, memtable (`std::map` sorted for SST serialization), and SST file list, under a single mutex. The `flush_memtable` function serializes the sorted memtable to an SST file as key-value pairs and clears the WAL checkpoint, so recovery after a crash only needs to replay WAL records written after the last flush.
```cpp
#include <algorithm>
#include <cassert>
#include <climits>
#include <cmath>
#include <cstdint>
#include <cstring>
#include <fstream>
#include <functional>
#include <iostream>
#include <mutex>
#include <optional>
#include <shared_mutex>
#include <sstream>
#include <string>
#include <vector>

// ---- Bloom Filter (from section 02) ------------------------------------

static uint64_t bloom_hash(const std::string& key, uint64_t seed) {
    uint64_t h = seed ^ 0xdeadbeefcafe0000ULL;
    for (char c : key) {
        h ^= static_cast<uint8_t>(c);
        h *= 0xff51afd7ed558ccdULL;
        h ^= h >> 33;
    }
    return h;
}

struct BloomFilter {
    std::vector<uint8_t> bits;
    size_t               num_bits;
    int                  num_hashes;

    explicit BloomFilter(size_t expected, int bpk = 10)
        : num_bits(expected * bpk)
        , num_hashes(static_cast<int>(std::round(bpk * std::log(2.0))))
    {
        bits.assign((num_bits + 7) / 8, 0);
    }

    void insert(const std::string& key) {
        for (int i = 0; i < num_hashes; ++i) {
            size_t pos = bloom_hash(key, i) % num_bits;
            bits[pos / 8] |= (1u << (pos % 8));
        }
    }

    bool maybe_contains(const std::string& key) const {
        for (int i = 0; i < num_hashes; ++i) {
            size_t pos = bloom_hash(key, i) % num_bits;
            if (!(bits[pos / 8] >> (pos % 8) & 1)) return false;
        }
        return true;
    }

    // Serialize to bytes for SST header
    std::vector<uint8_t> serialize() const {
        std::vector<uint8_t> out;
        uint32_t nb = static_cast<uint32_t>(num_bits);
        uint32_t nh = static_cast<uint32_t>(num_hashes);
        out.insert(out.end(), reinterpret_cast<uint8_t*>(&nb),
                              reinterpret_cast<uint8_t*>(&nb) + 4);
        out.insert(out.end(), reinterpret_cast<uint8_t*>(&nh),
                              reinterpret_cast<uint8_t*>(&nh) + 4);
        out.insert(out.end(), bits.begin(), bits.end());
        return out;
    }

    static BloomFilter deserialize(const uint8_t* data, size_t len) {
        uint32_t nb, nh;
        std::memcpy(&nb, data, 4);
        std::memcpy(&nh, data + 4, 4);
        BloomFilter bf(0);
        bf.num_bits   = nb;
        bf.num_hashes = static_cast<int>(nh);
        bf.bits.assign(data + 8, data + len);
        return bf;
    }
};

// ---- Skip List Memtable -----------------------------------------------
// (Simplified version from section 07)

struct SkipNode {
    std::string              key;
    std::string              value;
    bool                     deleted = false;  // tombstone marker
    std::vector<SkipNode*>   forward;

    SkipNode(const std::string& k, const std::string& v, int level, bool del)
        : key(k), value(v), deleted(del), forward(level + 1, nullptr) {}
};

class Memtable {
    SkipNode*          head_;
    int                level_ = 0;
    size_t             size_  = 0;  // approximate bytes
    static constexpr int MAX_LEVEL = 12;

    int random_level() {
        int lvl = 0;
        while ((rand() % 2) == 0 && lvl < MAX_LEVEL) ++lvl;
        return lvl;
    }

public:
    Memtable() {
        head_ = new SkipNode("", "", MAX_LEVEL, false);
    }

    ~Memtable() {
        SkipNode* cur = head_;
        while (cur) { SkipNode* n = cur->forward[0]; delete cur; cur = n; }
    }

    void put(const std::string& key, const std::string& value) {
        std::vector<SkipNode*> update(MAX_LEVEL + 1);
        SkipNode* cur = head_;
        for (int i = level_; i >= 0; --i) {
            while (cur->forward[i] && cur->forward[i]->key < key)
                cur = cur->forward[i];
            update[i] = cur;
        }
        cur = cur->forward[0];

        if (cur && cur->key == key) {
            cur->value   = value;
            cur->deleted = false;
            return;
        }

        int nl = random_level();
        if (nl > level_) {
            for (int i = level_ + 1; i <= nl; ++i) update[i] = head_;
            level_ = nl;
        }

        auto* node = new SkipNode(key, value, nl, false);
        for (int i = 0; i <= nl; ++i) {
            node->forward[i]    = update[i]->forward[i];
            update[i]->forward[i] = node;
        }
        size_ += key.size() + value.size() + 64;
    }

    void del(const std::string& key) {
        // Insert tombstone: logical delete
        put(key, "");
        // Find and mark deleted
        SkipNode* cur = head_;
        for (int i = level_; i >= 0; --i) {
            while (cur->forward[i] && cur->forward[i]->key < key)
                cur = cur->forward[i];
        }
        cur = cur->forward[0];
        if (cur && cur->key == key) cur->deleted = true;
    }

    struct LookupResult {
        bool found;
        bool deleted;
        std::string value;
    };

    LookupResult get(const std::string& key) const {
        SkipNode* cur = head_;
        for (int i = level_; i >= 0; --i) {
            while (cur->forward[i] && cur->forward[i]->key < key)
                cur = cur->forward[i];
        }
        cur = cur->forward[0];
        if (cur && cur->key == key) {
            return {true, cur->deleted, cur->value};
        }
        return {false, false, ""};
    }

    // Sorted iteration for SST flush
    void for_each(std::function<void(const std::string&,
                                     const std::string&, bool)> fn) const
    {
        for (SkipNode* cur = head_->forward[0]; cur; cur = cur->forward[0]) {
            fn(cur->key, cur->value, cur->deleted);
        }
    }

    size_t approximate_size() const { return size_; }
};

// ---- SST File ---------------------------------------------------------

struct SST {
    std::string                              path;
    BloomFilter                              bloom;
    std::vector<std::pair<std::string,std::string>> entries;  // in memory after load
    std::string                              min_key, max_key;

    explicit SST(const std::string& p, size_t expected_keys)
        : path(p), bloom(expected_keys) {}

    // Write sorted entries to disk with bloom filter header
    void write(const std::vector<std::pair<std::string, std::string>>& kv) {
        // Build bloom filter
        for (auto& [k, _] : kv) bloom.insert(k);
        if (!kv.empty()) {
            min_key = kv.front().first;
            max_key = kv.back().first;
        }

        std::ofstream f(path, std::ios::binary | std::ios::trunc);
        // Write bloom filter
        auto bf_bytes = bloom.serialize();
        uint32_t bf_size = static_cast<uint32_t>(bf_bytes.size());
        f.write(reinterpret_cast<char*>(&bf_size), 4);
        f.write(reinterpret_cast<char*>(bf_bytes.data()), bf_bytes.size());

        // Write sorted key-value pairs
        for (auto& [k, v] : kv) {
            uint32_t klen = k.size(), vlen = v.size();
            f.write(reinterpret_cast<char*>(&klen), 4);
            f.write(k.data(), klen);
            f.write(reinterpret_cast<char*>(&vlen), 4);
            f.write(v.data(), vlen);
        }
        entries = kv;
    }

    // Load bloom filter and all entries from disk
    void load() {
        std::ifstream f(path, std::ios::binary);
        if (!f.is_open()) return;

        uint32_t bf_size = 0;
        f.read(reinterpret_cast<char*>(&bf_size), 4);
        std::vector<uint8_t> bf_bytes(bf_size);
        f.read(reinterpret_cast<char*>(bf_bytes.data()), bf_size);
        bloom = BloomFilter::deserialize(bf_bytes.data(), bf_bytes.size());

        entries.clear();
        while (f.peek() != EOF) {
            uint32_t klen = 0, vlen = 0;
            if (!f.read(reinterpret_cast<char*>(&klen), 4)) break;
            std::string key(klen, '\0');
            f.read(key.data(), klen);
            if (!f.read(reinterpret_cast<char*>(&vlen), 4)) break;
            std::string val(vlen, '\0');
            f.read(val.data(), vlen);
            entries.emplace_back(key, val);
        }
        if (!entries.empty()) {
            min_key = entries.front().first;
            max_key = entries.back().first;
        }
    }

    std::optional<std::string> get(const std::string& key) const {
        if (!bloom.maybe_contains(key)) return std::nullopt;
        // Binary search in sorted entries
        auto it = std::lower_bound(entries.begin(), entries.end(),
            std::make_pair(key, std::string{}));
        if (it != entries.end() && it->first == key) return it->second;
        return std::nullopt;
    }
};

// ---- WAL (minimal, from section 03) -----------------------------------

struct SimpleWAL {
    std::string    path;
    std::ofstream  out;

    explicit SimpleWAL(const std::string& p) : path(p) {
        out.open(p, std::ios::binary | std::ios::app);
    }

    void append_put(const std::string& key, const std::string& value) {
        uint8_t op = 1;
        write_entry(op, key, value);
    }

    void append_del(const std::string& key) {
        uint8_t op = 2;
        write_entry(op, key, "");
    }

    void sync() { out.flush(); }

    void truncate() {
        out.close();
        out.open(path, std::ios::binary | std::ios::trunc);
    }

    // Replay WAL on startup
    void replay(std::function<void(uint8_t, const std::string&,
                                    const std::string&)> fn)
    {
        std::ifstream in(path, std::ios::binary);
        while (in.peek() != EOF) {
            uint8_t op; uint32_t klen, vlen;
            if (!in.read(reinterpret_cast<char*>(&op), 1)) break;
            if (!in.read(reinterpret_cast<char*>(&klen), 4)) break;
            std::string k(klen, '\0');
            in.read(k.data(), klen);
            if (!in.read(reinterpret_cast<char*>(&vlen), 4)) break;
            std::string v(vlen, '\0');
            in.read(v.data(), vlen);
            fn(op, k, v);
        }
    }

private:
    void write_entry(uint8_t op, const std::string& k, const std::string& v) {
        uint32_t klen = k.size(), vlen = v.size();
        out.write(reinterpret_cast<char*>(&op), 1);
        out.write(reinterpret_cast<char*>(&klen), 4);
        out.write(k.data(), klen);
        out.write(reinterpret_cast<char*>(&vlen), 4);
        out.write(v.data(), vlen);
    }
};

// ---- KVStore ----------------------------------------------------------

class KVStore {
    SimpleWAL                        wal_;
    std::unique_ptr<Memtable>        mem_;
    std::vector<std::unique_ptr<SST>> sstables_;  // newest first
    mutable std::shared_mutex        mu_;
    std::string                      dir_;
    int                              sst_counter_ = 0;
    static constexpr size_t          FLUSH_THRESHOLD = 4 * 1024 * 1024; // 4MB

    void flush_memtable() {
        // Collect all entries from memtable in sorted order
        std::vector<std::pair<std::string,std::string>> kv;
        mem_->for_each([&](const std::string& k, const std::string& v, bool del) {
            if (!del) kv.emplace_back(k, v);
            // Deleted keys become absent in SST (compaction handles tombstones
            // in a real implementation)
        });

        if (kv.empty()) return;

        std::string path = dir_ + "/sst-" + std::to_string(sst_counter_++) + ".dat";
        auto sst = std::make_unique<SST>(path, kv.size());
        sst->write(kv);

        // Prepend (newest first)
        sstables_.insert(sstables_.begin(), std::move(sst));

        // Reset memtable and truncate WAL
        mem_ = std::make_unique<Memtable>();
        wal_.truncate();
    }

public:
    explicit KVStore(const std::string& dir)
        : wal_(dir + "/wal.log")
        , mem_(std::make_unique<Memtable>())
        , dir_(dir)
    {
        // Crash recovery: replay WAL into memtable
        wal_.replay([&](uint8_t op, const std::string& k, const std::string& v) {
            if (op == 1) mem_->put(k, v);
            else if (op == 2) mem_->del(k);
        });
    }

    void put(const std::string& key, const std::string& value) {
        std::unique_lock lock(mu_);
        wal_.append_put(key, value);
        wal_.sync();
        mem_->put(key, value);

        if (mem_->approximate_size() >= FLUSH_THRESHOLD) {
            flush_memtable();
        }
    }

    void del(const std::string& key) {
        std::unique_lock lock(mu_);
        wal_.append_del(key);
        wal_.sync();
        mem_->del(key);
    }

    std::optional<std::string> get(const std::string& key) const {
        std::shared_lock lock(mu_);

        // 1. Check memtable first
        auto res = mem_->get(key);
        if (res.found) {
            if (res.deleted) return std::nullopt;
            return res.value;
        }

        // 2. Search SST files newest-first with bloom filter
        for (auto& sst : sstables_) {
            auto v = sst->get(key);
            if (v.has_value()) return v;
        }

        return std::nullopt;
    }

    void flush() {
        std::unique_lock lock(mu_);
        flush_memtable();
    }
};
```

### Usage

The usage example demonstrates the full write-then-read cycle: `put` stores four records, `get` retrieves them with `std::optional` return semantics so missing keys are explicit rather than exceptions, and `remove` marks a key deleted. Running this against the store also exercises the WAL recovery path, any restart between `put` and `get` should still return the correct values by replaying the WAL.
```cpp
int main() {
    KVStore store("/tmp/mykvstore");

    store.put("alice",   "98");
    store.put("bob",     "72");
    store.put("charlie", "85");
    store.put("diana",   "91");

    assert(store.get("alice").value()   == "98");
    assert(store.get("bob").value()     == "72");
    assert(!store.get("eve").has_value());

    store.del("bob");
    assert(!store.get("bob").has_value());

    store.flush();  // force memtable to SST

    // After flush, data is in SST file with bloom filter
    // Get still works via SST search
    assert(store.get("alice").value() == "98");

    std::cout << "All assertions passed.\n";
}
```

### What RocksDB Adds

This implementation deliberately omits what makes RocksDB production-grade:

- **Multi-level compaction**: merge overlapping SST files to reclaim tombstone space and bound read amplification. Without this, SST files accumulate indefinitely and read performance degrades.
- **Block compression**: Snappy, LZ4, or Zstd applied per 4 KB block. Reduces I/O by 3-5× for text data.
- **Iterator-based range scan**: a merge iterator over memtable and all SST files, yielding keys in sorted order.
- **Column families**: separate memtable/SST/compaction state per logical namespace.
- **Statistics and rate limiting**: track read/write amplification in real time, limit compaction bandwidth to prevent I/O starvation.
- **Cache**: block cache (LRU over uncompressed 4 KB blocks) and row cache (LRU over full rows).

Reading the RocksDB source at `facebook/rocksdb` with this mental model, `DBImpl::Put` → `WriteThread::JoinBatchGroup` → `MemTable::Add` → background flush → `CompactionJob::Run`, is now entirely tractable.

### Go Comparison

`github.com/dgraph-io/badger` implements almost exactly this architecture in pure Go. `badger.DB.Set` → WAL append → `skl.Skiplist.Put` (a lock-free skip list in Go) → background flush → SST file. Its main innovation over standard LevelDB is value-log separation: large values are stored in a flat append-only file (vlog) and only a small value pointer is stored in the LSM tree, dramatically reducing write amplification for large values.

---
