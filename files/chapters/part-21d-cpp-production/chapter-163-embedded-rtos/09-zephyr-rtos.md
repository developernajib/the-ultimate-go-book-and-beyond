## Zephyr RTOS

Zephyr is the open-source RTOS hosted by the Linux Foundation. It started as a Wind River project, was contributed to the foundation in 2016, and is now developed by Intel, Nordic, NXP, Google, Antmicro, and dozens of other members. It is the default RTOS in modern Nordic SDKs, the foundation of Google Nest devices, and the OS of choice for Espressif's ESP32-based Matter products. The current LTS as of early 2026 is Zephyr 3.7 LTS (released July 2024) with 4.0 as the active development line.

### Architecture

Zephyr is more ambitious than FreeRTOS. It includes a kernel, a device driver model, a device tree, networking stacks (IPv4, IPv6, Thread, BLE, IEEE 802.15.4), file systems, USB stacks, sensor APIs, machine learning subsystems, and a CMake-based build system that scales to large applications. The footprint starts around 8 KB for a tiny example and grows to hundreds of KB for a fully featured product.

The kernel concepts are similar to FreeRTOS but renamed. A task is a `k_thread`. A queue is a `k_msgq` or `k_fifo`. A mutex is a `k_mutex`. A semaphore is a `k_sem`. The system is built around kernel objects, abbreviated `kobj`, which are statically defined and tracked by the kernel for safety analysis.

### Devicetree

The biggest difference from FreeRTOS is the devicetree. Zephyr borrows the Linux device tree concept: hardware is described in a hierarchical configuration file (`board.dts`), and drivers are matched to the configuration at build time. The application code looks up devices by node label, not by register address.

A typical board overlay snippet:

```
&i2c1 {
    status = "okay";
    pinctrl-0 = <&i2c1_default>;
    clock-frequency = <I2C_BITRATE_FAST>;

    bme280@76 {
        compatible = "bosch,bme280";
        reg = <0x76>;
        label = "ENV_SENSOR";
    };
};
```

And the application code:

```cpp
#include <zephyr/device.h>
#include <zephyr/drivers/sensor.h>

const struct device* sensor = DEVICE_DT_GET(DT_NODELABEL(bme280_76));

void sample() {
    sensor_sample_fetch(sensor);
    sensor_value temp;
    sensor_channel_get(sensor, SENSOR_CHAN_AMBIENT_TEMP, &temp);
    log_info("temp = %d.%06d", temp.val1, temp.val2);
}
```

The `DEVICE_DT_GET` macro resolves at compile time. There is no string lookup at runtime. The driver was registered statically and the application gets a direct pointer.

The advantage is portability. The same application source code targets a Nordic nRF52, an STM32, an ESP32, or a Renesas part by changing the devicetree, not the C++. The disadvantage is the learning curve. Devicetree is its own DSL with bindings, overlays, and macro expansion that takes a week to internalize.

### Threads

```cpp
#include <zephyr/kernel.h>

K_THREAD_STACK_DEFINE(sensor_stack, 1024);
struct k_thread sensor_thread_data;

void sensor_thread(void* a, void* b, void* c) {
    while (true) {
        sample_sensor();
        k_sleep(K_MSEC(100));
    }
}

int main() {
    k_thread_create(
        &sensor_thread_data,
        sensor_stack,
        K_THREAD_STACK_SIZEOF(sensor_stack),
        sensor_thread,
        nullptr, nullptr, nullptr,
        K_PRIO_PREEMPT(5),
        0,
        K_NO_WAIT
    );
}
```

Zephyr distinguishes preemptible and cooperative threads. `K_PRIO_PREEMPT(n)` gives a preemptible thread, `K_PRIO_COOP(n)` gives a cooperative thread that yields voluntarily. Cooperative threads are useful for code that does not want to be preempted mid-operation.

### Mutexes and Semaphores

```cpp
K_MUTEX_DEFINE(flash_mutex);

void update_config() {
    k_mutex_lock(&flash_mutex, K_FOREVER);
    flash_write_config();
    k_mutex_unlock(&flash_mutex);
}
```

Wrapping in C++ RAII:

```cpp
class MutexLock {
    k_mutex& m_;
public:
    explicit MutexLock(k_mutex& m, k_timeout_t to = K_FOREVER) : m_(m) {
        k_mutex_lock(&m_, to);
    }
    ~MutexLock() { k_mutex_unlock(&m_); }
    MutexLock(const MutexLock&) = delete;
};
```

