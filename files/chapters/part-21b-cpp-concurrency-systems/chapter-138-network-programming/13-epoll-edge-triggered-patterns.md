## epoll Edge-Triggered Patterns

`epoll` (Linux 2.5.44, October 2002) replaced O(n) `select`/`poll` with an O(1) ready-list. Most C++ network code that has not migrated to io_uring still lives on epoll: nginx, HAProxy, Envoy's default poller, Folly's `EventBase`, libev, libevent. Getting epoll right at the edge-triggered (ET) level is the difference between a server that handles 200k connections per worker and one that silently stalls under load.

### 1. Level-triggered vs edge-triggered

- **LT (default, `EPOLLIN`/`EPOLLOUT` without `EPOLLET`)**: epoll keeps reporting readiness as long as the buffer has data. You can be lazy and read once per wakeup, the next `epoll_wait` will tell you again.
- **ET (`EPOLLET`)**: edge transition only. You must drain until `recv` returns `EAGAIN`. Forget that drain loop and the connection hangs forever, because you will never get another wakeup until *new* data arrives.

ET wins on syscalls: under load, LT hands you the same fd repeatedly while you slowly process it. ET tells you once and trusts you. ET is mandatory if you want to combine `EPOLLEXCLUSIVE` with multiple workers (see section 4).

### 2. The drain loop

```cpp
// Required ET read pattern. Anything else is a bug.
ssize_t total = 0;
for (;;) {
  char buf[8192];
  ssize_t n = ::recv(fd, buf, sizeof(buf), 0);
  if (n > 0) {
    parser.feed(buf, n);
    total += n;
    continue;
  }
  if (n == 0) { close_connection(fd); break; }      // peer FIN
  if (errno == EINTR) continue;
  if (errno == EAGAIN || errno == EWOULDBLOCK) break;  // drained
  log_err("recv failed: %s", strerror(errno));
  close_connection(fd);
  break;
}
```

The mirror for writes:

```cpp
while (!out_queue.empty()) {
  auto& chunk = out_queue.front();
  ssize_t n = ::send(fd, chunk.data() + chunk.off, chunk.size() - chunk.off, MSG_NOSIGNAL);
  if (n >= 0) {
    chunk.off += n;
    if (chunk.off == chunk.size()) out_queue.pop_front();
    continue;
  }
  if (errno == EINTR) continue;
  if (errno == EAGAIN || errno == EWOULDBLOCK) {
    arm_epollout(fd);    // only now do you care about EPOLLOUT
    break;
  }
  if (errno == EPIPE) { close_connection(fd); break; }
  // ECONNRESET, ENOBUFS, etc.
  close_connection(fd); break;
}
```

> Junior -> FAANG: Do not arm `EPOLLOUT` permanently. It will fire on every wakeup because the socket is almost always writable. Arm it only when `send` returned `EAGAIN`, and disarm when the queue empties. This is the single most common source of 100% CPU in junior network code.

### 3. EPOLLONESHOT: serializing wakeups across threads

`EPOLLONESHOT` disables the fd in epoll after one wakeup. The thread that took the event must `epoll_ctl(EPOLL_CTL_MOD, ...)` to re-arm. This is how Java's NIO, Folly's `EventBaseManager`, and the original libuv worker model achieve "exactly one thread sees this fd at a time" without locks.

```cpp
epoll_event ev{};
ev.events = EPOLLIN | EPOLLET | EPOLLONESHOT | EPOLLRDHUP;
ev.data.ptr = conn;
epoll_ctl(epfd, EPOLL_CTL_ADD, conn->fd, &ev);

// after handling:
ev.events = EPOLLIN | EPOLLET | EPOLLONESHOT | EPOLLRDHUP;
epoll_ctl(epfd, EPOLL_CTL_MOD, conn->fd, &ev);    // re-arm
```

Forgetting to re-arm strands the connection. If you `close(fd)` before re-arming you must remove the lambda/closure to avoid use-after-free, since other threads may already hold the `data.ptr`.

### 4. EPOLLEXCLUSIVE and the thundering herd

