## Posting List Compression

A posting list of one billion docIDs at 32 bits each is 4 GB. Compressed, it is between 200 MB and 1 GB depending on scheme. At search scale this dominates: Google's web index is reported to be in the petabytes precisely because of how aggressively posting lists are compressed and how many lists there are. The choice of codec is rarely about ratio alone. It is always about ratio versus decode throughput versus random-access cost, and different codecs win at different points on that surface.

### Why Gap Encoding First

Posting lists are sorted ascending docIDs. Replacing `[100, 142, 198, 280]` with gaps `[100, 42, 56, 82]` shrinks the integers, which lets every code below work on smaller numbers. The base assumption of the rest of this chapter is that the input is gap-encoded.

### VarByte (a.k.a. VByte, Variable Byte)

The simplest. Each integer is split into 7-bit chunks, each chunk is one byte with a continuation bit in the MSB.

```cpp
inline void vbyte_encode(std::uint32_t v, std::vector<std::uint8_t>& out) {
    while (v >= 0x80) {
        out.push_back(static_cast<std::uint8_t>(v | 0x80));
        v >>= 7;
    }
    out.push_back(static_cast<std::uint8_t>(v));
}

inline std::uint32_t vbyte_decode(const std::uint8_t*& p) {
    std::uint32_t v = 0;
    std::uint32_t shift = 0;
    std::uint8_t b;
    do {
        b = *p++;
        v |= static_cast<std::uint32_t>(b & 0x7F) << shift;
        shift += 7;
    } while (b & 0x80);
    return v;
}
```

Pros: simple, no boundary alignment. Cons: branch-per-byte, mispredicts, around 200 million integers/second on a single core. That is slow by modern standards.

