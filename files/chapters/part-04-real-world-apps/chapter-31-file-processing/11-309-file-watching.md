## 31.9 File Watching

### Simple File Watcher

The file watcher uses `fsnotify` to receive OS-level inotify (Linux), kqueue (macOS), or ReadDirectoryChangesW (Windows) events rather than polling the file's modification time in a loop, reducing CPU usage to near zero when files are idle.

> **Senior track**: `fsnotify` has sharp edges. It does not watch recursively, add each subdirectory yourself and re-add on `Create` events that land on directories. Editors that "save" by writing to a temp file and renaming on top (vim, VS Code, most modern editors) fire `Rename`/`Create`/`Remove`, not `Write`, so a watcher filtering only `fsnotify.Write` misses legitimate edits. Filter on `Write|Create|Rename` and re-stat the target. On Linux, inotify has a per-user limit (`/proc/sys/fs/inotify/max_user_watches`, often 8192 on older distros), large trees will hit it and return `no space left on device` on `Add`. On network filesystems (NFS/SMB) no events fire at all, fall back to a `time.Ticker` + mtime compare. For recursive watching without hand-rolled subscription management, `github.com/rjeczalik/notify` wraps OS-specific recursive APIs (FSEvents on macOS, ReadDirectoryChangesW on Windows) though at the cost of a larger API surface. Events are debounced with a short timer reset on each event, so rapid successive writes, such as an editor saving a file in multiple flushes, trigger only one reload rather than one per write. The watcher goroutine selects on both the events channel and a done channel, allowing clean shutdown when the application receives a termination signal.

```go
package main

import (
    "log"

    "github.com/fsnotify/fsnotify"
)

func watchFiles(paths []string, onChange func(path string)) error {
    watcher, err := fsnotify.NewWatcher()
    if err != nil {
        return err
    }
    defer watcher.Close()

    for _, path := range paths {
        if err := watcher.Add(path); err != nil {
            return err
        }
    }

    for {
        select {
        case event, ok := <-watcher.Events:
            if !ok {
                return nil
            }
            if event.Op&fsnotify.Write == fsnotify.Write {
                onChange(event.Name)
            }
        case err, ok := <-watcher.Errors:
            if !ok {
                return nil
            }
            log.Printf("watcher error: %v", err)
        }
    }
}

// Watch directory for new files
func watchDirectory(dir string, onNew func(path string)) error {
    watcher, err := fsnotify.NewWatcher()
    if err != nil {
        return err
    }
    defer watcher.Close()

    if err := watcher.Add(dir); err != nil {
        return err
    }

    for {
        select {
        case event := <-watcher.Events:
            if event.Op&fsnotify.Create == fsnotify.Create {
                onNew(event.Name)
            }
        case err := <-watcher.Errors:
            log.Printf("error: %v", err)
        }
    }
}
```

### Junior → FAANG: Prerequisites and Interview Framing

File watching is one of those APIs where the Hello World example works immediately and then breaks in every real deployment because you did not know what the underlying kernel feature actually guarantees. The mental model you need is that `fsnotify` is a thin cross-platform wrapper over three very different kernel primitives: inotify on Linux, kqueue on macOS and BSD, and ReadDirectoryChangesW on Windows. They agree on the basics (file created, modified, deleted) and disagree on everything else: inotify watches inodes, kqueue watches file descriptors, and ReadDirectoryChangesW watches directories. The semantics leak through the abstraction, and you must know which OS you are targeting.

Two other facts every junior engineer hits the hard way. First, watching a file's inode means that when an editor saves by writing to a temp file and renaming on top, your watch is now pointing at a deleted inode and you stop receiving events. The fix is to watch the parent directory instead, and filter events by name. Second, file systems do not fire events for changes made through other kernels. NFS mounts, SMB shares, FUSE filesystems with lazy notification, and Docker bind mounts on Windows/macOS all either drop events silently or only fire them for local-origin changes. If your watcher has to work across those boundaries, you need a polling fallback.

A worked first-job example. You are building "hot reload" for a config file. Naive approach: `watcher.Add("/etc/myapp.conf")` and listen for `fsnotify.Write`. It works when you `echo "..." > /etc/myapp.conf`, it fails when your ops team edits with vim because vim writes to `.myapp.conf.swp`, renames to `myapp.conf`, and your watch is on the old inode that no longer has a name. The correct version watches `/etc/myapp` (the directory), filters events where `event.Name == "/etc/myapp/myapp.conf"`, matches on any of `Write|Create|Rename`, debounces with a 200 ms timer, and on fire re-reads the file. That is the shape of production hot-reload.

Interview framing is often "build a config hot-reloader" or "watch a directory for new files and process them." The signals: you mention watching the parent directory rather than the file, you handle editor rename-save patterns, you debounce, you have a polling fallback for network filesystems, you handle the case where the watcher itself dies (inotify queue overflow). Candidates who answer "just use `fsnotify`" without knowing the edge cases get a weak hire at best.

### Senior @ FAANG: inotify Limits, Cross-Platform Watch Semantics, and Ringbuffer Overflow

At senior level, file watching at scale is mostly about knowing the limits of the kernel primitive and designing around them. Each platform has a different failure mode. On Linux, `/proc/sys/fs/inotify/max_user_watches` defaults to 8,192 on older distros and 524,288 on recent ones (systemd bumped the default). `/proc/sys/fs/inotify/max_user_instances` is the per-user limit on watcher handles, usually 128. `/proc/sys/fs/inotify/max_queued_events` is the per-instance event queue, usually 16,384. Exceeding the watch limit returns `ENOSPC` from `inotify_add_watch`, exceeding the instance limit returns `EMFILE` from `inotify_init`, and exceeding the queue size drops events and sets the `IN_Q_OVERFLOW` flag on the next read. Watchman and VS Code both have had public incidents where they recommended users bump `max_user_watches` because they hit this on monorepos. For any tool that might watch a whole repository, document the required sysctl values and check them at startup.

