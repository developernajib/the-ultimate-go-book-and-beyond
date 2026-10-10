## Low-Latency Tuning

Once the code follows the realtime rules and the algorithms are sound, the next bottleneck is the OS. The audio thread runs on a scheduler that decides when to run it, on what CPU core, with what priority, and whether to preempt it for kernel work. Tuning these decisions is the difference between 64-sample buffers that hold and 64-sample buffers that drop out.

### Sample Math, Restated

A buffer of `B` samples at sample rate `Fs` covers `B / Fs` seconds. The audio thread must produce that buffer's output before the buffer is needed. For an input-output round-trip, the latency is approximately `2 * B / Fs` plus the driver and ADC/DAC contributions.

```
B = 64,   Fs = 48000  -> 1.33 ms per buffer, ~3-5 ms RTT typical
B = 128,  Fs = 48000  -> 2.67 ms, ~6-8 ms RTT
B = 256,  Fs = 48000  -> 5.33 ms, ~10-13 ms RTT
B = 512,  Fs = 48000  -> 10.67 ms, ~22 ms RTT
B = 1024, Fs = 48000  -> 21.33 ms, ~45 ms RTT
```

For tracking with monitoring through plugins, sub-10 ms RTT is the threshold below which musicians stop noticing the delay. For mixing (no live monitoring), 256-512 samples is fine.

### Detecting Xruns

An xrun is the driver finding that the buffer is not ready when it needs to consume it. Detection:

- **CoreAudio:** check `kAudioDeviceProcessorOverload` notifications. Set a property listener.
- **ASIO:** the driver may call `bufferSwitchTimeInfo` with a flag, or simply produce silence on the next iteration. Some drivers expose a counter via vendor SDKs.
- **WASAPI:** `IAudioClient::GetCurrentPadding` returning the full buffer size means we are too late.
- **JACK / PipeWire:** `jack_get_xrun_delayed_usecs` or the equivalent PipeWire stats.

A counter incremented from a non-realtime thread when notifications arrive, exposed as a metric, is the standard production approach. Production audio software at Apple, Avid, and Native Instruments all instrument xrun counters and ship them in support diagnostics.

### Real-Time Priority on Linux

The Linux scheduler has multiple policies:

- `SCHED_OTHER` (default), the standard time-sharing scheduler.
- `SCHED_FIFO`, real-time first-in-first-out, runs until it blocks or is preempted by higher priority.
- `SCHED_RR`, real-time round-robin.
- `SCHED_DEADLINE` (3.14+), earliest-deadline-first with budget enforcement.

For audio, `SCHED_FIFO` at priority 70-80 is the standard:

```cpp
#include <pthread.h>
#include <sched.h>

void setRealtimePriority(pthread_t thread, int priority) {
    sched_param param{};
    param.sched_priority = priority;
    pthread_setschedparam(thread, SCHED_FIFO, &param);
}
```

Without `CAP_SYS_NICE` capability or rt-prio limits in `/etc/security/limits.conf`, this fails. PipeWire and JACK install themselves with capabilities or wrap the priority setting via PolicyKit. For a custom DAW, the user-facing setup typically asks the user to add their account to the `audio` group and adjust `limits.conf`.

The PREEMPT_RT kernel patch (mainlined in 6.12 in late 2024) lets the kernel preempt almost everywhere, dropping worst-case latency from milliseconds to tens of microseconds. Pro audio Linux distributions (UbuntuStudio, AVLinux) ship with PREEMPT_RT kernels.

### CPU Isolation

Even with SCHED_FIFO, the kernel can preempt the audio thread for IRQs. Pin the audio thread to a CPU and route IRQs away from that CPU:

```bash
# Boot parameters
isolcpus=2,3 nohz_full=2,3 rcu_nocbs=2,3
```

This dedicates cores 2 and 3 to audio. The Linux kernel does not schedule timer ticks on them and does not run RCU callbacks on them. Then pin the audio thread:

```cpp
cpu_set_t cpuset;
CPU_ZERO(&cpuset);
CPU_SET(2, &cpuset);
pthread_setaffinity_np(thread, sizeof(cpuset), &cpuset);
```

For embedded audio products (smart speakers, hearing aids, in-ear monitors), this kind of CPU partitioning is standard practice.

### Apple QoS and Time-Constraint

macOS and iOS use a different model. The threading API is `pthread`, but priority is conveyed via QoS classes plus a separate "time-constraint" policy for audio:

```cpp
#include <pthread.h>
#include <mach/thread_act.h>
#include <mach/thread_policy.h>

void setAppleAudioThread(pthread_t thread, double sampleRate, int blockSize) {
    thread_time_constraint_policy_data_t policy;
    mach_timebase_info_data_t info;
    mach_timebase_info(&info);

    uint64_t period_ns = static_cast<uint64_t>(1e9 * blockSize / sampleRate);
    uint64_t period_abs = period_ns * info.denom / info.numer;

    policy.period      = static_cast<uint32_t>(period_abs);
    policy.computation = static_cast<uint32_t>(period_abs * 0.6);
    policy.constraint  = static_cast<uint32_t>(period_abs * 0.85);
    policy.preemptible = 0;

    thread_policy_set(pthread_mach_thread_np(thread),
                      THREAD_TIME_CONSTRAINT_POLICY,
                      reinterpret_cast<thread_policy_t>(&policy),
                      THREAD_TIME_CONSTRAINT_POLICY_COUNT);
}
```