**Group VarInt** (used by Google's Jeff Dean and Sanjay Ghemawat in early Google internals) batches four integers and stores their byte-lengths in one selector byte. Same idea, four-way decode, vastly better branch behavior. Roughly 800 M ints/sec.

### Simple9 / Simple16

Pack as many integers as possible into a single 32-bit word. The first 4 bits are a selector telling the decoder how many integers and how many bits each. Simple9 has 9 selectors (1x28-bit, 2x14-bit, 3x9-bit, 4x7-bit, 5x5-bit, 7x4-bit, 9x3-bit, 14x2-bit, 28x1-bit). Simple16 extends to 16 selectors and tighter packing.

```cpp
// Sketch only.
struct Simple9Word { std::uint32_t bits; };
// Decoder is a 9-way switch on the top 4 bits, each case unpacks N ints.
```

The decode is fully unrolled per selector, no inner loop, so it lands around 1.5 billion ints/sec. The cost is the selector switch and slightly worse compression than PFOR on skewed gaps.

### PFOR and FastPFOR

Patched Frame of Reference (Zukowski 2006) divides the input into blocks of 128 integers. For each block, pick a `b` such that most values fit in `b` bits. Pack those values bit-tightly. The values that overflow (the "exceptions") are stored separately at full width with their positions. The decoder unpacks all 128 in SIMD then patches in exceptions.

FastPFOR (Lemire and Boytsov, 2012) refines exception handling and bit packing using SIMD (SSE2 / AVX2). On Intel, FastPFOR128 hits 4-6 billion integers/sec and matches the compression ratio of Simple16 on web data. It is the codec used by Lucene's `PForUtil` and by Tantivy. The reference C++ implementation is the FastPFOR library on GitHub.

Key insight: the bit-packing kernel for a fixed `b` is one of 32 hand-written SIMD routines. The dispatch is by `b`, so the inner loop has zero branches.

### BitMagic and Roaring Bitmaps

When the posting list is dense (term appears in 30 percent of documents), bit-set representation wins. A bitmap of N bits, with the j-th bit set if doc j contains the term. Roaring (Lemire et al., 2016) splits the bitmap into 16-bit chunks and chooses the best representation per chunk: array (sparse), bitmap (dense), or run-length (clustered). Roaring is the format Elastic uses for filter caches, Druid uses for dimension columns, and Pinot uses for inverted indexes.

```cpp
// Conceptual sketch.
struct RoaringChunk {
    enum Kind { Array, Bitmap, Run };
    Kind kind;
    std::vector<std::uint16_t> array;   // when sparse
    std::array<std::uint64_t, 1024> bm; // when dense
    // run pairs when clustered
};
```

Boolean intersection between Roaring bitmaps is faster than between PFOR posting lists when both lists are dense. This is why filter columns ("country = US") are usually Roaring even in engines that use PFOR for term postings.

### Elias-Fano

The compression-ratio champion when you also need rank/select operations. For a sorted sequence of n values up to U, Elias-Fano uses `n * (2 + log2(U/n))` bits, which is information-theoretically near optimal. The trick is splitting each value into a high part (stored as a unary code in a bitvector) and a low part (stored bit-packed). Rank/select on the high bitvector lets you locate any value in O(1) with a small index.

Elias-Fano is the encoding behind Facebook's `folly::EliasFanoEncoder` and behind ds2i (the experimental search engine framework from Pisa University used in many academic IR papers). Compression ratio: typically 0.6 to 0.8 of FastPFOR on web data. Decode throughput for full scan is comparable to PFOR. Random access (find the i-th element, or find the value at least X) is where it shines: O(1) with two cache misses, where PFOR would need to decode the whole block.

```cpp
// folly::EliasFanoEncoder<>::Layout from a sorted vector<uint64_t>.
folly::EliasFanoEncoder<std::uint64_t> enc(values.size(), values.back());
for (auto v : values) enc.add(v);
auto buf = enc.finish();
folly::EliasFanoReader<decltype(buf)> reader(buf);
reader.skipTo(target);  // O(1) plus a cache miss or two.
```

Vespa uses an Elias-Fano variant for some posting lists. Lucene 9 added it for sparse columns.

### Comparison

Numbers below are representative on a Skylake-class core, web-corpus posting lists (Gov2 or ClueWeb09 benchmarks):

| Codec | Bits/posting | Decode (M ints/sec) | Random access |
|--------------|--------------|---------------------|---------------|
| Raw 32-bit | 32 | memcpy speed | O(1) |
| VByte | 8-9 | 200 | sequential |
| Group VInt | 8-9 | 800 | sequential |
| Simple9 | 6-8 | 1500 | sequential |
| Simple16 | 6-7 | 1400 | sequential |
| FastPFOR128 | 5-6 | 4500 | block-aligned |
| Roaring | varies | 3000-6000 | O(1) per chunk|
| Elias-Fano | 4-5 | 3000 | O(1) skipto |

There is no universal winner. Lucene picked PFOR for postings and Roaring for filters. Vespa picked PFOR with selective Elias-Fano. Pisa's Anserini-equivalent ships multiple codecs and switches by list density.

### Decoding into a SIMD-Friendly Buffer

A common production pattern: decode 128 integers into a stack-allocated `alignas(64) std::uint32_t buf[128]` then iterate. Two reasons. First, the AVX2 decode kernels for FastPFOR write 32-byte chunks, so the destination must be 32-byte aligned. Second, the next stage (intersection, scoring) can itself use SIMD over the buffer. Engines that decode straight into a `std::vector` lose 30 percent of throughput to the allocator and the alignment check.

### Junior to FAANG

Junior: pick whichever library compiles. FAANG: profile the codec on **your** corpus. Web posting lists are not academic benchmarks. A search-infra engineer at Google ran a multi-quarter project to switch one corpus from Simple9 to PFOR and gained 12 percent QPS at the same recall. The same project on a different corpus would have lost performance because the gap distribution was different. The skill is being able to read flame graphs of decoders and reason about why a particular codec misbehaves on long sequences of small gaps versus short sequences of large gaps. The skill is **not** memorizing which codec is "best".

---
