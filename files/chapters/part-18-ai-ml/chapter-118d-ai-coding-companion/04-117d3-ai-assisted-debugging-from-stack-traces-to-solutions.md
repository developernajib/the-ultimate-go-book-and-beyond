## 118D.3 AI-Assisted Debugging: From Stack Traces to Solutions

### Systematic Debugging with AI Assistance

Debugging is where AI provides some of its highest-value assistance, because debugging fundamentally requires two things: broad knowledge of failure patterns and systematic investigation. AI has the first in abundance. You provide the second.

The workflow is:

```
┌──────────────┐     ┌──────────────┐     ┌──────────────┐
│  Observe the │────►│ Feed context │ ────►│ AI provides │
│  symptom     │     │ to AI        │      │ hypotheses  │
└──────────────┘     └──────────────┘     └──────┬───────┘
                                                  │
┌──────────────┐     ┌──────────────┐            │
│  Fix and     │◄────│ You test the │◄───────────┘
│  verify      │     │ hypothesis   │
└──────────────┘     └──────────────┘
```

### Feeding Error Messages and Getting Root Cause Analysis

**Template: Error Analysis Prompt**

````
I'm getting this error in my Go application:

```
[paste the full error message and stack trace]
```

Relevant code:

```text
[paste the function where the error occurs]
```

Context:
- Go version: 1.27
- This happens [when/frequency]
- Recent changes: [what changed before this started]
- Environment: [prod/staging/local]

Please:
1. Identify the most likely root cause
2. Explain WHY this error occurs (not just what it means)
3. Suggest a fix with code
4. Identify if there are related issues I should check
````

### Debugging Concurrency Issues with AI

Concurrency bugs are where AI debugging shines brightest, because these bugs are notoriously hard to reproduce and reason about. AI can analyze goroutine dumps and identify patterns that humans miss in the noise.

**Template: Concurrency Bug Analysis Prompt**

````
I suspect a race condition in my Go code. Here's the goroutine dump
from `runtime.Stack()` (or SIGQUIT):

```
[paste goroutine dump]
```

