## 30.4 Cron-Style Scheduling

> **Use `robfig/cron/v3` in real code.** The hand-rolled parser below is here to teach how cron expressions are evaluated. In production, `github.com/robfig/cron/v3` is the de-facto standard: it supports the standard five-field format, optional seconds-precision mode, descriptors like `@hourly` and `@every 30s`, and crucially it lets you bind a schedule to a specific `*time.Location` so you do not get bitten by DST transitions or server-vs-user time-zone drift. It also exposes `cron.WithChain()` for middleware such as `cron.SkipIfStillRunning` and `cron.Recover`, which address two of the three common cron bugs (overlapping runs, panicking jobs). The third, duplicate runs across replicas, still needs a distributed lock (section 30.7).

### Cron Parser

The cron parser converts a standard five-field cron expression (minute, hour, day-of-month, month, day-of-week) into a `CronExpr` struct that can test whether a given timestamp matches. It supports wildcards (`*`), ranges (`1-5`), comma-separated lists (`1,3,5`), and step values (`*/15`). The `Next` method iterates forward minute-by-minute from a start time until it finds the first matching timestamp, bounded by a one-year lookahead to prevent infinite loops on impossible expressions.

```go
package scheduler

import (
    "fmt"
    "strconv"
    "strings"
    "time"
)

type CronExpr struct {
    minute     []int
    hour       []int
    dayOfMonth []int
    month      []int
    dayOfWeek  []int
}

func ParseCron(expr string) (*CronExpr, error) {
    parts := strings.Fields(expr)
    if len(parts) != 5 {
        return nil, fmt.Errorf("invalid cron expression: expected 5 parts")
    }

    cron := &CronExpr{}
    var err error

    cron.minute, err = parseField(parts[0], 0, 59)
    if err != nil {
        return nil, fmt.Errorf("minute: %w", err)
    }

    cron.hour, err = parseField(parts[1], 0, 23)
    if err != nil {
        return nil, fmt.Errorf("hour: %w", err)
    }

    cron.dayOfMonth, err = parseField(parts[2], 1, 31)
    if err != nil {
        return nil, fmt.Errorf("day of month: %w", err)
    }

    cron.month, err = parseField(parts[3], 1, 12)
    if err != nil {
        return nil, fmt.Errorf("month: %w", err)
    }

    cron.dayOfWeek, err = parseField(parts[4], 0, 6)
    if err != nil {
        return nil, fmt.Errorf("day of week: %w", err)
    }

    return cron, nil
}

func parseField(field string, min, max int) ([]int, error) {
    if field == "*" {
        result := make([]int, max-min+1)
        for i := range result {
            result[i] = min + i
        }
        return result, nil
    }

    var result []int
    for _, part := range strings.Split(field, ",") {
        if strings.Contains(part, "-") {
            bounds := strings.Split(part, "-")
            start, _ := strconv.Atoi(bounds[0])
            end, _ := strconv.Atoi(bounds[1])
            for i := start; i <= end; i++ {
                result = append(result, i)
            }
        } else if strings.Contains(part, "/") {
            parts := strings.Split(part, "/")
            step, _ := strconv.Atoi(parts[1])
            for i := min; i <= max; i += step {
                result = append(result, i)
            }
        } else {
            val, _ := strconv.Atoi(part)
            result = append(result, val)
        }
    }

    return result, nil
}

func (c *CronExpr) Next(from time.Time) time.Time {
    t := from.Add(time.Minute).Truncate(time.Minute)

    for i := 0; i < 366*24*60; i++ { // Max 1 year lookahead
        if c.matches(t) {
            return t
        }
        t = t.Add(time.Minute)
    }

    return time.Time{}
}

func (c *CronExpr) matches(t time.Time) bool {
    return contains(c.minute, t.Minute()) &&
        contains(c.hour, t.Hour()) &&
        contains(c.dayOfMonth, t.Day()) &&
        contains(c.month, int(t.Month())) &&
        contains(c.dayOfWeek, int(t.Weekday()))
}

func contains(slice []int, val int) bool {
    for _, v := range slice {
        if v == val {
            return true
        }
    }
    return false
}
```

### Scheduler

