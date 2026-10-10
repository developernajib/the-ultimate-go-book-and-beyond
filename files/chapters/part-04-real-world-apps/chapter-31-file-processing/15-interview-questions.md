## Interview Questions

### Question 1: How would you process a 100GB file that doesn't fit in memory?

**Answer:**

```go
// Strategy 1: Stream processing - never load entire file
func processLargeFile(path string) error {
    f, err := os.Open(path)
    if err != nil {
        return err
    }
    defer f.Close()

    reader := bufio.NewReaderSize(f, 64*1024) // 64KB buffer

    for {
        line, err := reader.ReadString('\n')
        if err == io.EOF {
            break
        }
        if err != nil {
            return err
        }

        // Process one line at a time
        processLine(line)
    }
    return nil
}

// Strategy 2: Memory-mapped files for random access
func randomAccessLargeFile(path string) error {
    f, err := os.Open(path)
    if err != nil {
        return err
    }
    defer f.Close()

    info, _ := f.Stat()
    data, err := syscall.Mmap(int(f.Fd()), 0, int(info.Size()),
        syscall.PROT_READ, syscall.MAP_SHARED)
    if err != nil {
        return err
    }
    defer syscall.Munmap(data)

    // Can now access any part of file as data[offset]
    // OS handles paging automatically
    return nil
}

// Strategy 3: Parallel chunked processing
func parallelProcess(path string, workers int) error {
    info, _ := os.Stat(path)
    chunkSize := info.Size() / int64(workers)

    var wg sync.WaitGroup
    errors := make(chan error, workers)

    for i := 0; i < workers; i++ {
        wg.Add(1)
        go func(workerID int) {
            defer wg.Done()

            start := int64(workerID) * chunkSize
            end := start + chunkSize
            if workerID == workers-1 {
                end = info.Size()
            }

            if err := processChunk(path, start, end); err != nil {
                errors <- err
            }
        }(i)
    }

    wg.Wait()
    close(errors)

    for err := range errors {
        return err // Return first error
    }
    return nil
}
```

**What FAANG expects:** Name three strategies (streaming, mmap for random access, parallel chunked), explain why `os.ReadFile` is the wrong tool here, and show you understand that `bufio.Scanner` has a 64KB token cap. Bonus points for mentioning `io.Copy` fast paths (`copy_file_range`/`sendfile`), backpressure when fan-out processing is slower than read, and that mmap degrades badly when the file exceeds physical RAM.

**Follow-ups:**
- What happens if one of your parallel chunks starts mid-record? (Answer: discard the partial head of each chunk except chunk 0, resync to the next delimiter, and the previous chunk owns the tail it consumed.)
- How would you checkpoint progress so a crash at 80GB can resume instead of restarting? (Answer: durable offset file, `fsync` after commit, idempotent record processing.)
- Why is `bufio.Scanner` risky for this problem? (Answer: `bufio.ErrTooLong` on any line above `MaxScanTokenSize`, silent truncation if you ignore the error.)

### Question 2: How do you implement atomic file writes?

**Answer:**

```go
// Atomic write ensures readers never see partial data
func AtomicWriteFile(path string, data []byte, perm os.FileMode) error {
    // 1. Write to temp file in same directory
    dir := filepath.Dir(path)
    tmp, err := os.CreateTemp(dir, ".tmp-*")
    if err != nil {
        return err
    }
    tmpPath := tmp.Name()

    // 2. Clean up on failure
    cleanup := func() { os.Remove(tmpPath) }
    defer func() {
        if err != nil {
            cleanup()
        }
    }()

    // 3. Write data
    if _, err = tmp.Write(data); err != nil {
        tmp.Close()
        return err
    }

    // 4. Set permissions
    if err = tmp.Chmod(perm); err != nil {
        tmp.Close()
        return err
    }

    // 5. Sync to disk (critical!)
    if err = tmp.Sync(); err != nil {
        tmp.Close()
        return err
    }

    if err = tmp.Close(); err != nil {
        return err
    }

    // 6. Atomic rename
    // On POSIX: rename is atomic if same filesystem
    // On Windows: uses MoveFileEx with MOVEFILE_REPLACE_EXISTING
    return os.Rename(tmpPath, path)
}
```

**What FAANG expects:** Write-to-temp-then-rename is table stakes. The hire signal is mentioning the three syncs: data `fsync`, rename, parent-directory `fsync`. Also expected: same filesystem requirement (cross-device rename is copy+delete, not atomic), Windows `MOVEFILE_REPLACE_EXISTING` semantics, and that cleanup on the error path must run regardless of where the function exits.

