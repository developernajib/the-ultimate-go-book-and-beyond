## Exercises with Complete Solutions

### Exercise 1: Build a Log Analyzer

Create a log analyzer that processes Apache/Nginx access logs and generates statistics.

**Complete Solution:**

```go
// internal/loganalyzer/analyzer.go
package loganalyzer

import (
	"bufio"
	"context"
	"fmt"
	"io"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

// LogEntry represents a parsed log line
type LogEntry struct {
	IP        string
	Timestamp time.Time
	Method    string
	Path      string
	Status    int
	Size      int64
	UserAgent string
	Referer   string
}

// Stats holds aggregated statistics
type Stats struct {
	TotalRequests    int64
	TotalBytes       int64
	UniqueIPs        int
	StatusCodes      map[int]int64
	TopPaths         []PathCount
	TopIPs           []IPCount
	RequestsPerHour  map[int]int64
	ErrorRate        float64
	AvgResponseSize  float64
}

type PathCount struct {
	Path  string
	Count int64
}

type IPCount struct {
	IP    string
	Count int64
}

// Analyzer processes log files
type Analyzer struct {
	workers    int
	pattern    *regexp.Regexp
	mu         sync.Mutex
	entries    []LogEntry
	ipCounts   map[string]int64
	pathCounts map[string]int64
	statusCounts map[int]int64
	hourCounts map[int]int64
	totalBytes int64
}

func NewAnalyzer(workers int) *Analyzer {
	// Common log format regex
	pattern := regexp.MustCompile(
		`^(\S+)\s+\S+\s+\S+\s+\[([^\]]+)\]\s+"(\S+)\s+(\S+)[^"]*"\s+(\d+)\s+(\d+)`,
	)

	return &Analyzer{
		workers:      workers,
		pattern:      pattern,
		ipCounts:     make(map[string]int64),
		pathCounts:   make(map[string]int64),
		statusCounts: make(map[int]int64),
		hourCounts:   make(map[int]int64),
	}
}

func (a *Analyzer) Analyze(ctx context.Context, reader io.Reader) (*Stats, error) {
	lines := make(chan string, a.workers*100)

	// Start workers
	var wg sync.WaitGroup
	for i := 0; i < a.workers; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			a.worker(ctx, lines)
		}()
	}

	// Read and distribute lines
	scanner := bufio.NewScanner(reader)
	buf := make([]byte, 0, 64*1024)
	scanner.Buffer(buf, 1024*1024)

	for scanner.Scan() {
		select {
		case lines <- scanner.Text():
		case <-ctx.Done():
			close(lines)
			return nil, ctx.Err()
		}
	}
	close(lines)

	if err := scanner.Err(); err != nil {
		return nil, err
	}

	wg.Wait()

	return a.computeStats(), nil
}

func (a *Analyzer) worker(ctx context.Context, lines <-chan string) {
	localIPs := make(map[string]int64)
	localPaths := make(map[string]int64)
	localStatus := make(map[int]int64)
	localHours := make(map[int]int64)
	var localBytes int64

	for line := range lines {
		select {
		case <-ctx.Done():
			return
		default:
		}

		entry, err := a.parseLine(line)
		if err != nil {
			continue
		}

		localIPs[entry.IP]++
		localPaths[entry.Path]++
		localStatus[entry.Status]++
		localHours[entry.Timestamp.Hour()]++
		localBytes += entry.Size
	}

	// Merge into global state
	a.mu.Lock()
	for ip, count := range localIPs {
		a.ipCounts[ip] += count
	}
	for path, count := range localPaths {
		a.pathCounts[path] += count
	}
	for status, count := range localStatus {
		a.statusCounts[status] += count
	}
	for hour, count := range localHours {
		a.hourCounts[hour] += count
	}
	a.totalBytes += localBytes
	a.mu.Unlock()
}

