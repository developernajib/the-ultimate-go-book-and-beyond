## Deterministic Memory: Static Allocation Patterns

Knowing that the heap is banned is the easy part. The harder discipline is understanding the memory topology of a microcontroller and placing every byte consciously. On a typical ARM Cortex-M4 microcontroller, say, an STM32F4, you have multiple distinct memory regions with different access latencies, alignment requirements, and visibility to peripherals. Choosing the right region for each data structure is the difference between firmware that meets timing budgets and firmware that does not.

### Memory Regions on Microcontrollers

The STM32F407 memory map below shows four distinct regions with different properties: Flash is read-only and subject to ART prefetcher wait states, SRAM1 is zero-wait-state and DMA-accessible, CCM RAM is zero-latency but invisible to the DMA controller, and peripheral registers occupy the upper address space. Placing a DMA transfer buffer in CCM RAM is a silent hardware bug, the DMA controller cannot reach that address range, so understanding this map is prerequisite to any embedded memory optimization.
```
STM32F407 memory map (simplified):
  0x0800_0000 - 0x080F_FFFF : Flash (1 MB)     -- code, const data, rodata
  0x2000_0000 - 0x2001_FFFF : SRAM1 (128 KB)   -- main SRAM, DMA-accessible
  0x2002_0000 - 0x2002_FFFF : SRAM2 (64 KB)    -- secondary SRAM
  0x1000_0000 - 0x1000_FFFF : CCM (64 KB)      -- Core Coupled Memory, NOT DMA-accessible
  0x4000_0000 - 0x5FFF_FFFF : Peripheral regs  -- APB1, APB2, AHB1 peripherals
```

**Flash (ROM):** Where your compiled code lives. Read-only after programming. Access time is 2-8 wait states at high CPU frequencies, the STM32F4 at 168 MHz adds wait states and uses the ART accelerator to prefetch. Constants declared `const` end up here unless the optimizer decides to copy them into registers.

**SRAM:** The main working memory. Zero wait states at typical frequencies. All stack variables, non-const globals, and static locals live here. DMA controllers can read and write SRAM directly.

**CCM (Core Coupled Memory):** Physically wired directly to the Cortex-M4 CPU's instruction and data buses, zero wait states even at maximum clock. Perfect for hot data structures accessed in every interrupt. Critical restriction: DMA controllers cannot reach CCM on most STM32 devices, so DMA buffers must live in main SRAM.

**External SDRAM:** Available on boards with the FMC (Flexible Memory Controller). 4-16 MB available, but 50-200 ns access latency due to DRAM refresh and bus arbitration. Suitable for display frame buffers and audio data, not real-time control state.

### Linker Section Placement

The GCC `__attribute__((section("name")))` directs the linker to place a symbol in a named section. The linker script maps sections to address ranges.

```cpp
#include <cstdint>

// Place time-critical ISR data in CCM for zero-wait-state access
__attribute__((section(".ccm_data")))
static volatile uint32_t encoder_count = 0;

__attribute__((section(".ccm_data")))
static int32_t pid_integral = 0;

// Large lookup table belongs in flash -- preserve SRAM for live data
__attribute__((section(".flash_rodata")))
static const uint16_t sine_table[4096] = { /* 8 KB of sine values */ };

// DMA receive buffer must be in main SRAM, not CCM
__attribute__((section(".sram_dma"), aligned(4)))
static uint8_t uart_dma_rx[256];
```

The linker script (`STM32F407.ld`) defines where `.ccm_data` maps:

```linker
/* Excerpt from linker script */
MEMORY {
    FLASH  (rx)  : ORIGIN = 0x08000000, LENGTH = 1M
    SRAM   (rwx) : ORIGIN = 0x20000000, LENGTH = 128K
    SRAM2  (rwx) : ORIGIN = 0x20020000, LENGTH = 64K
    CCM    (rwx) : ORIGIN = 0x10000000, LENGTH = 64K
}

SECTIONS {
    .ccm_data (NOLOAD) : {
        *(.ccm_data)
    } > CCM

    .sram_dma (NOLOAD) : {
        *(.sram_dma)
    } > SRAM
}
```

### `.bss` vs `.data`: A Critical Distinction

Two sections hold static variables:

- **`.data`:** Initialized static variables (`static int x = 5`). The initial values are stored in flash. The startup code copies them from flash to SRAM before `main()` runs.
- **`.bss`:** Zero-initialized static variables (`static int x` or `static int x = 0`). No flash storage needed, startup code zeroes the section in SRAM. Saves flash space for zero-initialized arrays.

```cpp
// .data -- initial value stored in flash, copied to SRAM at boot
static uint32_t tx_sequence = 0x0001;

// .bss -- zeroed by startup code, no flash cost
static uint8_t packet_buffer[512];

// .rodata -- lives entirely in flash, never copied
static const char firmware_version[] = "v2.4.1";
```

On a system with 256 KB flash and 64 KB SRAM, misplacing a large `const` array in `.data` instead of `.rodata` silently wastes both flash (storing the data twice) and SRAM (keeping an unnecessary copy).

### Compile-Time Size Validation

Static assertions enforce memory budgets at compile time, failing the build before flash or RAM is exhausted in the field.

