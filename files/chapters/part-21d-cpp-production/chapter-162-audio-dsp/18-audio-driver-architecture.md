## Audio Driver Architecture

The audio callback your code receives is the top of a stack that runs from your application down through the operating system into the kernel, across the USB or PCIe bus, and out to a digital-to-analog converter. The senior engineer working on professional audio software needs to understand what happens below the API, where latency comes from, and which part of the stack is responsible for which kind of failure.

### The Latency Budget

A complete capture-to-playback path on a modern machine has six contributors to latency:

1. **ADC group delay.** A typical sigma-delta converter has 0.5 to 1.5 ms of group delay from its decimation filter.
2. **USB / Thunderbolt packetization.** USB Audio Class 2 transmits in 125us microframes (USB 2.0 high speed). The interface accumulates one or more microframes before the transaction completes.
3. **Driver buffer.** The OS-side driver hands buffers between the kernel and the ring buffer that user-space reads.
4. **Application buffer.** Your callback's block size translates into a buffer's worth of latency.
5. **Plugin lookahead.** Each plugin in the chain may add lookahead (oversampling halfband filters, transient detectors). Properly behaved plugins report latency to the host for ADC.
6. **DAC group delay.** Same as ADC, 0.5 to 1.5 ms.

A 64-sample buffer at 48 kHz gives 1.33 ms of application buffer latency. Add ADC + DAC + USB + driver and a typical Apogee or RME interface measures 3-5 ms round trip. JACK on Linux with a real-time kernel and a direct PCIe interface can hit 1.5 ms round trip in expert hands.

### CoreAudio HAL

Apple's Core Audio is structured in layers:

- **Hardware Abstraction Layer (HAL).** A C API for managing audio devices. `AudioObjectGetPropertyData`, `AudioDeviceCreateIOProcID`. Lives in `CoreAudio.framework`.
- **AudioUnit.** Higher-level processing units (Apple-supplied and third-party).
- **AVAudioEngine.** Swift / Objective-C node graph, built on AudioUnit.

For lowest-latency apps (Logic, Pro Tools), the HAL is the entry point. You request a device, set its buffer size with `kAudioDevicePropertyBufferFrameSize`, and install an IOProc:

```cpp
AudioDeviceIOProcID procID;
AudioDeviceCreateIOProcID(deviceID, ioProc, this, &procID);
AudioDeviceStart(deviceID, procID);
```

The IOProc runs on a real-time thread created by Core Audio. Below the HAL, Core Audio talks to the kernel via `kAudioServerPlugIn` (the modern user-space plugin API for audio drivers, replacing the older kernel-resident IOAudioFamily). Aggregate devices, virtual devices like BlackHole, Rogue Amoeba's loopback driver, and SoundFlower all implement the user-space plugin API.

### ASIO Driver Internals

