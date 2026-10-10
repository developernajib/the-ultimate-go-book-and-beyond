## 8. Inter-Process Communication

### Shared Memory (POSIX)

The fastest IPC mechanism, no kernel involvement after initial setup. Both processes access the same physical memory pages.

```cpp
#include <sys/mman.h>
#include <sys/stat.h>
#include <fcntl.h>
#include <unistd.h>
#include <cstring>
#include <atomic>

struct SharedState {
    std::atomic<uint64_t> counter;
    std::atomic<bool> ready;
    char data[4096];
};

// Producer process
void producer() {
    int fd = shm_open("/my_shm", O_CREAT | O_RDWR, 0666);
    ftruncate(fd, sizeof(SharedState));

    auto* state = static_cast<SharedState*>(
        mmap(nullptr, sizeof(SharedState), PROT_READ | PROT_WRITE,
             MAP_SHARED, fd, 0));
    ::close(fd);

    // Initialize
    new (state) SharedState{};

    // Write data
    std::strcpy(state->data, "Hello from producer");
    state->counter.store(1, std::memory_order_release);
    state->ready.store(true, std::memory_order_release);

    // Wait for consumer to acknowledge...
    while (state->counter.load(std::memory_order_acquire) < 2) {
        usleep(1000);
    }

    munmap(state, sizeof(SharedState));
    shm_unlink("/my_shm");
}

// Consumer process
void consumer() {
    int fd = shm_open("/my_shm", O_RDWR, 0666);
    auto* state = static_cast<SharedState*>(
        mmap(nullptr, sizeof(SharedState), PROT_READ | PROT_WRITE,
             MAP_SHARED, fd, 0));
    ::close(fd);

    // Wait for data
    while (!state->ready.load(std::memory_order_acquire)) {
        usleep(1000);
    }

    printf("Received: %s\n", state->data);
    state->counter.fetch_add(1, std::memory_order_acq_rel);

    munmap(state, sizeof(SharedState));
}
```

### POSIX Message Queues

Message queues provide structured, prioritized message passing between processes. Unlike pipes, they preserve message boundaries.

```cpp
#include <mqueue.h>
#include <cstring>
#include <stdexcept>

class MessageQueue {
    mqd_t mq_ = -1;
    std::string name_;

public:
    MessageQueue(const char* name, bool create, long max_msg = 10,
                 long msg_size = 4096)
        : name_(name)
    {
        struct mq_attr attr{};
        attr.mq_maxmsg = max_msg;
        attr.mq_msgsize = msg_size;

        int flags = O_RDWR;
        if (create) flags |= O_CREAT;

        mq_ = mq_open(name, flags, 0666, create ? &attr : nullptr);
        if (mq_ == (mqd_t)-1)
            throw std::runtime_error("mq_open failed");
    }

    ~MessageQueue() {
        if (mq_ != (mqd_t)-1) mq_close(mq_);
    }

    void send(const void* data, size_t len, unsigned priority = 0) {
        if (mq_send(mq_, static_cast<const char*>(data), len, priority) < 0)
            throw std::runtime_error("mq_send failed");
    }

    ssize_t receive(void* buf, size_t len, unsigned* priority = nullptr) {
        ssize_t n = mq_receive(mq_, static_cast<char*>(buf), len, priority);
        if (n < 0) throw std::runtime_error("mq_receive failed");
        return n;
    }

    void unlink() { mq_unlink(name_.c_str()); }
};
```

### Pipes

Pipes are the simplest IPC mechanism, a unidirectional byte stream. Named pipes (FIFOs) persist in the filesystem and work between unrelated processes.

```cpp
#include <unistd.h>
#include <sys/wait.h>
#include <iostream>

void pipe_example() {
    int pipefd[2];
    if (pipe(pipefd) < 0) return;

    pid_t pid = fork();
    if (pid == 0) {
        // Child: write to pipe
        ::close(pipefd[0]);  // Close read end
        const char* msg = "Hello from child";
        ::write(pipefd[1], msg, strlen(msg));
        ::close(pipefd[1]);
        _exit(0);
    } else {
        // Parent: read from pipe
        ::close(pipefd[1]);  // Close write end
        char buf[256];
        ssize_t n = ::read(pipefd[0], buf, sizeof(buf) - 1);
        if (n > 0) {
            buf[n] = '\0';
            std::cout << "Parent received: " << buf << "\n";
        }
        ::close(pipefd[0]);
        waitpid(pid, nullptr, 0);
    }
}
```

**IPC selection guide:**

| Mechanism | Latency | Throughput | Structured | Cross-Machine |
|-----------|---------|------------|------------|----------------|
| Shared Memory | Lowest | Highest | No | No |
| Unix Socket | Low | High | No (stream) | No |
| Message Queue | Low | Medium | Yes | No |
| Pipe | Low | Medium | No | No |
| TCP Socket | Medium | High | No | Yes |

---
