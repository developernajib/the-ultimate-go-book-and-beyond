## 06. Memory Segments and Process Layout

When the OS loads a program, it maps the executable into the process's virtual address space and sets up several distinct memory regions. Each region has different permissions, different lifetimes, and different allocation mechanisms. Knowing where your variables live explains scope, lifetime, and many classes of bugs.

### The Classic Five Segments

The traditional model divides a process's memory into five regions:

```
High addresses
+------------------+
|      Stack       |  grows downward (toward lower addresses)
|  (local vars,    |
|   return addrs)  |
+------------------+
|       ...        |  (gap for ASLR and stack guard)
+------------------+
|  mmap region     |  shared libs, file mappings, anonymous mmap
+------------------+
|       ...        |
+------------------+
|      Heap        |  grows upward (toward higher addresses)
|  (malloc/new)    |
+------------------+
|      BSS         |  uninit. globals and statics (zeroed at load)
+------------------+
|      Data        |  init. globals and statics (read from binary)
+------------------+
|      Text        |  executable code (read-only)
+------------------+
Low addresses
```

### Text Segment (Code Segment)

The text segment contains the machine instructions for the program. It is loaded directly from the executable file. It is read-only (any write generates a segfault) and executable. On Linux the text segment starts at a fixed address after ASLR randomization.

Literals like string constants (`"hello"`) are often stored in the text segment or in a read-only data section adjacent to it.

### Data Segment (Initialized Data)

The data segment holds global and static variables that have explicit initial values in the source code. These values are stored in the executable binary and mapped directly into memory at load time.

```c
// These live in the data segment:
int global_counter = 42;
static const float PI = 3.14159f;
```

The data segment is read-write (globals can be modified) but its size is fixed, it does not grow at runtime.

### BSS Segment (Uninitialized Data)

BSS stands for "Block Started by Symbol", an old assembler directive. The BSS segment holds global and static variables that have no explicit initial value. These are initialized to zero by the OS at process start.

The key property of BSS: the executable binary does not need to store the zero values. A 100,000-element global array of zeros in BSS takes up only a small descriptor in the binary (recording its size), not 800KB of actual data. The OS allocates zeroed pages when the process loads.

```c
// These live in BSS, no space in the binary:
static uint64_t bitboard[12];       // 12 * 8 = 96 bytes, all zeros
static char scratch_buffer[65536];  // 64KB, all zeros
```

```go
// In Go, package-level variables with zero values go to BSS equivalent:
var globalSlice []byte     // nil slice header, zero-cost in binary
var globalMap   map[string]int  // nil map, zero-cost in binary
```

### Heap

The heap is the dynamic allocation region. `malloc`/`free` in C, `new`/`delete` in C++, and the Go runtime allocator all serve memory from the heap. The heap starts just above the BSS segment and grows upward via the `brk` or `mmap` syscall.

On 64-bit Linux, the heap can grow to the address space limit (typically 128TB for user space). In practice, it is bounded by physical RAM plus swap plus any per-process rlimit.

The heap is unstructured. The allocator maintains free lists and metadata about allocated blocks. This metadata is the source of fragmentation and allocator overhead.

### Stack

The stack holds:
- Local variables of the current function.
- Function arguments.
- Return addresses.
- Saved registers (caller-saved and callee-saved, depending on calling convention).

The stack grows downward on x86-64. Each function call pushes a new stack frame. Each return pops it.

The stack starts at a high virtual address (just below the kernel/user space boundary) and grows toward lower addresses. The OS provides a guard page below the stack, which generates a stack overflow signal (SIGSEGV on Linux, stack overflow exception on Windows) when the stack grows into it.

Default stack sizes:
- Linux: 8MB (ulimit -s).
- Go: starts at 8KB per goroutine, grows dynamically up to 1GB by default.
- macOS: 8MB for main thread, 512KB for secondary threads.

### mmap Region

