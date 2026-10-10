## The Entity Component System

ECS is what data-oriented design looks like when it becomes an architecture. It is the dominant pattern in modern engines and it is a specific answer to a specific problem, not a style choice.

### The Problem It Solves

The inheritance hierarchy is the natural first design and it fails predictably:

```cpp
class GameObject { virtual void Update(); };
class Character : public GameObject { ... };
class Player : public Character { ... };
class Enemy : public Character { ... };
class FlyingEnemy : public Enemy { ... };
```

Then design asks for a flying enemy that is also a vehicle the player can pilot, and the hierarchy has no answer. This is the deep-hierarchy failure, and every engine hit it in the 1990s. Composition over inheritance is the fix, and ECS is composition taken to its conclusion:

- **Entity**: an ID. Not an object, just an integer.
- **Component**: plain data. `Position`, `Velocity`, `Health`. No methods, no vtable.
- **System**: a function that runs over every entity having a given set of components.

An entity *is* the components attached to it. A flying pilotable enemy is an entity with `Transform`, `Flight`, `Vehicle`, `AI`, and `Health`. No hierarchy, no diamond, no refactor.

### Archetype Storage

The naive implementation stores each component type in a sparse array indexed by entity ID, and it is a cache disaster: iterating "everything with Position and Velocity" means checking every entity and chasing scattered arrays.

The layout modern engines use, Unity DOTS and the widely-used C++ library EnTT among them, is the **archetype**: entities with the identical component set are stored together, each component in its own dense array.

```cpp
// An archetype is one component signature and its dense columns.
struct Archetype {
    ComponentMask signature;          // e.g. Position|Velocity|Health
    std::vector<EntityId> entities;   // which entities live here
    std::vector<void*>    columns;    // one dense array per component
    size_t count;
};
```

Now the query is trivial and the iteration is linear:

```cpp
// Every archetype whose signature includes Position and Velocity.
for (Archetype& arch : world.matching(Position::mask | Velocity::mask)) {
    auto* pos = arch.column<Position>();
    auto* vel = arch.column<Velocity>();
    for (size_t i = 0; i < arch.count; ++i) {
        pos[i].value += vel[i].value * dt;   // linear, vectorizable
    }
}
```

This is section 03's SoA loop, arrived at structurally rather than by hand. The query cost is proportional to the number of archetypes (dozens) rather than entities (hundreds of thousands), and the inner loop is the tight linear pass the hardware wants.

The trade-off is the part to know: **adding or removing a component moves the entity to a different archetype**, which means copying its data. Archetype ECS is fast to iterate and comparatively slow to mutate structure. Games that add and remove components constantly (a `Stunned` tag every frame) will feel it, and the idiomatic fix is to use a flag inside an existing component rather than a component whose presence toggles.

### Handles, Not Pointers

Entities move in memory: archetype changes copy them, and dense arrays compact on removal. A raw `Entity*` is therefore a dangling pointer waiting for a frame to pass. Engines use generational handles instead.

```cpp
struct EntityId {
    uint32_t index;       // slot in the entity table
    uint32_t generation;  // bumped when the slot is recycled
};

// A stale handle is detected, not dereferenced.
Entity* World::resolve(EntityId id) {
    if (id.index >= slots.size()) return nullptr;
    Slot& s = slots[id.index];
    if (s.generation != id.generation) return nullptr;  // freed and reused
    return &s.entity;
}
```

The generation counter is what makes this safe. Destroy an entity and its slot's generation increments, so every handle still pointing at that slot fails validation instead of silently reading a different entity's data. That converts a use-after-free, the worst bug class in C++, into a null check.

This is the pattern that replaces `shared_ptr` in engines. It is 8 bytes, it is trivially copyable, it needs no atomic, and it is safe across frames.

### What ECS Costs

It is not free, and being able to say so is what separates having used it from having read about it.

**Debugging is worse.** An entity is not an object you can inspect. In a debugger it is an integer, and its data is scattered across archetype columns. Every serious ECS ships an inspector tool because the debugger alone is not enough.

**Random access is worse.** ECS optimizes iterating all entities with a component set. "Give me entity 4,231's health" is a handle resolve plus an archetype lookup plus an index, which is slower than a pointer dereference. Games that mostly do random access by ID are fighting the design.

**Cross-entity logic is awkward.** "Damage the entity that this projectile hit" crosses archetypes and often becomes a deferred command buffer, because mutating structure mid-iteration invalidates the arrays you are iterating. Every ECS has a command-buffer concept for exactly this, and it is where the complexity lives.

**It is overkill below a threshold.** A puzzle game with 200 entities gains nothing measurable and pays all the complexity. ECS earns out at thousands of entities with hot per-frame passes.

### Junior to FAANG: The Comparison They Want

"Why ECS instead of inheritance?" wants three points, not one.

Composition solves the hierarchy problem: a flying pilotable enemy has no place in a tree, and it is just a component set. Cache layout: components live in dense per-type arrays, so a system's pass is linear and vectorizable rather than a pointer chase through heterogeneous objects with vtables. Parallelism: systems declare which components they read and write, so the scheduler can run non-overlapping systems concurrently without locks, which section 06 covers.

Then name a cost, because an answer with no downside reads as unexamined. Structural changes are expensive in archetype ECS, and debugging needs tooling.

### Senior at FAANG: The Scheduler Is the Real Win

At scale the compelling property of ECS is not the cache, it is that the dependency graph becomes **declarative**. A system that reads `Position` and writes `Velocity` has stated its data dependencies in its signature, so the engine can compute which systems conflict and schedule the rest in parallel automatically. No locks, no manual thread assignment, no data races by construction: two systems that touch disjoint component sets provably cannot interfere.

That is the property Unity's DOTS is built to exploit, and it is why ECS scales across cores in a way an inheritance-based engine never did. It also inverts the debugging story: races become impossible in the common case, and the bugs you get instead are ordering bugs, which are deterministic and reproducible.

The design-review consequence is that component signatures are an API. Widening a system's signature to "read everything" is the ECS equivalent of taking a global lock: it is easy, it compiles, and it silently serializes your frame. A senior reviewer should read a system's declared components the way they read a lock's scope, and ask why each one is there.
