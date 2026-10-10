## 16. Streaming Stores and Non-Temporal Operations

A normal store on x86 fetches the cache line first (write-allocate), modifies it, and the line goes through the cache hierarchy. For data that will not be re-read, this wastes cache space and bandwidth. Streaming stores (non-temporal) bypass the cache, going from registers through write-combining buffers directly to memory.

### When to Use Streaming Stores

The pattern: write a large region once, never read it on this core.

- Logging buffers being filled before flush.
- Video frame buffers being composited.
- Network packet payloads being staged for DMA.
- Memcpy of very large regions (multi-MB).
- Initializing a large region with zero or a fixed value.

For these, write-allocate is wasteful. The CPU pulls a line into L1, you overwrite it entirely, then it gets evicted to L2 to L3 to memory. The cache traffic is doubled vs streaming.

### The Instructions (x86)

| Intrinsic | Instruction | Notes |
|---|---|---|
| `_mm_stream_si32` | MOVNTI | 4 bytes |
| `_mm_stream_si64` | MOVNTI | 8 bytes |
| `_mm_stream_si128` | MOVNTDQ | 16 bytes (SSE) |
| `_mm256_stream_si256` | VMOVNTDQ | 32 bytes (AVX) |
| `_mm512_stream_si512` | VMOVNTDQ | 64 bytes (AVX-512) |
| `_mm_stream_load_si128` | MOVNTDQA | non-temporal load (only useful from WC memory) |

Example: zero a buffer with streaming stores.

```cpp
#include <immintrin.h>
#include <cstring>

void stream_zero(void* dst, size_t bytes) {
    char* p = static_cast<char*>(dst);
    char* end = p + bytes;
    __m256i z = _mm256_setzero_si256();
    while (p + 32 <= end) {
        _mm256_stream_si256(reinterpret_cast<__m256i*>(p), z);
        p += 32;
    }
    while (p < end) *p++ = 0;
    _mm_sfence();   // make sure stores are visible before next reads
}
```

The `_mm_sfence` is critical. Streaming stores are weakly ordered relative to normal stores. Without a fence, a later normal load might miss the streamed data.

### Write-Combining Buffers

Streaming stores accumulate in 64-byte write-combining (WC) buffers. The CPU has a small number of these (typically 4 to 12). When a buffer fills, it flushes to memory as a single 64-byte burst. This is more efficient than one cache-line write per 64 bytes.

If you write 32 bytes (one AVX2 store) and then write to a different cache line, the partial buffer flushes. To get full WC efficiency, write all 64 bytes of a line consecutively before moving on.

```cpp
// Good: fill a line completely
_mm256_stream_si256(p + 0, v);
_mm256_stream_si256(p + 32, v);
// Next iteration, p += 64, fills the next line
```

Modern microarchitectures (Sapphire Rapids, Zen 4+) handle partial WC writes better than older parts, but the principle holds.

### When Streaming Stores Cost You

The trap: if you read the data soon after writing it, streaming stores are slower than regular stores. The data is in DRAM, not in cache, so the read pays full DRAM latency.

```cpp
// BAD: write then read soon after
stream_zero(buf, 1<<20);
process(buf);   // every read is a DRAM miss; would have been L1/L2 hit with normal stores

// GOOD: write final, no soon-after read
stream_zero(packet_payload, 1500);
nic_send(packet_payload);   // NIC DMAs from DRAM directly; we don't touch it again
```

The decision: estimate whether the writer or someone else will read the data within the cache lifetime (~milliseconds). If yes, regular stores. If no, streaming.

### memcpy and the Glibc Threshold

Glibc's memcpy switches to streaming stores above a size threshold (typically 1 MB to 8 MB, depends on the build's CPU features). Below the threshold, regular stores. The threshold is calibrated per microarchitecture.

You can override per-call:

```cpp
extern "C" void* memcpy_nontemporal(void* dst, const void* src, size_t n);
// Custom implementation using _mm256_stream_si256, with sfence at end.
```

Useful when you have many medium-sized copies (256 KB to 2 MB) where the glibc heuristic might not switch but you know the destination will not be re-read.

### Hardware Differences

Streaming stores behave differently across architectures:

- **Intel client (Skylake, Alder Lake)**: WC buffers shared with regular stores. Performance is good.
- **Intel server (Sapphire Rapids)**: separate WC paths, very high streaming bandwidth (100+ GB/s per socket).
- **AMD Zen 4**: streaming stores work but the prefetcher behavior differs. Test on your workload.
- **ARM (NEON, SVE)**: `STNP` (store pair non-temporal) and `STN` instructions exist. Behavior is implementation-defined, check the chip's optimization guide.
- **Apple M-series**: ARM with custom microarchitecture. Streaming hint is honored, but the cache hierarchy is different and the win may be smaller.

### Measuring the Win

```bash
perf stat -e cache-misses,cache-references,LLC-load-misses,LLC-store-misses \
  ./baseline_memcpy
perf stat -e cache-misses,cache-references,LLC-load-misses,LLC-store-misses \
  ./streaming_memcpy
```

The streaming version should show much lower LLC-store-misses (the stores bypass LLC entirely) and lower cache-misses on subsequent code (because the working set was not evicted).

### A Concrete Win: Logging

A logging library that fills a 4 KB buffer per message and flushes batches of 256 messages can use streaming stores for the message bodies:

```cpp
class StreamingLogger {
    static constexpr size_t MSG_SIZE = 4096;
    static constexpr size_t BATCH = 256;
    char* buf_;
    size_t pos_ = 0;
public:
    void log(const Message& m) {
        char* dst = buf_ + pos_;
        // Streaming-store-encode the message:
        encode_streaming(dst, m);
        pos_ += MSG_SIZE;
        if (pos_ == BATCH * MSG_SIZE) flush();
    }
    void flush() {
        _mm_sfence();
        write(fd_, buf_, pos_);
        pos_ = 0;
    }
};
```

The 1 MB buffer fills with streaming stores, never polluting the cache. The hot working set on this core (parsers, request state, business logic) stays in L2. Without streaming stores, that 1 MB would push everything else out of L2 four times per second under load.

### Junior to FAANG

A junior writes a tight memcpy loop and sees the performance crater because they did not realize cache pollution was the cost. A FAANG engineer recognizes the write-once pattern and reaches for streaming stores immediately.

### Senior at FAANG

Staff engineers profile the cache miss rate of unrelated code paths after the supposedly-fast memcpy. If the miss rate jumped 5x, the memcpy is polluting cache. The fix is streaming stores in the memcpy, not in the unrelated code. The diagnosis takes one minute if you know to look. The fix takes one line.

---