**Follow-ups:**
- Why is `os.Rename` across filesystems not atomic? (Answer: the kernel falls back to copy then unlink, which is observable mid-operation.)
- Where does data live immediately after a successful `os.Rename` on ext4 with default mount options? (Answer: page cache. Without directory fsync, a power loss in the next few seconds can roll back the rename.)
- How do you make the write durable against a concurrent reader opening the file mid-rename? (Answer: rename is atomic at the VFS layer on POSIX, an open `O_RDONLY` handle on the old inode keeps reading old data until closed, new opens see the new file.)

### Question 3: How do you handle CSV files with different encodings?

**Answer:**

```go
import (
    "golang.org/x/text/encoding"
    "golang.org/x/text/encoding/unicode"
    "golang.org/x/text/transform"
)

func DetectAndReadCSV(path string) ([][]string, error) {
    f, err := os.Open(path)
    if err != nil {
        return nil, err
    }
    defer f.Close()

    // Read first bytes to detect BOM/encoding
    bom := make([]byte, 4)
    n, _ := f.Read(bom)
    f.Seek(0, io.SeekStart) // Reset

    var decoder *encoding.Decoder
    var skipBOM int

    switch {
    case n >= 3 && bom[0] == 0xEF && bom[1] == 0xBB && bom[2] == 0xBF:
        // UTF-8 BOM
        decoder = unicode.UTF8BOM.NewDecoder()
        skipBOM = 3
    case n >= 2 && bom[0] == 0xFF && bom[1] == 0xFE:
        // UTF-16 LE BOM
        decoder = unicode.UTF16(unicode.LittleEndian, unicode.UseBOM).NewDecoder()
    case n >= 2 && bom[0] == 0xFE && bom[1] == 0xFF:
        // UTF-16 BE BOM
        decoder = unicode.UTF16(unicode.BigEndian, unicode.UseBOM).NewDecoder()
    default:
        // Assume UTF-8 without BOM
        decoder = nil
    }

    // Skip BOM if present
    if skipBOM > 0 {
        f.Seek(int64(skipBOM), io.SeekStart)
    }

    var reader io.Reader = f
    if decoder != nil {
        reader = transform.NewReader(f, decoder)
    }

    csvReader := csv.NewReader(reader)
    return csvReader.ReadAll()
}
```

**What FAANG expects:** BOM detection (UTF-8, UTF-16 LE/BE, rarely UTF-32), `golang.org/x/text/encoding` for decoding, and awareness that Excel's "CSV UTF-8" writes a BOM that `encoding/csv` does not strip. Candidates who answer "just read as UTF-8" fail: Japanese/Chinese/European enterprise exports routinely arrive as Shift-JIS, GB18030, or Windows-1252.

**Follow-ups:**
- A BOM-less UTF-16 file, how do you detect it? (Answer: heuristic on null-byte distribution in the first 4KB, or require an explicit encoding hint, BOM-less UTF-16 is ambiguous with Latin-1 by bytes alone.)
- What happens if you feed a Shift-JIS file directly to `encoding/csv`? (Answer: the comma splitter still works because 0x2C is ASCII-safe, but field contents are garbage, and any multibyte character containing 0x22 can fake a quote and desync the parser.)
- How do you stream-decode rather than buffer? (Answer: `transform.NewReader(f, decoder)` returns an `io.Reader` you can hand straight to `csv.NewReader`, no intermediate buffering.)

### Question 4: How do you implement file watching efficiently?

**Answer:**

```go
import "github.com/fsnotify/fsnotify"

type FileWatcher struct {
    watcher   *fsnotify.Watcher
    callbacks map[string]func(event fsnotify.Event)
    debounce  time.Duration
    mu        sync.RWMutex
}

func NewFileWatcher(debounce time.Duration) (*FileWatcher, error) {
    w, err := fsnotify.NewWatcher()
    if err != nil {
        return nil, err
    }

    return &FileWatcher{
        watcher:   w,
        callbacks: make(map[string]func(fsnotify.Event)),
        debounce:  debounce,
    }, nil
}

func (fw *FileWatcher) Watch(path string, callback func(fsnotify.Event)) error {
    fw.mu.Lock()
    fw.callbacks[path] = callback
    fw.mu.Unlock()

    return fw.watcher.Add(path)
}

func (fw *FileWatcher) Start(ctx context.Context) {
    // Debounce map to coalesce rapid events
    pending := make(map[string]time.Time)
    mu := sync.Mutex{}

    // Debounce processor
    go func() {
        ticker := time.NewTicker(fw.debounce / 2)
        defer ticker.Stop()

        for {
            select {
            case <-ctx.Done():
                return
            case <-ticker.C:
                mu.Lock()
                now := time.Now()
                for path, lastEvent := range pending {
                    if now.Sub(lastEvent) >= fw.debounce {
                        fw.mu.RLock()
                        if cb, ok := fw.callbacks[path]; ok {
                            go cb(fsnotify.Event{Name: path, Op: fsnotify.Write})
                        }
                        fw.mu.RUnlock()
                        delete(pending, path)
                    }
                }
                mu.Unlock()
            }
        }
    }()

    // Event handler
    for {
        select {
        case <-ctx.Done():
            fw.watcher.Close()
            return
        case event, ok := <-fw.watcher.Events:
            if !ok {
                return
            }

            // Debounce: record event time
            mu.Lock()
            pending[event.Name] = time.Now()
            mu.Unlock()

        case err, ok := <-fw.watcher.Errors:
            if !ok {
                return
            }
            log.Printf("watcher error: %v", err)
        }
    }
}
```

