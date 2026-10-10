## 31.7 Directory Operations

### Walking Directories

`filepath.Walk` recursively visits every file and directory under a root, calling a visitor function for each entry. The visitor receives the full path, an `os.FileInfo`, and any error encountered opening the directory. For Go 1.16+, `filepath.WalkDir` is preferred because it passes an `os.DirEntry` that avoids a `Stat` syscall per entry, significant when traversing directories with millions of files.

```go
package main

import (
    "fmt"
    "os"
    "path/filepath"
)

// Walk directory tree
func walkDir(root string, process func(path string, info os.FileInfo) error) error {
    return filepath.Walk(root, func(path string, info os.FileInfo, err error) error {
        if err != nil {
            return err
        }
        return process(path, info)
    })
}

// Find files by pattern
func findFiles(root, pattern string) ([]string, error) {
    var matches []string

    err := filepath.Walk(root, func(path string, info os.FileInfo, err error) error {
        if err != nil {
            return err
        }
        if info.IsDir() {
            return nil
        }

        matched, err := filepath.Match(pattern, info.Name())
        if err != nil {
            return err
        }
        if matched {
            matches = append(matches, path)
        }

        return nil
    })

    return matches, err
}

// Calculate directory size
func dirSize(path string) (int64, error) {
    var size int64

    err := filepath.Walk(path, func(_ string, info os.FileInfo, err error) error {
        if err != nil {
            return err
        }
        if !info.IsDir() {
            size += info.Size()
        }
        return nil
    })

    return size, err
}

// Use WalkDir for better performance (Go 1.16+)
func walkDirNew(root string) error {
    return filepath.WalkDir(root, func(path string, d os.DirEntry, err error) error {
        if err != nil {
            return err
        }

        // DirEntry is more efficient than FileInfo
        if d.IsDir() {
            return nil
        }

        // Only call Stat if needed
        info, err := d.Info()
        if err != nil {
            return err
        }

        fmt.Printf("%s: %d bytes\n", path, info.Size())
        return nil
    })
}
```

### Directory Manipulation

Directory traversal uses `os.ReadDir` rather than the deprecated `ioutil.ReadDir`, returning `[]os.DirEntry` which provides `Name()`, `IsDir()`, and `Type()` without calling `Stat()` on every entry, saving one syscall per file on most filesystems. Recursive traversal is implemented with `filepath.WalkDir`, which passes an `fs.WalkDirFunc` receiving the path, a `DirEntry`, and any error encountered opening the directory. Returning `filepath.SkipDir` skips the subtree without aborting the walk. Symlinks are not followed by default in `WalkDir`. Following them requires explicit `os.Readlink` calls with cycle detection to avoid infinite loops.

```go
package main

import (
    "io"
    "os"
    "path/filepath"
    "time"
)

// Copy directory recursively
func copyDir(src, dst string) error {
    return filepath.Walk(src, func(path string, info os.FileInfo, err error) error {
        if err != nil {
            return err
        }

        relPath, err := filepath.Rel(src, path)
        if err != nil {
            return err
        }
        dstPath := filepath.Join(dst, relPath)

        if info.IsDir() {
            return os.MkdirAll(dstPath, info.Mode())
        }

        return copyFile(path, dstPath)
    })
}

func copyFile(src, dst string) error {
    srcFile, err := os.Open(src)
    if err != nil {
        return err
    }
    defer srcFile.Close()

    dstFile, err := os.Create(dst)
    if err != nil {
        return err
    }
    defer dstFile.Close()

    _, err = io.Copy(dstFile, srcFile)
    return err
}

// Clean old files
func cleanOldFiles(dir string, maxAge time.Duration) error {
    cutoff := time.Now().Add(-maxAge)

    return filepath.Walk(dir, func(path string, info os.FileInfo, err error) error {
        if err != nil {
            return err
        }
        if info.IsDir() {
            return nil
        }

        if info.ModTime().Before(cutoff) {
            return os.Remove(path)
        }

        return nil
    })
}
```

