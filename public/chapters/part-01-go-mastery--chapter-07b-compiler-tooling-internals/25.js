export default `# Executable Formats, ABI, and OS Portability

You compile a Go program on Linux, copy the binary to another Linux machine, and it runs. You
copy that same binary to macOS and it crashes immediately. This happens even when both machines
use the same x86-64 CPU. The question "why?" exposes a stack of compatibility layers that most
developers never examine directly.

## The Wrong Answer: CPU Architecture

The instinctive answer is CPU architecture. If Linux is x86-64 and macOS is arm64, that explains
the incompatibility. But the incompatibility existed even when most Macs ran on Intel x86-64,
the same hardware as your Linux box. You can run Windows and Linux side by side on the same
physical machine, yet a Windows \`.exe\` will not execute on Linux even though both see the same
CPU registers. Architecture is one factor. It is not the only one.

## System Calls: The First Layer of Incompatibility

User programs cannot touch hardware directly. The CPU enforces two privilege levels: user mode
and kernel mode. Your application code runs in user mode. When it needs to read a file, open a
socket, or allocate memory, it asks the kernel via a system call. The kernel executes the
privileged operation and returns a result.

Each operating system defines its own set of system calls, and each call is identified by an
integer number. Here is where the first incompatibility appears.

On Linux x86-64, \`read\` is syscall number 0. On macOS x86-64, \`read\` is syscall number 3. A
compiled binary that writes \`0\` into the syscall register and fires a software interrupt is asking
Linux to do a \`read\`. On macOS, the same instruction sequence asks for something entirely
different, producing garbage results or a crash.

The mismatch is not just naming. Even when two operating systems expose the same logical call,
the mechanics differ. On Windows, \`CreateProcess\` takes a path to an executable. On Unix,
creating a new process requires \`fork\` to clone the caller, then \`exec\` to replace the clone's
image with a new program. One operation on Windows maps to two on Linux. Machine code compiled
for one model has no meaning on the other.

You can see Linux's syscall table in the kernel source at
\`arch/x86/entry/syscalls/syscall_64.tbl\`. The table makes clear how many calls exist and how
their numbering is fixed to a specific kernel version and architecture.

## Calling Conventions: The Second Layer

Even if two operating systems used identical syscall numbers, they could still disagree on how
to pass arguments. Before triggering a system call, a program must place the syscall number and
its arguments somewhere the kernel can find them. Where exactly?

On Linux x86-64, the convention is:
- Syscall number in \`rax\`
- Arguments 1-6 in \`rdi\`, \`rsi\`, \`rdx\`, \`r10\`, \`r8\`, \`r9\` (in that order)
- Arguments beyond six go to a memory block pointed to by one of the registers

On macOS, the registers differ. If your binary follows the Linux convention and macOS reads a
different register for the first argument, it gets the wrong value. The kernel proceeds with
corrupted inputs.

These conventions, taken together, form the **Application Binary Interface** (ABI). An ABI is to
binary code what an API is to source code. It specifies: which registers carry arguments, which
registers a caller must preserve across a function call, how the stack frame is laid out, how
struct fields are aligned, and how return values are communicated back.

The ABI is architecture-specific AND operating-system-specific. Linux x86-64 and Windows x86-64
share an instruction set but use different ABIs. This is why a Windows \`.dll\` cannot be directly
loaded on Linux even if both are running on the same Intel chip.

Go has its own internal ABI for calls between Go functions (documented as \`ABI0\` and \`ABIInternal\`
in the compiler). When you use \`cgo\` to call C code, the Go runtime bridges from Go's internal
calling convention to the C ABI expected by the platform. Without that bridge, a C function would
read the wrong registers and crash or return garbage.

## Executable Formats: The Third Layer

A compiled binary is not just raw machine code. The operating system needs to know where the code
lives in the file, where the data lives, which external libraries to load, and where execution
should begin. Each OS defines a file format that encodes this metadata.

**ELF (Executable and Linkable Format)** is used on Linux and most Unix systems. An ELF file starts
with a magic number (\`0x7f 0x45 0x4c 0x46\`, which is \`\\x7fELF\`) followed by a header that
specifies architecture, entry point, and offsets to the program header table. The program header
table lists segments: the \`LOAD\` segment tells the kernel which bytes to map into memory and at
what virtual address. The \`.text\` section holds code. The \`.data\` section holds initialized
globals. The \`.bss\` section marks uninitialized globals (zero-initialized at load time). The
symbol table and relocation entries allow the dynamic linker to wire up external function calls.

**PE/COFF (Portable Executable / Common Object File Format)** is used on Windows. A PE file
starts with the legacy DOS stub (\`MZ\` header), followed by the PE signature, the COFF header,
and the optional header which carries the entry point and the preferred load address. PE sections
map roughly to ELF sections: \`.text\`, \`.data\`, \`.rdata\` (read-only data), \`.bss\`. The import
table replaces ELF's relocation entries for external calls.

**Mach-O** is used on macOS and iOS. A Mach-O file opens with a magic number and a header that
lists load commands. Load commands describe segments (\`__TEXT\`, \`__DATA\`), tell the dynamic
linker which libraries to load (\`LC_LOAD_DYLIB\`), and specify the entry point (\`LC_MAIN\`).

When the OS kernel receives an \`exec\` syscall, it reads the first bytes of the file to detect the
format, then hands control to the appropriate loader. Linux looks for the ELF magic bytes. macOS
looks for the Mach-O magic. A PE binary has neither, so Linux's ELF loader rejects it at the
format check stage, before any code runs.

## The Dynamic Linker

Most programs on traditional systems do not bundle all their dependencies. They reference shared
libraries: \`.so\` files on Linux, \`.dll\` files on Windows, \`.dylib\` files on macOS. The dynamic
linker (also called the dynamic loader) resolves these references at load time.

On Linux, \`ld.so\` (or \`ld-linux-x86-64.so.2\`) reads the ELF's \`DYNAMIC\` segment, finds the list
of required shared objects, locates them in \`/lib\` or \`/usr/lib\`, maps them into the process's
address space, and patches the program's Global Offset Table (GOT) with the resolved addresses.

If the required \`.so\` is not present, the program fails to start even though the binary itself is
intact. This is why "works on my machine" bugs exist: the developer's machine has the library.the deployment target does not.

## How Go Solves This

Go compiles to a statically linked binary by default on most platforms. The Go runtime implements
its own system call wrappers using the \`syscall\` package, which issues syscalls directly using the
number and calling convention appropriate for the current \`GOOS\`/\`GOARCH\` pair. There is no
dependency on \`glibc\`, \`musl\`, or any other C standard library.

The \`GOOS\` and \`GOARCH\` environment variables tell the Go compiler which kernel ABI and executable
format to target. \`GOOS=linux GOARCH=amd64 go build\` produces an ELF binary with Linux syscall
numbers. \`GOOS=windows GOARCH=amd64 go build\` produces a PE binary with Windows API calls wired
through the appropriate shims.

Because Go's runtime handles syscalls itself and the binary has no external \`.so\` dependencies,
a Go binary built for \`linux/amd64\` will run on any Linux distribution that runs the same kernel
ABI, regardless of which C library (or which distro) is installed. This is why Go programs work
correctly in minimal Alpine Linux Docker containers that lack \`glibc\`. The Go binary does not need
\`glibc\` at all.

For CGO, Go disables this portability guarantee. \`CGO_ENABLED=1\` links against the host's C
library, reintroducing the glibc dependency. Alpine uses musl, not glibc. A CGO binary built on
Ubuntu and run in an Alpine container will fail at the dynamic linker stage. The fix is to disable
CGO (\`CGO_ENABLED=0\`) or to cross-compile with a musl toolchain.

## Inspecting Go Binaries

You can examine what a Go binary actually is using standard Unix tools:

\`\`\`bash
# Identify the file format
file ./myapp
# → myapp: ELF 64-bit LSB executable, x86-64, dynamically linked (if CGO), Go BuildID ...

# Read the ELF header
readelf -h ./myapp
# Shows: Magic, Class (64-bit), Data (little-endian), OS/ABI, Entry point address

# Show sections
readelf -S ./myapp | grep -E 'Name|\\.text|\\.data|\\.go'

# Disassemble the entry point
objdump -d ./myapp | head -60

# Check dynamic dependencies (CGO builds will have entries; pure Go builds show none)
ldd ./myapp
# Pure Go: "not a dynamic executable" or minimal list
# CGO: lists libc, libpthread, etc.
\`\`\`

For a pure Go binary, \`ldd\` reports no dynamic dependencies. For a CGO binary, it lists the
libraries that must be present on the target machine at runtime.

## The Portability Model in Practice

The full picture of why a binary is OS-specific:

1. **System call numbers** differ across kernels. The same integer means different operations.
2. **Calling conventions** differ. Arguments go in different registers or stack locations.
3. **Executable format** differs. The OS loader rejects files it does not understand.
4. **Dynamic linker paths** differ. The linker has a hardcoded path like \`/lib64/ld-linux-x86-64.so.2\`.
5. **Library APIs** differ. A Windows \`.dll\` exports different symbols than a Linux \`.so\`.

Go's approach of compiling \`GOOS\`/\`GOARCH\` pairs at build time and implementing syscalls directly
in the runtime eliminates layers 1, 2, 3, and 4 for pure Go code. Layer 5 only matters if you
call C libraries via CGO.

Understanding the ABI and executable format is the prerequisite for reading crash dumps, debugging
segfaults in CGO code, and knowing why your container image must match the OS your binary was
compiled for.

---

Watch the original video: https://www.youtube.com/watch?v=eP_P4KOjwhs
`;
