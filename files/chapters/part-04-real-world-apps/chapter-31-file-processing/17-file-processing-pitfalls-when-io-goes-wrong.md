## File Processing Pitfalls: When I/O Goes Wrong

### The Memory-Mapped OOM Massacre

**The Incident**: A log analysis service processed multi-gigabyte log files. A developer optimized it using `mmap` to "avoid loading files into memory." In testing with 100MB files, it was blazing fast. In production with 50GB files on machines with 16GB RAM, the service was OOM-killed repeatedly. The developer didn't understand that `mmap` doesn't avoid memory usage - it just moves it to virtual memory, and accessing random pages across a 50GB file causes massive page fault storms and swap thrashing.

```go
// WRONG: mmap for sequential processing of huge files
func processLargeFile(path string) error {
    f, err := os.Open(path)
    if err != nil {
        return err
    }
    defer f.Close()

    stat, _ := f.Stat()
    // This will cause massive virtual memory usage
    data, err := syscall.Mmap(int(f.Fd()), 0, int(stat.Size()),
        syscall.PROT_READ, syscall.MAP_SHARED)
    if err != nil {
        return err
    }
    defer syscall.Munmap(data)

    // Sequential access through mmap - wasteful
    for i := 0; i < len(data); i++ {
        process(data[i])
    }
    return nil
}

// CORRECT: Streaming for sequential processing
func processLargeFile(path string) error {
    f, err := os.Open(path)
    if err != nil {
        return err
    }
    defer f.Close()

    // Buffer for sequential reads - predictable memory usage
    buf := make([]byte, 64*1024) // 64KB buffer
    reader := bufio.NewReaderSize(f, 1024*1024) // 1MB read buffer

    for {
        n, err := reader.Read(buf)
        if n > 0 {
            process(buf[:n])
        }
        if err == io.EOF {
            break
        }
        if err != nil {
            return err
        }
    }
    return nil
}

// When mmap IS appropriate: random access patterns
func processWithRandomAccess(path string) (*MappedFile, error) {
    f, err := os.Open(path)
    if err != nil {
        return nil, err
    }

    stat, _ := f.Stat()
    if stat.Size() > 1<<30 { // > 1GB
        // Don't mmap huge files for random access either
        // Use a chunked approach instead
        return nil, errors.New("file too large for mmap, use chunked access")
    }

    data, err := syscall.Mmap(int(f.Fd()), 0, int(stat.Size()),
        syscall.PROT_READ, syscall.MAP_SHARED)
    if err != nil {
        f.Close()
        return nil, err
    }

    return &MappedFile{file: f, data: data}, nil
}
```

### The Scanner Buffer Overflow Silence

**The Incident**: A CSV import service used `bufio.Scanner` to read lines. For months it worked perfectly. Then a customer uploaded a CSV with a 2MB cell (base64-encoded image data). The scanner silently stopped at that line with no error indication. 50,000 rows after the problematic row were never imported. The customer didn't notice for weeks because the first 10,000 rows were imported correctly.

