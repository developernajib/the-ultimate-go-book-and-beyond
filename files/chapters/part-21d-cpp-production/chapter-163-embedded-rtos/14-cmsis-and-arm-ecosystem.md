## CMSIS and the Arm Ecosystem

CMSIS is the Cortex Microcontroller Software Interface Standard, Arm's vendor-neutral hardware abstraction for Cortex-M parts. Every Cortex-M chip from STMicroelectronics, NXP, Microchip, Nordic, Renesas, and Silicon Labs ships with a CMSIS-Core header that gives you the same `NVIC_EnableIRQ`, `__DMB`, `__DSB`, `__WFI` intrinsics regardless of the silicon vendor. CMSIS is the closest thing the Cortex-M world has to a portable layer.

### CMSIS Components

The standard has grown to several components, each shipped as a separate library:

**CMSIS-Core(M).** Cortex-M core register definitions, NVIC, SysTick, FPU, MPU, and intrinsics for `WFI`, `WFE`, `DSB`, `ISB`, `LDREX`/`STREX`. The foundation everyone depends on.

**CMSIS-Core(A).** Same idea for Cortex-A and Cortex-R, less universally adopted.

**CMSIS-DSP.** Optimized signal processing routines: FIR/IIR filters, FFT, vector math, matrix operations, statistical functions. Hand-tuned assembly for Cortex-M0+/M3/M4/M7/M33/M55/M85, with Helium acceleration on M55 and M85. Used in audio, motor control, sensor fusion, and biomedical signal processing.

**CMSIS-NN.** Neural network kernels: int8 matrix multiply, depthwise convolution, fully connected, pooling, softmax. Targets TensorFlow Lite Micro. Provides the inference primitives that turn a Cortex-M55 with Helium into a 1-2 GOPS inference engine.

**CMSIS-RTOS2.** The standardized RTOS API mentioned in the previous chapter.

**CMSIS-DAP.** USB protocol for debug access, used by ST-Link, J-Link, and many vendor-specific debug probes.

**CMSIS-Driver.** Standardized driver API for SPI, I2C, USART, USB, Ethernet. Less universally adopted than the core.

**CMSIS-Pack.** A packaging format for SDKs, used by Keil MDK, ARM Compiler 6, and the open-source `vcpkg` for embedded.

### CMSIS-Core Highlights

The C version is the lingua franca. The C++ wrappers are easy to write.

```cpp
#include "core_cm4.h"

// NVIC interrupt management with C++ guard
class CriticalSection {
    std::uint32_t saved_;
public:
    CriticalSection() : saved_(__get_PRIMASK()) { __disable_irq(); }
    ~CriticalSection() { __set_PRIMASK(saved_); }
    CriticalSection(const CriticalSection&) = delete;
};

void update_shared_state() {
    CriticalSection cs;
    g_shared_value = compute_new_value();
    // IRQs re-enabled on scope exit
}
```

The intrinsics like `__disable_irq` map to single-cycle inline assembly. `__DMB`, `__DSB`, `__ISB` are the data memory barrier, data synchronization barrier, and instruction synchronization barrier. They are required when:

- Setting up a new vector table (`__DSB` then `__ISB`)
- Enabling a peripheral before using it (`__DSB` between enable and access)
- Programming the MPU before relying on its protection (`__DSB` then `__ISB`)
- Updating a buffer just before triggering DMA (`__DSB` before the trigger)

### CMSIS-DSP

The DSP library is where the Cortex-M's DSP extensions earn their keep. A 1024-point FFT on a Cortex-M4 at 168 MHz runs in roughly 600 microseconds using `arm_rfft_fast_f32`. The same on a Cortex-M7 at 480 MHz with TCM placement runs in roughly 100 microseconds. On a Cortex-M55 with Helium, under 30 microseconds.

```cpp
#include "arm_math.h"

constexpr std::size_t N = 1024;
arm_rfft_fast_instance_f32 fft;
float input[N];
float output[N];

void init_fft() {
    arm_rfft_fast_init_f32(&fft, N);
}

void run_fft() {
    arm_rfft_fast_f32(&fft, input, output, 0);
    // output[0] = DC, output[1] = Nyquist, then real/imag pairs
}
```

The library is C, but the C++ wrappers commonly add type safety:

```cpp
template <std::size_t N>
class FastRealFFT {
    arm_rfft_fast_instance_f32 inst_;
public:
    FastRealFFT() {
        static_assert((N & (N-1)) == 0, "N must be power of 2");
        arm_rfft_fast_init_f32(&inst_, N);
    }
    void forward(const std::array<float, N>& in,
                 std::array<float, N>& out) {
        arm_rfft_fast_f32(&inst_,
            const_cast<float*>(in.data()), out.data(), 0);
    }
};

FastRealFFT<1024> g_fft;
```

The `const_cast` is unfortunate, the CMSIS-DSP API takes a non-const pointer for the input even though it does not modify it. Wrapping it in C++ contains the cast in one place.

### CMSIS-NN

CMSIS-NN provides quantized neural network kernels. The reference data type is int8, with int16 supported for some kernels. The library targets TensorFlow Lite Micro as the higher-level interpreter.

A typical convolution call:

