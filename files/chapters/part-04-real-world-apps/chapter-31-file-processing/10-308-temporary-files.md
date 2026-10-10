## 31.8 Temporary Files

### Creating Temp Files

> **Senior track**: Truly durable atomic writes require three things, not just `os.Rename`. First, write the payload, then `f.Sync()` the temp file to push data past the page cache. Second, `os.Rename` atomically. Third, open the parent directory and `Sync()` it too, otherwise a crash between rename and metadata flush can leave the directory entry pointing at nothing. Skip step three and your "atomic write" survives every test but loses the last write on real power failures. On Windows, `os.Rename` calls `MoveFileEx` with `MOVEFILE_REPLACE_EXISTING`, which requires the target to not be open in any handle, including the file you're replacing. Close the old handle before rename. On the temp file itself, always create it in the same directory as the destination, cross-filesystem rename is not atomic and falls back to copy+delete.

Temporary files are created with `os.CreateTemp(dir, pattern)`, which atomically creates a uniquely named file in the specified directory and returns the open `*os.File`, eliminating the TOCTOU race of generating a name and then opening it. The temporary directory is obtained from `os.TempDir()` or an application-specific temp directory under the data root, keeping temp files off the OS temp directory where other processes or cleanup daemons might remove them unexpectedly. Deferred removal with `defer os.Remove(f.Name())` ensures cleanup even on error paths, but the file must be closed before removal on Windows where open files cannot be deleted.

```go
package main

import (
    "os"
    "path/filepath"
)

// Create temp file
func withTempFile(fn func(f *os.File) error) error {
    f, err := os.CreateTemp("", "myapp-*.tmp")
    if err != nil {
        return err
    }
    defer os.Remove(f.Name())
    defer f.Close()

    return fn(f)
}

// Create temp directory
func withTempDir(fn func(dir string) error) error {
    dir, err := os.MkdirTemp("", "myapp-*")
    if err != nil {
        return err
    }
    defer os.RemoveAll(dir)

    return fn(dir)
}

// Atomic file write (write to temp, then rename)
func atomicWrite(path string, data []byte) error {
    dir := filepath.Dir(path)
    name := filepath.Base(path)

    f, err := os.CreateTemp(dir, name+".tmp.*")
    if err != nil {
        return err
    }
    tempPath := f.Name()

    // Clean up on failure
    defer func() {
        if err != nil {
            os.Remove(tempPath)
        }
    }()

    if _, err = f.Write(data); err != nil {
        f.Close()
        return err
    }

    if err = f.Sync(); err != nil {
        f.Close()
        return err
    }

    if err = f.Close(); err != nil {
        return err
    }

    return os.Rename(tempPath, path)
}
```

### Junior → FAANG: Prerequisites and Interview Framing

Temporary files seem like a trivial topic and then you meet the first engineer who lost a day of customer data because they wrote the config file with `os.WriteFile` and the machine lost power mid-write. The mental model you need has three layers. First, writes do not hit disk synchronously. They land in the OS page cache, and the kernel flushes them in the background. A crash between your `Write` return and the kernel flush loses data. Second, even after `Sync` on the file, the directory entry may still be in the page cache, so a crash between file flush and directory flush can leave you with zero-byte files or stale names. Third, rename is atomic with respect to other processes on the same filesystem, but only after the rename itself is durable. These three layers are why atomic writes need write-sync-rename-syncdir, not just write-rename.

A first-job worked example. You are saving user preferences to `~/.myapp/config.json`. The obvious approach is `os.WriteFile(path, data, 0644)` which opens, writes, closes. Failure modes: if the write is interrupted, the file is half-written and unparseable. If the process crashes after the `Close` returns but before the kernel flushes, the file exists but is empty after reboot. The correct pattern is `os.CreateTemp` in the same directory as the final path, write, `Sync`, `Close`, `Rename`, and then open the parent directory and `Sync` it. For most applications the last step is skipped because nobody pulls the power cord, but for databases, package managers, and anything with a state file that must survive a crash, the directory sync is mandatory.

Interview framing is almost always "implement atomic write" or "how would you make sure a config file update is crash-safe." The signal they are looking for: you mention `CreateTemp` in the same directory (not `os.TempDir()`), you call `Sync` before rename, you clean up the temp file on error paths, you handle the Windows case where `Rename` fails if the destination is open. Extra credit is mentioning that `os.Rename` is not atomic across filesystems and falls back to copy-plus-delete, which is why the temp file must sit next to the destination. Candidates who write to `/tmp` and then `os.Rename` across filesystems fail silently until a real power loss proves them wrong.

### Senior @ FAANG: TOCTOU Hardening, O_TMPFILE, and Atomic Write Patterns at Scale

At senior level, temp files are a security surface and a durability contract. The security surface is TOCTOU, the durability contract is the sequence of syscalls that must execute in order for your "atomic" write to actually be atomic under crash. Both are easy to get wrong, and the failure modes are rare enough to pass code review and common enough to lose data in production.

