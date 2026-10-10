## 90K.3 The Banned Constructs

NASA JPL maintains a list of language constructs that are explicitly banned in
safety-critical flight software. These bans go beyond the Power of 10 rules and
represent decades of experience with bugs caused by specific language features. Each ban
exists because the construct has caused mission-threatening defects or makes the code
impossible to verify with static analysis tools.

### Complete Ban List

| Construct | Why Banned | Failure Mode |
|-----------|-----------|--------------|
| `malloc()` after init | Non-deterministic timing, fragmentation, can return NULL | Heap exhaustion, null deref, unpredictable latency |
| `free()` | Use-after-free, double-free | Memory corruption, crashes |
| Recursion | Unbounded stack growth | Stack overflow |
| `goto` | Arbitrary control flow | Spaghetti logic, unreachable code |
| `setjmp`/`longjmp` | Non-local jumps, bypass destructors | Resource leaks, corrupted state |
| Function pointers | Dynamic dispatch defeats static analysis | Unverifiable call targets |
| Unbounded loops | Potential infinite loops | Processor hangs |
| Variable-length arrays | Stack allocation of unknown size | Stack overflow |
| Complex macros | Text substitution hides logic | Type errors, double evaluation |
| `union` types | Type punning | Undefined behavior |
| Bit fields | Implementation-defined behavior | Portability bugs |
| `abort()` | Unrecoverable termination | Mission loss |
| `signal()` | Asynchronous signal handling | Race conditions |

### Go Equivalents of Banned Constructs

In Go, some of these constructs do not exist. Others have safe equivalents. Some require
discipline to avoid.

```go
package nasa

import (
    "context"
    "errors"
    "fmt"
    "sync"
    "time"
)

// Assert checks an invariant and panics if false.
func Assert(condition bool, format string, args ...any) {
    if !condition {
        if len(args) == 0 {
            panic("assertion failed: " + format)
        }
        panic(fmt.Sprintf("assertion failed: "+format, args...))
    }
}

// === BANNED: Dynamic allocation after initialization ===
// Go equivalent: append() that grows slices, map insertion, new goroutines.
//
// NASA approach in Go: Pre-allocate everything during init.

// CommandQueue is a bounded, pre-allocated command queue.
// After construction, no heap allocations occur.
type CommandQueue struct {
    mu       sync.Mutex
    commands [MaxCommands]Command // Fixed array - no slice growth.
    head     int
    tail     int
    count    int
}

// MaxCommands is the maximum number of queued commands.
const MaxCommands = 256

// Command represents a spacecraft command.
type Command struct {
    ID        uint32
    OpCode    uint16
    Params    [64]byte // Fixed size - no dynamic allocation.
    ParamLen  int
    Timestamp int64
}

// Enqueue adds a command without allocating.
func (q *CommandQueue) Enqueue(cmd Command) error {
    q.mu.Lock()
    defer q.mu.Unlock()

    if q.count >= MaxCommands {
        return errors.New("command queue full")
    }

    q.commands[q.tail] = cmd
    q.tail = (q.tail + 1) % MaxCommands
    q.count++
    return nil
}

// Dequeue removes and returns the oldest command.
func (q *CommandQueue) Dequeue() (Command, error) {
    q.mu.Lock()
    defer q.mu.Unlock()

    if q.count == 0 {
        return Command{}, errors.New("command queue empty")
    }

    cmd := q.commands[q.head]
    q.commands[q.head] = Command{} // Clear for safety.
    q.head = (q.head + 1) % MaxCommands
    q.count--
    return cmd, nil
}

// === BANNED: Function pointers / dynamic dispatch ===
// Go equivalent: interfaces with dynamic dispatch.
//
// NASA approach: When you must use interfaces, constrain them
// to a known, enumerable set of implementations.

// SubsystemID identifies a spacecraft subsystem.
type SubsystemID int

const (
    SubsystemPower SubsystemID = iota
    SubsystemThermal
    SubsystemComms
    SubsystemGNC // Guidance, Navigation, and Control
    SubsystemPayload
    subsystemCount // Must be last - gives us the count.
)

// SubsystemHandler processes commands for a specific subsystem.
// Instead of function pointers or open interfaces, we use a
// fixed-size dispatch table with compile-time known entries.
type SubsystemHandler struct {
    handlers [subsystemCount]func(Command) error
}

// NewSubsystemHandler creates a handler with all subsystems registered.
// After construction, the dispatch table is immutable.
func NewSubsystemHandler() *SubsystemHandler {
    h := &SubsystemHandler{}

    h.handlers[SubsystemPower] = handlePowerCommand
    h.handlers[SubsystemThermal] = handleThermalCommand
    h.handlers[SubsystemComms] = handleCommsCommand
    h.handlers[SubsystemGNC] = handleGNCCommand
    h.handlers[SubsystemPayload] = handlePayloadCommand

    // Verify all handlers are registered.
    for i := 0; i < int(subsystemCount); i++ {
        Assert(h.handlers[i] != nil,
            "handler for subsystem %d not registered", i)
    }

    return h
}

// Dispatch routes a command to the appropriate handler.
func (h *SubsystemHandler) Dispatch(subsystem SubsystemID, cmd Command) error {
    if subsystem < 0 || subsystem >= subsystemCount {
        return fmt.Errorf("unknown subsystem: %d", subsystem)
    }

    handler := h.handlers[subsystem]
    Assert(handler != nil, "nil handler for subsystem %d", subsystem)

    return handler(cmd)
}

func handlePowerCommand(cmd Command) error   { return nil }
func handleThermalCommand(cmd Command) error  { return nil }
func handleCommsCommand(cmd Command) error    { return nil }
func handleGNCCommand(cmd Command) error      { return nil }
func handlePayloadCommand(cmd Command) error  { return nil }

// === BANNED: goto ===
// Go has goto but it is heavily restricted - it cannot jump over
// variable declarations or into different scopes.
// NASA approach: never use it. Use structured control flow.

// === BANNED: Unbounded loops ===
// Covered in Rule 2. Here is another example.

// WaitForDownlink waits for a communication window with a hard deadline.
func WaitForDownlink(ctx context.Context, checker func() bool) error {
    const maxChecks = 3600 // At 1Hz = 1 hour maximum wait.

    for i := 0; i < maxChecks; i++ {
        select {
        case <-ctx.Done():
            return ctx.Err()
        default:
        }

        if checker() {
            return nil
        }

        select {
        case <-ctx.Done():
            return ctx.Err()
        case <-time.After(1 * time.Second):
        }
    }

    return errors.New("downlink window not available within timeout")
}

// === BANNED: abort() / unrecoverable termination ===
// Go equivalent: os.Exit(), log.Fatal(), panic without recovery.
//
// NASA approach: Never exit the process. Always recover and
// enter a safe mode. Panics must be caught at the top level.

// SafeExecute runs a function with panic recovery.
// In spacecraft software, an unrecovered panic would terminate the
// flight software process, potentially ending the mission.
func SafeExecute(fn func() error) (retErr error) {
    defer func() {
        if r := recover(); r != nil {
            retErr = fmt.Errorf("recovered from panic: %v", r)
        }
    }()

    return fn()
}
```

---
