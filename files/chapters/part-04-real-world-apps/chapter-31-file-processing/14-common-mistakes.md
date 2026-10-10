## Common Mistakes

### Mistake 1: Loading Entire File into Memory

**Wrong:**
```go
func processLargeFile(path string) error {
    // Loads entire 10GB file into memory!
    data, err := os.ReadFile(path)
    if err != nil {
        return err
    }

    for _, line := range strings.Split(string(data), "\n") {
        process(line)
    }
    return nil
}
```

**Correct:**
```go
func processLargeFile(path string) error {
    f, err := os.Open(path)
    if err != nil {
        return err
    }
    defer f.Close()

    // Stream line by line - constant memory
    scanner := bufio.NewScanner(f)
    for scanner.Scan() {
        process(scanner.Text())
    }
    return scanner.Err()
}

// For very long lines, increase buffer
func processLargeLines(path string) error {
    f, err := os.Open(path)
    if err != nil {
        return err
    }
    defer f.Close()

    scanner := bufio.NewScanner(f)
    // Handle lines up to 1MB
    buf := make([]byte, 0, 64*1024)
    scanner.Buffer(buf, 1024*1024)

    for scanner.Scan() {
        process(scanner.Text())
    }
    return scanner.Err()
}
```

### Mistake 2: Not Using Atomic Writes

**Wrong:**
```go
func updateConfig(path string, config Config) error {
    f, err := os.Create(path) // Truncates immediately!
    if err != nil {
        return err
    }
    defer f.Close()

    // If marshal fails, file is now empty/corrupt!
    data, err := json.Marshal(config)
    if err != nil {
        return err
    }

    _, err = f.Write(data)
    return err
}
```

**Correct:**
```go
func updateConfig(path string, config Config) error {
    // Marshal first - don't touch file if this fails
    data, err := json.Marshal(config)
    if err != nil {
        return err
    }

    // Write to temp file
    dir := filepath.Dir(path)
    tmp, err := os.CreateTemp(dir, "config.*.tmp")
    if err != nil {
        return err
    }
    tmpPath := tmp.Name()

    // Cleanup on failure
    success := false
    defer func() {
        if !success {
            os.Remove(tmpPath)
        }
    }()

    if _, err := tmp.Write(data); err != nil {
        tmp.Close()
        return err
    }

    // Ensure data is on disk before rename
    if err := tmp.Sync(); err != nil {
        tmp.Close()
        return err
    }

    if err := tmp.Close(); err != nil {
        return err
    }

    // Atomic rename - readers always see complete file
    if err := os.Rename(tmpPath, path); err != nil {
        return err
    }

    success = true
    return nil
}
```

### Mistake 3: Not Handling Scanner Buffer Overflow

**Wrong:**
```go
func countLines(path string) (int, error) {
    f, _ := os.Open(path)
    defer f.Close()

    count := 0
    scanner := bufio.NewScanner(f)
    for scanner.Scan() {
        count++
    }
    // scanner.Err() not checked - may miss "token too long" error!
    return count, nil
}
```

**Correct:**
```go
func countLines(path string) (int, error) {
    f, err := os.Open(path)
    if err != nil {
        return 0, err
    }
    defer f.Close()

    count := 0
    scanner := bufio.NewScanner(f)

    // Increase buffer for long lines
    buf := make([]byte, 0, 64*1024)
    scanner.Buffer(buf, 10*1024*1024) // Max 10MB lines

    for scanner.Scan() {
        count++
    }

    if err := scanner.Err(); err != nil {
        return 0, fmt.Errorf("scan error at line %d: %w", count, err)
    }

    return count, nil
}
```

### Mistake 4: Ignoring File Permissions and Security