Linux 4.5 (`EPOLLEXCLUSIVE`, commit `df0108c5da56`) fixes the classic accept-thundering-herd: with N workers all calling `epoll_wait` on the same listening fd, a single connection wakes only one waiter. Without it, all N wake up, N-1 fail with `EAGAIN`, you waste O(N) syscalls.

```cpp
epoll_event ev{};
ev.events  = EPOLLIN | EPOLLEXCLUSIVE;     // ET is NOT compatible -- 4.5..5.0
ev.data.fd = listen_fd;
epoll_ctl(epfd, EPOLL_CTL_ADD, listen_fd, &ev);
```

Constraints:

- `EPOLLEXCLUSIVE` cannot combine with `EPOLLET` until kernel 5.x, check with `uname -r`.
- Cannot use `EPOLL_CTL_MOD` to add it later, must be set on `EPOLL_CTL_ADD`.
- If your workers each have their own `epfd`, you do not need `EPOLLEXCLUSIVE`, the listening fd in each epoll instance is independent. `EPOLLEXCLUSIVE` is for the case where workers share one `epfd`.

The alternative, used by nginx until 1.11.3, is the `accept_mutex`: a userspace mutex that serializes which worker calls `accept`. It works on every kernel but adds a contended lock. With `SO_REUSEPORT` (see SO_REUSEPORT and Kernel-Side Load Distribution) the discussion becomes moot for listening sockets -- each worker has its own listen fd and the kernel does the dispatch.

### 5. EPOLLRDHUP and half-close detection

`EPOLLRDHUP` (Linux 2.6.17) signals that the peer sent FIN. Without it, you only learn about peer close when `recv` returns 0 -- which means you cannot detect half-close on an idle connection unless you also keep `EPOLLIN` armed. Always include `EPOLLRDHUP | EPOLLHUP | EPOLLERR` in your event mask.

```cpp
if (ev.events & (EPOLLERR | EPOLLHUP)) {
  int err = 0; socklen_t len = sizeof(err);
  getsockopt(fd, SOL_SOCKET, SO_ERROR, &err, &len);
  log_err("conn %d error: %s", fd, strerror(err));
  close_connection(fd);
  return;
}
if (ev.events & EPOLLRDHUP) {
  // peer closed write side - finish writing what we owe, then close
  start_graceful_shutdown(conn);
}
```

### 6. Production reactor skeleton

```cpp
class Reactor {
 public:
  Reactor() : epfd_(epoll_create1(EPOLL_CLOEXEC)) {
    if (epfd_ < 0) throw std::system_error(errno, std::system_category(), "epoll_create1");
  }
  ~Reactor() { ::close(epfd_); }

  void add(int fd, uint32_t events, IHandler* h) {
    epoll_event ev{.events = events, .data{.ptr = h}};
    if (epoll_ctl(epfd_, EPOLL_CTL_ADD, fd, &ev) < 0)
      throw std::system_error(errno, std::system_category(), "EPOLL_CTL_ADD");
  }
  void mod(int fd, uint32_t events, IHandler* h) {
    epoll_event ev{.events = events, .data{.ptr = h}};
    epoll_ctl(epfd_, EPOLL_CTL_MOD, fd, &ev);
  }
  void del(int fd) { epoll_ctl(epfd_, EPOLL_CTL_DEL, fd, nullptr); }

  void run(int timeout_ms = -1) {
    std::array<epoll_event, 1024> events;
    while (running_.load(std::memory_order_relaxed)) {
      int n = epoll_wait(epfd_, events.data(), events.size(), timeout_ms);
      if (n < 0) {
        if (errno == EINTR) continue;
        throw std::system_error(errno, std::system_category(), "epoll_wait");
      }
      for (int i = 0; i < n; ++i) {
        auto* h = static_cast<IHandler*>(events[i].data.ptr);
        h->handle(events[i].events);
      }
    }
  }
  void stop() { running_ = false; }
 private:
  int epfd_;
  std::atomic<bool> running_{true};
};
```

