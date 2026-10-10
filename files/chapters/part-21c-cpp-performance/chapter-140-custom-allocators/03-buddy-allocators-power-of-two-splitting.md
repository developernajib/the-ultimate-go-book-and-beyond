## Buddy Allocators, Power-of-Two Splitting

The buddy allocator is a classic algorithm that handles variable-size allocations efficiently by splitting and coalescing power-of-two-sized blocks. It provides O(log n) allocation and deallocation with minimal external fragmentation.

### How It Works

1. Start with one large block of size 2^N.
2. To allocate size S, find the smallest power-of-two block >= S.
3. If no block of that size exists, split a larger block in half (creating two "buddies").
4. To free, check if the buddy is also free. If so, coalesce them back into the larger block.

```cpp
#include <cstddef>
#include <cstdint>
#include <cstring>
#include <cassert>
#include <cstdlib>
#include <new>

class BuddyAllocator {
    static constexpr size_t MIN_ORDER = 4;   // 16 bytes minimum
    static constexpr size_t MAX_ORDER = 20;  // 1 MB maximum
    static constexpr size_t LEVELS = MAX_ORDER - MIN_ORDER + 1;

    struct FreeBlock {
        FreeBlock* next;
    };

    uint8_t*    base_;
    FreeBlock*  free_lists_[LEVELS];
    size_t      total_size_;

    static size_t order_for_size(size_t size) {
        size_t order = MIN_ORDER;
        while ((static_cast<size_t>(1) << order) < size) {
            ++order;
        }
        return order;
    }

    size_t index_for_order(size_t order) const {
        return order - MIN_ORDER;
    }

    // Given a block at ptr of given order, find its buddy
    uint8_t* buddy_of(uint8_t* ptr, size_t order) const {
        size_t offset = ptr - base_;
        size_t buddy_offset = offset ^ (static_cast<size_t>(1) << order);
        return base_ + buddy_offset;
    }

    void remove_from_free_list(size_t order, FreeBlock* block) {
        size_t idx = index_for_order(order);
        FreeBlock** prev = &free_lists_[idx];
        while (*prev) {
            if (*prev == block) {
                *prev = block->next;
                return;
            }
            prev = &(*prev)->next;
        }
    }

    bool is_in_free_list(size_t order, FreeBlock* block) const {
        size_t idx = index_for_order(order);
        for (FreeBlock* f = free_lists_[idx]; f; f = f->next) {
            if (f == block) return true;
        }
        return false;
    }

public:
    BuddyAllocator()
        : total_size_(static_cast<size_t>(1) << MAX_ORDER)
    {
        base_ = static_cast<uint8_t*>(std::aligned_alloc(total_size_, total_size_));
        if (!base_) throw std::bad_alloc();

        std::memset(free_lists_, 0, sizeof(free_lists_));

        // Initially, one big free block at the highest order
        auto* block = reinterpret_cast<FreeBlock*>(base_);
        block->next = nullptr;
        free_lists_[index_for_order(MAX_ORDER)] = block;
    }

    ~BuddyAllocator() {
        std::free(base_);
    }

    void* allocate(size_t size) {
        size_t order = order_for_size(size);
        if (order > MAX_ORDER) return nullptr;

        // Find the smallest available block >= requested order
        for (size_t current = order; current <= MAX_ORDER; ++current) {
            size_t idx = index_for_order(current);
            if (!free_lists_[idx]) continue;

            // Remove block from free list
            FreeBlock* block = free_lists_[idx];
            free_lists_[idx] = block->next;

            // Split down to the requested order
            while (current > order) {
                --current;
                size_t buddy_size = static_cast<size_t>(1) << current;
                auto* buddy = reinterpret_cast<FreeBlock*>(
                    reinterpret_cast<uint8_t*>(block) + buddy_size
                );
                buddy->next = free_lists_[index_for_order(current)];
                free_lists_[index_for_order(current)] = buddy;
            }

            return block;
        }

        return nullptr;  // No block large enough
    }

    void deallocate(void* ptr, size_t size) {
        if (!ptr) return;

        size_t order = order_for_size(size);
        auto* block = static_cast<uint8_t*>(ptr);

        // Try to coalesce with buddy
        while (order < MAX_ORDER) {
            uint8_t* buddy = buddy_of(block, order);
            auto* buddy_block = reinterpret_cast<FreeBlock*>(buddy);

            if (!is_in_free_list(order, buddy_block)) break;

            // Remove buddy from free list and merge
            remove_from_free_list(order, buddy_block);

            // Merged block starts at the lower address
            if (buddy < block) block = buddy;
            ++order;
        }

        // Add merged block to free list
        auto* free_block = reinterpret_cast<FreeBlock*>(block);
        size_t idx = index_for_order(order);
        free_block->next = free_lists_[idx];
        free_lists_[idx] = free_block;
    }
};
```

### Buddy Allocator Trade-offs

**Strengths:**
- Coalescing is efficient, only check one buddy, not scan a list.
- External fragmentation is bounded.
- O(log n) allocation and deallocation.

**Weaknesses:**
- Internal fragmentation: a 33-byte request wastes 31 bytes (rounded to 64).
- Power-of-two sizes waste up to 50% of memory in the worst case.
- The Linux kernel uses a buddy allocator for page-level allocation, paired with slab allocators for smaller objects to mitigate the internal fragmentation problem.

---