```cpp
#include "arm_nnfunctions.h"

cmsis_nn_conv_params conv_params{
    .input_offset = -128,
    .output_offset = 0,
    .stride = {1, 1},
    .padding = {1, 1},
    .dilation = {1, 1},
    .activation = {-128, 127}
};

cmsis_nn_per_channel_quant_params quant_params{
    .multiplier = output_multipliers,
    .shift = output_shifts
};

cmsis_nn_dims input_dims{1, 32, 32, 3};
cmsis_nn_dims filter_dims{16, 3, 3, 3};
cmsis_nn_dims output_dims{1, 32, 32, 16};

arm_convolve_s8(
    &ctx,
    &conv_params, &quant_params,
    &input_dims, input_data,
    &filter_dims, filter_data,
    &bias_dims, bias_data,
    &output_dims, output_data
);
```

The Helium-accelerated version of the same call on a Cortex-M55 runs roughly 5x faster than the scalar version. The library detects Helium availability at compile time via the `__ARM_FEATURE_MVE` macro and selects the appropriate kernel.

### DSP Intrinsics

Cortex-M4/M7/M33 have 32-bit SIMD instructions: pack two int16 or four int8 values into a 32-bit register and operate on them in parallel. The intrinsics live in `cmsis_compiler.h` or `arm_acle.h`:

```cpp
#include "arm_acle.h"

std::uint32_t saturated_add4_int8(std::uint32_t a, std::uint32_t b) {
    return __QADD8(a, b);   // signed saturating add of 4 int8 lanes
}

std::int32_t multiply_accumulate_int16x2(
    std::int32_t acc, std::uint32_t a, std::uint32_t b) {
    return __SMLAD(a, b, acc);   // (a.lo * b.lo) + (a.hi * b.hi) + acc
}
```

These are the building blocks that CMSIS-DSP uses internally. Hand-coded inner loops with these intrinsics regularly beat the compiler's autovectorization on Cortex-M4.

### Helium (M-Profile Vector Extension)

Helium is Arm's SIMD extension for Cortex-M, introduced on Cortex-M55 and continued on Cortex-M85. It provides 128-bit vector operations on integers (8/16/32-bit) and floats (16/32-bit). Critically, Helium reuses the FPU register file, so the silicon cost is small compared to a dedicated vector unit.

A simple Helium intrinsic example:

```cpp
#include <arm_mve.h>

void scale_int16_buffer(std::int16_t* buf, std::size_t n, std::int16_t factor) {
    // Process 8 int16 elements per iteration
    while (n > 0) {
        mve_pred16_t pred = vctp16q(n);
        int16x8_t v = vld1q_z_s16(buf, pred);
        int16x8_t r = vmulq_x_s16(v, factor, pred);
        vst1q_p_s16(buf, r, pred);
        buf += 8;
        n -= 8;
    }
}
```

The `vctp16q` predicate takes the remaining length and produces a mask for the final iteration. This handles the tail without separate tail-cleanup code, an idea borrowed from SVE.

Helium is the reason Cortex-M55 is competitive with Cortex-A for TinyML inference. A keyword spotting model that runs in 50 ms on a Cortex-A7 may run in 30 ms on a Cortex-M55 at one-tenth the power, no operating system, deterministic latency.

As of 2026, Helium-equipped parts in the market include Alif Ensemble (M55), Himax WE2 (M55), Renesas RA8 series (M85), and the upcoming NXP MCX N series.

### GCC ARM Toolchain

The reference compiler for Cortex-M is GCC ARM, maintained by Arm Limited and distributed at developer.arm.com as `arm-gnu-toolchain`. The naming convention as of 2026 is `arm-none-eabi-gcc` for bare-metal, `arm-none-linux-gnueabihf-gcc` for Linux-targeting cross-compilers.

A typical compile line for a Cortex-M55 with Helium:

```
arm-none-eabi-g++ \
    -mcpu=cortex-m55 -mthumb \
    -mfloat-abi=hard -mfpu=fpv5-sp-d16 \
    -ftree-vectorize -O2 \
    -fno-exceptions -fno-rtti \
    -ffunction-sections -fdata-sections \
    -std=c++20 \
    -DCMSIS_NN_M85 \
    -c src/inference.cpp -o build/inference.o
```

The `-mfloat-abi=hard` selects hardware floating-point with float arguments passed in FPU registers, the standard for performance-critical code. `-mcpu=cortex-m55` enables Helium intrinsics automatically.

The link line uses `--specs=nosys.specs` (no system calls, link with stubs that return errors) or `--specs=nano.specs` (newlib-nano), plus `-T linker.ld` for the memory layout.

### LLVM and Clang for Embedded

Clang has become a credible alternative to GCC for Cortex-M. The `LLVM Embedded Toolchain for Arm` is shipped by Arm alongside the GCC toolchain. Code size is generally within 5 percent of GCC, runtime performance is generally within 2 percent. Some teams prefer Clang for its diagnostics and the Clang-Tidy integration.

A typical Clang line for the same target:

```
clang++ --target=arm-none-eabi \
    -mcpu=cortex-m55 -mthumb \
    -mfloat-abi=hard -mfpu=fpv5-sp-d16 \
    -O2 -fno-exceptions -fno-rtti \
    -ffunction-sections -fdata-sections \
    -std=c++20 \
    -c src/inference.cpp -o build/inference.o
```

For new embedded C++ projects in 2026, both compilers are reasonable. GCC has the longer track record. Clang has better tooling integration. Most safety-critical projects use GCC because the qualified compiler ecosystem (Validas, BTC) is GCC-centric. Most consumer IoT projects use whichever the vendor SDK ships.

---
