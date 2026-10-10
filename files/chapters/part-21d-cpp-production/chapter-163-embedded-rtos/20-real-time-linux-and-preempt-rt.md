## Real-Time Linux and PREEMPT_RT

When the application needs Linux but the deadlines are real, the answer is PREEMPT_RT. After two decades of out-of-tree development, PREEMPT_RT is now in mainline Linux as of kernel 6.12 (December 2024). Building a deterministic Linux system is a real engineering discipline, distinct from both bare-metal MCU work and ordinary server-class Linux.

This chapter is for engineers who run real-time workloads on Cortex-A class hardware: industrial robots, motion controllers, audio processing, machine vision pipelines, and software-defined radio.

### What PREEMPT_RT Changes

The default Linux kernel is preemptible up to a point. System calls and certain kernel sections are non-preemptible, so a real-time task can wait an unbounded time if the kernel is in one of those sections. PREEMPT_RT makes the kernel fully preemptible by:

1. Converting most kernel locks (spinlocks) into preemptible mutexes (rt_mutex) with priority inheritance.
2. Threading hardware interrupts so that ISRs run as kernel threads and can be preempted.
3. Threading software interrupts (softirqs) similarly.
4. Eliminating long-held locks in core paths (work that took 20 years).

The result is a kernel where the maximum scheduling latency for a high-priority task is bounded, typically under 100 microseconds on modern Cortex-A hardware.

### Building a PREEMPT_RT Kernel

In 2026 with mainline integration, the configuration is straightforward:

```
make menuconfig
# General setup -> Preemption Model -> Fully Preemptible Kernel (Real-Time)
make -j$(nproc)
make modules_install
make install
```

The `CONFIG_PREEMPT_RT` option enables the real-time semantics. Most distributions now ship `linux-image-rt-*` packages. Ubuntu Pro provides a supported PREEMPT_RT kernel for x86_64 and arm64. Yocto and Buildroot have config layers for embedded targets.

### Real-Time Application Pattern

```cpp
#include <pthread.h>
#include <sched.h>
#include <sys/mman.h>
#include <sys/resource.h>
#include <chrono>
#include <thread>

void setup_rt_thread(int priority, int cpu_core) {
    // Lock pages so they cannot be swapped or paged
    if (mlockall(MCL_CURRENT | MCL_FUTURE) != 0) {
        perror("mlockall");
        std::exit(1);
    }

    // Set scheduling policy and priority
    sched_param param{};
    param.sched_priority = priority;
    if (pthread_setschedparam(pthread_self(), SCHED_FIFO, &param) != 0) {
        perror("pthread_setschedparam");
        std::exit(1);
    }

    // Pin to a specific CPU
    cpu_set_t set;
    CPU_ZERO(&set);
    CPU_SET(cpu_core, &set);
    if (pthread_setaffinity_np(pthread_self(), sizeof(set), &set) != 0) {
        perror("pthread_setaffinity_np");
        std::exit(1);
    }
}

void real_time_loop() {
    auto period = std::chrono::microseconds(1000);   // 1 kHz loop
    auto next = std::chrono::steady_clock::now();
    while (true) {
        next += period;
        do_real_time_work();
        std::this_thread::sleep_until(next);
    }
}

int main() {
    setup_rt_thread(80, 1);
    real_time_loop();
}
```

Three things make this real-time:

1. **`mlockall`** prevents the kernel from paging out the process's memory. A page fault would block the thread for milliseconds.
2. **`SCHED_FIFO` priority 80** puts the thread above normal user threads and ensures preemption of lower-priority work. Note: priorities 1-99 in `SCHED_FIFO`, with 99 the highest. Avoid 99 (kernel uses it for some interrupt threads).
3. **CPU pinning** prevents thread migration jitter. Migrating to another CPU costs cache misses.

### Isolating CPUs

For the strictest determinism, dedicate one or more CPUs to real-time work and exclude them from the regular Linux scheduler. The kernel command line:

```
isolcpus=2,3 nohz_full=2,3 rcu_nocbs=2,3
```

This isolates CPUs 2 and 3 from the scheduler, disables the periodic tick on them when no task is running, and offloads RCU callbacks to other CPUs. The real-time application binds to CPU 2 or 3 and gets the core almost entirely to itself.

Combined with `irqaffinity` setting on the kernel command line that excludes CPUs 2 and 3 from interrupt handling, the real-time CPUs see no scheduling jitter from interrupts on those cores.

### Threaded Interrupts

In PREEMPT_RT, hardware interrupts run as kernel threads (`irqthreads`). A high-priority RT thread can preempt an interrupt thread, which keeps interrupts from blocking the application.