`IHandler::handle(uint32_t events)` dispatches to the connection or listener, which runs the drain loop and updates state. RAII ownership: `IHandler` is owned by a `std::unique_ptr` in a per-connection slab, `del(fd)` is called from the destructor *after* `close(fd)` so a concurrent worker cannot pick up a recycled fd referring to a freed handler. On Linux, `epoll_ctl(EPOLL_CTL_DEL)` followed by `close()` is racy under multi-threaded epoll only if multiple threads share `epfd_`, per-thread reactors avoid the race entirely.

### 7. Listener with edge-triggered accept

```cpp
struct Listener : IHandler {
  int fd;
  Reactor& r;
  void handle(uint32_t) override {
    while (true) {
      sockaddr_storage ss; socklen_t sl = sizeof(ss);
      int c = ::accept4(fd, (sockaddr*)&ss, &sl, SOCK_NONBLOCK | SOCK_CLOEXEC);
      if (c >= 0) {
        on_accept(c, (sockaddr*)&ss, sl);
        continue;
      }
      if (errno == EINTR) continue;
      if (errno == EAGAIN || errno == EWOULDBLOCK) return;
      if (errno == EMFILE || errno == ENFILE) {
        // fd exhaustion: trick from Marc Lehmann (libev)
        ::close(spare_fd_);
        int discard = ::accept4(fd, nullptr, nullptr, 0);
        ::close(discard);
        spare_fd_ = ::open("/dev/null", O_RDONLY);
        return;
      }
      log_err("accept4: %s", strerror(errno));
      return;
    }
  }
};
```

The "spare fd" pattern keeps the server alive under fd exhaustion: you close a placeholder, accept and immediately close the offending connection, then reopen the placeholder. Without it, an `EMFILE` storm freezes the listener forever because epoll keeps reporting `EPOLLIN` on a fd you cannot accept.

### 8. Production proxy skeleton (HTTP-style)

```cpp
struct Conn : IHandler {
  int fd;
  Reactor* r;
  std::deque<Buf> out;
  Parser parser;
  bool want_close = false;

  void handle(uint32_t events) override {
    if (events & (EPOLLERR | EPOLLHUP)) { teardown(); return; }
    if (events & EPOLLIN)  do_read();
    if (events & EPOLLOUT) do_write();
    if (want_close && out.empty()) teardown();
  }

  void do_read() {
    char buf[16384];
    for (;;) {
      ssize_t n = ::recv(fd, buf, sizeof(buf), 0);
      if (n > 0) { parser.feed(buf, n); continue; }
      if (n == 0) { want_close = true; return; }
      if (errno == EINTR) continue;
      if (errno == EAGAIN) return;
      teardown(); return;
    }
  }
  void do_write() { /* mirror image; arm/disarm EPOLLOUT */ }
  void teardown() {
    r->del(fd);
    ::close(fd);
    delete this;          // or release from slab
  }
};
```

Common bug: calling `delete this` while the same fd has more events pending in the same `epoll_wait` batch. Defense: process all events from a batch through a stable `data.ptr`, and defer `delete` to end-of-loop via a "to-close" list.

### 9. Tuning knobs

- `epoll_create1(EPOLL_CLOEXEC)` -- always set CLOEXEC, avoid leaking epfd to children.
- `epoll_wait` batch size of 1024-4096 is fine, larger batches mostly waste cache.
- `fs.epoll.max_user_watches` (sysctl) caps total fds across all epoll instances per uid, bump for >1M connections.
- Consider `epoll_pwait2(2)` (Linux 5.11) for ns-precision timeouts, useful when integrating with deadline propagation.

### 10. When epoll is the wrong tool

- Pure file I/O on buffered fds: epoll always returns "ready" for regular files. Use io_uring or a thread pool with `pread`.
- Timers: `timerfd` is fine but io_uring's `IORING_OP_TIMEOUT` has lower overhead at scale.
- Cross-process notifications: `eventfd` + epoll works, but consider `signalfd` for signals so you avoid signal-safety hell.
- Windows portability: use IOCP (Boost.Asio abstracts this) -- epoll has no Windows equivalent.

