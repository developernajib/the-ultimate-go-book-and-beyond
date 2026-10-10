## 102Q.4 WebAssembly (WASM)

### Standard WASM (Browser Target)

Go compiles to a browser-runnable WASM module using the `js` and `wasm` build tags, exposing Go functions to JavaScript via the `syscall/js` package. The key mechanism is `js.FuncOf`, which wraps a Go function into a JavaScript-callable value, bridging Go's type system with the browser's dynamic runtime. For asynchronous work, Go goroutines are wrapped in a `Promise` constructor so callers can `await` them naturally, while bulk data is exchanged through shared `Uint8Array` buffers using `js.CopyBytesToGo` and `js.CopyBytesToJS` to avoid the cost of JSON serialization for binary payloads.

```go
//go:build js && wasm

package main

import (
	"encoding/json"
	"fmt"
	"syscall/js"
)

// Expose a Go function to JavaScript
func fibonacci(this js.Value, args []js.Value) any {
	if len(args) == 0 {
		return js.ValueOf(-1)
	}
	n := args[0].Int()
	return js.ValueOf(fib(n))
}

func fib(n int) int {
	if n <= 1 {
		return n
	}
	a, b := 0, 1
	for i := 2; i <= n; i++ {
		a, b = b, a+b
	}
	return b
}

// DOM manipulation from Go
func updateElement(this js.Value, args []js.Value) any {
	if len(args) < 2 {
		return nil
	}
	id := args[0].String()
	content := args[1].String()

	doc := js.Global().Get("document")
	el := doc.Call("getElementById", id)
	if el.IsNull() {
		fmt.Printf("element #%s not found\n", id)
		return nil
	}
	el.Set("innerHTML", content)
	return nil
}

// Async Go function returning a Promise
func fetchAndProcess(this js.Value, args []js.Value) any {
	handler := js.FuncOf(func(this js.Value, promiseArgs []js.Value) any {
		resolve := promiseArgs[0]
		reject := promiseArgs[1]

		go func() {
			// Simulate async work
			result, err := doAsyncWork(args[0].String())
			if err != nil {
				reject.Invoke(err.Error())
				return
			}
			resolve.Invoke(result)
		}()
		return nil
	})

	return js.Global().Get("Promise").New(handler)
}

func doAsyncWork(input string) (string, error) {
	// Process input
	result := map[string]string{
		"processed": input,
		"status":    "ok",
	}
	b, err := json.Marshal(result)
	if err != nil {
		return "", err
	}
	return string(b), nil
}

// Memory sharing: pass large data via shared buffer
func processBuffer(this js.Value, args []js.Value) any {
	if len(args) == 0 {
		return nil
	}

	// Get Uint8Array from JS
	jsArray := args[0]
	length := jsArray.Get("length").Int()
	buf := make([]byte, length)
	js.CopyBytesToGo(buf, jsArray)

	// Process
	for i := range buf {
		buf[i] = buf[i] ^ 0xFF // XOR transform
	}

	// Write back
	js.CopyBytesToJS(jsArray, buf)
	return jsArray
}

func main() {
	c := make(chan struct{}, 0)

	js.Global().Set("goFib", js.FuncOf(fibonacci))
	js.Global().Set("goUpdateElement", js.FuncOf(updateElement))
	js.Global().Set("goFetchAndProcess", js.FuncOf(fetchAndProcess))
	js.Global().Set("goProcessBuffer", js.FuncOf(processBuffer))

	fmt.Println("Go WASM initialized")
	<-c // Block forever (keep WASM alive)
}
```

```html
<!-- index.html -->
<!DOCTYPE html>
<html>
<head><title>Go WASM Demo</title></head>
<body>
<script src="wasm_exec.js"><\/script>
<script>
async function loadWASM() {
  const go = new Go();
  const result = await WebAssembly.instantiateStreaming(
    fetch('main.wasm'), go.importObject
  );
  go.run(result.instance);
}

loadWASM().then(() => {
  // Now Go functions are available globally
  console.log('Fib(10):', goFib(10)); // 55
  goUpdateElement('output', '<b>Hello from Go!</b>');
});
<\/script>
<div id="output">Loading...</div>
</body>
</html>
```

### WASI: WebAssembly System Interface

