## 8. Connection Pooling and Backpressure

### Connection Pool

Creating a TCP connection (handshake + optional TLS) is expensive. A connection pool maintains a set of open connections for reuse.

```cpp
#include <queue>
#include <mutex>
#include <condition_variable>
#include <chrono>

class ConnectionPool {
public:
    ConnectionPool(std::string host, uint16_t port,
                   size_t min_conns, size_t max_conns)
        : host_(std::move(host)), port_(port),
          max_conns_(max_conns) {
        // Pre-warm the pool
        for (size_t i = 0; i < min_conns; ++i) {
            pool_.push(create_connection());
            total_conns_++;
        }
    }

    // Acquire a connection from the pool (blocks if all in use)
    int acquire(std::chrono::milliseconds timeout = std::chrono::seconds(5)) {
        std::unique_lock lock(mutex_);

        if (!pool_.empty()) {
            int fd = pool_.front();
            pool_.pop();
            return fd;
        }

        // Can we create a new connection?
        if (total_conns_ < max_conns_) {
            total_conns_++;
            lock.unlock();
            return create_connection();
        }

        // Wait for a connection to be returned
        if (!cv_.wait_for(lock, timeout, [this] { return !pool_.empty(); })) {
            return -1;  // timeout - backpressure signal
        }

        int fd = pool_.front();
        pool_.pop();
        return fd;
    }

    // Return a connection to the pool
    void release(int fd) {
        if (!is_healthy(fd)) {
            close(fd);
            std::lock_guard lock(mutex_);
            total_conns_--;
            return;
        }

        std::lock_guard lock(mutex_);
        pool_.push(fd);
        cv_.notify_one();
    }

    ~ConnectionPool() {
        while (!pool_.empty()) {
            close(pool_.front());
            pool_.pop();
        }
    }

private:
    int create_connection() {
        int fd = socket(AF_INET, SOCK_STREAM, 0);
        sockaddr_in addr{};
        addr.sin_family = AF_INET;
        addr.sin_port = htons(port_);
        inet_pton(AF_INET, host_.c_str(), &addr.sin_addr);
        connect(fd, reinterpret_cast<sockaddr*>(&addr), sizeof(addr));
        return fd;
    }

    bool is_healthy(int fd) {
        char buf;
        // Peek - if recv returns 0, the peer closed the connection
        int n = recv(fd, &buf, 1, MSG_PEEK | MSG_DONTWAIT);
        return n != 0;  // -1 (EAGAIN) means alive with no data; 0 means closed
    }

    std::string host_;
    uint16_t port_;
    size_t max_conns_;
    size_t total_conns_ = 0;
    std::queue<int> pool_;
    std::mutex mutex_;
    std::condition_variable cv_;
};
```

### Backpressure

Backpressure is the mechanism by which a slow consumer signals a fast producer to slow down. Without it, unbounded queues grow until the process runs out of memory.

Strategies for backpressure in network systems:

1. **TCP flow control**: Stop reading from the socket. The receive buffer fills, the TCP window closes, and the sender blocks. This is automatic backpressure, free and correct, but coarse-grained.
2. **Application-level**: Return HTTP 429 (Too Many Requests) or gRPC RESOURCE_EXHAUSTED. The client implements retry with exponential backoff.
3. **Connection pool exhaustion**: When `acquire()` times out (as above), the caller knows the downstream is saturated and can fail fast, shed load, or queue the request locally.
4. **Bounded queues**: Internal producer-consumer queues with a fixed capacity. When full, the producer blocks or drops messages.

```cpp
// Bounded channel with backpressure
template <typename T>
class BoundedChannel {
public:
    explicit BoundedChannel(size_t capacity) : capacity_(capacity) {}

    // Blocks if the channel is full - this IS the backpressure
    void send(T value) {
        std::unique_lock lock(mutex_);
        not_full_.wait(lock, [this] { return queue_.size() < capacity_; });
        queue_.push(std::move(value));
        not_empty_.notify_one();
    }

    T receive() {
        std::unique_lock lock(mutex_);
        not_empty_.wait(lock, [this] { return !queue_.empty(); });
        T value = std::move(queue_.front());
        queue_.pop();
        not_full_.notify_one();
        return value;
    }

private:
    size_t capacity_;
    std::queue<T> queue_;
    std::mutex mutex_;
    std::condition_variable not_full_, not_empty_;
};
```

---
