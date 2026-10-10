## Vectorized Execution

In 2005, Boncz, Zukowski, and Nes published "MonetDB/X100: Hyper-Pipelining Query Execution." It described an engine that processed batches of values per operator call instead of single tuples. The batches sat in cache-resident vectors. The inner loops were tight, branch-free, SIMD-friendly. The engine was 10x to 50x faster than Volcano on TPC-H. Twenty years later, every analytical engine that matters (DuckDB, ClickHouse, Velox, Snowflake, Photon, BigQuery) is vectorized.

The core idea: amortize per-call overhead across thousands of rows.

### The Vector and the Batch

A vector is a contiguous array of values of one type. A batch (DataChunk in DuckDB, Block in ClickHouse, RowVector in Velox) is a set of vectors of equal length, one per output column. Operators consume and produce batches.

```cpp
#include <cstdint>
#include <cstring>
#include <memory>
#include <vector>
#include <bit>

namespace vec {

constexpr size_t kVectorSize = 2048;

enum class TypeId : uint8_t { Int32, Int64, Float64, Bool, String };

struct Vector {
    TypeId type;
    size_t size = 0;
    alignas(64) std::byte* data = nullptr;
    // Validity bitmap: 1 = valid, 0 = NULL. One bit per row.
    alignas(64) uint64_t* validity = nullptr;

    template <typename T>
    T* as() { return reinterpret_cast<T*>(data); }

    bool IsNull(size_t i) const {
        return !(validity[i / 64] & (1ULL << (i % 64)));
    }
};

struct DataChunk {
    std::vector<Vector> columns;
    size_t size = 0;  // number of valid rows

    void Reset() { size = 0; }
};

}  // namespace vec
```

Three implementation details deserve attention.

**Vector size.** The literature settled on 1024 to 4096 rows per batch. Smaller (256) leaves SIMD performance on the table. Larger (16384) blows the L1 cache for any operator that touches multiple columns. DuckDB uses 2048. ClickHouse uses 65536 by default but with explicit cache-aware inner loops. Velox uses 1024. Pick a value that keeps the working set of `(num_columns * vector_size * sizeof(T))` under 64 KB so it fits in L1 D-cache.

**Validity bitmap, not sentinel values.** NULLs are tracked in a separate bitmap. This lets the inner loop run on the data array unconditionally (computing on garbage in the NULL slots), and the bitmap is combined with the predicate result at the end. A loop with no per-row null check is 3x to 5x faster than one with a null branch.

**64-byte alignment.** Cache lines are 64 bytes on x86 and arm64. AVX-512 loads are 64 bytes. Aligning the data array eliminates split loads at the top of every batch.

### A Vectorized Filter

```cpp
namespace vec {

// Evaluate a > b on two int64 vectors, output a uint8 selection vector
// (one byte per row, 0 or 1) plus the count of selected rows.
size_t FilterGreaterThan(const Vector& a, const Vector& b,
                         uint16_t* selection_vector) {
    const int64_t* aa = reinterpret_cast<const int64_t*>(a.data);
    const int64_t* bb = reinterpret_cast<const int64_t*>(b.data);
    size_t count = 0;
    // Compiler will autovectorize this with AVX2/AVX-512 when -O3 -mavx2.
    for (size_t i = 0; i < a.size; ++i) {
        if (aa[i] > bb[i]) {
            selection_vector[count++] = static_cast<uint16_t>(i);
        }
    }
    return count;
}

// Constant comparison: a > k. The compiler vectorizes this aggressively.
size_t FilterGreaterThanConst(const int64_t* aa, size_t n, int64_t k,
                              uint16_t* sel) {
    size_t count = 0;
    for (size_t i = 0; i < n; ++i) {
        sel[count] = static_cast<uint16_t>(i);
        count += (aa[i] > k);  // branchless
    }
    return count;
}

}  // namespace vec
```

The branchless version is the trick of the trade. Instead of `if (cond) sel[count++] = i;`, write `sel[count] = i; count += cond;`. The compiler converts this into a CMOV or a vectorized compress-store (`vpcompressd` on AVX-512). Branchless filters run at 4 to 16 GB/s of input on a single core.

ClickHouse goes further. For `WHERE x > 5`, it generates a bitmap (one bit per row), then uses `_mm_blendv_epi8` or AVX-512 mask registers to select rows in the next operator without expanding to a full selection vector. This is "selection by bitmap" vs "selection by index list," and the right choice depends on selectivity. Bitmaps win when most rows pass. Index lists win when few rows pass.

### A Vectorized Hash Join

The build phase fills a hash table from the build side. The probe phase batches lookups for SIMD-friendly hashing.

