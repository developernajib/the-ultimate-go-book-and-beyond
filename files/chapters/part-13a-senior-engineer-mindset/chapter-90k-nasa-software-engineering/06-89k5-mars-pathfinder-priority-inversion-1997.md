## 90K.5 Mars Pathfinder Priority Inversion (1997)

On July 4, 1997, NASA's Mars Pathfinder lander touched down on the surface of Mars. It
was a triumphant success - the first Mars landing since Viking in 1976. The lander
deployed the Sojourner rover and began transmitting data back to Earth. Then, just days
into the mission, the spacecraft began resetting itself repeatedly. Telemetry data was
lost. Science operations stopped. The mission was in jeopardy.

### What Happened

The Pathfinder ran VxWorks, a priority-based preemptive real-time operating system, on a
RAD6000 processor (a radiation-hardened IBM RS/6000 derivative running at 20 MHz with 128
MB of RAM). The flight software had three tasks of interest:

1. **Bus Management Task** (high priority): Managed the 1553 data bus that connected all
   spacecraft subsystems. Had hard real-time deadlines.
2. **Communications Task** (medium priority): Handled telemetry downlink.
3. **Meteorological Data Collection Task** (low priority): Gathered weather data from
   sensors and wrote results to shared memory.

These tasks shared a mutex-protected region of shared memory. The sequence that caused
the failure was:

1. The low-priority meteorological task acquired the mutex.
2. While holding the mutex, the low-priority task was preempted by the medium-priority
   communications task (which did not need the mutex).
3. The high-priority bus management task woke up and tried to acquire the mutex.
4. The bus management task blocked because the low-priority task held the mutex.
5. The medium-priority task continued running, preventing the low-priority task from
   resuming and releasing the mutex.
6. The bus management task missed its deadline.
7. The VxWorks watchdog timer detected the missed deadline and reset the entire system.

This is a textbook **priority inversion**: a high-priority task is effectively blocked by
a medium-priority task, even though the medium-priority task has no direct relationship
with the shared resource. The high-priority task's effective priority has been "inverted"
to below the medium-priority task's.

### The Fix

The fix was remarkably elegant. VxWorks already supported **priority inheritance** - a
mechanism where a task holding a mutex temporarily inherits the priority of the
highest-priority task waiting for that mutex. This prevents priority inversion because the
low-priority task would run at high priority while holding the mutex, preventing the
medium-priority task from preempting it.

The VxWorks `mutexCreate` function had a flag to enable priority inheritance:
`SEM_INVERSION_SAFE`. The Pathfinder team had not enabled it. NASA engineers on Earth
diagnosed the problem from telemetry data and the source code, then **uploaded a C code
patch to Mars** that set the priority inheritance flag on the critical mutex. The
resets stopped. The mission continued for nearly three months beyond its planned one-week
surface lifetime.

### Priority Inversion in Go

Go does not have OS-level task priorities. All goroutines are scheduled cooperatively by
the Go runtime with no priority system. However, Go programs can experience analogous
problems: a goroutine holding a mutex can be starved by the scheduler, causing other
goroutines waiting for that mutex to block indefinitely. The patterns to prevent this
are: minimize critical sections, use timeouts, and use channels instead of mutexes where
possible.

