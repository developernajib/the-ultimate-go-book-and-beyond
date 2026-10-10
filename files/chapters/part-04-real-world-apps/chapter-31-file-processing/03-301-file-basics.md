## 31.1 File Basics

### Reading Files

Reading a file efficiently requires choosing the right abstraction: `os.ReadFile` for small files that fit in memory, `bufio.Scanner` for line-oriented text, and a fixed-size buffer loop for binary data or streaming large files.

> **Senior track**: Code written before Go 1.16 used `ioutil.ReadFile` and `ioutil.WriteFile`. The `io/ioutil` package was deprecated in 1.16 and its helpers moved to `os` and `io`. Use `os.ReadFile`, `os.WriteFile`, `io.ReadAll`, and `os.MkdirTemp` in new code. In Go 1.27, `io/ioutil` remains present only as thin aliases for backward compatibility and should not appear in fresh code or reviews.

> **Senior track**: For pluggable file sources (embedded FS, zip archives, test fixtures, remote object stores) design APIs around `io/fs.FS` rather than concrete paths. A function that accepts `fs.FS` plus a path string works uniformly over `os.DirFS("/var/data")`, `embed.FS`, `zip.Reader` (which implements `fs.FS`), and test doubles from `fstest.MapFS`.

```go
package main

import (
    "bufio"
    "io"
    "os"
)

// Read entire file into memory
func readAll(path string) ([]byte, error) {
    return os.ReadFile(path)
}

// Read file with explicit open/close
func readFile(path string) ([]byte, error) {
    f, err := os.Open(path)
    if err != nil {
        return nil, err
    }
    defer f.Close()

    return io.ReadAll(f)
}

// Read file line by line
func readLines(path string) ([]string, error) {
    f, err := os.Open(path)
    if err != nil {
        return nil, err
    }
    defer f.Close()

    var lines []string
    scanner := bufio.NewScanner(f)
    for scanner.Scan() {
        lines = append(lines, scanner.Text())
    }

    return lines, scanner.Err()
}

// Read file in chunks
func readChunks(path string, chunkSize int) error {
    f, err := os.Open(path)
    if err != nil {
        return err
    }
    defer f.Close()

    buf := make([]byte, chunkSize)
    for {
        n, err := f.Read(buf)
        if err == io.EOF {
            break
        }
        if err != nil {
            return err
        }

        // Process buf[:n]
        processChunk(buf[:n])
    }

    return nil
}
```

### Writing Files

Writing should always go through `bufio.Writer` for small, frequent writes to avoid a syscall per write call. Flushing the buffer before closing the file is mandatory. The deferred `Close` does not flush a `bufio.Writer` automatically.

```go
package main

import (
    "bufio"
    "os"
)

// Write entire content
func writeAll(path string, data []byte) error {
    return os.WriteFile(path, data, 0644)
}

// Write with explicit file handle
func writeFile(path string, data []byte) error {
    f, err := os.Create(path)
    if err != nil {
        return err
    }
    defer f.Close()

    _, err = f.Write(data)
    if err != nil {
        return err
    }

    return f.Sync() // Ensure data is flushed to disk
}

// Buffered writing
func writeBuffered(path string, lines []string) error {
    f, err := os.Create(path)
    if err != nil {
        return err
    }
    defer f.Close()

    w := bufio.NewWriter(f)
    for _, line := range lines {
        if _, err := w.WriteString(line + "\n"); err != nil {
            return err
        }
    }

    return w.Flush()
}

// Append to file
func appendToFile(path string, data []byte) error {
    f, err := os.OpenFile(path, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0644)
    if err != nil {
        return err
    }
    defer f.Close()

    _, err = f.Write(data)
    return err
}
```

### File Information

The `os.Stat` function returns an `os.FileInfo` value containing the file's name, size, permissions, modification time, and whether it is a directory. Checking `os.IsNotExist(err)` distinguishes a missing file from other errors like permission denied. The `filepath` package provides portable path manipulation: `filepath.Ext` extracts the extension, and `filepath.Abs` resolves a relative path against the working directory.

```go
package main

import (
    "fmt"
    "os"
    "path/filepath"
)

func fileInfo(path string) error {
    info, err := os.Stat(path)
    if err != nil {
        if os.IsNotExist(err) {
            fmt.Println("File does not exist")
        }
        return err
    }

    fmt.Printf("Name: %s\n", info.Name())
    fmt.Printf("Size: %d bytes\n", info.Size())
    fmt.Printf("Mode: %s\n", info.Mode())
    fmt.Printf("ModTime: %s\n", info.ModTime())
    fmt.Printf("IsDir: %v\n", info.IsDir())

    return nil
}

// Check if file exists
func fileExists(path string) bool {
    _, err := os.Stat(path)
    return err == nil
}

// Get file extension
func getExtension(path string) string {
    return filepath.Ext(path)
}

// Get absolute path
func getAbsPath(path string) (string, error) {
    return filepath.Abs(path)
}
```

### Junior to FAANG: the bugs hiding in the basics

Every example above is correct, and every example has a corresponding bug pattern that appears in production code written by juniors. Walk through them once so you recognize them in review.

The `readChunks` function looks fine, but the `io.EOF` check is incomplete. `Read` is allowed to return a non zero `n` and `io.EOF` in the same call. The code above handles EOF before processing, which means the final chunk gets dropped if it arrives with EOF. The correct pattern processes `buf[:n]` first, then checks EOF. Use `io.ReadFull` or `bufio.Reader` unless you genuinely need this level of control.

