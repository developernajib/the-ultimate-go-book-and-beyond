## Low Power and Tickless RTOS

A wireless sensor running on a CR2032 coin cell has roughly 220 milliamp-hours of energy. If the firmware draws 1 mA average, the cell lasts 220 hours, about 9 days. If the firmware draws 10 microamps average, the same cell lasts 22000 hours, about 2.5 years. The difference between 9 days and 2.5 years is firmware engineering. The hardware is the same.

This chapter is about the techniques that make 2.5 years achievable.

### Sleep Modes on Cortex-M

Most Cortex-M parts have several power states with progressively lower current and progressively longer wakeup latency:

**Run.** Core is clocked, executing instructions. Tens of mA on a typical Cortex-M4 at 80 MHz.

**Sleep.** Core clock gated. Peripherals continue. Wakes on any interrupt in 1-2 cycles. A few mA.

**Deep sleep / Stop.** Core clock and most peripheral clocks gated. RAM retained. Wakes on selected interrupts (RTC, EXTI, BLE link layer). Microseconds to wake. Tens of microamps.

**Standby / Shutdown.** Core off, RAM lost (or partially retained on parts with backup SRAM), wakes on a few specific pins or RTC alarms. Wake latency in the millisecond range because the core has to re-run the bootloader. 1-2 microamps.

The naming differs across silicon vendors. STM32 calls them Run, Sleep, Stop, Standby, Shutdown. Nordic calls them System ON Constant Latency, System ON Low Power, System OFF. NXP, Renesas, and Silicon Labs each have their own taxonomy. The semantic categories are the same.

### RAM Retention

The deeper sleep modes typically allow you to choose which RAM banks remain powered. On a Nordic nRF52840 with 256 KB of SRAM split into 9 banks, you can retain only the banks you need (say, 32 KB of RTOS state) and let the rest power down. Each retained bank costs roughly 200 nanoamps in System ON.

The C++ side controls retention via vendor APIs:

```cpp
void configure_low_power_retention() {
    // nRF5340 example: keep only banks holding RTOS state and stack
    NRF_VMC_S->RAM[0].POWER = (1 << 0) | (1 << 1);
    for (int i = 2; i < 8; ++i) NRF_VMC_S->RAM[i].POWER = 0;
}
```

The application places frequently used data in the retained banks via section attributes:

```cpp
__attribute__((section(".retained_data")))
RtosState g_rtos_state;
```

And the linker script puts `.retained_data` in the right RAM bank.

### Wake Sources

Each sleep mode has a set of allowed wake sources. The deeper the sleep, the fewer the sources:

- **Sleep**: any interrupt
- **Deep Sleep / Stop**: RTC, EXTI lines, low-power UART, low-power timer, BLE link layer
- **Standby**: a few specific pins, RTC alarm
- **Shutdown**: power-on reset, possibly one wake pin

A battery-powered sensor that wakes once per second and sends a BLE advertisement once per minute has wake sources of: RTC for the periodic sample, BLE link layer for the radio scheduler, and EXTI for an external switch. Everything else stays disabled.

### Tickless Idle in FreeRTOS

The default FreeRTOS configuration has a 1 kHz tick. Every millisecond the core wakes, runs the scheduler, runs the idle task, and sleeps. On a battery-powered device, that 1000 wakes per second adds up to roughly 100 microamps just for the tick handler.

`configUSE_TICKLESS_IDLE 1` enables tickless mode. When the idle task runs and no other tasks are ready, FreeRTOS:

1. Computes the time until the next scheduled event (the closest task delay or timer expiry).
2. Stops the SysTick timer.
3. Programs a low-power timer to wake at that future time.
4. Calls `portSUPPRESS_TICKS_AND_SLEEP(idle_time)`, which is the port's hook to enter sleep.
5. On wake, computes how long the part actually slept and updates the tick count.

The application provides a port hook:

```cpp
extern "C" void vPortSuppressTicksAndSleep(TickType_t expected_idle) {
    // Stop SysTick
    SysTick->CTRL &= ~SysTick_CTRL_ENABLE_Msk;

    // Re-check that no work is ready (must be inside critical section)
    if (eTaskConfirmSleepModeStatus() == eAbortSleep) {
        SysTick->CTRL |= SysTick_CTRL_ENABLE_Msk;
        return;
    }

    // Program RTC for wake at expected_idle ms in the future
    rtc_program_wake(expected_idle);

    // Enter Stop mode
    SCB->SCR |= SCB_SCR_SLEEPDEEP_Msk;
    __DSB();
    __WFI();
    SCB->SCR &= ~SCB_SCR_SLEEPDEEP_Msk;

    // Compute actual sleep time
    TickType_t actual = rtc_get_elapsed();
    vTaskStepTick(actual);

    // Restart SysTick
    SysTick->CTRL |= SysTick_CTRL_ENABLE_Msk;
}
```

