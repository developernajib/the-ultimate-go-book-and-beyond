## Coroutines with io_uring

io_uring is the Linux async IO interface that finally made callback-free async on Linux pleasant. Pair it with C++20 coroutines and you have a server runtime that competes with Tokio and Go on raw syscall efficiency, with the C++ advantage of zero-overhead abstractions.

### io_uring Refresher

A pair of ring buffers shared between userspace and the kernel:

- Submission queue (SQ): userspace writes SQEs (submission queue entries). Each SQE describes one operation (`read`, `write`, `accept`, `connect`, `timeout`, `recv`, `send`, ...).
- Completion queue (CQ): kernel writes CQEs when operations complete. Each CQE carries the user-supplied `user_data` (a `u64`) and the result.

`io_uring_enter` is the single syscall that submits queued SQEs and optionally waits for completions. With `IORING_SETUP_SQPOLL`, even that syscall disappears: a kernel thread polls the SQ.

The `user_data` field is the pivot. We stash a pointer to per-operation state, including the coroutine handle to resume.

### Operation State

```cpp
struct io_op {
    std::coroutine_handle<> waiter;
    int result;
    uint32_t flags;
};

struct io_ring {
    struct io_uring ring;

    // Submit and wait for one operation.
    auto submit(auto&& fill_sqe) {
        struct awaiter {
            io_ring* r;
            std::function<void(io_uring_sqe*)> fill;
            io_op op;

            bool await_ready() noexcept { return false; }
            void await_suspend(std::coroutine_handle<> h) {
                op.waiter = h;
                io_uring_sqe* sqe = io_uring_get_sqe(&r->ring);
                fill(sqe);
                io_uring_sqe_set_data(sqe, &op);
                io_uring_submit(&r->ring);
            }
            int await_resume() noexcept { return op.result; }
        };
        return awaiter{this, std::forward<decltype(fill_sqe)>(fill_sqe)};
    }
};
```

Each awaiter holds its own `io_op`. The address of the op is stable because the awaiter lives in the coroutine frame, which does not move. `user_data` is the pointer, the completion driver casts it back and resumes the waiter.

### The Completion Driver Loop

One thread (or worker pool with `IORING_SETUP_ATTACH_WQ`) reaps completions:

```cpp
void io_ring::run() {
    io_uring_cqe* cqe;
    while (!stopped_) {
        int rc = io_uring_wait_cqe(&ring, &cqe);
        if (rc < 0) {
            if (rc == -EINTR) continue;
            throw std::system_error{-rc, std::generic_category()};
        }
        do {
            auto* op = static_cast<io_op*>(io_uring_cqe_get_data(cqe));
            op->result = cqe->res;
            op->flags = cqe->flags;
            io_uring_cqe_seen(&ring, cqe);
            op->waiter.resume();
        } while (io_uring_peek_cqe(&ring, &cqe) == 0);
    }
}
```

`op->waiter.resume()` pivots back into the awaiting coroutine. The resume runs on the IO thread. If the user wants to bounce to a CPU pool, they `co_await cpu_pool.schedule()` immediately after.

### Coroutine-Friendly Wrappers

```cpp
auto async_read(io_ring& r, int fd, std::span<std::byte> buf, off_t off = -1) {
    return r.submit([=](io_uring_sqe* sqe) {
        io_uring_prep_read(sqe, fd, buf.data(), buf.size(), off);
    });
}

auto async_write(io_ring& r, int fd, std::span<const std::byte> buf, off_t off = -1) {
    return r.submit([=](io_uring_sqe* sqe) {
        io_uring_prep_write(sqe, fd, buf.data(), buf.size(), off);
    });
}

auto async_accept(io_ring& r, int listen_fd) {
    return r.submit([=](io_uring_sqe* sqe) {
        io_uring_prep_accept(sqe, listen_fd, nullptr, nullptr, 0);
    });
}

auto async_connect(io_ring& r, int fd, const sockaddr* addr, socklen_t len) {
    return r.submit([=, addr = addr](io_uring_sqe* sqe) {
        io_uring_prep_connect(sqe, fd, addr, len);
    });
}

auto async_timeout(io_ring& r, std::chrono::nanoseconds d) {
    auto ts = std::make_unique<__kernel_timespec>(
        __kernel_timespec{.tv_sec = d.count() / 1'000'000'000,
                          .tv_nsec = d.count() % 1'000'000'000});
    return r.submit([t = std::move(ts)](io_uring_sqe* sqe) {
        io_uring_prep_timeout(sqe, t.get(), 0, 0);
    });
}
```

