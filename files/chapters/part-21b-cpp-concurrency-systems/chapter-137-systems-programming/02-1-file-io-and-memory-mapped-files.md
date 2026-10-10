## 1. File I/O and Memory-Mapped Files

### POSIX File I/O

The foundation of all file operations on Unix-like systems is the file descriptor, a small integer that references a kernel object. The basic operations are `open`, `read`, `write`, `lseek`, and `close`.

```cpp
#include <fcntl.h>
#include <unistd.h>
#include <sys/stat.h>
#include <cerrno>
#include <cstring>
#include <stdexcept>
#include <string>

class FileDescriptor {
    int fd_ = -1;

public:
    explicit FileDescriptor(const char* path, int flags, mode_t mode = 0644) {
        fd_ = ::open(path, flags, mode);
        if (fd_ < 0) {
            throw std::runtime_error(
                std::string("open failed: ") + std::strerror(errno));
        }
    }

    ~FileDescriptor() {
        if (fd_ >= 0) ::close(fd_);
    }

    // Non-copyable, movable
    FileDescriptor(const FileDescriptor&) = delete;
    FileDescriptor& operator=(const FileDescriptor&) = delete;
    FileDescriptor(FileDescriptor&& other) noexcept : fd_(other.fd_) {
        other.fd_ = -1;
    }
    FileDescriptor& operator=(FileDescriptor&& other) noexcept {
        if (this != &other) {
            if (fd_ >= 0) ::close(fd_);
            fd_ = other.fd_;
            other.fd_ = -1;
        }
        return *this;
    }

    int get() const { return fd_; }

    // Read exactly n bytes, handling partial reads
    size_t read_all(void* buf, size_t n) {
        size_t total = 0;
        auto* p = static_cast<char*>(buf);
        while (total < n) {
            ssize_t r = ::read(fd_, p + total, n - total);
            if (r < 0) {
                if (errno == EINTR) continue;  // Interrupted by signal
                throw std::runtime_error(
                    std::string("read failed: ") + std::strerror(errno));
            }
            if (r == 0) break;  // EOF
            total += static_cast<size_t>(r);
        }
        return total;
    }

    // Write exactly n bytes, handling partial writes
    void write_all(const void* buf, size_t n) {
        size_t total = 0;
        const auto* p = static_cast<const char*>(buf);
        while (total < n) {
            ssize_t w = ::write(fd_, p + total, n - total);
            if (w < 0) {
                if (errno == EINTR) continue;
                throw std::runtime_error(
                    std::string("write failed: ") + std::strerror(errno));
            }
            total += static_cast<size_t>(w);
        }
    }
};
```

**Key points:** Always handle `EINTR` (signal interruption) and partial reads/writes. The kernel may return fewer bytes than requested for perfectly normal reasons, pipe buffers, socket windows, signal delivery. Wrapping the file descriptor in an RAII class prevents leaks.

### Memory-Mapped Files (mmap)

Memory mapping projects a file directly into the process's virtual address space. Reads and writes become ordinary memory accesses, the kernel handles page faults and writeback transparently. This eliminates `read`/`write` system call overhead and lets the kernel's page cache work optimally.

```cpp
#include <sys/mman.h>
#include <sys/stat.h>
#include <fcntl.h>
#include <unistd.h>
#include <cstring>
#include <stdexcept>
#include <string_view>

class MappedFile {
    void* addr_ = MAP_FAILED;
    size_t size_ = 0;

public:
    explicit MappedFile(const char* path, bool writable = false) {
        int flags = writable ? O_RDWR : O_RDONLY;
        int fd = ::open(path, flags);
        if (fd < 0)
            throw std::runtime_error(
                std::string("open: ") + std::strerror(errno));

        struct stat st{};
        if (fstat(fd, &st) < 0) {
            ::close(fd);
            throw std::runtime_error("fstat failed");
        }
        size_ = static_cast<size_t>(st.st_size);

        int prot = PROT_READ | (writable ? PROT_WRITE : 0);
        addr_ = ::mmap(nullptr, size_, prot, MAP_SHARED, fd, 0);
        ::close(fd);  // fd can be closed after mmap

        if (addr_ == MAP_FAILED)
            throw std::runtime_error(
                std::string("mmap: ") + std::strerror(errno));
    }

    ~MappedFile() {
        if (addr_ != MAP_FAILED) ::munmap(addr_, size_);
    }

    MappedFile(const MappedFile&) = delete;
    MappedFile& operator=(const MappedFile&) = delete;

    // Advise the kernel on access pattern
    void advise_sequential() {
        ::madvise(addr_, size_, MADV_SEQUENTIAL);
    }

    void advise_random() {
        ::madvise(addr_, size_, MADV_RANDOM);
    }

    std::string_view view() const {
        return {static_cast<const char*>(addr_), size_};
    }

    void* data() { return addr_; }
    const void* data() const { return addr_; }
    size_t size() const { return size_; }
};

// Usage: count newlines in a file without buffering
size_t count_lines(const char* path) {
    MappedFile file(path);
    file.advise_sequential();
    auto content = file.view();
    size_t count = 0;
    for (char c : content) {
        if (c == '\n') ++count;
    }
    return count;
}
```

**When to use mmap:** Large files read sequentially or with random access patterns, shared memory between processes, and databases that need direct page management. **When to avoid it:** Small files (mmap overhead exceeds read), files that grow dynamically, or when you need precise control over I/O timing (mmap writes are asynchronous by default, use `msync` to force).

**Go comparison:** Go's `syscall.Mmap` exposes the same primitive, but idiomatic Go uses `os.ReadFile` or `bufio.Scanner` for most file operations. The Go runtime's scheduler and garbage collector add complexity to mmap usage that C++ avoids.

---
