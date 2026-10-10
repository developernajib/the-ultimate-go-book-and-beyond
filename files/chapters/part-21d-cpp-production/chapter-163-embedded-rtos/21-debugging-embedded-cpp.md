## Debugging Embedded C++

Debugging firmware is harder than debugging applications. The bug may surface only on real hardware, only with a specific peripheral configuration, only when an interrupt fires at a specific point in a function, only after the part has been running for hours. The tools are different from desktop C++ debugging and the techniques are specific to embedded.

### JTAG and SWD

JTAG (Joint Test Action Group) is the original 4-wire debug interface (TCK, TMS, TDI, TDO). SWD (Serial Wire Debug) is the 2-wire variant Arm introduced for Cortex-M. Modern Cortex-M parts support both. SWD is preferred because it uses fewer pins and gives access to the Trace Port.

The debug probe (J-Link, ST-Link, CMSIS-DAP, FTDI-based) connects via USB to the host and via JTAG/SWD to the target. The probe runs commands on behalf of the host: read memory, write memory, set breakpoint, halt CPU, resume CPU. The probe firmware translates host requests into low-level JTAG/SWD transactions.

### OpenOCD

OpenOCD is the open-source debug server. It speaks JTAG/SWD on the back end and presents a GDB remote serial protocol on the front end. The standard workflow:

```
openocd -f interface/stlink.cfg -f target/stm32f4x.cfg
```

OpenOCD listens on TCP 3333. GDB connects:

```
arm-none-eabi-gdb app.elf
(gdb) target extended-remote localhost:3333
(gdb) load
(gdb) monitor reset halt
(gdb) break main
(gdb) continue
```

The `monitor` prefix sends a command to OpenOCD itself. `monitor reset halt` resets the target and stops at the reset handler, which is the canonical way to start a debug session.

OpenOCD has a TCL-based scripting language. Production debug scripts often automate flash writing, register access, and post-mortem dumps:

```tcl
proc dump_state {} {
    halt
    set msp [reg msp]
    set lr [reg lr]
    set pc [reg pc]
    puts "PC=$pc LR=$lr MSP=$msp"
    mdw 0xE000ED28 8           ;# CFSR, HFSR, DFSR, MMAR, BFAR
    mdw $msp 32                ;# stack from MSP
    resume
}
```

### J-Link and Segger SystemView

Segger's J-Link is the commercial debug probe most engineers prefer. It is faster than OpenOCD for flash programming, supports more targets, and integrates with Segger's higher-level tools:

- **J-Link Commander**: command-line interface to the probe
- **Ozone**: Segger's GUI debugger, an alternative to GDB
- **SystemView**: real-time event tracing with kernel-aware visualization
- **RTT (Real-Time Transfer)**: high-bandwidth printf alternative without the overhead of UART

SystemView records every RTOS event (task switch, ISR entry/exit, semaphore give/take) with microsecond timestamps. The tool then displays a Gantt-chart-like view of task execution. Pinpointing priority inversions, missed deadlines, and unexpected ISR latencies takes minutes instead of days.

```cpp
#include "SEGGER_SYSVIEW.h"

int main() {
    SEGGER_SYSVIEW_Conf();
    SEGGER_SYSVIEW_Start();
    // FreeRTOS or Zephyr automatically logs task events
    // Application can log custom events:
    SEGGER_SYSVIEW_RecordU32(33, sensor_value);
    return 0;
}
```

The instrumentation overhead is roughly 1-2 microseconds per event. On a 100 MHz Cortex-M4, that is 0.1 percent CPU at 1 kHz event rate, well within acceptable.

### ITM Trace

The Instrumentation Trace Macrocell on Cortex-M3/M4/M7/M33 lets the CPU send up to 32 channels of data to the debug probe through the SWO pin (single wire trace output). It is the embedded equivalent of `printf` to the debugger console, but without the latency of a UART.

```cpp
class ItmStream {
    static constexpr std::uintptr_t ITM_BASE = 0xE0000000;
public:
    static void putc(int channel, char c) {
        auto* port = reinterpret_cast<volatile std::uint32_t*>(ITM_BASE + 4 * channel);
        while (*port == 0) {}
        *port = static_cast<std::uint32_t>(c);
    }
    static void puts(int channel, std::string_view s) {
        for (char c : s) putc(channel, c);
    }
};

#define LOG_INFO(msg) ItmStream::puts(0, msg)
```

OpenOCD captures the SWO output and writes it to a file. J-Link's tooling displays it live.

### ETM Trace

The Embedded Trace Macrocell records every instruction executed, with timing. ETM trace is the gold standard for performance debugging because it lets you see exactly which path the CPU took, including branch outcomes and interrupt points. The cost is hardware: ETM requires a more capable debug probe (J-Trace, Lauterbach TRACE32) and a wider trace port (TPIU with 4-pin parallel).