The thread name pattern is `irq/<irq_num>-<device>`. You can see them in `ps`:

```
$ ps -eLo pid,tid,class,rtprio,cmd | grep irq
   29   29 FF      50 [irq/9-acpi]
   45   45 FF      50 [irq/16-i801_smb]
```

Their priorities default to 50 (mid-range SCHED_FIFO). Application code at priority 80 preempts them.

### Measuring Jitter with cyclictest

`cyclictest` is the standard benchmark. It runs a high-priority thread that sleeps for a fixed period and measures the difference between expected and actual wakeup time:

```
sudo cyclictest -p 80 -t 1 -m -i 1000 -l 100000000 -a 1
```

The output gives min, max, and average jitter. On a properly tuned PREEMPT_RT system on modern Cortex-A hardware:

```
T: 0 ( 1234) P:80 I:1000 C: 100000000 Min:      8 Act:   12 Avg:   10 Max:      48
```

Min 8 microseconds, max 48 microseconds. That is the wall the application can budget against. If the deadline is 100 microseconds, the system meets it. If the deadline is 30 microseconds, you need bare metal or an FPGA.

For comparison, a non-RT kernel under the same load might show:

```
T: 0 ( 1234) P:80 I:1000 C: 100000000 Min:     12 Act:   18 Avg:   45 Max:    8200
```

8.2 milliseconds worst case. Useless for hard real-time.

### Hardware Watchdog Interaction

A critical real-time Linux system must have a hardware watchdog. The application kicks the watchdog from its main loop. If the loop hangs, the watchdog resets the system.

```cpp
#include <sys/ioctl.h>
#include <linux/watchdog.h>
#include <fcntl.h>
#include <unistd.h>

class Watchdog {
    int fd_;
public:
    Watchdog() : fd_(open("/dev/watchdog", O_WRONLY)) {
        if (fd_ < 0) { perror("open watchdog"); std::exit(1); }
        int timeout = 10;
        ioctl(fd_, WDIOC_SETTIMEOUT, &timeout);
    }
    ~Watchdog() {
        // Magic close to disable watchdog on clean shutdown
        write(fd_, "V", 1);
        close(fd_);
    }
    void kick() { ioctl(fd_, WDIOC_KEEPALIVE, nullptr); }
};

void real_time_loop() {
    Watchdog wdt;
    auto period = std::chrono::microseconds(1000);
    auto next = std::chrono::steady_clock::now();
    while (true) {
        next += period;
        do_real_time_work();
        if ((counter++ % 1000) == 0) wdt.kick();   // every second
        std::this_thread::sleep_until(next);
    }
}
```

Care: the destructor uses the "magic close" sequence (writing 'V' before close) so that an orderly shutdown does not trigger the watchdog. Without it, closing the watchdog file descriptor enables the timer and resets the system.

### Practical Footprint

A typical industrial real-time Linux system in 2026:

- Cortex-A53 quad-core or Cortex-A72 dual-core SoC at 1-1.8 GHz
- 1-4 GB of DDR4
- PREEMPT_RT kernel built from mainline 6.12 LTS or later
- Yocto-built minimal root filesystem, 100-300 MB
- Real-time application written in C++17 or C++20
- Ethernet for non-time-critical communication, EtherCAT or PROFINET for time-critical I/O
- Hardware watchdog and an external monitoring MCU for safety

The real-time application is one process with several threads: one or two SCHED_FIFO threads for the control loops, normal-priority threads for logging and network communication, and a watchdog thread that monitors the others.

### When PREEMPT_RT Is and Is Not Enough

PREEMPT_RT gets you to the 50-100 microsecond worst-case scheduling latency range on a modern application processor. That is enough for:

- Industrial control loops at 1-5 kHz
- Robotics motion control with closed-loop torque control on the controller and current control on dedicated motor drivers
- Audio processing with buffer sizes of 1-4 ms
- Software-defined radio with sample rates up to a few MHz

It is not enough for:

- Sub-microsecond control loops (use bare metal or an FPGA)
- Hard safety-critical loops where the worst-case latency must be guaranteed at the silicon level (use a Cortex-R lockstep core with no OS)
- Audio with sample-accurate routing and buffer sizes of 32-64 samples (use a dedicated DSP)

For these, the answer is to keep PREEMPT_RT for the supervisory layer and offload the timing-critical loop to a coprocessor. Modern automotive and robotics SoCs (NVIDIA Orin, NXP Layerscape, Renesas RZ/G3S) integrate Cortex-R or Cortex-M cores on the same die for exactly this purpose. The C++ on the Cortex-A side talks to firmware on the coprocessor over a shared memory mailbox.

---