```cpp
#include <cstddef>

struct ControlState {
    int32_t position;
    int32_t velocity;
    int32_t target;
    uint8_t flags;
    uint8_t mode;
};

struct SensorData {
    uint32_t timestamp_us;
    uint16_t adc_raw[8];
    float    temperature;
};

// Enforce struct sizes -- catch bloat introduced by later changes
static_assert(sizeof(ControlState) <= 64,
    "ControlState too large for per-task stack allocation");
static_assert(sizeof(SensorData) == 24,
    "SensorData layout changed -- check DMA frame alignment");

// Enforce alignment for hardware registers and DMA
static_assert(alignof(SensorData) >= 4,
    "SensorData must be 4-byte aligned for DMA transfers");

// Enforce that a pool fits in CCM
constexpr size_t MAX_MOTORS = 4;
static_assert(MAX_MOTORS * sizeof(ControlState) <= 1024,
    "Motor pool exceeds CCM allocation budget");
```

### Memory Budget Tracking in the Build System

A post-build step that checks `text + data + bss` against device limits catches overflows before flashing.

```makefile
# Makefile post-build check
SIZE_TOOL = arm-none-eabi-size

FLASH_MAX = 1048576   # 1 MB
SRAM_MAX  = 131072    # 128 KB

.PHONY: size-check
size-check: firmware.elf
	@$(SIZE_TOOL) $<
	@python3 scripts/check_memory.py $< $(FLASH_MAX) $(SRAM_MAX)
```

```python
# scripts/check_memory.py
import subprocess, sys, re

elf, flash_max, sram_max = sys.argv[1], int(sys.argv[2]), int(sys.argv[3])
out = subprocess.check_output(['arm-none-eabi-size', '-B', elf]).decode()
# Parse: text   data    bss    dec
m = re.search(r'(\d+)\s+(\d+)\s+(\d+)', out.split('\n')[1])
text, data, bss = int(m[1]), int(m[2]), int(m[3])

flash_used = text + data   # flash holds code + initialized data values
sram_used  = data + bss    # SRAM holds runtime data + zero-initialized storage

if flash_used > flash_max:
    print(f"FLASH OVERFLOW: {flash_used} > {flash_max}")
    sys.exit(1)
if sram_used > sram_max:
    print(f"SRAM OVERFLOW: {sram_used} > {sram_max}")
    sys.exit(1)

print(f"Memory OK: flash {flash_used}/{flash_max}  sram {sram_used}/{sram_max}")
```

### `const` and `constexpr` as Memory Discipline

Every value that does not change at runtime should be `const` or `constexpr`. This is not style, it has memory consequences.

```cpp
// BAD: non-const global lives in .data, consumes SRAM
uint16_t SENSOR_TIMEOUT_MS = 100;

// GOOD: const lives in .rodata in flash, zero SRAM cost
const uint16_t SENSOR_TIMEOUT_MS = 100;

// BETTER: constexpr -- also available at compile time for static_assert
constexpr uint16_t SENSOR_TIMEOUT_MS = 100;
constexpr size_t   ADC_CHANNELS      = 8;
constexpr size_t   ADC_BUFFER_SIZE   = ADC_CHANNELS * 16;

// Constexpr lookup table: computed at compile time, stored in flash
constexpr std::array<uint16_t, 256> make_crc_table() {
    std::array<uint16_t, 256> t{};
    for (int i = 0; i < 256; ++i) {
        uint16_t crc = static_cast<uint16_t>(i);
        for (int j = 0; j < 8; ++j)
            crc = (crc & 1) ? ((crc >> 1) ^ 0xA001) : (crc >> 1);
        t[i] = crc;
    }
    return t;
}
constexpr auto CRC16_TABLE = make_crc_table();  // In flash, zero runtime cost
```

### Pool Allocator at Startup

If some post-startup dynamic allocation is genuinely unavoidable, for instance, a runtime-configurable number of communication channels, use a startup pool: allocate everything from a static arena during `main()` initialization, then seal the allocator.

```cpp
#include <cstdint>
#include <cstddef>
#include <cstdlib>

class StartupPool {
    static uint8_t pool_[4096];
    size_t offset_ = 0;
    bool   sealed_ = false;

public:
    void* alloc(size_t size, size_t align = 4) {
        if (sealed_) std::abort();  // No allocation after init phase
        size_t aligned = (offset_ + align - 1) & ~(align - 1);
        if (aligned + size > sizeof(pool_)) std::abort();  // Pool exhausted
        void* p = &pool_[aligned];
        offset_ = aligned + size;
        return p;
    }

    void seal() { sealed_ = true; }  // Call at end of init phase
};

uint8_t StartupPool::pool_[4096];
static StartupPool g_startup_pool;

// During init:
void system_init() {
    // All subsystem objects allocated here
    auto* comm = new (g_startup_pool.alloc(sizeof(CommChannel))) CommChannel(baud_rate);
    auto* ctrl = new (g_startup_pool.alloc(sizeof(Controller)))  Controller(comm);
    g_startup_pool.seal();  // From this point on, allocation aborts
}
```

After `seal()`, any code path that tries to allocate from the pool aborts immediately. The system's memory footprint is frozen at the end of initialization, measurable, verifiable, static.

---
