## RTOS Fundamentals

A real-time operating system is a scheduler plus a small set of synchronization primitives. The scheduler decides which task runs next based on priority. The primitives let tasks communicate without races. There is no virtual memory, no process model, no file system in the POSIX sense. Everything shares one address space, which means a bug in any task can corrupt any other task. Discipline is the only line of defense.

### What Counts as Real-Time

Real-time does not mean fast. It means deterministic. A 1 GHz desktop running Linux can compute a result in 5 microseconds on average and 50 milliseconds in the worst case when the kernel decides to flush dirty pages. That is not real-time. A 100 MHz Cortex-M4 running FreeRTOS that completes the same operation in 30 microseconds always, with worst-case bounded at 35 microseconds, is real-time.

Two flavors:

**Hard real-time.** Missing a deadline is a system failure. Brake-by-wire, engine ignition, pacemaker pacing. Worst-case execution time matters more than average.

**Soft real-time.** Missing an occasional deadline is undesirable but tolerable. Audio playback (a glitch is annoying), UI animation (a dropped frame is forgivable). Average performance matters more than worst-case.

### Tasks Versus Threads

In RTOS terminology, a task is a thread of execution with its own stack and a priority. The terms "task" and "thread" are used interchangeably. FreeRTOS calls them tasks. Zephyr calls them threads. ThreadX calls them threads. They are the same concept: a function plus a stack plus a priority plus a scheduling state (ready, blocked, running).

What an RTOS task is not: it is not a process. There is no MMU isolation by default (Zephyr and FreeRTOS support optional MPU regions per task, but most projects do not enable it). All tasks see the same global memory. A null pointer dereference in any task crashes the whole firmware.

### Priority-Preemptive Scheduling

The standard model in real-time RTOSes is fixed-priority preemptive scheduling. Each task has a static priority assigned at creation. The scheduler always runs the highest-priority task that is ready. If a higher-priority task becomes ready (an interrupt unblocks it), the scheduler immediately preempts the running task and switches to the higher-priority one.

Two consequences:

1. **Starvation.** A high-priority task in a busy loop prevents all lower-priority tasks from running. The idle task never runs, the watchdog refresh task never runs, and the part resets.

2. **Priority inversion.** A high-priority task can be blocked indirectly by a low-priority task that holds a resource. If a medium-priority task preempts the low-priority holder, the high-priority task waits for the medium task to finish first. This is the famous Mars Pathfinder bug. The fix is priority inheritance, where the holder of a contested resource is temporarily boosted to the priority of the highest waiter.

```cpp
// Demonstrating priority inversion
void high_priority_task() {
    xSemaphoreTake(shared_resource, portMAX_DELAY);
    // ...
    xSemaphoreGive(shared_resource);
}

void medium_priority_task() {
    while (true) {
        // CPU-bound work, no blocking
        compute_something();
    }
}

void low_priority_task() {
    xSemaphoreTake(shared_resource, portMAX_DELAY);
    // ...
    xSemaphoreGive(shared_resource);
}
```

Without priority inheritance, the sequence "low takes resource, high preempts and blocks on resource, medium preempts low" causes high to wait for medium, an unbounded delay. FreeRTOS `xSemaphoreCreateMutex` returns a mutex with priority inheritance. `xSemaphoreCreateBinary` returns a semaphore without it. Use the mutex for resource protection, use the semaphore for signaling.

### Time-Slicing

Tasks at the same priority typically share the CPU in round-robin fashion, switching every tick (1 ms is a common tick). This is configurable. Time-slicing matters only when you have multiple tasks at the same priority. Most well-designed embedded systems give every task a unique priority, eliminating time-slicing entirely.

### The Idle Hook

The idle task runs when nothing else is ready. Its body is typically a tight loop that calls `__WFI` (wait for interrupt) on Cortex-M, putting the core to sleep until an interrupt wakes it. RTOSes provide an idle hook, a callback the application can install to do background work, refresh the watchdog, or run a deeper sleep mode.

```cpp
extern "C" void vApplicationIdleHook() {
    iwdg_refresh();
    if (battery_low()) {
        enter_low_power_mode();
    }
    asm volatile("wfi");
}
```

### Tickless Idle

The default RTOS configuration has a periodic tick (1 ms) that wakes the CPU to run the scheduler. On a battery-powered device, that 1000-Hz wakeup eats current. Tickless mode disables the periodic tick when the system is idle, programs the wake source to fire only when the next time-based event is due, and lets the CPU sleep for the entire interval.

FreeRTOS calls this `configUSE_TICKLESS_IDLE`. Zephyr has it built in. The savings on a typical sensor node are dramatic, often 90 percent reduction in average current.