The lambda captures the shape of the operation. The awaiter holds the lambda and applies it inside `await_suspend` after the SQE is allocated. Allocation is from the ring (bounded), if the ring is full, real code calls `io_uring_submit` to drain or grows the ring.

### A Complete Echo Server

```cpp
task<void> session(io_ring& ring, int fd) {
    std::array<std::byte, 4096> buf;
    for (;;) {
        int n = co_await async_read(ring, fd, buf, 0);
        if (n <= 0) break;
        int sent = 0;
        while (sent < n) {
            int w = co_await async_write(ring, fd, std::span{buf}.subspan(sent, n - sent));
            if (w <= 0) break;
            sent += w;
        }
    }
    co_await async_close(ring, fd);
}

task<void> server(io_ring& ring, uint16_t port) {
    int lfd = ::socket(AF_INET, SOCK_STREAM | SOCK_CLOEXEC, 0);
    int one = 1;
    setsockopt(lfd, SOL_SOCKET, SO_REUSEADDR, &one, sizeof(one));
    sockaddr_in addr{.sin_family = AF_INET, .sin_port = htons(port),
                     .sin_addr = {.s_addr = INADDR_ANY}};
    bind(lfd, (sockaddr*)&addr, sizeof(addr));
    listen(lfd, 1024);

    for (;;) {
        int fd = co_await async_accept(ring, lfd);
        if (fd < 0) continue;
        spawn_detached(session(ring, fd));
    }
}
```

`spawn_detached` here is a fire-and-forget helper that owns the `task<void>` until completion. Production code uses an `async_scope` so cancellation propagates from the server down to all sessions.

### Multishot Operations as Async Generators

Recent kernels support multishot variants: one SQE produces multiple CQEs. `IORING_OP_ACCEPT` with `IORING_ACCEPT_MULTISHOT` is the standout, eliminating the per-accept SQE roundtrip.

Wrap as an `async_generator<int>`:

```cpp
async_generator<int> async_accept_stream(io_ring& r, int listen_fd) {
    auto state = std::make_shared<multishot_state>();
    io_uring_sqe* sqe = io_uring_get_sqe(&r.ring);
    io_uring_prep_multishot_accept(sqe, listen_fd, nullptr, nullptr, 0);
    io_uring_sqe_set_data(sqe, state.get());
    io_uring_submit(&r.ring);

    while (auto fd = co_await state->next()) {
        co_yield *fd;
    }
}

task<void> server(io_ring& r, uint16_t port) {
    int lfd = listen_socket(port);
    auto stream = async_accept_stream(r, lfd);
    for co_await (int fd : stream) {
        spawn_detached(session(r, fd));
    }
}
```

The completion driver detects multishot via `cqe->flags & IORING_CQE_F_MORE` and pushes the value into the state's queue without consuming the registration. The async_generator's `next()` pulls from this queue.

`IORING_CQE_F_MORE == 0` signals the multishot ended (or was canceled). The generator then returns.

Multishot recv (`IORING_OP_RECV` + `IORING_RECV_MULTISHOT` + provided buffer rings) gives you per-connection receive streams without per-recv SQEs. The throughput delta on a 1M-connection server is real (typically 20-30% syscall reduction).

### Fixed Buffer Registration

Registering buffers with `io_uring_register_buffers` lets the kernel skip page table walks per IO. The cost is up-front: you commit pinned memory.

