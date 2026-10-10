## CPU Frequency and Thermal Effects

Two threads running the same code on the same core can produce wildly different cycle counts. The CPU runs at variable frequency, governed by power, thermals, and the instruction mix. Performance engineering on modern silicon means accounting for frequency as a first-class variable.

### Frequency States

| Concept | Meaning |
|---------|---------|
| Base | Guaranteed frequency at TDP under any workload |
| All-core turbo | Max frequency when all cores active |
| Single-core turbo | Max with only one core active |
| P-states | Performance levels (P0 = max) |
| C-states | Idle states (C1 short, C6 deep, lose context) |

Sapphire Rapids 8480+ example: base 2.0 GHz, all-core turbo ~3.0 GHz, single-core ~3.8 GHz. The same workload on a quiet box runs at 3.8, on a busy host at 2.5.

### Measuring Effective Frequency

```bash
perf stat -e cycles,ref-cycles,task-clock ./binary
```

`ref-cycles` is wall time normalized to the TSC (always counts at base). `cycles` counts at actual frequency.

```
effective_freq = cycles / task_clock_seconds
freq_ratio = cycles / ref-cycles
```

`freq_ratio` of 1.0 means base. 1.5 means turbo to 1.5x base. 0.7 means thermally throttled below base.

```bash
# Live per-CPU frequency
sudo turbostat --interval 1
# Or
perf stat -a -e msr/cpu_thermal_margin/,msr/aperf/,msr/mperf/
```

`turbostat` shows real freq, idle %, package power, core temp.

### Instruction-Mix Frequency Licensing

On Skylake-X through Icelake-SP, AVX-512 instructions caused a frequency drop ("license"):

| License | Triggered by | Max freq impact |
|---------|-------------|-----------------|
| 0 | scalar/SSE | full turbo |
| 1 | AVX/AVX2 256b heavy | -200 to -400 MHz |
| 2 | AVX-512 heavy (FMA) | -400 to -800 MHz |

License changes lasted ~2 ms after the last 512b instruction. Mixed workloads suffered: a hot loop with one AVX-512 region dropped the whole core for 2 ms.

Sapphire Rapids and later eliminated the explicit license model. AVX-512 still draws more power and may indirectly throttle, but there is no automatic step-down. AMD Zen 4 has no equivalent.

Granite Rapids and AVX10.1: tighter coupling between width and power. Sustained heavy FMA at high all-core can still hit power-cap throttling on dense racks.

### Thermal Throttling

The CPU monitors per-core temperature. At Tjmax (typically 100 to 105 C) it forces a frequency cut. PROCHOT# pin assertion and PL1/PL2 power caps cause similar drops.

```bash
# Throttling counters
turbostat --quiet --show CoreTmp,PkgTmp,PkgWatt,RAPL,CoreThr,PkgThr
```

`CoreThr` and `PkgThr` count throttle events. Non-zero means you are hitting limits.

Causes:

- Inadequate cooling (data center hot aisle, dense 1U with weak fans)
- High AVX-512/AMX duty cycle in a workload designed for cooler instructions
- Power cap policies (`MSR 0x610` PKG_RAPL_LIMIT)
- "Eco mode" BIOS settings

Mitigations:

- Lower all-core frequency cap to a sustainable point (better than the box thrashing between turbo and throttle)
- Spread heavy SIMD across more cores at lower duty
- Active cooling
- Set RAPL limits explicitly so behavior is predictable

### Frequency-Aware Benchmarking

Two runs of the same code on the same host can differ 30%. Without controls, benchmarks are useless.

```bash
# Pin frequency via cpupower
sudo cpupower frequency-set -g performance
sudo cpupower frequency-set --min 2400MHz --max 2400MHz

# Disable turbo
echo 1 | sudo tee /sys/devices/system/cpu/intel_pstate/no_turbo

# Pin process and forbid SMT sibling
taskset -c 4 ./benchmark    # core 4 only, sibling 4+nphys idle
chrt -f 99 ./benchmark      # SCHED_FIFO real-time priority

# Disable address space randomization for stability
setarch $(uname -m) -R ./benchmark
```

Production-grade benchmark harness (Google Benchmark) reports min, median, mean, stddev across iterations. Always read the stddev, single-shot timings are noise.

### Intel Speed Select Technology (SST)

Newer Xeons expose runtime frequency-priority. SST-PP (Performance Profile) lets the OS request different all-core/single-core trade-offs without a reboot. SST-CP (Core Power) lets you classify cores as High/Medium/Low priority for boost. SST-BF (Base Frequency) gives a subset of cores a higher guaranteed frequency.

