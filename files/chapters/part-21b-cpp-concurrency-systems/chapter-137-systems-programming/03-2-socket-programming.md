## 2. Socket Programming

### TCP Sockets

TCP provides reliable, ordered, connection-oriented byte streams. The server lifecycle is: `socket` -> `bind` -> `listen` -> `accept` -> `read`/`write` -> `close`.

```cpp
#include <sys/socket.h>
#include <netinet/in.h>
#include <arpa/inet.h>
#include <unistd.h>
#include <cstring>
#include <string>
#include <stdexcept>
#include <iostream>

class TcpServer {
    int listen_fd_ = -1;

public:
    explicit TcpServer(uint16_t port, int backlog = 128) {
        listen_fd_ = ::socket(AF_INET, SOCK_STREAM, 0);
        if (listen_fd_ < 0)
            throw std::runtime_error("socket failed");

        // Allow address reuse to avoid TIME_WAIT issues
        int opt = 1;
        setsockopt(listen_fd_, SOL_SOCKET, SO_REUSEADDR, &opt, sizeof(opt));

        sockaddr_in addr{};
        addr.sin_family = AF_INET;
        addr.sin_addr.s_addr = INADDR_ANY;
        addr.sin_port = htons(port);

        if (::bind(listen_fd_, reinterpret_cast<sockaddr*>(&addr),
                   sizeof(addr)) < 0)
            throw std::runtime_error("bind failed");

        if (::listen(listen_fd_, backlog) < 0)
            throw std::runtime_error("listen failed");
    }

    ~TcpServer() {
        if (listen_fd_ >= 0) ::close(listen_fd_);
    }

    // Accept a connection, return client fd and peer address
    int accept_client(std::string& peer_addr) {
        sockaddr_in client{};
        socklen_t len = sizeof(client);
        int client_fd = ::accept(listen_fd_,
                                  reinterpret_cast<sockaddr*>(&client), &len);
        if (client_fd < 0)
            throw std::runtime_error("accept failed");

        char buf[INET_ADDRSTRLEN];
        inet_ntop(AF_INET, &client.sin_addr, buf, sizeof(buf));
        peer_addr = std::string(buf) + ":" +
                    std::to_string(ntohs(client.sin_port));
        return client_fd;
    }

    int fd() const { return listen_fd_; }
};

// Simple echo server
void run_echo_server(uint16_t port) {
    TcpServer server(port);
    std::cout << "Listening on port " << port << "\n";

    while (true) {
        std::string peer;
        int client = server.accept_client(peer);
        std::cout << "Connection from " << peer << "\n";

        char buf[4096];
        ssize_t n;
        while ((n = ::read(client, buf, sizeof(buf))) > 0) {
            ::write(client, buf, n);  // Echo back
        }
        ::close(client);
    }
}
```

### UDP Sockets

UDP is connectionless and unreliable, each `sendto`/`recvfrom` is an independent datagram. No handshake, no ordering, no retransmission.

```cpp
class UdpSocket {
    int fd_ = -1;

public:
    explicit UdpSocket(uint16_t port = 0) {
        fd_ = ::socket(AF_INET, SOCK_DGRAM, 0);
        if (fd_ < 0) throw std::runtime_error("socket failed");

        if (port > 0) {
            sockaddr_in addr{};
            addr.sin_family = AF_INET;
            addr.sin_addr.s_addr = INADDR_ANY;
            addr.sin_port = htons(port);
            if (::bind(fd_, reinterpret_cast<sockaddr*>(&addr),
                       sizeof(addr)) < 0)
                throw std::runtime_error("bind failed");
        }
    }

    ~UdpSocket() { if (fd_ >= 0) ::close(fd_); }

    ssize_t send_to(const void* data, size_t len,
                    const char* host, uint16_t port) {
        sockaddr_in dest{};
        dest.sin_family = AF_INET;
        dest.sin_port = htons(port);
        inet_pton(AF_INET, host, &dest.sin_addr);
        return ::sendto(fd_, data, len, 0,
                        reinterpret_cast<sockaddr*>(&dest), sizeof(dest));
    }

    ssize_t recv_from(void* buf, size_t len,
                      sockaddr_in& sender) {
        socklen_t slen = sizeof(sender);
        return ::recvfrom(fd_, buf, len, 0,
                          reinterpret_cast<sockaddr*>(&sender), &slen);
    }

    int fd() const { return fd_; }
};
```

### Unix Domain Sockets

Unix domain sockets provide IPC on the same machine with lower overhead than TCP loopback. They use filesystem paths instead of IP addresses and support both stream and datagram modes. They also support passing file descriptors between processes via `SCM_RIGHTS`.

```cpp
#include <sys/un.h>

int create_unix_stream_server(const char* path) {
    int fd = ::socket(AF_UNIX, SOCK_STREAM, 0);
    if (fd < 0) return -1;

    ::unlink(path);  // Remove stale socket file

    sockaddr_un addr{};
    addr.sun_family = AF_UNIX;
    std::strncpy(addr.sun_path, path, sizeof(addr.sun_path) - 1);

    if (::bind(fd, reinterpret_cast<sockaddr*>(&addr), sizeof(addr)) < 0) {
        ::close(fd);
        return -1;
    }

    ::listen(fd, 128);
    return fd;
}
```

**Go comparison:** Go's `net` package wraps all three socket types behind `net.Listener`, `net.Conn`, and `net.PacketConn` interfaces. internally, the Go runtime registers every socket with epoll and multiplexes goroutines across OS threads. You get concurrency without explicit I/O multiplexing, but the mechanisms described in the next section are exactly what Go uses internally.

---
