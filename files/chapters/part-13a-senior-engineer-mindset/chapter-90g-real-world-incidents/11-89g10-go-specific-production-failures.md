## 90G.10 Go-Specific Production Failures

### Uber's Goroutine Leak Epidemic

Uber's Go microservice fleet experienced a systemic problem with goroutine leaks - goroutines that start but
never terminate, accumulating over time until the service runs out of memory and is killed by the OOM killer.

**The Scale:**
- Services consumed 2.5-5x more memory than necessary
- OOM kills were a regular occurrence across the fleet
- Uber built LeakProf, a tool that detected 10 critical leaks with only 1 false positive

**Common Leak Patterns:**

```go
package goroutineleaks

import (
	"context"
	"fmt"
	"runtime"
	"sync"
	"time"
)

// Pattern 1: Premature return with abandoned goroutine
// This is the most common goroutine leak at Uber.
func LeakyPattern1_PrematureReturn(ctx context.Context) (string, error) {
	ch := make(chan string) // UNBUFFERED - this is the problem

	go func() {
		result := expensiveOperation()
		ch <- result // BLOCKS FOREVER if nobody reads from ch
	}()

	select {
	case result := <-ch:
		return result, nil
	case <-ctx.Done():
		return "", ctx.Err()
		// The goroutine is still blocked on ch <- result
		// It will NEVER be collected. Leaked.
	}
}

// Fix: Use a buffered channel of size 1
func FixedPattern1_PrematureReturn(ctx context.Context) (string, error) {
	ch := make(chan string, 1) // BUFFERED - goroutine can write and exit

	go func() {
		result := expensiveOperation()
		ch <- result // Even if nobody reads, this succeeds and goroutine exits
	}()

	select {
	case result := <-ch:
		return result, nil
	case <-ctx.Done():
		return "", ctx.Err()
		// Goroutine will write to buffered channel and exit normally
	}
}

// Pattern 2: Range over unclosed channel
func LeakyPattern2_UnclosedChannel() {
	ch := make(chan int)

	go func() {
		for val := range ch { // BLOCKS FOREVER - nobody closes ch
			fmt.Println(val)
		}
	}()

	ch <- 1
	ch <- 2
	// Function returns without closing ch
	// The goroutine is blocked on range, waiting for more values or close
	// Leaked.
}

// Fix: Always close channels when done sending
func FixedPattern2_UnclosedChannel() {
	ch := make(chan int)

	go func() {
		for val := range ch {
			fmt.Println(val)
		}
	}()

	ch <- 1
	ch <- 2
	close(ch) // Reader goroutine will exit the range loop
}

// Pattern 3: Goroutine blocked on mutex/IO with no timeout
func LeakyPattern3_NoTimeout() {
	var mu sync.Mutex

	go func() {
		mu.Lock() // If something holds mu forever, this goroutine leaks
		defer mu.Unlock()
		// ... work ...
	}()
}

// GoroutineLeakDetector monitors goroutine count and detects leaks.
type GoroutineLeakDetector struct {
	serviceName    string
	baselineCount  int
	sampleInterval time.Duration
	alertThreshold float64 // multiplier over baseline
	onLeak         func(count int, baseline int, stackDump string)
}

// NewGoroutineLeakDetector creates a leak detector.
func NewGoroutineLeakDetector(
	serviceName string,
	alertThreshold float64,
	onLeak func(count int, baseline int, stackDump string),
) *GoroutineLeakDetector {
	return &GoroutineLeakDetector{
		serviceName:    serviceName,
		baselineCount:  runtime.NumGoroutine(),
		sampleInterval: 30 * time.Second,
		alertThreshold: alertThreshold,
		onLeak:         onLeak,
	}
}

// Start begins monitoring goroutine count. Cancel context to stop.
func (d *GoroutineLeakDetector) Start(ctx context.Context) {
	ticker := time.NewTicker(d.sampleInterval)
	defer ticker.Stop()

	// Let the service warm up before establishing baseline
	warmupDone := time.After(5 * time.Minute)
	<-warmupDone
	d.baselineCount = runtime.NumGoroutine()

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			current := runtime.NumGoroutine()
			threshold := int(float64(d.baselineCount) * d.alertThreshold)

			if current > threshold {
				// Capture goroutine stack dump for analysis
				buf := make([]byte, 1024*1024) // 1 MB buffer
				n := runtime.Stack(buf, true)   // true = all goroutines
				stackDump := string(buf[:n])

				d.onLeak(current, d.baselineCount, stackDump)
			}
		}
	}
}

func expensiveOperation() string {
	time.Sleep(5 * time.Second)
	return "result"
}
```

### Twitch's GC Pressure Crisis

Twitch experienced severe GC pressure in their Go services: the garbage collector was running 8-10 times per
second, consuming over 30% of CPU. During traffic spikes (up to 20x normal - e.g., during popular streams), GC
mark assist added 45% latency to requests.

**The Fix: Memory Ballast**

