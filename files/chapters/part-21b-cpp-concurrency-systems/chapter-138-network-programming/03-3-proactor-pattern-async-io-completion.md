## 3. Proactor Pattern: Async I/O Completion

Where the Reactor pattern notifies you when I/O is *ready*, the Proactor pattern notifies you when I/O is *complete*. You submit an operation (read 4096 bytes from this socket), and the OS performs the I/O in the background, then notifies your completion handler.

On Linux, `io_uring` (kernel 5.1+) provides true asynchronous I/O. On Windows, IOCP (I/O Completion Ports) has offered this model since Windows NT.

```cpp
#include <liburing.h>
#include <cstring>

class Proactor {
public:
    Proactor(unsigned queue_depth = 256) {
        if (io_uring_queue_init(queue_depth, &ring_, 0) < 0) {
            throw std::runtime_error("io_uring_queue_init failed");
        }
    }

    ~Proactor() { io_uring_queue_exit(&ring_); }

    // Submit an async read - the kernel performs the read, we get notified
    // when it completes with data already in our buffer
    void async_read(int fd, void* buf, size_t len, uint64_t user_data) {
        io_uring_sqe* sqe = io_uring_get_sqe(&ring_);
        io_uring_prep_read(sqe, fd, buf, len, 0);
        io_uring_sqe_set_data64(sqe, user_data);
        io_uring_submit(&ring_);
    }

    void async_write(int fd, const void* buf, size_t len, uint64_t user_data) {
        io_uring_sqe* sqe = io_uring_get_sqe(&ring_);
        io_uring_prep_write(sqe, fd, buf, len, 0);
        io_uring_sqe_set_data64(sqe, user_data);
        io_uring_submit(&ring_);
    }

    void async_accept(int server_fd, sockaddr* addr, socklen_t* len,
                      uint64_t user_data) {
        io_uring_sqe* sqe = io_uring_get_sqe(&ring_);
        io_uring_prep_accept(sqe, server_fd, addr, len, 0);
        io_uring_sqe_set_data64(sqe, user_data);
        io_uring_submit(&ring_);
    }

    struct Completion {
        uint64_t user_data;
        int32_t result;  // bytes transferred, or negative errno
    };

    // Wait for the next completed I/O operation
    Completion wait_one() {
        io_uring_cqe* cqe;
        if (io_uring_wait_cqe(&ring_, &cqe) < 0) {
            throw std::runtime_error("io_uring_wait_cqe failed");
        }
        Completion c{io_uring_cqe_get_data64(cqe), cqe->res};
        io_uring_cqe_seen(&ring_, cqe);
        return c;
    }

private:
    io_uring ring_;
};
```

The Proactor eliminates the need for non-blocking sockets and readiness polling. The kernel handles the data transfer. Your code only runs when data is already in your buffer. This reduces context switches and is particularly effective for disk I/O where `epoll` offers no benefit (disk reads are always "ready" in epoll, but may still block).

**Reactor vs Proactor summary**:

| Aspect | Reactor (epoll) | Proactor (io_uring) |
|--------|-----------------|---------------------|
| Notification | I/O is ready | I/O is complete |
| Buffer management | Application reads/writes | Kernel reads/writes |
| Syscalls per I/O | 2 (epoll_wait + read) | 1 (batched submit) |
| Disk I/O support | Poor (always "ready") | Excellent |
| Complexity | Lower | Higher |

---