The symptom is: [describe what's wrong: data corruption, deadlock, panic]

Here's the code that the goroutines are executing:

```text
[paste relevant code with concurrent access]
```

Please:
1. Identify which goroutines are contending
2. What shared state is being accessed unsafely
3. Is this a data race, deadlock, or livelock
4. Suggest the minimal fix (I don't want to restructure everything)
5. Would `go test -race` catch this? Why or why not?
````

### Example: A Full Debugging Session on a Production Goroutine Leak

Here is a realistic debugging session for a production goroutine leak.

```go
// The problematic code: a worker pool that leaks goroutines.
package worker

import (
	"context"
	"fmt"
	"sync"
	"time"
)

// Task represents work to be done.
type Task struct {
	ID      string
	Payload []byte
}

// Result holds the outcome of processing a task.
type Result struct {
	TaskID string
	Output []byte
	Err    error
}

// Pool manages a set of worker goroutines.
type Pool struct {
	tasks   chan Task
	results chan Result
	workers int
	wg      sync.WaitGroup
}

// NewPool creates a worker pool.
func NewPool(workers, queueSize int) *Pool {
	return &Pool{
		tasks:   make(chan Task, queueSize),
		results: make(chan Result, queueSize),
		workers: workers,
	}
}

// Start launches the worker goroutines.
func (p *Pool) Start(ctx context.Context) {
	for range p.workers {
		p.wg.Add(1)
		go func() {
			defer p.wg.Done()
			for task := range p.tasks {
				result := processTask(ctx, task)
				p.results <- result // BUG: blocks if nobody reads results
			}
		}()
	}
}

// Submit adds a task to the pool.
func (p *Pool) Submit(task Task) {
	p.tasks <- task
}

// Stop shuts down the pool.
func (p *Pool) Stop() {
	close(p.tasks)
	p.wg.Wait()
	close(p.results)
}

func processTask(_ context.Context, task Task) Result {
	// Simulate work.
	time.Sleep(10 * time.Millisecond)
	return Result{
		TaskID: task.ID,
		Output: []byte(fmt.Sprintf("processed: %s", task.ID)),
	}
}
```

**The debugging conversation:**

```
ENGINEER: My Go service's goroutine count keeps climbing. Started at
50, now at 12,000 after 6 hours. The pool is fixed-size: 8 workers.
Here's what the dump shows:

goroutine 8234 [chan send, 45 minutes]:
main.(*Handler).ServeHTTP(...)
    /app/api/handler.go:31
    pool.Submit(task)          // blocked: p.tasks <- task

... 11,987 more goroutines in [chan send] at handler.go:31

goroutine 19 [chan send, 5h58m]:
worker.(*Pool).Start.func1(...)
    /app/worker/pool.go:52
    p.results <- result        // blocked

... 7 more goroutines in [chan send] at pool.go:52

The worker pool processes HTTP webhook payloads. We submit tasks but
only read results for synchronous requests (about 30% of traffic).

AI: Root cause identified, and note that the dump tells the story in
two layers. The blocked workers are the cause; the 12,000 goroutines
are the downstream effect.

THE BUG:
Line 52: `p.results <- result`
Your workers write EVERY result to the results channel, but you only
read results for 30% of tasks. The other 70% are never consumed. Once
the results buffer fills, all 8 workers block on that send and stop
consuming p.tasks.

WHY THE COUNT REACHES 12,000:
Not from the workers. A fixed-size pool cannot leak workers: there are
exactly 8, and blocked or not, 8 is where it stays. That is worth
pausing on, because "goroutines blocked on p.results <- result" is the
line that looks guilty, and it can only ever account for 8 of them.

The growth is your callers. With no worker draining p.tasks, that
buffer fills too, and then every `pool.Submit(task)` blocks. Submit is
called from ServeHTTP, and the http server runs each request in its
own goroutine, so every incoming webhook now parks forever in Submit.
That is the unbounded set: one leaked goroutine per request, for as
long as traffic continues.

WHY IT TAKES 6 HOURS:
Both buffers must fill first. Until then the system looks healthy.
The service does not degrade gradually, it falls off a cliff once the
last slot goes, which is why this reads as "fine, fine, fine, outage".

THE FIX:
Option A (minimal change): Make result sending non-blocking with a
select:

    select {
    case p.results <- result:
    default:
        slog.Warn("result dropped, no consumer", "task_id", task.ID)
    }

Option B (better design): Only send results when someone is waiting:

    select {
    case p.results <- result:
    case <-ctx.Done():
        return
    }

Option C (best design): Use a callback pattern instead of a channel.
The results channel exists to hand values to a consumer that, 70% of
the time, does not exist. Deleting the channel deletes the bug class.

ENGINEER: Option C. Show me the callback design.
```

> **Read that diagnosis again, sceptically.** It is correct, but notice the specific way it could have been wrong. The obvious story ("workers block on the results send, blocked goroutines accumulate") is fluent, fits the stack trace, and is exactly what a model pattern-matching on "goroutine leak + blocked channel send" will produce. It is also arithmetically impossible: a fixed-size pool has a fixed number of workers, so those goroutines cannot be the 12,000. Catching that requires you to check the numbers against the architecture, which is a thing you have to *do*, not a thing the answer's tone will prompt you to do.
>
> This is the general shape of AI debugging failure, and it is worth naming: the diagnosis identifies a real problem, on the right line, that genuinely needs fixing, and still misidentifies the mechanism. Fix only the workers and the goroutine count keeps climbing, because you addressed the cause but not the thing that was actually accumulating. The habit that saves you is arithmetic: if a component is capped at 8, it cannot explain 12,000. Always ask which goroutines are *growing*, not just which ones are blocked.

**The fixed implementation:**

```go
package worker

import (
	"context"
	"log/slog"
	"sync"
)

// TaskFunc processes a task payload and returns a result.
type TaskFunc func(ctx context.Context, payload []byte) ([]byte, error)

// ResultCallback is invoked when a task completes.
// It is called from a worker goroutine, so implementations must be safe
// for concurrent use.
type ResultCallback func(taskID string, output []byte, err error)

// PoolConfig holds configuration for the worker pool.
type PoolConfig struct {
	Workers   int
	QueueSize int
	OnResult  ResultCallback // Optional: called when each task completes.
}

// Pool manages a set of worker goroutines with proper shutdown.
type Pool struct {
	tasks    chan taskEnvelope
	workers  int
	wg       sync.WaitGroup
	process  TaskFunc
	onResult ResultCallback
}

type taskEnvelope struct {
	id      string
	payload []byte
}

// NewPool creates a worker pool that processes tasks using the given function.
func NewPool(cfg PoolConfig, process TaskFunc) *Pool {
	onResult := cfg.OnResult
	if onResult == nil {
		onResult = func(string, []byte, error) {} // No-op default.
	}

	return &Pool{
		tasks:    make(chan taskEnvelope, cfg.QueueSize),
		workers:  cfg.Workers,
		process:  process,
		onResult: onResult,
	}
}

// Start launches worker goroutines. They stop when ctx is canceled
// or Stop is called.
func (p *Pool) Start(ctx context.Context) {
	for range p.workers {
		p.wg.Add(1)
		go p.worker(ctx)
	}
}

func (p *Pool) worker(ctx context.Context) {
	defer p.wg.Done()
	for {
		select {
		case task, ok := <-p.tasks:
			if !ok {
				return // Channel closed, pool is shutting down.
			}
			output, err := p.process(ctx, task.payload)
			p.onResult(task.id, output, err)

		case <-ctx.Done():
			slog.Info("worker stopping due to context cancellation")
			return
		}
	}
}

// Submit adds a task to the pool. It blocks if the queue is full.
// Returns an error if the context is canceled while waiting.
func (p *Pool) Submit(ctx context.Context, id string, payload []byte) error {
	select {
	case p.tasks <- taskEnvelope{id: id, payload: payload}:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

// Stop signals workers to finish and waits for them to complete.
func (p *Pool) Stop() {
	close(p.tasks)
	p.wg.Wait()
}

// SubmitAndWait submits a task and waits for its specific result.
// Use this for synchronous request/response patterns.
func (p *Pool) SubmitAndWait(ctx context.Context, id string, payload []byte) ([]byte, error) {
	type result struct {
		output []byte
		err    error
	}

	done := make(chan result, 1)

	// Temporarily wrap onResult to capture this specific task's result.
	originalCallback := p.onResult
	p.onResult = func(taskID string, output []byte, err error) {
		if taskID == id {
			done <- result{output, err}
		}
		originalCallback(taskID, output, err)
	}
	// Note: In production, use a concurrent map of pending results
	// instead of swapping the callback. This is simplified for clarity.

	if err := p.Submit(ctx, id, payload); err != nil {
		return nil, err
	}

	select {
	case r := <-done:
		return r.output, r.err
	case <-ctx.Done():
		return nil, ctx.Err()
	}
}
```

### Debugging Memory Leaks with AI-Guided pprof Analysis

**Template: Memory Leak Analysis Prompt**

````
My Go service's memory usage grows linearly over time. Here's the
pprof heap profile output:

```
[paste top 20 lines from `go tool pprof` top output]
```

And here's the allocation profile showing growth over the last hour:

```
[paste diff between two heap profiles]
```

The service handles [describe workload]. It processes approximately
[N] requests per [time unit].

Relevant code sections that allocate heavily:

```text
[paste suspected code]
```

Please:
1. Which allocations are growing and which are stable?
2. What's the likely leak: goroutine leak, cache without eviction,
   slice growth, or unclosed resources?
3. What pprof commands should I run next to narrow it down?
4. Suggest a fix if you can identify the root cause.
````

### Go Code: AI-Integrated Debug Helper Tool

A source-level debugger allows inspection of program state at any point of execution without modifying the source code. The commands below illustrate the essential workflow: setting breakpoints, stepping through code, inspecting variables, and reading backtraces to locate the source of a crash.

```go
package debughelper

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"runtime"
	"runtime/pprof"
	"strings"
	"time"
)

// DebugSnapshot captures the current state of a Go application for AI analysis.
type DebugSnapshot struct {
	Timestamp     time.Time         `json:"timestamp"`
	NumGoroutine  int               `json:"num_goroutine"`
	MemStats      MemStatsSnapshot  `json:"mem_stats"`
	GoroutineDump string            `json:"goroutine_dump"`
	TopAllocators []AllocatorInfo   `json:"top_allocators,omitempty"`
	Environment   map[string]string `json:"environment"`
}

// MemStatsSnapshot holds key memory statistics.
type MemStatsSnapshot struct {
	AllocMB      float64 `json:"alloc_mb"`
	TotalAllocMB float64 `json:"total_alloc_mb"`
	SysMB        float64 `json:"sys_mb"`
	NumGC        uint32  `json:"num_gc"`
	HeapObjects  uint64  `json:"heap_objects"`
	HeapInuseMB  float64 `json:"heap_inuse_mb"`
}

// AllocatorInfo identifies a source of allocations.
type AllocatorInfo struct {
	Function   string `json:"function"`
	File       string `json:"file"`
	Line       int    `json:"line"`
	AllocBytes int64  `json:"alloc_bytes"`
	AllocCount int64  `json:"alloc_count"`
}

// CaptureSnapshot gathers application state for debugging.
func CaptureSnapshot() *DebugSnapshot {
	var memStats runtime.MemStats
	runtime.ReadMemStats(&memStats)

	var goroutineBuf bytes.Buffer
	profile := pprof.Lookup("goroutine")
	if profile != nil {
		_ = profile.WriteTo(&goroutineBuf, 1)
	}

	return &DebugSnapshot{
		Timestamp:    time.Now(),
		NumGoroutine: runtime.NumGoroutine(),
		MemStats: MemStatsSnapshot{
			AllocMB:      float64(memStats.Alloc) / 1024 / 1024,
			TotalAllocMB: float64(memStats.TotalAlloc) / 1024 / 1024,
			SysMB:        float64(memStats.Sys) / 1024 / 1024,
			NumGC:        memStats.NumGC,
			HeapObjects:  memStats.HeapObjects,
			HeapInuseMB:  float64(memStats.HeapInuse) / 1024 / 1024,
		},
		GoroutineDump: goroutineBuf.String(),
		Environment: map[string]string{
			"go_version": runtime.Version(),
			"num_cpu":    fmt.Sprintf("%d", runtime.NumCPU()),
			"gomaxprocs": fmt.Sprintf("%d", runtime.GOMAXPROCS(0)),
		},
	}
}

// DebugAnalyzer sends debug snapshots to an AI for analysis.
type DebugAnalyzer struct {
	apiKey     string
	apiURL     string
	model      string
	httpClient *http.Client
}

// NewDebugAnalyzer creates an analyzer configured for Claude.
//
// The model is a parameter rather than a constant in the request body. Model
// IDs change on a scale of months, aliases are complete as written (never
// append a date suffix), and a dated snapshot compiled into a tool is a
// deprecation notice with a delay fuse. Pass the current model from config.
func NewDebugAnalyzer(apiKey, model string) *DebugAnalyzer {
	return &DebugAnalyzer{
		apiKey: apiKey,
		apiURL: "https://api.anthropic.com/v1/messages",
		model:  model,
		httpClient: &http.Client{
			Timeout: 60 * time.Second,
		},
	}
}

// Analyze sends a debug snapshot to AI and returns analysis.
func (d *DebugAnalyzer) Analyze(ctx context.Context, snapshot *DebugSnapshot, symptom string) (string, error) {
	prompt := buildDebugPrompt(snapshot, symptom)

	reqBody := map[string]any{
		"model":      d.model,
		"max_tokens": 4096,
		"messages": []map[string]string{
			{"role": "user", "content": prompt},
		},
	}

	body, err := json.Marshal(reqBody)
	if err != nil {
		return "", fmt.Errorf("marshal request: %w", err)
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, d.apiURL, bytes.NewReader(body))
	if err != nil {
		return "", fmt.Errorf("create request: %w", err)
	}

	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("x-api-key", d.apiKey)
	// "2023-06-01" is the Messages API version. It identifies the wire
	// contract, so it does not track the current year: a plausible-looking
	// date invented here gets the request rejected.
	req.Header.Set("anthropic-version", "2023-06-01")

	resp, err := d.httpClient.Do(req)
	if err != nil {
		return "", fmt.Errorf("API request: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("API returned status %d", resp.StatusCode)
	}

	var result struct {
		Content []struct {
			Text string `json:"text"`
		} `json:"content"`
	}

	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return "", fmt.Errorf("decode response: %w", err)
	}

	if len(result.Content) == 0 {
		return "", fmt.Errorf("empty response")
	}

	return result.Content[0].Text, nil
}

func buildDebugPrompt(snapshot *DebugSnapshot, symptom string) string {
	var sb strings.Builder

	sb.WriteString("You are debugging a Go application. Analyze this snapshot and identify the root cause.\n\n")
	sb.WriteString(fmt.Sprintf("SYMPTOM: %s\n\n", symptom))
	sb.WriteString(fmt.Sprintf("Go Version: %s\n", snapshot.Environment["go_version"]))
	sb.WriteString(fmt.Sprintf("CPUs: %s, GOMAXPROCS: %s\n\n", snapshot.Environment["num_cpu"], snapshot.Environment["gomaxprocs"]))
	sb.WriteString(fmt.Sprintf("Goroutines: %d\n", snapshot.NumGoroutine))
	sb.WriteString(fmt.Sprintf("Heap Alloc: %.2f MB\n", snapshot.MemStats.AllocMB))
	sb.WriteString(fmt.Sprintf("Heap In-Use: %.2f MB\n", snapshot.MemStats.HeapInuseMB))
	sb.WriteString(fmt.Sprintf("Sys Memory: %.2f MB\n", snapshot.MemStats.SysMB))
	sb.WriteString(fmt.Sprintf("Heap Objects: %d\n", snapshot.MemStats.HeapObjects))
	sb.WriteString(fmt.Sprintf("GC Cycles: %d\n\n", snapshot.MemStats.NumGC))

	// Truncate goroutine dump to first 100 goroutines for prompt size.
	dump := snapshot.GoroutineDump
	lines := strings.Split(dump, "\n")
	maxLines := min(len(lines), 500)
	sb.WriteString("GOROUTINE DUMP (first 500 lines):\n")
	sb.WriteString(strings.Join(lines[:maxLines], "\n"))

	sb.WriteString("\n\nProvide:\n")
	sb.WriteString("1. Root cause analysis\n")
	sb.WriteString("2. Which goroutines are problematic and why\n")
	sb.WriteString("3. Specific fix with code\n")
	sb.WriteString("4. Prevention strategy\n")

	return sb.String()
}

// RegisterDebugEndpoint adds an HTTP endpoint that captures a snapshot
// and sends it to AI for analysis. For development/staging use only.
func RegisterDebugEndpoint(mux *http.ServeMux, analyzer *DebugAnalyzer) {
	mux.HandleFunc("POST /debug/ai-analyze", func(w http.ResponseWriter, r *http.Request) {
		// Restrict to non-production environments.
		if os.Getenv("APP_ENV") == "production" {
			http.Error(w, "not available in production", http.StatusForbidden)
			return
		}

		symptom := r.URL.Query().Get("symptom")
		if symptom == "" {
			http.Error(w, "symptom query parameter required", http.StatusBadRequest)
			return
		}

		snapshot := CaptureSnapshot()

		analysis, err := analyzer.Analyze(r.Context(), snapshot, symptom)
		if err != nil {
			http.Error(w, fmt.Sprintf("analysis failed: %v", err), http.StatusInternalServerError)
			return
		}

		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{
			"snapshot": snapshot,
			"analysis": analysis,
		})
	})
}
```

> **What AI Gets Wrong**: AI often suggests the most common cause of a symptom, not the actual cause. If you report "high memory usage," AI will suggest goroutine leaks or unclosed HTTP bodies, the usual suspects. Give AI as much specific context as possible (goroutine counts, pprof output, recent code changes) to get past generic answers to your actual bug.

> **Pro Tip**: When debugging with AI, always ask "what else could cause this symptom?" after receiving the first hypothesis. AI's first answer is the most statistically likely cause, but production bugs are often the less likely ones, which is exactly why they are hard to find.

### Junior → FAANG: AI Debugging as Incident Response Accelerator

The systematic debugging workflow with AI (provide error, logs, and code path, ask for root cause, ask for alternative hypotheses) is the skill that accelerates incident response at FAANG where every minute of downtime has measurable business impact. Practice this workflow before being on-call by running it on past bugs you have already solved: describe the symptoms, provide the relevant context, and see whether AI's diagnosis matches what you found. When it does not match, understand why: did you provide too little context? Did the AI focus on the most common cause when the actual cause was less common? This practice builds intuition for which context elements are most important for specific bug categories.

The "ask for alternative hypotheses" pro tip is the most valuable debugging practice in this section. AI's first hypothesis is usually correct for common bugs but misses the less obvious causes that are often responsible for production incidents. After receiving the first hypothesis, always ask "what are five other possible causes of this symptom?" and evaluate each one against the available evidence. This systematic hypothesis generation prevents the debugging tunnel vision where the first plausible explanation is pursued exclusively until it is proven wrong.

For FAANG behavioral interviews about problem-solving and debugging, prepare a specific story where AI-assisted debugging identified a root cause faster than manual investigation would have. The best stories include: the specific context you provided to AI, the hypotheses AI generated, how you validated the correct hypothesis, and what you changed in your debugging process as a result of the experience.

### Senior @ FAANG: AI Debugging as Team Incident Response Capability

At senior level, AI-assisted debugging is a team capability that must be built before a major incident, not discovered during one. The debugging workflow, the context that produces the best diagnoses, and the "alternative hypotheses" follow-up are all practices that should be in the team's on-call runbook and incident response training. Running a fire drill that specifically practices AI-assisted debugging (simulate an incident, have the on-call engineer use AI to diagnose it, measure time to correct hypothesis) builds team muscle memory before real pressure.

The "most statistically likely cause" limitation of AI's first hypothesis has an important implication for FAANG on-call processes: when AI's first diagnosis does not match the evidence (the suggested fix does not resolve the issue), escalate quickly rather than continuing to follow AI's suggestions. Production incidents at FAANG have time pressure that makes debugging tunnel vision (following AI's suggestions long after they should have been abandoned) more costly than in development environments. Training on-call engineers to recognize when to override AI's diagnosis and apply their own domain knowledge is the human judgment component of AI-assisted incident response.

---
