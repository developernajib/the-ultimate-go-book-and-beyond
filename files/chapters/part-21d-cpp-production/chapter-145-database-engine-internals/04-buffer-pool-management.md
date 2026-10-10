## Buffer Pool Management: Page Replacement and Dirty Page Flushing

The buffer pool is the most important performance component in a traditional database system. It is a fixed-size region of RAM divided into page-sized frames. When a query needs a page, the buffer pool fetches it from disk into a frame and returns a pointer to in-memory data. Subsequent accesses to the same page return the same pointer, no disk I/O. When the pool is full and a new page is needed, the replacement policy selects a victim frame to evict, flushing it to disk first if dirty.

PostgreSQL calls this the "shared buffer pool". InnoDB calls it the "buffer pool". The size is the single most impactful configuration parameter for database performance: PostgreSQL recommends setting `shared_buffers` to 25% of RAM. InnoDB's `innodb_buffer_pool_size` to 70-80% of RAM.

### Core Data Structures

The buffer pool's core data structures are a fixed-size array of `Page` frames, an `std::unordered_map<page_id_t, frame_id_t>` for O(1) lookup, and an `std::list<frame_id_t>` that implements the LRU eviction policy. The `pin_count` field prevents a page from being evicted while a query is actively reading it, analogous to a reference count, so the eviction algorithm only considers frames with `pin_count == 0`.
```cpp
#include <cassert>
#include <cstddef>
#include <cstdint>
#include <iostream>
#include <list>
#include <mutex>
#include <stdexcept>
#include <unordered_map>
#include <vector>

using page_id_t  = uint32_t;
using frame_id_t = uint32_t;
static constexpr page_id_t  INVALID_PAGE_ID  = UINT32_MAX;
static constexpr frame_id_t INVALID_FRAME_ID = UINT32_MAX;
static constexpr size_t     PAGE_SIZE        = 4096;  // 4 KB

struct Page {
    uint8_t   data[PAGE_SIZE]{};
    page_id_t page_id    = INVALID_PAGE_ID;
    bool      dirty      = false;
    int       pin_count  = 0;  // callers currently holding this page

    void reset() {
        page_id   = INVALID_PAGE_ID;
        dirty     = false;
        pin_count = 0;
        std::memset(data, 0, PAGE_SIZE);
    }
};
```

### LRU-K Replacement Policy

Plain LRU suffers from "sequential flooding": a full table scan reads every page in the database once, evicting hot frequently-accessed pages from the pool. LRU-K evicts the page whose K-th most recent access is oldest. With K=2, a page accessed once during a full scan is evicted before pages that have been accessed multiple times. PostgreSQL and InnoDB both use variants of this idea (PostgreSQL uses a "clock" approximation. InnoDB uses a modified LRU with "young" and "old" sub-lists).

```cpp
class LRUKReplacer {
    struct FrameEntry {
        frame_id_t  frame_id;
        std::list<uint64_t> access_history;  // timestamps, newest last
        bool        evictable = true;
    };

    int                                          k_;
    uint64_t                                     current_timestamp_ = 0;
    std::unordered_map<frame_id_t, FrameEntry>   entries_;
    size_t                                       num_evictable_ = 0;

public:
    explicit LRUKReplacer(int k) : k_(k) {}

    void record_access(frame_id_t frame_id) {
        auto& e = entries_[frame_id];
        e.frame_id = frame_id;
        e.access_history.push_back(current_timestamp_++);
        // Keep only last K accesses
        while (static_cast<int>(e.access_history.size()) > k_) {
            e.access_history.pop_front();
        }
    }

    void set_evictable(frame_id_t frame_id, bool evictable) {
        auto it = entries_.find(frame_id);
        if (it == entries_.end()) return;
        bool was_evictable = it->second.evictable;
        it->second.evictable = evictable;
        if (evictable && !was_evictable) ++num_evictable_;
        if (!evictable && was_evictable) --num_evictable_;
    }

    // Returns INVALID_FRAME_ID if no victim available.
    frame_id_t evict() {
        if (num_evictable_ == 0) return INVALID_FRAME_ID;

        frame_id_t victim       = INVALID_FRAME_ID;
        uint64_t   oldest_k_ts  = UINT64_MAX;
        bool       victim_inf   = false;  // victim has < k accesses (inf dist)

        for (auto& [fid, e] : entries_) {
            if (!e.evictable) continue;

            bool has_k = (static_cast<int>(e.access_history.size()) == k_);

            if (!has_k) {
                // Fewer than K accesses: treated as +inf distance.
                // Among these, evict the one with the oldest single access.
                uint64_t earliest = e.access_history.front();
                if (!victim_inf || earliest < oldest_k_ts) {
                    victim      = fid;
                    oldest_k_ts = earliest;
                    victim_inf  = true;
                }
            } else if (!victim_inf) {
                // K accesses: compare K-th oldest access time
                uint64_t k_ts = e.access_history.front();
                if (k_ts < oldest_k_ts) {
                    victim      = fid;
                    oldest_k_ts = k_ts;
                }
            }
        }

        if (victim != INVALID_FRAME_ID) {
            entries_.erase(victim);
            --num_evictable_;
        }
        return victim;
    }

    void remove(frame_id_t frame_id) {
        auto it = entries_.find(frame_id);
        if (it == entries_.end()) return;
        if (it->second.evictable) --num_evictable_;
        entries_.erase(it);
    }

    size_t size() const { return num_evictable_; }
};
```

