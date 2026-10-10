## Exercises

Six labs at increasing depth. Each lab is sized for an evening to a weekend of work for an engineer with a development board on the bench. The hardware suggestions are common parts, substitute equivalents as needed.

### Lab 1: Type-Safe Register Library

**Goal**: Build a header-only C++20 library that wraps memory-mapped registers with compile-time type safety.

**Hardware**: STM32F411 Nucleo or any Cortex-M4 board.

**Tasks**:

1. Define `Mmio<Addr, T>` and `Field<Addr, Pos, Width>` templates similar to the chapter example.
2. Add a `WriteOnlyField` variant that has no `read()` or `modify()` so the type system rejects read-modify-write on write-only registers.
3. Define an enum for GPIO pin modes (input, output, alternate function, analog) and a `ModeField` template that takes the enum as the value type, so writing a non-enumerator becomes a compile error.
4. Wrap the GPIO peripheral. Implement a `blink_pa5()` function using your wrappers. Verify that the generated assembly is identical (or smaller) than the equivalent CMSIS C version.
5. Bonus: add a `constexpr` validation that catches an out-of-range value at compile time, e.g. `Field<Addr, Pos, 2>::set<5>()` should not compile because 5 does not fit in 2 bits.

**Success criteria**: The blinker runs at the expected rate, the disassembly shows two `STR` instructions for the pin configuration with no extra overhead, and any attempt to write a wrong-sized value to a field is rejected by the compiler with a clear error message.

### Lab 2: Tickless FreeRTOS Power Profile

**Goal**: Measure and minimize current consumption on a battery-powered FreeRTOS application.

**Hardware**: Nordic nRF52840 DK, Nordic Power Profiler Kit II (PPK2) or Otii Arc Pro, a CR2032 coin cell.

**Tasks**:

1. Build a baseline FreeRTOS application with one task that samples a sensor every 1 second and goes to `vTaskDelay(1000)`.
2. Measure average current with the PPK2. Expected: 2-5 mA depending on Wi-Fi/BLE configuration, dominated by the 1 kHz tick.
3. Enable `configUSE_TICKLESS_IDLE` and implement `vPortSuppressTicksAndSleep` using the nRF52840's RTC2 to schedule the wakeup and entry into System ON Idle.
4. Re-measure. Expect 5-50 microamps depending on retention configuration.
5. Add a BLE advertisement every 60 seconds using the SoftDevice or the Zephyr Bluetooth stack. Re-measure.
6. Compute battery life on a CR2032 (220 mAh). Target: more than 2 years.

**Success criteria**: documented current trace showing deep sleep below 5 microamps, sample current spikes at 1-second intervals, BLE advertisement spikes at 60-second intervals, average current matching battery life calculation.

### Lab 3: CAN Bus Driver with ISO-TP

**Goal**: Implement a CAN driver and a layered ISO-TP transport.

**Hardware**: Two STM32F4 boards with CAN transceivers (e.g. SN65HVD230) connected over a 60-ohm twisted pair, or one STM32 board plus a USB-CAN adapter as the partner.

**Tasks**:

1. Implement a `CanBus` class that exposes `send(CanFrame)`, `receive(CanFrame, timeout)`, and exposes error counters and bus-off detection. Use the bxCAN or FDCAN peripheral with interrupt-driven RX into a queue.
2. Implement bus-off recovery. Inject a fault by shorting the CAN_H and CAN_L lines briefly, observe TEC climbing past 255, the controller entering bus-off, and your driver auto-recovering after a quiet bus interval.
3. Build the ISO-TP layer on top: `send_iso_tp(span<uint8_t>)` for outgoing fragmentation and `receive_iso_tp(span<uint8_t>)` for incoming reassembly, supporting Single Frame, First Frame, Consecutive Frame, and Flow Control.
4. Connect a commercial scan tool or a Vector CANalyzer and verify that the ISO-TP framing matches ISO 15765-2 byte-for-byte.
5. Bonus: implement a UDS service handler for service 0x22 (ReadDataByIdentifier) and respond with a manufacturer string.