```go
// WRONG: Default scanner buffer, no error check
func importCSV(path string) error {
    f, err := os.Open(path)
    if err != nil {
        return err
    }
    defer f.Close()

    scanner := bufio.NewScanner(f)
    for scanner.Scan() {
        processLine(scanner.Text())
    }
    // Missing scanner.Err() check!
    return nil
}

// CORRECT: Increased buffer, proper error handling
func importCSV(path string) error {
    f, err := os.Open(path)
    if err != nil {
        return err
    }
    defer f.Close()

    scanner := bufio.NewScanner(f)

    // Increase buffer for large lines (default is 64KB)
    const maxLineSize = 10 * 1024 * 1024 // 10MB
    buf := make([]byte, maxLineSize)
    scanner.Buffer(buf, maxLineSize)

    lineNum := 0
    for scanner.Scan() {
        lineNum++
        if err := processLine(scanner.Text()); err != nil {
            return fmt.Errorf("line %d: %w", lineNum, err)
        }
    }

    // CRITICAL: Always check scanner error
    if err := scanner.Err(); err != nil {
        if err == bufio.ErrTooLong {
            return fmt.Errorf("line %d exceeds max size of %d bytes",
                lineNum+1, maxLineSize)
        }
        return fmt.Errorf("scan error at line %d: %w", lineNum, err)
    }

    return nil
}

// For truly unbounded lines, use ReadString instead
func importCSVUnbounded(path string) error {
    f, err := os.Open(path)
    if err != nil {
        return err
    }
    defer f.Close()

    reader := bufio.NewReader(f)
    lineNum := 0

    for {
        lineNum++
        line, err := reader.ReadString('\n')
        if len(line) > 0 {
            // ReadString includes the delimiter
            line = strings.TrimSuffix(line, "\n")
            if err := processLine(line); err != nil {
                return fmt.Errorf("line %d: %w", lineNum, err)
            }
        }
        if err == io.EOF {
            break
        }
        if err != nil {
            return fmt.Errorf("line %d: %w", lineNum, err)
        }
    }
    return nil
}
```

### The Path Traversal Apocalypse

**The Incident**: A document management API allowed users to download files by path. The path was validated to ensure it started with the user's directory. An attacker uploaded a file named `../../../etc/passwd` (yes, the filename itself). When another user listed their directory, the malicious filename was returned. Their client then requested that file, and the server - after joining paths - served `/etc/passwd`. The vulnerability existed for 2 years in production before discovery.

```go
// WRONG: Path joining without validation
func downloadHandler(w http.ResponseWriter, r *http.Request) {
    userDir := filepath.Join(baseDir, r.Header.Get("X-User-ID"))
    filename := r.URL.Query().Get("file")

    // This can escape userDir!
    fullPath := filepath.Join(userDir, filename)

    http.ServeFile(w, r, fullPath)
}

// CORRECT: Strict path validation
func downloadHandler(w http.ResponseWriter, r *http.Request) {
    userID := r.Header.Get("X-User-ID")
    if !isValidUserID(userID) {
        http.Error(w, "invalid user", http.StatusBadRequest)
        return
    }

    userDir := filepath.Join(baseDir, userID)
    filename := r.URL.Query().Get("file")

    // Clean and validate the path
    fullPath, err := securePath(userDir, filename)
    if err != nil {
        http.Error(w, "invalid path", http.StatusBadRequest)
        return
    }

    http.ServeFile(w, r, fullPath)
}

func securePath(baseDir, requestedPath string) (string, error) {
    // Clean the requested path
    cleanPath := filepath.Clean(requestedPath)

    // Reject paths that try to escape
    if strings.HasPrefix(cleanPath, "..") {
        return "", errors.New("path traversal attempt")
    }

    // Reject absolute paths
    if filepath.IsAbs(cleanPath) {
        return "", errors.New("absolute path not allowed")
    }

    // Join and resolve to absolute path
    fullPath := filepath.Join(baseDir, cleanPath)
    absPath, err := filepath.Abs(fullPath)
    if err != nil {
        return "", err
    }

    // Verify the result is still under baseDir
    absBase, err := filepath.Abs(baseDir)
    if err != nil {
        return "", err
    }

    // Must have the base as prefix (with trailing separator to prevent
    // /data/user matching /data/user-evil)
    if !strings.HasPrefix(absPath, absBase+string(filepath.Separator)) &&
       absPath != absBase {
        return "", errors.New("path escapes base directory")
    }

    // Verify the file actually exists and is a regular file
    stat, err := os.Stat(absPath)
    if err != nil {
        return "", err
    }
    if !stat.Mode().IsRegular() {
        return "", errors.New("not a regular file")
    }

    return absPath, nil
}
```

### The Atomic Write That Wasn't

