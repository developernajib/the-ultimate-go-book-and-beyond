## Fixed-Point Arithmetic

Floating-point arithmetic seems natural until you need deterministic timing and a microcontroller that lacks an FPU. The Cortex-M0 and Cortex-M3 have no hardware floating-point unit. Even on the Cortex-M4F which has a single-precision FPU, using `double` falls back to software emulation. Soft-float routines are not just slow, they have variable latency depending on operand values (denormals, NaN handling), making them unsuitable for WCET-sensitive code. Fixed-point arithmetic solves both problems: it runs entirely on integer instructions, which every Cortex-M executes with deterministic single-cycle throughput.

### Fixed-Point Representation

A fixed-point number is an integer with an implicit decimal point at a fixed position.

**Q notation:** Qm.n means m integer bits and n fractional bits. The total storage is m+n bits (plus a sign bit for signed types). The resolution (smallest representable difference) is `2^(-n)`. The range for a signed Qm.n is `[-2^m, 2^m - 2^(-n)]`.

```
Q8.8  (16-bit):  range [-128, 127.996],  resolution 1/256 ≈ 0.0039
Q16.16 (32-bit): range [-32768, 32767.999985],  resolution 1/65536 ≈ 0.0000153
Q1.30 (32-bit):  range [-1, 0.9999999991],  resolution ≈ 9.3e-10  (for unit fractions)
```

The raw integer value stores `real_value × 2^n`. Converting between fixed-point and float:

```
real = raw / 2^n
raw  = real × 2^n    (integer truncation)
```

### Fixed-Point Template

Templates are C++'s compile-time code generation mechanism, allowing a single definition to work with multiple types without sacrificing type safety or runtime performance. The compiler instantiates a separate concrete version for each distinct set of template arguments encountered.
```cpp
#include <cstdint>
#include <type_traits>

template<typename T, int FRAC>
struct Fixed {
    static_assert(std::is_integral_v<T>, "T must be integer type");
    static_assert(FRAC > 0 && FRAC < sizeof(T) * 8, "FRAC out of range");

    T raw;

    // Construction
    constexpr Fixed() : raw(0) {}
    constexpr explicit Fixed(T raw_val) : raw(raw_val) {}

    static constexpr Fixed from_int(int v) {
        return Fixed(static_cast<T>(v) << FRAC);
    }

    static Fixed from_float(float f) {
        return Fixed(static_cast<T>(f * static_cast<float>(1 << FRAC)));
    }

    float to_float() const {
        return static_cast<float>(raw) / static_cast<float>(1 << FRAC);
    }

    // Arithmetic -- same type, same FRAC
    constexpr Fixed operator+(Fixed rhs) const { return Fixed(raw + rhs.raw); }
    constexpr Fixed operator-(Fixed rhs) const { return Fixed(raw - rhs.raw); }
    constexpr Fixed operator-()          const { return Fixed(-raw); }

    // Multiplication: intermediate result needs double-width
    constexpr Fixed operator*(Fixed rhs) const {
        using Wide = typename std::conditional_t<
            sizeof(T) == 4,
            int64_t,   // int32 → int64 intermediate
            int32_t    // int16 → int32 intermediate
        >;
        return Fixed(static_cast<T>(
            (static_cast<Wide>(raw) * static_cast<Wide>(rhs.raw)) >> FRAC
        ));
    }

    // Division: pre-shift dividend
    constexpr Fixed operator/(Fixed rhs) const {
        using Wide = typename std::conditional_t<
            sizeof(T) == 4, int64_t, int32_t
        >;
        return Fixed(static_cast<T>(
            (static_cast<Wide>(raw) << FRAC) / static_cast<Wide>(rhs.raw)
        ));
    }

    constexpr bool operator< (Fixed rhs) const { return raw <  rhs.raw; }
    constexpr bool operator<=(Fixed rhs) const { return raw <= rhs.raw; }
    constexpr bool operator> (Fixed rhs) const { return raw >  rhs.raw; }
    constexpr bool operator>=(Fixed rhs) const { return raw >= rhs.raw; }
    constexpr bool operator==(Fixed rhs) const { return raw == rhs.raw; }
};

// Convenient type aliases
using Q8_8  = Fixed<int16_t, 8>;
using Q16_16 = Fixed<int32_t, 16>;
using Q1_30 = Fixed<int32_t, 30>;
```

### Overflow Detection and Saturation

Fixed-point arithmetic wraps on overflow, producing incorrect results silently. In a PID controller, integral windup on a saturated actuator can cause overflow. Detect and clamp:

```cpp
#include <climits>

// Saturating add for Q16.16
Q16_16 sat_add(Q16_16 a, Q16_16 b) {
    int32_t result;
    if (__builtin_add_overflow(a.raw, b.raw, &result)) {
        // Overflow -- saturate to limits
        result = (a.raw > 0) ? INT32_MAX : INT32_MIN;
    }
    return Q16_16(result);
}

// Saturating subtract
Q16_16 sat_sub(Q16_16 a, Q16_16 b) {
    int32_t result;
    if (__builtin_sub_overflow(a.raw, b.raw, &result)) {
        result = (a.raw > 0) ? INT32_MAX : INT32_MIN;
    }
    return Q16_16(result);
}

// Clamp to range [lo, hi]
Q16_16 clamp(Q16_16 val, Q16_16 lo, Q16_16 hi) {
    if (val < lo) return lo;
    if (val > hi) return hi;
    return val;
}
```

