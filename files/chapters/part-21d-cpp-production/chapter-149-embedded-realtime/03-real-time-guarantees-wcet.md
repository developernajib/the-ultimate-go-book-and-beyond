## Real-Time Guarantees and WCET Analysis

The word "real-time" is abused in general software. A responsive UI is not real-time. A low-latency trading system is not real-time in the embedded sense. Real-time, rigorously defined, means the system guarantees a response within a bounded time under all circumstances. The deadline is a requirement, not a target.

### Hard Real-Time vs Soft Real-Time

**Hard real-time:** Missing a deadline constitutes system failure. The correctness of the output depends not only on its value but on the time it was produced. An airbag controller must fire within 15-30 ms of impact detection. A pacemaker must deliver a pulse within the refractory timing window. An ABS controller must release brake pressure within a specific window during wheel lockup. These systems are not *fast* in the server sense, their CPUs run at 72-240 MHz. They are *predictable*.

**Soft real-time:** Occasional deadline misses degrade quality but do not cause system failure. Audio streaming, video decoding, UI rendering. A dropped audio frame produces a click. Missing a video frame produces a stutter. Unpleasant, not dangerous.

**Firm real-time:** A missed deadline makes the result useless (late data is as bad as no data), but the system does not fail. Telemetry collection, non-critical sensor fusion.

The techniques in this chapter target hard real-time. Soft real-time can often be achieved on Linux with `SCHED_FIFO` and memory locking. Hard real-time requires bare-metal or RTOS with deterministic scheduling.

### WCET: Worst-Case Execution Time

WCET is the maximum time a task or function can take under any input and any hardware state. It is the foundational concept of real-time analysis. If you cannot bound WCET, you cannot make a real-time guarantee.

**Sources of non-determinism that inflate or bound WCET:**

| Source | Bare-metal Cortex-M | Linux/RTOS |
|---|---|---|
| Cache misses | Predictable (small L1, no L2) | Unpredictable (shared L1/L2) |
| Branch prediction | Simple, bounded | Speculative, harder to bound |
| TLB misses | No MMU, N/A | Present, unbounded in worst case |
| OS preemption | None (bare-metal) | Preemption latency varies |
| Memory bus arbitration | DMA competes for bus | Many cores compete |
| Interrupt latency | 12 cycles on Cortex-M (bounded) | Bounded only with CONFIG_PREEMPT_RT |

On bare-metal Cortex-M, WCET analysis is tractable because the hardware is simple. The pipeline stalls are bounded, interrupt latency is 12 cycles, and cache state can be analyzed statically for small cores without I/D cache. This is why automotive safety systems often run on Cortex-M class hardware rather than Cortex-A.

### RTOS Scheduling Algorithms

When multiple periodic tasks share a CPU, a scheduling algorithm decides which runs when.

**Rate Monotonic Scheduling (RMS):** Tasks are assigned fixed priorities inversely proportional to their periods. The shortest-period task gets the highest priority. Liu and Layland (1973) proved that RMS is optimal for fixed-priority preemptive scheduling: if any fixed-priority assignment can meet all deadlines, RMS can. The use bound for n tasks is `U ≤ n(2^(1/n) − 1)`, which converges to ln(2) ≈ 69.3% as n → ∞.

```
Task A: period 10 ms, WCET 3 ms  → priority 3 (highest)
Task B: period 20 ms, WCET 5 ms  → priority 2
Task C: period 50 ms, WCET 8 ms  → priority 1 (lowest)

Utilization: 3/10 + 5/20 + 8/50 = 0.3 + 0.25 + 0.16 = 0.71
Within RMS bound? n=3: 3(2^(1/3)-1) = 0.779 → YES, schedulable.
```

**Earliest Deadline First (EDF):** Dynamic priority: the task whose deadline is soonest gets the CPU. Theoretically optimal, can achieve 100% use on uniprocessor. More complex to implement. Used in AUTOSAR OS and some RTOS.

### Priority Inversion and Priority Inheritance

Priority inversion is a subtle real-time failure mode. A high-priority task is blocked waiting for a resource held by a low-priority task, while a medium-priority task preempts the low-priority task, effectively the medium task blocks the high task indefinitely.

```
High task H (priority 3): needs mutex M
Low  task L (priority 1): holds mutex M, preempted by...
Med  task M (priority 2): running (doesn't need mutex M)

H is blocked. L cannot run to release M because M preempts it.
H's deadline is missed. This is priority inversion.
```

