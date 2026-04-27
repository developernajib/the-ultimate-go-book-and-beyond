export default `## 7B.15 Advanced Toolchain Usage

### go vet and Analysis

\`go vet\` is Go's built-in static analysis tool that catches common mistakes the compiler does not flag. It runs a curated set of analyzers that check for issues like format string mismatches in \`fmt.Printf\`, copying of mutex values, unreachable code, and malformed struct tags. Each checker can be run individually by name, which is useful when you want to focus on a specific category of issues. In CI pipelines, \`go vet ./...\` should always run alongside your tests.

\`\`\`bash
# Built-in vet checks
go vet ./...

# Specific checkers
go vet -printf ./...    # format string mismatches
go vet -shadow ./...    # variable shadowing
go vet -tests ./...     # test function signatures
go vet -assign ./...    # useless assignments
go vet -atomic ./...    # misuse of sync/atomic
go vet -copylocks ./... # copying locked mutex/etc
go vet -lostcancel ./.. # context cancel not called
go vet -nilfunc ./...   # function == nil always false
go vet -structtag ./... # malformed struct tags
go vet -unmarshal ./... # incorrect JSON unmarshal
\`\`\`

### Assembler Integration

Go supports writing functions in assembly language for cases where you need maximum performance or access to CPU instructions not exposed by the Go compiler. You declare the function signature in a \`.go\` file without a body, then provide the implementation in a corresponding \`.s\` file using Go's Plan 9-style assembly syntax. This is how the standard library implements performance-critical functions like \`math.Float64bits\` and parts of \`crypto/aes\`. The \`//go:linkname\` directive provides another escape hatch by letting you call unexported functions from other packages, though this is fragile and should be used sparingly.

\`\`\`go
// file: math_amd64.go
package math

// add adds two int64 values using assembly
// implemented in math_amd64.s
func add(a, b int64) int64

// file: math_amd64.s
TEXT ·add(SB), NOSPLIT, \$0-24
    MOVQ a+0(FP), AX    // load first argument
    MOVQ b+8(FP), BX    // load second argument
    ADDQ BX, AX         // AX = AX + BX
    MOVQ AX, ret+16(FP) // store result
    RET
\`\`\`

\`\`\`go
// Linkname for accessing internal packages (USE WITH CAUTION)
package main

import (
	_ "unsafe" // required for go:linkname
)

//go:linkname nanotime runtime.nanotime
func nanotime() int64

func main() {
	// Access runtime internal function
	t := nanotime()
	println(t)
}
\`\`\`

### Profiling Integration

Integrating profiling directly into your application lets you collect CPU, memory, and execution trace data on demand, both during development and in production. The standard library's \`runtime/pprof\` package provides functions to start and stop CPU profiling, write heap profiles, and capture execution traces. A common pattern is to accept command-line flags like \`-cpuprofile\` and \`-memprofile\` that activate profiling when needed, then write the profile data to files that you can analyze with \`go tool pprof\` or \`go tool trace\`.

\`\`\`go
package main

import (
	"flag"
	"log"
	"os"
	"runtime"
	"runtime/pprof"
	"runtime/trace"
)

var (
	cpuprofile = flag.String("cpuprofile", "", "write cpu profile to file")
	memprofile = flag.String("memprofile", "", "write memory profile to file")
	traceout   = flag.String("trace", "", "write trace to file")
)

func initProfiling() func() {
	flag.Parse()

	var cleanups []func()

	if *cpuprofile != "" {
		f, err := os.Create(*cpuprofile)
		if err != nil {
			log.Fatal("could not create CPU profile:", err)
		}
		if err := pprof.StartCPUProfile(f); err != nil {
			log.Fatal("could not start CPU profile:", err)
		}
		cleanups = append(cleanups, func() {
			pprof.StopCPUProfile()
			f.Close()
			log.Println("CPU profile written to", *cpuprofile)
		})
	}

	if *traceout != "" {
		f, err := os.Create(*traceout)
		if err != nil {
			log.Fatal("could not create trace file:", err)
		}
		if err := trace.Start(f); err != nil {
			log.Fatal("could not start trace:", err)
		}
		cleanups = append(cleanups, func() {
			trace.Stop()
			f.Close()
			log.Println("trace written to", *traceout)
		})
	}

	return func() {
		for _, cleanup := range cleanups {
			cleanup()
		}

		if *memprofile != "" {
			f, err := os.Create(*memprofile)
			if err != nil {
				log.Fatal("could not create memory profile:", err)
			}
			defer f.Close()
			runtime.GC() // force GC to get accurate stats
			if err := pprof.WriteHeapProfile(f); err != nil {
				log.Fatal("could not write memory profile:", err)
			}
			log.Println("memory profile written to", *memprofile)
		}
	}
}

func main() {
	cleanup := initProfiling()
	defer cleanup()

	// Your application code here
	doWork()
}

func doWork() {
	// Simulate work
	data := make([]int, 1000000)
	for i := range data {
		data[i] = i * i
	}
}
\`\`\`

### Toolchain Flags That Earn Their Keep

Five flags every senior engineer should know:

1. **\`-trimpath\`.** Strips local path info from the binary. Required for reproducible builds.
2. **\`-ldflags="-s -w"\`.** Strips debug symbols. Saves 30% binary size.
3. **\`-ldflags="-X main.Version=\$(git rev-parse HEAD)"\`.** Injects build metadata. Visible via \`./binary -version\`.
4. **\`-gcflags="-m"\`.** Escape analysis output. First tool to reach for when diagnosing allocations.
5. **\`-race\`.** Data race detector. Slow (5-10x) but catches races that nothing else will.

---
`;
