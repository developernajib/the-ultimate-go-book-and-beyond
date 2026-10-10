## Exercises

These exercises build real embedded C++ components. Compile and run exercises 1-3 on your host machine (no hardware required). Exercises 4 and 5 require an ARM toolchain and either a hardware target or a cycle-accurate simulator such as QEMU or Renode.

---

### Exercise 1: Fixed-Capacity Ring Buffer Without Heap

Implement a generic, fixed-capacity ring buffer that can be used as the communication channel between an ISR and a main thread. The buffer must:

- Compile-time capacity (template parameter)
- Capacity must be a power of two (enforced with `static_assert`)
- `push(const T&)` returns `bool`, returns `false` when full, never blocks
- `pop(T&)` returns `bool`, returns `false` when empty, never blocks
- No heap allocation anywhere
- Thread/interrupt safe for single-producer single-consumer using `std::atomic`
- `size()` returns current number of elements
- `empty()` and `full()` predicates

Write the implementation, then write at least four test cases:
1. Push until full, verify `push` returns `false` on the next call
2. Pop on empty buffer returns `false`
3. Push 8 items, pop all 8, verify order and values
4. Wrap-around: push N-1 items, pop N/2, push N/2 more, verify correct values throughout

Test without an RTOS: simulate ISR behavior by directly calling `push` from one function and `pop` from another in sequence.

---

### Exercise 2: PID Controller in Q16.16 Fixed-Point

Implement a complete PID controller using Q16.16 fixed-point arithmetic (`Fixed<int32_t, 16>` from section 6). Requirements:

- Uses only integer arithmetic, no `float` or `double` anywhere in the control path
- Saturation on integral accumulator (anti-windup): the integral term must be clamped to `[output_min, output_max]` before accumulation
- Output clamped to configurable `[output_min, output_max]`
- `reset()` method clears integral and derivative state
- `update(setpoint, measured)` takes Q16.16 inputs, returns Q16.16 output

Write test cases for:
1. Proportional only (Ki=0, Kd=0): error of 1.0 with Kp=2.0 should produce output of 2.0
2. Integral windup prevention: constant error should not cause output to exceed max
3. Derivative kick: step change in setpoint produces bounded derivative term
4. Negative error: output drives in the correct direction
5. `reset()` clears state: after reset, a fresh `update` should behave identically to the first call

Convert final output to float for test assertion: `output.to_float()` should be within 0.01 of expected float value.

---

### Exercise 3: HAL LED Driver Testable on Host

Design and implement an LED driver using the CRTP HAL pattern that:

- Defines a `GpioBase<Derived>` CRTP base with `set_high()`, `set_low()`, `toggle()`, `read()` methods
- Provides a `MockGpio` implementation for host testing that stores state internally
- Implements an `LedDriver<TGpio>` class that owns a GPIO reference and provides:
  - `turn_on()`, `turn_off()`, `toggle()`
  - `blink(uint32_t times)`: toggle the LED N times (no actual delay, call a `delay_ms` function pointer passed at construction)
  - `is_on() const`: returns current LED state

Write unit tests (without a test framework, use `assert`) that:
1. `turn_on()` causes `MockGpio::read()` to return `true`
2. `turn_off()` causes `MockGpio::read()` to return `false`
3. `toggle()` three times on an off LED: ends with LED on
4. `blink(4)` calls the delay function exactly 8 times (4 toggles, 2 calls per toggle)
5. `is_on()` returns consistent results without calling `read()` on the underlying GPIO (i.e., the driver caches state)

The test must compile and run with `g++ -std=c++17 -o test_led test_led.cpp && ./test_led`.

---

### Exercise 4: UART ISR with Lock-Free Buffer Handoff

On a hardware target (or QEMU STM32F4 emulation), implement a complete UART receive system:

**ISR side:** `USART2_IRQHandler()` receives one byte at a time (RXNE interrupt) and pushes it to the SPSC ring buffer from Exercise 1, instantiated as `SpscRingBuffer<uint8_t, 256>`.

**Main thread side:** A `UartLineReader` class that:
- Holds a reference to the ring buffer
- `poll()` method: drains available bytes from the ring buffer, accumulating into a fixed-size line buffer (`char line_buf[128]`)
- Returns a `bool` indicating whether a complete line (`'\n'` terminated) was received
- `get_line(char* out, size_t max)`: copies the current complete line into `out`
- Handles buffer overflow: if line exceeds 128 bytes, reset the accumulator and discard

**Integration test:** Use a logic analyzer or UART echo mode to verify:
1. Sending "hello\n" over USART2 is received completely and correctly
2. Sending 200 bytes without newlines does not crash the system (overflow handled)
3. Sending 10 lines at 115200 baud back-to-back, all lines received without loss

Document the WCET of the ISR by measuring cycles with DWT as shown in section 3.

---

### Exercise 5: Stack Usage Analysis for a Call Chain

Given the following (intentionally complex) call chain, use the GCC `-fstack-usage` flag to determine the maximum stack depth consumed by a call to `top_level_function()`:

```cpp
struct Config { uint8_t data[64]; uint32_t checksum; };
struct Result { int32_t values[16]; bool valid; };

Result process_config(const Config& cfg);
int32_t validate_checksum(const uint8_t* data, size_t len);
bool    apply_calibration(int32_t* values, size_t count, int32_t offset);
Result  top_level_function(const Config& cfg);
```

Tasks:
1. Implement stub versions of all four functions with realistic local variable allocations (arrays, structs) totalling approximately 200 bytes across the call chain
2. Compile with `arm-none-eabi-g++ -mcpu=cortex-m4 -mthumb -Os -fstack-usage -c exercise5.cpp`
3. Read the generated `.su` file and sum the stack usage across the call chain
4. Add `static_assert`-style build-time verification that total stack depth is within a 512-byte budget
5. Identify which function contributes the most stack usage and refactor it to reduce by at least 50% (hint: move large local arrays to `static` storage if they are not re-entrant)

Report: the original maximum stack depth, the refactored stack depth, and why the `static` refactoring is only safe for non-reentrant call paths.

---
