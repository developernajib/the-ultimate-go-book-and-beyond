## FFT and Convolution

The Fast Fourier Transform is the second pillar of audio DSP after biquads. Convolution reverb, partitioned convolution for long FIRs, spectral analysis, pitch shifting via phase vocoder, and noise reduction all rely on FFT-domain processing. The senior audio engineer knows the radix-2 Cooley-Tukey algorithm, the real-input optimization, and which library to use on which platform.

### The DFT and the FFT

The discrete Fourier transform of an N-point sequence:

`X[k] = sum from n=0 to N-1 of x[n] * exp(-j*2*pi*k*n/N)`

Direct computation is O(N^2). Cooley-Tukey decomposes the transform recursively into smaller transforms, achieving O(N log N) when N is a power of 2 (radix-2) or has small prime factors (mixed-radix).

```cpp
#include <complex>
#include <cmath>

void fft_radix2(std::complex<float>* x, int n) {
    // Bit-reversal permutation
    for (int i = 1, j = 0; i < n; ++i) {
        int bit = n >> 1;
        for (; j & bit; bit >>= 1) j ^= bit;
        j ^= bit;
        if (i < j) std::swap(x[i], x[j]);
    }
    // Cooley-Tukey butterflies
    for (int len = 2; len <= n; len <<= 1) {
        float ang = -2.0f * 3.14159265f / static_cast<float>(len);
        std::complex<float> wlen(std::cos(ang), std::sin(ang));
        for (int i = 0; i < n; i += len) {
            std::complex<float> w(1.0f, 0.0f);
            for (int j = 0; j < len / 2; ++j) {
                auto u = x[i + j];
                auto v = x[i + j + len / 2] * w;
                x[i + j]             = u + v;
                x[i + j + len / 2]   = u - v;
                w *= wlen;
            }
        }
    }
}
```

This is for understanding only. In production, never write your own FFT.

### Real FFT Trick

Audio is real-valued. A complex FFT of an N-point real input has a Hermitian-symmetric output, so half the bins are redundant. The "real FFT" packs an N-point real input into an N/2-point complex sequence, runs a complex FFT, and unpacks. The result is a 2x speedup and a 2x memory reduction.

Almost every audio library exposes a real FFT entry point. JUCE's `juce::dsp::FFT::performRealOnlyForwardTransform` is the cross-platform version. Apple's `vDSP_fft_zrip` is the optimized version for Apple silicon. Use the library's real FFT, not the complex FFT.

### Library Choice

The mature options:

- **FFTW** (Frigo, Johnson, MIT). Industry standard. GPL, with commercial license available from MIT. Tuneable via `fftw_plan_dft_r2c_1d` with `FFTW_PATIENT` for the best plan. Heavy dependency. Not appropriate for plugins because of license.
- **KISS-FFT** (Mark Borgerding). Tiny, BSD-licensed, single-file C library. Slower than FFTW but acceptable for short transforms (size 256 to 4096). The default for plugin developers who do not want a license entanglement.
- **PFFFT** (Julien Pommier). BSD, faster than KISS-FFT, header-friendly C, used in WebRTC.
- **Apple vDSP / Accelerate.** Free with macOS / iOS, uses NEON and AMX, the fastest option on Apple silicon.
- **Intel IPP** (`ippsFFTFwd_RToCCS_32f`). Free runtime, the fastest on Intel x86.
- **JUCE's `juce::dsp::FFT`.** Wraps the platform's best option (vDSP on Apple, FFTW if linked, falls back to JUCE's own implementation).

For commercial plugin work, JUCE's wrapper plus PFFFT or KISS-FFT for non-JUCE code is the typical stack.

### Direct (Time-Domain) Convolution

For a FIR with coefficients `h[0..M-1]` and an input block `x[0..N-1]`:

`y[n] = sum from k=0 to M-1 of h[k] * x[n-k]`

The straightforward algorithm has cost `O(N*M)` per block. For `M = 256` taps and `N = 64` samples per block, that is 16384 multiply-adds per block per channel. Achievable. For `M = 65536` taps (a 1.4-second impulse at 48kHz, a typical hall reverb), it is 4.2 million multiply-adds per block, which exceeds a per-plugin CPU budget at 64-sample blocks.

### FFT-Based Convolution

The convolution theorem: convolution in the time domain equals multiplication in the frequency domain.

```
y = ifft( fft(x) * fft(h) )
```

For an N-block input convolved with an M-tap impulse, we use overlap-add or overlap-save:

1. Pad `h` to length `L = N + M - 1`, FFT once at startup, store as `H`.
2. Per block: zero-pad `x` to length `L`, FFT to `X`, multiply `X * H`, IFFT to `y`, add the `M-1` overlap from the previous block.

Cost per block: O(L log L). Crossover point with direct convolution is around M = 128 taps.

The catch: a single big FFT introduces latency equal to the block size used in the FFT. A 4096-point FFT at 48kHz is 85ms of latency. Unacceptable for a real-time plugin.

### Partitioned Convolution (Gardner)

William Gardner's "Efficient Convolution Without Input/Output Delay" (JAES 1995) solved the latency problem. Split the impulse into uniform partitions of size N (the host's block size). Each block, you FFT the new input block, multiply it against each partition's frequency-domain representation, and accumulate into a frequency-domain output. After IFFT, sum the overlap from past partitions.