The `readLines` function uses `bufio.Scanner` with the default 64 KB buffer. If any line exceeds 64 KB, Scanner returns an error that is easy to miss because `scanner.Err()` is only checked at the end. For production, always call `scanner.Buffer(make([]byte, 0, 64*1024), 16*1024*1024)` with an explicit max that matches your input assumptions, and log the line number when the error fires.

The `writeFile` function calls `f.Sync()` but does not sync the parent directory. On POSIX, a file's existence and metadata are only durable after the parent directory is fsynced. For a config file that must survive power loss, the pattern is write to temp, `f.Sync()`, `f.Close()`, open the parent directory with `os.Open`, `Sync()`, `Close()`. Skipping the directory sync is a common source of "the file is there but empty after crash" bugs.

The `appendToFile` function is not atomic across concurrent processes. Two writers with `O_APPEND` on Linux will not interleave within a single `write` syscall that fits in `PIPE_BUF` (4096 bytes), but larger writes can interleave. If you need multi writer append with atomicity, use `O_APPEND` with writes smaller than `PIPE_BUF`, or serialize through a single writer goroutine, or use a lock file with `flock`.

The `fileExists` function has a TOCTOU bug baked in. By the time you act on the result, the file may exist or not exist, created or deleted by another process. Never check then act. Instead, open with `O_CREATE|O_EXCL` if you want "create if not exists", or open without check and handle `os.IsNotExist` on the error. The same applies to `os.Stat` based permission checks. The only trustworthy permission check is actually attempting the operation.

Interview coding rounds at FAANG frequently ask you to implement `copyFile` or `atomicWrite` from scratch. If you do not include directory fsync and `O_EXCL` temp creation, you lose points regardless of whether the interviewer mentions them. They are checking whether you know the invariants unprompted.

### Senior @ FAANG: the syscall level model and why `fs.FS` is not enough

The Go standard library's file primitives are thin wrappers over POSIX syscalls, and at senior level you must reason in terms of those syscalls, not the Go API. This matters because the Go API hides behavior that matters under load.

Start with `os.Open`. It maps to `openat(AT_FDCWD, path, O_RDONLY|O_CLOEXEC, 0)`. The `O_CLOEXEC` flag is critical and Go sets it by default, which prevents the file descriptor from leaking into child processes spawned via `exec`. If you ever pass the `*os.File` to a subprocess, you must explicitly dup it without `O_CLOEXEC`, which is what `os/exec.Cmd.ExtraFiles` does. Junior code that forks and execs without understanding FD inheritance leaks descriptors into every child, exhausts the FD table, and hangs the process.

`os.Create` maps to `openat(AT_FDCWD, path, O_RDWR|O_CREATE|O_TRUNC, 0666)` and the resulting mode is further masked by the process `umask`, typically 0022, producing 0644. This means `os.Create("secret.key")` produces a world readable file. For secrets, always use `os.OpenFile(path, O_RDWR|O_CREATE|O_TRUNC, 0600)` and, on the paranoid path, verify the mode after creation with `f.Stat` in case `umask` was manipulated. The primary defense is always the explicit mode argument.

`os.ReadFile` is implemented as `stat` plus `read` into a sized buffer. The stat races with the read, and if the file grows between them, you get a truncated result. This is fine for config files that are rewritten atomically but wrong for log files that grow during read. For growing files, `io.ReadAll` on an `*os.File` grows the buffer as needed and avoids the race.

`f.Sync()` maps to `fsync(fd)`. This flushes dirty pages and the file's inode metadata. On ext4 with default mount options, fsync is expensive, typically 1 to 10 ms per call, because it waits for the journal commit. On XFS it is slightly cheaper. On ZFS and Btrfs it is coupled to transaction group commits and can be highly variable. For high write rate workloads, batching fsync across many writers via group commit is mandatory. This is what databases do internally and is why writing a database to a normal filesystem without group commit gives you 100x lower throughput than an engine that understands the filesystem's commit model.

`fdatasync(fd)` is a cheaper variant that flushes data without metadata if the size did not change. Go exposes it via `golang.org/x/sys/unix.Fdatasync`. For append heavy log workloads where you do not care about exact size durability, fdatasync can be 2x faster than fsync. This is what Kafka's log segments use.

`rename(old, new)` is atomic within a single filesystem on POSIX, meaning any observer sees either the old inode or the new inode but never a half state. It is not atomic across filesystems, where it degrades to copy plus unlink. The `renameat2(RENAME_EXCHANGE)` syscall is atomic swap of two paths and is the basis of copy on write config updates, but Go does not wrap it in the standard library, you call it via `unix.Renameat2`. For atomic config rotation with a rollback file, this is the correct primitive.

For the `fs.FS` abstraction, senior review should note its limits. `fs.FS` is read only by design. There is no `fs.WriteFS` in the standard library as of Go 1.27, and the proposals to add one have stalled because write semantics differ too much across backends (atomic rename on local disk, PUT on S3, conditional PUT on GCS). Do not build a "write capable FS abstraction" on top of `fs.FS` in new code, because the next reviewer will ask why you did not use `afero` or `billy`, both of which exist and have wider compatibility. Pick an abstraction with a real user base or stay on concrete types.

For mmap, `golang.org/x/exp/mmap` gives you a read only `ReaderAt` backed by `mmap(PROT_READ, MAP_SHARED)`. This is the right primitive for random access on files that fit in page cache. It is the wrong primitive for sequential scans larger than RAM, because the kernel readahead fights random access heuristics and you pay major faults on every page. The rule is mmap for index files, `bufio` for scan files. Do not mmap files you are writing to concurrently without explicit barriers, because the memory model for mmap writes visible to subsequent reads via the file API is weaker than Go's memory model and varies by kernel version.

---
