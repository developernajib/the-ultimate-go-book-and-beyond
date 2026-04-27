export default `## 7D.13 ARM64 Assembly

Apple Silicon (M1/M2/M3) and AWS Graviton run on ARM64 (AArch64). Go's ARM64 assembly uses Plan 9 syntax with ARM64 register names.

\`\`\`asm
// file: sum_arm64.s
// Implements func SumARM64(data []int64) int64 using NEON SIMD

#include "textflag.h"

// func SumARM64(data []int64) int64
TEXT "".SumARM64(SB),NOSPLIT,\$0-32
    // Arguments:
    // data.ptr at FP+0  (8 bytes)
    // data.len at FP+8  (8 bytes)
    // data.cap at FP+16 (8 bytes)
    // return  at FP+24  (8 bytes)

    MOVD data_ptr+0(FP), R0    // R0 = data pointer
    MOVD data_len+8(FP), R1    // R1 = length
    MOVD \$0, R2                // R2 = accumulator (scalar fallback)

    CBZ R1, arm_done           // if len==0, goto done

    // NEON: process 2 int64s per cycle using V registers (128-bit)
    MOVI \$0, V0.D2             // V0 = {0, 0} (two 64-bit zeros)
    MOVD R1, R3
    LSR \$1, R3                 // R3 = len / 2
    CBZ R3, arm_scalar

arm_simd_loop:
    VLD1.P 16(R0), [V1.D2]    // load 2 int64s, post-increment R0 by 16
    VADD V1.D2, V0.D2, V0.D2  // V0 += V1 (add 2 int64s simultaneously)
    SUBS \$1, R3
    BNE arm_simd_loop

    // Horizontal add: V0 = {sum_even, sum_odd} → single sum
    VMOV V0.D[0], R2           // R2 = V0[0] (first int64)
    VMOV V0.D[1], R4           // R4 = V0[1] (second int64)
    ADD R4, R2                 // R2 = total sum

    AND \$1, R1                 // remaining = len % 2
    CBZ R1, arm_done

arm_scalar:
    MOVD (R0), R4              // load one int64
    ADD R4, R2                 // accumulator += value
    ADD \$8, R0                 // advance pointer
    SUBS \$1, R1
    BNE arm_scalar

arm_done:
    MOVD R2, ret+24(FP)        // store result
    RET
\`\`\`

The Go dispatcher selects the appropriate implementation at init time. Unlike x86 AVX2 which requires a runtime CPU check, ARM64 NEON is part of the base architecture, every ARM64 processor supports it:

\`\`\`go
// file: sum_dispatch.go
package math

import "golang.org/x/sys/cpu"

// Architecture-specific implementations declared in .s files:
// sum_amd64.s  - x86-64 scalar + AVX2
// sum_arm64.s  - ARM64 scalar + NEON

func SumAVX2(data []int64) int64   // implemented in sum_avx2_amd64.s
func SumARM64(data []int64) int64  // implemented in sum_arm64.s

var sumImpl func([]int64) int64

func init() {
    switch {
    case cpu.X86.HasAVX2:
        sumImpl = SumAVX2
    default:
        // ARM64 NEON is always available on arm64; no runtime check needed
        // On other platforms, the _generic.go file provides the fallback
        sumImpl = sumScalarGo
    }
}

func Sum(data []int64) int64 {
    return sumImpl(data)
}

func sumScalarGo(data []int64) int64 {
    var total int64
    for _, v := range data {
        total += v
    }
    return total
}
\`\`\`

### ARM64 Register Reference

ARM64 provides 31 general-purpose 64-bit registers (X0-X30), floating-point registers, and SIMD registers. In Go's Plan 9 assembly, these are accessed with architecture-specific names defined by the Go compiler.

\`\`\`
┌──────────────────────────────────────────────────────────────────────┐
│              ARM64 (Plan 9) Register Quick Reference                  │
├──────────────────────────────────────────────────────────────────────┤
│                                                                       │
│  General Purpose (64-bit):                                           │
│  R0–R7    Function arguments and return values                       │
│  R8–R15   Caller-saved temporaries                                   │
│  R16–R17  Intra-procedure-call scratch (IP0, IP1)                   │
│  R18       Platform reserved (do not use on most OS)                 │
│  R19–R28  Callee-saved (preserve across calls)                      │
│  R29 (FP) Frame pointer                                             │
│  R30 (LR) Link register (return address)                            │
│  RSP (R31) Stack pointer                                             │
│                                                                       │
│  NEON/FP Registers (128-bit):                                        │
│  V0–V7    Arguments and return values                               │
│  V8–V15   Callee-saved (low 64 bits only)                          │
│  V16–V31  Caller-saved temporaries                                  │
│                                                                       │
│  Vector suffixes: .B16 (16×8-bit), .H8 (8×16-bit),                │
│                   .S4 (4×32-bit), .D2 (2×64-bit)                   │
│                                                                       │
│  Plan 9 ARM64 instructions differ from GNU syntax:                  │
│  GNU: add x1, x0, x2   →  Plan 9: ADD R2, R0, R1                  │
│  GNU: ldr x0, [x1]     →  Plan 9: MOVD (R1), R0                   │
│  GNU: str x0, [x1]     →  Plan 9: MOVD R0, (R1)                   │
│  GNU: cmp x0, x1       →  Plan 9: CMP R1, R0                      │
└──────────────────────────────────────────────────────────────────────┘
\`\`\`

### ARM64 in 2026

ARM64 is a first-class Go target. Apple Silicon laptops, AWS Graviton instances, and most datacenter ARM servers run Go well. For services targeting ARM64, the assembly discipline from the amd64 section applies: per-architecture file, pure-Go fallback, benchmarks to justify the assembly path.

---
`;
