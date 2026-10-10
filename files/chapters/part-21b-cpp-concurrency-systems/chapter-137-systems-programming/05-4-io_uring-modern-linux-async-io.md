## 4. Io_uring: Modern Linux Async I/O

`io_uring`, introduced in Linux 5.1, is a revolution in kernel-userspace I/O. It uses two lock-free ring buffers shared between userspace and the kernel, a Submission Queue (SQ) where you post I/O requests and a Completion Queue (CQ) where the kernel delivers results. This eliminates system call overhead for the common path.

```cpp
#include <liburing.h>
#include <fcntl.h>
#include <cstring>
#include <iostream>
#include <stdexcept>

class IoUring {
    struct io_uring ring_{};

public:
    explicit IoUring(unsigned entries = 256) {
        int ret = io_uring_queue_init(entries, &ring_, 0);
        if (ret < 0)
            throw std::runtime_error(
                std::string("io_uring_queue_init: ") + strerror(-ret));
    }

    ~IoUring() { io_uring_queue_exit(&ring_); }

    // Submit a read operation
    void submit_read(int fd, void* buf, size_t len, off_t offset,
                     void* user_data) {
        struct io_uring_sqe* sqe = io_uring_get_sqe(&ring_);
        if (!sqe) throw std::runtime_error("SQ full");
        io_uring_prep_read(sqe, fd, buf, len, offset);
        io_uring_sqe_set_data(sqe, user_data);
        io_uring_submit(&ring_);
    }

    // Submit a write operation
    void submit_write(int fd, const void* buf, size_t len, off_t offset,
                      void* user_data) {
        struct io_uring_sqe* sqe = io_uring_get_sqe(&ring_);
        if (!sqe) throw std::runtime_error("SQ full");
        io_uring_prep_write(sqe, fd, buf, len, offset);
        io_uring_sqe_set_data(sqe, user_data);
        io_uring_submit(&ring_);
    }

    // Wait for a completion
    struct io_uring_cqe* wait_completion() {
        struct io_uring_cqe* cqe = nullptr;
        int ret = io_uring_wait_cqe(&ring_, &cqe);
        if (ret < 0)
            throw std::runtime_error("io_uring_wait_cqe failed");
        return cqe;
    }

    void mark_seen(struct io_uring_cqe* cqe) {
        io_uring_cqe_seen(&ring_, cqe);
    }
};

// Read a file asynchronously using io_uring
void async_file_read(const char* path) {
    int fd = ::open(path, O_RDONLY);
    if (fd < 0) return;

    IoUring ring(32);
    char buf[4096];
    int request_id = 1;

    ring.submit_read(fd, buf, sizeof(buf), 0, &request_id);

    auto* cqe = ring.wait_completion();
    auto* id = static_cast<int*>(io_uring_cqe_get_data(cqe));
    std::cout << "Request " << *id << " completed: "
              << cqe->res << " bytes\n";
    ring.mark_seen(cqe);

    ::close(fd);
}
```

**Why io_uring matters:** It supports nearly every I/O operation (reads, writes, accepts, connects, sends, receives, `fsync`, `openat`, and more) through a single unified interface. Batching multiple submissions into one syscall and polling for completions without syscalls makes it substantially faster than epoll for high-throughput workloads. It also supports linked operations (chains) and fixed buffers to eliminate per-operation overhead.

---
