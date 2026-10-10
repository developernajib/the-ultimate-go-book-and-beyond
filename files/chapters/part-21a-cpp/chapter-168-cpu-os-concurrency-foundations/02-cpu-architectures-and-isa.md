## 02. CPU Architectures and ISA

### What an ISA Is

An Instruction Set Architecture (ISA) is the contract between software and hardware. It specifies which binary patterns the CPU will recognize as valid instructions, what operations they perform, what registers exist, and how memory is addressed. The ISA is what makes code portable across different physical CPU implementations, any chip that implements the same ISA will run the same binary.

The ISA is not the same as the microarchitecture. The microarchitecture is how a specific chip implements the ISA internally. Two chips with the same ISA can have completely different internal designs, different pipeline depths, different cache sizes, different execution units. They both run the same binary.

---

### CISC vs RISC

The two major design philosophies differ in what they consider a good instruction set.

**CISC (Complex Instruction Set Computer)** adds instructions for common multi-step operations. A single CISC instruction might load data from memory, perform arithmetic, and write the result back. The goal was to give compilers powerful tools and reduce the number of instructions needed to express a computation. x86 is CISC.

**RISC (Reduced Instruction Set Computer)** uses simple, fixed-width instructions that each do one thing. Load is separate from arithmetic. Store is separate from arithmetic. More instructions to express the same computation, but each instruction is simple and executes predictably. ARM is RISC.

The practical difference today is smaller than the theory suggests. x86 CPUs translate complex CISC instructions into simpler internal micro-operations before executing them, which gives them many RISC-like properties internally. But the instruction encoding remains CISC at the hardware interface.

---

### x86 and x86-64

x86 originated in 1978 with Intel's 8086 processor. It used 16-bit registers and a segmented memory model. The ISA grew incrementally over decades, accumulating instructions for each generation of applications. 32-bit extension came with the 80386. Floating-point instructions were added. SIMD instructions (SSE, AVX) were added for multimedia and scientific workloads.

x86 had 8 general-purpose registers in 32-bit mode. AMD extended x86 to 64 bits (called AMD64 or x86-64) in 2003 and added 8 more registers for a total of 16. Intel adopted AMD's 64-bit extension. The ISA you use today on any modern PC is this AMD64 extension.

x86-64 instructions are variable-length, ranging from 1 to 15 bytes. This makes decoding complex. The CPU must determine where each instruction ends before it can decode the next one, which complicates the pipeline.

x86 is dominant on servers and desktops. Almost all cloud infrastructure runs x86-64.

---

### ARM

ARM (originally Acorn RISC Machine, later Advanced RISC Machine) started in 1983 at a British company called Acorn Computers. The design team was small and constrained, which pushed them toward simplicity. The result was a processor that consumed very little power, which made it attractive for embedded and mobile applications long before smartphones existed.

ARM instructions are fixed-width (32-bit in ARM mode, 16-bit compressed in Thumb mode). Fixed-width instructions make decoding predictable and allow the CPU to fetch multiple instructions per clock cycle without the variable-length complexity of x86.

ARM's big.LITTLE architecture pairs high-performance cores with efficiency cores. The efficiency cores handle idle background tasks and consume a fraction of the power. The CPU scheduler can move work between core types based on load. Apple's M-series chips and most Android processors use this architecture.

Apple M1 (2020) was significant because it demonstrated that ARM could match x86 server performance in real workloads while consuming dramatically less power. The laptop does not need a fan. This performance-per-watt advantage is now driving ARM adoption in data centers.

---

### RISC-V

RISC-V (pronounced "risk five") is an open-source ISA developed at UC Berkeley starting in 2010. Unlike x86 (controlled by Intel) and ARM (controlled by ARM Holdings, which requires a license), RISC-V is published openly and anyone can implement it without paying royalties or signing license agreements.

RISC-V is modular. The base integer instruction set is small. Extensions add specific capabilities: M for multiply/divide, A for atomic operations, F for single-precision floating-point, D for double-precision, V for vector operations. A chip implementer picks exactly the extensions they need.

RISC-V is used in embedded systems, research chips, and increasingly in commercial products. SiFive makes general-purpose RISC-V processors. The European Processor Initiative chose RISC-V as one of its ISAs. RISC-V matters because it shows the ISA does not need to be proprietary.

---

### What the ISA Exposes to Programmers

The ISA determines:

- **Register width:** 32-bit vs 64-bit determines the maximum address space and the size of integer operations
- **Number of registers:** More registers means the compiler can keep more values in fast storage without round-tripping to memory
- **Memory addressing modes:** Which combinations of base register, offset, and index are valid in a single instruction
- **Calling convention:** How function arguments and return values are passed (in registers vs on the stack)
- **Atomic instructions:** Which operations the hardware guarantees to be indivisible

The calling convention (ABI, Application Binary Interface) is particularly important for cross-language interop. When Go calls a C function via cgo, both sides must agree on which registers hold arguments and return values. The ABI is determined by the ISA and OS combination.

---

### Go's Relationship to ISA

Go runs on multiple ISAs: amd64, arm64, arm, 386, mips, ppc64, s390x, riscv64, and others. The Go runtime and compiler are aware of the ISA and generate different code for each target. The Go register-based calling convention (introduced in Go 1.17 for amd64 and 1.18 for arm64) passes function arguments in registers rather than on the stack, reducing memory traffic on ISAs with enough registers.

The fact that Go goroutines are much cheaper than OS threads comes partly from ISA features: when the Go scheduler performs a goroutine switch, it only needs to save a small set of registers, not the full CPU state that an OS context switch saves.

---

### Summary

| ISA | Width | Registers | License | Primary Use |
|-----|-------|-----------|---------|-------------|
| x86-64 | 64-bit | 16 GPR | Proprietary (Intel/AMD) | PC, Server |
| ARM64 | 64-bit | 31 GPR | Licensed (ARM Holdings) | Mobile, Apple Silicon |
| RISC-V | 64-bit | 32 GPR | Open source | Embedded, Research |

The ISA shapes everything from compiler output to the cost of system calls. When you profile a Go binary and see assembly, the instructions you see are ISA instructions. When you use `sync/atomic`, the operations map to specific ISA atomic instructions. The ISA is not an abstraction you can ignore when tuning real programs.

---

**Watch:** [CPU Architectures, x86, ARM, RISC-V Explained](https://www.youtube.com/watch?v=7xWaijDmKDY)
