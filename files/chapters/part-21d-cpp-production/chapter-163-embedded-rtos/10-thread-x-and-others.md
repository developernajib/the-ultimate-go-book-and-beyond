## ThreadX and Other RTOSes

FreeRTOS and Zephyr cover most new designs, but the embedded world has many other RTOSes that ship in real products. A senior firmware engineer should know which one is in front of them and what the tradeoffs are.

### ThreadX (Microsoft Azure RTOS)

ThreadX began at Express Logic in 1997 and was acquired by Microsoft in 2019, then rebranded as Azure RTOS. In 2024 Microsoft contributed it to the Eclipse Foundation as Eclipse ThreadX, an open-source project under MIT license.

ThreadX is famous for two things. It has the smallest verified kernel footprint (under 2 KB on Cortex-M with a minimal configuration) and the fastest context switch (under 1 microsecond on a 100 MHz Cortex-M4). It is certified to IEC 61508 SIL 4, IEC 62304, EN 50128, ISO 26262 ASIL D, and FDA Class C, which makes it the default choice for medical, industrial safety, and rail signaling applications.

The API is C, but it is straightforward to wrap from C++.

```cpp
TX_THREAD sensor_thread;
constexpr std::size_t kStackSize = 1024;
alignas(8) std::uint8_t sensor_stack[kStackSize];

void sensor_entry(ULONG arg) {
    while (true) {
        sample_sensor();
        tx_thread_sleep(10);   // ticks
    }
}

UINT result = tx_thread_create(
    &sensor_thread, "sensor", sensor_entry, 0,
    sensor_stack, kStackSize,
    8, 8,                       // priority, preempt threshold
    TX_NO_TIME_SLICE, TX_AUTO_START
);
```

The "preempt threshold" is a ThreadX-specific feature. A thread can declare a priority above its base priority such that only threads above that threshold can preempt it. This gives finer-grained control over preemption than a simple priority.

ThreadX ships with NetX (TCP/IP), FileX (FAT file system), GUIX (graphics), USBX (USB host and device), and LevelX (NAND flash wear leveling). The full Azure RTOS bundle is the most complete commercially supported RTOS stack.

### Mbed OS

Arm Mbed OS started in 2014 as Arm's RTOS for Cortex-M. It is C++14-first (the API is C++ classes, not C functions) and integrated with the Arm Keil ecosystem. The current state in 2026 is "deprecated but maintained." Arm announced end-of-life for active development in 2024, but the community fork lives on for legacy projects.

The Mbed API is the cleanest C++ RTOS API ever shipped:

```cpp
#include "mbed.h"

DigitalOut led(LED1);
Thread sensor_thread;

void sensor_loop() {
    while (true) {
        led = !led;
        ThisThread::sleep_for(500ms);
    }
}

int main() {
    sensor_thread.start(sensor_loop);
    while (true) ThisThread::sleep_for(1s);
}
```

For new designs in 2026, Mbed should be considered legacy. Existing products may have years of life left.

### NuttX

NuttX is a POSIX-compliant RTOS hosted by the Apache Foundation. It is the OS in the PX4 autopilot used on millions of drones (DJI uses a fork, ArduPilot and PX4 use mainline). It runs on Sony spresense for IoT, on the Olimex ESP32-PoE, and on dozens of small SBCs.

NuttX's distinguishing feature is full POSIX. You can write `pthread_create`, `pthread_mutex_lock`, `mq_open`, `read`, `write`, `select`, and `epoll`. Code originally written for Linux often ports to NuttX with minimal changes. The footprint is larger than FreeRTOS but smaller than Linux, in the hundreds of KB range.

```cpp
#include <pthread.h>
#include <unistd.h>

void* sensor_loop(void*) {
    while (true) {
        sample();
        usleep(10'000);
    }
    return nullptr;
}

int main() {
    pthread_t t;
    pthread_create(&t, nullptr, sensor_loop, nullptr);
    pthread_join(t, nullptr);
}
```

For drone autopilots, IoT gateways with full POSIX requirements, and any project where the team's POSIX experience is more valuable than the smallest possible footprint, NuttX is the answer.

### ChibiOS

