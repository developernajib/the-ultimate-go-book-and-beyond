## 10. IPC: Shared Memory vs. Message Passing

Processes have separate address spaces. A write to address `0x7fff1234` in process A does not affect address `0x7fff1234` in process B. That isolation is a feature: it prevents one buggy process from corrupting another. But sometimes processes need to cooperate. Inter-process communication (IPC) is the set of mechanisms the OS provides for that.

There are two fundamental models: **shared memory** (both processes read and write the same physical memory region) and **message passing** (processes exchange data by copying it through a kernel-managed channel). Every IPC mechanism is a variation of one of these two.

### Pipes

A pipe is a unidirectional byte stream. Data written to the write end appears at the read end, in order. Pipes have a kernel-managed buffer (typically 64KB on Linux).

```go
// Shell equivalent: ls | grep ".go"
// Go using os/exec
package main

import (
    "bytes"
    "os/exec"
    "fmt"
)

func main() {
    ls := exec.Command("ls")
    grep := exec.Command("grep", ".go")

    var buf bytes.Buffer
    lsOut, _ := ls.Output()
    grep.Stdin = bytes.NewReader(lsOut)
    grep.Stdout = &buf
    grep.Run()
    fmt.Print(buf.String())
}
```

Pipes exist only as long as both ends are open. When the write end closes, a read on an empty pipe returns EOF. Pipes are anonymous: they can only connect processes that share a common ancestor (because the file descriptor is inherited through fork).

#### FIFOs (Named Pipes)

A FIFO is a pipe with a name in the filesystem. Any process that can open the path can use it. FIFOs are useful for connecting unrelated processes.

```bash
mkfifo /tmp/my-pipe
echo "hello" > /tmp/my-pipe &
cat /tmp/my-pipe
```

In Go, you open a FIFO like any other file. Reads block until a writer opens the other end, and vice versa.

### Unix Domain Sockets

Unix domain sockets work like network sockets (you can use `Read`, `Write`, `Accept`, `Connect`) but communicate within a single machine through the kernel rather than through a network stack. They are faster than TCP loopback and support passing open file descriptors between processes (a technique called "fd passing").

```go
// Server
ln, _ := net.Listen("unix", "/tmp/my.sock")
conn, _ := ln.Accept()
// ... read/write conn

// Client
conn, _ := net.Dial("unix", "/tmp/my.sock")
```

Unix sockets are the standard IPC mechanism for services that need both stream (SOCK_STREAM) and datagram (SOCK_DGRAM) semantics. Docker, systemd, and most desktop Linux applications use Unix sockets extensively.

### Message Queues

POSIX message queues (`mq_open`, `mq_send`, `mq_receive`) give you a persistent, typed message channel. Unlike pipes, messages have explicit boundaries. Unlike sockets, a crashed receiver does not lose the queue. The kernel delivers messages in priority order.

Message queues are less common in new code. Pipes and sockets are simpler and more portable.

### Shared Memory

Shared memory gives two or more processes access to the same physical RAM pages. No copying happens: a write in one process is immediately visible in another. This makes shared memory the highest-bandwidth IPC mechanism available.

```c
// POSIX shared memory (simplified)
int fd = shm_open("/my-segment", O_CREAT | O_RDWR, 0666);
ftruncate(fd, 4096);
void *mem = mmap(NULL, 4096, PROT_READ | PROT_WRITE, MAP_SHARED, fd, 0);

// Both processes mmap the same name - they now share the memory region.
```

The catch: shared memory has no built-in synchronization. If two processes write simultaneously, you get a data race. You must add a semaphore or mutex to protect the shared region. This is exactly the same race condition problem that affects threads, except now it crosses process boundaries.

### When to Use Each Mechanism

| Mechanism | Bandwidth | Latency | Synchronization needed | Use case |
|---|---|---|---|---|
| Pipe | Medium | Low | No (stream) | Shell pipelines, stdin/stdout |
| FIFO | Medium | Low | No (stream) | Unrelated processes, simple logs |
| Unix socket | High | Very low | No (stream/dgram) | Local RPC, daemon communication |
| Message queue | Medium | Low | No (per message) | Priority queues, persistent messages |
| Shared memory | Very high | Minimal | Yes, explicit | High-frequency data, video frames, trading |

For most applications, reach for sockets or pipes first. Shared memory is a last resort when you can prove that copying is the bottleneck.

### Go Channels as CSP Message Passing

Go's channels implement the Communicating Sequential Processes (CSP) model invented by Tony Hoare in 1978. CSP says: instead of sharing memory and protecting it with locks, transfer ownership of data by sending it through a channel. The sender stops owning the value after sending it. The receiver exclusively owns it after receiving it.

```go
ch := make(chan []byte, 1)

go func() {
    data := fetchData() // allocate and populate
    ch <- data          // transfer ownership
}()

result := <-ch          // now this goroutine owns data
process(result)
```

This is in-process message passing. No kernel is involved. No copying happens unless you explicitly copy (for buffered channels, the runtime copies into the channel buffer, but for unbuffered channels the transfer is a direct handoff). The Go memory model guarantees that a send happens-before the corresponding receive completes, eliminating the need for explicit synchronization around the transferred data.

The Go proverb captures the philosophy: "Do not communicate by sharing memory. Share memory by communicating."

### Go Shared Memory with sync.Mutex

Sometimes you do need shared state. Multiple goroutines reading and writing a map or a counter. Go provides `sync.Mutex` for this case.

```go
type SafeCounter struct {
    mu    sync.Mutex
    count int
}

func (c *SafeCounter) Inc() {
    c.mu.Lock()
    c.count++
    c.mu.Unlock()
}

func (c *SafeCounter) Value() int {
    c.mu.Lock()
    defer c.mu.Unlock()
    return c.count
}
```

This is the shared memory model inside a single process. The mutex is the synchronization that shared memory IPC also requires.

For read-heavy workloads where writes are rare, `sync.RWMutex` lets multiple goroutines hold a read lock simultaneously while writes get exclusive access.

### Choosing Between Channels and Mutexes in Go

Use channels when:
- Ownership of data transfers from one goroutine to another
- You are modeling a pipeline or producer-consumer pattern
- You want backpressure (a full buffered channel blocks the sender)

Use mutexes when:
- Multiple goroutines need concurrent access to the same data structure
- The data is logically shared (a cache, a connection pool, a registry)
- The operation is short and the overhead of channel communication is not worth it

Both are correct tools. Channels are not always faster than mutexes. Profile before deciding.

### Summary

- Pipes: unidirectional byte streams for related processes
- FIFOs: named pipes for unrelated processes
- Unix sockets: bidirectional, supports any process, high performance
- Shared memory: zero-copy but requires explicit synchronization
- Go channels: CSP in-process message passing, transfers ownership
- Go mutexes: explicit shared-memory protection within a process

**Watch:** [CONCURRENCY IS NOT WHAT YOU THINK](https://www.youtube.com/watch?v=3X93PnKRNUo)

**Watch:** [Threads On Multicore Systems](https://www.youtube.com/watch?v=5sw9XJokAqw)