The savings are dramatic. A nRF52840 running a typical sensor task with 1-second periods drops from roughly 100 microamps to 5 microamps average current with tickless idle. Five-year battery life on a CR2032 becomes feasible.

### Tickless Idle in Zephyr

Zephyr has tickless mode built in via `CONFIG_TICKLESS_KERNEL=y` (default in modern releases). The kernel calls `arch_busy_wait` and `pm_state_set` from the idle thread, and the application provides a Power Management subsystem driver that maps to the silicon-specific sleep modes.

```cpp
#include <zephyr/pm/policy.h>

void do_long_work() {
    // Prevent deep sleep while we are in critical work
    pm_policy_state_lock_get(PM_STATE_SUSPEND_TO_RAM, PM_ALL_SUBSTATES);
    work_that_must_complete();
    pm_policy_state_lock_put(PM_STATE_SUSPEND_TO_RAM, PM_ALL_SUBSTATES);
}
```

The PM subsystem queries each enabled device for its current state before transitioning. A UART driver in the middle of a transmit prevents the part from entering Stop mode until the transmission completes. This is enforced through `pm_device_busy_set` and `pm_device_busy_clear` calls inside the drivers.

### BLE Coexistence

A common case: a BLE peripheral that advertises every 1 second and connects when a phone is nearby. The BLE controller runs its own time-base on a low-frequency clock (32.768 kHz crystal), schedules radio events, and wakes the core to handle the radio. The application code must stay out of the controller's way.

The controller publishes its next radio event time to the application. The application's tickless idle hook respects that time:

```cpp
TickType_t expected_sleep = expected_idle;
TickType_t ble_next = ble_controller_next_event_ticks();
TickType_t actual = std::min(expected_sleep, ble_next);
rtc_program_wake(actual);
```

If the application sleeps past the BLE event, the connection breaks. Modern BLE stacks (Nordic SoftDevice, Zephyr Bluetooth, Apache NimBLE) integrate with the RTOS PM subsystem so this coordination is automatic. The application provides a hint, the stack and PM negotiate.

### Current Consumption Budgeting

A workable approach for a battery-powered product:

1. Build the firmware with the typical workload.
2. Measure actual current with a high-precision DMM (Joulescope, Otii Arc Pro, Nordic Power Profiler Kit) for several minutes.
3. Decompose the trace into states: deep sleep at X uA, BLE advertisement at Y mA for Z ms, ADC sample at W mA for V ms.
4. Compute the time-weighted average.
5. Compare to the target. If too high, find the worst offender and optimize.

A typical decomposition for a sensor:

```
State            Current   Duration    Frequency       Charge per period
Deep sleep       2 uA      999 ms      every 1s        2 uAs
Sensor sample    3 mA      1 ms        every 1s        3 uAs
Total per second                                       5 uAs
Average current                                        5 uA
```

Then for the BLE advertisement once per minute:

```
BLE advertise    8 mA      3 ms        every 60s       24 uAs / 60s = 0.4 uA average
```

Sum: 5.4 uA average. On a 220 mAh CR2032: 220000 / 5.4 = 40700 hours = 4.6 years.

The first time you do this analysis on a real product, the answer is typically 6 months and the customer wants 5 years. Then you spend a quarter cutting current. The wins are usually:

- Sensors that should be off between samples but are not (configure power-down mode)
- A pull-up resistor on a GPIO that the sleep mode does not turn off (move to a different pin)
- A peripheral clock left on by the bootloader and never disabled (clear the enable bit before sleep)
- A flash retention bug that forces a deeper sleep mode than necessary
- A debug interface (SWD) consuming current in deep sleep (disable in production builds)

### Practical C++ Pattern

A useful RAII guard for "stay awake while I am doing work":

```cpp
class WakeLock {
public:
    WakeLock() { pm_policy_state_lock_get(PM_STATE_SUSPEND_TO_RAM, PM_ALL_SUBSTATES); }
    ~WakeLock() { pm_policy_state_lock_put(PM_STATE_SUSPEND_TO_RAM, PM_ALL_SUBSTATES); }
    WakeLock(const WakeLock&) = delete;
};

void process_request() {
    WakeLock keep_awake;
    do_complex_work();
    write_result_to_flash();
    // wake lock released, deep sleep allowed again
}
```

This pattern keeps the part out of deep sleep for exactly the duration of the work, and the lock is released even on early return. The same pattern with a manual `lock_get`/`lock_put` pair is one of the most common bug sources in low-power firmware: a forgotten `lock_put` keeps the part awake forever, draining the battery.

---