func (a *Analyzer) parseLine(line string) (*LogEntry, error) {
	matches := a.pattern.FindStringSubmatch(line)
	if len(matches) < 7 {
		return nil, fmt.Errorf("parse error")
	}

	timestamp, _ := time.Parse("02/Jan/2006:15:04:05 -0700", matches[2])
	status, _ := strconv.Atoi(matches[5])
	size, _ := strconv.ParseInt(matches[6], 10, 64)

	return &LogEntry{
		IP:        matches[1],
		Timestamp: timestamp,
		Method:    matches[3],
		Path:      matches[4],
		Status:    status,
		Size:      size,
	}, nil
}

func (a *Analyzer) computeStats() *Stats {
	stats := &Stats{
		StatusCodes:     make(map[int]int64),
		RequestsPerHour: make(map[int]int64),
	}

	// Copy status codes
	for status, count := range a.statusCounts {
		stats.StatusCodes[status] = count
		stats.TotalRequests += count
	}

	// Copy hour counts
	for hour, count := range a.hourCounts {
		stats.RequestsPerHour[hour] = count
	}

	// Unique IPs
	stats.UniqueIPs = len(a.ipCounts)

	// Total bytes
	stats.TotalBytes = a.totalBytes

	// Average response size
	if stats.TotalRequests > 0 {
		stats.AvgResponseSize = float64(stats.TotalBytes) / float64(stats.TotalRequests)
	}

	// Error rate (4xx + 5xx)
	var errors int64
	for status, count := range stats.StatusCodes {
		if status >= 400 {
			errors += count
		}
	}
	if stats.TotalRequests > 0 {
		stats.ErrorRate = float64(errors) / float64(stats.TotalRequests) * 100
	}

	// Top paths
	stats.TopPaths = a.topN(a.pathCounts, 10)

	// Top IPs
	ipCounts := make([]IPCount, 0, len(a.ipCounts))
	for ip, count := range a.ipCounts {
		ipCounts = append(ipCounts, IPCount{IP: ip, Count: count})
	}
	sort.Slice(ipCounts, func(i, j int) bool {
		return ipCounts[i].Count > ipCounts[j].Count
	})
	if len(ipCounts) > 10 {
		ipCounts = ipCounts[:10]
	}
	stats.TopIPs = ipCounts

	return stats
}

func (a *Analyzer) topN(counts map[string]int64, n int) []PathCount {
	result := make([]PathCount, 0, len(counts))
	for path, count := range counts {
		result = append(result, PathCount{Path: path, Count: count})
	}
	sort.Slice(result, func(i, j int) bool {
		return result[i].Count > result[j].Count
	})
	if len(result) > n {
		result = result[:n]
	}
	return result
}

func (s *Stats) String() string {
	var sb strings.Builder

	sb.WriteString(fmt.Sprintf("Total Requests: %d\n", s.TotalRequests))
	sb.WriteString(fmt.Sprintf("Total Bytes: %d (%.2f MB)\n", s.TotalBytes, float64(s.TotalBytes)/1024/1024))
	sb.WriteString(fmt.Sprintf("Unique IPs: %d\n", s.UniqueIPs))
	sb.WriteString(fmt.Sprintf("Average Response Size: %.2f bytes\n", s.AvgResponseSize))
	sb.WriteString(fmt.Sprintf("Error Rate: %.2f%%\n\n", s.ErrorRate))

	sb.WriteString("Status Code Distribution:\n")
	for status, count := range s.StatusCodes {
		sb.WriteString(fmt.Sprintf("  %d: %d (%.2f%%)\n", status, count,
			float64(count)/float64(s.TotalRequests)*100))
	}

	sb.WriteString("\nTop 10 Paths:\n")
	for i, p := range s.TopPaths {
		sb.WriteString(fmt.Sprintf("  %d. %s: %d requests\n", i+1, p.Path, p.Count))
	}

	sb.WriteString("\nTop 10 IPs:\n")
	for i, ip := range s.TopIPs {
		sb.WriteString(fmt.Sprintf("  %d. %s: %d requests\n", i+1, ip.IP, ip.Count))
	}

	return sb.String()
}
```

### Exercise 2: Build a File Synchronizer

Create a directory synchronization utility that keeps two directories in sync.

**Complete Solution:**

```go
// internal/filesync/sync.go
package filesync

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"sync"
	"time"
)