**Success criteria**: passes a CANalyzer trace showing correct framing, recovers from bus-off, exchanges ISO-TP messages of 200+ bytes correctly with a partner.

### Lab 4: Secure Boot with MCUboot

**Goal**: Build a fully signed firmware update pipeline on a real MCU.

**Hardware**: Nordic nRF52840 DK or STM32H743 with QSPI flash.

**Tasks**:

1. Set up MCUboot with two slots in internal flash, each large enough for your application image.
2. Generate an ECDSA P-256 key pair. Burn the public key hash into OTP fuses (or flash a non-erasable region in development).
3. Build the application with a signed image trailer using `imgtool sign`.
4. Implement an OTA update path that downloads a new image over UART or BLE, writes it to the secondary slot, and triggers a reboot.
5. Verify that swap-on-reset works: the new image becomes active.
6. Verify rollback: omit the `boot_set_confirmed` call in the new image, observe MCUboot swapping back after a reboot.
7. Implement anti-rollback: add an SVN field, attempt to install a lower-SVN image and verify rejection.
8. Bonus: instrument the boot process with timing measurements. Report time spent in signature verification, slot swap, and total time from reset to application `main`.

**Success criteria**: a documented OTA pipeline, three successful update demonstrations (forward, rollback, anti-rollback rejection), and timing data.

### Lab 5: TinyML Keyword Spotting

**Goal**: Deploy a TFLite Micro model that recognizes a custom keyword on an MCU.

**Hardware**: Arduino Nano 33 BLE Sense (Cortex-M4 with onboard PDM microphone), or a STM32F746 Discovery board.

**Tasks**:

1. Use Edge Impulse or TensorFlow Lite Model Maker to train a 4-class keyword spotting model on a custom keyword (e.g. your name) plus background noise, unknown words, and silence. Quantize to int8.
2. Deploy the model to the MCU. Use `MicroMutableOpResolver` to include only the ops your model needs.
3. Implement audio capture from the microphone with double-buffered DMA.
4. Run the inference at 1 Hz. Light an LED when the keyword is detected.
5. Measure: model size in flash, tensor arena size in RAM, inference time per call.
6. Bonus: enable `CMSIS-NN` as the kernel backend and re-measure inference time. Report the speedup.

**Success criteria**: model recognizes the keyword with at least 80 percent accuracy in real environments, total RAM under 64 KB, total flash under 256 KB, inference under 50 ms.

### Lab 6: Real-Time Linux Control Loop

**Goal**: Run a 1 kHz control loop on PREEMPT_RT Linux with documented worst-case jitter.

**Hardware**: Raspberry Pi 5 or BeagleBone AI-64, or any Cortex-A board with PREEMPT_RT support.

**Tasks**:

1. Build a PREEMPT_RT kernel from a recent mainline release (6.12 LTS or later) for your target. Boot from it.
2. Write a C++ application that runs a 1 kHz loop with `SCHED_FIFO` priority 80, CPU affinity to a single isolated CPU, and `mlockall` for memory.
3. Add kernel command line options to isolate the CPU: `isolcpus=3 nohz_full=3 rcu_nocbs=3`.
4. The loop reads a GPIO input, applies a trivial PID computation, and sets a GPIO output. Use the Linux GPIO character device API (`/dev/gpiochip0`).
5. Measure jitter using `cyclictest` running concurrently for 1 hour with a load on the non-isolated CPUs (`stress-ng`).
6. Document the worst-case jitter and the maximum loop period observed.
7. Add a hardware watchdog using `/dev/watchdog`.
8. Bonus: implement a Modbus TCP server in a normal-priority thread. Verify that the real-time loop's jitter is unaffected by Modbus traffic.

**Success criteria**: cyclictest shows max jitter under 100 microseconds for one hour, watchdog is functional, control loop maintains its period under simulated load.

---