Between the stack and the heap is the memory-mapped region. This is where:
- Shared libraries (`.so` / `.dylib`) are mapped.
- File mappings (`mmap(2)`) reside.
- Large anonymous allocations by `malloc` (above a threshold, typically 128KB, glibc uses `mmap` instead of `brk`).
- Thread stacks for non-main threads.

### Inspecting a Process's Memory Map

On Linux, `/proc/PID/maps` shows the complete virtual address space layout:

```bash
cat /proc/$(pgrep myserver)/maps
```

Example output:

```
55a3e2b00000-55a3e2c00000 r-xp 00000000 fd:01 1234567 /usr/bin/myserver
55a3e2e00000-55a3e2e10000 r--p 00100000 fd:01 1234567 /usr/bin/myserver
55a3e2e10000-55a3e2e20000 rw-p 00110000 fd:01 1234567 /usr/bin/myserver
55a3e3000000-55a3e4000000 rw-p 00000000 00:00 0        [heap]
7f8b4c000000-7f8b4c200000 rw-p 00000000 00:00 0
7f8b4c200000-7f8b4d000000 r-xp 00000000 fd:01 2345678 /lib/x86_64-linux-gnu/libc.so.6
7f8b4d200000-7f8b4d210000 r--p 00200000 fd:01 2345678 /lib/x86_64-linux-gnu/libc.so.6
7f8b4d210000-7f8b4d212000 rw-p 00210000 fd:01 2345678 /lib/x86_64-linux-gnu/libc.so.6
7ffd3a000000-7ffd3a200000 rw-p 00000000 00:00 0        [stack]
7ffd3a2f4000-7ffd3a2f8000 r--p 00000000 00:00 0        [vvar]
7ffd3a2f8000-7ffd3a2fa000 r-xp 00000000 00:00 0        [vdso]
```

Fields: start-end address, permissions (rwx, p=private/s=shared), file offset, device, inode, name.

In Go, read your own maps:

```go
package main

import (
    "bufio"
    "fmt"
    "os"
)

func printMemoryMap() error {
    f, err := os.Open("/proc/self/maps")
    if err != nil {
        return err
    }
    defer f.Close()
    sc := bufio.NewScanner(f)
    for sc.Scan() {
        fmt.Println(sc.Text())
    }
    return sc.Err()
}
```

### C++ Example: Observing Segment Location

```cpp
#include <cstdio>
#include <cstdlib>
#include <cstdint>

// Text segment: the code itself

// Data segment: initialized globals
int initialized_global = 100;

// BSS segment: uninitialized globals
static char large_buffer[64 * 1024];  // 64KB, zero, not in binary

void demo() {
    // Stack: local variables
    int stack_var = 42;

    // Heap: dynamic allocation
    int* heap_var = new int(99);

    printf("text   (function ptr):  %p\n", (void*)demo);
    printf("data   (init global):   %p\n", (void*)&initialized_global);
    printf("bss    (buffer):        %p\n", (void*)large_buffer);
    printf("stack  (local var):     %p\n", (void*)&stack_var);
    printf("heap   (new int):       %p\n", (void*)heap_var);

    delete heap_var;
}

int main() {
    demo();
}
```

On x86-64 Linux you will see addresses in roughly the order: text < data/BSS < heap < stack (which is at a very high address). The mmap region (shared libs) sits between heap and stack.

### Go Runtime Layout

Go's runtime does not map directly to the C segment model. The Go runtime:
- Loads the executable text into the text region.
- Uses a single large virtual address reservation (typically 256GB on 64-bit) for the heap, managed by its own arena-based allocator.
- Allocates goroutine stacks individually via `mmap`, starting at 8KB and growing by doubling (up to a configurable maximum, default 1GB).
- Manages static variables in data/BSS per the ELF layout.

```bash
# Show Go process maps including goroutine stacks:
cat /proc/$(pgrep mygoserver)/maps | grep -v "\.so" | sort
```

**Watch:** [Memory Segments in C/C++](https://www.youtube.com/watch?v=2htbIR2QpaM), recommended for visual learners.
