## Interrupt Handlers

An interrupt is a hardware signal that tells the CPU to stop what it is doing and execute a specific function, the Interrupt Service Routine (ISR). When a UART receives a byte, a timer overflows, or an ADC conversion completes, the peripheral asserts an interrupt line. The CPU saves its current context, looks up the ISR address in the vector table, and jumps to it. When the ISR returns, the CPU restores context and continues where it left off.

ISRs are the heartbeat of embedded firmware. They are also the most dangerous code to write incorrectly.

### ARM Cortex-M Interrupt Architecture

The NVIC (Nested Vectored Interrupt Controller) is built into Cortex-M cores and provides:

- **Up to 256 interrupt sources** (240 external + 16 internal exceptions)
- **256 priority levels** (8-bit priority register. Most STM32 devices implement 4 bits = 16 levels)
- **Hardware preemption:** a higher-priority interrupt can preempt a running ISR
- **Hardware context save/restore:** the CPU automatically pushes/pops R0-R3, R12, LR, PC, xPSR on interrupt entry, saving ~12 cycles vs software-managed context switches
- **Tail-chaining:** consecutive interrupts avoid redundant push/pop (~6 cycle savings)

Lower numeric priority values are higher priority on ARM (0 = highest). Configure priorities before enabling interrupts.

```cpp
#include "stm32f4xx.h"

void nvic_configure() {
    // USART1 interrupt: priority group 2, sub-priority 0
    // Numeric priority 2 → lower than priority 1 → can be preempted by priority 1
    NVIC_SetPriority(USART1_IRQn, 2);
    NVIC_EnableIRQ(USART1_IRQn);

    // SysTick at priority 1 -- preempts USART ISR, not vice versa
    NVIC_SetPriority(SysTick_IRQn, 1);
}
```

### ISR Requirements

Writing a correct ISR requires following strict rules:

**Must be `extern "C"`:** The vector table stores raw function pointers. C++ name mangling produces a different symbol name, which the linker cannot match to the vector table entry. Without `extern "C"`, the mangled name is placed in the `.text` section with no connection to the vector table, and the default handler fires instead.

**Must be fast:** Every cycle in the ISR is a cycle stolen from the main thread and from lower-priority ISRs. Rule of thumb: ISRs should run in < 1 μs (< 168 cycles at 168 MHz). Complex processing happens in the main thread, triggered by a flag the ISR sets.

**Must never block:** No `while (!(USART->SR & USART_SR_TXE))` in an ISR, that polling loop can spin forever if the main thread was the one expected to drain the transmit register.

**Must never allocate:** Covered in the previous section. `malloc` in an ISR is undefined behavior in any non-trivial system.

**Must handle shared state atomically:** Data shared between an ISR and the main thread must be protected. `volatile` prevents the compiler from caching the value in a register, but does not prevent tearing on multi-byte reads/writes. `std::atomic` is the correct tool.

```cpp
// Correct UART receive ISR for STM32F4
#include <cstdint>
#include "stm32f4xx.h"

// Ring buffer for ISR → main thread communication
static constexpr size_t RING_SIZE = 256;  // Must be power of two for mask trick
static uint8_t  g_rx_buf[RING_SIZE];
static volatile uint32_t g_rx_head = 0;  // Written by ISR
static volatile uint32_t g_rx_tail = 0;  // Read by main thread

extern "C" void USART1_IRQHandler() {
    uint32_t sr = USART1->SR;

    if (sr & USART_SR_RXNE) {
        // Read clears RXNE flag
        uint8_t byte = static_cast<uint8_t>(USART1->DR);

        uint32_t next_head = (g_rx_head + 1) & (RING_SIZE - 1);
        if (next_head != g_rx_tail) {
            // Buffer not full -- store byte
            g_rx_buf[g_rx_head] = byte;
            g_rx_head = next_head;  // Publish: visible to main thread after this write
        }
        // If full: silently drop. In production, increment an overflow counter.
    }

    if (sr & USART_SR_ORE) {
        // Overrun error: clear by reading SR then DR
        (void)USART1->SR;
        (void)USART1->DR;
    }
}

// Main thread: consume bytes from ring buffer
bool uart_read_byte(uint8_t& out) {
    if (g_rx_tail == g_rx_head) return false;  // Empty
    out = g_rx_buf[g_rx_tail];
    g_rx_tail = (g_rx_tail + 1) & (RING_SIZE - 1);
    return true;
}
```

### `volatile` in Embedded C++: What It Does and Doesn't Do

`volatile` tells the compiler: "do not cache this variable in a register. Every read must go to memory. Every write must go to memory." It prevents two categories of incorrect optimization:

**Hardware register access:** Without `volatile`, the compiler may read a hardware register once and reuse the cached value. But hardware registers change without software intervention, the USART DR register contains a new byte every time a character arrives.

**ISR-visible variables:** Without `volatile`, the compiler may hoist a variable read out of a loop, assuming it cannot change. But the ISR can change it from a different execution context.

What `volatile` does *not* do:

```cpp
// volatile does NOT prevent tearing on 32-bit MCUs for 64-bit values
volatile uint64_t g_timestamp;  // Read may be torn: two 32-bit reads, ISR fires between them

// volatile does NOT order memory operations relative to other variables
// Use std::atomic<> for proper happens-before guarantees

// CORRECT: atomic for shared flags
#include <atomic>
static std::atomic<bool>    g_data_ready{false};
static std::atomic<uint32_t> g_sample_count{0};

extern "C" void ADC_IRQHandler() {
    g_latest_sample = ADC1->DR;          // Read conversion result
    g_sample_count.fetch_add(1, std::memory_order_relaxed);
    g_data_ready.store(true, std::memory_order_release);  // Publish
}

void main_loop_process() {
    if (g_data_ready.load(std::memory_order_acquire)) {
        g_data_ready.store(false, std::memory_order_relaxed);
        process_sample(g_latest_sample);
    }
}
```

