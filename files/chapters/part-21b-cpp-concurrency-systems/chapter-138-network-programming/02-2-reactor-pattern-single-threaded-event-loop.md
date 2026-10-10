## 2. Reactor Pattern: Single-Threaded Event Loop

The Reactor pattern demultiplexes I/O events from multiple sources using a single thread. An event loop waits for readiness notifications (via `epoll`, `kqueue`, or `io_uring`) and dispatches handlers for each ready file descriptor. This is the architecture behind Redis, Node.js, and Nginx's worker processes.

```cpp
#include <sys/epoll.h>
#include <functional>
#include <unordered_map>
#include <vector>
#include <stdexcept>

class Reactor {
public:
    using EventHandler = std::function<void(uint32_t events)>;

    Reactor() {
        epoll_fd_ = epoll_create1(0);
        if (epoll_fd_ < 0) throw std::runtime_error("epoll_create1 failed");
    }

    ~Reactor() { close(epoll_fd_); }

    // Register a file descriptor with an event handler
    void register_handler(int fd, uint32_t events, EventHandler handler) {
        epoll_event ev{};
        ev.events = events;
        ev.data.fd = fd;

        if (epoll_ctl(epoll_fd_, EPOLL_CTL_ADD, fd, &ev) < 0) {
            throw std::runtime_error("epoll_ctl ADD failed");
        }
        handlers_[fd] = std::move(handler);
    }

    void remove_handler(int fd) {
        epoll_ctl(epoll_fd_, EPOLL_CTL_DEL, fd, nullptr);
        handlers_.erase(fd);
    }

    // Run the event loop
    void run() {
        constexpr int MAX_EVENTS = 64;
        std::vector<epoll_event> events(MAX_EVENTS);
        running_ = true;

        while (running_) {
            int n = epoll_wait(epoll_fd_, events.data(), MAX_EVENTS, -1);
            if (n < 0) {
                if (errno == EINTR) continue;
                throw std::runtime_error("epoll_wait failed");
            }

            for (int i = 0; i < n; ++i) {
                int fd = events[i].data.fd;
                auto it = handlers_.find(fd);
                if (it != handlers_.end()) {
                    it->second(events[i].events);
                }
            }
        }
    }

    void stop() { running_ = false; }

private:
    int epoll_fd_;
    bool running_ = false;
    std::unordered_map<int, EventHandler> handlers_;
};
```

Using the Reactor to build a simple echo server:

```cpp
void run_echo_server(uint16_t port) {
    int server_fd = create_tcp_server(port);
    set_nonblocking(server_fd);  // must be non-blocking for epoll

    Reactor reactor;

    reactor.register_handler(server_fd, EPOLLIN, [&](uint32_t) {
        sockaddr_in client_addr{};
        socklen_t len = sizeof(client_addr);
        int client_fd = accept4(server_fd,
            reinterpret_cast<sockaddr*>(&client_addr), &len,
            SOCK_NONBLOCK);

        if (client_fd < 0) return;

        reactor.register_handler(client_fd,
            EPOLLIN | EPOLLET,  // edge-triggered for efficiency
            [&reactor, client_fd](uint32_t events) {
                char buf[4096];
                while (true) {
                    ssize_t n = read(client_fd, buf, sizeof(buf));
                    if (n > 0) {
                        write(client_fd, buf, n);  // echo back
                    } else if (n == 0) {
                        reactor.remove_handler(client_fd);
                        close(client_fd);
                        break;
                    } else if (errno == EAGAIN) {
                        break;  // no more data (edge-triggered)
                    }
                }
            });
    });

    reactor.run();
}
```

**Edge-triggered vs. Level-triggered**: Level-triggered (`EPOLLIN`) fires every time `epoll_wait` is called while data is available. Edge-triggered (`EPOLLIN | EPOLLET`) fires only when new data arrives. Edge-triggered is more efficient but requires draining the buffer completely in each callback, miss a read and you will never be notified again until new data arrives.

---