On Windows, ASIO drivers (Steinberg's API, vendor implementations) bypass the kernel-mode Windows audio stack entirely. The driver is delivered as a user-mode DLL plus a small kernel-mode component that talks directly to the hardware.

The DLL exposes the `IASIO` COM interface. The audio buffer pointers it hands to your `bufferSwitch` callback may be DMA buffers shared with the hardware, or they may be intermediate user-space buffers that the kernel-mode driver copies to/from DMA. RME's MADIface drivers, for example, provide direct DMA access, cheaper ASIO drivers (FlexASIO, ASIO4ALL) wrap WDM with double-buffering and have higher latency.

ASIO4ALL is a free wrapper that exposes any WDM driver as ASIO. It does not lower latency below WDM's floor, but it gives an ASIO API to applications that demand it.

### WASAPI

WASAPI is the modern Windows audio API (Vista+). Two modes:

- **Shared mode** routes through the Windows audio engine, which mixes all running apps. Default buffer is 10ms, reducible to about 3ms on Windows 10 1709+ and 1ms on Windows 11 24H2 with proper drivers.
- **Exclusive mode** bypasses the engine. The application owns the device. Buffer sizes go down to about 1.5ms with capable drivers.

WASAPI is event-driven. The driver signals an event handle when a buffer slot is available. Below the API:

- The Windows Audio Engine runs in `audiodg.exe` (Audio Device Graph isolation).
- The engine talks to the WDM/KS driver stack.
- The driver allocates DMA buffers in physical memory the device can reach.
- The kernel scheduler grants real-time priority to threads marked with MMCSS (Multimedia Class Scheduler Service) "Pro Audio" task.

Without MMCSS, your audio thread runs at normal priority and Windows will preempt it for system work. With MMCSS, Windows guarantees the thread a percentage of CPU time bounded by the OS's QoS for that task class.

```cpp
DWORD taskIndex = 0;
HANDLE mmcss = AvSetMmThreadCharacteristics(L"Pro Audio", &taskIndex);
AvSetMmThreadPriority(mmcss, AVRT_PRIORITY_CRITICAL);
```

### ALSA and PipeWire

On Linux, ALSA is the kernel audio API. Drivers live in the kernel as `snd-*` modules. User-space talks to ALSA via `libasound`:

```cpp
snd_pcm_t* handle;
snd_pcm_open(&handle, "default", SND_PCM_STREAM_PLAYBACK, 0);
snd_pcm_hw_params_t* hw;
snd_pcm_hw_params_alloca(&hw);
snd_pcm_hw_params_any(handle, hw);
snd_pcm_hw_params_set_access(handle, hw, SND_PCM_ACCESS_RW_INTERLEAVED);
snd_pcm_hw_params_set_format(handle, hw, SND_PCM_FORMAT_FLOAT_LE);
snd_pcm_hw_params_set_rate(handle, hw, 48000, 0);
snd_pcm_hw_params_set_channels(handle, hw, 2);
snd_pcm_hw_params(handle, hw);
```

For decades, PulseAudio sat above ALSA for desktop apps and JACK sat alongside ALSA for pro audio, with no easy way to mix the two. PipeWire (2018+, default on Fedora since 34, on Ubuntu 22.10+) replaces both with a single graph-based audio server that speaks JACK's protocol on the JACK socket and PulseAudio's protocol on the PulseAudio socket. As of 2026, PipeWire is the default Linux audio server.

PipeWire uses a single graph thread that processes all clients in dependency order, with shared-memory buffers between clients to avoid copies. Clients can choose their own block size, the server picks an LCM-style schedule. Latencies competitive with JACK are achievable.

### USB Audio Class 2 and 3

USB Audio Class 2.0 (UAC2) is the standard interface for almost every USB audio device made since 2010. It supports up to 384 kHz, up to 32-bit, and up to 32 channels. UAC3 (2018) adds a power-saving mode and a few profile improvements but most devices remain UAC2.

The UAC2 transmission model:

- Isochronous transfers in 125us microframes (USB 2.0 HS) or 1ms frames (USB 1.1 FS).
- Two endpoints per direction: data and feedback. The feedback endpoint reports the device's actual sample rate so the host can adjust packet sizes.
- "Asynchronous" mode (the device clock is master, host adapts), "synchronous" mode (host clock master, device adapts), "adaptive" mode (host slaves to its own clock, device fills in).

For low jitter, asynchronous mode is preferred and is what serious audio interfaces use. The host computer's USB scheduling jitter does not propagate to the DAC clock.

### Thunderbolt Audio

Thunderbolt 3 and 4 expose a PCIe tunnel and DisplayPort over a USB-C connector. Thunderbolt audio interfaces use the PCIe tunnel for direct DMA access to system memory, achieving lower latency than USB. UAD's Apollo, RME's Babyface Pro and UFX, and Universal Audio Volt are common Thunderbolt interfaces.

Latency advantage over USB is real but smaller than marketing suggests: typically 0.5-1 ms improvement at the same buffer size.

### Ring Buffer Between Kernel and Userspace

Between the driver and your application is a ring buffer. The driver writes captured samples to it, your callback reads. Your callback writes playback samples, the driver reads. The driver and userspace run on different scheduler classes (kernel-real-time and user-real-time) and need a synchronization primitive.

ALSA mmap mode and CoreAudio's HAL both expose the ring directly: your callback writes into a memory region that the driver subsequently DMAs to the device, no copy needed. This is the fastest path. For high-latency or sandboxed environments (PulseAudio, Web Audio in browsers), an extra copy through a server-side ring buffer is added.

### Latency vs Stability

Lowering the buffer size lowers latency and raises the chance of an xrun (buffer underrun, called "click" or "dropout" by users). The xrun rate is bounded below by:

- The variance of the OS scheduler.
- The variance of the audio processing CPU cost (worst-case versus average).
- The interrupt latency (how long after the device requests the buffer the OS notices).

A well-tuned Mac running CoreAudio on Apple silicon can sustain 64 samples at 48 kHz with no xruns under typical load. A Windows machine without MMCSS configured will xrun at 256 samples on the same load.

### Diagnostic Tools

For driver-level debugging:

- **macOS:** `Console.app` filtered to `coreaudiod`, the Apple Audio Hardware Test app, `samplerate -t` for HAL inspection.
- **Windows:** LatencyMon (the standard tool, measures DPC and ISR latencies), Resplendence's WhySoSlow, Windows Performance Analyzer.
- **Linux:** `cyclictest` for kernel real-time latency, `cset` for CPU isolation, `htop -t` for thread priorities, JACK's `jackd -v` for graph timings.

When a customer reports "clicks and pops in our DAW," the first diagnostic step is always to capture latency data with the platform tool. The cause is rarely the application, it is usually a driver, a USB hub, or a misconfigured kernel.

---
