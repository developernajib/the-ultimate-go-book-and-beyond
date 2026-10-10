## Cache-Friendly Data Structures: SoA vs AoS and Data-Oriented Design

### Array of Structures (AoS) vs Structure of Arrays (SoA)

The most impactful data layout decision in performance-critical code is whether to use AoS or SoA. AoS groups all fields of a single entity together. SoA groups all values of the same field together across entities.

```cpp
#include <vector>
#include <cmath>
#include <chrono>
#include <iostream>

// Array of Structures (AoS) - traditional OOP style
struct ParticleAoS {
    float x, y, z;       // position
    float vx, vy, vz;    // velocity
    float mass;           // mass
    float charge;         // charge
    int id;               // identifier
    bool active;          // is active
    // sizeof = 40 bytes with padding
};

// Structure of Arrays (SoA) - data-oriented style
struct ParticlesSoA {
    std::vector<float> x, y, z;
    std::vector<float> vx, vy, vz;
    std::vector<float> mass;
    std::vector<float> charge;
    std::vector<int> id;
    std::vector<bool> active;

    void resize(size_t n) {
        x.resize(n); y.resize(n); z.resize(n);
        vx.resize(n); vy.resize(n); vz.resize(n);
        mass.resize(n); charge.resize(n);
        id.resize(n); active.resize(n);
    }
};

// AoS update: each iteration loads 40 bytes, uses only 24 (position + velocity)
void update_positions_aos(std::vector<ParticleAoS>& particles, float dt) {
    for (auto& p : particles) {
        p.x += p.vx * dt;
        p.y += p.vy * dt;
        p.z += p.vz * dt;
    }
}

// SoA update: each iteration loads exactly the data it needs
void update_positions_soa(ParticlesSoA& particles, float dt, size_t n) {
    for (size_t i = 0; i < n; ++i) {
        particles.x[i] += particles.vx[i] * dt;
        particles.y[i] += particles.vy[i] * dt;
        particles.z[i] += particles.vz[i] * dt;
    }
}

void soa_vs_aos_benchmark() {
    constexpr size_t N = 10'000'000;

    // AoS benchmark
    std::vector<ParticleAoS> aos(N);
    for (size_t i = 0; i < N; ++i) {
        aos[i] = {1.0f, 2.0f, 3.0f, 0.1f, 0.2f, 0.3f, 1.0f, 0.0f, (int)i, true};
    }

    auto start = std::chrono::high_resolution_clock::now();
    for (int iter = 0; iter < 100; ++iter) {
        update_positions_aos(aos, 0.016f);
    }
    auto end = std::chrono::high_resolution_clock::now();
    auto aos_ms = std::chrono::duration_cast<std::chrono::milliseconds>(end - start).count();

    // SoA benchmark
    ParticlesSoA soa;
    soa.resize(N);
    for (size_t i = 0; i < N; ++i) {
        soa.x[i] = 1.0f; soa.y[i] = 2.0f; soa.z[i] = 3.0f;
        soa.vx[i] = 0.1f; soa.vy[i] = 0.2f; soa.vz[i] = 0.3f;
    }

    start = std::chrono::high_resolution_clock::now();
    for (int iter = 0; iter < 100; ++iter) {
        update_positions_soa(soa, 0.016f, N);
    }
    end = std::chrono::high_resolution_clock::now();
    auto soa_ms = std::chrono::duration_cast<std::chrono::milliseconds>(end - start).count();

    std::cout << "AoS: " << aos_ms << " ms\n";
    std::cout << "SoA: " << soa_ms << " ms\n";
    std::cout << "Speedup: " << (double)aos_ms / soa_ms << "x\n";
}
```

The SoA version typically runs 2-4x faster for this workload. The reason: the AoS version loads 40 bytes per particle but only uses the 24 bytes of position and velocity. The remaining 16 bytes waste cache line space. The SoA version loads only the arrays it needs, achieving near-perfect cache utilization.

### Data-Oriented Design Principles

Data-oriented design (DOD) is a systematic approach to structuring programs around data access patterns rather than object hierarchies:

1. **Separate hot and cold data.** Fields accessed together go in the same structure. Rarely accessed fields go elsewhere.
2. **Prefer contiguous arrays over pointer-linked structures.** Vectors beat linked lists. Indices beat pointers.
3. **Process data in bulk.** Batch operations on arrays enable vectorization and prefetching.
4. **Avoid virtual dispatch in hot loops.** Sort entities by type and process each type in a tight loop.

```cpp
// Hot/cold split: separate frequently and rarely accessed data
struct EntityHot {
    float x, y, z;       // accessed every frame
    float vx, vy, vz;    // accessed every frame
};

struct EntityCold {
    std::string name;     // accessed rarely
    int health;           // accessed occasionally
    int team_id;          // accessed occasionally
    uint64_t created_at;  // accessed rarely
};

// Process hot data in a tight loop without polluting cache with cold data
void physics_update(std::vector<EntityHot>& entities, float dt) {
    for (auto& e : entities) {
        e.x += e.vx * dt;
        e.y += e.vy * dt;
        e.z += e.vz * dt;
    }
}
```

---