WASI enables WASM to run outside browsers with file system, network, and environment access.

```go
//go:build wasip1

// cmd/wasi/main.go - runs in any WASI runtime (wasmtime, wasmer, wazero)
package main

import (
	"bufio"
	"encoding/json"
	"fmt"
	"os"
	"strings"
)

type Record struct {
	Name  string `json:"name"`
	Score int    `json:"score"`
}

func main() {
	// WASI: file I/O works normally
	if len(os.Args) < 2 {
		fmt.Fprintln(os.Stderr, "usage: process <input.jsonl>")
		os.Exit(1)
	}

	f, err := os.Open(os.Args[1])
	if err != nil {
		fmt.Fprintf(os.Stderr, "open: %v\n", err)
		os.Exit(1)
	}
	defer f.Close()

	var records []Record
	scanner := bufio.NewScanner(f)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" {
			continue
		}
		var r Record
		if err := json.Unmarshal([]byte(line), &r); err != nil {
			fmt.Fprintf(os.Stderr, "parse error: %v\n", err)
			continue
		}
		records = append(records, r)
	}

	// Process: find top scorer
	if len(records) == 0 {
		fmt.Println("no records")
		return
	}

	top := records[0]
	for _, r := range records[1:] {
		if r.Score > top.Score {
			top = r
		}
	}

	result, _ := json.Marshal(map[string]any{
		"top_scorer": top.Name,
		"score":      top.Score,
		"total":      len(records),
	})
	fmt.Println(string(result))
}
```

```bash
# Build for WASI
GOOS=wasip1 GOARCH=wasm go build -o process.wasm ./cmd/wasi/

# Run with wasmtime
wasmtime --dir=. process.wasm data.jsonl

# Run with wazero (pure Go WASM runtime)
go run github.com/tetratelabs/wazero/cmd/wazero run --mount=.:/ process.wasm /data.jsonl
```

### Embedding WASM with wazero

wazero is a zero-dependency, pure-Go WebAssembly runtime that lets you run WASM modules as in-process plugins without spawning subprocesses or linking against a C runtime. The key performance technique is `CompileModule`, which AOT-compiles the WASM bytecode once and caches the result so subsequent instantiations are fast, critical for plugin systems that execute the same module per request. Each `InstantiateModule` call gets its own isolated memory space, providing sandbox-level isolation between plugin invocations while sharing the compiled code.

```go
package wasm

import (
	"bytes"
	"context"
	_ "embed"
	"fmt"
	"os"
	"sync"

	"github.com/tetratelabs/wazero"
	"github.com/tetratelabs/wazero/imports/wasi_snapshot_preview1"
)

//go:embed process.wasm
var wasmFile []byte

// WASMPlugin wraps a WASM module for in-process execution
type WASMPlugin struct {
	runtime wazero.Runtime
	module  wazero.CompiledModule
}

// NewWASMPlugin compiles and caches a WASM module
func NewWASMPlugin(ctx context.Context) (*WASMPlugin, error) {
	r := wazero.NewRuntimeWithConfig(ctx, wazero.NewRuntimeConfigCompiler())

	// Add WASI support
	wasi_snapshot_preview1.MustInstantiate(ctx, r)

	// Compile module (cached)
	compiled, err := r.CompileModule(ctx, wasmFile)
	if err != nil {
		return nil, fmt.Errorf("compile wasm: %w", err)
	}

	return &WASMPlugin{
		runtime: r,
		module:  compiled,
	}, nil
}

// Execute runs the WASM module with given input and returns output
func (p *WASMPlugin) Execute(ctx context.Context, input []byte) ([]byte, error) {
	// Capture stdout
	var stdout bytes.Buffer
	var stderr bytes.Buffer

	config := wazero.NewModuleConfig().
		WithStdin(bytes.NewReader(input)).
		WithStdout(&stdout).
		WithStderr(&stderr).
		WithArgs("plugin", "--stdin")

	mod, err := p.runtime.InstantiateModule(ctx, p.module, config)
	if err != nil {
		return nil, fmt.Errorf("instantiate: %w, stderr: %s", err, stderr.String())
	}
	defer mod.Close(ctx)

	return stdout.Bytes(), nil
}

// Close releases resources
func (p *WASMPlugin) Close(ctx context.Context) error {
	return p.runtime.Close(ctx)
}

// Plugin system: load plugins from disk
type PluginManager struct {
	plugins map[string]*WASMPlugin
	mu      sync.RWMutex
}

func NewPluginManager() *PluginManager {
	return &PluginManager{
		plugins: make(map[string]*WASMPlugin),
	}
}

func (pm *PluginManager) LoadPlugin(ctx context.Context, name, path string) error {
	data, err := os.ReadFile(path)
	if err != nil {
		return fmt.Errorf("read plugin %s: %w", name, err)
	}

	r := wazero.NewRuntimeWithConfig(ctx, wazero.NewRuntimeConfigCompiler())
	wasi_snapshot_preview1.MustInstantiate(ctx, r)

	compiled, err := r.CompileModule(ctx, data)
	if err != nil {
		return fmt.Errorf("compile plugin %s: %w", name, err)
	}

	pm.mu.Lock()
	defer pm.mu.Unlock()
	pm.plugins[name] = &WASMPlugin{runtime: r, module: compiled}
	return nil
}

func (pm *PluginManager) Execute(ctx context.Context, name string, input []byte) ([]byte, error) {
	pm.mu.RLock()
	plugin, ok := pm.plugins[name]
	pm.mu.RUnlock()
	if !ok {
		return nil, fmt.Errorf("plugin %s not found", name)
	}
	return plugin.Execute(ctx, input)
}
```

