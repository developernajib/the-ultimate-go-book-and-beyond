## Exercises

### Exercise 1: Cache Line Experiment

Write a program that creates a large array of structs and measures access time with varying struct sizes (8, 16, 32, 64, 128, 256 bytes). Graph the results and explain the performance cliff when struct size crosses cache line boundaries.

### Exercise 2: SoA Transformation

Take this AoS game entity structure and convert it to SoA. Benchmark both versions for a position update loop over 10 million entities:

```cpp
struct GameEntity {
    float pos_x, pos_y, pos_z;
    float vel_x, vel_y, vel_z;
    float health;
    int team_id;
    uint64_t entity_id;
    std::string name;
    bool is_alive;
};
```

### Exercise 3: Branchless Min/Max

Implement branchless `min`, `max`, `abs`, and `clamp` functions for integers. Benchmark them against the standard library versions with uniformly random input. Explain when the branchless versions win and when they lose.

### Exercise 4: SIMD Vector Operations

Using AVX2 intrinsics, implement:
- Element-wise addition of two `float` arrays
- Dot product of two `float` arrays
- Finding the maximum value in a `float` array

Compare performance against the scalar versions and report the speedup.

### Exercise 5: PGO Measurement

Take a non-trivial program (a JSON parser, a compression utility, or a sorting benchmark) and measure performance in three configurations:
1. `-O2` only
2. `-O2 -flto`
3. `-O2 -flto` with PGO

Report the percentage improvement at each stage.

### Exercise 6: Profiling Investigation

Write a deliberately cache-unfriendly program (e.g., random traversal of a large linked list) and a cache-friendly version (vector with sequential access). Use `perf stat` to collect L1 and LLC cache miss rates for both. Explain the relationship between miss rates and wall-clock time.

### Exercise 7: Latency Estimation

Without running any code, estimate the time for each operation. Then measure and compare:
- Summing 1 million ints in a vector (fits in L2/L3)
- Summing 1 million ints via random access in a 1 GB array (cache misses)
- Making 1000 uncontended mutex lock/unlock pairs
- Reading 1 MB sequentially from an NVMe SSD via `mmap`

---
