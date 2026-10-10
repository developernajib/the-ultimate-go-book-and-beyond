## Bare-Metal C++: No OS, No Standard Library

Bare-metal means the processor runs your code directly, no operating system, no scheduler, no libc loaded by an ELF loader, no dynamic linker. When the CPU exits reset, it begins executing code at a hard-wired address. Before `main()` can be called, before any C++ constructor runs, the runtime environment must be bootstrapped by hand. Understanding this sequence is fundamental to embedded C++.

### The Startup Sequence

When an ARM Cortex-M processor powers on or resets:

1. The hardware reads the initial stack pointer from address `0x00000000` (offset 0 of the interrupt vector table)
2. The hardware reads the reset handler address from address `0x00000004` (offset 4)
3. Execution jumps to the reset handler

Everything that happens before `main()`, including the construction of global objects, is the startup code's responsibility.

```cpp
// startup.cpp -- bare-metal reset handler for STM32F4
#include <cstdint>
#include <cstring>

// Symbols defined by the linker script
extern uint32_t _sidata;   // Start of .data initial values in flash
extern uint32_t _sdata;    // Start of .data in SRAM
extern uint32_t _edata;    // End of .data in SRAM
extern uint32_t _sbss;     // Start of .bss in SRAM
extern uint32_t _ebss;     // End of .bss in SRAM
extern uint32_t _stack_top; // Top of stack (set in linker script)

// Function prototype: called to run global constructors
extern void __libc_init_array();

// User's main function
extern int main();

extern "C" void Reset_Handler() {
    // 1. Copy .data section from flash to SRAM
    uint32_t* src = &_sidata;
    uint32_t* dst = &_sdata;
    while (dst < &_edata) {
        *dst++ = *src++;
    }

    // 2. Zero .bss section
    dst = &_sbss;
    while (dst < &_ebss) {
        *dst++ = 0;
    }

    // 3. Call global C++ constructors (objects with static storage duration)
    __libc_init_array();

    // 4. Jump to main -- bare-metal main never returns
    main();

    // Should never reach here -- halt if it does
    while (true) { __asm volatile ("wfi"); }
}
```

The `extern "C"` linkage is mandatory, the vector table contains raw function pointers, and name mangling would make the address unreachable.

### The Interrupt Vector Table

The vector table is a contiguous array of function pointers placed at a fixed address. The first entry is the initial stack pointer value (not a function pointer, the CPU treats it as a 32-bit immediate loaded into SP). All subsequent entries are exception and interrupt handlers.

```cpp
// vectors.cpp -- ARM Cortex-M4 vector table
#include <cstdint>

// Default handler: infinite loop for unhandled exceptions
extern "C" void Default_Handler() {
    while (true) { __asm volatile ("wfi"); }
}

// Weak aliases -- override by defining the handler in your code
extern "C" void NMI_Handler()       __attribute__((weak, alias("Default_Handler")));
extern "C" void HardFault_Handler() __attribute__((weak, alias("Default_Handler")));
extern "C" void MemManage_Handler() __attribute__((weak, alias("Default_Handler")));
extern "C" void BusFault_Handler()  __attribute__((weak, alias("Default_Handler")));
extern "C" void UsageFault_Handler()__attribute__((weak, alias("Default_Handler")));
extern "C" void SVC_Handler()       __attribute__((weak, alias("Default_Handler")));
extern "C" void PendSV_Handler()    __attribute__((weak, alias("Default_Handler")));
extern "C" void SysTick_Handler()   __attribute__((weak, alias("Default_Handler")));

// Device-specific IRQs (STM32F407, up to 91 external interrupts)
extern "C" void USART1_IRQHandler() __attribute__((weak, alias("Default_Handler")));
extern "C" void TIM2_IRQHandler()   __attribute__((weak, alias("Default_Handler")));
// ... more device IRQs ...

extern "C" void Reset_Handler();
extern uint32_t _stack_top;

// The vector table itself -- placed in .isr_vector by the linker script
__attribute__((section(".isr_vector"), used))
const uintptr_t g_vectors[] = {
    reinterpret_cast<uintptr_t>(&_stack_top),  // Initial SP
    reinterpret_cast<uintptr_t>(Reset_Handler),
    reinterpret_cast<uintptr_t>(NMI_Handler),
    reinterpret_cast<uintptr_t>(HardFault_Handler),
    reinterpret_cast<uintptr_t>(MemManage_Handler),
    reinterpret_cast<uintptr_t>(BusFault_Handler),
    reinterpret_cast<uintptr_t>(UsageFault_Handler),
    0, 0, 0, 0,  // Reserved
    reinterpret_cast<uintptr_t>(SVC_Handler),
    0, 0,        // Reserved
    reinterpret_cast<uintptr_t>(PendSV_Handler),
    reinterpret_cast<uintptr_t>(SysTick_Handler),
    // Device IRQs follow...
    reinterpret_cast<uintptr_t>(USART1_IRQHandler),
    reinterpret_cast<uintptr_t>(TIM2_IRQHandler),
};
```

The `__attribute__((weak, alias))` pattern is essential: it provides a default (infinite-loop) handler for every vector, but any translation unit that defines the same function name without `weak` will override it. You only implement handlers for the peripherals you actually use.

### Bare-Metal Compiler Flags

Compiling without standard library requires explicit flags to prevent the toolchain from inserting OS-dependent code.

