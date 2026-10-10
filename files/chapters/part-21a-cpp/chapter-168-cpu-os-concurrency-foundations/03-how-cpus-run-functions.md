## 03. How CPUs Run Functions

### The Problem: Where Does Execution Return?

The fetch-decode-execute cycle runs linearly, moving through instructions one by one. A jump instruction tells the CPU to continue from a different address. But a function call requires something more: after the function completes, execution must return to the instruction immediately after the call. The CPU needs to remember where to come back.

The naive solution is to store the return address in a dedicated register. This fails immediately when a function calls another function, the second call overwrites the return address from the first call, and the first function can never return correctly. Recursion makes this completely unworkable.

The actual solution is the call stack.

---

### The Call Stack

The stack is a region of memory set aside for tracking function calls. It grows and shrinks as functions are called and return. A special register called the stack pointer (SP) tracks the current top of the stack.

The x86-64 `call` instruction does two things atomically:
1. Push the return address (the address of the instruction after the call) onto the stack
2. Jump to the function's address

The `ret` instruction does the reverse:
1. Pop the return address from the stack
2. Jump to that address

This works for arbitrarily deep call chains because each level of the stack holds its own return address.

---

### Stack Frames

Each function call creates a stack frame. A stack frame contains:
- The return address (pushed by `call`)
- Saved register values (the function must restore any registers it uses)
- Local variables
- Space for arguments to functions that this function calls (on some calling conventions)

On x86-64, the stack grows downward, toward lower memory addresses. When a function is called, the stack pointer decreases. When a function returns, it increases. The stack frame for the current function is the region between the current stack pointer and the frame pointer (if used).

A simple example in C and its stack layout:

```c
int add(int a, int b) {
    return a + b;
}

int main() {
    int result = add(3, 5);
    return 0;
}
```

When `main` calls `add`:
1. Arguments 3 and 5 go into registers (on x86-64 System V ABI: rdi, rsi)
2. `call add` pushes the return address and jumps to `add`
3. `add` computes `a + b` in registers
4. `ret` pops the return address and jumps back to `main`

No heap allocation. No garbage collection. The stack is just a pointer into a pre-allocated memory region.

---

### Stack Depth and Stack Overflow

Every process has a fixed stack size. On Linux, the default is 8 MB. On Windows, it is typically 1 MB per thread. Go is different: goroutines start with a 2 KB to 8 KB stack that grows dynamically as needed, up to a configurable maximum (default 1 GB).

A stack overflow happens when function calls go too deep and the stack pointer moves past the end of the allocated stack region. The OS detects this via a guard page, a page of memory at the bottom of the stack with no read/write permissions. When the stack pointer crosses into it, the CPU raises a page fault, which the OS converts into a stack overflow signal.

In Go, the runtime checks available stack space at each function entry and copies the goroutine's stack to a larger allocation when it is running out. This is the goroutine stack growth mechanism. It is why goroutines can start small but handle deep recursion.

---

### Inlining vs Outlining

The compiler can choose to inline a function: copy the function's code directly into the call site instead of emitting a call instruction. This eliminates the overhead of pushing/popping the stack frame and the jump.

Inlining is a win when:
- The function is small (the code copied is smaller than the call overhead)
- The function is called frequently (the overhead compounds)
- Inlining enables further optimizations at the call site

Inlining is a loss when:
- The function is large (the binary gets bigger, and instruction cache efficiency decreases)
- The function is called from many places (the code is duplicated at each call site)

Go inlines small functions automatically. The `//go:noinline` directive prevents inlining for benchmarking or debugging.

You can see inlining decisions:

```bash
go build -gcflags="-m" ./...
```

Output lines like `can inline add` and `inlining call to add` tell you what the compiler decided.

---

### The ABI and Calling Conventions

The ABI (Application Binary Interface) specifies the calling convention: which registers hold arguments, which registers hold return values, which registers the callee must preserve, and how the stack is aligned.

On x86-64 Linux (System V ABI):
- First 6 integer arguments: rdi, rsi, rdx, rcx, r8, r9
- First 8 floating-point arguments: xmm0-xmm7
- Return value: rax (integer), xmm0 (float)
- Callee-saved registers (must be restored before return): rbx, rbp, r12-r15

On x86-64 Windows:
- First 4 arguments: rcx, rdx, r8, r9
- Return value: rax

Go's internal calling convention changed in Go 1.17. Before 1.17, Go used a stack-based calling convention (all arguments on the stack). From 1.17 on, Go uses a register-based convention on amd64, which reduced benchmark overhead by 5-10% in the standard library.

When Go code calls C via cgo, the Go runtime switches from Go's calling convention to the platform ABI. This is one reason cgo calls have extra overhead compared to pure Go calls.

---

### Recursion and Tail Calls

Recursion is straightforward once you understand the stack: each recursive call adds a frame. Deep recursion uses a lot of stack space. A function that recurses 10,000 times has 10,000 active frames simultaneously.

A tail call is a function call that is the last thing a function does before returning. The callee's result is immediately returned without further computation. In a tail call, the current frame is not needed after the call returns, so the compiler can reuse it instead of allocating a new one. This is tail call optimization (TCO).

Go does not currently perform tail call optimization. A recursive function in Go that recurses 1 million times will either overflow the goroutine stack or trigger stack growth. If you need deep recursion in Go, the standard approaches are to convert to iteration or use an explicit stack data structure.

---

### What This Means for Performance

Stack operations are fast because:
- The stack pointer is always in a register
- Pushing and popping are single instructions (adjust SP, store/load)
- Stack memory is hot in CPU cache because you access it constantly

Heap allocation is slower because:
- The runtime must find free memory
- The allocator must track allocated regions
- The garbage collector must eventually reclaim it

The Go compiler's escape analysis decides whether a variable lives on the stack or the heap. Variables that do not escape the function live on the stack. Variables that escape (because their address is taken and passed out, or because they are too large) live on the heap.

```bash
go build -gcflags="-m" ./...
# Look for "escapes to heap" in the output
```

Understanding the call stack explains why escape analysis matters and why keeping allocations on the stack is a performance optimization.

---

**Watch:** [How CPUs Run Functions. The Call Stack Explained](https://www.youtube.com/watch?v=7YyALikxAlU)
