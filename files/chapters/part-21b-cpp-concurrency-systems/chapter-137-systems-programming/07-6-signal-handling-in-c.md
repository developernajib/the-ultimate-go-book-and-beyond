## 6. Signal Handling in C++

Signals are the Unix mechanism for asynchronous process notification. They are also one of the most treacherous areas of systems programming, a signal handler interrupts normal execution at an arbitrary point, and only a small set of operations are safe inside a handler.

### The Async-Signal-Safe Approach

The only safe approach: set a flag in the handler and check it in the main loop. Use `volatile sig_atomic_t` or a self-pipe.

```cpp
#include <signal.h>
#include <unistd.h>
#include <atomic>
#include <iostream>

// Atomic flag -- safe because std::atomic<bool> is lock-free
// on all major platforms for bool
static std::atomic<bool> g_shutdown_requested{false};

void signal_handler(int signo) {
    // ONLY set flags or write to a self-pipe here.
    // No malloc, no printf, no mutex locks, no C++ exceptions.
    if (signo == SIGINT || signo == SIGTERM) {
        g_shutdown_requested.store(true, std::memory_order_relaxed);
    }
}

void setup_signal_handlers() {
    struct sigaction sa{};
    sa.sa_handler = signal_handler;
    sigemptyset(&sa.sa_mask);
    sa.sa_flags = 0;  // No SA_RESTART: let blocking calls return EINTR

    sigaction(SIGINT, &sa, nullptr);
    sigaction(SIGTERM, &sa, nullptr);
}

// Main loop checks the flag
void run_server() {
    setup_signal_handlers();

    while (!g_shutdown_requested.load(std::memory_order_relaxed)) {
        // Do work... accept connections, process requests
        // Blocking calls like accept() will return EINTR on signal,
        // which is your cue to check the flag.
    }
    std::cout << "Graceful shutdown complete\n";
}
```

### The signalfd Approach (Linux)

`signalfd` converts signals into file descriptor events, which can be monitored with epoll. This eliminates the async-signal-safety problem entirely.

```cpp
#include <sys/signalfd.h>
#include <signal.h>

int create_signal_fd() {
    sigset_t mask;
    sigemptyset(&mask);
    sigaddset(&mask, SIGINT);
    sigaddset(&mask, SIGTERM);

    // Block signals so they are delivered via signalfd instead
    sigprocmask(SIG_BLOCK, &mask, nullptr);

    int sfd = signalfd(-1, &mask, SFD_NONBLOCK | SFD_CLOEXEC);
    // Now add sfd to your epoll reactor and read signalfd_siginfo structs
    return sfd;
}
```

**Go comparison:** Go installs its own signal handlers to manage the runtime. The `os/signal` package provides `signal.Notify` which delivers signals to a channel, conceptually similar to `signalfd` but integrated with goroutines.

---
