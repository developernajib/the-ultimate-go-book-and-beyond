## Compression Techniques

Storage compression is part of query performance. A 5x compression ratio means 5x less I/O for cold scans. But if decompression is slow, you trade I/O for CPU and the query runs longer. The right compression scheme depends on column type, cardinality, distribution, and the storage tier.

This chapter covers the schemes that production engines use, with C++ implementations of the lightweight ones.

### Compression Lives in Two Layers

Modern columnar storage applies two layers of compression.

**Lightweight encoding.** Data-aware schemes that exploit column structure: dictionary encoding for low cardinality, RLE for runs, FOR for clustered ranges, delta for monotonic, bit-packing for narrow ranges. Decompression is essentially free (10+ GB/s per core).

**General-purpose compression.** Block compressors that treat the bytes generically: LZ4, Snappy, Zstd, Gzip. Compression ratio is better but decompression is slower (1-4 GB/s per core).

Most engines apply lightweight first, then general-purpose on top of the lightweight result. Parquet does this. ClickHouse does this. DuckDB does this.

### Dictionary Encoding

Covered in chapter 13. Replaces values with small integer IDs. Best for low cardinality (NDV < ~10K), strings, and any time the same values repeat. Compression ratio depends on repetition: 2x to 100x+.

### Run-Length Encoding (RLE)

Replaces runs of equal values with `(value, count)` pairs. Best for sorted data and low-entropy categorical columns.

```cpp
#include <cstdint>
#include <vector>

namespace cmp {

struct RleRun { int64_t value; uint32_t count; };

std::vector<RleRun> RleEncode(const int64_t* in, size_t n) {
    std::vector<RleRun> out;
    if (n == 0) return out;
    int64_t cur = in[0]; uint32_t cnt = 1;
    for (size_t i = 1; i < n; ++i) {
        if (in[i] == cur) { ++cnt; }
        else { out.push_back({cur, cnt}); cur = in[i]; cnt = 1; }
    }
    out.push_back({cur, cnt});
    return out;
}

void RleDecode(const std::vector<RleRun>& runs, int64_t* out) {
    size_t pos = 0;
    for (auto& r : runs) {
        for (uint32_t i = 0; i < r.count; ++i) out[pos++] = r.value;
    }
}

}  // namespace cmp
```

For sorted columns RLE alone can give 100x compression. Parquet pairs RLE with bit-packing in its `RLE/Bit-Packed` hybrid encoding.

### Bit-Packing

When all values fit in fewer bits than the storage type, pack them. A column of integers in [0, 7] uses 3 bits per value, not 32 or 64.

```cpp
namespace cmp {

void BitPack(const uint32_t* in, size_t n, int bits, uint8_t* out) {
    uint64_t bitbuf = 0;
    int bitcnt = 0;
    size_t out_pos = 0;
    for (size_t i = 0; i < n; ++i) {
        bitbuf |= (uint64_t(in[i]) & ((1ULL << bits) - 1)) << bitcnt;
        bitcnt += bits;
        while (bitcnt >= 8) {
            out[out_pos++] = uint8_t(bitbuf & 0xFF);
            bitbuf >>= 8;
            bitcnt -= 8;
        }
    }
    if (bitcnt > 0) out[out_pos++] = uint8_t(bitbuf & 0xFF);
}

}  // namespace cmp
```

In production, use the FastPFOR library. It SIMD-encodes and SIMD-decodes bit-packed integers at 5-10 GB/s. Parquet, Lucene, and several search engines use FastPFOR variants.

### Frame of Reference (FOR)

Subtract the column's minimum from every value, store the differences in fewer bits. Combine with bit-packing for clustered ranges.

For a column of timestamps in a one-day range (86400 seconds), the differences fit in 17 bits instead of 32. Compression ratio: ~2x with no entropy coding.

```cpp
namespace cmp {

struct FOR { int64_t reference; std::vector<uint32_t> deltas; int bits; };

FOR ForEncode(const int64_t* in, size_t n) {
    int64_t mn = in[0], mx = in[0];
    for (size_t i = 1; i < n; ++i) {
        if (in[i] < mn) mn = in[i];
        if (in[i] > mx) mx = in[i];
    }
    uint64_t range = uint64_t(mx - mn);
    int bits = range == 0 ? 1 : 64 - std::countl_zero(range);
    FOR out{mn, std::vector<uint32_t>(n), bits};
    for (size_t i = 0; i < n; ++i) out.deltas[i] = uint32_t(in[i] - mn);
    return out;
}

}  // namespace cmp
```

Real implementations like BtrBlocks (Kuschewski et al., VLDB 2023) cascade FOR with dictionary, RLE, and bit-packing in adaptive layers.

### Delta and Delta-of-Delta

For monotonic or near-monotonic data (timestamps, sequence numbers), store consecutive differences instead of values. For very regular data (a metric sampled every second), the differences are almost constant, and the differences-of-differences are mostly zero.

```cpp
namespace cmp {

void DeltaEncode(const int64_t* in, size_t n, int64_t* out) {
    if (n == 0) return;
    out[0] = in[0];
    for (size_t i = 1; i < n; ++i) out[i] = in[i] - in[i - 1];
}

void DeltaOfDeltaEncode(const int64_t* in, size_t n, int64_t* out) {
    if (n < 2) { for (size_t i = 0; i < n; ++i) out[i] = in[i]; return; }
    out[0] = in[0]; out[1] = in[1] - in[0];
    int64_t prev_delta = out[1];
    for (size_t i = 2; i < n; ++i) {
        int64_t d = in[i] - in[i - 1];
        out[i] = d - prev_delta;
        prev_delta = d;
    }
}

}  // namespace cmp
```