**The Incident**: A configuration management system wrote config files atomically using temp-file-then-rename. It worked great on Linux. On Windows deployment, updates intermittently failed. The issue: Go's `os.Rename` does overwrite an existing destination on Windows (it calls `MoveFileEx` with `MOVEFILE_REPLACE_EXISTING`), but that call fails with a sharing violation when another process holds the destination open, which the config-reloading service frequently did. When the rename failed, the temp file was cleaned up in defer and the original file stayed stale. Windows rename is also not guaranteed atomic the way POSIX rename is, so a concurrent reader can observe the file mid-swap. And on any platform, the rename is not durable across a crash without `fsync` on the file and the parent directory.

```go
// WRONG: Atomic write that fails on Windows and isn't durable
func writeConfigBad(path string, data []byte) error {
    tmp, err := os.CreateTemp(filepath.Dir(path), "config-*")
    if err != nil {
        return err
    }
    defer os.Remove(tmp.Name()) // Cleans up on any error

    if _, err := tmp.Write(data); err != nil {
        return err
    }
    tmp.Close()

    // On Windows this fails with a sharing violation if a reader holds path open;
    // it also skips the fsync needed for crash durability.
    return os.Rename(tmp.Name(), path)
}

// CORRECT: Cross-platform atomic write with durability
func writeConfigAtomic(path string, data []byte) error {
    dir := filepath.Dir(path)

    // Create temp file in same directory (required for atomic rename)
    tmp, err := os.CreateTemp(dir, ".config-*.tmp")
    if err != nil {
        return fmt.Errorf("create temp file: %w", err)
    }
    tmpPath := tmp.Name()

    // Clean up temp file on any error
    success := false
    defer func() {
        if !success {
            os.Remove(tmpPath)
        }
    }()

    // Write data
    if _, err := tmp.Write(data); err != nil {
        tmp.Close()
        return fmt.Errorf("write: %w", err)
    }

    // Sync to ensure data is on disk before rename
    if err := tmp.Sync(); err != nil {
        tmp.Close()
        return fmt.Errorf("sync: %w", err)
    }

    if err := tmp.Close(); err != nil {
        return fmt.Errorf("close: %w", err)
    }

    // os.Rename replaces an existing destination on all supported platforms
    // (POSIX rename, and MoveFileEx with MOVEFILE_REPLACE_EXISTING on Windows).
    // On Windows it can still fail with a sharing violation if a reader holds
    // the destination open, so callers should retry or coordinate with readers.
    if err := os.Rename(tmpPath, path); err != nil {
        return fmt.Errorf("rename: %w", err)
    }

    // Sync the directory to ensure the rename is durable
    if err := syncDir(dir); err != nil {
        // Log but don't fail - the file is written
        log.Printf("warning: directory sync failed: %v", err)
    }

    success = true
    return nil
}

func syncDir(path string) error {
    d, err := os.Open(path)
    if err != nil {
        return err
    }
    defer d.Close()
    return d.Sync()
}
```

### The File Handle Leak in Loops

**The Incident**: A batch processing job opened files in a loop to aggregate data from thousands of small files. Each iteration used `defer f.Close()`. The team thought this was fine - defer runs when the function returns, right? But the function was a long-running loop. After processing 10,000 files, the process hit the file descriptor limit and crashed. The "fix" was to increase ulimit. The actual fix was to not defer in loops.

```go
// WRONG: Defer in a loop accumulates until function returns
func aggregateFiles(paths []string) error {
    var total int64

    for _, path := range paths {
        f, err := os.Open(path)
        if err != nil {
            return err
        }
        defer f.Close() // These ALL defer until function returns!

        var count int64
        fmt.Fscan(f, &count)
        total += count
    }

    return nil
}

// CORRECT: Close immediately or use helper function
func aggregateFiles(paths []string) error {
    var total int64

    for _, path := range paths {
        count, err := readCount(path)
        if err != nil {
            return err
        }
        total += count
    }

    return nil
}

func readCount(path string) (int64, error) {
    f, err := os.Open(path)
    if err != nil {
        return 0, err
    }
    defer f.Close() // Now defer is scoped to this function

    var count int64
    if _, err := fmt.Fscan(f, &count); err != nil {
        return 0, err
    }
    return count, nil
}

// Alternative: Explicit close with error handling
func aggregateFilesExplicit(paths []string) error {
    var total int64

    for _, path := range paths {
        f, err := os.Open(path)
        if err != nil {
            return err
        }

        var count int64
        _, err = fmt.Fscan(f, &count)

        // Close immediately, check error
        closeErr := f.Close()
        if err != nil {
            return err
        }
        if closeErr != nil {
            return closeErr
        }

        total += count
    }

    return nil
}
```