The `Scheduler` struct maintains a list of registered jobs and ticks once per minute to check which cron expressions match the current time. Matching jobs run in their own goroutines so that a slow job does not block the scheduler loop or delay other jobs. The mutex protects the job list during registration and iteration, allowing jobs to be added dynamically at runtime.

```go
package scheduler

import (
    "context"
    "log/slog"
    "sync"
    "time"
)

type Job struct {
    Name     string
    Schedule *CronExpr
    Handler  func(ctx context.Context) error
}

type Scheduler struct {
    jobs    []*Job
    logger  *slog.Logger
    mu      sync.Mutex
    running bool
}

func NewScheduler(logger *slog.Logger) *Scheduler {
    return &Scheduler{
        jobs:   make([]*Job, 0),
        logger: logger,
    }
}

func (s *Scheduler) AddJob(name, cronExpr string, handler func(ctx context.Context) error) error {
    schedule, err := ParseCron(cronExpr)
    if err != nil {
        return err
    }

    s.mu.Lock()
    s.jobs = append(s.jobs, &Job{
        Name:     name,
        Schedule: schedule,
        Handler:  handler,
    })
    s.mu.Unlock()

    return nil
}

func (s *Scheduler) Start(ctx context.Context) {
    s.mu.Lock()
    if s.running {
        s.mu.Unlock()
        return
    }
    s.running = true
    s.mu.Unlock()

    s.logger.Info("scheduler started", "jobs", len(s.jobs))

    ticker := time.NewTicker(time.Minute)
    defer ticker.Stop()

    // Run immediately for any due jobs
    s.checkJobs(ctx)

    for {
        select {
        case <-ctx.Done():
            s.logger.Info("scheduler stopped")
            return
        case <-ticker.C:
            s.checkJobs(ctx)
        }
    }
}

func (s *Scheduler) checkJobs(ctx context.Context) {
    now := time.Now().Truncate(time.Minute)

    s.mu.Lock()
    jobs := make([]*Job, len(s.jobs))
    copy(jobs, s.jobs)
    s.mu.Unlock()

    for _, job := range jobs {
        if job.Schedule.matches(now) {
            go s.runJob(ctx, job)
        }
    }
}

func (s *Scheduler) runJob(ctx context.Context, job *Job) {
    s.logger.Info("running job", "name", job.Name)
    start := time.Now()

    if err := job.Handler(ctx); err != nil {
        s.logger.Error("job failed",
            "name", job.Name,
            "error", err,
            "duration", time.Since(start),
        )
    } else {
        s.logger.Info("job completed",
            "name", job.Name,
            "duration", time.Since(start),
        )
    }
}
```

### Junior to FAANG: cron has three bugs you will ship

1. **N replicas means N executions.** Deploy the scheduler as 3 pods for HA and your 9am report runs 3 times. Fix with a distributed lock per `(job_name, fire_time)`. SET NX PX in Redis works for opportunistic dedup. etcd or a DB advisory lock for correctness dedup. The typical error is a junior engineer putting the scheduler inside the main app deployment and only discovering the duplicate at month-end when three duplicate invoices go out.

2. **Time zone bugs.** `time.Now()` in Go returns local time, which in a container is usually UTC. Cron expressions meaning "9am Pacific" must be parsed against a specific `time.Location`. DST transitions make "2:30 am" ambiguous twice a year. `robfig/cron/v3` handles this. Hand-rolled parsers almost never do.

3. **Overlapping runs.** If a job runs longer than its interval, the next tick fires a second instance. The `go s.runJob` above does exactly this. `cron.SkipIfStillRunning` in `robfig/cron/v3` prevents it. Alternatively, take a per-job mutex.

Other issues in the snippet. Parser ignores errors (silent `strconv.Atoi` failures). Parser does not support `@hourly`, `@daily`, or second-precision. `matches` ORs day-of-month and day-of-week incorrectly (standard cron ORs them, this snippet ANDs them).

Worked example of a bug report. "Sunday report never fires." Vixie cron accepts both `0` and `7` for Sunday, so a user copies `0 9 * * 7` from a system crontab. Go's `time.Weekday()` only ever returns 0 through 6 (0 is Sunday), so the parsed value `7` matches no real timestamp and the job silently never runs. A robust parser normalizes `7` to `0`. Hand-rolled ones usually forget, and users who learned Sunday=7 from system cron are surprised. `robfig/cron/v3` documents a consistent 0-6 (Sunday=0) convention so there is one rule to remember.