```makefile
CXXFLAGS += \
    -mcpu=cortex-m4        \  # Target CPU
    -mthumb                \  # Thumb-2 instruction set
    -mfpu=fpv4-sp-d16      \  # FPU type (Cortex-M4F)
    -mfloat-abi=hard       \  # Use FPU for float args/returns
    -ffreestanding         \  # Don't assume hosted environment
    -fno-exceptions        \  # No exception runtime overhead
    -fno-rtti              \  # No RTTI (typeid, dynamic_cast)
    -fno-threadsafe-statics\  # No mutex around static local init
    -fno-use-cxa-atexit    \  # No global destructor registration
    -nostdlib              \  # Don't link standard library
    -Os                    \  # Optimize for size
    -g3                    \  # Full debug info
    -Wall -Wextra          \
    -Werror
```

**`-ffreestanding`:** Tells GCC the program does not have a standard C library available. The compiler may not assume `memcpy`, `memset`, etc., are available unless explicitly provided.

**`-fno-exceptions`:** Eliminates the exception unwinding tables and runtime (libsupc++). Saves 2-8 KB of flash on typical embedded projects and removes the non-deterministic exception dispatch path.

**`-fno-rtti`:** Eliminates the type information tables needed by `dynamic_cast` and `typeid`. Saves flash and removes a class of non-deterministic behavior.

**`-fno-threadsafe-statics`:** By default, GCC generates a mutex lock around the first-time initialization of function-local static variables. In bare-metal single-threaded code, this generates calls to undefined `__cxa_guard_acquire/__cxa_guard_release`. This flag removes the guard.

### What You Can Keep Without OS

Many useful headers work in freestanding mode because they are purely computational:

```cpp
// These work in -ffreestanding -nostdlib:
#include <cstdint>     // uint8_t, uint32_t, etc.
#include <cstddef>     // size_t, ptrdiff_t, nullptr_t
#include <cstring>     // memcpy, memset (provided by your startup/newlib)
#include <type_traits> // is_trivial, is_pod, enable_if -- all constexpr
#include <limits>      // numeric_limits<uint16_t>::max() -- constexpr
#include <array>       // std::array -- no heap, header-only
#include <utility>     // std::move, std::forward
#include <algorithm>   // std::min, std::max, std::fill -- but NOT std::sort with comparators that allocate

// These require OS/libc and cannot be used:
// #include <iostream>   -- syscall-dependent
// #include <string>     -- heap-dependent
// #include <vector>     -- heap-dependent
// #include <map>        -- heap-dependent
// #include <thread>     -- OS-dependent
```

### Full Bare-Metal GPIO Example

A minimal LED-blink program on STM32F407, using only CMSIS register access, no HAL, no BSP, no OS.

```cpp
// main.cpp -- bare-metal STM32F407 LED blink
#include <cstdint>
#include "stm32f4xx.h"  // CMSIS device header

// Simple busy-wait delay using SysTick or instruction count
static void delay_ms(uint32_t ms) {
    // At 16 MHz HSI, each loop is ~4 cycles. 16e6/4 = 4e6 loops/sec.
    volatile uint32_t count = ms * 4000;
    while (count--) { __asm volatile ("nop"); }
}

int main() {
    // 1. Enable GPIOD clock (STM32F407 Discovery: LED on PD12-PD15)
    RCC->AHB1ENR |= RCC_AHB1ENR_GPIODEN;
    __DSB();  // Ensure clock enable propagates before register access

    // 2. Configure PD12 as output (MODER: 01 = output)
    GPIOD->MODER &= ~(GPIO_MODER_MODER12_Msk);
    GPIOD->MODER |=  (GPIO_MODER_MODER12_0);   // 01 = general purpose output

    // 3. Configure as push-pull (OTYPER bit 12 = 0 = push-pull)
    GPIOD->OTYPER &= ~(GPIO_OTYPER_OT12_Msk);

    // 4. Set output speed to low (OSPEEDR: 00 = low speed)
    GPIOD->OSPEEDR &= ~(GPIO_OSPEEDR_OSPEED12_Msk);

    // 5. No pull-up/pull-down (PUPDR: 00)
    GPIOD->PUPDR &= ~(GPIO_PUPDR_PUPD12_Msk);

    // 6. Blink loop -- never returns
    while (true) {
        GPIOD->BSRR = GPIO_BSRR_BS12;  // Set PD12 high
        delay_ms(500);
        GPIOD->BSRR = GPIO_BSRR_BR12;  // Set PD12 low
        delay_ms(500);
    }
}
```

### Global Constructor Initialization Order

Global objects with constructors are initialized in translation-unit order before `main()`, but order between translation units is unspecified. This can cause the static initialization order fiasco: object A's constructor references object B, but B has not been constructed yet.

```cpp
// Avoid inter-TU constructor dependencies.
// If needed, use __attribute__((init_priority(N))):
class SystemClock {
public:
    SystemClock() { /* configure PLL, set clock to 168 MHz */ }
};

class UART {
public:
    UART() { /* needs system clock configured first */ }
};

// init_priority 101 runs before 102
__attribute__((init_priority(101))) SystemClock g_clock;
__attribute__((init_priority(102))) UART        g_uart;
```

Lower `init_priority` values run first. The valid range is 101-65535 (0-100 are reserved by the implementation).

### Go Comparison

TinyGo supports bare-metal targets including Arduino Uno (AVR), Arduino Nano 33 BLE (nRF52840), Raspberry Pi Pico (RP2040), and STM32 boards. TinyGo provides its own startup code, minimal runtime (goroutine scheduler for simple cooperative concurrency), and a subset of the standard library. For bare-metal, GC is optional or disabled. The abstraction level is higher than raw C++, the `machine` package provides GPIO, UART, SPI/I2C drivers, but the programmer has less control over section placement, interrupt latency, and WCET. For educational purposes TinyGo is excellent. For production safety-critical systems, raw C++ or Ada remain the tools of choice.

---