### The Zip Bomb Defense Failure

**The Incident**: A file upload API accepted ZIP files and extracted them for processing. An attacker uploaded a 42KB ZIP file that expanded to 4.5 petabytes (the infamous "42.zip" bomb). The server ran out of disk space, crashed, and corrupted other services sharing the same volume. The incident response team discovered the attack vector was documented in 2001, but nobody had implemented decompression limits.

```go
// WRONG: Unbounded zip extraction
func extractZipBad(zipPath, destDir string) error {
    r, err := zip.OpenReader(zipPath)
    if err != nil {
        return err
    }
    defer r.Close()

    for _, f := range r.File {
        destPath := filepath.Join(destDir, f.Name)

        if f.FileInfo().IsDir() {
            os.MkdirAll(destPath, 0755)
            continue
        }

        // No size limit, no path validation!
        outFile, _ := os.Create(destPath)
        rc, _ := f.Open()
        io.Copy(outFile, rc) // Could be petabytes!
        rc.Close()
        outFile.Close()
    }
    return nil
}

// CORRECT: Secure zip extraction with multiple safeguards
type ZipExtractConfig struct {
    MaxFileSize       int64  // Max size per file
    MaxTotalSize      int64  // Max total extracted size
    MaxFiles          int    // Max number of files
    MaxNameLength     int    // Max filename length
    AllowedExtensions []string
}

var DefaultZipConfig = ZipExtractConfig{
    MaxFileSize:   100 * 1024 * 1024,  // 100MB per file
    MaxTotalSize:  1024 * 1024 * 1024, // 1GB total
    MaxFiles:      1000,
    MaxNameLength: 255,
}

func extractZipSecure(zipPath, destDir string, cfg ZipExtractConfig) error {
    r, err := zip.OpenReader(zipPath)
    if err != nil {
        return err
    }
    defer r.Close()

    if len(r.File) > cfg.MaxFiles {
        return fmt.Errorf("too many files: %d > %d", len(r.File), cfg.MaxFiles)
    }

    var totalSize int64
    for _, f := range r.File {
        // Check filename length
        if len(f.Name) > cfg.MaxNameLength {
            return fmt.Errorf("filename too long: %s", f.Name)
        }

        // Secure path validation
        destPath, err := securePath(destDir, f.Name)
        if err != nil {
            return fmt.Errorf("invalid path %s: %w", f.Name, err)
        }

        if f.FileInfo().IsDir() {
            if err := os.MkdirAll(destPath, 0755); err != nil {
                return err
            }
            continue
        }

        // Check declared size (can be spoofed, but good first filter)
        if f.UncompressedSize64 > uint64(cfg.MaxFileSize) {
            return fmt.Errorf("file too large: %s (%d bytes)",
                f.Name, f.UncompressedSize64)
        }

        // Check compression ratio (detect zip bombs)
        if f.CompressedSize64 > 0 {
            ratio := float64(f.UncompressedSize64) / float64(f.CompressedSize64)
            if ratio > 100 { // Suspicious compression ratio
                return fmt.Errorf("suspicious compression ratio %.1f for %s",
                    ratio, f.Name)
            }
        }

        // Extract with size limit
        extracted, err := extractFileLimited(f, destPath, cfg.MaxFileSize)
        if err != nil {
            return err
        }

        totalSize += extracted
        if totalSize > cfg.MaxTotalSize {
            return fmt.Errorf("total size exceeded: %d > %d",
                totalSize, cfg.MaxTotalSize)
        }
    }

    return nil
}

func extractFileLimited(f *zip.File, destPath string, maxSize int64) (int64, error) {
    // Create parent directories
    if err := os.MkdirAll(filepath.Dir(destPath), 0755); err != nil {
        return 0, err
    }

    rc, err := f.Open()
    if err != nil {
        return 0, err
    }
    defer rc.Close()

    outFile, err := os.Create(destPath)
    if err != nil {
        return 0, err
    }
    defer outFile.Close()

    // Use LimitReader to enforce size limit during extraction
    // (protects against spoofed headers)
    limitReader := io.LimitReader(rc, maxSize+1)
    n, err := io.Copy(outFile, limitReader)
    if err != nil {
        os.Remove(destPath)
        return 0, err
    }

    if n > maxSize {
        os.Remove(destPath)
        return 0, fmt.Errorf("file exceeded size limit during extraction")
    }

    return n, nil
}
```