Delta-of-delta is the basis of Gorilla compression (Pelkonen et al., VLDB 2015), used in Facebook's TSDB. ClickHouse has `Delta`, `DoubleDelta`, and `Gorilla` codecs as first-class compression options.

### Block Compressors: LZ4, Snappy, Zstd

These treat input as a byte stream. They find repeated substrings, replace them with back-references, and entropy-code the result.

Performance characteristics on a 2024 server (Sapphire Rapids, single core):

| Codec | Compression speed | Decompression speed | Typical ratio |
|---|---|---|---|
| LZ4 | 500 MB/s | 4 GB/s | 2.0-2.5x |
| LZ4-HC | 80 MB/s | 4 GB/s | 2.5-3.0x |
| Snappy | 500 MB/s | 2 GB/s | 2.0-2.5x |
| Zstd-1 | 500 MB/s | 1.5 GB/s | 2.5-3.0x |
| Zstd-3 | 300 MB/s | 1.5 GB/s | 3.0-3.5x |
| Zstd-9 | 80 MB/s | 1.5 GB/s | 3.5-4.0x |
| Zstd-22 | 5 MB/s | 1.5 GB/s | 4.0-5.0x |
| Gzip | 50 MB/s | 350 MB/s | 3.0-3.5x |
| Brotli | 5-100 MB/s | 600 MB/s | 3.5-4.5x |

The choices in production:

- **LZ4** for hot data where decompression speed dominates. ClickHouse default.
- **Zstd-3** for warm data where ratio matters and decompression is still fast. Newer ClickHouse default for some workloads.
- **Zstd-9 to Zstd-22** for cold archival.
- **Snappy** for legacy. Largely replaced by LZ4 (similar ratio, faster decompress).

DuckDB uses Snappy as the Parquet default but supports LZ4 and Zstd. ClickHouse defaults to LZ4 with Zstd available per column.

### BtrBlocks

BtrBlocks (Kuschewski et al., VLDB 2023) is a lightweight cascading scheme designed for analytical workloads. It tries several lightweight encodings on each block, picks the best, and applies the result. The key insight: lightweight is fast enough that you can try multiple schemes on each block at write time and pick the winner.

The scheme typically beats Parquet's encodings by 10-30% in ratio at similar decompress speed. Adoption is still limited (mostly research and a few prototypes), but the technique is influencing newer storage engines.

### FastPFOR and Patched Encodings

FastPFOR (Lemire and Boytsov, 2015) bit-packs integers with SIMD. The "patched" variant handles outliers: most values fit in N bits, a few outliers are stored separately at full precision.

```cpp
// Pseudocode for patched encoding.
// 1. Pick bit width B such that 95% of values fit in B bits.
// 2. Bit-pack all values at width B.
// 3. For values that did not fit, store (index, full_value) in an exception array.
// 4. On decode, bit-unpack, then patch in exceptions.
```

ClickHouse uses similar techniques internally for some columnar operations. Lucene uses FastPFOR variants for posting list compression.

### Choosing Compression Per Column

A serious storage engine picks compression per column based on data characteristics. A heuristic that works:

1. NDV < 100: dictionary encoding alone, no further compression needed.
2. NDV < 10K: dictionary + bit-packing of indexes.
3. Mostly sorted, low entropy: RLE + bit-packing.
4. Monotonic: delta encoding + bit-packing.
5. Time series with regular intervals: delta-of-delta + Zstd.
6. Free text: Zstd.
7. Numeric with broad range: FOR + bit-packing + LZ4.

The optimizer can profile a sample at write time and pick. ClickHouse's `CODEC()` per column lets the user override. DuckDB picks automatically.

### What Production Engines Do

- **Parquet (Apache C++ writer)**: dictionary + RLE + bit-packing + Snappy or Zstd.
- **ClickHouse**: per-column codec stacks. Default: LZ4. Common: `Delta, ZSTD(3)` for timestamps, `LowCardinality(String)` for categoricals.
- **DuckDB**: automatic per-column compression with FSST for strings, FOR for ints, dictionary, RLE.
- **BigQuery Capacitor**: proprietary, but research papers indicate dictionary + RLE + bit-packing + Snappy on top.
- **Photon**: relies on Delta Lake's Parquet, no proprietary compression.

### Decompression in the Vectorized Loop

For lightweight encodings, decompression should happen inside the operator loop, not as a separate pass. ClickHouse and DuckDB both inline RLE decompression and dictionary lookup into the filter and projection operators. This avoids materializing a fully-decoded vector when only a fraction of values pass the filter.

For block compressors (Zstd, LZ4), decompression is too expensive to inline. Decompress whole pages, then run vectorized operators on the decompressed result.

### Recommended Reading

- Lemire and Boytsov, "Decoding billions of integers per second through vectorization," 2015.
- Kuschewski et al., "BtrBlocks: Efficient Columnar Compression for Data Lakes," VLDB 2023.
- Pelkonen et al., "Gorilla: A Fast, Scalable, In-Memory Time Series Database," VLDB 2015.
- Boncz et al., "MonetDB/X100: Hyper-Pipelining Query Execution," CIDR 2005.

The next chapter goes from compression to indexing: zone maps, bloom filters, and other skipping structures.

---