**Priority inheritance** fixes this: when a low-priority task holds a resource needed by a higher-priority task, the low-priority task temporarily runs at the higher-priority task's level until it releases the resource.

FreeRTOS mutexes implement priority inheritance. Counting semaphores do not, use mutexes (`xSemaphoreCreateMutex`) when protecting shared resources between tasks of different priorities.

### Disabling Interrupts for Atomic Sections

The simplest way to create an atomic section on Cortex-M is to disable all maskable interrupts. This is appropriate for very short critical sections, typically register reads that must not be interrupted.

```cpp
#include <cstdint>

// ARM CMSIS: __disable_irq() emits CPSID I, __enable_irq() emits CPSIE I
inline void enter_critical() {
    __disable_irq();
    __DSB();  // Data Synchronization Barrier -- ensure pending stores complete
    __ISB();  // Instruction Synchronization Barrier -- flush pipeline
}

inline void exit_critical() {
    __enable_irq();
}

// RAII wrapper for critical section -- exception-safe, scope-limited
class CriticalSection {
public:
    CriticalSection()  { enter_critical(); }
    ~CriticalSection() { exit_critical(); }

    // Non-copyable
    CriticalSection(const CriticalSection&) = delete;
    CriticalSection& operator=(const CriticalSection&) = delete;
};

// Usage: atomic read of a 64-bit value updated in an ISR
uint64_t read_timestamp_atomic() {
    CriticalSection cs;
    return g_system_timestamp;  // ISR cannot preempt while cs is alive
}
```

Disable duration must be minimal, typically < 100 ns on Cortex-M4 at 168 MHz. Longer critical sections push interrupt latency and violate hard real-time guarantees for other tasks.

### Measuring WCET with DWT Cycle Counter

The ARM Data Watchpoint and Trace (DWT) unit provides a free-running cycle counter at full CPU frequency, the most precise timer available on Cortex-M.

```cpp
#include "stm32f4xx.h"  // CMSIS device header

void dwt_init() {
    // Enable the DWT unit
    CoreDebug->DEMCR |= CoreDebug_DEMCR_TRCENA_Msk;
    DWT->CYCCNT = 0;
    DWT->CTRL  |= DWT_CTRL_CYCCNTENA_Msk;
}

// Returns cycles elapsed -- call on same CPU, no context switches
uint32_t measure_cycles(void (*fn)()) {
    uint32_t start = DWT->CYCCNT;
    fn();
    return DWT->CYCCNT - start;
}

// Measure and record worst case over N iterations
template<size_t N>
uint32_t measure_wcet(void (*fn)()) {
    uint32_t worst = 0;
    for (size_t i = 0; i < N; ++i) {
        uint32_t c = measure_cycles(fn);
        if (c > worst) worst = c;
    }
    return worst;
}

// Convert cycles to microseconds
float cycles_to_us(uint32_t cycles, uint32_t cpu_hz) {
    return static_cast<float>(cycles) / (static_cast<float>(cpu_hz) / 1e6f);
}

// Usage during integration testing:
void characterize_control_loop() {
    dwt_init();
    uint32_t wcet_cycles = measure_wcet<10000>(run_pid_controller);
    float    wcet_us     = cycles_to_us(wcet_cycles, 168'000'000);
    // Log via ITM/SWO or UART: "PID WCET: 4.7 us"
    (void)wcet_us;
}
```

Run WCET measurement with the worst-case inputs, maximum sensor noise, all state variables at boundary conditions, to get a realistic upper bound rather than a typical-case measurement.

### Static WCET Analysis Tools

Manual measurement catches most cases but misses rare code paths. Static analysis tools analyze the binary and compute a mathematical upper bound:

- **AbsInt aiT:** Industry standard. Used in DO-178C certification. Analyzes machine code, models pipeline and cache behavior, produces certified WCET bounds.
- **Rapita RVS:** WCET measurement tool for automotive (ISO 26262 support).
- **OTAWA:** Open-source WCET framework for research and development.

These tools take the compiled binary (not source code), a hardware model (pipeline latency, cache configuration), and produce a WCET bound per function. The bound is conservative by design, a guarantee, not an estimate.

### Go Comparison

Go's runtime makes WCET analysis essentially impossible. The garbage collector can pause goroutines at any point, even with the current incremental GC, worst-case pauses are in the millisecond range under pressure. The scheduler uses cooperative-plus-preemptive scheduling with no priority levels. TinyGo for bare-metal targets disables the GC entirely and eliminates the scheduler, making WCET tractable, but at the cost of no goroutines and no garbage collection, at which point TinyGo code looks much like embedded C code in structure.

---
