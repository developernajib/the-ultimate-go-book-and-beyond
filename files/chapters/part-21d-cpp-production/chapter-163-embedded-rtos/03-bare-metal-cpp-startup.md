## Bare-Metal C++ Startup

When the part comes out of reset, there is no operating system, no heap, and no `main`. There is a stack pointer loaded from flash address 0, a program counter loaded from flash address 4, and whatever the silicon designers wired into the reset behavior. Getting from that state to a running C++ application is the bootloader and the C runtime, and on a microcontroller you write both.

### The Cortex-M Reset Vector

On a Cortex-M part, the first 256 to 1024 bytes of flash are the vector table. Address 0 holds the initial stack pointer. Address 4 holds the address of the reset handler. Subsequent slots hold the addresses of the system exception handlers (NMI, hard fault, SVCall, PendSV, SysTick) followed by the device-specific interrupt handlers.

```cpp
// vector_table.cpp - placed at flash origin
#include <cstdint>

extern "C" {
    extern std::uint32_t __stack_top;     // from linker script
    void Reset_Handler();
    void NMI_Handler();
    void HardFault_Handler();
    void MemManage_Handler();
    void BusFault_Handler();
    void UsageFault_Handler();
    void SVC_Handler();
    void DebugMon_Handler();
    void PendSV_Handler();
    void SysTick_Handler();
}

using handler_t = void(*)();

__attribute__((section(".isr_vector"), used))
const handler_t vector_table[] = {
    reinterpret_cast<handler_t>(&__stack_top),
    Reset_Handler,
    NMI_Handler,
    HardFault_Handler,
    MemManage_Handler,
    BusFault_Handler,
    UsageFault_Handler,
    nullptr, nullptr, nullptr, nullptr,   // reserved
    SVC_Handler,
    DebugMon_Handler,
    nullptr,
    PendSV_Handler,
    SysTick_Handler,
    // ... device IRQs follow
};
```

The `section(".isr_vector")` attribute tells the linker to place this array at a known section, and the linker script puts that section at flash origin.

### The Reset Handler

The reset handler is the first C or C++ that runs. Its job is to set up the C runtime so that C++ can execute correctly. On Cortex-M, this means:

1. Copy initialized data (`.data`) from flash to SRAM.
2. Zero uninitialized data (`.bss`).
3. Set up the FPU if present.
4. Call C++ global constructors.
5. Call `main`.
6. If `main` returns, hang.

```cpp
extern "C" {
    extern std::uint32_t __data_start__, __data_end__, __data_load__;
    extern std::uint32_t __bss_start__, __bss_end__;
    extern void (*__init_array_start[])();
    extern void (*__init_array_end[])();
    int main();
}

extern "C" __attribute__((noreturn))
void Reset_Handler() {
    // Copy .data from flash to SRAM
    std::uint32_t* src = &__data_load__;
    std::uint32_t* dst = &__data_start__;
    while (dst < &__data_end__) {
        *dst++ = *src++;
    }

    // Zero .bss
    dst = &__bss_start__;
    while (dst < &__bss_end__) {
        *dst++ = 0;
    }

    // Enable FPU on Cortex-M4F/M7/M33 if compiled with FPU support
    #if defined(__VFP_FP__) && !defined(__SOFTFP__)
        volatile std::uint32_t* CPACR = reinterpret_cast<std::uint32_t*>(0xE000ED88);
        *CPACR |= (0xF << 20);   // CP10 + CP11 full access
        asm volatile("dsb" ::: "memory");
        asm volatile("isb" ::: "memory");
    #endif

    // Call C++ global constructors
    for (auto* p = __init_array_start; p < __init_array_end; ++p) {
        (*p)();
    }

    // Hand off to application
    main();

    // main() should never return on a microcontroller
    for (;;) { asm volatile("wfi"); }
}
```

Two non-obvious points. First, the `dsb` and `isb` after enabling the FPU are not optional. Without them, the next instruction (which the pipeline already fetched) will see CP10 disabled and fault. Second, every C++ global with a non-trivial constructor generates an entry in `.init_array`, and the order is the link order. If you depend on construction order between translation units, you have a defect waiting to ship.

### C++ Static Constructor Order

C++ guarantees that static objects within a single translation unit are constructed in declaration order. It does not guarantee an order across translation units. This is the "static initialization order fiasco," and on a microcontroller it bites harder than on a desktop because there is no exception handler to catch the resulting nonsense.

The defensive patterns:

**Construct on first use.** Replace globals with `static` locals inside accessor functions. The function-local static is initialized the first time the function is called, in a thread-safe manner by default since C++11.

```cpp
class Uart;
Uart& debug_uart() {
    static Uart instance(USART2, 115200);
    return instance;
}
```

**`constinit`.** C++20 added `constinit` which forces constant initialization at translation time, eliminating the order question entirely for objects whose constructors are `constexpr`.