```go
package nasa

import (
    "context"
    "fmt"
    "sync"
    "time"
)

// === BAD: Priority inversion analog in Go ===
// A goroutine holds a mutex for a long time, blocking other goroutines
// that need the same resource.

// SharedBus represents a shared communication bus (like the 1553 bus
// on Mars Pathfinder).
type SharedBus struct {
    mu   sync.Mutex
    data [1024]byte
}

// BAD: SlowWriter holds the mutex while performing a slow operation.
// In Go, this doesn't cause priority inversion per se (no priorities),
// but it causes the same symptom: high-urgency goroutines blocked
// waiting for a lock held by a low-urgency goroutine doing slow work.
func (sb *SharedBus) SlowWriter(data []byte) {
    sb.mu.Lock()
    defer sb.mu.Unlock()

    // Simulates slow meteorological data collection while holding the lock.
    time.Sleep(100 * time.Millisecond) // BAD: Long critical section.
    copy(sb.data[:], data)
}

// GOOD: NASA-inspired patterns to prevent priority-inversion-like behavior.

// === Pattern 1: Minimize critical section ===

// FastBus separates data preparation from the critical section.
type FastBus struct {
    mu   sync.Mutex
    data [1024]byte
}

// Write prepares data outside the lock, then holds the lock only for
// the copy operation. Critical section is O(n) on data size with
// bounded n, not O(network) or O(disk).
func (fb *FastBus) Write(rawData []byte) error {
    // Validate and prepare OUTSIDE the lock.
    if len(rawData) > len(fb.data) {
        return fmt.Errorf("data too large: %d > %d", len(rawData), len(fb.data))
    }

    prepared := make([]byte, len(rawData))
    copy(prepared, rawData) // Defensive copy.

    // Lock only for the final write.
    fb.mu.Lock()
    copy(fb.data[:], prepared)
    fb.mu.Unlock()

    return nil
}

// === Pattern 2: Timeout-based mutex acquisition ===

// TimedMutex wraps a mutex with a timeout to prevent indefinite blocking.
// If the lock cannot be acquired within the deadline, the caller gets
// an error instead of blocking forever (like Pathfinder's bus manager
// blocking until the watchdog fired).
type TimedMutex struct {
    ch chan struct{}
}

// NewTimedMutex creates a mutex with timeout support.
func NewTimedMutex() *TimedMutex {
    ch := make(chan struct{}, 1)
    ch <- struct{}{} // Initially unlocked.
    return &TimedMutex{ch: ch}
}

// Lock acquires the mutex with a timeout.
func (tm *TimedMutex) Lock(ctx context.Context) error {
    select {
    case <-tm.ch:
        return nil
    case <-ctx.Done():
        return fmt.Errorf("mutex acquisition timed out: %w", ctx.Err())
    }
}

// Unlock releases the mutex.
func (tm *TimedMutex) Unlock() {
    select {
    case tm.ch <- struct{}{}:
    default:
        panic("TimedMutex: unlock of unlocked mutex")
    }
}

// === Pattern 3: Channel-based coordination (no mutexes) ===

// PathfinderBus reimplements the bus management pattern using channels
// instead of mutexes. A single goroutine owns the data, and others
// send requests through channels. This eliminates the possibility of
// priority inversion entirely.
type PathfinderBus struct {
    writeCh chan writeRequest
    readCh  chan readRequest
    stopCh  chan struct{}
}

type writeRequest struct {
    data   []byte
    result chan error
}

type readRequest struct {
    result chan readResponse
}

type readResponse struct {
    data []byte
    err  error
}

// NewPathfinderBus creates a bus with channel-based ownership.
func NewPathfinderBus(bufSize int) *PathfinderBus {
    pb := &PathfinderBus{
        writeCh: make(chan writeRequest, bufSize),
        readCh:  make(chan readRequest, bufSize),
        stopCh:  make(chan struct{}),
    }
    go pb.run()
    return pb
}

// run is the single owner goroutine. Only this goroutine touches the data.
// No mutexes needed. No priority inversion possible.
func (pb *PathfinderBus) run() {
    var data [1024]byte

    for {
        select {
        case <-pb.stopCh:
            return
        case req := <-pb.writeCh:
            if len(req.data) > len(data) {
                req.result <- fmt.Errorf("data too large: %d", len(req.data))
                continue
            }
            copy(data[:], req.data)
            req.result <- nil
        case req := <-pb.readCh:
            buf := make([]byte, len(data))
            copy(buf, data[:])
            req.result <- readResponse{data: buf}
        }
    }
}

// Write sends data to the bus owner goroutine with a timeout.
func (pb *PathfinderBus) Write(ctx context.Context, data []byte) error {
    result := make(chan error, 1)
    select {
    case pb.writeCh <- writeRequest{data: data, result: result}:
    case <-ctx.Done():
        return ctx.Err()
    }

    select {
    case err := <-result:
        return err
    case <-ctx.Done():
        return ctx.Err()
    }
}

// Read retrieves data from the bus with a timeout.
func (pb *PathfinderBus) Read(ctx context.Context) ([]byte, error) {
    result := make(chan readResponse, 1)
    select {
    case pb.readCh <- readRequest{result: result}:
    case <-ctx.Done():
        return nil, ctx.Err()
    }

    select {
    case resp := <-result:
        return resp.data, resp.err
    case <-ctx.Done():
        return nil, ctx.Err()
    }
}

// Stop terminates the bus owner goroutine.
func (pb *PathfinderBus) Stop() {
    close(pb.stopCh)
}
```

### Lessons for Go Engineers

1. **Minimize critical sections.** Hold locks for the shortest possible duration. Prepare
   data outside the lock. Log outside the lock. Make network calls outside the lock.

2. **Use timeouts on lock acquisition.** A goroutine waiting forever for a lock is
   equivalent to Pathfinder's bus management task hanging - eventually a watchdog (or a
   health check) will kill your process.

3. **Prefer channel-based ownership.** Go's channels naturally serialize access without
   mutexes. A single goroutine that owns the data and services requests through channels
   cannot experience priority inversion.

4. **Test under contention.** The Pathfinder bug only manifested when all three tasks ran
   concurrently with specific timing. Use `go test -race` and stress tests with high
   goroutine counts to surface contention bugs.

---
