export default `## 7.8 Map Internals

Go 1.24 (February 2025) replaced the legacy bucket-and-overflow hash map with an implementation derived from Google's Abseil Swiss Tables. The language-level contract is unchanged: iteration order is still randomized, maps are still unsafe for concurrent use, nil reads still succeed, nil writes still panic. What changed is the internal layout and lookup algorithm, which matters when you are debugging map performance or reading \`runtime/map*\` source.

### The Swiss Table Layout (Go 1.24+)

Entries live in groups of 8 slots. Each group has a parallel 8-byte control word where each byte stores one slot's state, empty, deleted, or the 7-bit fingerprint (H2) of that slot's hash. Groups are organized into tables that use extendible hashing, so the table can grow only the region where a group overflowed rather than rehashing the entire map.

\`\`\`go
// Simplified view of the Go 1.24+ map runtime structures.
// The exact types live in runtime/map_swiss.go, names may evolve.
type swissMap struct {
    used         uint64         // number of live entries
    seed         uintptr        // hash seed for randomization
    dirPtr       unsafe.Pointer // directory of tables (extendible hashing)
    dirLen       int
    globalDepth  uint8          // log2 of directory length
    globalShift  uint8          // 64 - globalDepth (for hash splitting)
    writing      uint8          // concurrent-access guard
    // elemsize, keySize, etc. for the specific map type
}

type swissTable struct {
    used       uint16              // live entries in this table
    capacity   uint16              // 2^groupShift * slotsPerGroup
    groupShift uint8
    groups     unsafe.Pointer      // pointer to groups array
}

// A group holds 8 slots plus a packed control word.
// Logically:
//   ctrl   [8]uint8   // per-slot state: empty/deleted/fingerprint
//   keys   [8]keyType
//   values [8]valueType
\`\`\`

### Lookup Algorithm

\`\`\`
1. Hash the key once:    h := hash(key, seed)
2. Split the hash:
   - h1 (upper ~57 bits): directory + group index
   - h2 (lower 7 bits):   fingerprint stored in control byte
3. Find the group via extendible hashing on h1.
4. Compare all 8 control bytes against h2 in parallel.
   On amd64 and arm64 this is a single SIMD instruction.
5. For each fingerprint match, do a full key compare.
   Exactly one will match for the hit case; zero for a miss.
6. If the group is full and no match found, probe the next group
   (linear probing inside the table).
\`\`\`

The win over the legacy bucket layout is that step 4 replaces an 8-element loop with one SIMD compare, and steps 3 and 4 together touch only 2 cache lines per group. Lookups, insertions, and deletions are roughly 30 to 60 percent faster on microbenchmarks, iteration roughly 50 percent faster. Datadog reported saving hundreds of gigabytes of RSS across their Go services after upgrading, with no code changes.

### Map Growth

Maps grow when the load factor would exceed approximately 7 out of 8 slots filled per group across the table, or when the number of deleted entries plus live entries in a group would saturate probing. Extendible hashing lets the runtime split a single overflowing table (doubling only that portion of the directory) instead of rehashing the entire map, which keeps growth amortized and avoids the bulk-copy pause that showed up in the legacy implementation.

### Why Maps Are Still Not Concurrency-Safe

The \`writing\` field in \`swissMap\` is a cheap race detector, not a lock. The runtime checks it on every write and panics with "concurrent map writes" or "concurrent map read and map write" if two goroutines step on each other. This is the same contract the old map had. Use \`sync.RWMutex\` around a plain map for write-heavy workloads, \`sync.Map\` for mostly-read workloads, or a sharded map for hot contention paths.

### Legacy Note: Pre-1.24 hmap

Older Go versions (up to 1.23) used a different layout with \`hmap\` and \`bmap\` structs, buckets of 8 slots chained through \`overflow\` pointers, and a \`tophash\` array. Interview questions and blog posts from that era frequently reference those names. If you are reading pre-2025 material on Go map internals, translate: "bucket" becomes "group", "tophash" becomes "control byte", "overflow bucket" no longer exists (Swiss Tables use linear probing and extendible-hash splitting instead), and "load factor 6.5" is replaced by the 7-out-of-8 rule above.

### Map Growth Demonstration

\`\`\`go
package main

import (
    "fmt"
    "runtime"
)

func main() {
    m := make(map[int]int)

    fmt.Println("Adding elements and observing heap behavior:")
    for i := 0; i < 10000; i++ {
        m[i] = i
        if i == 0 || i == 8 || i == 64 || i == 512 || i == 4096 {
            var stats runtime.MemStats
            runtime.ReadMemStats(&stats)
            fmt.Printf("Elements: %5d, HeapAlloc: %d KB\\n",
                len(m), stats.HeapAlloc/1024)
        }
    }
}
\`\`\`

### Incident Playbook: Map Misuse

Three patterns that cause incidents:

1. **Concurrent map access without synchronisation.** The runtime detects this and panics with "fatal error: concurrent map read and map write". Diagnosis: the panic stack trace points at the map. Fix: add a mutex or use \`sync.Map\`.
2. **Map iteration order dependency.** A test that passes locally fails in CI because iteration order changed. Fix: sort the keys explicitly for any deterministic output.
3. **Map that grows without shrinking.** A cache that reaches millions of entries, then drops to hundreds, retains the memory. Fix: periodically rebuild with \`maps.Clone\`.

### Code-Review Lens (Senior Track)

Two patterns to flag:

1. **\`map[K]V\` for concurrent read/write.** Always wrong. Mutex or \`sync.Map\`.
2. **Large map used as a slow cache.** Consider the real cache library (\`ristretto\`, \`bigcache\`, or a proper LRU).

---
`;
