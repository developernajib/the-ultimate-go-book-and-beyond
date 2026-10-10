## LSM Tree: Compaction, Bloom Filters, Write Amplification

The Log-Structured Merge-tree (LSM tree), introduced by O'Neil et al. In 1996 and popularized by Google's Bigtable and subsequent work by Jeff Dean and Sanjay Ghemawat on LevelDB, inverts the design of a B+ tree. Instead of updating pages in place, all writes are sequential appends. This trades write performance for read complexity, and then uses bloom filters and compaction to recover the read performance.

RocksDB, LevelDB, Cassandra, BadgerDB, TiKV, ScyllaDB, and InfluxDB all use LSM trees as their storage layer.

### Architecture Overview

This section provides a conceptual foundation for Architecture Overview, establishing the terminology and mental model needed to understand the implementation details that follow.
```
┌───────────────────────────────────────────────────┐
│  Write Path                                       │
│  Put(k,v) ──► WAL (disk, sequential)              │
│           ──► MemTable (in-memory skip list)      │
│                    │ when full (~64MB)            │
│                    ▼                              │
│             L0 SST files (disk, immutable)        │
│                    │ compaction trigger           │
│                    ▼                              │
│             L1 SST files (sorted, no overlap)     │
│                    ▼  ...                         │
│             LN SST files (largest level)          │
└───────────────────────────────────────────────────┘
```

### Bloom Filter: Probabilistic Set Membership

Before searching an SST file on disk, the database checks a bloom filter. If the filter says "definitely not here", the file is skipped entirely. This makes point lookups on large LSM databases tractable.

A bloom filter is an m-bit array plus k hash functions. To insert a key, set k bits at the positions given by the k hash functions. To query, check all k bits, if any is 0, the key is absent. False positives are possible. False negatives are not.

False positive probability: `p = (1 - e^(-k*n/m))^k` where n is number of keys.

Optimal number of hash functions: `k = (m/n) * ln(2)`

With 10 bits per key, the false positive rate is approximately 1%. RocksDB defaults to 10 bits per key per bloom filter.

```cpp
#include <cmath>
#include <cstddef>
#include <cstdint>
#include <string>
#include <vector>

// MurmurHash3 finalization mix -- fast, good distribution
static uint64_t murmur_mix(uint64_t h) {
    h ^= h >> 33;
    h *= 0xff51afd7ed558ccdULL;
    h ^= h >> 33;
    h *= 0xc4ceb9fe1a85ec53ULL;
    h ^= h >> 33;
    return h;
}

class BloomFilter {
    std::vector<uint8_t> bits_;
    size_t               num_bits_;
    int                  num_hashes_;

    void set_bit(size_t pos) {
        bits_[pos / 8] |= (1u << (pos % 8));
    }
    bool get_bit(size_t pos) const {
        return (bits_[pos / 8] >> (pos % 8)) & 1u;
    }

    // Derive k hash positions from one 64-bit hash (Kirsch-Mitzenmacher trick)
    std::vector<size_t> hash_positions(const std::string& key) const {
        uint64_t h1 = murmur_mix(std::hash<std::string>{}(key));
        uint64_t h2 = murmur_mix(h1 ^ 0xdeadbeefcafe1234ULL);

        std::vector<size_t> positions(num_hashes_);
        for (int i = 0; i < num_hashes_; ++i) {
            positions[i] = (h1 + static_cast<uint64_t>(i) * h2) % num_bits_;
        }
        return positions;
    }

public:
    // bits_per_key: 10 gives ~1% FPR, 7 gives ~1%, 14 gives ~0.1%
    BloomFilter(size_t expected_keys, int bits_per_key = 10)
        : num_bits_(expected_keys * bits_per_key)
        , num_hashes_(static_cast<int>(
              std::round(static_cast<double>(bits_per_key) * std::log(2.0))))
    {
        bits_.assign((num_bits_ + 7) / 8, 0);
    }

    void insert(const std::string& key) {
        for (size_t pos : hash_positions(key)) set_bit(pos);
    }

    // Returns false  => key is DEFINITELY absent
    // Returns true   => key is PROBABLY present (may be a false positive)
    bool maybe_contains(const std::string& key) const {
        for (size_t pos : hash_positions(key)) {
            if (!get_bit(pos)) return false;
        }
        return true;
    }

    double false_positive_rate(size_t actual_keys) const {
        double k = num_hashes_;
        double n = actual_keys;
        double m = num_bits_;
        return std::pow(1.0 - std::exp(-k * n / m), k);
    }
};
```

### SST File Format

An SST (Sorted String Table) file is an immutable, sorted file written once and never modified. Its layout:

```
┌─────────────────────┐
│  Data Blocks        │  sorted key-value pairs, block-compressed
│  (4KB each)         │
├─────────────────────┤
│  Index Block        │  one entry per data block: (last_key, offset)
├─────────────────────┤
│  Bloom Filter Block │  serialized BloomFilter for all keys in file
├─────────────────────┤
│  Footer             │  offsets to index block and bloom filter block
└─────────────────────┘
```