**Wrong:**
```go
func extractZip(archive, destDir string) error {
    r, _ := zip.OpenReader(archive)
    defer r.Close()

    for _, f := range r.File {
        // VULNERABLE: path traversal attack!
        path := filepath.Join(destDir, f.Name)

        if f.FileInfo().IsDir() {
            os.MkdirAll(path, 0755)
            continue
        }

        out, _ := os.Create(path)
        in, _ := f.Open()
        io.Copy(out, in)
        in.Close()
        out.Close()
    }
    return nil
}
```

**Correct:**
```go
func extractZip(archive, destDir string) error {
    r, err := zip.OpenReader(archive)
    if err != nil {
        return err
    }
    defer r.Close()

    // Resolve destination to absolute path
    destAbs, err := filepath.Abs(destDir)
    if err != nil {
        return err
    }

    for _, f := range r.File {
        // Clean the path and join with destination
        cleanName := filepath.Clean(f.Name)
        path := filepath.Join(destAbs, cleanName)

        // Prevent path traversal
        if !strings.HasPrefix(path, destAbs+string(os.PathSeparator)) {
            return fmt.Errorf("invalid file path: %s", f.Name)
        }

        // Prevent symlink attacks
        if f.Mode()&os.ModeSymlink != 0 {
            return fmt.Errorf("symlinks not allowed: %s", f.Name)
        }

        if f.FileInfo().IsDir() {
            if err := os.MkdirAll(path, 0755); err != nil {
                return err
            }
            continue
        }

        if err := extractFile(f, path); err != nil {
            return err
        }
    }
    return nil
}

func extractFile(f *zip.File, destPath string) error {
    // Create parent directories
    if err := os.MkdirAll(filepath.Dir(destPath), 0755); err != nil {
        return err
    }

    out, err := os.OpenFile(destPath, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, f.Mode()&0755)
    if err != nil {
        return err
    }
    defer out.Close()

    in, err := f.Open()
    if err != nil {
        return err
    }
    defer in.Close()

    // Limit extraction size to prevent zip bombs
    limited := io.LimitReader(in, 100*1024*1024) // 100MB max

    _, err = io.Copy(out, limited)
    return err
}
```

### Mistake 5: Not Closing Files in Loops

**Wrong:**
```go
func processAllFiles(paths []string) error {
    for _, path := range paths {
        f, err := os.Open(path)
        if err != nil {
            return err // File handles from previous iterations leak!
        }
        // defer f.Close() only runs after function returns!
        defer f.Close()

        process(f)
    }
    return nil
}
```

**Correct:**
```go
func processAllFiles(paths []string) error {
    for _, path := range paths {
        if err := processFile(path); err != nil {
            return err
        }
    }
    return nil
}

func processFile(path string) error {
    f, err := os.Open(path)
    if err != nil {
        return err
    }
    defer f.Close() // Closes when this function returns

    return process(f)
}

// Alternative: explicit close
func processAllFilesExplicit(paths []string) error {
    for _, path := range paths {
        f, err := os.Open(path)
        if err != nil {
            return err
        }

        err = process(f)
        f.Close() // Close immediately after use

        if err != nil {
            return err
        }
    }
    return nil
}
```

### Junior to FAANG: Building the "why did this fail?" reflex

Junior engineers tend to treat file I/O as a sequence of happy-path function calls. The FAANG bar asks you to internalize that every syscall can fail and every failure mode has a recovery path you must choose deliberately. Before shipping any file-processing code, read it back and answer four questions in order. First, what does the function do if the process dies between any two lines? If the answer is "leaves a half-written file," you have not implemented atomic write and you will ship data corruption. Second, what does the function do if the disk returns `ENOSPC` in the middle of a write? If the answer is "returns the error and the file is truncated," you need the temp file plus rename pattern from Mistake 2. Third, what happens if two processes run this code concurrently against the same path? If the answer is "last writer wins silently," you need file locks or a compare-and-swap via `os.Rename`. Fourth, what happens when the input is adversarial, a 500 GB file, a zip bomb, a symlink pointing at `/etc/passwd`? If you cannot answer, you have the Mistake 4 class of bug.