Pseudocode:

```cpp
class UniformPartitionedConvolver {
    int blockSize_;          // e.g. 64 samples
    int fftSize_;            // 2 * blockSize_
    int numPartitions_;      // M / blockSize_
    std::vector<std::vector<std::complex<float>>> H_; // [numPartitions][fftSize/2+1]
    std::vector<std::vector<std::complex<float>>> X_; // ring of input FFTs
    int writeIndex_ = 0;

public:
    void prepare(const float* impulse, int impulseLength, int blockSize) {
        blockSize_ = blockSize;
        fftSize_ = 2 * blockSize;
        numPartitions_ = (impulseLength + blockSize - 1) / blockSize;
        // FFT each partition into H_[p].
        // Allocate ring of input spectra X_.
    }

    void process(const float* in, float* out, int n) noexcept {
        // FFT current block into X_[writeIndex_].
        // For each partition p in 0..numPartitions_-1:
        //   accumulate Y += X_[(writeIndex_ - p + ring) % ring] * H_[p]
        // IFFT Y, output the second half.
        writeIndex_ = (writeIndex_ + 1) % numPartitions_;
    }
};
```

Latency: equals the host block size, not the impulse length. CPU: roughly proportional to log(blockSize) * numPartitions, which is much better than direct.

### Non-Uniform Partitioned Convolution

For very long impulses (5+ seconds), even uniform partitioning is suboptimal. Non-uniform partitioning uses small partitions for the first few blocks (low latency) and progressively larger partitions for the impulse tail (better CPU). Wave Arts WaveShell, Liquidsonics Cinematic Rooms, and Fabfilter Pro-R 2 all use non-uniform partitioning.

The standard reference is Garcia, "Optimal Filter Partition for Efficient Convolution with Short Input/Output Delay" (AES Convention 113, 2002). The optimization is a dynamic-programming partition that minimizes total operations subject to the latency constraint.

### Convolution Reverb

A convolution reverb is just a partitioned convolver with a long impulse response (an actual room recording or synthesized). Stereo or surround impulses are typically processed as multiple parallel convolvers, with the stereo I/O matrix reflecting the impulse's recording configuration (true stereo is 4 mono convolvers: LL, LR, RL, RR).

Real implementations:

- **Audio Ease Altiverb** uses non-uniform partitioning with hand-curated impulses.
- **Liquidsonics** (Cinematic Rooms, Reverberate) uses dynamic IR morphing and is the convolution engine licensed by some Avid plugins.
- **Fabfilter Pro-R 2** is algorithmic but uses convolution-style early reflections.
- **JUCE's `juce::dsp::Convolution`** is a uniform partitioned convolver suitable for plugins. Use the `juce::dsp::Convolution::NonUniform` mode (added in JUCE 7) for long impulses.

### FFT Precision and Determinism

Different FFT libraries use different butterfly orderings, different twiddle-factor tables, and different SIMD strategies. The result is that bit-exact output across platforms is not guaranteed. If you need deterministic output (regression testing, networked sample-accurate sync, audio-reactive visuals), choose one library, link it everywhere (no platform-specific implementations), and disable FMA contraction with `-ffp-contract=off` on Clang/GCC.

For musical content, sub-bit-of-precision differences are inaudible and not worth fighting. For forensic audio or regulated workflows, they matter.

### Spectral Processing Patterns

Beyond convolution, FFT enables:

- **Spectral gates and noise reduction.** Subtract a noise spectrum estimate from each block's spectrum.
- **Phase vocoder for time stretch.** Hold the magnitude, advance the phase by the desired stretch ratio.
- **Convolution-based EQ.** A linear-phase FIR EQ designed in the frequency domain.
- **Cross-synthesis.** Use the magnitude of one signal with the phase of another (the "vocoder" effect, but implemented in FFT rather than analog filter banks).

All of these patterns share the same overlap-add framework, the difference is what you do to the spectrum between FFT and IFFT.

### A Complete Block-Convolver Sketch

```cpp
class BlockConvolver {
    juce::dsp::FFT fft_;        // size N (host block size)
    std::vector<float> hPad_;    // padded impulse, time domain
    std::vector<std::complex<float>> H_; // impulse spectrum
    std::vector<float> overlap_; // saved tail
public:
    BlockConvolver(int blockSize) : fft_(std::log2(2 * blockSize)) {}
    void setIR(const float* h, int len) {
        // Pad h, FFT once, store H_.
    }
    void process(const float* in, float* out, int n) noexcept {
        // Copy in into a 2N buffer (zero second half), FFT, multiply by H_,
        // IFFT, output first N + overlap, save second N as new overlap.
    }
};
```

This is the kernel of every convolution-based plugin shipped today.

---
