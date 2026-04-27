export default `## 7D.3 Plan 9 Assembly Basics

Go uses an assembler based on Plan 9's assembly language. The syntax is different from Intel or AT&T x86 assembly.

### Why Write Assembly?

1. **SIMD operations** - process multiple values per CPU cycle
2. **Atomic operations** not in Go's stdlib
3. **Direct CPU instruction access** (RDTSC, CPUID, etc.)
4. **Micro-optimization** of hot functions measured in pprof
5. **Understanding the Go compiler output** - \`go tool compile -S\`

### Reading Compiler-Generated Assembly

Before writing assembly, reading what the compiler already generates provides a baseline. The \`-gcflags="-S"\` flag and \`go tool objdump\` emit assembly for compiled packages, revealing optimization opportunities.

\`\`\`go
// file: add.go
package math

func Add(a, b int) int {
    return a + b
}
\`\`\`

\`\`\`bash
# View assembly output
go tool compile -S add.go

# Or disassemble a binary
go tool objdump -s 'main\\.Add' ./myprogram
\`\`\`

The compiler generates straightforward register-based code for simple functions. Here is the simplified x86-64 Plan 9 assembly for the \`Add\` function above:

\`\`\`asm
# What the compiler generates for Add(a, b int) int:
# (simplified x86-64 Plan 9 assembly)

TEXT "".Add(SB),NOSPLIT,\$0-24
    # Frame size: 0 bytes (no local variables)
    # Arguments: 24 bytes (a=8, b=8, return=8)

    MOVQ "".a+0(SP), AX   # load a from stack into AX register
    ADDQ "".b+8(SP), AX   # add b (from stack) to AX
    MOVQ AX, "".~r0+16(SP) # store result to return slot
    RET
\`\`\`

### Plan 9 Assembly Syntax

Go uses Plan 9 assembly syntax, which differs significantly from AT&T and Intel syntax in register naming, addressing modes, and pseudo-instructions for Go runtime integration such as \`NOSPLIT\` and \`NOFRAME\`.

\`\`\`asm
// File: sum_amd64.s
// Implements: func Sum(data []int64) int64

// Registers on amd64 (Plan 9 names):
// AX = RAX (accumulator)
// BX = RBX
// CX = RCX (counter)
// DX = RDX
// SI = RSI (source index)
// DI = RDI (destination index)
// SP = RSP (stack pointer)
// BP = RBP (base pointer)
// R8-R15 = extra general purpose

// TEXT declares a function
// "".Sum = function named Sum in current package
// SB = static base - package-level functions live here
// \$frameSize-argSize: frame=local vars bytes, argSize=args+return bytes
TEXT "".Sum(SB),NOSPLIT,\$0-32
    // Arguments for func Sum(data []int64) int64:
    // data.ptr at SP+0   (8 bytes)
    // data.len at SP+8   (8 bytes)
    // data.cap at SP+16  (8 bytes)
    // return  at SP+24   (8 bytes)

    MOVQ data_ptr+0(SP), SI   // SI = pointer to first element
    MOVQ data_len+8(SP), CX   // CX = length
    XORQ AX, AX               // AX = 0 (accumulator)
    TESTQ CX, CX
    JE   done                  // if len==0, goto done

loop:
    ADDQ 0(SI), AX            // AX += *SI
    ADDQ \$8, SI               // SI += 8 (next int64)
    DECQ CX                   // CX--
    JNZ  loop                 // if CX != 0, goto loop

done:
    MOVQ AX, ret+24(SP)       // store result
    RET
\`\`\`

The corresponding Go file declares the function signature without a body. The compiler links this stub to the assembly implementation by matching the package and function names:

\`\`\`go
// file: sum.go - Go file declares the function stub
package math

// Sum returns the sum of all int64 values.
// Implemented in sum_amd64.s for performance.
func Sum(data []int64) int64
// Note: no function body! The body is in the .s file.
\`\`\`

### SIMD Example: AVX2 Sum

SIMD (Single Instruction Multiple Data) processes multiple values simultaneously:

\`\`\`asm
// file: sum_avx2_amd64.s
// Uses AVX2 to sum 4 int64 values per iteration (256-bit registers)

#include "textflag.h"

// func SumAVX2(data []int64) int64
TEXT "".SumAVX2(SB),NOSPLIT,\$0-32
    MOVQ data_ptr+0(SP), SI    // data pointer
    MOVQ data_len+8(SP), CX    // length
    XORQ AX, AX                // accumulator = 0
    TESTQ CX, CX
    JE   avx_done

    VPXOR Y0, Y0, Y0           // Y0 = 0 (256-bit ymm register = 4 × int64)
    MOVQ CX, DX
    SHRQ \$2, DX                // DX = len / 4 (number of 4-element chunks)
    TESTQ DX, DX
    JE   avx_scalar            // if < 4 elements, use scalar

avx_loop:
    VMOVDQU 0(SI), Y1          // load 4 int64s from SI into Y1
    VPADDQ Y1, Y0, Y0          // Y0 += Y1 (add 4 int64s simultaneously)
    ADDQ \$32, SI               // advance pointer by 32 bytes (4 × 8)
    DECQ DX
    JNZ avx_loop

    // Horizontal sum of Y0 (4 values → 1 value)
    VEXTRACTI128 \$1, Y0, X1    // X1 = upper 128 bits of Y0
    VPADDQ X1, X0, X0          // X0 = lower 128 + upper 128
    VPSRLDQ \$8, X0, X1         // X1 = upper 64 bits of X0
    VPADDQ X1, X0, X0          // X0[0] = sum of all 4
    MOVQ X0, AX                // AX = final sum

    ANDQ \$3, CX                // remaining elements (len % 4)
    JE   avx_done

avx_scalar:
    ADDQ 0(SI), AX             // scalar fallback for remainder
    ADDQ \$8, SI
    DECQ CX
    JNZ avx_scalar

avx_done:
    VZEROUPPER                 // clear AVX state (required before calling non-AVX code)
    MOVQ AX, ret+24(SP)
    RET
\`\`\`

The Go side checks for AVX2 support at init time and selects the fastest available implementation. This runtime dispatch pattern avoids illegal-instruction crashes on older CPUs:

\`\`\`go
// file: sum_avx2.go
package math

import "golang.org/x/sys/cpu"

// SumAVX2 is the AVX2 implementation (sum_avx2_amd64.s)
// Only callable from SumOptimal; direct calls require CPU feature check.
func SumAVX2(data []int64) int64

// SumScalar is the pure Go fallback
func SumScalar(data []int64) int64 {
    var total int64
    for _, v := range data {
        total += v
    }
    return total
}

// SumOptimal dispatches to the best available implementation
var sumFunc func([]int64) int64

func init() {
    if cpu.X86.HasAVX2 {
        sumFunc = SumAVX2
    } else {
        sumFunc = SumScalar
    }
}

func Sum(data []int64) int64 {
    return sumFunc(data)
}
\`\`\`

### Assembly with GOARCH Build Constraints

Architecture-specific assembly files are paired with Go stub files and selected by build constraints. The Go stub provides the function signature for type-checking. The assembly provides the platform-specific implementation.

\`\`\`go
// file: sum_generic.go - runs on all architectures
//go:build !amd64

package math

func Sum(data []int64) int64 {
    var total int64
    for _, v := range data {
        total += v
    }
    return total
}
\`\`\`

For the amd64 assembly file, no explicit build tag is necessary. Go's build system recognizes the \`_amd64\` filename suffix and includes the file only when targeting that architecture:

\`\`\`asm
// file: sum_amd64.s - only compiled on amd64
// (no build tag needed - the _amd64 suffix in the filename handles it)
\`\`\`

### Assembly Discipline

For a senior engineer evaluating assembly in a team's codebase:

1. **Every assembly function needs a reference Go implementation.** Same behaviour, compared in tests. Without it, the assembly silently diverges over time.
2. **Every architecture needs its own file.** \`sum_amd64.s\`, \`sum_arm64.s\`, and a pure-Go fallback for unsupported architectures.
3. **CPU feature detection gates the specialised path.** \`golang.org/x/sys/cpu\` is the right tool.
4. **Benchmarks prove the gain.** Without measurements, the assembly is dead weight that added maintenance burden.

---
`;
