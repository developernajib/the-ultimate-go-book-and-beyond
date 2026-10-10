## FreeRTOS Deep Dive

FreeRTOS is the most widely deployed RTOS in the world. It ships in Espressif ESP32 by default, in Amazon AWS IoT reference designs, in Nordic nRF Connect SDK as one of two options, and in tens of thousands of products from medical devices to electric scooters. Amazon acquired Real Time Engineers Ltd in 2017 and now publishes the kernel as FreeRTOS LTS, currently the V11 line.

### Architecture

FreeRTOS is a single-file kernel: `tasks.c`, `queue.c`, `list.c`, `port.c`, plus headers. The port layer adapts to a CPU architecture. There are official ports for Cortex-M0/M3/M4/M7/M23/M33/M55/M85, Cortex-A under ARMv7-A, RISC-V, ESP32 Xtensa and RISC-V, AVR, MSP430, and dozens of others.

The kernel ships as source. You drop it into your project, point your build at `FreeRTOSConfig.h`, and it compiles into your firmware. There is no separate kernel image, no kernel/user split, and no system call overhead because everything runs in privileged mode by default.

### FreeRTOSConfig.h

The configuration header controls every kernel feature. A minimal version:

```cpp
#pragma once
#define configUSE_PREEMPTION                1
#define configUSE_PORT_OPTIMISED_TASK_SELECTION  1
#define configUSE_TICKLESS_IDLE             1
#define configCPU_CLOCK_HZ                  84000000
#define configTICK_RATE_HZ                  1000
#define configMAX_PRIORITIES                8
#define configMINIMAL_STACK_SIZE            128
#define configTOTAL_HEAP_SIZE               (16*1024)
#define configMAX_TASK_NAME_LEN             16
#define configUSE_16_BIT_TICKS              0
#define configIDLE_SHOULD_YIELD             0
#define configUSE_TASK_NOTIFICATIONS        1
#define configUSE_MUTEXES                   1
#define configUSE_RECURSIVE_MUTEXES         0
#define configUSE_COUNTING_SEMAPHORES       1
#define configCHECK_FOR_STACK_OVERFLOW      2
#define configUSE_MALLOC_FAILED_HOOK        1
#define configUSE_TIMERS                    1
#define configTIMER_TASK_PRIORITY           7
#define configTIMER_QUEUE_LENGTH            8
#define configTIMER_TASK_STACK_DEPTH        256
#define configSUPPORT_STATIC_ALLOCATION     1
#define configSUPPORT_DYNAMIC_ALLOCATION    0
#define configENABLE_MPU                    1
#define configENABLE_FPU                    1
#define configENABLE_TRUSTZONE              0
#define INCLUDE_vTaskDelay                  1
#define INCLUDE_uxTaskGetStackHighWaterMark 1
#define INCLUDE_xTaskGetCurrentTaskHandle   1
```

Most embedded teams use static allocation only (`configSUPPORT_DYNAMIC_ALLOCATION 0`), enable stack overflow detection, and turn on the MPU port for memory protection.

### Creating Tasks

Static allocation is preferred:

```cpp
constexpr std::size_t kStackWords = 512;
static StackType_t  sensor_stack[kStackWords];
static StaticTask_t sensor_tcb;

void sensor_task(void* arg) {
    auto* sensor = static_cast<Sensor*>(arg);
    TickType_t next = xTaskGetTickCount();
    while (true) {
        sensor->sample();
        vTaskDelayUntil(&next, pdMS_TO_TICKS(10));
    }
}

void start() {
    xTaskCreateStatic(
        sensor_task,
        "sensor",
        kStackWords,
        &g_sensor,
        4,                  // priority
        sensor_stack,
        &sensor_tcb
    );
}
```

`vTaskDelayUntil` is critical for periodic tasks. It schedules the next wakeup based on the previous wakeup time, not the current time, so the task does not drift even if it occasionally runs late.

### Queues