`computation` is how long you expect to run, `constraint` is the deadline, `period` is the cycle. The kernel uses these to schedule the thread ahead of less time-critical work.

CoreAudio's IOProc thread is set up this way automatically. If you create your own audio worker threads (for parallel processing of plugin chains, for example), you must set the policy yourself.

For QoS on auxiliary threads (control, GUI, network):

- `QOS_CLASS_USER_INTERACTIVE` for the main message loop.
- `QOS_CLASS_USER_INITIATED` for short user-driven work.
- `QOS_CLASS_UTILITY` for background work.
- `QOS_CLASS_BACKGROUND` for low-priority maintenance.

Never use `QOS_CLASS_USER_INTERACTIVE` for the audio thread. It is not real-time enough. Use the time-constraint policy.

### Windows MMCSS

Windows uses Multimedia Class Scheduler Service:

```cpp
DWORD taskIndex = 0;
HANDLE mmcss = AvSetMmThreadCharacteristics(L"Pro Audio", &taskIndex);
AvSetMmThreadPriority(mmcss, AVRT_PRIORITY_CRITICAL);
// At thread shutdown:
AvRevertMmThreadCharacteristics(mmcss);
```

The available task names: `"Audio"`, `"Capture"`, `"DisplayPostProcessing"`, `"Distribution"`, `"Games"`, `"Playback"`, `"Pro Audio"`, `"Window Manager"`. `"Pro Audio"` is the priority class for low-latency audio.

Without MMCSS, your audio thread runs at normal user priority and Windows defragmenters, antivirus scans, and network stacks will preempt it.

### Android AAudio Performance Mode

```cpp
oboe::AudioStreamBuilder builder;
builder.setPerformanceMode(oboe::PerformanceMode::LowLatency)
       .setSharingMode(oboe::SharingMode::Exclusive)
       .setUsage(oboe::Usage::Game);
```

`Exclusive` sharing mode bypasses the Android mixer for direct device access. Not all devices support it, Oboe falls back to shared. The "Game" usage hint biases the framework toward low-latency over power saving.

Android's audio HAL latency varies wildly by device. The Pixel line and Samsung flagships hit sub-30 ms RTT. Many mid-tier devices are 60-100 ms RTT regardless of API, due to vendor HAL implementations padding buffers for stability.

### Pre-Faulting Pages

When you allocate memory at startup, the kernel does not necessarily map physical pages until the first write. The first write page-faults, which costs microseconds. To avoid faults during the audio callback, pre-fault every page at startup:

```cpp
inline void prefault(void* base, size_t bytes) noexcept {
    constexpr size_t pageSize = 4096;
    auto* p = static_cast<volatile char*>(base);
    for (size_t i = 0; i < bytes; i += pageSize) {
        p[i] = 0;
    }
}
```

For very large allocations, also call `mlock` (Linux) or `VirtualLock` (Windows) to pin the pages and prevent swap-out. Avoid this for multi-gigabyte allocations because it removes that memory from the global page cache and can starve other processes.

### Disabling Energy-Saving CPU States

Modern CPUs enter low-power C-states when idle, and waking from C6/C7 takes microseconds. For aggressive low-latency setups, disable deep C-states:

- **Linux:** `intel_idle.max_cstate=1` boot parameter, or `processor.max_cstate=1` for AMD.
- **macOS:** `pmset -a sleep 0 disksleep 0` and limit deep sleep, but Apple silicon's energy core / performance core split makes this less of an issue.
- **Windows:** Power profile "High performance" sets minimum processor state to 100%.

Trade-off: thermal headroom drops, fans run more often. For a recording studio workstation that is plugged in, fine. For a laptop on battery, no.

### Disabling Frequency Scaling

CPU frequency scaling (P-states) introduces latency when the OS decides to ramp from a lower frequency to a higher one. For a deterministic audio thread, pin the CPU to its maximum frequency:

- **Linux:** `cpupower frequency-set -g performance` or write to `/sys/devices/system/cpu/cpu*/cpufreq/scaling_governor`.
- **Windows:** Power profile "High performance".
- **macOS:** Apple silicon manages this automatically and the user has limited control.

### Real-World Setup Checklist

For a low-latency Linux DAW workstation:

```bash
# Add user to audio group
sudo usermod -aG audio $USER

# Install rtkit and configure rtprio limits
echo "@audio - rtprio 95" | sudo tee -a /etc/security/limits.d/audio.conf
echo "@audio - memlock unlimited" | sudo tee -a /etc/security/limits.d/audio.conf

# CPU governor
sudo cpupower frequency-set -g performance

# Boot parameters in /etc/default/grub
GRUB_CMDLINE_LINUX="threadirqs preempt=full nohz=on isolcpus=2,3"
```

For a Windows DAW workstation:

- Power plan: High Performance (or "Ultimate Performance" hidden plan).
- Disable USB selective suspend.
- Disable CPU parking.
- Pin audio interface IRQ to a non-zero CPU (LatencyMon will identify which one matters).
- Disable Windows Defender real-time scanning on plugin folders.

For a macOS DAW workstation:

- Disable Spotlight on audio drives (`mdutil -i off`).
- Disable Time Machine on the audio drive.
- Increase the buffer size of the secondary device when not used.
- Sometimes: aggregate device with the audio interface as clock master.

These are the kinds of platform-level tuning the senior audio engineer at any DAW vendor knows by heart and ships in customer support documentation.

---