Interview entry point. "Design a distributed cron system for a company with 100 services that each need scheduled jobs." Expected topics. Leader election, persistent schedule store, deduplication per fire time, observability per schedule (last-run, next-run, missed-runs), timezone handling, backfill, manual trigger, pause.

### Senior at FAANG: cron as a company-wide platform service

At FAANG, cron is a centralized platform service because every team has tens of schedules and running them in each service's pods is unreliable. Google's internal cron is documented in the SRE Book chapter "Distributed Periodic Scheduling". The lessons:

**Correctness over convenience.** Cron must provide at-most-once or at-least-once semantics per `(schedule, fire_time)`. At Google, Cron uses Paxos to elect a leader that fires schedules and persists the decision to replicated storage before notifying the datacenter. If a fire_time was fired, it cannot fire again. If it was not fired (leader crash), the replacement leader catches up from the log and fires any missed times up to a configurable window (typically "skip if older than 1 interval").

**Schedule registry.** Schedules are not in code. They are in a registry (database or config service) with metadata. Owner team, alert contact, criticality tier, retry policy, maximum runtime, timezone, allowed skew. Changes go through code review and are observable to on-call.

**Leader election.** For 10 to 100 schedules, a single leader elected via etcd lease is sufficient. For 10k+ schedules, shard schedules by hash of name across N leaders. Each leader owns one shard. Rebalance on leader change. This is Kubernetes controller-manager pattern.

**Backfill and manual trigger.** Humans need to say "re-run yesterday's 9am run" after a downstream fix. The platform must expose manual trigger with audit log, and a backfill tool that fires all missed schedules in a range. Stripe's scheduled-job UI does this. It requires the fire decision to be idempotent keyed on `(schedule, fire_time)`, which is the same idempotency key used for dedup.

**Timezone as a policy decision.** Different teams want different policies. Finance wants America/New_York for reporting runs. Engineering wants UTC for consistency. The platform supports both by storing the explicit location with each schedule and warning on schedules that hit DST ambiguous windows.

**Missed-run alerting.** If a schedule fails to fire because the scheduler was down, the platform detects missed runs by comparing `last_run` to `expected_last_run` and alerts. Without this, outages hide because "it did not run" is invisible.

**Distributed lock anti-patterns.** A common junior mistake is Redlock for cron dedup. Redlock is safe under Antirez's assumptions (no big clock drift, no long GC pauses). Both assumptions fail on occasion in a Kubernetes environment. Use etcd or Postgres advisory locks for correctness-critical cron dedup. Use Redis SET NX PX only when the handler is idempotent and the cost of a duplicate is acceptable.

**Long-running cron jobs.** A weekly nightly batch that runs 6 hours is not a cron job. It is a workflow. Model it in Temporal or Cadence with checkpoints, not in cron. Cron should trigger the workflow, and the workflow engine handles duration, retries, and state. Conflating the two is how teams end up with 6-hour cron jobs that restart from scratch on leader failover.

**Capacity and fanout.** When 100 schedules fire at 9am, you have a thundering herd on downstream services. The platform adds per-schedule jitter (e.g. `+0 to +5 minutes`) and offers a "fan out over N minutes" option. Google's cron has this. Home-rolled cron usually does not.

**ADR template for cron rollout.** A realistic ADR includes semantics (at-most-once), storage (etcd), leader election (etcd lease with 5s TTL), fire precision (1 minute default, 1 second optional), max missed window (1 interval), observability (last_run, next_run, missed_total, run_duration_p99 per schedule), timezone policy (explicit location required), and on-call rotation for the cron service itself.

**Staff-level risk assessment.** Cron is deceptively low-traffic and therefore deceptively underinvested. When it breaks, the symptoms are "my report did not arrive" and they surface hours after the failure. Invest in alerting before scale. The rule is, for every schedule, there is a downstream alert that fires if the expected output is missing. The cron system's own alerts are secondary.

---
