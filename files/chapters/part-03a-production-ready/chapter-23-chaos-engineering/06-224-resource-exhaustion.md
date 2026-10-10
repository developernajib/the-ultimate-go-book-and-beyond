## 23.4 Resource Exhaustion

Resource exhaustion happens when your application runs out of memory, CPU cycles, file descriptors, or other system resources. These failures are especially insidious because they often cause cascading problems: a memory-starved service responds slowly, which causes upstream callers to accumulate goroutines waiting for responses, which exhausts their memory in turn. The implementations below let you simulate memory pressure, CPU saturation, and file descriptor exhaustion in a controlled way so you can test whether your service degrades gracefully or crashes entirely.

These three injectors share a property that makes them more dangerous than the network and HTTP ones: they attack the process running them. An HTTP fault injector can always serve its own abort endpoint. A process that has consumed every file descriptor cannot open a socket to accept the request telling it to stop. Design the abort switch accordingly, which in practice means an in-process timer armed before the injection starts, never a control plane the injection can starve.

### Memory Pressure

`MemoryPressure` allocates a large byte slice and writes one byte per page, which forces the kernel to back the allocation with real physical memory rather than leaving it as untouched zero pages that never become resident. Residency is the point. What you are simulating is the process pushing its RSS toward a cgroup limit, and the failure you are hunting is the OOM killer arriving mid-request.

Be precise about what this does to the garbage collector, because the intuition runs backwards. A ballast is *live* memory. Under `GOGC` alone, a larger live heap means a *higher* next-GC target, so a ballast makes collections less frequent, not more. That is exactly why the ballast trick was popularised as a GC tuning knob in the first place. Under `GOMEMLIMIT`, the same ballast eats the budget and drives GC harder. So the honest description is that this injector simulates memory *scarcity*, and its effect on GC frequency depends entirely on which of the two knobs your service actually sets. Calling `runtime.GC()` right after allocating does not make the runtime "feel" the pressure any sooner, so the useful place for a forced collection is on the way out, in `Stop`, where `debug.FreeOSMemory` returns the pages to the OS promptly instead of whenever the runtime next feels like it.

```go
package chaos

import (
    "os"
    "runtime"
    "runtime/debug"
    "sync"
)

type MemoryPressure struct {
    mu      sync.Mutex
    ballast []byte
}

// Start makes megabytes of memory resident. The ballast is live, so the GC
// will not reclaim it, and the RSS it costs is real.
func (m *MemoryPressure) Start(megabytes int) {
    m.mu.Lock()
    defer m.mu.Unlock()

    if m.ballast != nil {
        return // Already active
    }

    b := make([]byte, megabytes*1024*1024)

    // Touch one byte per page. Untouched pages of a fresh allocation may
    // never become resident, so without this the RSS cost is imaginary.
    page := os.Getpagesize()
    for i := 0; i < len(b); i += page {
        b[i] = 1
    }

    m.ballast = b
}

func (m *MemoryPressure) Stop() {
    m.mu.Lock()
    defer m.mu.Unlock()

    if m.ballast == nil {
        return
    }

    m.ballast = nil
    runtime.GC()
    debug.FreeOSMemory() // Hand the pages back now, not eventually.
}

func (m *MemoryPressure) IsActive() bool {
    m.mu.Lock()
    defer m.mu.Unlock()
    return m.ballast != nil
}
```

Note the state is the ballast itself rather than a separate `active` flag and an unused `stopChan`. One field that cannot disagree with itself beats three that can.

### CPU Pressure

CPU saturation is simulated by spawning one goroutine per logical core, each spinning until told to stop. Two details in the obvious version of this code are wrong, and both are worth seeing.

The first is the busy loop. It is tempting to write `for j := 0; j < 1000000; j++ { _ = j * j }` and describe it as arithmetic the compiler cannot remove. The compiler removes it. Build that function with `-gcflags=-S` and the body compiles to `INCQ`, `CMPQ`, `JLT`, with no multiply anywhere: the result is assigned to the blank identifier, so it is dead, and dead code is deleted. The loop still burns a core, so the injector works by accident, but the reasoning is false and the pattern is a trap. Carry the value forward into a variable that escapes and the arithmetic survives.

The second is the stop channel. Reading `c.stopChan` from inside the worker goroutine reads a field that a later `Start` writes, and `go test -race` reports it on the first arm and disarm cycle. Capture the channel into a local before spawning and the workers close over a value nobody rewrites. While you are there, make `Stop` wait on a `WaitGroup`. An abort switch that returns before the load it is aborting has actually stopped is not an abort switch, it is a hope.