### Quick Reference: File Processing Pitfalls

| Pitfall | Symptom | Fix |
|---------|---------|-----|
| mmap for sequential I/O | OOM, swap thrashing | Use streaming reads |
| Scanner buffer overflow | Silent data truncation | Check scanner.Err(), increase buffer |
| Path traversal | Security breach, data leak | Validate paths, use securePath() |
| Non-atomic writes | Corrupted files | Temp file + fsync + rename |
| Defer in loops | File descriptor exhaustion | Helper functions or explicit close |
| Unbounded extraction | Disk exhaustion, zip bombs | Size limits, ratio checks |
| Missing fsync | Data loss on crash | Sync before rename |
| Windows path issues | Cross-platform failures | Use filepath, handle OS differences |

### Junior to FAANG: Reading pitfalls as a diagnostic lens

Each pitfall above is a fossil of a real incident. Junior engineers read them as trivia. The FAANG bar asks you to read them as a diagnostic lens you carry into every code review and every oncall page. Before approving any file-processing PR on your first team, walk the seven pitfalls in this chapter as a checklist and answer "could this instance trigger that pitfall." If the answer to any is "maybe," the PR needs a comment.

Worked example. You are paged at 3 AM because a batch job has been running for 90 minutes when the p99 is 8 minutes. The junior reflex is to look at logs and CPU. The FAANG reflex walks the pitfall list. Memory-mapped on a huge file, producing swap thrash? Check `vmstat 1` and look at `si` and `so`. Scanner buffer silently dropped input? Check the line count against expected count from the upstream producer. Path traversal triggering an infinite recursion into a symlinked loop? Check the process's open file list with `lsof`. Atomic write that is not atomic, producing stuck locks? Check for stale `.tmp` files in the target directory. File descriptor leak? Check `/proc/$pid/fd` count against `ulimit -n`. Zip extraction OOM? Check disk usage trajectory. Each pitfall maps to a signal. Naming the map out loud is what senior oncall looks like.

Interview entry point for pitfall questions. When an interviewer describes an incident, do not jump to the fix. Ask three questions first. "What was the detection mechanism that fired?" "What was the observable symptom?" "How was the root cause confirmed?" The gap between symptom and root cause is where most candidates fail. A file-descriptor leak presents as "socket accept fails with EMFILE," not as "we had too many open files." A scanner overflow presents as "downstream consumer is missing records," not as "scanner returned an error we ignored." The FAANG signal is the candidate who follows the symptom chain backward without skipping a link.

First-job context for the atomic write pitfall. This one hits every new engineer who ships a config-update feature. The naive path passes the unit test because the unit test does not crash the process mid-write. The only way to catch the bug before production is either a chaos test (kill -9 the process during write, rerun, assert file integrity) or a fuzz test that injects write errors. Neither is in the default testing curriculum. If you are on your first team and you see an atomic-write pattern without a chaos test, propose adding one as your first week task. That single contribution signals L4 capability in the first month.

