## 5. Zero-Copy Techniques

Traditional I/O copies data from kernel buffer to userspace and back. Zero-copy techniques eliminate these copies, keeping data in kernel space throughout the transfer.

### sendfile

Transfers data directly from one file descriptor to another within the kernel. The classic use case is serving static files over a TCP socket.

```cpp
#include <sys/sendfile.h>

// Send an entire file over a socket without copying to userspace
ssize_t send_file(int socket_fd, int file_fd, size_t file_size) {
    off_t offset = 0;
    size_t remaining = file_size;

    while (remaining > 0) {
        ssize_t sent = sendfile(socket_fd, file_fd, &offset, remaining);
        if (sent < 0) {
            if (errno == EINTR || errno == EAGAIN) continue;
            return -1;
        }
        remaining -= sent;
    }
    return static_cast<ssize_t>(file_size);
}
```

### splice

More general than `sendfile`, moves data between any two file descriptors, at least one of which must be a pipe. Useful for proxying data between sockets.

```cpp
#include <fcntl.h>

// Zero-copy proxy: splice data from source socket to destination socket
// via a pipe intermediary
ssize_t splice_proxy(int src_fd, int dst_fd) {
    int pipefd[2];
    if (pipe(pipefd) < 0) return -1;

    // Move data from source socket into the pipe
    ssize_t n = splice(src_fd, nullptr, pipefd[1], nullptr,
                       65536, SPLICE_F_MOVE | SPLICE_F_NONBLOCK);
    if (n <= 0) {
        ::close(pipefd[0]);
        ::close(pipefd[1]);
        return n;
    }

    // Move data from pipe into destination socket
    ssize_t written = splice(pipefd[0], nullptr, dst_fd, nullptr,
                             n, SPLICE_F_MOVE | SPLICE_F_NONBLOCK);

    ::close(pipefd[0]);
    ::close(pipefd[1]);
    return written;
}
```

### MSG_ZEROCOPY

Since Linux 4.14, `send` with `MSG_ZEROCOPY` avoids copying socket send data. The kernel pins the userspace buffer and DMAs directly from it. The application receives completion notifications via the socket's error queue.

```cpp
#include <sys/socket.h>
#include <linux/errqueue.h>

void send_zerocopy(int sock_fd, const void* data, size_t len) {
    // Enable zero-copy on the socket
    int val = 1;
    setsockopt(sock_fd, SOL_SOCKET, SO_ZEROCOPY, &val, sizeof(val));

    // Send with zero-copy flag
    ssize_t ret = send(sock_fd, data, len, MSG_ZEROCOPY);
    if (ret < 0) return;

    // Wait for completion notification on error queue
    char cbuf[64];
    msghdr msg{};
    msg.msg_control = cbuf;
    msg.msg_controllen = sizeof(cbuf);

    if (recvmsg(sock_fd, &msg, MSG_ERRQUEUE) < 0) return;

    // Parse the notification
    for (cmsghdr* cm = CMSG_FIRSTHDR(&msg); cm; cm = CMSG_NXTHDR(&msg, cm)) {
        if (cm->cmsg_level == SOL_IP && cm->cmsg_type == IP_RECVERR) {
            auto* err = reinterpret_cast<sock_extended_err*>(CMSG_DATA(cm));
            if (err->ee_origin == SO_EE_ORIGIN_ZEROCOPY) {
                // Buffer is safe to reuse or free
            }
        }
    }
}
```

**When zero-copy helps:** Large transfers (10KB+) over high-bandwidth links. For small messages, the overhead of completion tracking exceeds the copy cost. Nginx and HAProxy use `sendfile`. High-performance proxies like Envoy use `splice`.

---