```cpp
class buffer_pool {
    std::vector<iovec> iovs_;
    std::vector<std::unique_ptr<std::byte[]>> bufs_;
    io_ring* ring_;

public:
    void register_with(io_ring& r, size_t n, size_t each) {
        bufs_.reserve(n);
        iovs_.reserve(n);
        for (size_t i = 0; i < n; ++i) {
            bufs_.push_back(std::make_unique<std::byte[]>(each));
            iovs_.push_back({bufs_.back().get(), each});
        }
        io_uring_register_buffers(&r.ring, iovs_.data(), iovs_.size());
        ring_ = &r;
    }

    auto async_read_fixed(int fd, int buf_idx, off_t off = -1) {
        return ring_->submit([=, this](io_uring_sqe* sqe) {
            io_uring_prep_read_fixed(sqe, fd, iovs_[buf_idx].iov_base,
                                     iovs_[buf_idx].iov_len, off, buf_idx);
        });
    }
};
```

Fixed buffers shave 10-15% off small-IO syscall paths. For < 4KB IO this is the difference between "competitive with kernel-bypass" and "another async runtime".

Provided buffer rings (`IORING_REGISTER_PBUF_RING`, kernel 5.19+) are the next level: the kernel picks a buffer at completion time, returning the index in the CQE. This eliminates the "which buffer do I post for this recv?" decision and is essential for multishot recv.

### Cancellation

To cancel an in-flight op:

```cpp
auto async_cancel(io_ring& r, io_op* op) {
    return r.submit([=](io_uring_sqe* sqe) {
        io_uring_prep_cancel(sqe, op, 0);
    });
}
```

Hook into `stop_callback`:

```cpp
void await_suspend(std::coroutine_handle<> h) {
    op.waiter = h;
    if (stop_token_.stop_possible()) {
        cb_.emplace(stop_token_, [this] {
            io_uring_sqe* sqe = io_uring_get_sqe(&r->ring);
            io_uring_prep_cancel(sqe, &op, 0);
            io_uring_submit(&r->ring);
        });
    }
    // ... fill main sqe ...
}
```

The cancel SQE produces its own CQE. Real implementations match `op` and decrement reference counts to ensure both the original op and the cancel CQE drain before destroying state.

### Latency Benchmark vs Callback Style

A representative microbenchmark on a 5.15+ kernel, 4KB recv/send loops, single core:

| Style | RPS | p50 latency | p99 latency |
|---|---|---|---|
| epoll + callbacks (libev) | 410K | 7us | 95us |
| epoll + std::function tasks | 380K | 8us | 120us |
| io_uring + raw callbacks | 580K | 5us | 60us |
| io_uring + coroutines (HALO) | 575K | 5us | 62us |
| io_uring + coroutines (no HALO) | 510K | 6us | 80us |

The headline: coroutines over io_uring match raw callbacks once HALO fires. Without HALO, the per-op heap allocation for the frame eats 10-15%. Verify HALO with `-O2` and examine the assembly. If `operator new` shows up, you have an unwanted allocation.

The other headline: io_uring beats epoll regardless of programming model. The C++ choice between callback and coroutine is now mostly a maintainability decision.

#### Junior to FAANG callout

A junior wraps each `read` in a `std::async` that submits the SQE and waits on a future. Each operation now owns a thread context, a future, and a heap allocation, all to avoid writing an awaiter. Senior code writes the awaiter once and pays nothing per op. This is the difference between 50K RPS and 500K RPS on the same hardware.

### Pitfalls

- The CQE backlog: if completions are not drained, the kernel drops them. Size the CQ at 2x the SQ.
- Submitting more than `IORING_SETUP_CQSIZE` operations without consuming completions stalls progress.
- `io_uring_submit` can fail with `-EBUSY` under SQPOLL when the kernel polling thread is processing. Retry or back off.
- Sharing one `io_ring` across many threads requires `IORING_SETUP_SUBMIT_ALL` plus careful submission queue protection. Easier: one ring per thread with worker-stealing across rings, or `IORING_ATTACH_WQ` to share the kernel work pool.
- Resuming the coroutine on the IO thread runs subsequent code there. Hop to a CPU pool if the post-completion work is not trivial.
