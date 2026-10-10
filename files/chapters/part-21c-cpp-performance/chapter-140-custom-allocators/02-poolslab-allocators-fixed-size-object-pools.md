## Pool/Slab Allocators, Fixed-Size Object Pools

When you allocate and free many objects of the same size, a pool allocator (also called a slab allocator) eliminates fragmentation entirely and provides O(1) allocation and deallocation.

### How It Works

The allocator pre-allocates a contiguous block, divides it into fixed-size slots, and maintains a free list threaded through the unused slots themselves, no extra metadata storage needed.

```cpp
#include <cstddef>
#include <cstdint>
#include <cstdlib>
#include <new>
#include <cassert>

template <typename T>
class PoolAllocator {
    union Slot {
        T       value;
        Slot*   next;

        Slot() {}   // Don't construct T yet
        ~Slot() {}  // Don't destroy T here
    };

    Slot*   slots_;
    Slot*   free_head_;
    size_t  capacity_;
    size_t  allocated_;

public:
    explicit PoolAllocator(size_t capacity)
        : capacity_(capacity)
        , allocated_(0)
    {
        slots_ = static_cast<Slot*>(
            std::aligned_alloc(alignof(Slot), capacity * sizeof(Slot))
        );
        if (!slots_) throw std::bad_alloc();

        // Thread free list through all slots
        free_head_ = &slots_[0];
        for (size_t i = 0; i < capacity - 1; ++i) {
            slots_[i].next = &slots_[i + 1];
        }
        slots_[capacity - 1].next = nullptr;
    }

    ~PoolAllocator() {
        std::free(slots_);
    }

    PoolAllocator(const PoolAllocator&) = delete;
    PoolAllocator& operator=(const PoolAllocator&) = delete;

    template <typename... Args>
    T* allocate(Args&&... args) {
        if (!free_head_) return nullptr;

        Slot* slot = free_head_;
        free_head_ = slot->next;
        ++allocated_;

        // Construct T in-place
        return new (&slot->value) T(std::forward<Args>(args)...);
    }

    void deallocate(T* ptr) {
        assert(ptr != nullptr);

        // Destroy the object
        ptr->~T();

        // Return slot to free list
        Slot* slot = reinterpret_cast<Slot*>(ptr);
        slot->next = free_head_;
        free_head_ = slot;
        --allocated_;
    }

    size_t allocated() const { return allocated_; }
    size_t available() const { return capacity_ - allocated_; }
};
```

### Usage Example: Game Entity System

The following complete example integrates the individual techniques covered in this chapter into a cohesive program that demonstrates how they interact in practice. Reading through the code in its entirety before examining individual sections provides essential context for understanding the design decisions.
```cpp
struct Entity {
    uint32_t id;
    float    x, y, z;
    uint32_t flags;
    char     name[32];
};

void game_loop() {
    PoolAllocator<Entity> entity_pool(10'000);

    // Spawn entities -- O(1) each
    Entity* player = entity_pool.allocate();
    player->id = 1;
    player->x = 0.0f;

    Entity* enemy = entity_pool.allocate();
    enemy->id = 2;
    enemy->x = 100.0f;

    // Despawn -- O(1), no fragmentation
    entity_pool.deallocate(enemy);

    // Next allocation reuses the same memory
    Entity* pickup = entity_pool.allocate();
    // pickup occupies the same slot enemy had

    entity_pool.deallocate(player);
    entity_pool.deallocate(pickup);
}
```

### Slab Allocator (Linux Kernel Style)

The Linux kernel's slab allocator extends the pool concept with multiple slabs. When one slab fills, a new one is allocated from the page allocator. Each slab is a pool of fixed-size objects for a particular type.

```cpp
#include <vector>
#include <cstdlib>
#include <cstdint>
#include <new>

template <typename T, size_t SlabSize = 64>
class SlabAllocator {
    struct Slab {
        uint8_t  storage[SlabSize * sizeof(T)];
        bool     used[SlabSize] = {};
        size_t   free_count = SlabSize;
        Slab*    next = nullptr;

        T* slot(size_t i) {
            return reinterpret_cast<T*>(storage + i * sizeof(T));
        }
    };

    Slab* head_ = nullptr;

    Slab* new_slab() {
        Slab* s = new Slab();
        s->next = head_;
        head_ = s;
        return s;
    }

    Slab* find_slab_with_space() {
        for (Slab* s = head_; s; s = s->next) {
            if (s->free_count > 0) return s;
        }
        return new_slab();
    }

public:
    ~SlabAllocator() {
        Slab* s = head_;
        while (s) {
            Slab* next = s->next;
            delete s;
            s = next;
        }
    }

    template <typename... Args>
    T* allocate(Args&&... args) {
        Slab* slab = find_slab_with_space();
        for (size_t i = 0; i < SlabSize; ++i) {
            if (!slab->used[i]) {
                slab->used[i] = true;
                --slab->free_count;
                return new (slab->slot(i)) T(std::forward<Args>(args)...);
            }
        }
        return nullptr;  // Should not reach here
    }

    void deallocate(T* ptr) {
        for (Slab* s = head_; s; s = s->next) {
            auto* base = reinterpret_cast<uint8_t*>(s->storage);
            auto* p    = reinterpret_cast<uint8_t*>(ptr);
            if (p >= base && p < base + SlabSize * sizeof(T)) {
                size_t index = (p - base) / sizeof(T);
                ptr->~T();
                s->used[index] = false;
                ++s->free_count;
                return;
            }
        }
    }
};
```

---