type SyncMode int

const (
	SyncModeOneWay SyncMode = iota  // Source -> Dest only
	SyncModeTwoWay                   // Bidirectional
	SyncModeMirror                   // Make dest exact copy (delete extra)
)

type FileInfo struct {
	Path     string
	Size     int64
	ModTime  time.Time
	Hash     string
	IsDir    bool
}

type SyncResult struct {
	Copied   []string
	Deleted  []string
	Errors   []SyncError
	Duration time.Duration
}

type SyncError struct {
	Path  string
	Error error
}

type Syncer struct {
	source      string
	dest        string
	mode        SyncMode
	workers     int
	dryRun      bool
	useHash     bool
	excludes    []string
	logger      *slog.Logger
}

type SyncOption func(*Syncer)

func WithWorkers(n int) SyncOption {
	return func(s *Syncer) { s.workers = n }
}

func WithDryRun(dryRun bool) SyncOption {
	return func(s *Syncer) { s.dryRun = dryRun }
}

func WithHashCompare(useHash bool) SyncOption {
	return func(s *Syncer) { s.useHash = useHash }
}

func WithExcludes(patterns []string) SyncOption {
	return func(s *Syncer) { s.excludes = patterns }
}

func WithLogger(logger *slog.Logger) SyncOption {
	return func(s *Syncer) { s.logger = logger }
}

func NewSyncer(source, dest string, mode SyncMode, opts ...SyncOption) *Syncer {
	s := &Syncer{
		source:  source,
		dest:    dest,
		mode:    mode,
		workers: 4,
		logger:  slog.Default(),
	}

	for _, opt := range opts {
		opt(s)
	}

	return s
}

func (s *Syncer) Sync(ctx context.Context) (*SyncResult, error) {
	start := time.Now()
	result := &SyncResult{}

	// Scan source
	sourceFiles, err := s.scanDirectory(s.source)
	if err != nil {
		return nil, fmt.Errorf("scan source: %w", err)
	}

	// Scan destination
	destFiles, err := s.scanDirectory(s.dest)
	if err != nil {
		return nil, fmt.Errorf("scan dest: %w", err)
	}

	// Build maps for quick lookup
	destMap := make(map[string]FileInfo)
	for _, f := range destFiles {
		relPath, _ := filepath.Rel(s.dest, f.Path)
		destMap[relPath] = f
	}

	// Find files to copy
	var toCopy []string
	for _, srcFile := range sourceFiles {
		relPath, _ := filepath.Rel(s.source, srcFile.Path)

		if s.isExcluded(relPath) {
			continue
		}

		destFile, exists := destMap[relPath]

		needsCopy := false
		if !exists {
			needsCopy = true
		} else if s.useHash {
			needsCopy = srcFile.Hash != destFile.Hash
		} else {
			needsCopy = srcFile.ModTime.After(destFile.ModTime) ||
				srcFile.Size != destFile.Size
		}

		if needsCopy {
			toCopy = append(toCopy, relPath)
		}
	}

	// Find files to delete (mirror mode only)
	var toDelete []string
	if s.mode == SyncModeMirror {
		sourceMap := make(map[string]bool)
		for _, f := range sourceFiles {
			relPath, _ := filepath.Rel(s.source, f.Path)
			sourceMap[relPath] = true
		}

		for relPath := range destMap {
			if !sourceMap[relPath] && !s.isExcluded(relPath) {
				toDelete = append(toDelete, relPath)
			}
		}
	}

	// Execute sync
	copyErrors := s.copyFiles(ctx, toCopy)
	deleteErrors := s.deleteFiles(ctx, toDelete)

	result.Copied = toCopy
	result.Deleted = toDelete
	result.Errors = append(copyErrors, deleteErrors...)
	result.Duration = time.Since(start)

	return result, nil
}