```cpp
#include <fstream>
#include <map>
#include <stdexcept>

struct SSTWriter {
    std::string                      path_;
    std::map<std::string,std::string> entries_;  // sorted by key

    void add(const std::string& key, const std::string& value) {
        entries_[key] = value;
    }

    void flush() {
        // Build bloom filter
        BloomFilter bf(entries_.size(), 10);
        for (auto& [k, _] : entries_) bf.insert(k);

        std::ofstream f(path_, std::ios::binary);

        // Data section: length-prefixed key-value pairs
        uint64_t data_start = 0;  // will be written in footer
        for (auto& [k, v] : entries_) {
            uint32_t klen = k.size(), vlen = v.size();
            f.write(reinterpret_cast<char*>(&klen), 4);
            f.write(k.data(), klen);
            f.write(reinterpret_cast<char*>(&vlen), 4);
            f.write(v.data(), vlen);
        }
        // In production: also write index block and footer with offsets
    }
};

struct SSTReader {
    std::string                       path_;
    BloomFilter*                      bloom_ = nullptr;
    std::map<std::string,std::string> cache_;  // loaded lazily

    bool might_contain(const std::string& key) const {
        return bloom_ ? bloom_->maybe_contains(key) : true;
    }

    std::optional<std::string> get(const std::string& key) {
        if (!might_contain(key)) return std::nullopt;  // skip disk I/O
        // Binary search in the index block to locate the right data block,
        // then scan within that block. Simplified here:
        auto it = cache_.find(key);
        if (it == cache_.end()) return std::nullopt;
        return it->second;
    }
};
```

### Compaction Strategies

Compaction is the process of merging overlapping SST files from one level into the next, eliminating deleted and overwritten keys. It is the core cost-quality trade-off in LSM tree design.

**Leveled compaction (LevelDB, RocksDB default):**

- L0 has a few small SSTs (possibly overlapping, they are raw flushes from memtable).
- L1 and beyond have a size limit (e.g., L1 = 256 MB, L2 = 2.5 GB, Ln = Ln-1 × 10).
- Each level Ln≥1 contains non-overlapping SST files, sorted by key.
- Compaction picks one SST from Ln and all overlapping SSTs from Ln+1, merges them, writes sorted output to Ln+1, deletes inputs.

Write amplification (WA) is high: each byte written may be rewritten 10-30× across levels. Space amplification (SA) is low: ~10% overhead.

**Tiered / STCS compaction (Cassandra, RocksDB universal):**

- Multiple "runs" (tiers) per level. A run can overlap with others in the same level.
- Compaction merges a whole tier into the next when the tier has enough files.
- Write amplification is lower (~5×), but space amplification is higher (~50%).

**FIFO compaction:**

- Only delete the oldest SST when total size exceeds a limit.
- Used for time-series data where old data expires naturally.
- Zero write amplification. Appropriate when data is never updated.

```cpp
// Simplified leveled compaction: merge L0 into L1
struct LSMCompactor {
    static void compact_l0_to_l1(
        std::vector<SSTReader>& l0,
        std::vector<SSTReader>& l1)
    {
        // Multi-way merge sort over all entries in L0 and overlapping L1 files
        std::map<std::string, std::string> merged;

        // Later (higher-numbered L0 files) override earlier ones
        for (auto& sst : l0) {
            for (auto& [k, v] : sst.cache_) {
                merged[k] = v;  // newest value wins
            }
        }
        for (auto& sst : l1) {
            for (auto& [k, v] : sst.cache_) {
                merged.try_emplace(k, v);  // don't overwrite L0 data
            }
        }

        // Write merged result as new L1 SSTs (split at size limit)
        // Delete old L0 and overlapping L1 SSTs
        l0.clear();
        // In production: split merged into fixed-size SSTs and replace l1
    }
};
```

### Write Amplification in Numbers

For a workload writing 100 MB/s to RocksDB with leveled compaction:

```
Level  Size Limit  Write Amplification per Level
L0     4 files     1× (raw flush)
L1     256 MB      ~10× (compact into L1)
L2     2.5 GB      ~10× (compact into L2)
L3     25 GB       ~10× (compact into L3)

Total WA for 100 MB/s input: ~30× = 3 GB/s disk write bandwidth consumed
```

This is why RocksDB documentation warns heavily about write amplification and why tuning `max_bytes_for_level_base`, `level_multiplier`, and compaction thread count matters for write-heavy workloads.

### Go Comparison

`github.com/syndtr/goleveldb` is a pure-Go port of LevelDB with the same leveled compaction strategy. `github.com/dgraph-io/badger` reimplements the LSM architecture in Go with a key-value separation design (values stored in a value log, separate from the LSM key index) inspired by WiscKey. Both expose the same logical API but differ significantly in their compaction implementations. BadgerDB is used by TiKV's Go-layer coordination code and by IPFS.

---