### Message Queues, FIFOs, LIFOs

Zephyr offers several queue flavors with different performance characteristics:

**`k_msgq`** is fixed-size message queue, comparable to FreeRTOS queue. The application defines the message size at queue creation. Messages are copied in and out.

**`k_fifo`** is intrusive linked-list queue. The first word of each message must be a pointer reserved for kernel use. No copy. Faster but the application must manage memory.

**`k_lifo`** is the same as `k_fifo` but LIFO order.

```cpp
struct sensor_event {
    void* fifo_reserved;          // required first member
    std::uint32_t timestamp;
    float value;
};

K_FIFO_DEFINE(sensor_events);

void producer() {
    static sensor_event ev{nullptr, k_uptime_get_32(), read_sensor()};
    k_fifo_put(&sensor_events, &ev);
}

void consumer() {
    while (true) {
        auto* ev = static_cast<sensor_event*>(k_fifo_get(&sensor_events, K_FOREVER));
        process_event(*ev);
    }
}
```

### Work Queues

A work queue is a thread that runs deferred function callbacks. It is the Zephyr equivalent of a tasklet or a deferred ISR. Useful when an ISR needs to do non-trivial work, the ISR submits a work item, the work queue thread runs it.

```cpp
struct k_work blink_work;

void blink_handler(struct k_work* work) {
    gpio_pin_toggle_dt(&led);
}

void timer_isr_callback() {
    k_work_submit(&blink_work);
}

int main() {
    k_work_init(&blink_work, blink_handler);
}
```

There is also `k_work_delayable` for deferred work after a timeout.

### Sensor API

Zephyr's sensor subsystem abstracts sensor drivers behind a common API. Adding a new BME280, ICM-42688, or LIS2DH driver does not change the application code, it changes the devicetree.

```cpp
const struct device* dev = DEVICE_DT_GET_ONE(bosch_bme280);
sensor_sample_fetch(dev);
sensor_value temp, pressure, humidity;
sensor_channel_get(dev, SENSOR_CHAN_AMBIENT_TEMP, &temp);
sensor_channel_get(dev, SENSOR_CHAN_PRESS, &pressure);
sensor_channel_get(dev, SENSOR_CHAN_HUMIDITY, &humidity);
```

The same code works for any sensor that exposes those channels.

### Build System

Zephyr uses CMake plus a Python tool called `west`. A typical build:

```
west init zephyrproject
cd zephyrproject
west update
west build -b nrf52840dk_nrf52840 samples/basic/blinky
west flash
```

The board name selects the devicetree, the toolchain, and the linker script. The same project tree builds for every supported board with no source changes.

For application development, the project structure is:

```
my_app/
  CMakeLists.txt
  prj.conf            # Kconfig options
  app.overlay         # board-specific devicetree changes
  src/
    main.cpp
```

Where `prj.conf` contains the configuration knobs:

```
CONFIG_CPP=y
CONFIG_STD_CPP20=y
CONFIG_BT=y
CONFIG_BT_PERIPHERAL=y
CONFIG_LOG=y
CONFIG_MAIN_STACK_SIZE=2048
```

### Comparison with FreeRTOS

The choice between Zephyr and FreeRTOS is a real engineering decision, not a religious one.

**FreeRTOS strengths.** Smaller and simpler kernel. Easier to certify because the codebase is small. Battle-tested on tens of billions of devices. Cleaner integration with vendor-specific SDKs (Espressif, Nordic before nRF Connect SDK 2.0). Less ceremony for a quick project.

**Zephyr strengths.** Full driver model and devicetree, so swapping silicon is a configuration change. Built-in networking, BLE, Matter, and Thread. Active LTS process with security backports. Backed by Linux Foundation governance, Intel and Nordic engineering, and the Matter ecosystem. Strong C++ support, including `CONFIG_CPP_EXCEPTIONS` and `CONFIG_NEWLIB_LIBC` options.

A 2026 starting point: pick Zephyr for any new IoT product targeting BLE, Matter, Thread, or LTE-M. Pick FreeRTOS for any product where vendor SDK integration dominates the bring-up time, where the kernel surface area must be minimal for certification, or where the silicon vendor's SDK only ships a FreeRTOS port.

For a Cortex-A or PREEMPT_RT-class workload, neither is the right answer, use Linux.

---