```cpp
struct SensorReading {
    std::uint32_t timestamp;
    float value;
};

constexpr std::size_t kQueueSlots = 16;
static StaticQueue_t reading_queue;
static SensorReading reading_buffer[kQueueSlots];

QueueHandle_t reading_q = xQueueCreateStatic(
    kQueueSlots, sizeof(SensorReading),
    reinterpret_cast<std::uint8_t*>(reading_buffer),
    &reading_queue
);

// Producer
void sensor_task(void*) {
    while (true) {
        SensorReading r{xTaskGetTickCount(), read_value()};
        if (xQueueSend(reading_q, &r, 0) != pdTRUE) {
            // Queue full: dropped sample, log it
            ++g_dropped_samples;
        }
        vTaskDelay(pdMS_TO_TICKS(10));
    }
}

// Consumer
void uplink_task(void*) {
    SensorReading r;
    while (true) {
        if (xQueueReceive(reading_q, &r, portMAX_DELAY) == pdTRUE) {
            transmit_reading(r);
        }
    }
}
```

Queue send from ISR uses `xQueueSendFromISR`. Sending with timeout zero from a non-ISR producer ensures the producer never blocks if the queue is full, useful for sensor sampling tasks where dropping old data is acceptable.

### Mutexes

```cpp
static StaticSemaphore_t flash_mutex_buf;
SemaphoreHandle_t flash_mutex = xSemaphoreCreateMutexStatic(&flash_mutex_buf);

class FlashLock {
    bool taken_;
public:
    FlashLock() : taken_(xSemaphoreTake(flash_mutex, portMAX_DELAY) == pdTRUE) {}
    ~FlashLock() { if (taken_) xSemaphoreGive(flash_mutex); }
    FlashLock(const FlashLock&) = delete;
    FlashLock& operator=(const FlashLock&) = delete;
    explicit operator bool() const { return taken_; }
};

void update_settings(const Settings& s) {
    FlashLock lock;
    flash_erase(SETTINGS_SECTOR);
    flash_program(SETTINGS_SECTOR, &s, sizeof(s));
}
```

The RAII wrapper guarantees the mutex is released even on early return. The mutex has priority inheritance, so a high-priority task waiting on it will boost the holder.

### Event Groups

Event groups are a 24-bit field of flags (32-bit on platforms with `configUSE_16_BIT_TICKS == 0`). Useful when a task waits on multiple conditions.

```cpp
constexpr EventBits_t WIFI_CONNECTED  = (1 << 0);
constexpr EventBits_t MQTT_CONNECTED  = (1 << 1);
constexpr EventBits_t TIME_SYNCED     = (1 << 2);

static StaticEventGroup_t connectivity_buf;
EventGroupHandle_t connectivity = xEventGroupCreateStatic(&connectivity_buf);

void uplink_task(void*) {
    while (true) {
        EventBits_t bits = xEventGroupWaitBits(
            connectivity,
            WIFI_CONNECTED | MQTT_CONNECTED | TIME_SYNCED,
            pdFALSE,    // do not clear on exit
            pdTRUE,     // wait for ALL bits
            portMAX_DELAY
        );
        publish_pending_data();
    }
}

void wifi_callback(bool connected) {
    if (connected) xEventGroupSetBits(connectivity, WIFI_CONNECTED);
    else xEventGroupClearBits(connectivity, WIFI_CONNECTED);
}
```

### Software Timers

The timer service task processes one-shot and periodic timers without burning a full task. Useful for low-frequency timeouts (heartbeat every 30 s, watchdog kick every 100 ms).

```cpp
static StaticTimer_t heartbeat_buf;
TimerHandle_t heartbeat_timer;

void heartbeat_callback(TimerHandle_t) {
    send_heartbeat();
}

void init_heartbeat() {
    heartbeat_timer = xTimerCreateStatic(
        "hb",
        pdMS_TO_TICKS(30000),
        pdTRUE,            // auto-reload
        nullptr,
        heartbeat_callback,
        &heartbeat_buf
    );
    xTimerStart(heartbeat_timer, 0);
}
```

