## Filesystem and Inode Mechanics

> **Senior @ FAANG**: "Did you `fsync` the directory?" is the question that separates engineers who lose data from engineers who do not. Durability is not a checkbox, it is a chain of fsyncs across the file, the directory, and (sometimes) the parent directory.

### 1. The VFS Layer

Every Linux filesystem hangs off the **Virtual Filesystem Switch**. A path lookup goes:

```
path → namei() → walk dentry cache → inode → super_block → fs ops
```

Three caches dominate performance:

| Cache | What it caches | Eviction |
|-------|---------------|----------|
| Page cache | File data, 4 KB pages | LRU + writeback |
| Inode cache | `struct inode` | Slab, pinned by open fds |
| Dentry cache | Path-name → inode bindings | LRU, explicit `drop_caches=2` |

`stat()` and `open()` are dentry-cache lookups when warm (~100 ns), full disk reads when cold (~10 ms). `find /` on a cold tree of 50 M files is dentry-cache cost, same `find` second run is purely CPU.

Drop caches for benchmark sanity (never on production):

```bash
echo 3 > /proc/sys/vm/drop_caches  # 1=page, 2=dentry+inode, 3=both
```

### 2. Inodes. The Real File Identity

A *path* is just a label. The *file* is its inode (per device). Consequences:

- **Hard links** share an inode, deleting any one decrements `nlink`. The file lives until `nlink==0` AND no open fd refers to it.
- **`unlink()` while open** is the canonical "tmpfile" pattern, disk space reclaimed at close.
- **`stat`/`fstatat`** return `st_ino` and `st_dev`, the pair `(dev,ino)` is the unique key.
- **`O_TMPFILE`** creates an unnamed inode you can later `linkat()` to materialize:

```cpp
int fd = openat(AT_FDCWD, "/var/lib/app", O_TMPFILE|O_RDWR|O_CLOEXEC, 0600);
write(fd, payload, n);
fsync(fd);
linkat(AT_FDCWD, ("/proc/self/fd/" + std::to_string(fd)).c_str(),
       AT_FDCWD, "/var/lib/app/data.bin", AT_SYMLINK_FOLLOW);
```

This is **the** durable atomic-write pattern when you do not need to overwrite an existing path. For overwrite, see §6.

### 3. ext4 vs xfs vs btrfs. One-Paragraph Each

**ext4**, journaling (`data=ordered` default: data before metadata commit), extent-based allocation, `delayed_allocation` (writes accumulate in page cache until pressure or sync). Robust, predictable, no COW. `lazy_itable_init` makes `mkfs` fast at the cost of background initialization.

**xfs**, log-structured metadata, B+tree allocation groups, delay-allocate, **no `data=` mode** (always orders data via the log). Better at parallel metadata workloads (multiple AGs). Reflinks (`xfs_io -c "reflink"`) since 5.x give COW snapshots without a full COW filesystem. Default for RHEL 8+, AWS Graviton workloads.

**btrfs**, full COW, snapshots, subvolumes, RAID. Every overwrite allocates a new block. Inherently variable latency under heavy write load (free-space-cache rebuild). Production use at FAANG: niche. SUSE and Meta use it heavily, Google does not.

**zfs** (Linux via OpenZFS), full COW + checksumming + ARC + L2ARC + ZIL. Different semantics, `fsync` is acknowledged after the ZIL flush. Memory-hungry.

### 4. `fsync` vs `fdatasync` vs Barriers

| Call | Flushes data | Flushes inode metadata | Flushes directory entry |
|------|:------------:|:----------------------:|:-----------------------:|
| `write()` | no, page cache only | no | no |
| `fsync(fd)` | yes | yes | **no** |
| `fdatasync(fd)` | yes | only if size changed | no |
| `sync_file_range(fd, off, len, FLAGS)` | partial | no | no |
| `syncfs(fd)` | all data on the fs | yes | yes |

`fdatasync` is faster than `fsync` because it skips the inode-metadata journal commit when only mtime/atime changed. Database engines (PostgreSQL `wal_sync_method=fdatasync`, MySQL `O_DSYNC`) lean on this.

**`O_DSYNC` vs `O_SYNC`**, file-flag equivalents of `fdatasync`/`fsync` per write. They serialize every write into a flush, throughput collapses unless you batch. Use only for short-write WAL paths or as a sanity check.

### 5. `O_DIRECT`. Bypassing the Page Cache

```cpp
int fd = open(path, O_RDWR | O_DIRECT | O_CLOEXEC);
```

Constraints:

- Buffer must be aligned to the filesystem's logical block size (typically 512 B or 4 KiB, `statx(STATX_DIOALIGN)` since 6.1 gives the exact value).
- Length and offset must be block-aligned multiples.
- The kernel does **no** read-ahead and **no** write-back coalescing, the application must do it.
- Concurrency model is "the kernel hands the I/O to the block layer immediately."

When to use it:

- The application has its own cache (databases, log engines).
- You are streaming data once and a 100 GiB file would evict everything else from page cache (use `posix_fadvise(FADV_DONTNEED)` as a softer alternative).
- Random I/O at QD>1 with `io_uring` or `libaio` for disk benchmarking.

When **not** to use it:

- General-purpose code. The page cache is one of the kernel's best features.
- Containers, bypass means you lose the cgroup writeback throttling.

### 6. Atomic Rename and Durable Directories

The "atomic write to existing path" recipe in any production C++ codebase:

