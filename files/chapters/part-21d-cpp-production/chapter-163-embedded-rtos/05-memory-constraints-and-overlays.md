## Memory Constraints and Overlays

The defining property of embedded C++ is that memory is finite, fixed at fabrication, and not negotiable. A Cortex-M0 with 16 KB of flash will never have 17 KB of flash. The application either fits or it does not ship.

### Typical Budgets in Production

A realistic snapshot of memory budgets across the parts that ship in real products today:

| Part | Flash | SRAM | Cache | TCM |
|---|---|---|---|---|
| Microchip ATtiny85 (AVR) | 8 KB | 512 B | none | none |
| Nordic nRF52810 (M4) | 192 KB | 24 KB | none | none |
| STM32F411 (M4) | 512 KB | 128 KB | none | none |
| ESP32-C3 (RV32) | 4 MB external | 400 KB | 16 KB | none |
| STM32H743 (M7) | 2 MB | 1 MB | 16 KB I + 16 KB D | 64 KB ITCM + 128 KB DTCM |
| Nordic nRF5340 (M33 dual) | 1 MB + 256 KB | 512 KB + 64 KB | none | none |
| NXP RT1170 (M7 + M4) | external QSPI 16 to 64 MB | 2 MB | 32 KB I + 32 KB D | 256 KB ITCM + 256 KB DTCM |
| Alif Ensemble E7 (M55 + M55 + A32) | external | 13.5 MB | varies | yes |

The application code, stack, heap, and DMA buffers all share the SRAM. The flash holds code, constants, and the load image of `.data`.

A typical breakdown for a 256 KB SRAM part running an application with FreeRTOS, a TCP/IP stack, and BLE:

```
.text + .rodata in flash:   400 KB
.data in SRAM:                4 KB   (initialized globals)
.bss in SRAM:                32 KB   (uninitialized globals, including FreeRTOS heap_4)
Task stacks (8 tasks * 2KB):  16 KB
Main stack (ISR):              4 KB
DMA buffers (rings, descs): 16 KB
TCP/IP buffers:              64 KB
BLE controller buffers:      32 KB
Free SRAM:                   88 KB
```

The "free SRAM" line is what is left for the actual application. It looks generous and disappears the moment someone adds a 4-channel audio recorder or a JPEG buffer.

### Where to Place Code

Cortex-M7 and later parts have multiple memory regions with very different access timings.

**Internal flash.** Code executes in place. On most parts, accessing flash beyond the first wait state cliff (often 28 to 30 MHz on Cortex-M4, higher on M7) requires wait states. The flash accelerator (ART on STM32) prefetches and caches lines to reduce stalls. Worst-case access for a cache miss is the wait-state count plus a flash refresh.

**ITCM (Instruction Tightly Coupled Memory).** Single-cycle access from the CPU, bypasses the cache. Code placed in ITCM never stalls. Use it for the highest-priority interrupt handlers and the inner loops of control algorithms.

**DTCM (Data Tightly Coupled Memory).** Single-cycle data access, no cache between CPU and DTCM. Use for the DSP working buffers, the PID controller state, the FIR filter coefficients in the audio path.

**Internal SRAM.** Cached. Cache hits are single cycle, cache misses cost a refill from SRAM. Default for most data.

**External QSPI flash (XIP).** Cortex-M7 and later support execute-in-place from QSPI. Latency is much higher than internal flash, often hundreds of cycles for a cache miss. Use for code that is rarely called or large but cold (UI assets, infrequent settings code).

**External DRAM.** Found on parts like NXP RT and i.MX. Cached, large, slow on miss. Use for buffers that do not fit in SRAM.

The linker script places sections explicitly:

```
SECTIONS {
    .itcm_code : { *(.itcm_code*) } > ITCM AT > FLASH
    .dtcm_data : { *(.dtcm_data*) } > DTCM
    .external_flash : { *(.external_flash*) } > QSPI
}
```

And C++ code uses attributes to direct functions and data:

```cpp
#define ITCM    __attribute__((section(".itcm_code")))
#define DTCM    __attribute__((section(".dtcm_data")))
#define COLD    __attribute__((section(".external_flash")))

ITCM void HighPriorityIrqHandler() {
    // single-cycle fetches, no flash wait states
}

DTCM std::array<float, 1024> filter_state;

COLD void format_settings_screen() {
    // rarely called, lives in slow QSPI
}
```

### .ramfunc and Self-Programming

When the application updates its own flash (firmware update, configuration write), the flash controller is busy and cannot service code reads. If the executing code lives in flash, the part hangs. The fix is to copy the flash routines to RAM and execute them from there.

The linker script reserves a `.ramfunc` section in SRAM with a flash load address. The startup code copies the section at boot, identical to `.data`. Functions are tagged with the attribute:

```cpp
__attribute__((section(".ramfunc"), long_call, noinline))
bool flash_program_word(std::uint32_t addr, std::uint32_t value) {
    // Wait for any prior op
    while (FLASH->SR & FLASH_SR_BSY) {}
    FLASH->CR |= FLASH_CR_PG;
    *reinterpret_cast<volatile std::uint32_t*>(addr) = value;
    while (FLASH->SR & FLASH_SR_BSY) {}
    FLASH->CR &= ~FLASH_CR_PG;
    return (FLASH->SR & FLASH_SR_EOP) != 0;
}
```

