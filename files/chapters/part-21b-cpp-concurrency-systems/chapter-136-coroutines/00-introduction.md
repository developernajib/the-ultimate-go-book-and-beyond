# Chapter 136: Coroutines (C++20)

> Coroutines are functions that can suspend execution to be resumed later. They are the foundation for cooperative multitasking, generators, and async I/O - and C++ got them largely through Gor Nishanov's decade-long standardization effort.

Functions execute from beginning to end. You call them, they run, they return. This model has served programming well for decades, but it forces a fundamental tension: when a function must wait for something, a disk read, a network response, a value from another computation, the thread that called it either blocks (wasting resources) or you restructure your entire program around callbacks (wasting your sanity).

C++20 coroutines resolve this tension. A coroutine is a function that can suspend its execution, return control to its caller, and later resume exactly where it left off with all local variables intact. The suspended coroutine consumes no thread. It is a small heap-allocated frame waiting to be resumed, while the thread that was running it moves on to other work.

Unlike Go's goroutines, which are runtime-managed green threads scheduled preemptively across OS threads, C++ coroutines are a language-level transformation. The compiler rewrites your function into a state machine. There is no runtime scheduler, no hidden thread pool, no garbage collector. You get the abstraction of suspendable functions with the control and determinism C++ programmers demand.

This chapter builds C++20 coroutines from the ground up. You will learn the three coroutine keywords, understand the promise type machinery that powers them, build generators and async tasks, explore scheduling strategies, and compare the C++ approach with Go's goroutine model.

### Junior → FAANG: Coroutines as a Mental Model Shift

Engineers coming from Go find C++ coroutines counterintuitive at first because Go's goroutines are invisible. You `go func()` and the runtime handles scheduling. C++ coroutines are explicit: the compiler transforms your function into a state machine, but you own the scheduler. There is no hidden runtime.

The entry-level mental model: a coroutine is a function that can pause and resume. Every `co_await` is a potential pause point. When paused, the function's local variables are stored in a heap-allocated frame, and the thread is free to run other code. This is cooperative concurrency, not preemptive, so coroutines that do not yield can starve other coroutines on the same thread.

First-job relevance: C++20 coroutines are increasingly used in FAANG codebases for async I/O (replacing callback-based code), generators (replacing iterator types with complex state), and async task pipelines. Know the three keywords and the basic generator pattern. Understanding the promise type machinery is a senior skill.

### Senior @ FAANG: Coroutines as an Infrastructure Architecture Decision

At L5+, adopting C++20 coroutines in a service codebase is an architectural decision with consequences for: compile time (coroutines are complex templates that slow compilation), debug experience (coroutine frames are heap-allocated and do not appear on the stack in a crash dump), and team expertise (coroutine promise types are not beginner-friendly).

The ADR for adopting coroutines must answer: does your team have the expertise to write and maintain coroutine promise types? Will you use a library (CppCoro, Folly Coro) that provides pre-built promise types, or write your own? How will you debug coroutine-based async code in production (coroutine frames are on the heap, GDB does not automatically reconstruct the logical call stack)?

Platform thinking: Folly Coro (Meta's coroutine library) and CppCoro (David Sankel's library) both provide well-tested promise types and task types. At production scale, these are preferable to custom implementations. The infrastructure investment is in integrating the coroutine executor with your event loop (io_uring, ASIO, epoll), not in writing promise type boilerplate.

---