### Buffer Pool Manager

`BufferPoolManager::fetch_page` first checks the page table for a cache hit, returning the pinned frame immediately. On a miss it selects an LRU victim frame, writes it back to disk if dirty, then reads the requested page from disk into that frame. The `unpin_page` call decrements the pin count and optionally marks the frame dirty, giving callers explicit control over when the buffer pool may flush their modifications.
```cpp
// Simplified disk manager: reads/writes pages to a flat file
struct DiskManager {
    std::fstream file_;
    page_id_t    next_page_id_ = 0;

    explicit DiskManager(const std::string& path) {
        file_.open(path, std::ios::in | std::ios::out |
                         std::ios::binary | std::ios::trunc);
        if (!file_.is_open()) throw std::runtime_error("Cannot open db file");
    }

    void write_page(page_id_t id, const uint8_t* data) {
        file_.seekp(static_cast<std::streamoff>(id) * PAGE_SIZE);
        file_.write(reinterpret_cast<const char*>(data), PAGE_SIZE);
        file_.flush();
    }

    void read_page(page_id_t id, uint8_t* data) {
        file_.seekg(static_cast<std::streamoff>(id) * PAGE_SIZE);
        if (!file_.read(reinterpret_cast<char*>(data), PAGE_SIZE)) {
            std::memset(data, 0, PAGE_SIZE);  // new page: zero-filled
        }
    }

    page_id_t allocate_page() { return next_page_id_++; }
};

class BufferPoolManager {
    size_t                                          pool_size_;
    std::vector<Page>                               pages_;
    std::unordered_map<page_id_t, frame_id_t>       page_table_;
    std::list<frame_id_t>                           free_list_;
    LRUKReplacer                                    replacer_;
    DiskManager                                     disk_;
    mutable std::mutex                              latch_;

    // Evict a frame: flush to disk if dirty, then return the frame id.
    frame_id_t evict_frame() {
        frame_id_t fid = replacer_.evict();
        if (fid == INVALID_FRAME_ID) return INVALID_FRAME_ID;

        Page& page = pages_[fid];
        if (page.dirty) {
            disk_.write_page(page.page_id, page.data);
            page.dirty = false;
        }
        page_table_.erase(page.page_id);
        page.reset();
        return fid;
    }

public:
    BufferPoolManager(size_t pool_size, const std::string& db_path)
        : pool_size_(pool_size)
        , pages_(pool_size)
        , replacer_(2)        // LRU-2
        , disk_(db_path)
    {
        for (frame_id_t i = 0; i < pool_size; ++i) free_list_.push_back(i);
    }

    // Fetch page from buffer pool (or disk if not cached).
    // Caller MUST call UnpinPage when done. Pin count > 0 prevents eviction.
    Page* fetch_page(page_id_t page_id) {
        std::lock_guard lock(latch_);

        // Already in pool?
        auto it = page_table_.find(page_id);
        if (it != page_table_.end()) {
            frame_id_t fid = it->second;
            ++pages_[fid].pin_count;
            replacer_.record_access(fid);
            replacer_.set_evictable(fid, false);
            return &pages_[fid];
        }

        // Get a free or evictable frame
        frame_id_t fid = INVALID_FRAME_ID;
        if (!free_list_.empty()) {
            fid = free_list_.front();
            free_list_.pop_front();
        } else {
            fid = evict_frame();
            if (fid == INVALID_FRAME_ID) return nullptr;  // out of frames
        }

        // Load page from disk
        Page& frame = pages_[fid];
        frame.page_id   = page_id;
        frame.dirty     = false;
        frame.pin_count = 1;
        disk_.read_page(page_id, frame.data);

        page_table_[page_id] = fid;
        replacer_.record_access(fid);
        replacer_.set_evictable(fid, false);
        return &frame;
    }

    // Allocate a new page (not yet on disk).
    Page* new_page(page_id_t* page_id_out) {
        std::lock_guard lock(latch_);

        frame_id_t fid = INVALID_FRAME_ID;
        if (!free_list_.empty()) {
            fid = free_list_.front(); free_list_.pop_front();
        } else {
            fid = evict_frame();
            if (fid == INVALID_FRAME_ID) return nullptr;
        }

        page_id_t new_id = disk_.allocate_page();
        Page& frame      = pages_[fid];
        frame.page_id    = new_id;
        frame.dirty      = true;   // brand new, needs to be written
        frame.pin_count  = 1;

        page_table_[new_id] = fid;
        replacer_.record_access(fid);
        replacer_.set_evictable(fid, false);

        *page_id_out = new_id;
        return &frame;
    }

    // Release pin on a page. If dirty=true, mark it for write-back.
    bool unpin_page(page_id_t page_id, bool dirty) {
        std::lock_guard lock(latch_);
        auto it = page_table_.find(page_id);
        if (it == page_table_.end()) return false;

        frame_id_t fid = it->second;
        Page& page     = pages_[fid];
        if (page.pin_count == 0) return false;

        if (dirty) page.dirty = true;
        --page.pin_count;

        if (page.pin_count == 0) {
            replacer_.set_evictable(fid, true);
        }
        return true;
    }

    // Flush a specific page to disk (does not unpin or reset dirty flag).
    bool flush_page(page_id_t page_id) {
        std::lock_guard lock(latch_);
        auto it = page_table_.find(page_id);
        if (it == page_table_.end()) return false;

        Page& page = pages_[it->second];
        disk_.write_page(page_id, page.data);
        page.dirty = false;
        return true;
    }

    // Flush all dirty pages. Called during checkpoint.
    void flush_all() {
        std::lock_guard lock(latch_);
        for (auto& [pid, fid] : page_table_) {
            if (pages_[fid].dirty) {
                disk_.write_page(pid, pages_[fid].data);
                pages_[fid].dirty = false;
            }
        }
    }
};
```