func (s *Syncer) scanDirectory(root string) ([]FileInfo, error) {
	var files []FileInfo
	var mu sync.Mutex

	err := filepath.WalkDir(root, func(path string, d os.DirEntry, err error) error {
		if err != nil {
			return err
		}

		if d.IsDir() {
			return nil
		}

		info, err := d.Info()
		if err != nil {
			return err
		}

		fileInfo := FileInfo{
			Path:    path,
			Size:    info.Size(),
			ModTime: info.ModTime(),
		}

		if s.useHash {
			hash, err := hashFile(path)
			if err != nil {
				return err
			}
			fileInfo.Hash = hash
		}

		mu.Lock()
		files = append(files, fileInfo)
		mu.Unlock()

		return nil
	})

	return files, err
}

func (s *Syncer) copyFiles(ctx context.Context, files []string) []SyncError {
	if len(files) == 0 {
		return nil
	}

	var errors []SyncError
	var mu sync.Mutex
	var wg sync.WaitGroup

	sem := make(chan struct{}, s.workers)

	for _, relPath := range files {
		wg.Add(1)
		go func(relPath string) {
			defer wg.Done()

			select {
			case sem <- struct{}{}:
				defer func() { <-sem }()
			case <-ctx.Done():
				return
			}

			srcPath := filepath.Join(s.source, relPath)
			destPath := filepath.Join(s.dest, relPath)

			if s.dryRun {
				s.logger.Info("would copy", "from", srcPath, "to", destPath)
				return
			}

			if err := copyFile(srcPath, destPath); err != nil {
				mu.Lock()
				errors = append(errors, SyncError{Path: relPath, Error: err})
				mu.Unlock()
			}
		}(relPath)
	}

	wg.Wait()
	return errors
}

func (s *Syncer) deleteFiles(ctx context.Context, files []string) []SyncError {
	if len(files) == 0 {
		return nil
	}

	var errors []SyncError

	for _, relPath := range files {
		select {
		case <-ctx.Done():
			return errors
		default:
		}

		destPath := filepath.Join(s.dest, relPath)

		if s.dryRun {
			s.logger.Info("would delete", "path", destPath)
			continue
		}

		if err := os.Remove(destPath); err != nil {
			errors = append(errors, SyncError{Path: relPath, Error: err})
		}
	}

	return errors
}

func (s *Syncer) isExcluded(path string) bool {
	for _, pattern := range s.excludes {
		if matched, _ := filepath.Match(pattern, filepath.Base(path)); matched {
			return true
		}
	}
	return false
}

func copyFile(src, dst string) error {
	// Create destination directory
	if err := os.MkdirAll(filepath.Dir(dst), 0755); err != nil {
		return err
	}

	srcFile, err := os.Open(src)
	if err != nil {
		return err
	}
	defer srcFile.Close()

	srcInfo, err := srcFile.Stat()
	if err != nil {
		return err
	}

	// Write to temp file first
	dstFile, err := os.CreateTemp(filepath.Dir(dst), ".sync-*")
	if err != nil {
		return err
	}
	tmpPath := dstFile.Name()

	defer func() {
		if err != nil {
			os.Remove(tmpPath)
		}
	}()

	if _, err = io.Copy(dstFile, srcFile); err != nil {
		dstFile.Close()
		return err
	}

	if err = dstFile.Chmod(srcInfo.Mode()); err != nil {
		dstFile.Close()
		return err
	}

	if err = dstFile.Sync(); err != nil {
		dstFile.Close()
		return err
	}

	if err = dstFile.Close(); err != nil {
		return err
	}

	// Atomic rename
	if err = os.Rename(tmpPath, dst); err != nil {
		return err
	}

	// Preserve modification time
	return os.Chtimes(dst, srcInfo.ModTime(), srcInfo.ModTime())
}