---

### Junior → FAANG: WASM Memory and the Linear Memory Model

The most important mental model for Go-to-WASM compilation is that WASM modules operate in a linear memory space that is separate from the host JavaScript or runtime memory. You cannot pass Go strings or slices directly to JavaScript host functions because Go pointers are addresses within the WASM linear memory, not JavaScript heap pointers. All data crossing the WASM/host boundary must be explicitly serialized: write data into WASM linear memory, pass the pointer and length to the host, and have the host read the data from that memory range.

This explains the pattern of passing pointers and lengths across the boundary in the examples above. Understanding it prevents a class of subtle bugs where engineers assume JavaScript strings and Go strings are interchangeable across the boundary, resulting in garbled data or memory access violations.

First-job habit: before building a WASM-based plugin system, measure the serialization overhead. Calling a Go function from JavaScript via WASM has a non-trivial overhead (typically 1-5 microseconds for the boundary crossing plus serialization time). For functions called thousands of times per render cycle, this overhead is significant. WASM is appropriate for computationally intensive operations where the computation time dominates the boundary crossing overhead.

### Senior @ FAANG: WASM Plugin Architecture and Security Boundary Design

At staff level, the WASM plugin system pattern in this section is an architectural primitive for building extensible platforms that accept untrusted code. The security properties of WASM make it attractive for plugin systems: a WASM module cannot access host memory outside its own linear memory space, cannot make system calls directly, and can only call host functions that the host explicitly exports to it. These properties make WASM sandboxing significantly stronger than native dynamic libraries (which share the host process memory space) and significantly more efficient than process isolation (which requires a separate process per plugin).

The organizational use cases for WASM plugin systems at scale: data transformation pipelines where customers provide transformation logic (analytics platforms, ETL tools), policy enforcement systems where security rules are compiled to WASM and evaluated at request time (API gateways, OPA Wasm policies), and game or simulation engines where user-authored scripts run inside the game loop. Each of these use cases requires a capability design: what host functions does the WASM module have access to, and what are the resource limits (memory, CPU time, number of host function calls per invocation)?

The Wasmtime and wazero runtimes for server-side WASM have different performance and security tradeoffs. Wasmtime uses Cranelift for JIT compilation, producing near-native execution speed at the cost of compilation time and memory. Wazero is a pure-Go interpreter and compiler with no CGO dependency, producing lower peak performance but easier embedding in Go services and simpler cross-compilation. The platform choice between them should be driven by benchmarks against the organization's actual plugin workload, not by headline benchmark numbers. A plugin that performs string manipulation is bottlenecked by serialization, not execution speed, making Wasmtime's JIT advantage irrelevant. A plugin that performs numerical computation will see Wasmtime's JIT providing a meaningful speedup.