**Hardware register `volatile`:** Memory-mapped peripheral registers are always accessed through `volatile` pointers. CMSIS headers define them as `volatile uint32_t` fields in structs:

```cpp
// Accessing GPIO output data register directly (without CMSIS struct)
volatile uint32_t* const ODR = reinterpret_cast<volatile uint32_t*>(0x40020C14);
*ODR = 0x0020;  // Each write generates a real memory store -- not optimized away
```

### Lock-Free SPSC Ring Buffer for ISR Communication

The simple ring buffer above uses `volatile` head/tail indices. For multi-byte packets or Cortex-M devices with out-of-order memory (Cortex-M7 has cache), `std::atomic` with explicit ordering provides a correct single-producer single-consumer queue.

```cpp
#include <atomic>
#include <cstdint>
#include <cstring>

template<typename T, size_t N>
class SpscRingBuffer {
    static_assert((N & (N - 1)) == 0, "N must be a power of two");

    T                     buf_[N];
    std::atomic<uint32_t> head_{0};  // Written by producer (ISR)
    std::atomic<uint32_t> tail_{0};  // Written by consumer (main)

public:
    // Called from ISR -- must not block
    bool push(const T& item) {
        uint32_t h = head_.load(std::memory_order_relaxed);
        uint32_t next = (h + 1) & (N - 1);
        if (next == tail_.load(std::memory_order_acquire)) {
            return false;  // Full
        }
        buf_[h] = item;
        head_.store(next, std::memory_order_release);
        return true;
    }

    // Called from main thread -- must not block
    bool pop(T& out) {
        uint32_t t = tail_.load(std::memory_order_relaxed);
        if (t == head_.load(std::memory_order_acquire)) {
            return false;  // Empty
        }
        out = buf_[t];
        tail_.store((t + 1) & (N - 1), std::memory_order_release);
        return true;
    }
};

struct SensorFrame { uint32_t timestamp; uint16_t values[8]; };
static SpscRingBuffer<SensorFrame, 16> g_sensor_queue;
```

### DMA and Completion Interrupts

For high-throughput peripherals (UART, SPI, I2C at > 1 Mbit/s), polling or per-byte interrupts waste CPU cycles. DMA transfers data directly between peripheral and memory while the CPU runs other code.

```cpp
// Configure DMA for USART1 receive (STM32F4)
void uart_dma_init() {
    RCC->AHB1ENR |= RCC_AHB1ENR_DMA2EN;

    // DMA2, Stream 5, Channel 4: USART1_RX
    DMA2_Stream5->CR  = 0;  // Disable while configuring
    DMA2_Stream5->PAR = reinterpret_cast<uint32_t>(&USART1->DR);  // Peripheral address
    DMA2_Stream5->M0AR= reinterpret_cast<uint32_t>(uart_dma_rx);   // Memory address
    DMA2_Stream5->NDTR= sizeof(uart_dma_rx);
    DMA2_Stream5->CR  =
        (4U << DMA_SxCR_CHSEL_Pos) |   // Channel 4
        DMA_SxCR_MINC              |   // Increment memory address
        DMA_SxCR_CIRC              |   // Circular mode: wrap around
        DMA_SxCR_TCIE;                 // Transfer complete interrupt
    DMA2_Stream5->CR |= DMA_SxCR_EN;

    USART1->CR3 |= USART_CR3_DMAR;  // Enable USART DMA receive
}

// ISR fires when DMA completes one full buffer transfer
extern "C" void DMA2_Stream5_IRQHandler() {
    if (DMA2->HISR & DMA_HISR_TCIF5) {
        DMA2->HIFCR = DMA_HIFCR_CTCIF5;  // Clear flag
        g_dma_buffer_ready.store(true, std::memory_order_release);
    }
}
```

### FreeRTOS ISR-Safe APIs

When running on FreeRTOS, never call standard FreeRTOS API functions from an ISR. Use the `FromISR` variants, which are non-blocking and safe to call from interrupt context.

```cpp
// ISR-safe FreeRTOS: send to queue from interrupt
extern "C" void TIM2_IRQHandler() {
    HAL_TIM_IRQHandler(&htim2);  // Clear timer flag

    SensorReading reading = read_sensors_fast();

    BaseType_t higher_priority_woken = pdFALSE;
    xQueueSendFromISR(g_sensor_queue, &reading, &higher_priority_woken);

    // If a higher-priority task was unblocked, request a context switch
    portYIELD_FROM_ISR(higher_priority_woken);
}
```

`portYIELD_FROM_ISR` triggers a PendSV exception if a higher-priority task was made ready, ensuring the system preempts to the newly-ready task immediately after the ISR returns rather than waiting for the next scheduler tick.

### Go Comparison

Go has no ISR concept. Signal handlers (`os/signal`) exist but are not analogous, they run on a goroutine, have full runtime support, and are not suitable for real-time response. The closest Go idiom to ISR → main thread communication is an unbuffered or small-buffered channel: the ISR side is the writer goroutine, the main side is the reader. The lock-free SPSC ring buffer above is essentially a channel implementation stripped of the scheduler overhead, which is exactly what embedded programmers invented before channels existed as a language concept.

---