func hashFile(path string) (string, error) {
	f, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer f.Close()

	h := sha256.New()
	if _, err := io.Copy(h, f); err != nil {
		return "", err
	}

	return hex.EncodeToString(h.Sum(nil)), nil
}
```

### Junior to FAANG: Stretching these exercises into first-job material

The two exercises above are at an L3 to low-L4 difficulty. To stretch them to the FAANG first-job bar, add the following extensions and work them through on your own before looking at a reference answer. For Exercise 1, the log analyzer, add a resumable mode. The analyzer must write a durable offset checkpoint every 100,000 lines, and on restart it must skip lines it has already processed. The checkpoint file uses the atomic write pattern from chapter 14. Measure memory residency with `runtime.ReadMemStats` before and after and confirm the unique-IP map is not growing unboundedly. When it is, swap the exact count for a probabilistic HyperLogLog. This single extension moves the exercise from "parses logs" to "operates as a production ingest."

For Exercise 2, the file synchronizer, add three extensions in order. First, replace the "scan both sides, diff in memory" pattern with a streaming diff that never holds both file lists in memory at once. Sort both directory walks and do a merge comparison. Second, add a conflict-resolution policy object that the caller injects. In two-way mode, newer-wins, larger-wins, and prompt-user are three valid policies and the code must not hardcode one. This is Open-Closed and Dependency Inversion applied to a concrete problem. Third, add a rate limiter on the copy loop so a sync does not saturate the disk or the network, and wire it to a context-aware backpressure signal so pausing propagates cleanly.

Worked example: the "why did this fail?" reflex applied to Exercise 2. Run the synchronizer in two-way mode against a directory where one side is on an SMB mount with clock skew of 30 seconds. What happens? The `ModTime` comparison flips on every sync, each side thinks the other is newer, and you get a perpetual copy loop. The FAANG fix: use content hash when the `ModTime` delta is under a tolerance threshold, log a warning when clock skew is detected, and add a metric. This is the kind of failure mode that never appears in unit tests but owns your oncall for a year if you miss it.

Interview entry point. When asked to design a file synchronizer in an interview, the opening question is not "how do I compare files" but "what is the consistency model?" Rsync is eventually consistent with last-writer-wins. Dropbox is eventually consistent with conflict files. Git is append-only with merge. Name your model before you write code. This is the move that changes the conversation from a coding question into a design question, and most interviewers raise the level of the slot when you make it.

Prerequisite gaps these exercises reveal. If Exercise 1's parallel worker pool confuses you, revisit the concurrency chapter: goroutines, channels, `sync.WaitGroup`, bounded work queues. If Exercise 2's atomic rename inside a loop surprises you, revisit the common-mistakes chapter on `defer` in loops. If the hash-based comparison feels magical, revisit the hashing primer: why SHA-256 over MD5 (collision resistance matters even for sync because adversarial inputs exist), and when BLAKE3 or xxhash are faster and still good enough (for non-adversarial change detection, xxhash is 10 times faster and fine).

### Senior @ FAANG: Exercises as assessment artifacts and platform forcing functions

Staff plus engineers use exercises like these not as homework but as calibration fixtures for their teams. Below is how I run these two exercises as a senior.

Exercise 1 as a platform forcing function. Take the log analyzer and ask, "what is missing for this to ship in our platform?" The answer is a staff-level list. (1) Schema contract: the regex is a private bilateral coupling to the log producer. Replace with a versioned schema (protobuf or Avro) and require producers to emit structured logs. (2) Input backpressure: the `lines` channel with capacity `workers*100` is a 2000-line burst absorber. Under a 10x input spike this stalls the scanner and blocks the upstream reader. Replace with a bounded-ring plus drop-oldest policy and a dropped-lines counter. (3) Multi-tenant isolation: the analyzer is a single-tenant tool. In a platform, every worker must be budgeted against a per-tenant CPU and memory quota. (4) Observability: the tool prints stats at the end. Platform-grade means per-tenant Prometheus counters, traces spanning ingest, histograms for line-parse latency, and a dashboard that answers "is tenant X being rate-limited right now." (5) SLO: the tool has no SLO. Platform means "95 percent of lines are queryable within 5 minutes" and "99.9 percent durability" with alerts tied to SLI burn rate.

Exercise 2 as an ADR forcing function. Take the synchronizer and write the ADR for whether to build versus buy.

```
# ADR-NNN: File Synchronization Strategy