### Junior → FAANG: Prerequisites and Interview Framing

Directory walking looks trivial until you hit the first directory with a million files. The mental model you need is that every `Stat` call is a syscall, every syscall is a context switch, and on a network filesystem every syscall is a round trip to a server. A naive `filepath.Walk` on a directory with one million files does one million `stat` calls on top of the `readdir` calls, which on NFS can take minutes for work that should take seconds. Switching to `filepath.WalkDir` (Go 1.16+) cuts this in half because `DirEntry.IsDir()` and `DirEntry.Type()` come from the directory entry itself without an additional `stat`. This single change is the most common perf fix for "my script is slow on the production server."

The other prerequisite is understanding what a directory actually is. On Linux, a directory is a file whose contents are `(inode, name)` pairs. `readdir` returns these pairs in filesystem order, which is not alphabetical. If you need sorted output, you sort client-side. Hidden files (names starting with `.`) are not hidden at the syscall level, they are hidden by convention in `ls`. `os.ReadDir` returns them all. Symlinks show up as entries whose `Type()` returns `ModeSymlink`, and by default `WalkDir` does not follow them, which is the right default because following them can create infinite loops.

A worked example for junior context. Your task is "find all `.log` files older than seven days under `/var/log/myapp` and delete them." The naive solution uses `filepath.Walk` and deletes in the visitor. Problems: it follows zero symlinks (fine) but also deletes files that were rotated mid-walk (race), and a permission error on one subdirectory aborts the whole walk. The production version uses `WalkDir`, checks `d.Type().IsRegular()` before deletion, catches per-entry errors and returns `nil` to continue, and uses `os.Remove` rather than `os.RemoveAll` so you never accidentally recurse into a directory you did not mean to touch. That is the shape of the interview answer.

Interview framing for directory operations usually hides a systems question. "Find duplicates in a large directory" tests whether you know to hash by content only after filtering by size (cheap, no I/O beyond stat). "Implement parallel copy" tests whether you understand that directory creation must happen serially in order but file copies can fan out. "Walk a huge tree without OOM" tests whether you know that `filepath.Walk`'s visitor model is already streaming and you do not need to buffer paths. Candidates who propose "load all paths into a slice first" fail the signal.

### Senior @ FAANG: Parallel Walks, Syscall Budgets, and Directory Operations at Scale

At senior level, directory walks become a distributed-systems problem even on a single machine. The constraints are syscall throughput (limited by the VFS layer, maybe 100k to 500k syscalls per second per core), filesystem-specific parallelism (XFS and ext4 scale well with parallel readers, NFS does not), and memory pressure from buffering directory entries. The job is to pick a walk strategy that matches both the workload and the filesystem.

The single-threaded `filepath.WalkDir` baseline tops out around 100 MB/s of directory scan on local SSD with warm cache. For large monorepos, container image filesystems, and backup scanners this is not enough. The canonical upgrade in Go is `github.com/karrick/godirwalk` (fast single-threaded with direct `getdents64` syscalls) or `github.com/charlievieth/fastwalk` (parallel walk used by ripgrep-style tools). fastwalk's model is a worker pool where each goroutine pulls a directory off a shared queue, reads its entries, and pushes subdirectories back onto the queue. The tricky part is ordering: parallel walks produce nondeterministic output order, which is fine for `find`-style tools and wrong for `diff`-style tools. Know which one you are building.

On Linux, the direct-syscall path uses `SYS_GETDENTS64` with a large buffer (typically 64 KB or 128 KB). Each syscall returns as many `dirent64` records as fit, which amortizes the syscall cost across many entries. The Go stdlib already does this internally in `os.ReadDir`. The win from godirwalk is that it avoids the per-entry `Info()` call overhead when you only need names and types. For monorepo tools like Bazel or Buck2, this translates directly into faster `bazel build //...` invocations.

