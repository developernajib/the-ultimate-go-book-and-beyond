export default `# Interpreted vs Compiled: How Go Fits

## The Core Distinction

A **compiled** language takes source code and produces machine instructions that the CPU can execute directly. A **compiled program** is a file containing those machine instructions. When you run it, the OS loads those instructions into memory and the CPU begins fetching, decoding, and executing them.

An **interpreted** language works differently. The Python script \`main.py\` does not contain machine instructions. It is text. The CPU cannot run text. What actually happens when you type \`python main.py\`:

1. The OS loads the \`python\` executable into memory.
2. That executable is a compiled program (CPython is written in C).
3. The Python interpreter process starts.
4. The interpreter reads \`main.py\` as data, parses it into an internal tree structure, and then walks that tree, executing operations based on what it finds.

Your script never becomes a process. It becomes **data** that another process reads and acts on. A \`.py\` file is to the Python interpreter what an \`.xlsx\` file is to Excel: it does not run itself, it is consumed by another program.

---

## Interpreters Are Compiled Programs

This distinction matters: every interpreted language project is already a multi-language project. You just do not see the compiled layer because it ships pre-compiled as the interpreter binary.

- CPython (the reference Python interpreter) is written in C.
- Node.js (the JavaScript runtime) is written in C++.
- Ruby MRI is written in C.
- Lua is written in C.

When you run \`node main.js\`, you are starting a C++ process that reads your JavaScript and interprets it. The JavaScript itself never becomes machine code by default.

---

## Bytecode: A Middle Ground

Many "interpreted" languages compile to bytecode first, then interpret the bytecode:

**CPython:** parses Python source to bytecode (\`.pyc\` files), then the interpreter executes the bytecode. Bytecode is faster to interpret than raw source because parsing is done once.

**Java/JVM:** \`javac\` compiles Java source to JVM bytecode (\`.class\` files). The JVM then interprets bytecode and, for hot paths, uses a JIT (Just-In-Time) compiler to generate native machine instructions. A long-running JVM process produces native code for the methods called most frequently.

**Go:** does **not** use a JVM or bytecode layer. The \`go build\` tool compiles directly to native machine code in the target architecture's instruction set. There is no bytecode, no JIT, no virtual machine at runtime.

---

## Where Go Fits

Go is fully compiled to native machine code. Running:

\`\`\`bash
go build -o myapp ./cmd/myapp
\`\`\`

Produces a standalone ELF binary (on Linux) or PE binary (on Windows) with no external runtime dependency beyond the OS itself. The Go runtime (scheduler, GC, stack management) is statically linked into the binary.

\`\`\`bash
# Confirm: no dynamic interpreter dependency
file ./myapp
# myapp: ELF 64-bit LSB executable, x86-64, dynamically linked

ldd ./myapp
# On a purely static Go binary with CGo disabled:
# GOFLAGS=-v go build -tags netgo -ldflags '-extldflags "-static"' -o myapp .
# ldd: not a dynamic executable

# Default Go binary links libc dynamically on Linux for DNS and user lookups
# (when CGo is enabled, which is the default)
# Disable CGo for a fully static binary:
CGO_ENABLED=0 go build -o myapp .
\`\`\`

With \`CGO_ENABLED=0\`, the resulting binary carries everything it needs. You can copy it to any compatible Linux system and run it. This is why Go is popular for containerized deployments: \`COPY ./myapp /app/myapp\` in a scratch Dockerfile produces a working image.

---

## The Compilation Pipeline

Go's build pipeline, in order:

1. **Lexing and parsing:** source files are tokenized and parsed into an AST (Abstract Syntax Tree).
2. **Type checking:** the AST is type-checked. Errors like calling a method on the wrong type are caught here.
3. **SSA construction:** the typed AST is lowered to Static Single Assignment (SSA) form, an intermediate representation used for optimization.
4. **Machine code generation:** SSA is compiled to native instructions for the target architecture (GOARCH).
5. **Linking:** object files from all packages plus the runtime are linked into the final binary.

You can inspect intermediate stages:

\`\`\`bash
# View the SSA form
GOSSAFUNC=main go build .
# Creates ssa.html in current directory

# View the generated assembly
go build -gcflags="-S" ./... 2>&1 | head -50

# View what the linker includes
go build -v ./...
\`\`\`

---

## CGo: Calling C from Go

Go can call C code using CGo. The mechanism relies on the C ABI (Application Binary Interface): a convention for how functions pass arguments and return values at the machine instruction level.

A minimal CGo example:

\`\`\`go
package main

/*
#include <stdio.h>
#include <stdlib.h>

void hello(const char* name) {
    printf("Hello from C, %s\\n", name);
}
*/
import "C"
import "unsafe"

func main() {
    cs := C.CString("Go")
    defer C.free(unsafe.Pointer(cs))
    C.hello(cs)
}
\`\`\`

What happens at compile time:
1. \`go build\` detects the \`import "C"\` and invokes the C compiler (gcc or clang) on the embedded C code.
2. The C code is compiled to an object file.
3. The linker links the C object file with the Go object files.
4. The final binary contains both Go and C machine code.

At runtime, calling \`C.hello(cs)\` causes the Go runtime to switch from a goroutine stack to a C-compatible OS thread stack, call the C function, and return. The Go scheduler does not run during C execution, the goroutine blocks for the duration.

---

## The ABI: Why Two Languages Can Talk

Two compiled languages can coexist in one binary only if they agree on calling conventions, the ABI. The ABI specifies:

- Which registers carry function arguments and return values.
- What the caller vs callee is responsible for saving/restoring.
- How structs are passed (by value in registers, or by pointer).
- Name mangling rules (how function names appear in the symbol table).

C has a stable, well-documented ABI on each platform (the System V AMD64 ABI on Linux x86-64). Most languages that want to interoperate with the ecosystem declare an \`extern "C"\` or equivalent binding that disables name mangling and switches to the C calling convention.

In Go, CGo functions use the C calling convention at the boundary. Inside Go code, Go uses its own internal ABI (which has changed over versions for better performance). The \`//go:linkname\` directive and \`//export\` comment expose or import symbols at the C ABI level.

In Rust, \`extern "C" fn foo()\` produces a function using the C calling convention. In Fortran, \`BIND(C)\` does the same.

---

## WASM: A Portable Bytecode Target for Go

WebAssembly (WASM) is a binary instruction format designed to run in browsers and server-side runtimes (Deno, Wasmtime, WASI). It is, in effect, a portable bytecode with a well-defined virtual machine model.

Go supports WASM as a compilation target:

\`\`\`bash
GOOS=wasip1 GOARCH=wasm go build -o main.wasm ./cmd/main

# Run with wasmtime
wasmtime main.wasm

# Or with wasm_exec.js in a browser
\`\`\`

The \`GOOS=wasip1 GOARCH=wasm\` target compiles Go source to WebAssembly binary format. The Go runtime is included in the \`.wasm\` file. The WASM runtime (browser, wasmtime, wasmer) provides a sandboxed execution environment.

WASM is useful for:
- Running Go code in browsers (though TinyGo produces smaller binaries for this use case).
- Deploying serverless functions in WASM-based runtimes (Cloudflare Workers, Fermyon Spin).
- Safe plugin systems where untrusted code runs in an isolated WASM sandbox.

The key point: WASM is not interpreted in the traditional sense. Browsers and runtimes typically compile WASM to native machine code using a JIT or AOT compiler. The WASM format is the intermediate representation, not the final executed form. Go's \`GOOS=wasip1\` output is real Go code compiled to WASM bytecode, which the host runtime then compiles or interprets to native instructions.

---

## Summary

| Property | Interpreted (Python/JS) | JVM/CLR (Java/C#) | Go |
|----------|------------------------|-------------------|----|
| Runtime required? | Yes (the interpreter) | Yes (JVM/CLR) | No (runtime statically linked) |
| Bytecode? | Optional (.pyc) | Yes (.class) | No |
| JIT? | Rarely (PyPy) | Yes | No |
| Native binary? | No | No (JARs) | Yes |
| C interop | Via FFI/ctypes | Via JNI | Via CGo |
| Cold start | Fast | Slow (JVM warmup) | Fast |
| Static binary | No | No | Yes (CGO_ENABLED=0) |

Go's model gives you the simplicity of a scripting language's build experience (\`go run main.go\`) with the output of a fully native compiled binary. There is no warmup period, no JIT compilation, no garbage collected heap in the JVM sense (though Go has its own GC). Your program is machine code from the first instruction.

**Watch:** [Why interpreters are just compiled programs](https://www.youtube.com/watch?v=RnBOOF502p0)

**Watch:** [Low-level concepts: multi-language projects and the linker](https://www.youtube.com/watch?v=XJC5WB2Bwrc)
`;