Timer callbacks run in the timer service task context. They must not block. If you need to do work, signal a worker task from the callback.

### Stream Buffers

A stream buffer is a single-producer single-consumer byte-oriented FIFO. It is the cheapest way to pipe UART RX bytes from an ISR into a task.

```cpp
static std::uint8_t uart_rx_storage[1024];
static StaticStreamBuffer_t uart_rx_buf;
StreamBufferHandle_t uart_rx = xStreamBufferCreateStatic(
    sizeof(uart_rx_storage), 1, uart_rx_storage, &uart_rx_buf
);

extern "C" void USART2_IRQHandler() {
    if (USART2->ISR & USART_ISR_RXNE) {
        std::uint8_t b = USART2->RDR;
        BaseType_t hpw = pdFALSE;
        xStreamBufferSendFromISR(uart_rx, &b, 1, &hpw);
        portYIELD_FROM_ISR(hpw);
    }
}

void parser_task(void*) {
    std::uint8_t buf[64];
    while (true) {
        std::size_t n = xStreamBufferReceive(uart_rx, buf, sizeof(buf), portMAX_DELAY);
        for (std::size_t i = 0; i < n; ++i) parse_byte(buf[i]);
    }
}
```

### Stack Overflow Hook

With `configCHECK_FOR_STACK_OVERFLOW == 2`, the kernel fills new stacks with `0xA5` and on every context switch checks the last few bytes for corruption. If the pattern is broken, the application's stack overflow hook is called.

```cpp
extern "C" void vApplicationStackOverflowHook(TaskHandle_t task, char* name) {
    log_critical("STACK OVERFLOW in task %s", name);
    asm volatile("bkpt #0");
    for (;;) {}
}
```

The kernel cannot continue safely after a stack overflow. The hook should log and reset.

### MPU Support

FreeRTOS-MPU on Cortex-M lets each task run in unprivileged mode with its own MPU regions. Privileged tasks (the kernel and authorized application code) have full access. Unprivileged tasks have access only to their stack, the kernel APIs, and any explicitly granted regions.

```cpp
TaskParameters_t params = {
    .pvTaskCode    = sensor_task,
    .pcName        = "sensor",
    .usStackDepth  = 512,
    .pvParameters  = nullptr,
    .uxPriority    = 4 | portPRIVILEGE_BIT,    // privileged or not
    .puxStackBuffer = sensor_stack,
    .xRegions = {
        { (void*)sensor_buffer, 1024,
          portMPU_REGION_READ_WRITE | portMPU_REGION_EXECUTE_NEVER },
        { (void*)nullptr, 0, 0 },
        { (void*)nullptr, 0, 0 }
    }
};
xTaskCreateRestrictedStatic(&params, &sensor_tcb_handle);
```

This is the FreeRTOS path to memory isolation. Compared with full process isolation on Linux, it is lightweight, but it does require careful design of the region grants.

### FreeRTOS-Plus Components

The FreeRTOS-Plus project ships several add-ons that integrate cleanly with the kernel:

- **FreeRTOS-Plus-TCP**: a small footprint TCP/IP stack maintained by Amazon, an alternative to lwIP
- **FreeRTOS-Plus-CLI**: a simple command-line interpreter that maps text commands to handlers
- **FreeRTOS-Plus-FAT**: a FAT12/16/32 file system suitable for SD cards and small flash file systems
- **coreMQTT, coreHTTP, coreJSON, corePKCS11**: AWS-maintained protocol libraries with minimal footprint

The FreeRTOS LTS releases bundle the kernel and these libraries with a stable API and security backports for two years per release. As of 2026, the current LTS line is FreeRTOS V11.x, which adds SMP support for multi-core Cortex-M parts, runtime statistics improvements, and granular configuration of the trace facilities.

---