Inode-based deduplication is the senior move for directory diffs and backup scanners. On POSIX filesystems, a hardlink means two directory entries point to the same inode. A naive backup that copies by path duplicates the data. The right approach is to keep a `map[uint64]string` keyed by `(dev, ino)` from `syscall.Stat_t`, first occurrence becomes the canonical copy, subsequent occurrences become hardlinks in the destination via `os.Link`. This is how `rsync --hard-links` and `cp -a` work. On Windows, `syscall.GetFileInformationByHandle` gives you the equivalent `(volume serial, file index)` pair.

Ordering and atomicity guarantees are weaker than most engineers assume. `readdir` can return the same entry twice if the directory is modified during iteration, can skip entries that exist both before and after, and can return entries in arbitrary order. The POSIX standard only guarantees that entries which exist throughout the walk and are not modified will be returned exactly once. For directories under active write load, a walk is a fuzzy snapshot. Build code that tolerates this: idempotent deletions, content-addressed operations, and explicit retry on "file disappeared during walk."

On network filesystems, the syscall budget collapses. NFS v3 readdir is one RPC per batch of entries (controlled by `rsize`), and every `stat` is a separate GETATTR RPC. Walking a million-file NFS directory can take an hour. Mitigations: use `readdirplus` if the server supports it (returns attributes with names, cutting RPCs in half), use FUSE pass-through caching, or do the walk server-side via SSH and stream results. On object stores like S3, there are no directories at all, only keys with common prefixes. `ListObjectsV2` paginates at 1000 keys per response, and the parallel walk strategy is to partition the key space and run concurrent paginators per prefix. This is why tools like `s5cmd` beat `aws s3 sync` by an order of magnitude.

Memory-mapped directory caches are the last trick for truly massive trees. For repeated walks (build systems, search indexers), persist the last walk's results to a mmap'd file indexed by inode, invalidate on `ctime` change, and skip subtrees whose root inode has not changed. Watchman (used by Meta, React Native, and Mercurial) does this combined with inotify to provide near-instant "what changed" queries on trees with tens of millions of files. Building something similar in Go is a legitimate staff-level project that pays for itself in CI time savings.

TOCTOU (time-of-check-time-of-use) bugs are the security class to know. The pattern `if info, _ := os.Stat(path); !info.IsDir() { os.Remove(path) }` is racy because an attacker can replace `path` with a symlink between `Stat` and `Remove`. The fix is to use `openat` with `O_NOFOLLOW` and operate on the file descriptor, or use Linux's `O_PATH` plus `fstatat` family. Go 1.24+ added `os.Root` and `(*Root).OpenRoot`, `(*Root).Open`, `(*Root).Remove`, which provide `openat`-style operations that are rooted in a directory handle and refuse to escape it. Any new directory-walking code that touches attacker-influenced paths should use `os.Root` rather than `filepath.Join` plus `os.Open`. This is the Go-native defense against directory traversal.

Error handling in `WalkDir` is subtle. Returning `nil` from the visitor continues the walk. Returning `filepath.SkipDir` skips the rest of the current directory. Returning `filepath.SkipAll` (Go 1.20+) terminates the walk early without error. Returning any other error terminates and propagates. The common mistake is returning the per-entry error from the visitor, which aborts the whole walk on the first permission-denied file. The correct pattern is to log and swallow expected errors (permission, not-found) and propagate unexpected ones (I/O, corruption).

Benchmarking directory walks requires cold-cache and warm-cache measurement. `echo 3 > /proc/sys/vm/drop_caches` on Linux clears the page cache and dentry cache between runs. Without this, your second run is reading from RAM and tells you nothing about production. For S3-backed or NFS-backed walks, the real test is against a fresh bucket or a cleared NFS client cache. Publish both numbers in any internal perf analysis, because the cold path is what your users hit after a deploy.

---