Prerequisite gap check. These pitfalls assume fluency in: (1) POSIX file semantics (inode versus path, how rename affects open handles), (2) kernel page cache behavior and when fsync actually reaches the disk platter versus just the disk controller, (3) the difference between "atomic at the VFS layer" and "durable across a power cycle," (4) file descriptor accounting and ulimit behavior, (5) the fsnotify inode model. If any of these is fuzzy, the pitfall descriptions will feel like magic incantations rather than consequences of first principles.

The "why did this fail?" reflex, pitfall edition. Given any production bug, classify it into the pitfall taxonomy before fixing it. "We are OOM on the log analyzer" could be pitfall 1 (mmap misuse) or an unrelated memory leak. "We lost records during the import" could be pitfall 2 (scanner overflow) or an upstream producer issue. "We are getting path escape errors" is pitfall 3. "Config reload is reading stale data" is pitfall 4. "File descriptor exhaustion" is pitfall 5. "Disk full after a ZIP upload" is pitfall 6. The classification itself is the skill. The fix is a mechanical follow-up.

### Senior @ FAANG: Incident retrospectives, governance, and the path to a managed pipeline platform

At staff plus, you do not fix pitfalls one PR at a time. You build the systems that prevent the pitfalls from shipping. Below is the governance model I apply.

Incident postmortem template, staff edition. A postmortem for any pitfall in this chapter must include the following fields. (1) Trigger: what specific input or event caused the failure. (2) Detection: what alarm fired, at what threshold, after what lag. (3) Mitigation: what action stopped the bleeding, and what side effects did that action have. (4) Root cause: one sentence, naming the specific class of bug. (5) Contributing factors: three to five factors that allowed the root cause to reach production. (6) Review-process gap: which item on the staff review checklist was missing or not enforced. (7) Class-level action: what change to the checklist, the linter, the platform, or the runbook prevents every instance of this class, not just this instance. (8) Instance-level action: the immediate fix. (9) Learning-level action: what artifact (training doc, internal post, architecture deep-dive) is produced so the org absorbs the lesson.

Mapped incident retrospectives. The Cloudflare July 2019 outage was not a file-processing incident but the root cause pattern (unbounded input crashing a regex engine) maps to pitfall 2 (scanner overflow, unbounded input trust). The class-level action was "reject unbounded regexes in the config pipeline." Translated to file processing, the class-level action is "reject unbounded scanner buffers in the platform linter." The GitHub October 2018 incident maps to pitfall 4 at a systems scale: a seemingly atomic failover was not atomic across the network partition boundary, and the reconciliation took 24 hours. Translated to file processing, this is a reminder that `os.Rename` is atomic on one filesystem and nothing else. The GitLab January 2017 incident maps to pitfall 5 indirectly (the backup pipeline had resource exhaustion silently for weeks) and to the general theme of "silent failure of a critical path with no SLO alarm." Translated to file processing, every ingest pipeline needs a heartbeat metric that alarms on absence, not just on error.

SLO framing for ingest pipelines. A senior-owned ingest pipeline publishes four SLOs, each tied to a pitfall class. (1) Time-to-availability: p95 lag from file landing to record queryable, alarm when above threshold. Protects against pitfalls 1 and 2 (throughput collapse from memory pressure or silent scanner stalls). (2) Durability: fraction of bytes durable after the "commit" signal, measured by end-to-end checksum comparison. Protects against pitfall 4 (non-atomic writes). (3) Correctness: parse-success rate and schema-conformance rate. Protects against pitfall 2 (silent truncation). (4) Isolation: per-tenant resource usage stays within quota, alarm on breach. Protects against pitfalls 1 and 6 (one tenant starving others via memory or disk).

ADR template for mmap versus stream versus read-all versus async.

