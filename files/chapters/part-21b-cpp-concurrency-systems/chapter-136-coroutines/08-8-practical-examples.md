## 8. Practical Examples

### Async File Reader

An async file reader that integrates with an event loop, reading chunks without blocking the thread:

```cpp
#include <coroutine>
#include <fstream>
#include <string>
#include <vector>
#include <iostream>

// Awaitable that reads a file chunk on a background thread
struct AsyncReadAwaitable {
    std::string filename;
    size_t offset;
    size_t chunk_size;
    std::vector<char> buffer;

    bool await_ready() { return false; }

    void await_suspend(std::coroutine_handle<> handle) {
        // In production, submit to an I/O thread pool
        std::thread([this, handle]() {
            std::ifstream file(filename, std::ios::binary);
            file.seekg(static_cast<std::streamoff>(offset));
            buffer.resize(chunk_size);
            file.read(buffer.data(), 
                      static_cast<std::streamsize>(chunk_size));
            auto bytes_read = file.gcount();
            buffer.resize(static_cast<size_t>(bytes_read));
            handle.resume();  // Resume coroutine on this thread
        }).detach();
    }

    std::vector<char> await_resume() {
        return std::move(buffer);
    }
};

AsyncTask<std::string> read_file_async(const std::string& filename) {
    std::string contents;
    size_t offset = 0;
    constexpr size_t chunk_size = 4096;

    while (true) {
        auto chunk = co_await AsyncReadAwaitable{
            filename, offset, chunk_size, {}
        };

        if (chunk.empty()) break;

        contents.append(chunk.data(), chunk.size());
        offset += chunk.size();
    }

    co_return contents;
}

// Usage:
AsyncTask<void> process_files() {
    auto config = co_await read_file_async("config.json");
    auto data = co_await read_file_async("data.csv");
    std::cout << "Config size: " << config.size() 
              << ", Data size: " << data.size() << "\n";
}
```

### Task Scheduler with Priorities

A priority-based coroutine scheduler that processes high-priority tasks first:

```cpp
#include <coroutine>
#include <queue>
#include <functional>
#include <iostream>

enum class Priority { High = 0, Normal = 1, Low = 2 };

class PriorityScheduler {
public:
    struct ScheduledTask {
        Priority priority;
        std::coroutine_handle<> handle;

        bool operator>(const ScheduledTask& other) const {
            return static_cast<int>(priority) > 
                   static_cast<int>(other.priority);
        }
    };

    auto schedule(Priority p = Priority::Normal) {
        struct Awaiter {
            PriorityScheduler& sched;
            Priority priority;

            bool await_ready() const noexcept { return false; }
            void await_suspend(std::coroutine_handle<> h) {
                sched.enqueue(h, priority);
            }
            void await_resume() const noexcept {}
        };
        return Awaiter{*this, p};
    }

    void enqueue(std::coroutine_handle<> handle, Priority p) {
        tasks_.push(ScheduledTask{p, handle});
    }

    void run() {
        while (!tasks_.empty()) {
            auto task = tasks_.top();
            tasks_.pop();
            task.handle.resume();
        }
    }

private:
    std::priority_queue<
        ScheduledTask,
        std::vector<ScheduledTask>,
        std::greater<ScheduledTask>
    > tasks_;
};

PriorityScheduler scheduler;

Task log_message(const std::string& msg, Priority p) {
    co_await scheduler.schedule(p);
    std::cout << "[" << static_cast<int>(p) << "] " << msg << "\n";
    co_await scheduler.schedule(p);
    std::cout << "[" << static_cast<int>(p) << "] " << msg << " (done)\n";
}

int main() {
    // Create tasks - all suspended at first co_await
    auto t1 = log_message("Low priority work", Priority::Low);
    auto t2 = log_message("Critical alert", Priority::High);
    auto t3 = log_message("Normal processing", Priority::Normal);

    scheduler.run();
    // Output order:
    // [0] Critical alert
    // [1] Normal processing
    // [2] Low priority work
    // [0] Critical alert (done)
    // [1] Normal processing (done)
    // [2] Low priority work (done)
}
```

### Producer-Consumer with Async Channel

A channel-like abstraction built on coroutines, similar in spirit to Go channels:

```cpp
#include <coroutine>
#include <queue>
#include <optional>
#include <mutex>
#include <iostream>

template <typename T>
class Channel {
public:
    explicit Channel(size_t capacity = 0) : capacity_(capacity) {}

    // Awaitable for sending a value
    auto send(T value) {
        struct SendAwaiter {
            Channel& ch;
            T value;

            bool await_ready() {
                std::lock_guard lock(ch.mutex_);
                if (ch.buffer_.size() < ch.capacity_ || !ch.receivers_.empty()) {
                    return true;  // Can send immediately
                }
                return false;
            }

            void await_suspend(std::coroutine_handle<> handle) {
                std::lock_guard lock(ch.mutex_);
                if (!ch.receivers_.empty()) {
                    // Receiver waiting - hand off directly
                    auto receiver = ch.receivers_.front();
                    ch.receivers_.pop();
                    ch.last_received_ = std::move(value);
                    receiver.resume();
                    handle.resume();
                } else {
                    ch.senders_.push({handle, std::move(value)});
                }
            }

            void await_resume() {}
        };
        return SendAwaiter{*this, std::move(value)};
    }

    // Awaitable for receiving a value
    auto receive() {
        struct ReceiveAwaiter {
            Channel& ch;

            bool await_ready() {
                std::lock_guard lock(ch.mutex_);
                return !ch.buffer_.empty() || !ch.senders_.empty() || ch.closed_;
            }

            void await_suspend(std::coroutine_handle<> handle) {
                std::lock_guard lock(ch.mutex_);
                ch.receivers_.push(handle);
            }

            std::optional<T> await_resume() {
                std::lock_guard lock(ch.mutex_);
                if (!ch.buffer_.empty()) {
                    T val = std::move(ch.buffer_.front());
                    ch.buffer_.pop();
                    return val;
                }
                if (!ch.senders_.empty()) {
                    auto [sender_handle, val] = std::move(ch.senders_.front());
                    ch.senders_.pop();
                    sender_handle.resume();
                    return val;
                }
                if (ch.last_received_.has_value()) {
                    return std::exchange(ch.last_received_, std::nullopt);
                }
                return std::nullopt;  // Channel closed
            }
        };
        return ReceiveAwaiter{*this};
    }

    void close() {
        std::lock_guard lock(mutex_);
        closed_ = true;
        while (!receivers_.empty()) {
            receivers_.front().resume();
            receivers_.pop();
        }
    }

private:
    struct PendingSend {
        std::coroutine_handle<> handle;
        T value;
    };

    size_t capacity_;
    bool closed_ = false;
    std::queue<T> buffer_;
    std::queue<PendingSend> senders_;
    std::queue<std::coroutine_handle<>> receivers_;
    std::optional<T> last_received_;
    std::mutex mutex_;
};

// Producer-consumer using the channel
Task producer(Channel<int>& ch) {
    for (int i = 0; i < 5; ++i) {
        co_await ch.send(i);
        std::cout << "Sent: " << i << "\n";
    }
    ch.close();
}

Task consumer(Channel<int>& ch) {
    while (true) {
        auto val = co_await ch.receive();
        if (!val.has_value()) break;
        std::cout << "Received: " << val.value() << "\n";
    }
}
```

---