### Sequential Flooding and Prefetching

A naive LRU buffer pool performs poorly for sequential scans. When a 100 GB table scan runs on a system with a 4 GB buffer pool, it evicts the entire working set of every other concurrent query. PostgreSQL solves this with a "ring buffer" for sequential scans: large sequential scans use a small fixed-size ring of 256 KB that wraps around, leaving the main pool untouched.

Prefetching is the complement: detect sequential access patterns (page N, N+1, N+2...) and issue asynchronous read-ahead requests so the next pages are already in RAM when the scan reaches them.

```cpp
// Sequential scan ring: doesn't participate in LRU, fixed size
struct SeqScanBuffer {
    static constexpr size_t RING_PAGES = 64;  // 256 KB ring
    Page ring_[RING_PAGES];
    size_t head_ = 0;

    Page* next_slot() {
        Page* p = &ring_[head_];
        head_ = (head_ + 1) % RING_PAGES;
        return p;
    }
};
```

### Go Comparison

`go.etcd.io/bbolt` (BoltDB) takes a fundamentally different approach: it uses `mmap()` to map the entire database file into the process address space and lets the OS page cache act as the buffer pool. This is simpler, no pin/unpin protocol, no LRU replacement, no dirty page tracking, but gives up control over eviction policy, prefetching, and write ordering. For bbolt's use case (small embedded databases, mostly reads), this is an excellent trade-off. For a high-throughput OLTP database under memory pressure, the OS page cache's simple LRU is insufficient, which is why PostgreSQL implements its own buffer pool on top of the OS.

---