Worked example for a first job. You are asked to add a "daily export" feature that writes a CSV to a shared NFS volume every midnight. The naive path is `os.Create`, write rows, close. The FAANG path is: marshal in memory or stream to a temp file in the same directory as the target (cross-device rename fails with `EXDEV`), `fsync` the file, close, rename, then `fsync` the parent directory. Without the parent directory fsync on ext4 with `data=ordered`, a crash after rename can leave the directory entry pointing at a file with zero length. This is the kind of detail that separates L3 "it works on my laptop" from L4 "it survives the power plug test."

Interview entry-point framing. When given "process this large file," do not jump to code. Restate the problem as a pipeline with four stages: open, read, transform, commit. Ask the interviewer which stage owns correctness, which owns throughput, and what the failure domain looks like. For each mistake in this chapter there is a one sentence signal: "I would stream rather than load to bound memory" (Mistake 1), "I would write to a temp file and rename atomically with parent fsync" (Mistake 2), "I would size the scanner buffer and always check `scanner.Err`" (Mistake 3), "I would validate paths against the destination root and reject symlinks and enforce a size cap" (Mistake 4), "I would extract the per-file work into its own function so `defer` scoping is correct" (Mistake 5). These are the five sentences that get you past the phone screen.

The "why did this fail?" reflex in practice. Every time you see a bug in file-processing code, classify it against the taxonomy in this chapter before fixing it. Is it a memory issue, a durability issue, a buffer issue, a security issue, or a resource lifecycle issue? Name the class out loud. This is how staff engineers build the mental index that lets them triage an oncall page in under a minute.

### Senior @ FAANG: Review checklists, ADR templates, and governance for file I/O

Staff and principal engineers do not write file-processing code line by line on a whiteboard. They write the review checklist, the ADR, and the rollout playbook that prevents junior engineers from writing the bugs in this chapter in the first place. Below is the playbook I run when I own a data platform.

Staff-level code review checklist for file I/O. A PR touching file I/O is not approved unless every item is addressed explicitly in the description or the code. (1) Durability contract. Does the change call `Sync` on the file and the parent directory before declaring success? If not, the commit message must say "at-most-once durability acceptable because X." (2) Atomicity contract. Does every write-path use temp file plus rename in the same filesystem? Cross-device renames must be flagged and fallback-copied with a checksum verification step. (3) Resource lifecycle. Is every `Open`, `CreateTemp`, and `OpenFile` paired with a `Close` in the same lexical scope, or extracted into a helper function to avoid the loop-defer anti-pattern in Mistake 5? Linters must flag `defer f.Close()` inside a `for` loop as an error, not a warning. (4) Bounded memory. Does the code stream, and is the scanner or reader buffer sized against an explicit input SLA? Unbounded `bufio.Scanner` is a CVE waiting to happen. (5) Adversarial input. Zip, tar, and gzip paths must declare a decompression ratio cap, an extracted size cap, and a path-traversal check. Symlinks in archives default to rejected. (6) Observability. Every file-processing stage emits bytes-read, bytes-written, duration, and error-class counters. If you cannot answer "how many records did yesterday's job write" from a metric, the job is not production. (7) Fsync discipline. Write-heavy paths must document whether they need `O_DSYNC`, periodic `Sync`, or end-of-batch `Sync`. Defaulting to no fsync is a performance optimization that trades durability for throughput, and that trade must be explicit.

ADR template: choosing between `read`, `stream`, `mmap`, and async I/O.