The Linux `O_TMPFILE` flag is the right answer for secure temp files in 2026. Opening a directory with `O_TMPFILE | O_RDWR` creates an unnamed inode that is linked into no directory, cannot be opened by name (no TOCTOU window at all), and is automatically freed on `close` or process exit. To make it a real file, you call `linkat(fd, "", AT_FDCWD, dest, AT_EMPTY_PATH)` after you are done writing. This gives you a true "create, write, then publish atomically" primitive with no window where an attacker can race against the temp path. Go does not wrap this in the stdlib, but you can call it via `golang.org/x/sys/unix` with `unix.Open(dir, unix.O_TMPFILE|unix.O_RDWR|unix.O_CLOEXEC, 0600)` and `unix.Linkat`. For code that must run on older kernels (pre-3.11), fall back to `CreateTemp` with a randomly named file in the target directory and `O_EXCL` to prevent symlink attacks.

The standard atomic write on Linux in 2026 is: `O_TMPFILE` into the destination directory, write, `fsync` the file, `linkat` to final name, `fsync` the parent directory. On macOS, `O_TMPFILE` does not exist, so you use `CreateTemp` plus `Rename` plus `fsync` the directory. On Windows, `MoveFileEx` with `MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH` gives atomic rename with durability, and the parent directory sync is implicit. Cross-platform code should abstract this behind an `AtomicWriter` interface with OS-specific implementations. The `github.com/google/renameio` package provides this for Unix, and is the closest the Go ecosystem has to a canonical implementation.

TOCTOU hardening beyond O_TMPFILE. Every place you have `stat(path) ... open(path)` or `open(path) ... chmod(path)` is a race. The fix is to operate on file descriptors: `openat` for open-relative-to-directory-fd, `fstatat` for stat-relative-to-directory-fd, `fchmod` and `fchown` for operations on an open file, and `linkat`/`renameat` for directory modifications. Go 1.24+ `os.Root` wraps the openat family and is the right default. For temporary files specifically, the canonical secure pattern is: open the target directory with `O_DIRECTORY | O_RDONLY`, create a temp file with `O_TMPFILE` relative to that fd, write, `linkat` to final name relative to that fd. At no point does an attacker have a path to race against.

Durability guarantees vary by filesystem and mount options. ext4 with default `data=ordered` journals metadata before data, which means after a crash you will see either the old file or the new file but not a half-written file, even without an explicit `fsync`. XFS makes weaker guarantees and requires `fsync` plus directory `fsync`. Btrfs with CoW gives you atomic file replacement for free but the cost is fragmentation. ZFS is similar to btrfs. The portable answer is "always fsync, because you do not know the filesystem." The optimized answer for known-ext4 is "skip the directory fsync on ordered-mode ext4," which saves one syscall per atomic write and at package-manager scale (dpkg installing thousands of files) adds up.

Temp file cleanup policy at scale is a surprisingly hard operational problem. `os.TempDir` returns `/tmp` on Linux, which is typically tmpfs (RAM-backed) and cleared on reboot, but may be disk-backed on minimal containers. `/var/tmp` persists across reboots and is the right choice for long-running operations like large file uploads. Systemd's `systemd-tmpfiles` cleans `/tmp` and `/var/tmp` on a configurable age. For application temp directories under `/var/lib/myapp/tmp` you are responsible for cleanup. The production pattern is a startup scan that removes files older than some threshold and rejects writes to temp names that collide, combined with a signal handler that removes in-progress temp files on SIGTERM. Getting this wrong fills disks in the middle of the night, which is a recurring SRE incident class.

Secure temp file permissions matter for multi-tenant systems. `CreateTemp` creates files with mode 0600 by default, which is correct for most uses. Do not `chmod` them wider before writing secrets. On systems with `umask` set loosely, the mode may still be masked, so explicitly `f.Chmod(0600)` after open if the file will hold sensitive data before rename. On Linux with SELinux or AppArmor, temp files inherit the security context of the creating process, which is usually what you want but can break when the temp file is later opened by a different service under a different context. Use `setfscreatecon` if you need to override this.

CSV injection is the compression topic that lives here too, because temp files often hold intermediate CSVs before upload. A field starting with `=`, `+`, `-`, `@`, or tab is interpreted as a formula by Excel and LibreOffice, and can exfiltrate data via `=HYPERLINK` or execute commands via DDE. The fix is to prefix such fields with a single quote or wrap them in a literal quote and escape. Every CSV library in every language has this bug, and the correct defense is at the writer layer, not at the reader layer.

Checksum-on-commit is the durability pattern for critical atomic writes. Write the data to temp, compute a hash, store the hash in an adjacent `.sha256` file (also written atomically), then rename both. On read, verify the hash before trusting the content. This catches silent corruption that `fsync` alone does not, because `fsync` only guarantees the bytes you wrote are durable, not that they are correct. For config files this is overkill, for financial state files it is mandatory.

Error handling for atomic writes is the place where the "simple" API lies. If the `Sync` succeeds but `Rename` fails (ENOSPC, read-only filesystem), the temp file is still on disk holding the new data and the old file still holds the stale data. The correct cleanup is to log, remove the temp file, and propagate the error so the caller knows the write did not happen. If `Rename` succeeds but the directory `Sync` fails, the new file is visible to readers but may disappear after a crash. This is a hard case to surface honestly. The pragmatic compromise is to fsync-best-effort and log the fsync error as a durability warning, while reporting the write as successful because the application cannot do anything useful with a failure at that stage.

---