```
# ADR-NNN: I/O Strategy for <Workload>

## Context
- Workload: <describe>
- File size p50, p99, max: <values>
- Access pattern: sequential, random, or mixed
- Platform: <kernel, filesystem, storage class>
- SLO: <throughput, latency, durability targets>

## Options
1. ReadFile: simplest, OOM ceiling at file size.
2. Stream via bufio: bounded memory, line-oriented.
3. mmap: zero-copy, random access, SIGBUS risk on truncation,
   page-fault cost on non-resident pages.
4. Async I/O: io_uring on Linux, highest throughput, highest operational cost.

## Decision
<selected option>

## Consequences
- Benchmark plan: <workload, duration, metrics>
- Rollback: feature flag
- Review gate: <who signs off>
```

Maturity model for file-processing platforms. Level 1, scripts on laptops. Level 2, scheduled cron jobs on shared VMs. Level 3, orchestrated pipelines (Airflow, cron plus Make). Level 4, contract-driven platform with schemas, quotas, SLOs, per-tenant isolation. Level 5, managed platform with self-service onboarding, automated rollback, chaos tests, and SLO-driven alerts. Each pitfall in this chapter is harder to hit at higher levels because the platform enforces the guardrail. Scanner overflow is gone at level 4 because the platform rejects unbounded scanner configs. Atomic-write bugs are gone at level 5 because the platform's storage client is the only write path and it does atomic writes correctly. The strategic question for a staff engineer is not "how do we fix this pitfall" but "what level are we at and what is the path to the next level."

Deprecation playbook for homegrown tooling. Every mature org inherits a bespoke file-processing tool that embodies every pitfall in this chapter. The deprecation playbook is: (1) Inventory every call site, measure byte volume per day, and classify tenants by criticality. (2) Stand up the managed alternative in shadow mode, dual-write, checksum compare. (3) Cut over non-critical tenants, monitor for 30 days. (4) Cut over critical tenants with a rollback feature flag, monitor for 90 days. (5) Decommission, archive the code with a README that points to the replacement and documents the ADR. The 2026 canonical migration paths are Airflow to Dagster for orchestration, bespoke extractors to a sandboxed extractor service, cron plus bash to Temporal for workflow, and custom file watchers to managed CDC. The senior signal is the engineer who proposes the deprecation path without being asked.

Team onboarding and oncall rotation. A data platform team that owns ingest is staffed for 24x7 oncall. Onboarding an oncall engineer takes four weeks: shadow, mentored, solo low-tier, full rotation. Every page produces a runbook update. The platform's maturity is measured by the ratio of runbook-resolvable pages to thinking-required pages. Above 80 percent runbook-resolvable is level 4. Above 95 percent is level 5. Each pitfall in this chapter has a runbook entry: detection signal, mitigation steps, root-cause investigation, follow-up actions. The runbook is the artifact that turns "hard-won experience" into "scalable institutional memory," and the staff engineer's job is to keep it current.

Compression governance. Pitfall 6 (zip bombs) is one instance of a broader class: untrusted compressed input. The platform governance rule is that all compressed input flows through a sandboxed extractor service with declared limits on max uncompressed size, max ratio, max file count, max path depth, and reject-on-symlink. The service emits metrics per tenant. Archives that exceed any limit are quarantined with a notification, not silently rejected. This is the level 4 pattern. At level 5, the platform offers a "safe extract" API that every client calls, and direct use of `archive/zip` or `archive/tar` by application code is prohibited by lint rule.

Fsync discipline, codified. Pitfall 4 (non-atomic writes, missing parent-directory fsync) is the most common incident driver among the seven. Senior governance codifies the rule as: any write that is part of the "commit" contract must be followed by `Sync` on the file and `Sync` on the parent directory, and the code must be reviewed against this rule. At the platform level, the storage client is the only write path and it enforces the rule centrally. At lower levels of maturity, a linter flags direct use of `os.Create` followed by `Write` followed by `Close` without `Sync` as an error, not a warning. This is the single change that catches the largest class of production durability bugs.

---
