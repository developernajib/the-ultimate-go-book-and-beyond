## Bigtable-Style Storage: LSM Trees in Modern C++

The LSM tree (Log-Structured Merge tree, O'Neil et al., 1996) is the storage engine pattern behind Bigtable, Cassandra, ScyllaDB, RocksDB, LevelDB, HBase, and most modern databases that prioritize write throughput. This section walks through an LSM implementation in C++23: skip-list memtable, SSTable file format with bloom filters, and the level-vs-tiered compaction trade-off.

### The Core Idea

A B-tree updates in place: every write seeks to a position and modifies it. On spinning disks and even on SSDs, in-place updates cap throughput. An LSM tree turns every write into an append: writes go to a memory buffer, the buffer is flushed sequentially to disk, and a background process merges old files. Sequential I/O dominates random I/O on every storage tier, so LSMs excel at write throughput.

The cost is read amplification: a read may have to check multiple files. Bloom filters and indexing keep this manageable.

### Components

1. **Write-ahead log (WAL)**: every write is appended to a log file before it touches the memtable, so a crash does not lose data.
2. **Memtable**: in-memory sorted structure, typically a skip list. Buffers writes until a size threshold.
3. **SSTable** (Sorted String Table): the immutable on-disk format. Sorted, with index and bloom filter sidecars.
4. **Compaction**: background process that merges SSTables, drops tombstones, reclaims space.

### Skip-List Memtable

A skip list is a probabilistic balanced search structure. Insert, delete, lookup all O(log N) on average, no rebalancing, lock-free variants are possible.

```cpp
template <typename K, typename V>
class SkipList {
public:
    static constexpr int kMaxLevel = 20;

    void Insert(const K& key, V value) {
        std::array<Node*, kMaxLevel> update{};
        Node* x = head_;
        for (int i = level_ - 1; i >= 0; --i) {
            while (x->next[i] && x->next[i]->key < key) x = x->next[i];
            update[i] = x;
        }
        x = x->next[0];
        if (x && x->key == key) { x->value = std::move(value); return; }

        int lvl = RandomLevel();
        if (lvl > level_) {
            for (int i = level_; i < lvl; ++i) update[i] = head_;
            level_ = lvl;
        }
        Node* n = new Node{key, std::move(value), lvl};
        for (int i = 0; i < lvl; ++i) {
            n->next[i] = update[i]->next[i];
            update[i]->next[i] = n;
        }
    }

    std::optional<V> Lookup(const K& key) const {
        Node* x = head_;
        for (int i = level_ - 1; i >= 0; --i) {
            while (x->next[i] && x->next[i]->key < key) x = x->next[i];
        }
        x = x->next[0];
        if (x && x->key == key) return x->value;
        return std::nullopt;
    }

private:
    struct Node {
        K key;
        V value;
        int height;
        std::vector<Node*> next;
        Node(K k, V v, int h) : key(std::move(k)), value(std::move(v)), height(h), next(h, nullptr) {}
    };

    int RandomLevel() {
        int lvl = 1;
        while ((rng_() & 0xFFFF) < 0x4000 && lvl < kMaxLevel) lvl++;  // p=0.25
        return lvl;
    }

    Node* head_ = new Node{K{}, V{}, kMaxLevel};
    int level_ = 1;
    std::mt19937 rng_{std::random_device{}()};
};
```

Production memtables (RocksDB's `InlineSkipList`) use atomic pointers to support concurrent reads while writes happen, and arena allocators to amortize per-node allocation.

### SSTable Format

An SSTable is a single file with the following layout:

```
[ data block 1 ] (4 KB to 64 KB of sorted key-value pairs, optionally compressed)
[ data block 2 ]
...
[ data block N ]
[ filter block ] (bloom filter for keys present in this SSTable)
[ index block ]  (key-to-data-block-offset map, sparse: one entry per data block)
[ footer ]       (offsets of filter and index blocks, magic number)
```

```cpp
class SSTableWriter {
public:
    explicit SSTableWriter(std::string path) : out_(path, std::ios::binary) {}

    void Add(const std::string& k, const std::string& v) {
        if (cur_block_size_ >= kBlockSize) FlushDataBlock();
        // Block format: varint key_len, key, varint val_len, val.
        WriteVarint(cur_block_, k.size());
        cur_block_.append(k);
        WriteVarint(cur_block_, v.size());
        cur_block_.append(v);
        cur_block_size_ += k.size() + v.size() + 8;
        if (cur_block_first_key_.empty()) cur_block_first_key_ = k;
        bloom_.Add(k);
    }

    void Finish() {
        if (cur_block_size_ > 0) FlushDataBlock();
        // Write filter block.
        auto filter_offset = out_.tellp();
        bloom_.Serialize(out_);
        // Write index block.
        auto index_offset = out_.tellp();
        for (const auto& [first_key, off] : index_) {
            WriteVarint(out_, first_key.size());
            out_.write(first_key.data(), first_key.size());
            WriteUint64(out_, off);
        }
        // Footer.
        WriteUint64(out_, filter_offset);
        WriteUint64(out_, index_offset);
        WriteUint64(out_, kMagic);
    }

private:
    void FlushDataBlock() {
        index_.emplace_back(cur_block_first_key_, out_.tellp());
        out_.write(cur_block_.data(), cur_block_.size());
        cur_block_.clear();
        cur_block_size_ = 0;
        cur_block_first_key_.clear();
    }

    static constexpr size_t kBlockSize = 16 * 1024;
    static constexpr uint64_t kMagic = 0x53535441424C4530ULL;
    std::ofstream out_;
    std::string cur_block_, cur_block_first_key_;
    size_t cur_block_size_ = 0;
    std::vector<std::pair<std::string, uint64_t>> index_;
    BloomFilter bloom_{1024 * 1024, 4};
};
```

A reader memory-maps the file, reads the footer, finds the index, binary-searches the index for the target key's data block, decompresses (if compressed) and scans the block for the key. The bloom filter short-circuits negative lookups.

### Bloom Filters

A bloom filter is a probabilistic set: queries return either "definitely not in set" or "maybe in set". For a target false-positive rate p, a bloom filter needs roughly `-1.44 log_2(p)` bits per element. At 1 percent false positive, ~10 bits per key.

```cpp
class BloomFilter {
public:
    BloomFilter(size_t num_bits, int num_hashes) : bits_(num_bits, false), k_(num_hashes) {}

    void Add(std::string_view key) {
        auto [h1, h2] = DoubleHash(key);
        for (int i = 0; i < k_; ++i) bits_[(h1 + i * h2) % bits_.size()] = true;
    }

    bool MaybeContains(std::string_view key) const {
        auto [h1, h2] = DoubleHash(key);
        for (int i = 0; i < k_; ++i) {
            if (!bits_[(h1 + i * h2) % bits_.size()]) return false;
        }
        return true;
    }

private:
    static std::pair<uint64_t, uint64_t> DoubleHash(std::string_view k) {
        // Two independent hashes via different seeds.
        return {Hash(k, 0xdeadbeef), Hash(k, 0xc0ffee)};
    }
    static uint64_t Hash(std::string_view, uint64_t seed) { /* xxhash, etc. */ return seed; }

    std::vector<bool> bits_;
    int k_;
};
```

LevelDB uses a single bloom filter per SSTable. RocksDB optionally uses partitioned bloom filters and *ribbon filters* (Dillinger & Walzer, 2021) for tighter false-positive rates at lower memory.

### Compaction Strategies

The pile of SSTables grows unboundedly without compaction. Compaction reads several SSTables, merges their key-value pairs (latest version wins, tombstones drop expired entries), writes new SSTables.

#### Level Compaction (LevelDB, RocksDB default)

Files are organized in levels L0, L1, L2, .... L0 holds the most recent flushes (overlapping key ranges allowed). Higher levels hold non-overlapping ranges, with each level 10x larger than the previous. Compaction picks a file from level N, merges with overlapping files in level N+1, writes results to N+1.

**Trade-offs**:
- Read amp: O(log size) (one bloom filter lookup per level).
- Write amp: O(log size) per write (each value rewritten on average log_10(size) times).
- Space amp: ~1.1x (one extra layer at most).

Level compaction is the right choice for read-heavy workloads.

#### Tiered Compaction (Cassandra default, ScyllaDB)

When N SSTables of similar size accumulate, merge them all into one. Result: levels of doubling-sized files.

**Trade-offs**:
- Read amp: O(log size) but with a higher constant.
- Write amp: O(log size) per write but a smaller constant (each value rewritten fewer times).
- Space amp: 2x (until the merge).

Tiered compaction is the right choice for write-heavy workloads. ScyllaDB uses incremental compaction strategies that interpolate between tiered and level.

#### Time-Window Compaction (TimeSeries)

For time-series, compact only within a time window. SSTables for January never compact with SSTables for February. Reduces compaction work for append-only workloads.

### Write Amplification Analysis

For 1 GB of writes with level compaction at default 10x ratios:

```
Write to L0 (memtable flush): 1 GB written.
L0 → L1 compaction: read 1 GB, write 1 GB. Now in L1.
L1 → L2: this 1 GB is part of a larger compaction. Across the lifetime of L1 (which holds 10 GB), every byte in L1 is rewritten roughly 10 times to push into L2.
L2 → L3: same, another 10x.
```

A workload that fills L4 has each byte written 1 + 10 + 10 + 10 + 10 = 41 times. RocksDB's tunables (L0 file size, level multiplier, max levels) all aim to control this.

### ScyllaDB's Per-Shard Architecture

ScyllaDB takes the LSM design and *partitions per CPU core*. Each core has its own memtables, SSTables, and IO scheduler, nothing shared. This eliminates lock contention and gives near-linear scaling with core count.

The Seastar framework underneath ScyllaDB provides futures, continuations, and a shard-aware allocator. The result is a Cassandra-compatible database that uses a fraction of the hardware.

### Junior at FAANG: The Storage Question

When asked "design a key-value store optimized for writes", do not say "use RocksDB." Say: "LSM tree with skip-list memtable, sorted SSTable on disk, bloom filter per file, compaction strategy chosen by workload (level for read-heavy, tiered for write-heavy). The write path is WAL append + memtable insert, the read path is memtable + bloom-filtered SSTables. The key tunables are memtable size, block size, bloom-filter bits per key, level multiplier."

That answer demonstrates you understand RocksDB rather than just import it.

---