```cpp
// atomic_write.cpp
#include <fcntl.h>
#include <unistd.h>
#include <sys/stat.h>
#include <filesystem>
#include <system_error>

namespace fs = std::filesystem;

void atomic_write(const fs::path& dst, std::span<const std::byte> data) {
    fs::path dir = dst.parent_path();
    fs::path tmp = dir / (dst.filename().string() + ".tmp.XXXXXX");

    char tmpbuf[PATH_MAX];
    std::snprintf(tmpbuf, sizeof tmpbuf, "%s", tmp.c_str());
    int fd = mkostemp(tmpbuf, O_CLOEXEC);
    if (fd < 0) throw std::system_error(errno, std::system_category(), "mkostemp");

    // 1. Write payload.
    size_t off = 0;
    while (off < data.size()) {
        ssize_t n = ::write(fd, data.data() + off, data.size() - off);
        if (n < 0) { if (errno == EINTR) continue; throw std::system_error(errno, std::system_category()); }
        off += n;
    }

    // 2. Flush the file's data + metadata.
    if (fsync(fd) != 0) throw std::system_error(errno, std::system_category(), "fsync file");
    close(fd);

    // 3. Rename atomically. Same-filesystem rename is atomic per POSIX.
    if (rename(tmpbuf, dst.c_str()) != 0)
        throw std::system_error(errno, std::system_category(), "rename");

    // 4. Flush the DIRECTORY so the rename is durable. Without this you can
    //    crash with both old and new file gone.
    int dfd = open(dir.c_str(), O_RDONLY | O_DIRECTORY | O_CLOEXEC);
    if (dfd < 0) throw std::system_error(errno, std::system_category(), "open dir");
    if (fsync(dfd) != 0) throw std::system_error(errno, std::system_category(), "fsync dir");
    close(dfd);
}
```

What juniors miss:

1. **fsync the directory after rename**, or the rename can vanish on crash even though the file's data is on disk.
2. The temp file must be in the **same directory** as the destination, otherwise `rename` becomes a cross-filesystem copy and is no longer atomic.
3. `renameat2(RENAME_EXCHANGE)` (kernel 3.15+) atomically swaps two paths, useful for "active/staged" config flips.
4. **`renameat2(RENAME_NOREPLACE)`** is the only way to rename without race-clobbering an existing file.

### 7. `dirsync` and Per-File Sync Flags

- Mount with `dirsync` to make every directory operation synchronous (mail servers historically). Heavy throughput penalty, use for a specific spool directory only.
- Per-inode `chattr +S` makes that file `O_SYNC` regardless of how it is opened. Useful for log files written by code you do not control.
- `chattr +d` excludes from `dump(8)`. `chattr +A` skips atime updates (cheaper than `relatime`).

### 8. `fallocate`, `ftruncate`, and Sparse Files

- `ftruncate(fd, N)` extends to N bytes, **lazily** (sparse). Reads of unwritten regions return zeros at zero disk cost.
- `fallocate(fd, 0, off, len)` reserves on-disk blocks **without writing**. Required when you need guaranteed space for a future write, e.g., a database's WAL pre-allocation.
- `fallocate(fd, FALLOC_FL_PUNCH_HOLE | FALLOC_FL_KEEP_SIZE, off, len)` deallocates a range, leaving a hole. `tail -c +1 logfile > logfile` is not how you trim a log, punch-hole is.
- `fallocate(fd, FALLOC_FL_ZERO_RANGE, off, len)` zeroes a range with no I/O if the FS supports it.
- `fallocate(fd, FALLOC_FL_COLLAPSE_RANGE, off, len)` removes a range and shifts the rest down (ext4, xfs). The fast log-rotation primitive.

### 9. COW Filesystems and Reflinks

ext4 does not have reflinks, xfs and btrfs do.

```cpp
#include <linux/fs.h>
int dst = open("clone", O_RDWR|O_CREAT, 0644);
int src = open("orig",  O_RDONLY);
ioctl(dst, FICLONE, src);   // O(1) reflink, both files share extents COW
```

A 200 GB checkpoint reflink is ~1 ms on xfs. Subsequent writes on either side allocate fresh extents. This is how container layers, ML checkpoints, and database backups achieve "instant snapshots."

### 10. Getting Hardware Truth: `FUA` and Write Barriers

`fsync` only guarantees the kernel has handed pages to the block layer with a flush request. The **disk** must honor it. SATA/NVMe disks have volatile write caches, the kernel issues a `FLUSH` (or `FUA`-tagged write) to commit. Verify:

- Cheap consumer SSDs sometimes lie. Test with `diskchecker.pl` or `fio --fdatasync=1 --verify_state_save=1` plus actual power-cut.
- Cloud block storage (EBS, GCP PD) does honor flushes, ephemeral instance storage may not.
- Enable `barrier=1` on ext4 (default since 2.6.32). On battery-backed RAID controllers you may explicitly disable for speed, at known risk.

### 11. Junior → FAANG Cheatsheet

| Junior | FAANG-grade |
|--------|-------------|
| `write()` and trust durability | `fsync` file + `fsync` parent dir, or use `O_TMPFILE`+`linkat`. |
| `rename` to overwrite | `renameat2` with explicit flags, same-fs only. |
| `fsync` everywhere | `fdatasync` for hot paths, `sync_file_range` for staged flushes. |
| `truncate` to grow file | `fallocate` so writes never `ENOSPC` mid-stream. |
| `cp` for snapshots | `ioctl(FICLONE)` or `copy_file_range` (kernel-side). |
| Trust `stat` mtime | Use `statx(STATX_BTIME)` for true creation time. |
| Use `O_DIRECT` casually | Only with own cache + alignment + io_uring. |

If you remember nothing else: **`fsync(fd); fsync(parent_dirfd);`**, the two-line pattern that has prevented more outages than any framework ever written.