```bash
# intel-speed-select tool
sudo intel-speed-select perf-profile get-config-current-level
sudo intel-speed-select perf-profile set-config-level -l 3
sudo intel-speed-select core-power assoc -c 0,1 -p 0   # high prio
```

Use case: latency-critical threads on SST-CP-priority-0 cores, batch on priority-2.

### AMD CPPC and Boost Behavior

AMD's analog is CPPC (Collaborative Processor Performance Control). Zen 4 added P-state-aware scheduling, the kernel can pick the best core for a high-priority task ("preferred cores", marked in /sys/devices/system/cpu/cpufreq/policy*/amd_pstate_*).

```bash
# Check
cat /sys/devices/system/cpu/cpu*/cpufreq/scaling_driver
cat /sys/devices/system/cpu/cpufreq/policy0/amd_pstate_prefcore_ranking
```

### TSC and Clock Drift

`rdtsc` reads the time stamp counter, monotonically increasing at the **invariant TSC frequency** (a fixed reference, usually base or a slightly different "TSC freq"). It does NOT reflect actual core frequency. So `rdtsc` is excellent for wall-time measurement but cannot be used to compute "cycles spent" if the core was turboing or throttling.

```cpp
inline uint64_t rdtsc() {
    unsigned lo, hi;
    asm volatile("lfence; rdtsc" : "=a"(lo), "=d"(hi));
    return ((uint64_t)hi << 32) | lo;
}
inline uint64_t rdtscp() {
    unsigned lo, hi, aux;
    asm volatile("rdtscp" : "=a"(lo), "=d"(hi), "=c"(aux));
    return ((uint64_t)hi << 32) | lo;
}
```

`rdtscp` is serializing for prior loads/stores and gives the CPU id in `aux`, helping detect core migrations mid-measurement.

For cycle counts measured against the actual frequency, use `IA32_APERF` (actual cycles since last reset) and `IA32_MPERF` (TSC-normalized cycles). Their ratio is current frequency / TSC frequency.

### Detecting Frequency in Code

```cpp
double measure_freq_hz() {
    auto t0 = std::chrono::steady_clock::now();
    uint64_t c0 = rdtsc();
    std::this_thread::sleep_for(std::chrono::milliseconds(50));
    uint64_t c1 = rdtsc();
    auto t1 = std::chrono::steady_clock::now();
    double sec = std::chrono::duration<double>(t1 - t0).count();
    return double(c1 - c0) / sec;
}
```

Returns the TSC frequency, not the actual core frequency. To get actual, sample APERF/MPERF (requires `msr` or `perf_event_open`).

### Tail Latency and Frequency

Single-shot tail latency is dominated by frequency variance more than algorithmic variance for short requests. A request landing on a freshly-throttled core sees 30 to 50% higher latency than one on a turboing core. p99 in production is essentially "what fraction of requests landed on the slowest core today".

Mitigations:

- Pin latency-critical work to a small set of cores with known thermal headroom
- Disable turbo on those cores (predictable beats fast)
- Use RAPL caps to set a sustainable ceiling
- Monitor `MSR_IA32_THERM_STATUS` and alert on PROCHOT events

### Sample Workflow for Reproducible Benchmarks

```bash
# Prep host
sudo cpupower frequency-set -g performance
sudo cpupower frequency-set --min 2.4GHz --max 2.4GHz
echo 1 | sudo tee /sys/devices/system/cpu/intel_pstate/no_turbo
sudo sh -c 'for f in /sys/devices/system/cpu/cpu*/online; do
  cpu=$(basename $(dirname "$f"))
  if [ "$cpu" != "cpu0" ]; then echo 0 > "$f"; fi
done'   # disable all other cores (extreme, only for kernel-level micro)

# Or less extreme: isolate cores
# Add isolcpus=4-7 nohz_full=4-7 rcu_nocbs=4-7 to kernel cmdline

# Run
taskset -c 4 chrt -f 99 ./bench --benchmark_repetitions=20 \
    --benchmark_report_aggregates_only=true
```

### Junior to FAANG callout

If you have not pinned the frequency before benchmarking, your numbers are wrong. They are not "approximate", they are "not measuring what you think". A 1.05x speedup measured at variable frequency may be 1.0x or 1.1x. Pin first.

### Senior at FAANG callout

Production tail latency and frequency variance are the same problem. Quantify your fleet's thermal headroom: temperature percentiles, throttle event counts, RAPL trips, per-core frequency distributions. Co-tenancy on shared hosts means your service's throttle is your noisy neighbor's instruction mix. Treat frequency as a stochastic variable in your latency model.