```go
package chaos

import (
    "runtime"
    "sync"
    "sync/atomic"
)

type CPUPressure struct {
    mu      sync.Mutex
    stop    chan struct{}
    wg      sync.WaitGroup
    workers int
}

func NewCPUPressure(workers int) *CPUPressure {
    if workers <= 0 {
        workers = runtime.NumCPU()
    }
    return &CPUPressure{workers: workers}
}

// sink keeps the spin loop's arithmetic alive. Without a destination the
// compiler deletes the multiply and the loop measures nothing.
var sink atomic.Uint64

func (c *CPUPressure) Start() {
    c.mu.Lock()
    defer c.mu.Unlock()

    if c.stop != nil {
        return // Already active
    }

    // Capture the channel locally. The workers must not read c.stop, which
    // a later Start would rewrite underneath them.
    stop := make(chan struct{})
    c.stop = stop

    for i := 0; i < c.workers; i++ {
        c.wg.Add(1)
        go func() {
            defer c.wg.Done()
            var acc uint64
            for {
                select {
                case <-stop:
                    sink.Store(acc)
                    return
                default:
                }
                for j := uint64(0); j < 1_000_000; j++ {
                    acc = acc*6364136223846793005 + 1442695040888963407
                }
                sink.Store(acc)
            }
        }()
    }
}

// Stop removes the load and returns only once every worker has exited.
func (c *CPUPressure) Stop() {
    c.mu.Lock()
    stop := c.stop
    c.stop = nil
    c.mu.Unlock()

    if stop == nil {
        return
    }

    close(stop)
    c.wg.Wait()
}
```

The test that keeps this honest counts goroutines rather than trusting the API:

```go
func TestStopIsSynchronous(t *testing.T) {
    c := NewCPUPressure(4)
    before := runtime.NumGoroutine()

    c.Start()
    time.Sleep(20 * time.Millisecond)
    if runtime.NumGoroutine() <= before {
        t.Fatal("Start spawned no load")
    }

    c.Stop()
    if after := runtime.NumGoroutine(); after != before {
        t.Fatalf("Stop returned with %d workers still burning CPU", after-before)
    }
}
```

### File Descriptor Exhaustion

File descriptor exhaustion is induced by opening temporary files in a loop until the OS limit is hit, recording each handle so they can be closed and removed cleanly afterward.

The version to avoid swallows the error from `os.CreateTemp` and `break`s, then returns a `nil` error unconditionally. The signature promises to report failure and never does, and the caller cannot tell whether it opened the 5000 descriptors it asked for or 12. Since hitting the limit is the intended outcome rather than a bug, say so in the return values: report how many handles were opened and hand back the error that stopped the loop, so the experiment's log records where the ceiling actually was.

The reserve is the safety machinery. Before exhausting anything, open a handful of descriptors and hold them. If the experiment needs to clean up, write a log line, or emit a metric while the process is out of descriptors, closing one from the reserve gives it room to do so. Without it the process can wedge in a state where even the code meant to end the experiment cannot allocate the resources it needs to run.

```go
package chaos

import (
    "fmt"
    "os"
    "sync"
)

type FDExhaustion struct {
    mu      sync.Mutex
    files   []*os.File
    reserve []*os.File
}

// Start opens up to count descriptors, holding back a reserve of handles
// first so the cleanup path is not starved by the experiment itself.
// It returns how many it managed to open and the error that stopped it.
func (f *FDExhaustion) Start(count, reserve int) (int, error) {
    f.mu.Lock()
    defer f.mu.Unlock()

    if f.files != nil {
        return 0, fmt.Errorf("chaos: fd exhaustion already active")
    }

    for i := 0; i < reserve; i++ {
        fh, err := os.CreateTemp("", "chaos-reserve-*")
        if err != nil {
            f.releaseLocked()
            return 0, fmt.Errorf("chaos: cannot build fd reserve: %w", err)
        }
        f.reserve = append(f.reserve, fh)
    }

    f.files = make([]*os.File, 0, count)
    for i := 0; i < count; i++ {
        fh, err := os.CreateTemp("", "chaos-fd-*")
        if err != nil {
            // Hitting the ceiling is the point. Report where it was.
            return len(f.files), fmt.Errorf(
                "chaos: fd limit reached after %d handles: %w", len(f.files), err)
        }
        f.files = append(f.files, fh)
    }

    return len(f.files), nil
}

func (f *FDExhaustion) releaseLocked() {
    for _, fh := range append(f.files, f.reserve...) {
        fh.Close()
        os.Remove(fh.Name())
    }
    f.files = nil
    f.reserve = nil
}

func (f *FDExhaustion) Stop() {
    f.mu.Lock()
    defer f.mu.Unlock()
    f.releaseLocked()
}
```

Arm this one behind `time.AfterFunc(d, f.Stop)` before you call `Start`, and check `ulimit -n` first so you know what ceiling you are aiming at. A descriptor experiment that outlives its window takes the whole process with it, and the process cannot ask for help.

### Staff Lens: Resource Exhaustion Reveals Surprising Gaps

Resource exhaustion tests reveal bugs that no other test does: what happens when the process runs out of memory mid-request? Out of file descriptors during a fan-out? Disk full during a write? These scenarios happen in production and most services fail badly. Chaos tests surface them early.

The deeper lesson from the three fixes above is that the tool and the target share a process. Every other injector in this chapter can be aborted from outside. These cannot, so their correctness matters more, not less. A CPU burner whose `Stop` returns early, or an FD exhauster that cannot free a descriptor to log its own failure, turns a bounded experiment into an incident with no off switch.

---