**What FAANG expects:** `fsnotify` over polling, debouncing rapid events (editors fire 3-5 events per save), handling non-Write ops because "save" is usually `Rename`/`Create`, not `Write`, and knowing the inotify `max_user_watches` limit is a production-killer on large trees. Bonus: awareness that fsnotify is not recursive and network filesystems don't deliver events at all.

**Follow-ups:**
- A user reports "the watcher stopped firing after 10 minutes", what do you check first? (Answer: the editor rename-on-save deleted the original inode, inotify watches are inode-based, so the watch silently became orphaned. Re-add after `Remove`/`Rename` events.)
- How would you watch a directory tree with 500,000 files on Linux? (Answer: don't. Raise `max_user_watches` as far as it goes, then fall back to a hybrid: watch top-level dirs + periodic scan of hot subtrees, or use `rjeczalik/notify` on macOS/Windows and a custom inotify driver on Linux.)
- Why is debouncing with a per-path timer map better than one global timer? (Answer: a global timer smears unrelated files together, high-churn path starves low-churn paths or vice versa. Per-path state is O(active paths) memory, which is fine.)

### Question 5: What's the difference between bufio.Reader and io.Reader?

**Answer:**

```go
// io.Reader is an interface - minimum requirement for reading
type Reader interface {
    Read(p []byte) (n int, err error)
}

// bufio.Reader wraps any io.Reader with buffering
// This is critical for performance!

func demonstrateDifference() {
    f, _ := os.Open("large_file.txt")
    defer f.Close()

    // Without buffering - each Read() is a syscall
    // Reading 1 byte at a time = 1 million syscalls for 1MB file!
    unbuffered := f
    buf := make([]byte, 1)
    for {
        _, err := unbuffered.Read(buf) // Syscall every time!
        if err == io.EOF {
            break
        }
    }

    // With buffering - reads 4KB at a time by default
    // 1MB file = ~256 syscalls instead of 1 million
    f.Seek(0, io.SeekStart)
    buffered := bufio.NewReader(f)
    for {
        _, err := buffered.ReadByte() // Usually from memory
        if err == io.EOF {
            break
        }
    }
}

// Key bufio.Reader features:
// - Peek(n) - look ahead without consuming
// - ReadString(delim) - read until delimiter
// - ReadLine() - read single line
// - ReadSlice(delim) - returns slice into buffer (zero-copy!)
// - UnreadByte() - "put back" a byte

func bufioFeatures() {
    reader := bufio.NewReader(strings.NewReader("hello\nworld"))

    // Peek without consuming
    peek, _ := reader.Peek(5)
    fmt.Println(string(peek)) // "hello"

    // Still reads "hello" because Peek didn't consume
    line, _ := reader.ReadString('\n')
    fmt.Println(line) // "hello\n"
}
```

**What FAANG expects:** `io.Reader` is an interface with one method, `Read(p []byte) (int, error)`. `bufio.Reader` is a concrete type that wraps an `io.Reader` and buffers reads to amortize syscall cost. The giveaway answer is knowing that `bufio.NewReader` defaults to a 4096-byte buffer, that `NewReaderSize` picks your own, and that `bufio.Reader` also implements `io.Reader` so it composes. Extra credit: `bufio.Reader` is not safe for concurrent use, and wrapping an already-buffered reader (like `*os.File` is not, but `*net.Conn` is often wrapped) adds nothing.

**Follow-ups:**
- When would wrapping in `bufio.Reader` make things slower? (Answer: when the source is already buffered or when reads are larger than the buffer, you pay a copy through the buffer for no win. Direct `io.Copy` with a 32KB-aligned buffer is often faster for bulk transfer.)
- How does `bufio.Scanner` relate to `bufio.Reader`? (Answer: Scanner is built on a Reader and adds token splitting via `SplitFunc`, with the 64KB `MaxScanTokenSize` cap that Reader does not have.)
- What is `ReadSlice` dangerous about? (Answer: the returned slice aliases the internal buffer, it is invalidated by the next `Read` call. Callers who hold onto it see their data overwritten. Use `ReadBytes` or copy the slice if you need to retain it.)

### Junior to FAANG: Prerequisites, worked examples, and interview entry points

Prerequisite gap check. Before the file-processing questions above land at FAANG difficulty, a candidate needs fluency in four adjacent areas. First, the `io` package interfaces: `Reader`, `Writer`, `Closer`, `Seeker`, `ReaderFrom`, `WriterTo`, and how `io.Copy` dispatches to the fastest one available. If you do not know that `io.Copy(dst, src)` calls `src.WriteTo(dst)` or `dst.ReadFrom(src)` when available and why that matters for `sendfile` on a `*os.File` to `*net.TCPConn` path, you will fail question 1's bonus. Second, the POSIX file lifecycle: inode versus path, how `rename` and `unlink` affect open handles, what `fsync` and `fdatasync` actually flush, what `O_DIRECT` and `O_DSYNC` change, and the `EINTR` retry rule. Third, encoding and text handling: the difference between byte length, rune count, and grapheme cluster count, and why `len(s)` is not "characters." Fourth, concurrency primitives: `sync.WaitGroup`, buffered channels for error fan-in, and `errgroup.Group` which is the idiomatic replacement for question 1's hand-rolled pattern.

Worked example for a first job interview. You are handed a 40 GB apache access log and asked to report the top 10 IPs by request count. A junior answer loads it into memory and sorts. A first-job FAANG answer streams with `bufio.Scanner` with a sized buffer, tokenizes each line, increments a `map[string]int`, and emits the top 10 at the end. A better answer notices the map can OOM on high-cardinality logs and swaps in a count-min sketch or a heavy-hitters algorithm. A FAANG answer adds: resumable via an offset checkpoint, parallel across chunks with a reconciliation step, and a flag for "assume log is gzip compressed" because prod logs always are. Each layer of improvement maps to a promotion level.

First-job context. On your first team, you will not be handed the 100 GB problem on day one. You will be handed a 200 MB CSV and told "make the import five times faster." The hidden game is recognizing that the bottleneck is almost never the disk, it is the encoding conversion, the regex per line, or the database round trip per row. The FAANG instinct is to profile first with `pprof` and `runtime/trace`, identify the actual hot path, and only then optimize. "I would benchmark before optimizing" is a sentence that signals seniority even from a new grad.

Interview entry-point framing. Each of the five questions above has a ladder of expected answers. Question 1 ladder: L3 streams with `bufio.Scanner`, L4 sizes the buffer and handles partial chunks at boundaries, L5 adds resumable checkpointing and discusses `copy_file_range`, L6 frames the problem as an ingest pipeline with SLOs and discusses backpressure and admission control. Question 2 ladder: L3 uses temp file plus rename, L4 adds `fsync` on the file, L5 adds `fsync` on the parent directory and discusses `EXDEV`, L6 discusses the durability contract across the whole system and how it composes with replication. Question 3 ladder: L3 reads as UTF-8, L4 handles UTF-8 BOM, L5 handles UTF-16 LE/BE plus Shift-JIS, L6 talks about the organizational problem of "why are we still accepting Shift-JIS" and proposes a deprecation path. Question 4 ladder: L3 uses fsnotify, L4 debounces, L5 knows about `max_user_watches` and rename-on-save, L6 discusses the architectural alternative of log-tailing or a managed change-data-capture service. Question 5 ladder: L3 describes buffering, L4 discusses syscall amortization, L5 discusses `ReadSlice` aliasing, L6 discusses when to skip `bufio` entirely in favor of direct `io.Copy` with aligned buffers.

The "why did this fail?" reflex for interviews. When the interviewer says "your code is reading from the file but the test keeps timing out," the junior reaches for `time.Sleep` or prints. The FAANG reflex asks: is `scanner.Err` being checked, is the buffer sized, is the file being closed, is `ctx` being propagated, is there a deadlock on the error channel? Say the five candidates out loud, then check each. Interviewers are looking for the checklist, not the fix.

### Senior @ FAANG: Interview signal ladders, calibration, and the bar itself

At staff plus, you are not the candidate, you are the interviewer and the calibrator. Your job is to translate a file-processing whiteboard question into a reliable signal about level. Below is the calibration guide I use.

Signal ladder, question by question. The ladder is not "did they get the right answer," it is "what depth of failure modes and trade-offs did they surface without prompting." The rubric below is what separates an L4 hire from an L5 hire in a 45 minute slot.

L3 signal: produces working code for the common case, asks clarifying questions about input format, names `bufio`. Hire for a new grad role, not for a senior-track role.

L4 signal: the L3 bar, plus handles error paths explicitly, sizes buffers with justification, recognizes the three canonical failure modes (OOM, partial write, resource leak), and reasons about one axis of trade-off (memory versus throughput). Hire for SDE II.

L5 signal: the L4 bar, plus frames the problem as a system with SLOs, names the durability contract, discusses two axes of trade-off (memory, throughput, durability, cost), recognizes at least one failure mode the interviewer did not seed (for example, notices that `filepath.Join` on Windows with a leading backslash is a path-traversal hole), and proposes an observability surface (what metrics, what SLIs). Hire for senior.

L6 signal: the L5 bar, plus treats the problem as an ambiguity to be scoped. What are the tenants? What is the isolation model? What is the cost-per-record budget? What is the deprecation plan if we build this and a managed alternative ships next quarter? Produces an ADR sketch on the board without being asked. Hire for staff.

L7 signal: the L6 bar, plus questions whether to solve the problem at all. "We are writing a file extractor because we accept uploaded archives from partners. The real question is whether we should accept archives. If we switched to a schema-validated streaming protocol, this entire class of bugs goes away." Hire for principal. This is the answer the interviewer remembers ten years later.

Calibration traps. Three traps consistently mis-calibrate candidates upward. First, the "clever trick" trap: a candidate who names `mmap` in question 1 is not automatically L5. Probe whether they know `SIGBUS` on truncation, whether they know the Go runtime does not integrate with `madvise` automatically, and whether they would actually ship it. L5 picks the boring answer unless the problem demands the clever one. Second, the "name-drop" trap: a candidate who says "io_uring" or "DPDK" without being able to reason about when it fits is L4 with a bigger vocabulary, not L5. Third, the "laundry list" trap: a candidate who recites all five failure modes in the first two minutes is often an L3 who memorized a prep document. Probe depth on one, not breadth across all.

Bar-raiser questions. For a staff plus hire, ask one of these. "Walk me through the rollout plan for replacing our hand-rolled CSV importer with a platform service. What is the migration strategy, the risk budget, and the success criteria?" Or: "We have a file-processing pipeline at 99.9 percent durability and we need 99.99. Walk me through the architectural options and their costs." Or: "Describe an incident you led involving file corruption. Not what broke, but what you changed in the review process so a different instance of the same class cannot happen again."

ADR template for the interview loop itself. When a team consistently mis-hires on file-processing questions, write an ADR.

```
# ADR-NNN: Calibration for File-Processing Interview Loop

## Context
- Observed mis-hire rate: X percent of L5 offers underperform at the 6-month mark
- Current rubric: ad hoc per interviewer
- Root cause: no shared signal ladder, reward for "clever" over "boring"

## Decision
Adopt the L3 through L7 ladder defined above. Require two signals per level
before advancing a candidate. Calibrate quarterly against on-the-job outcomes.

## Consequences
- Interview training session required for all loop members
- Rubric rolled out in hiring tools as structured scorecard
- Re-calibration at six months using performance data of hires
```

Oncall rotation and onboarding for data platforms. When you own the file-processing platform that the interview question is really asking about, the team has to be staffed for 24x7 oncall with a meaningful runbook. Onboarding a new oncall engineer takes four weeks minimum. Week one, shadow an existing oncall on every page. Week two, own pages with a mentor on call. Week three, solo on a low-tier rotation. Week four, full rotation. Every page produces a runbook update. The platform's maturity is measured by the ratio of "runbook-resolvable" pages to "needs an engineer to think" pages. Above 80 percent runbook-resolvable is level 4, above 95 percent is level 5. This is the operational dimension that an L6 interview answer must acknowledge and an L7 answer must plan for.

Deprecation of homegrown tooling. Every senior on a data platform team has inherited a bespoke file-processing tool that predates the managed alternative. The deprecation playbook: (1) inventory every call site, (2) write a compatibility shim that the new platform honors, (3) dual-write and compare checksums for 30 days, (4) flip reads to the new system behind a feature flag, (5) decommission the old system only after 90 days of clean metrics. The 2026 pattern is Airflow to Dagster for orchestration, bespoke tar extractors to the platform's sandboxed extractor service, and custom file watchers to managed CDC (Debezium or the cloud-native equivalent). The interview answer that names this migration pattern and its risks is the answer that hires at staff.

---