ChibiOS is a small, fast RTOS from Italy (Giovanni Di Sirio is the lead). It targets STM32, AVR, and a handful of other parts. The kernel is C with a clean C++ binding (`ChibiOS/RT++`). It ships with HAL drivers for STM32 that are sometimes preferred over ST's own HAL.

```cpp
static THD_WORKING_AREA(sensor_wa, 256);
static THD_FUNCTION(sensor_thd, arg) {
    while (true) {
        sample();
        chThdSleepMilliseconds(100);
    }
}

int main() {
    halInit();
    chSysInit();
    chThdCreateStatic(sensor_wa, sizeof(sensor_wa),
                      NORMALPRIO, sensor_thd, nullptr);
    while (true) chThdSleepMilliseconds(1000);
}
```

ChibiOS is popular in motor control and audio applications because the HAL is very thin and the latency is well-characterized.

### CMSIS-RTOS2 and RTX5

CMSIS-RTOS2 is Arm's standardized RTOS API for Cortex-M. It is a wrapper interface that can be implemented over multiple kernels. The reference implementation is RTX5, which Arm ships in the Keil MDK. FreeRTOS also has a CMSIS-RTOS2 wrapper.

The benefit of writing to CMSIS-RTOS2 is portability. The same application can run on RTX5 in development, FreeRTOS in production, and a different kernel in a future revision, with no source changes.

```cpp
#include "cmsis_os2.h"

static osThreadId_t sensor_id;

void sensor_thread(void*) {
    while (true) {
        sample();
        osDelay(10);
    }
}

int main() {
    osKernelInitialize();
    sensor_id = osThreadNew(sensor_thread, nullptr, nullptr);
    osKernelStart();
}
```

In practice, most teams pick the kernel directly and use its native API. CMSIS-RTOS2 is most common in Keil-centric shops.

### Real-Time Linux with PREEMPT_RT

When the application needs Linux for its drivers, networking, and tooling but also needs deterministic real-time behavior, the answer is the PREEMPT_RT patchset, which has been progressively merged into mainline Linux over the past 20 years. As of Linux 6.12 (December 2024), PREEMPT_RT is in mainline. The headline change is that all kernel locks become preemptible, all interrupts run in kernel threads, and the worst-case scheduling latency is bounded.

A typical PREEMPT_RT system can guarantee under 100 microseconds of scheduling jitter on a Cortex-A72 at 1.5 GHz, which is enough for industrial control loops, robotics, and many medical devices.

The C++ side looks like normal Linux:

```cpp
#include <pthread.h>
#include <sched.h>
#include <sys/mman.h>
#include <chrono>
#include <thread>

int main() {
    // Lock all current and future memory pages
    mlockall(MCL_CURRENT | MCL_FUTURE);

    // Set real-time scheduling policy
    sched_param param{};
    param.sched_priority = 80;
    pthread_setschedparam(pthread_self(), SCHED_FIFO, &param);

    // Pin to CPU 1 to avoid migration jitter
    cpu_set_t set;
    CPU_ZERO(&set);
    CPU_SET(1, &set);
    pthread_setaffinity_np(pthread_self(), sizeof(set), &set);

    while (true) {
        do_real_time_work();
        std::this_thread::sleep_for(std::chrono::microseconds(100));
    }
}
```

The standard verification tool is `cyclictest`. Run it for 24 hours with the production load nearby, and check that worst-case jitter is below your deadline. If it is, you have a real-time Linux system.

### When Each Fits

A practical decision tree:

- **Smallest possible footprint, certifiable, IEC 61508 SIL 4 or ASIL D**: ThreadX
- **Default choice for IoT with BLE, Matter, Thread, LTE-M**: Zephyr
- **Default choice when vendor SDK is FreeRTOS-native (Espressif, older Nordic)**: FreeRTOS
- **Drone autopilot, POSIX-required**: NuttX
- **Motor control, audio with very thin HAL**: ChibiOS
- **Keil-centric shop, CMSIS-RTOS2 portability**: RTX5
- **Linux required, real-time deadlines bounded but not microseconds**: PREEMPT_RT Linux
- **Hard real-time microsecond control loop on application processor**: bare metal on a Cortex-R lockstep core, no OS

The wrong answer is to pick whatever you used last time. Each of these has a real production niche.

---