## Context
- 50 TB of data across 200 partner sites needs replication to a central lake
- Partners range from enterprise NFS to consumer DSL
- Existing homegrown rsync wrappers have 12 oncall pages per month

## Options
1. Extend the homegrown synchronizer (Exercise 2 pattern)
2. Adopt rclone as a managed binary
3. Adopt a managed replication service (AWS DataSync, GCS Transfer Service)
4. Build on top of a change-data-capture primitive (Debezium, Fivetran)

## Decision Matrix
| Criterion              | Homegrown | rclone | Managed | CDC |
| Upfront cost           |   Med     |  Low   |   Low   | High|
| Per-month oncall cost  |   High    |  Med   |   Low   | Low |
| Feature flexibility    |   High    |  Med   |   Low   | Med |
| Vendor lock-in         |   None    |  None  |  Heavy  | Med |
| Auditability           |   Custom  |  Logs  | Service |Audit|

## Decision
Adopt rclone for tier-2 partners, managed service for tier-1,
deprecate homegrown within 12 months.

## Rollout Playbook
- Phase 1 (weeks 1-4): shadow-mode on 5 pilot partners, compare checksums
- Phase 2 (weeks 5-12): cut over tier-2 partners, monitor oncall volume
- Phase 3 (weeks 13-24): tier-1 to managed, homegrown code-frozen
- Phase 4 (weeks 25-52): decommission, code archived with tombstone README

## Consequences
- Oncall volume target: under 2 pages per month by week 24
- Cost target: 30 percent reduction on transfer infrastructure
- Risk: managed service outage, mitigated by dual-pipe for tier-1 first 90 days
```

Staff-level review checklist for exercises like these. When a PR adds a file-processing utility similar to Exercise 1 or 2, the checklist is: (1) Is there a schema contract or is the format bilateral? (2) Is there an SLO on throughput, latency, and correctness? (3) Does the atomic-write pattern include parent-directory fsync? (4) Are worker pools bounded and are their queues back-pressure aware? (5) Is resource lifecycle clean when context is canceled mid-flight? (6) Is there a checkpoint and is it resumable? (7) Is there a dry-run mode (Exercise 2 has it, Exercise 1 should) and is it tested? (8) Are errors classified into transient versus permanent, and does the retry policy respect the classification? (9) Is there a per-tenant quota and a global circuit breaker? (10) Is there a deprecation story for when the managed alternative arrives?

Incident postmortem mapped to these exercises. The GitLab January 2017 data loss incident is effectively Exercise 2 gone wrong. The operator on-call ran `rm -rf` against the wrong replica, the backup scripts had been failing silently for months (no SLO monitoring), and the recovery took 18 hours because the dry-run mode had never been exercised. Every element of the incident maps to a missing item on the checklist above. When interviewing an L6 candidate, ask them to architect a synchronizer that would have prevented it. The signal is whether they reach for the dry-run, the checkpoint, the quarantine, the audit log, and the SLO alert without prompting.

SLO framing for ingest pipelines built on these exercises. An L6 design of the log analyzer defines four SLOs: time-to-availability (p95 lag from log emission to queryable less than 5 minutes), data-freshness (p99 under 15 minutes), durability (99.99 percent of lines persisted on the first try, 99.999 percent after retry), and correctness (parse success rate above 99.9 percent on producer-conformant input). Each SLO has an SLI, each SLI has a burn-rate alert, each alert has a runbook, each runbook has a test. The exercise as written has none of these. The interview gold is the candidate who points out the gap and proposes a minimal set, not the one who adds five more features.

Team onboarding flow using these exercises. On a data platform team, week one of onboarding is "implement Exercise 1 locally, run it against a 100 MB sample log, compare output to the platform's canonical analyzer." Week two is "extend it to resumable, measure the checkpoint cost." Week three is "port the synchronizer to use the platform's storage client with per-tenant quota." Week four is "first oncall shadow." Engineers who cannot produce a working Exercise 1 by end of week one have a prerequisite gap that blocks oncall, and the exercise surfaces it before a page does. This is what it means to use an exercise as an assessment artifact rather than a homework assignment.

---