`__builtin_add_overflow` is a GCC/Clang intrinsic that compiles to an add-with-overflow check. On ARM Cortex-M, this uses the V (overflow) flag in the CPSR after an `adds` instruction, zero runtime overhead compared to a separate bounds check.

### PID Controller in Q16.16

A PID (Proportional-Integral-Derivative) controller is the workhorse of embedded control loops, motor speed, temperature regulation, attitude control. Implementing it in Q16.16 gives sub-millisecond deterministic execution on any Cortex-M.

```cpp
#include <cstdint>

class PidController {
    Q16_16 kp_, ki_, kd_;
    Q16_16 integral_{};
    Q16_16 prev_error_{};
    Q16_16 output_min_, output_max_;

public:
    PidController(Q16_16 kp, Q16_16 ki, Q16_16 kd,
                  Q16_16 out_min, Q16_16 out_max)
        : kp_(kp), ki_(ki), kd_(kd)
        , output_min_(out_min), output_max_(out_max)
    {}

    Q16_16 update(Q16_16 setpoint, Q16_16 measured) {
        Q16_16 error      = setpoint - measured;
        Q16_16 derivative = error - prev_error_;
        prev_error_       = error;

        // Integral with anti-windup: clamp before accumulating
        integral_ = clamp(sat_add(integral_, error), output_min_, output_max_);

        Q16_16 output = sat_add(
            sat_add(kp_ * error, ki_ * integral_),
            kd_ * derivative
        );
        return clamp(output, output_min_, output_max_);
    }

    void reset() {
        integral_   = Q16_16{};
        prev_error_ = Q16_16{};
    }
};

// Usage: motor speed controller, called every 1 ms from timer ISR
static PidController g_speed_pid(
    Q16_16::from_float(1.2f),   // Kp
    Q16_16::from_float(0.05f),  // Ki
    Q16_16::from_float(0.01f),  // Kd
    Q16_16::from_int(-100),     // Output min: -100%
    Q16_16::from_int( 100)      // Output max: +100%
);

extern "C" void TIM6_DAC_IRQHandler() {
    TIM6->SR &= ~TIM_SR_UIF;  // Clear update interrupt flag

    Q16_16 setpoint = Q16_16::from_int(g_target_rpm);
    Q16_16 measured = Q16_16::from_int(read_encoder_rpm());
    Q16_16 pwm_duty = g_speed_pid.update(setpoint, measured);

    set_motor_pwm(static_cast<int32_t>(pwm_duty.raw >> 16));
}
```

### CORDIC for sin/cos Without FPU

CORDIC (COordinate Rotation DIgital Computer) computes trigonometric functions using only shifts and additions, no multiplication, no division, no FPU.

```cpp
#include <cstdint>

// CORDIC sin/cos in Q1.30 fixed-point
// Input angle: Q1.30 in range [-pi/2, pi/2], where pi/2 ≈ 0x6487ED51
// Returns: sin in Q1.30, cos in Q1.30
// 16 iterations → ~9.6 decimal digits of precision

static const int32_t CORDIC_ATAN_TABLE[16] = {
    0x3243F6A8, 0x1DAC6705, 0x0FADBAFC, 0x07F56EA6,
    0x03FEAB76, 0x01FFD55B, 0x00FFFAAA, 0x007FFF55,
    0x003FFFEA, 0x001FFFFD, 0x000FFFFF, 0x0007FFFF,
    0x0003FFFF, 0x0001FFFF, 0x0000FFFF, 0x00007FFF,
};
static const int32_t CORDIC_K = 0x26DD3B6A;  // 1/An in Q1.30

void cordic_sincos(int32_t angle, int32_t& sin_out, int32_t& cos_out) {
    int32_t x = CORDIC_K;
    int32_t y = 0;
    int32_t z = angle;

    for (int i = 0; i < 16; ++i) {
        int32_t dx = x >> i;
        int32_t dy = y >> i;
        if (z >= 0) {
            x -= dy;  y += dx;  z -= CORDIC_ATAN_TABLE[i];
        } else {
            x += dy;  y -= dx;  z += CORDIC_ATAN_TABLE[i];
        }
    }
    cos_out = x;
    sin_out = y;
}
```

16 iterations of CORDIC on a Cortex-M3 (no FPU) runs in approximately 80-100 cycles, deterministic, fast, and correct.

### Go Comparison

Go has no fixed-point arithmetic in the standard library. For financial applications where floating-point rounding is unacceptable, `github.com/shopspring/decimal` provides arbitrary-precision decimal arithmetic, but it heap-allocates and is unsuitable for embedded use. In pure Go, a Q16.16 type would be straightforward to implement, but escaping to the heap when passed through interfaces would defeat the purpose. In embedded Go (TinyGo), the same fixed-point techniques apply, but the type system has no way to encode the FRAC parameter at compile time without generics, which TinyGo supports in recent versions.

---