```cpp
constinit GpioPort port_b{GPIOB};
```

**Avoid static constructors with side effects.** Many embedded shops ban globals with non-trivial constructors entirely. The Google C++ Style Guide takes this position. AUTOSAR C++14 effectively requires it through rule A3-3-2.

### NVIC Setup

The Nested Vectored Interrupt Controller dispatches device interrupts. After reset all interrupts are disabled. Application code enables specific lines and sets their priorities. On Cortex-M, the priority field is implementation-defined width (typically 3 to 4 bits, giving 8 to 16 priority levels).

```cpp
class Nvic {
    static constexpr std::uintptr_t NVIC_ISER0 = 0xE000E100;
    static constexpr std::uintptr_t NVIC_IPR0  = 0xE000E400;
public:
    static void enable_irq(int irq) {
        auto* iser = reinterpret_cast<volatile std::uint32_t*>(NVIC_ISER0);
        iser[irq >> 5] = 1u << (irq & 31);
    }
    static void set_priority(int irq, std::uint8_t pri) {
        auto* ipr = reinterpret_cast<volatile std::uint8_t*>(NVIC_IPR0);
        ipr[irq] = pri << 4;   // upper 4 bits implemented on most Cortex-M
    }
};
```

A subtle gotcha: priorities on Cortex-M are inverted from what most engineers expect. Lower numbers are higher priority. Priority 0 preempts priority 1.

### Linker Script

The linker script declares the memory regions and tells the linker which sections go where. A minimal script for an STM32F4 with 1 MB flash and 192 KB SRAM:

```
MEMORY {
    FLASH (rx)  : ORIGIN = 0x08000000, LENGTH = 1024K
    SRAM  (rwx) : ORIGIN = 0x20000000, LENGTH = 192K
}

ENTRY(Reset_Handler)

SECTIONS {
    .isr_vector : { KEEP(*(.isr_vector)) } > FLASH

    .text : {
        *(.text*)
        *(.rodata*)
        . = ALIGN(4);
        __init_array_start = .;
        KEEP(*(.init_array*))
        __init_array_end = .;
    } > FLASH

    __data_load__ = LOADADDR(.data);
    .data : {
        __data_start__ = .;
        *(.data*)
        __data_end__ = .;
    } > SRAM AT > FLASH

    .bss (NOLOAD) : {
        __bss_start__ = .;
        *(.bss*)
        *(COMMON)
        __bss_end__ = .;
    } > SRAM

    .ramfunc : {
        *(.ramfunc*)
    } > SRAM AT > FLASH

    .stack (NOLOAD) : {
        . = ALIGN(8);
        . = . + 0x2000;        // 8 KB stack
        __stack_top = .;
    } > SRAM
}
```

The `AT > FLASH` clause for `.data` is the trick that places the section's load address (LMA) in flash while its virtual address (VMA) is in SRAM. The reset handler copies from LMA to VMA. The same trick gives `.ramfunc` a flash backing store but RAM execution address.

### newlib-nano vs picolibc

The C standard library that ships in the GCC Arm toolchain is `newlib`, which is too large for many MCUs. `newlib-nano` is a stripped-down build that drops `printf` floating-point support, reduces locale support, and removes wide-character routines. It cuts a typical hello-world from 70 KB to 12 KB.

`picolibc` is a more aggressive rewrite by Keith Packard that integrates ideas from `newlib`, AVR-libc, and Plan 9. It is the default in modern Zephyr and is significantly smaller than `newlib-nano` for the same feature set, particularly for `printf` and `scanf`.

For C++ specifically, you also need `libstdc++`. The full `libstdc++` is enormous because of the IOstreams library and the locale machinery. The choices are:

1. Link the full `libstdc++` and pay the size.
2. Use `-fno-exceptions -fno-rtti` and link only the parts you need.
3. Use a replacement like `etl` (Embedded Template Library) which provides STL-compatible containers without dynamic allocation.
4. Use `eastl` (Electronic Arts STL) which is also heap-aware.

A typical embedded C++ build line on GCC Arm:

```
arm-none-eabi-g++ -mcpu=cortex-m4 -mthumb -mfpu=fpv4-sp-d16 -mfloat-abi=hard \
    -ffunction-sections -fdata-sections -fno-exceptions -fno-rtti \
    -fno-threadsafe-statics -fno-use-cxa-atexit \
    -Os -g3 -std=c++20 \
    -T linker.ld -nostartfiles --specs=nano.specs --specs=nosys.specs \
    -Wl,--gc-sections -Wl,-Map=app.map \
    src/*.cpp -o app.elf
```

`-fno-threadsafe-statics` removes the locking around function-local statics that GCC inserts by default. On a single-threaded firmware it is wasted code. `--specs=nano.specs` selects newlib-nano. `--gc-sections` lets the linker discard unused functions, which combined with `-ffunction-sections` typically saves 20 to 40 percent on flash.

---