```cpp
namespace vec {

struct HashJoinState {
    // Linear-probing table. Power of two size. Empty slots have key = 0
    // and a separate occupancy bitmap.
    struct Bucket {
        int64_t key;
        uint32_t row_id;  // index into the build-side row pool
    };
    std::vector<Bucket> buckets;
    uint64_t mask;  // buckets.size() - 1
    std::vector<uint64_t> occupied;  // bitmap

    // Materialized build rows.
    std::vector<DataChunk> build_chunks;
};

uint64_t Hash(int64_t k) {
    // CRC32 hardware instruction (fast and well-distributed for join keys).
    return std::rotl(static_cast<uint64_t>(k) * 0x9E3779B97F4A7C15ULL, 23);
}

void BuildPhase(HashJoinState& s, const Vector& keys, uint32_t base_row_id) {
    const int64_t* k = reinterpret_cast<const int64_t*>(keys.data);
    for (size_t i = 0; i < keys.size; ++i) {
        uint64_t h = Hash(k[i]) & s.mask;
        while (s.occupied[h / 64] & (1ULL << (h % 64))) {
            h = (h + 1) & s.mask;
        }
        s.buckets[h] = {k[i], base_row_id + static_cast<uint32_t>(i)};
        s.occupied[h / 64] |= (1ULL << (h % 64));
    }
}

// Probe a batch of probe-side keys against the table.
// Returns the number of matches found and writes (probe_idx, build_row_id)
// pairs to the output arrays.
size_t ProbePhase(const HashJoinState& s, const Vector& probe_keys,
                  uint16_t* probe_idx_out, uint32_t* build_row_out) {
    const int64_t* k = reinterpret_cast<const int64_t*>(probe_keys.data);

    // Step 1: hash all probe keys into a vector of bucket indices.
    alignas(64) uint64_t hashes[kVectorSize];
    for (size_t i = 0; i < probe_keys.size; ++i) {
        hashes[i] = Hash(k[i]) & s.mask;
    }

    // Step 2: prefetch the buckets we are about to touch.
    constexpr size_t kPrefetchDist = 16;
    for (size_t i = 0; i < std::min(probe_keys.size, kPrefetchDist); ++i) {
        __builtin_prefetch(&s.buckets[hashes[i]], 0, 0);
    }

    // Step 3: probe with linear probing, emit matches.
    size_t out = 0;
    for (size_t i = 0; i < probe_keys.size; ++i) {
        if (i + kPrefetchDist < probe_keys.size) {
            __builtin_prefetch(&s.buckets[hashes[i + kPrefetchDist]], 0, 0);
        }
        uint64_t h = hashes[i];
        while (s.occupied[h / 64] & (1ULL << (h % 64))) {
            if (s.buckets[h].key == k[i]) {
                probe_idx_out[out] = static_cast<uint16_t>(i);
                build_row_out[out] = s.buckets[h].row_id;
                ++out;
                break;  // first match only for inner equi-join
                        // (multimap version loops until empty)
            }
            h = (h + 1) & s.mask;
        }
    }
    return out;
}

}  // namespace vec
```

Three optimizations matter here.

**Software prefetching.** Hash table probes are the canonical pointer-chasing pattern. Each probe touches a random cache line. With prefetch distance 16, by the time we get to row i, the bucket for row i+16 is already on its way from DRAM. This trick alone is worth 2x to 4x on hash join probe.

**Two-pass hashing.** Compute all hashes first (pure SIMD-friendly arithmetic), then probe. Mixing hash computation with probing breaks the prefetcher and the compiler's vectorizer.

**Linear probing with power-of-two sizing.** Linear probing keeps probes on the same cache line under good load factor (50% to 75%). Power-of-two sizing lets us use bitwise AND for modulo. The combination is what every modern engine uses (DuckDB, ClickHouse, absl::flat_hash_map). Quadratic probing is a textbook idea that has lost in practice because it spreads probes across cache lines.

### DuckDB vs ClickHouse Vector Design

DuckDB's `Vector` supports four physical layouts: flat, constant, dictionary, and sequence. A `ConstantVector` represents a column where all values are the same (common after a filter that reduces a join key to one value). A `DictionaryVector` shares storage with another vector and indexes into it. The execution engine peels off these layouts in operators that benefit (a hash join on a dictionary-encoded probe key only hashes the unique values).

ClickHouse's `IColumn` hierarchy is parallel: `ColumnVector<T>`, `ColumnConst`, `ColumnLowCardinality`, `ColumnNullable`. The sparse representation (`ColumnSparse`) is unique to ClickHouse and well suited to wide tables with many NULLs.

Velox unifies these as `BaseVector` with `FlatVector`, `ConstantVector`, `DictionaryVector`, `BiasedVector` (rare), `SequenceVector`, and `LazyVector`. The `LazyVector` is materialized only when an operator demands it, supporting late materialization across operator boundaries.

Pick whichever vocabulary you like. The pattern is the same: a column knows its physical encoding, operators dispatch on encoding, and the fast path is "flat dense int64."

### Selection Vectors and the Selectivity Question

When a filter removes 50% of rows, you have two choices: rewrite the data column to a smaller dense column (compaction), or carry a selection vector that all downstream operators must respect.

DuckDB chooses the latter (selection vectors all the way down). ClickHouse and Velox choose the former more aggressively. The trade-off is:

- Selection vectors cost zero data movement but add an indirection on every column read in downstream operators.
- Compaction costs a memcpy of every selected row but makes downstream operators trivial.

The right answer depends on selectivity and column count. DuckDB's measurement is that selection vectors win for selectivity above 25% and column counts above 4. Below that, compaction wins. ClickHouse measured similar break-even points and wired them into the optimizer.

### What You Should Read

If you want to see vectorization in production code:

- DuckDB: `src/include/duckdb/common/types/vector.hpp` for the Vector class, `src/execution/operator/join/physical_hash_join.cpp` for the join.
- ClickHouse: `src/Columns/IColumn.h` for the column hierarchy, `src/Interpreters/HashJoin.cpp` for the join.
- Velox: `velox/vector/BaseVector.h` for vectors, `velox/exec/HashTable.h` for the join hash table.

The next chapter takes the next step: instead of writing the inner loop by hand, generate it from the query plan with LLVM.

---