The cost is complexity. The application must declare its time-based events to the RTOS so the RTOS knows when to wake. Anything that polls hardware in a loop defeats tickless mode.

### Latency Versus Throughput

A central design tension. A high tick rate (1 kHz) gives low scheduling latency but high overhead. A low tick rate (10 Hz) reduces overhead but means up to 100 ms of jitter on time-based events. Tickless mode resolves the tension by going to sleep when nothing is happening.

For interrupts, the relevant number is interrupt latency: the time from the hardware event to the first instruction of the ISR. On Cortex-M with a Cortex-M-aware RTOS, latency is typically 12 to 20 cycles for a no-RTOS-call handler and 30 to 50 cycles for one that signals a task. On Cortex-M7 with the cache cold, latency can spike to 100+ cycles. ITCM placement of the ISR fixes that.

### Stack Allocation per Task

Every task gets its own stack. The stack must be large enough to hold the deepest call chain plus the largest local arrays plus the saved register set on a context switch (16 to 32 registers on Cortex-M, around 100 bytes). Plus margin.

A typical sensor task with shallow logic and a 256-byte protocol buffer might run in 512 bytes. A networking task that calls into a TCP/IP stack might need 4 KB. The exact number is determined by measurement: fill the stack with `0xA5`, run the worst-case path, and find the highest-used address.

```cpp
// Static allocation pattern (preferred over heap-based xTaskCreate)
constexpr std::size_t SENSOR_STACK_WORDS = 256;
StackType_t sensor_stack[SENSOR_STACK_WORDS];
StaticTask_t sensor_tcb;

void create_sensor_task() {
    xTaskCreateStatic(
        sensor_task_fn,         // function
        "sensor",               // name
        SENSOR_STACK_WORDS,     // stack size in words
        nullptr,                // parameter
        2,                      // priority
        sensor_stack,           // stack buffer
        &sensor_tcb             // TCB buffer
    );
}
```

Static allocation avoids the FreeRTOS heap entirely, which is required in most automotive and aerospace builds.

### Synchronization Primitives

The standard toolkit:

**Mutex.** Mutual exclusion with priority inheritance. Use to protect data shared across tasks.

**Binary semaphore.** A flag with `take` and `give`. Use for ISR-to-task signaling.

**Counting semaphore.** A count with `take` and `give`. Use for resource pool management (5 DMA channels, take one, release when done).

**Queue.** Bounded FIFO with blocking send and receive. The standard mechanism for passing data between tasks.

**Event group.** A bitmask of flags. Tasks can wait on any combination, with AND or OR semantics. Useful for tasks that wait on multiple conditions.

**Stream buffer.** Byte-oriented circular buffer with one writer and one reader. Lower overhead than a queue for streaming data like UART receive.

**Message buffer.** Variable-size packet queue with one writer and one reader. Lower overhead than a queue with copies.

**Task notification.** Direct signal from one task to another, faster than a semaphore. FreeRTOS-specific.

### Interrupt Service Routines and the RTOS

Most RTOSes restrict which RTOS calls are legal from an ISR. The rule of thumb: any RTOS API ending in `FromISR` is safe from an ISR, others are not. The reason is that the regular versions may block, which is undefined behavior in an ISR (there is no task to suspend).

```cpp
extern "C" void EXTI0_IRQHandler() {
    EXTI->PR = EXTI_PR_PR0;
    BaseType_t higher_priority_task_woken = pdFALSE;
    xSemaphoreGiveFromISR(button_sem, &higher_priority_task_woken);
    portYIELD_FROM_ISR(higher_priority_task_woken);
}
```

The `portYIELD_FROM_ISR` at the end is essential. If the semaphore release unblocked a higher-priority task, the macro forces a context switch on ISR exit, eliminating the latency that would otherwise accumulate until the next tick.

### Designing With Priorities

A workable priority hierarchy for a typical IoT product:

```
Priority 5 (highest): control-loop task (10 kHz motor control or similar)
Priority 4:           sensor sampling at fixed rate
Priority 3:           network stack (TCP/IP)
Priority 2:           application logic
Priority 1:           UI / logging
Priority 0 (lowest):  idle / background telemetry
```

Each task has a unique priority. Time-slicing is disabled. The control loop preempts everything. The idle task is always available to enter sleep.

The biggest mistake junior engineers make is giving every task the same priority "to be fair." That eliminates the determinism that justified using an RTOS in the first place. If you want fairness, run Linux. If you want to meet a 100 microsecond deadline, assign priorities deliberately.

---