```
# ADR-NNN: File Access Strategy for <Workload>

## Context
- Workload: <batch ingest, real-time tail, random-access lookup>
- File size distribution: p50, p99, max
- Access pattern: sequential, random, append-only, read-mostly
- Concurrency: single reader, fan-out, fan-in
- Durability SLA: RPO, RTO, per-record vs per-batch
- Platform: Linux kernel version, filesystem, storage class (NVMe, EBS gp3, S3 FUSE)

## Options
1. os.ReadFile (load-to-memory)
   Pros: simplest, works for files under 100 MB with headroom.
   Cons: OOM risk, GC pressure, no streaming.
2. bufio.Scanner / bufio.Reader (stream)
   Pros: bounded memory, idiomatic, composes with io.Reader.
   Cons: line-oriented, buffer sizing is a footgun.
3. mmap (syscall.Mmap or golang.org/x/exp/mmap)
   Pros: zero-copy, kernel page cache shared across processes, fast random access.
   Cons: SIGBUS on truncation, Windows semantics differ, no easy error handling, OS paging is opaque.
4. io_uring / async I/O (via cgo or future runtime integration)
   Pros: highest throughput on NVMe, batched syscalls.
   Cons: not idiomatic Go in 1.27, platform-locked, oncall complexity.

## Decision Matrix
| Criterion       | ReadFile | Stream | Mmap | Async |
| Memory bound    |    No    |  Yes   |  OS  |  Yes  |
| Random access   |    Yes   |   No   |  Yes |  Yes  |
| Portability     |    Yes   |  Yes   |   No |   No  |
| Operational load|    Low   |  Low   |  Med |  High |

## Decision
<selected option and justification>

## Consequences
- Rollout gate: benchmark against current workload at p99 file size.
- Rollback: feature flag on the strategy selector.
- Follow-up: revisit when file size p99 doubles or when kernel upgrades to io_uring-stable.
```

Governance model for file-processing platforms. At L6 plus you are not writing code, you are writing the contract that other teams build against. The contract has four pillars. (1) Ingest SLO: time-to-availability (file landed to queryable), data-freshness (max lag), durability (nines per year), and correctness (checksum match rate). (2) Quota and admission control: per-tenant byte budget, per-tenant concurrent-file cap, decompression ratio cap, and a global circuit breaker tied to disk-free thresholds. (3) Deprecation path: every homegrown tool has a sunset date tied to a managed replacement. In 2026 the typical path is "Airflow to Dagster," "cron plus bash to Temporal," and "hand-rolled tar extractor to the platform's sandboxed extractor service." (4) Oncall runbook: every file-processing pipeline has a runbook entry covering "input spike," "disk full," "corrupt input," "downstream consumer down," and "partial write detected."

Maturity model for file-processing platforms. Level 1, scripts: bash and ad hoc Go binaries, no observability, manual reruns. Level 2, scheduled jobs: cron plus shared volume, logs to stdout, no SLO. Level 3, orchestrated pipelines: Airflow or equivalent, retries, basic metrics, per-job owner. Level 4, contract-driven platform: schemas enforced at ingest, quotas, multi-tenant isolation, per-record lineage. Level 5, managed platform: self-service onboarding, automated rollout and rollback, SLO dashboards per tenant, automated postmortems, chaos-tested durability. Most companies plateau at level 3 because the jump to level 4 requires a platform team and a political mandate to deprecate homegrown tooling.

Incident retrospective pattern. When a file-processing incident happens, the postmortem must answer six questions, not five. The usual five are trigger, detection, mitigation, root cause, and prevention. The sixth, which separates a FAANG postmortem from a generic one, is "which of the five mistakes in this chapter does this map to, and why did our review process miss it?" If the answer is "we do not have a review checklist for this class of bug," the action item is to add one to the checklist above, not to fix the single bug. The GitLab 2017 data-loss incident maps to the Mistake 2 failure mode of a write path that looks successful but is not: their backup and replication jobs silently produced empty or invalid output that nobody verified until recovery was needed. The Cloudflare 2020 partial-log-corruption class of incidents maps to Mistake 3 (scanner buffer overflow swallowed silently). The GitHub October 2018 MySQL incident is not a file-processing incident, but its unbounded replication backlog rhymes with the "no bounded memory" class of Mistake 1. Map every incident to a class, fix the class, not the instance.

---