The `long_call` attribute forces an absolute 32-bit branch, because a relative `BL` from flash to RAM may be out of range.

### XIP from External Flash

Modern parts boot from external QSPI or OctoSPI flash with XIP. The flash controller maps the external flash into the CPU address space and serves reads through a small instruction cache. Apple's secure enclave, NVIDIA's Tegra parts, and many automotive SoCs use this pattern.

The cost is unpredictability. A cache miss may need to issue a new QSPI command, wait for the flash to respond, and stream the line back. On a 100 MHz QSPI bus that is roughly 200 ns of wall time per miss. In a hard real-time loop, even one miss per iteration breaks determinism. The fix is to copy the hot path to ITCM or internal flash before entering the loop and execute from there.

### MPU Configuration

The Memory Protection Unit on Cortex-M lets the CPU enforce per-region access rules: read-only, no-execute, privileged-only. It is the difference between a buffer overflow being caught immediately by a fault and a buffer overflow corrupting the next variable for hours.

```cpp
class Mpu {
    static constexpr std::uintptr_t MPU_CTRL = 0xE000ED94;
    static constexpr std::uintptr_t MPU_RNR  = 0xE000ED98;
    static constexpr std::uintptr_t MPU_RBAR = 0xE000ED9C;
    static constexpr std::uintptr_t MPU_RASR = 0xE000EDA0;
public:
    enum class Access : std::uint32_t {
        NoAccess = 0, RO = 0b110, RW = 0b011, ROUser = 0b111, RWUser = 0b011
    };
    static void configure_region(int n, std::uintptr_t base,
                                 std::uint32_t size_pow2,
                                 Access ap, bool xn) {
        auto* rnr = reinterpret_cast<volatile std::uint32_t*>(MPU_RNR);
        auto* rbar = reinterpret_cast<volatile std::uint32_t*>(MPU_RBAR);
        auto* rasr = reinterpret_cast<volatile std::uint32_t*>(MPU_RASR);
        *rnr = n;
        *rbar = base;
        *rasr = (1u << 0) |                    // ENABLE
                ((size_pow2 - 1) << 1) |       // SIZE field
                (static_cast<std::uint32_t>(ap) << 24) |
                (xn ? (1u << 28) : 0);         // execute-never
    }
    static void enable() {
        auto* ctrl = reinterpret_cast<volatile std::uint32_t*>(MPU_CTRL);
        *ctrl = (1u << 0) | (1u << 2);          // ENABLE + PRIVDEFENA
        asm volatile("dsb" ::: "memory");
        asm volatile("isb" ::: "memory");
    }
};
```

Typical configuration in a production build:

```cpp
void setup_mpu() {
    // Region 0: code in flash, read-only execute
    Mpu::configure_region(0, 0x08000000, 20, Mpu::Access::RO, false);
    // Region 1: data in SRAM, read-write no-execute
    Mpu::configure_region(1, 0x20000000, 18, Mpu::Access::RW, true);
    // Region 2: stack guard at bottom of stack, no access
    Mpu::configure_region(2, &__stack_guard, 5, Mpu::Access::NoAccess, true);
    // Region 3: peripherals, read-write no-execute, device memory type
    Mpu::configure_region(3, 0x40000000, 28, Mpu::Access::RW, true);
    Mpu::enable();
}
```

The "stack guard" region at the bottom of the stack is a 32-byte region with no access. Any stack overflow that touches it triggers a MemManage fault immediately, instead of silently corrupting `.bss`.

### Stack and Heap Layout for Safety

The standard layout in a no-heap build looks like:

```
Flash:
  0x08000000  vector table, .text, .rodata
  0x080FFFFF  end of flash

SRAM:
  0x20000000  .data    (initialized globals)
  0x20001000  .bss     (zeroed globals, including RTOS task stacks if static)
  0x2000xxxx  heap (if any)
  ...
  0x2002xxxx  stack guard (no-access MPU region)
  0x2002xxxx  main stack (ISR stack on Cortex-M)
  0x2003FFFF  __stack_top
```

The stack grows downward from `__stack_top` toward the guard region. Any overflow hits the MPU. Without the MPU, an overflow silently corrupts the heap or .bss above it, and the resulting bug surfaces hours later in a completely unrelated module.

Per-task stacks under FreeRTOS or Zephyr live inside `.bss` (when statically allocated) or are dispensed from the RTOS heap. Each task gets its own stack guard if the RTOS is configured with stack overflow checking.

### Measuring Stack Usage

The standard technique is to fill every stack with a known pattern at boot, run the worst-case code path, and then walk back from the end of each stack to find the highest used address. FreeRTOS provides `uxTaskGetStackHighWaterMark` for this. Zephyr provides `k_thread_stack_space_get`.

```cpp
void monitor_stacks() {
    TaskHandle_t handles[] = { network_task, sensor_task, ui_task };
    for (auto h : handles) {
        UBaseType_t hwm = uxTaskGetStackHighWaterMark(h);
        log_info("task %s: %u words free at high water", pcTaskGetName(h), hwm);
    }
}
```

The number to watch is the high-water mark across the full feature set. If a task allocates 2 KB and the high-water mark is 200 bytes free, the next firmware version that adds a feature is going to overflow. Standard practice is to keep at least 25 percent free at peak.

---
