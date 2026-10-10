# Chapter 31B: File I/O Internals, net Package detailed look, and Go Memory Model

Three topics that every Go engineer uses daily but rarely examines closely: how the `os` and `io` packages work internally, how the `net` package models TCP connections, and how Go's Memory Model defines what goroutines are guaranteed to see. These are not abstract topics, they directly affect how you write correct concurrent code, handle errors in I/O, and design services that are both performant and safe.

**What you'll learn:**

- **File I/O internals** - os.File, syscall layer, bufio internals, io.Reader/Writer/Seeker patterns, io.Pipe, memory-mapped files
- **io/fs: virtual filesystem** - fs.FS interface, embed.FS, os.DirFS, walking and testing file trees
- **net package detailed look** - TCP connection lifecycle, net.Conn, net.Dialer options, keepalives, Unix sockets, raw connections, DNS resolution
- **HTTP server internals** - how net/http accepts connections, the Handler interface, request lifecycle, connection pooling in the HTTP client
- **Go Memory Model** - happens-before relationship, goroutine creation and joining, channel communication guarantees, mutex/once/atomic guarantees
- **WaitGroup advanced patterns** - the patterns chapter 12 only scratches

### Junior to FAANG: Why These Three Topics Belong Together

If you have only written application code, file IO, networking, and memory model feel like separate subjects. They are not. Every network read lands in a buffer that another goroutine will eventually observe. Every file write crosses a syscall boundary that blocks the OS thread until the scheduler parks the goroutine. Every shared counter that tracks bytes transferred needs a happens-before edge or the race detector will fire in CI.

The first-job framing is that you will be handed a service that already accepts traffic, and your first ticket will be something like "add a metrics counter around request handling." That ticket touches all three areas: the request enters via `net.Listener.Accept`, the handler reads a body through an `io.Reader`, and the counter you increment needs atomic semantics because handlers run on different goroutines. Interviewers probe this exact seam. A common loop question is "write a program that downloads N URLs concurrently and aggregates the total bytes." The naive answer uses a plain int and fails the race detector. The correct answer uses `atomic.Int64` or a channel, and the reason why is the memory model.

Prerequisite gaps to close before Senior material: you should be comfortable with `io.Reader`, `io.Writer`, `io.Copy`, `bufio.Scanner`, `net.Listen`, `net.Dial`, `sync.WaitGroup`, `sync.Mutex`, and `go run -race`. If any of those are fuzzy, jump to chapters 10, 12, 13 before continuing.

### Senior at FAANG: Chapter Scope at Staff Level

At staff level this chapter is the bridge between application code and the kernel. A staff engineer reviewing a hot-path service needs to reason about: which syscalls the runtime issues per request (`read`, `write`, `epoll_wait`, `futex`), how the netpoller parks goroutines without blocking M threads, which memory fences the compiler emits around `atomic.Store`, and what the Linux scheduler does when 10k goroutines wake simultaneously from a single epoll event.

The production stakes are concrete. A misconfigured `SO_REUSEPORT` fleet causes head-of-line blocking on a single listener when connections are not evenly distributed across the listener sockets. An `io.Copy` loop on a slow client pins goroutines and can exhaust the heap when the read side has no deadline. A payment idempotency cache that misses a happens-before edge between the writer goroutine and the reader goroutine surfaces the bug only under sustained load, when the Go scheduler migrates goroutines across Ps. All three failure modes require reading the runtime source, not just the stdlib docs.

This chapter assumes you will eventually touch `runtime/netpoll_epoll.go`, `runtime/sema.go`, and `runtime/proc.go`. If you are targeting a senior systems role at Google, Meta, Netflix, or Anthropic, treat each section as a launch point into the runtime source, not a summary.

---
