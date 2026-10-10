## 102Q.5 TinyGo for Ultra-Small Deployments

TinyGo produces much smaller binaries by using a different runtime and garbage collector. Unlike the standard `gc` compiler which bundles a full runtime including a goroutine scheduler and precise GC, TinyGo employs a simpler conservative GC and leaner scheduler optimized for constrained environments. This makes TinyGo binaries viable for microcontrollers with as little as 16 KB of flash and for WASM modules where download size matters. Not all of Go's standard library is supported, but the language syntax and core concurrency primitives work, making the transition from standard Go straightforward for most use cases.

```go
// Compatible with TinyGo
package main

import (
	"fmt"
	"machine"
	"time"
)

// TinyGo targets:
// - Microcontrollers (Arduino, BBC micro:bit, Raspberry Pi Pico)
// - WASM (browser + WASI)
// - Linux (small binaries)

// LED blink for microcontroller
func blinkLED() {
	led := machine.LED
	led.Configure(machine.PinConfig{Mode: machine.PinOutput})

	for {
		led.High()
		time.Sleep(500 * time.Millisecond)
		led.Low()
		time.Sleep(500 * time.Millisecond)
	}
}

func main() {
	fmt.Println("TinyGo running")
	blinkLED()
}
```

```bash
# Install TinyGo
# https://tinygo.org/getting-started/install/

# Build for WASM (tiny!)
tinygo build -o tiny.wasm -target=wasm ./

# Size comparison:
# Standard Go WASM: ~2MB
# TinyGo WASM:      ~50KB

# Build for microcontroller
tinygo flash -target=arduino-nano ./blink/

# Build for Linux (small binary)
tinygo build -o tiny-app -target=linux ./
# Result: ~200KB vs ~3MB for go build
```

### TinyGo WASM with Custom Runtime

When TinyGo functions are exported with the `//export` directive, the resulting WASM module exposes them as bare WebAssembly exports that JavaScript can call directly, without loading the `wasm_exec.js` shim that standard Go WASM requires. This eliminates several hundred kilobytes of glue code and produces a module that integrates cleanly with any WASM host, not just a Go-aware one. Passing strings across the boundary requires manual memory management: the Go side must allocate a shared buffer and return a pointer, since WASM linear memory is directly accessible from JavaScript via the `memory` export.

```go
//go:build tinygo

package main

import (
	"slices"
	"unsafe"
)

// TinyGo WASM exports for direct JS interop (no wasm_exec.js overhead)

//export add
func add(a, b int32) int32 {
	return a + b
}

//export fibonacci
func fibonacci(n int32) int32 {
	if n <= 1 {
		return n
	}
	a, b := int32(0), int32(1)
	for i := int32(2); i <= n; i++ {
		a, b = b, a+b
	}
	return b
}

// Memory management for passing strings
var (
	stringBuf []byte
)

//export allocBuffer
func allocBuffer(size int32) unsafe.Pointer {
	stringBuf = make([]byte, size)
	return unsafe.Pointer(&stringBuf[0])
}

//export processString
func processString(ptr unsafe.Pointer, length int32) int32 {
	input := string((*[1 << 20]byte)(ptr)[:length:length])
	result := reverseString(input)
	copy(stringBuf, result)
	return int32(len(result))
}

func reverseString(s string) string {
	runes := []rune(s)
	slices.Reverse(runes)
	return string(runes)
}

func main() {}
```

```javascript
// Minimal JS loader for TinyGo WASM (no wasm_exec.js needed for exports)
const wasm = await WebAssembly.instantiateStreaming(fetch('tiny.wasm'));
const { add, fibonacci, allocBuffer, processString, memory } = wasm.instance.exports;

console.log('add(3, 4):', add(3, 4));        // 7
console.log('fib(10):', fibonacci(10));         // 55

// Pass string to Go
function goProcessString(input) {
  const enc = new TextEncoder();
  const bytes = enc.encode(input);
  const ptr = allocBuffer(bytes.length);
  new Uint8Array(memory.buffer).set(bytes, ptr);
  const resultLen = processString(ptr, bytes.length);
  const result = new Uint8Array(memory.buffer, ptr, resultLen);
  return new TextDecoder().decode(result);
}

console.log(goProcessString("Hello, Go!")); // "!oG ,olleH"
```

---

### Junior → FAANG: TinyGo Compatibility as the First Question Before Using It

The critical first step with TinyGo is checking compatibility. TinyGo does not support all of Go's standard library. Packages that rely on reflection, `net` (in most WASM targets), `os` filesystem access, or goroutine scheduling beyond basic usage will either fail to compile or produce incorrect behavior. Before committing to TinyGo for a project, compile the specific code paths you intend to use and verify the binary size and behavior match expectations.

The binary size benefit of TinyGo is real and significant: a minimal HTTP handler compiled with TinyGo for WASM is typically 50-200KB versus 2-10MB with the standard `gc` compiler. For edge deployments where the binary is distributed to hundreds of PoPs and loaded per cold start, this difference matters. For Lambda deployments where the binary is loaded once per container lifecycle from S3, the size difference matters less than you might expect (S3 download speed is the bottleneck, not binary size for anything under 10MB).

### Senior @ FAANG: TinyGo Target Selection and the Maintenance Cost of Compatibility Shims

At staff level, the TinyGo adoption decision involves a maintenance cost that standard Go does not have: the compatibility surface. When you build a service with TinyGo, you are committing to maintaining compatibility shims for any standard library functionality your code needs that TinyGo does not support. These shims add code complexity, testing surface, and upgrade risk (TinyGo version updates may change compatibility behavior).

The organizational decision framework for TinyGo: use it when binary size is a hard constraint that the standard compiler cannot meet after stripping and compression, and when the code paths to be compiled are simple enough to fall entirely within TinyGo's compatibility boundary. Do not use it for services with complex business logic that uses reflection, fmt, or net packages, because the compatibility shim maintenance cost exceeds the binary size benefit.

The TinyGo project's compatibility matrix improves with each release. The staff engineer's responsibility is to evaluate TinyGo compatibility at each major release version against the organization's actual code, not against synthetic examples. A quarterly TinyGo upgrade benchmark, compiling the organization's edge functions with the new TinyGo version and measuring binary size, runtime correctness, and build time against the previous version, provides the evidence base for upgrade decisions. The benchmark also surfaces regressions: cases where a TinyGo update changes behavior that was previously working, which must be caught before production deployment.
