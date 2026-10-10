## Entity-Component-System (ECS) Architecture

ECS is the pattern that games and high-performance simulations reach for when classical OOP inheritance hierarchies collapse under their own weight. The core insight: instead of encoding behavior in class hierarchies, separate data (components) from identity (entities) from logic (systems), and arrange the data for cache efficiency. The result is radically better performance and a more composable design.

### The Inheritance Problem ECS Solves

Classical OOP game architecture leads to fragile hierarchies:

```cpp
// OOP approach: deep inheritance tree
class Entity { ... };
class Character : public Entity { ... };
class Player : public Character { ... };      // Has everything Character has
class Enemy  : public Character { ... };
class FlyingEnemy : public Enemy { ... };     // What if it also has Player stats?
// Diamond problem: FlyingPlayerControlledEnemy?
```

Adding a new behavior requires either widening the hierarchy or using mixins with all their ambiguity problems. Cache behavior is poor: each entity allocates separately on the heap, virtual dispatch prevents vectorization, and iterating all entities of a type scatters across memory.

### ECS Fundamentals

- **Entity**: an integer ID. Nothing more. No data, no methods.
- **Component**: a plain data struct. No methods, no inheritance. Holds only state.
- **System**: a function that iterates over entities that have a specific set of components and processes them.

```cpp
#include <cstdint>
#include <vector>
#include <unordered_map>
#include <optional>
#include <functional>
#include <cassert>
#include <iostream>
#include <algorithm>

using EntityId = std::uint32_t;
static constexpr EntityId INVALID_ENTITY = 0;

// ---- Components: plain data structs, no virtual methods --------------------

struct Position {
    float x = 0.0f;
    float y = 0.0f;
};

struct Velocity {
    float dx = 0.0f;
    float dy = 0.0f;
};

struct Health {
    float current = 100.0f;
    float maximum = 100.0f;
    bool  alive   = true;
};

struct Sprite {
    uint32_t texture_id = 0;
    float    scale      = 1.0f;
};
```

### Sparse Set: O(1) Component Storage

A sparse set is the data structure behind fast ECS implementations. It gives O(1) add, O(1) remove, O(1) lookup, and dense iteration over active components, the combination no other structure provides.

```cpp
// Sparse set: maps EntityId -> component with O(1) ops and dense storage
template <typename Component>
class ComponentStore {
    // sparse_[entity_id] = index into dense_ (or INVALID if not present)
    std::vector<std::uint32_t> sparse_;
    // Dense storage: packed array of components for cache-friendly iteration
    std::vector<Component>     dense_;
    std::vector<EntityId>      entities_;  // Which entity owns dense_[i]

    static constexpr std::uint32_t INVALID_IDX = ~std::uint32_t{0};

public:
    void ensure_capacity(EntityId id) {
        if (id >= sparse_.size()) {
            sparse_.resize(id + 1, INVALID_IDX);
        }
    }

    // O(1) insert
    void insert(EntityId id, Component component) {
        ensure_capacity(id);
        if (has(id)) {
            dense_[sparse_[id]] = std::move(component);
            return;
        }
        sparse_[id] = static_cast<std::uint32_t>(dense_.size());
        dense_.push_back(std::move(component));
        entities_.push_back(id);
    }

    // O(1) remove using swap-and-pop
    void remove(EntityId id) {
        if (!has(id)) return;

        std::uint32_t idx  = sparse_[id];
        EntityId      last = entities_.back();

        // Move last element into the removed slot
        dense_[idx]    = std::move(dense_.back());
        entities_[idx] = last;
        sparse_[last]  = idx;

        dense_.pop_back();
        entities_.pop_back();
        sparse_[id] = INVALID_IDX;
    }

    // O(1) lookup
    [[nodiscard]] bool has(EntityId id) const noexcept {
        return id < sparse_.size() && sparse_[id] != INVALID_IDX;
    }

    Component& get(EntityId id) {
        assert(has(id));
        return dense_[sparse_[id]];
    }

    const Component& get(EntityId id) const {
        assert(has(id));
        return dense_[sparse_[id]];
    }

    // Dense iteration: all active components, cache-friendly
    auto begin()       { return dense_.begin(); }
    auto end()         { return dense_.end(); }
    const auto& entities() const { return entities_; }
    std::size_t size() const { return dense_.size(); }
};
```

### The World: Entity Management

`World` owns one `ComponentStore` per component type and a free-list of recycled `EntityId` integers. Entity creation and destruction are O(1) pointer-bump/free-list operations, and component access is a direct indexed lookup into a dense array rather than a virtual dispatch, which keeps cache utilization high for systems that iterate over large populations of entities.
```cpp
class World {
    EntityId           next_id_   = 1;
    std::vector<EntityId> free_ids_;

public:
    // Component stores -- one per component type
    ComponentStore<Position> positions;
    ComponentStore<Velocity> velocities;
    ComponentStore<Health>   healths;
    ComponentStore<Sprite>   sprites;

    EntityId create_entity() {
        if (!free_ids_.empty()) {
            auto id = free_ids_.back();
            free_ids_.pop_back();
            return id;
        }
        return next_id_++;
    }

    void destroy_entity(EntityId id) {
        positions .remove(id);
        velocities.remove(id);
        healths   .remove(id);
        sprites   .remove(id);
        free_ids_.push_back(id);
    }
};
```

