## io_uring Deep Dive

io_uring (introduced in Linux 5.1 by Jens Axboe, commit `2b188cc1bb85`) is the first Linux interface that delivers true asynchronous I/O for both buffered and direct file operations, sockets, and an ever-growing list of syscalls. Unlike `epoll` (readiness notification) or POSIX AIO (broken for sockets, blocking for buffered files), io_uring uses two shared memory ring buffers between userspace and the kernel: a Submission Queue (SQ) and a Completion Queue (CQ). Senior engineers at FAANG-scale shops (Meta's Thrift, Google's gRPC experiments, Cloudflare's `pingora`-style proxies) treat io_uring as the default for new high-performance services on kernels >= 5.15 LTS.

> Junior -> FAANG: epoll tells you "the fd is ready, go syscall". io_uring tells you "I already did the syscall, here is the result." That is the whole insight, the rest is engineering.

### 1. Ring architecture (SQ / CQ)

After `io_uring_setup(2)` (syscall 425), the kernel returns a fd. You `mmap(2)` three regions:

1. SQ ring (head, tail, ring_mask, array of indices into SQE array)
2. CQ ring (head, tail, ring_mask, array of CQE structs)
3. SQE array (fixed-size submission entries, default 64 bytes each)

The producer (userspace) writes SQEs and bumps SQ tail. The consumer (kernel) reads SQ head. For completions it is mirrored: kernel produces, userspace consumes. Memory ordering requires `std::atomic_thread_fence(std::memory_order_acquire)` on read of tail and `release` on write -- the kernel uses `smp_load_acquire` / `smp_store_release` (see `io_uring/io_uring.c::io_uring_create`).

```cpp
struct io_uring_sqe {
  __u8  opcode;        // IORING_OP_*
  __u8  flags;         // IOSQE_*
  __u16 ioprio;
  __s32 fd;
  union { __u64 off; __u64 addr2; };
  union { __u64 addr; __u64 splice_off_in; };
  __u32 len;
  union { __kernel_rwf_t rw_flags; __u32 fsync_flags; /* ... */ };
  __u64 user_data;     // opaque; copied into CQE
  union { struct { __u16 buf_index; __u16 personality; }; __u64 __pad2[3]; };
};
struct io_uring_cqe {
  __u64 user_data;     // matches SQE
  __s32 res;           // syscall return value or -errno
  __u32 flags;         // IORING_CQE_F_*
};
```

`user_data` is how you correlate completions with continuations -- store a `void*` to a coroutine handle, a callback closure, or a 64-bit slab index. Never store a pointer to a stack frame, the SQE may complete after the function returns.

### 2. liburing minimal example, then the C++ wrapper

```cpp
// raw liburing -- read 4 KiB from a TCP socket
#include <liburing.h>

io_uring ring;
io_uring_queue_init(256, &ring, 0);

char buf[4096];
auto* sqe = io_uring_get_sqe(&ring);
io_uring_prep_recv(sqe, fd, buf, sizeof(buf), 0);
sqe->user_data = 42;
io_uring_submit(&ring);

io_uring_cqe* cqe;
io_uring_wait_cqe(&ring, &cqe);
if (cqe->res < 0) { /* -errno */ }
io_uring_cqe_seen(&ring, cqe);
```

A production C++ wrapper hides the ring and bridges to `std::coroutine`:

```cpp
class IoUring {
 public:
  explicit IoUring(unsigned entries, unsigned flags = 0) {
    io_uring_params p{};
    p.flags = flags;
    if (int rc = io_uring_queue_init_params(entries, &ring_, &p); rc < 0)
      throw std::system_error(-rc, std::system_category(), "io_uring_setup");
  }
  ~IoUring() { io_uring_queue_exit(&ring_); }
  IoUring(const IoUring&) = delete;
  IoUring& operator=(const IoUring&) = delete;

  io_uring_sqe* sqe() {
    auto* s = io_uring_get_sqe(&ring_);
    if (!s) {                       // ring full -> submit and retry
      io_uring_submit(&ring_);
      s = io_uring_get_sqe(&ring_);
      if (!s) throw std::runtime_error("SQ exhausted");
    }
    return s;
  }
  int submit() { return io_uring_submit(&ring_); }
  void run_once() {
    io_uring_cqe* cqe;
    if (io_uring_wait_cqe(&ring_, &cqe) < 0) return;
    unsigned head;
    int processed = 0;
    io_uring_for_each_cqe(&ring_, head, cqe) {
      auto* awaiter = reinterpret_cast<IoAwaiter*>(cqe->user_data);
      awaiter->result = cqe->res;
      awaiter->flags  = cqe->flags;
      awaiter->handle.resume();
      ++processed;
    }
    io_uring_cq_advance(&ring_, processed);
  }
 private:
  io_uring ring_{};
};
```

#### Coroutine awaiter

```cpp
struct IoAwaiter {
  IoUring* ring;
  std::function<void(io_uring_sqe*)> prep;
  int result = 0;
  unsigned flags = 0;
  std::coroutine_handle<> handle;

  bool await_ready() const noexcept { return false; }
  void await_suspend(std::coroutine_handle<> h) {
    handle = h;
    auto* s = ring->sqe();
    prep(s);
    s->user_data = reinterpret_cast<__u64>(this);
    ring->submit();
  }
  int await_resume() const {
    if (result < 0) throw std::system_error(-result, std::system_category());
    return result;
  }
};

inline IoAwaiter async_recv(IoUring& r, int fd, std::span<char> buf) {
  return {&r, [=](io_uring_sqe* s) {
    io_uring_prep_recv(s, fd, buf.data(), buf.size(), 0);
  }};
}

Task<void> echo(IoUring& r, int fd) {
  std::array<char, 4096> buf;
  while (true) {
    int n = co_await async_recv(r, fd, buf);
    if (n == 0) co_return;
    co_await async_send(r, fd, std::span(buf.data(), n));
  }
}
```

This is the same pattern Folly's `coro::Task` + `IoUringBackend` uses, see `folly/io/async/IoUringBackend.cpp`.

### 3. Opcodes worth knowing

| Opcode | Use |
|---------------------------------|---------------------------------------------|
| `IORING_OP_READ` / `WRITE` | pread64/pwrite64 replacement |
| `IORING_OP_RECV` / `SEND` | socket I/O without msghdr |
| `IORING_OP_RECVMSG` / `SENDMSG` | with control data, scatter/gather |
| `IORING_OP_ACCEPT` | replaces `accept4(2)`, returns connfd in `cqe->res` |
| `IORING_OP_CONNECT` | non-blocking connect |
| `IORING_OP_CLOSE` | offloaded close, no -EINTR worry |
| `IORING_OP_TIMEOUT` | absolute or relative timeout |
| `IORING_OP_LINK_TIMEOUT` | timeout linked to previous SQE |
| `IORING_OP_SPLICE` / `TEE` | zero-copy splice between fds |
| `IORING_OP_PROVIDE_BUFFERS` | feed kernel a pool, recv picks one |
| `IORING_OP_RECV_MULTISHOT` | one SQE -> many CQEs (5.19+) |
| `IORING_OP_ACCEPT_MULTISHOT` | one accept SQE keeps producing CQEs (5.19+) |
| `IORING_OP_SEND_ZC` | true zero-copy send (6.0+) |

### 4. Fixed buffers and fixed files

`io_uring_register(IORING_REGISTER_BUFFERS, iovecs, n)` pins userspace pages once and lets the kernel skip per-op `get_user_pages` overhead. Combined with `IORING_OP_READ_FIXED` / `WRITE_FIXED` you get a measurable 5-15% throughput bump on small ops (Axboe's numbers, LWN 776703).

`IORING_REGISTER_FILES` does the same for fds, subsequent SQEs reference the slot via `IOSQE_FIXED_FILE`. Required if you want SQPOLL because the polling thread cannot do `fdget` on every I/O.

```cpp
std::vector<iovec> iovs;
for (auto& slab : pool) iovs.push_back({slab.data(), slab.size()});
io_uring_register_buffers(&ring, iovs.data(), iovs.size());
// later:
io_uring_prep_read_fixed(sqe, fd, slab.data(), slab.size(), offset, /*buf_index=*/3);
```

### 5. SQPOLL -- kernel-side polling

`IORING_SETUP_SQPOLL` spawns a kernel thread that watches the SQ tail, userspace never enters the kernel for `submit()`. With `IORING_SETUP_SQ_AFF` you pin it to a CPU. Pros: zero-syscall hot path under load. Cons: a whole core burns at 100%, and you must use `IORING_REGISTER_FILES`. Worth it for >100k req/s, not worth it for a sidecar that does 5k/s.

```cpp
io_uring_params p{};
p.flags = IORING_SETUP_SQPOLL | IORING_SETUP_SQ_AFF;
p.sq_thread_cpu = 3;
p.sq_thread_idle = 2000;  // ms before kernel thread parks
io_uring_queue_init_params(4096, &ring, &p);
```

When the kernel thread parks (idle timeout exceeded), you must call `io_uring_enter(IORING_ENTER_SQ_WAKEUP)` -- liburing's `io_uring_submit()` handles that flag for you.

### 6. Multishot, linked SQEs, drain

- **Multishot accept** (kernel 5.19, commit `4e86a2c980137`): post one accept SQE, kernel keeps producing CQEs as connections arrive. Eliminates the re-arm round-trip that plagues classic accept loops. Watch `IORING_CQE_F_MORE` -- if it is unset, the multishot has terminated and you must re-post.
- **Linked SQEs** (`IOSQE_IO_LINK`): chain dependent ops in one submission. Common pattern: `connect` -> `LINK_TIMEOUT`. If the timeout fires first, the connect is canceled with `-ECANCELED`.
- **Drain** (`IOSQE_IO_DRAIN`): SQE waits until all prior ops complete -- expensive, basically a barrier. Use sparingly.

```cpp
auto* connect_sqe = io_uring_get_sqe(&ring);
io_uring_prep_connect(connect_sqe, fd, addr, addrlen);
connect_sqe->flags |= IOSQE_IO_LINK;
auto* timeout_sqe = io_uring_get_sqe(&ring);
__kernel_timespec ts{.tv_sec = 5};
io_uring_prep_link_timeout(timeout_sqe, &ts, 0);
io_uring_submit(&ring);
```

### 7. Backpressure

The SQ has a fixed depth. If the application produces SQEs faster than the kernel drains them, `io_uring_get_sqe()` returns NULL. You have three correct responses:

1. Call `io_uring_submit()` and retry (drains the SQ).
2. `io_uring_submit_and_wait(&ring, 1)` -- block until at least one CQE.
3. Apply application-level admission control: refuse new requests at the listener.

The wrong response is to busy-spin on `get_sqe`. The CQ has a separate depth (default `2 * entries`), if it overflows, the kernel sets `IORING_SQ_CQ_OVERFLOW` and stashes overflow CQEs in a kernel list (slow path). Size CQ via `IORING_SETUP_CQSIZE`.

### 8. Registered eventfd

You can integrate io_uring into a wider epoll/poll loop by registering an eventfd (`io_uring_register_eventfd`). The kernel signals the eventfd when CQEs arrive. Used by Tokio's io_uring driver and by some libuv backends to coexist with legacy code.

### 9. io_uring vs epoll, decision matrix

| Dimension | epoll | io_uring |
|-----------------------------------|--------------------------------------|---------------------------------------|
| Syscalls per I/O | 2 (epoll_wait + recv) | 0 with SQPOLL, 1-2 otherwise |
| File I/O | blocks for buffered reads | true async |
| Buffer registration | no | yes, ~10% gain |
| Cancellation | shutdown(2) hacks | `IORING_OP_ASYNC_CANCEL` |
| Linkage between ops | application-level | `IOSQE_IO_LINK` |
| Maturity | rock-solid since 2.6 | API stable from 5.15, quirks pre-6.x |
| Available in containers | always | often disabled (seccomp, gVisor) |
| Min kernel for "production-grade" | any | 5.15 LTS, ideally 6.1+ |

> Senior @ FAANG: do not migrate epoll-based services to io_uring just for benchmark pride. Migrate if (a) you saturate CPU on `epoll_wait` + syscall overhead, (b) you do mixed file + socket I/O, or (c) you can guarantee a recent kernel. Cloudflare's blog post "Missing Manuals: io_uring worker pools" (2022) is the canonical war story.

### 10. Security and sandbox concerns

io_uring has been the source of multiple CVEs (CVE-2023-2598 buffer registration, CVE-2024-0582 UAF). Google disabled io_uring in ChromeOS and on production borglets at one point. Mitigations:

- Compile with `IORING_SETUP_R_DISABLED` and gate `io_uring_register(IORING_REGISTER_ENABLE_RINGS)` behind a privileged init step.
- Use `seccomp` to allow only the opcodes you need (`IORING_RESTRICTION_SQE_OP`).
- Patch to the latest LTS, this subsystem still moves.

If you cannot patch, stay on epoll. Performance is not worth a kernel LPE.