ETM is the tool that catches "the function ran in 50 microseconds 99.9 percent of the time but spiked to 200 microseconds once an hour." Without ETM, finding the culprit is nearly impossible. With ETM, you scroll through the trace at the suspicious time stamp and see exactly which branch fired and why.

### Hard Fault Unwinding

When a Cortex-M part takes a hard fault, the architecture pushes 8 registers onto the active stack: R0, R1, R2, R3, R12, LR, PC, xPSR. The fault handler can inspect them to identify what the CPU was doing when the fault occurred.

```cpp
struct StackedRegs {
    std::uint32_t r0, r1, r2, r3, r12, lr, pc, xpsr;
};

extern "C" __attribute__((naked))
void HardFault_Handler() {
    asm volatile (
        "tst lr, #4              \n"  // EXC_RETURN bit 2
        "ite eq                  \n"
        "mrseq r0, msp           \n"
        "mrsne r0, psp           \n"
        "b hard_fault_handler_c  \n"
    );
}

extern "C" void hard_fault_handler_c(StackedRegs* regs) {
    std::uint32_t cfsr = SCB->CFSR;
    std::uint32_t hfsr = SCB->HFSR;
    std::uint32_t mmar = SCB->MMFAR;
    std::uint32_t bfar = SCB->BFAR;

    log_critical("HARD FAULT");
    log_critical("PC=%08x LR=%08x", regs->pc, regs->lr);
    log_critical("CFSR=%08x HFSR=%08x", cfsr, hfsr);
    log_critical("MMAR=%08x BFAR=%08x", mmar, bfar);

    // Enter infinite loop in debugger, otherwise reset
    if (CoreDebug->DHCSR & CoreDebug_DHCSR_C_DEBUGEN_Msk) {
        asm volatile("bkpt #0");
    }
    NVIC_SystemReset();
}
```

The Configurable Fault Status Register (CFSR) tells you the category: stacking fault, unstacking fault, instruction access fault, data access fault, divide-by-zero, undefined instruction, unaligned access. The MMFAR and BFAR contain the address that caused a memory or bus fault, when the IBUSERR/PRECISERR/BFARVALID bits are set.

A common bug: a precise bus fault with PC pointing into a function that dereferenced a stale pointer. The PC tells you the line, the BFAR tells you the bad address, and you have a starting point. A common bug: an imprecise bus fault where BFAR is invalid because the actual bus error happened cycles before the fault was reported. Then you need ETM trace.

### Post-Mortem from RAM Dump

When a fault is detected, the firmware copies the full RAM contents to a non-volatile region (a backup SRAM, an external EEPROM, or a reserved sector of internal flash). On the next boot, the firmware reports the dump to the cloud or holds it for engineering retrieval.

The dump format is typically:

```cpp
struct CrashHeader {
    std::uint32_t magic;
    std::uint32_t version;
    std::uint32_t fw_version;
    std::uint32_t cfsr;
    std::uint32_t hfsr;
    std::uint32_t mmar;
    std::uint32_t bfar;
    StackedRegs   regs;
    std::uint32_t ram_offset;
    std::uint32_t ram_size;
    // followed by ram_size bytes of RAM
};
```

On the engineering side, GDB can load the ELF and the RAM dump together:

```
arm-none-eabi-gdb app.elf
(gdb) target sim
(gdb) restore crashdump.bin binary 0x20000000
(gdb) set $pc = <pc from header>
(gdb) set $sp = <msp from header>
(gdb) bt full
```

The backtrace reveals the call chain at the time of the crash. With the matching ELF, you see line numbers, local variables, and source code. This is the technique Apple, Tesla, and SpaceX use to diagnose field failures: the device collects a dump, uploads it, and the engineering team reproduces the crash offline.

### Live Variable Inspection

For long-running issues that do not crash, debug probes can read memory while the target is running. OpenOCD's `mdw` command (memory display word) reads any address. J-Link Commander has the same functionality. SystemView shows them updating in real time.

A common pattern is to declare instrumentation variables that the application updates and the debug tool watches:

```cpp
struct DebugCounters {
    std::atomic<std::uint32_t> can_tx_count;
    std::atomic<std::uint32_t> can_rx_count;
    std::atomic<std::uint32_t> dma_completes;
    std::atomic<std::uint32_t> task_overruns;
    std::uint32_t worst_case_latency_us;
};

// Place at fixed address for easy debugger inspection
__attribute__((section(".debug_counters"), used))
DebugCounters g_dbg{};
```

The linker script puts `.debug_counters` at a known fixed address. The debugger reads them without halting the CPU. Field engineers diagnose performance issues by watching the counters tick.

---