### Systems: Logic as Free Functions

Systems iterate over component stores and apply logic. They are not classes, they are functions:

```cpp
// Movement system: applies velocity to position for all moving entities
void movement_system(World& world, float dt) {
    // Iterate the smaller set and look up the other -- avoids scanning all entities
    for (std::size_t i = 0; i < world.velocities.size(); ++i) {
        EntityId id = world.velocities.entities()[i];
        if (!world.positions.has(id)) continue;

        auto& pos = world.positions.get(id);
        auto& vel = world.velocities.entities()[i];  // dense index
        const auto& v = world.velocities.get(id);

        pos.x += v.dx * dt;
        pos.y += v.dy * dt;
    }
}

// Health system: mark entities as dead when HP hits zero
void health_system(World& world) {
    for (auto& hp : world.healths) {
        if (hp.current <= 0.0f) {
            hp.alive = false;
        }
    }
}

// Cleanup system: destroy dead entities at end of frame
void cleanup_system(World& world) {
    // Collect dead entity ids first (avoid modifying during iteration)
    std::vector<EntityId> to_destroy;
    for (std::size_t i = 0; i < world.healths.size(); ++i) {
        if (!world.healths.entities()[i]) continue;  // already removed
        EntityId id = world.healths.entities()[i];
        if (!world.healths.get(id).alive) {
            to_destroy.push_back(id);
        }
    }
    for (EntityId id : to_destroy) {
        world.destroy_entity(id);
    }
}
```

### A Complete Game Loop

The game loop below creates entities, assigns components, then iterates systems (physics, rendering) in sequence each frame. Each system queries only the component stores it depends on, so adding a new entity type or component never requires modifying existing system code, a concrete demonstration of the Open-Closed Principle that ECS achieves through data composition rather than class inheritance.
```cpp
void game_loop() {
    World world;

    // Create a player entity
    EntityId player = world.create_entity();
    world.positions .insert(player, Position{100.0f, 200.0f});
    world.velocities.insert(player, Velocity{50.0f, 0.0f});
    world.healths   .insert(player, Health{100.0f, 100.0f});
    world.sprites   .insert(player, Sprite{1, 2.0f});

    // Create 1000 enemies (all with position + health, no sprite for simplicity)
    for (int i = 0; i < 1000; ++i) {
        EntityId enemy = world.create_entity();
        world.positions.insert(enemy, Position{
            static_cast<float>(i * 5), 300.0f
        });
        world.healths.insert(enemy, Health{50.0f, 50.0f});
    }

    // Simulate 60 frames
    const float dt = 1.0f / 60.0f;
    for (int frame = 0; frame < 60; ++frame) {
        movement_system(world, dt);   // Move everything with velocity
        health_system(world);         // Detect deaths
        cleanup_system(world);        // Remove dead entities
    }

    std::cout << "Remaining entities with positions: "
              << world.positions.size() << '\n';
}
```

### Cache Performance: Why ECS Wins

Classical OOP stores each entity as a heap-allocated object. Iterating 1000 entities means 1000 pointer dereferences into random memory, cache miss per entity. ECS stores all `Position` components in a contiguous array. Iterating 1000 positions is a sequential scan through 8000 bytes, fits in L1 cache, SIMD-vectorizable.

The speedup in practice: 5-20x faster for systems that iterate all entities of a type, which is the common case in game loops. This is why every major game engine (Unreal's Mass, Unity DOTS, Flecs, EnTT) uses ECS.

### Go Comparison: Struct Embedding and Interface Composition

Go's approach to composition uses struct embedding and interfaces:

```go
type Entity struct {
    Position Position
    Velocity *Velocity  // nil if not moving
    Health   *Health    // nil if indestructible
}

// Iterating all entities requires checking nil pointers
// No cache locality guarantee -- each Entity is a separate heap allocation
for _, e := range entities {
    if e.Velocity != nil {
        e.Position.X += e.Velocity.DX * dt
        e.Position.Y += e.Velocity.DY * dt
    }
}
```

Go's approach is more readable but not cache-optimal. Each `Entity` struct may be allocated separately, velocity checks require nil comparisons, and the data is not packed. For game-scale workloads (100K+ entities per frame), Go's approach is measurably slower. For business logic where the entity count is in the hundreds, it is perfectly fine. ECS is a performance-specific pattern, reach for it when profiling shows iteration cost, not as a default architecture.

---