The cross-platform comparison, in practical terms for 2026. Linux inotify watches inodes, not paths, and does not recurse. You must walk the tree and add each directory, which is why Meta's Watchman maintains a shadow tree in userspace. Linux fanotify (since kernel 5.1 with `FAN_REPORT_FID`) is mount-point-wide and does recurse, but requires CAP_SYS_ADMIN and is designed for AV/HIPS-style use cases rather than dev tooling. macOS FSEvents is path-based, recurses by default, and is coalesced with a per-stream latency knob, which means it is higher throughput but lower resolution than inotify. Individual file modifications can coalesce into a single "something under `/Users/me/proj` changed" event and you must rescan to find what. macOS kqueue (used by fsnotify on macOS by default) is per-fd and does not recurse, which is why fsnotify on macOS has the same "watch each directory" issue as Linux despite the OS offering a better API. Windows ReadDirectoryChangesW takes a directory handle and a recursive flag and gives you per-event filenames, which is the best of the three APIs semantically but has its own quirk: the event buffer is in kernel memory and if the producer outpaces the consumer the kernel returns `ERROR_NOTIFY_ENUM_DIR` and you must rescan. `github.com/rjeczalik/notify` wraps the recursive APIs on each platform and gives you one abstraction over FSEvents, ReadDirectoryChangesW, and inotify-with-manual-recursion. It is the right choice when you need recursive watching and do not want to build the subscription manager yourself.

Ringbuffer overflow is the production failure mode nobody tests for. Your code runs fine in dev, then in production the watched directory gets a burst of 20,000 file creates from a CI job and inotify drops events. The symptom is a subtle one: your indexer's view of the filesystem diverges from reality and stays diverged until someone restarts the service. The defense is a three-layer strategy: increase `max_queued_events` at deploy time (to at least 65,536 for busy directories), detect `IN_Q_OVERFLOW` and trigger a full rescan, and provide a manual rescan endpoint for operational recovery. fsnotify exposes overflow by sending an error on `watcher.Errors` when the read returns `IN_Q_OVERFLOW`, but the common code paths ignore watcher errors and log them only. Treat overflow as a first-class event and trigger reconciliation, the same way a database replica handles a WAL gap by triggering a full snapshot.

Watchman's architectural lesson is worth internalizing. Meta built Watchman because file watching at monorepo scale (tens of millions of files, thousands of concurrent watchers) breaks every naive approach. Their solution: one long-running daemon that holds all the kernel watches, maintains an in-memory tree with per-file `clock` timestamps, and serves query-since-clock RPCs to clients. Clients no longer subscribe to raw events, they ask "what changed since clock 42," and Watchman returns a consistent diff. This eliminates the ringbuffer overflow problem (Watchman reconciles on overflow internally), amortizes the per-watcher kernel cost across all clients, and makes cold-start cheap because clients do not rescan the tree, they ask Watchman. Any Go tool that watches a monorepo should consider integrating with Watchman via its socket API rather than running its own inotify instance.

Debouncing strategies vary by use case. For config reload, a fixed debounce of 100 to 500 ms is fine. For build tools, a more sophisticated "wait until no events for 100 ms, then fire" is required because a `make` run emits bursts of writes and you want one rebuild per quiet period, not one per burst. For log tailing, no debounce at all, you want every append. The pattern in Go uses `time.NewTimer` reset on each event and `select` on the timer's `C` channel. Production code should also cap the maximum delay so a pathological write pattern does not indefinitely delay a reaction.

Security properties of file watchers. An attacker with write access to a watched directory can DoS your watcher by generating events faster than you can process, fill the ringbuffer, and trigger rescans. This is an attack vector for build servers and CI runners that watch checkout directories. Defenses: rate-limit event processing per watcher, bound rescan frequency, and use separate watcher goroutines per trust boundary so a noisy directory cannot starve a quiet one. Also be aware that the watcher sees events from every writer to that inode, including processes running as other users. Do not trust event `Name` fields for authorization decisions, always re-stat the resulting path and verify its owner and mode before acting on its content.

Polling fallback design. For NFS, SMB, FUSE, and Docker Desktop bind mounts on macOS/Windows, events do not fire reliably. The canonical fallback is `time.NewTicker` at a user-configurable interval (5 to 60 seconds depending on staleness tolerance), calling `os.Stat` and comparing mtime and size. At scale this is expensive because every poll is a syscall per watched file. Optimizations: hash the directory listing rather than stat each file, use `getdents` to batch the read, and back off the poll interval exponentially when changes are rare. The hybrid pattern is to use fsnotify when available and transparently switch to polling when the mount type indicates it is needed, which you can detect via `/proc/self/mountinfo` on Linux or `statfs` on other Unixes.

Cloud-native file watching in 2026 mostly means watching object stores rather than filesystems. S3 event notifications to SQS, GCS notifications to Pub/Sub, and Azure Blob event grid all replace local file watching for cloud-native workloads. The Go patterns are different (long-polling SQS receive, Pub/Sub subscribe streams) but the application-level debouncing, deduplication, and failure-mode reasoning carry over. Anything you learned about inotify overflow applies to SQS message visibility timeouts and Pub/Sub ack deadlines. The senior engineer treats them as the same class of problem and reuses the same reconciliation patterns.

---
