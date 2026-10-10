## 3. I/O Multiplexing: select, poll, epoll, kqueue, IOCP

The fundamental problem: a server handling thousands of connections cannot create a thread per connection (too expensive) and cannot call `read` on each socket sequentially (too slow). I/O multiplexing lets a single thread monitor many file descriptors and react only when data is available.

### select (Portable, Limited)

The oldest multiplexing API. Limited to `FD_SETSIZE` (typically 1024) file descriptors. Uses bitmask scanning, O(n) per call.

```cpp
#include <sys/select.h>

void select_echo(int listen_fd) {
    fd_set master_set;
    FD_ZERO(&master_set);
    FD_SET(listen_fd, &master_set);
    int max_fd = listen_fd;

    while (true) {
        fd_set read_set = master_set;
        struct timeval tv = {5, 0};  // 5-second timeout
        int ready = ::select(max_fd + 1, &read_set, nullptr, nullptr, &tv);
        if (ready < 0) {
            if (errno == EINTR) continue;
            break;
        }
        if (ready == 0) continue;  // Timeout

        for (int fd = 0; fd <= max_fd; ++fd) {
            if (!FD_ISSET(fd, &read_set)) continue;

            if (fd == listen_fd) {
                int client = ::accept(listen_fd, nullptr, nullptr);
                FD_SET(client, &master_set);
                if (client > max_fd) max_fd = client;
            } else {
                char buf[1024];
                ssize_t n = ::read(fd, buf, sizeof(buf));
                if (n <= 0) {
                    ::close(fd);
                    FD_CLR(fd, &master_set);
                } else {
                    ::write(fd, buf, n);
                }
            }
        }
    }
}
```

### poll (No FD Limit, Still O(n))

Replaces bitmasks with an array of `pollfd` structs, removing the `FD_SETSIZE` limit but still requiring a linear scan.

```cpp
#include <poll.h>
#include <vector>

void poll_echo(int listen_fd) {
    std::vector<pollfd> fds;
    fds.push_back({listen_fd, POLLIN, 0});

    while (true) {
        int ready = ::poll(fds.data(), fds.size(), 5000);
        if (ready < 0) { if (errno == EINTR) continue; break; }

        for (size_t i = 0; i < fds.size(); ++i) {
            if (!(fds[i].revents & POLLIN)) continue;

            if (fds[i].fd == listen_fd) {
                int client = ::accept(listen_fd, nullptr, nullptr);
                fds.push_back({client, POLLIN, 0});
            } else {
                char buf[1024];
                ssize_t n = ::read(fds[i].fd, buf, sizeof(buf));
                if (n <= 0) {
                    ::close(fds[i].fd);
                    fds.erase(fds.begin() + i);
                    --i;
                } else {
                    ::write(fds[i].fd, buf, n);
                }
            }
        }
    }
}
```

### epoll (Linux, O(1) for Ready Events)

The workhorse of high-performance Linux networking. Epoll maintains a kernel-side interest list and returns only the file descriptors that are ready, O(1) amortized for the common case of few ready fds among many monitored.

```cpp
#include <sys/epoll.h>
#include <vector>

class EpollReactor {
    int epfd_ = -1;

public:
    EpollReactor() {
        epfd_ = epoll_create1(EPOLL_CLOEXEC);
        if (epfd_ < 0) throw std::runtime_error("epoll_create1 failed");
    }

    ~EpollReactor() { if (epfd_ >= 0) ::close(epfd_); }

    void add(int fd, uint32_t events) {
        epoll_event ev{};
        ev.events = events;
        ev.data.fd = fd;
        if (epoll_ctl(epfd_, EPOLL_CTL_ADD, fd, &ev) < 0)
            throw std::runtime_error("epoll_ctl ADD failed");
    }

    void modify(int fd, uint32_t events) {
        epoll_event ev{};
        ev.events = events;
        ev.data.fd = fd;
        epoll_ctl(epfd_, EPOLL_CTL_MOD, fd, &ev);
    }

    void remove(int fd) {
        epoll_ctl(epfd_, EPOLL_CTL_DEL, fd, nullptr);
    }

    int wait(std::vector<epoll_event>& events, int timeout_ms) {
        return epoll_wait(epfd_, events.data(),
                          static_cast<int>(events.size()), timeout_ms);
    }
};

void epoll_echo_server(uint16_t port) {
    TcpServer server(port);
    EpollReactor reactor;

    // Use edge-triggered mode for maximum performance
    reactor.add(server.fd(), EPOLLIN | EPOLLET);

    std::vector<epoll_event> events(1024);

    while (true) {
        int n = reactor.wait(events, -1);
        for (int i = 0; i < n; ++i) {
            if (events[i].data.fd == server.fd()) {
                // Accept all pending connections (edge-triggered)
                while (true) {
                    int client = ::accept4(server.fd(), nullptr, nullptr,
                                           SOCK_NONBLOCK);
                    if (client < 0) break;
                    reactor.add(client, EPOLLIN | EPOLLET);
                }
            } else {
                int fd = events[i].data.fd;
                char buf[4096];
                ssize_t r;
                // Read all available data (edge-triggered)
                while ((r = ::read(fd, buf, sizeof(buf))) > 0) {
                    ::write(fd, buf, r);
                }
                if (r == 0 || (r < 0 && errno != EAGAIN)) {
                    reactor.remove(fd);
                    ::close(fd);
                }
            }
        }
    }
}
```

**Edge-triggered vs level-triggered:** Level-triggered (default) re-reports a descriptor every time `epoll_wait` is called while data remains. Edge-triggered reports only on state transitions, you must drain the entire buffer in one pass or you will miss events. Edge-triggered is more efficient but more error-prone.

### kqueue (BSD/macOS) and IOCP (Windows)

On BSD/macOS, `kqueue` serves the same role as epoll with a slightly different API using `kevent` structures. On Windows, I/O Completion Ports (IOCP) provide a proactor model where the OS completes I/O operations and notifies you, the inverse of epoll's reactor model where you are told when I/O *can* proceed.

```cpp
// kqueue sketch (BSD/macOS)
#ifdef __APPLE__
#include <sys/event.h>

void kqueue_example(int listen_fd) {
    int kq = kqueue();
    struct kevent change;
    EV_SET(&change, listen_fd, EVFILT_READ, EV_ADD, 0, 0, nullptr);
    kevent(kq, &change, 1, nullptr, 0, nullptr);

    struct kevent events[64];
    while (true) {
        int n = kevent(kq, nullptr, 0, events, 64, nullptr);
        for (int i = 0; i < n; ++i) {
            int fd = static_cast<int>(events[i].ident);
            // Handle event...
        }
    }
    ::close(kq);
}
#endif
```

Go's runtime uses epoll on Linux, kqueue on BSD/macOS, and IOCP on Windows, the `netpoller` abstraction selects the right mechanism at compile time. This is why goroutines can block on I/O without consuming an OS thread.

---