```go
package main

import (
	"fmt"
	"runtime"
	"runtime/debug"
)

// BallastPattern demonstrates Twitch's memory ballast technique.
// This was the primary fix before Go 1.19 introduced GOMEMLIMIT.
func BallastPattern() {
	// Allocate a large byte slice that is never used.
	// This is a VIRTUAL allocation - the OS does not commit physical memory
	// for zero-filled pages until they are written to. So this costs
	// essentially nothing in physical memory.
	//
	// Why it works: Go's GC triggers when heap size doubles from the
	// previous GC cycle's live heap. With GOGC=100 (default):
	//   Next GC target = live_heap * (1 + GOGC/100) = live_heap * 2
	//
	// Without ballast:
	//   Live heap: 500 MB → GC triggers at 1 GB → GC runs frequently
	//
	// With 10 GB ballast:
	//   Live heap: 500 MB + 10 GB = 10.5 GB → GC triggers at 21 GB
	//   GC runs MUCH less frequently because the trigger threshold is
	//   relative to live heap, which includes the ballast
	ballast := make([]byte, 10<<30) // 10 GiB - virtual, not physical

	// Result for Twitch:
	// - GC frequency: 8-10/sec → ~1/sec
	// - CPU usage: 30%+ reduction
	// - P99 latency: 45% improvement during spikes
	fmt.Printf("Ballast allocated: %d bytes (virtual)\n", len(ballast))

	var stats runtime.MemStats
	runtime.ReadMemStats(&stats)
	fmt.Printf("HeapSys: %d MB (virtual memory reserved)\n", stats.HeapSys/1024/1024)
	fmt.Printf("HeapAlloc: %d MB (actual memory in use)\n", stats.HeapAlloc/1024/1024)
	// HeapSys will be large (includes ballast), HeapAlloc will be small

	runtime.KeepAlive(ballast)
}

// ModernApproach_GOMEMLIMIT demonstrates the Go 1.19+ replacement for ballast.
// GOMEMLIMIT is strictly superior to the ballast pattern.
func ModernApproach_GOMEMLIMIT() {
	// GOMEMLIMIT tells the GC: "I have this much memory available.
	// Optimize your collection schedule to stay below this limit."
	//
	// Set via environment variable (preferred):
	//   GOMEMLIMIT=32GiB
	//
	// Or programmatically:
	debug.SetMemoryLimit(32 * 1024 * 1024 * 1024) // 32 GiB

	// You can also set GOGC=off to disable percentage-based GC entirely:
	//   GOGC=off GOMEMLIMIT=32GiB ./myservice
	//
	// This means: "GC, you have 32 GiB to work with. Only collect when
	// you need to, based on actual memory pressure."
	//
	// Advantages over ballast:
	// 1. No need for a fake allocation
	// 2. GC is aware of the actual memory limit
	// 3. GC will become more aggressive as memory usage approaches the limit
	//    (instead of OOM-killing the process)
	// 4. Works correctly with containers that have memory limits

	fmt.Println("GOMEMLIMIT set to 32 GiB")
	fmt.Println("In production, prefer environment variable: GOMEMLIMIT=32GiB")
}
```

### Key Lessons

**Lesson 1: Goroutine leaks are the Go equivalent of memory leaks in C.** They are easy to create, hard to
detect, and accumulate slowly until the service crashes. Every Go service should monitor `runtime.NumGoroutine()`
and alert on sustained growth.

**Lesson 2: Unbuffered channels are the #1 cause of goroutine leaks.** When a goroutine writes to an unbuffered
channel and the reader has already moved on (timeout, context cancellation, premature return), the writer blocks
forever. Use buffered channels of size 1 when the writer should not block.

**Lesson 3: GC tuning is essential for cache-heavy services.** The default GOGC=100 triggers GC when heap doubles.
For services with large stable caches, this means frequent unnecessary collections. Use GOMEMLIMIT (Go 1.19+) to
give the GC a memory budget and let it optimize its own schedule.

### Junior → FAANG: Go-Specific Failure Modes as Interview Knowledge

Goroutine leaks and GC pressure are the two Go-specific failure modes that appear most often in production interviews and debugging questions. For goroutine leaks: know the three common patterns (unbuffered channel writer with no reader, goroutine started with no context cancellation, goroutine blocking on lock with no timeout), know that `runtime.NumGoroutine()` is the detection mechanism, and know that `goleak` (in tests) and pprof (in production) are the diagnostic tools. For GC pressure: know GOMEMLIMIT is the modern solution, and know that GOGC=off combined with GOMEMLIMIT is the correct configuration for cache-heavy services.

### Senior @ FAANG: Go Runtime Discipline as a Platform Standard

At L6, goroutine leak prevention is a coding standard, not a debugging exercise. The standard is: every goroutine must be started with a context, every goroutine that writes to a channel must handle the case where the reader is gone, and every service must have a goroutine count metric with an alert threshold. These standards should be enforced by a custom `go/analysis` linter (from the previous chapter) rather than code review alone.

The GOMEMLIMIT configuration belongs in the service deployment template, not in per-service code. Every Go service deployed in your org should have a memory limit configured via `GOMEMLIMIT` and a corresponding container memory limit that is 10-20% higher than the `GOMEMLIMIT` value (to leave room for the runtime's overhead). Standardizing this configuration across the fleet is the kind of platform work that prevents Twitch-style GC crises.

---
