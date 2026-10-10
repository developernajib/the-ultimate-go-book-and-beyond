## 26.12 Interview Questions

### Question 1: Design a Feature Flag System for 100M Daily Users

**What FAANG expects:** A system-design answer that separates control plane (flag management, low QPS) from data plane (flag evaluation, 10M+ QPS). Candidates must default to local in-process evaluation with background refresh, not per-request network calls. Mentioning CDN-cached flag snapshots, delta updates, and eventual consistency with a strong-consistency escape hatch for kill switches signals senior-level thinking.

**Answer:**
Key architectural decisions for scale:

```
1. Local Evaluation (No Network Latency)
   - SDK fetches all flags on startup
   - Evaluates locally with cached rules
   - Background sync every 30 seconds

2. Efficient Distribution
   - CDN edge caching for flag definitions
   - Bloom filters for flag existence checks
   - Delta updates (only changed flags)

3. Storage Design
   - PostgreSQL for flag definitions (source of truth)
   - Redis for hot flag cache
   - S3 for flag snapshots (disaster recovery)

4. Analytics Pipeline
   - Batch impressions locally (1000 events or 10 seconds)
   - Kafka for streaming to data warehouse
   - Sampling for very high-traffic flags

5. Consistency Model
   - Eventually consistent (acceptable for most flags)
   - Strong consistency option for kill switches
```

```go
// Example: High-performance evaluation
type HighPerformanceSDK struct {
    flags     atomic.Value // map[string]*CompiledFlag
    evaluator *FastEvaluator
}

// CompiledFlag pre-computes for fast evaluation
type CompiledFlag struct {
    Key           string
    DefaultBucket int // Pre-computed default bucket threshold
    Rules         []CompiledRule
}

// Evaluate with minimal allocations
func (s *HighPerformanceSDK) IsEnabled(key string, userBucket int) bool {
    flags := s.flags.Load().(map[string]*CompiledFlag)
    flag, ok := flags[key]
    if !ok {
        return false
    }

    // Fast path: just compare buckets
    return userBucket < flag.DefaultBucket
}
```

**Follow-ups:**
- "What happens when the flag service is unreachable at startup?" Serve a last-known-good snapshot from disk. If there is no snapshot at all, every flag resolves to its compiled-in default, which must always be the currently-shipping behavior. Avoid the phrases "fail open" and "fail closed" here unless you define them, since they invert depending on whether you mean "traffic flows" or "feature is on". State the behavior instead: unknown flag state means the old code path runs.
- "How do you keep SDKs consistent across a polyglot stack?" Use OpenFeature (CNCF) so Go, Java, and Node services share the same evaluation semantics and flag definition format.
- "What is your p99 evaluation budget?" Sub-10 microseconds, which rules out any lock-based read path. Use `atomic.Value` snapshots.

### Question 2: How Would You Implement Safe Kill Switches?

**What FAANG expects:** Kill switches are a reliability tool, not a product feature. Candidates must recognize that kill switches (a) need their own evaluation path that bypasses targeting rules, (b) must propagate in seconds not minutes, (c) need a local override channel that works when the network is partitioned, and (d) must be testable in chaos/DR drills. The strong signal is stating the read path budget out loud and defending it: checking a kill switch must cost a snapshot read, never a network call, because the switch is queried most heavily during the incident that degraded the flag service.

**Answer:**
Kill switches must remain functional even when the flag service itself is down, propagate within seconds, and be triggerable without a deployment. The solution uses multiple redundant sources with local overrides as the highest-priority fallback:

```go
// Kill switch requirements:
// 1. Works even if flag service is down
// 2. Propagates within seconds
// 3. Can be triggered without deployment
// 4. NEVER does I/O on the read path

type KillSwitchManager struct {
    // Local override, checked first. Set via signal handler or env var so an
    // operator can kill a feature on one instance with no network at all.
    localOverrides sync.Map // map[string]bool

    // Multiple sources for redundancy.
    sources []KillSwitchSource

    // Last-known-good snapshot, refreshed by the poller. Reads are lock-free.
    snapshot atomic.Pointer[map[string]bool]

    pollInterval time.Duration // 5s: kill switches poll far harder than flags
    logger       *slog.Logger
}

// Source interface for kill switch state
type KillSwitchSource interface {
    GetKillSwitches(ctx context.Context) (map[string]bool, error)
}

// IsKilled checks if a feature is killed. No I/O, no locks, no allocation.
func (m *KillSwitchManager) IsKilled(key string) bool {
    // 1. Local override wins over everything, including the network.
    if v, ok := m.localOverrides.Load(key); ok {
        if killed, ok := v.(bool); ok {
            return killed
        }
    }

    // 2. Otherwise read the last-known-good snapshot.
    if snap := m.snapshot.Load(); snap != nil {
        return (*snap)[key]
    }

    // 3. Nothing loaded yet (cold start, flag service unreachable). Default to
    //    NOT killed: a config outage must not disable the product. See below.
    return false
}

// Run refreshes the snapshot until ctx is cancelled. This is the ONLY code
// that touches the network.
func (m *KillSwitchManager) Run(ctx context.Context) {
    ticker := time.NewTicker(m.pollInterval)
    defer ticker.Stop()

    m.refresh(ctx)
    for {
        select {
        case <-ctx.Done():
            return
        case <-ticker.C:
            m.refresh(ctx)
        }
    }
}

// refresh takes the first source that answers. On total failure it leaves the
// previous snapshot in place: stale kill state beats no kill state.
func (m *KillSwitchManager) refresh(ctx context.Context) {
    for _, source := range m.sources {
        fetchCtx, cancel := context.WithTimeout(ctx, 1*time.Second)
        kills, err := source.GetKillSwitches(fetchCtx)
        cancel()
        if err != nil {
            continue
        }
        m.snapshot.Store(&kills)
        return
    }
    m.logger.Error("all kill switch sources failed, serving last known state")
}

// LocalKill immediately kills a feature on this instance.
func (m *KillSwitchManager) LocalKill(key string) {
    m.localOverrides.Store(key, true)
    m.logger.Error("local kill switch engaged", "key", key)
}
```

Three things an interviewer is listening for here, and the original version of this answer got all three wrong:

**No I/O on the read path.** The tempting version calls `source.GetKillSwitches(ctx)` inside `IsKilled` with a one-second timeout. That puts a network round trip, and up to `1s × len(sources)` of latency, on every request that checks the switch. Worse, it is at its slowest exactly during the incident when the flag service is degraded and you are relying on the kill switch to save you. A kill switch that adds a second of latency per request *is* the outage. Poll in the background, read from an `atomic.Pointer` snapshot, and keep the read path at a few nanoseconds.

**"Fail open" and "fail closed" are ambiguous for kill switches, so say what you mean.** The phrase "kill switches fail open to killed" is self-contradictory and will cost you the question. Be concrete: when the switch's state is *unknown* (cold start, no snapshot, every source down), this code reports "not killed", meaning the feature stays on. That is deliberate. The alternative, defaulting to killed, means a flag service outage silently disables every guarded feature across the fleet, converting a config-plane problem into a total product outage. The state you must never lose is a kill that *was* already issued, and the last-known-good snapshot plus an on-disk cache is what protects that.

**The `pollInterval` field must actually be read by something.** In the original it was declared, commented `// 5 seconds`, and never used by any code, because the fetch happened inline. A struct field that no code reads is a design document, not an implementation, and the gap between the two is where this question is won or lost.

**Follow-ups:**
- "How do you test kill switches without an incident?" Game-day exercises: trigger a kill in staging under load, measure propagation p99, verify downstream services observe the kill within SLA.
- "What if the kill switch itself has a bug?" Deploy the kill-switch evaluator as a separate binary from the flag system so a bad flag-service deploy cannot disable the kill path. Pin the kill-switch config to a separate, restricted storage path with stricter change controls.

### Question 3: Explain Percentage Rollout Consistency

**What FAANG expects:** Candidates must articulate why `rand.Float64()` per request is wrong (users flicker between variants, experiment contamination, poor UX) and derive consistent hashing from first principles: `bucket = hash(user_id + ":" + flag_key) % 100`. The flag key in the hash input is critical, without it, a user in bucket 42 would be in bucket 42 for every flag, correlating rollouts.

**Answer:**
Users must consistently see the same variation:

```go
// Consistent hashing ensures:
// 1. Same user always gets same bucket (deterministic)
// 2. When percentage increases, only new users are added
// 3. When percentage decreases, users are removed from end

func calculateBucket(userID, salt string) int {
    // Use cryptographic hash for uniform distribution
    h := sha256.New()
    h.Write([]byte(userID + ":" + salt))
    hash := h.Sum(nil)

    // Convert to bucket 0-99
    // Use modulo for uniform distribution
    n := binary.BigEndian.Uint32(hash[:4])
    return int(n % 100)
}

// Example: User "alice" with flag "new-checkout"
// bucket = hash("alice:new-checkout") % 100 = 42
//
// At 10%: buckets 0-9 enabled → alice NOT enabled
// At 50%: buckets 0-49 enabled → alice ENABLED
// At 30%: buckets 0-29 enabled → alice NOT enabled
//
// Alice always has bucket 42, so her state is predictable
```

**Follow-ups:**
- "Why SHA-256 instead of FNV-1a?" FNV is fine for uniform bucketing and is 5x faster, but for flags that gate sensitive features, a cryptographic hash with a server-side salt prevents users from inverting the hash to predict their bucket.
- "What if you need more than 100 buckets?" Use `binary.BigEndian.Uint64(hash[:8]) % bucketCount`. 100 buckets gives 1% granularity, 10000 buckets gives 0.01%, useful for very slow rollouts at scale.
- "How do you handle anonymous users?" Fall back to a session ID or device ID, never to random. If no stable ID exists, bucket by IP or country and document that these users may see a different variant per session.

### Question 4: How Do You Handle Flag Dependencies?

**What FAANG expects:** Recognition that dependency graphs must be cycle-checked at flag-creation time, that evaluation must short-circuit on the first failed prerequisite, and that mutual exclusion is enforced in the flag system, not scattered through application code. Senior candidates flag the risk of dependency depth (cascading evaluations amplify latency).

**Answer:**
Flag dependencies arise when enabling feature B only makes sense if feature A is already active, or when two flags must never be enabled simultaneously (mutual exclusion). A dependency resolver checks prerequisites and exclusion lists before evaluating the target flag itself:

```go
type DependencyResolver struct {
    flagService *FlagService
}

// EvaluateWithDependencies evaluates a flag considering dependencies.
func (r *DependencyResolver) EvaluateWithDependencies(
    ctx context.Context,
    key string,
    userCtx *UserContext,
) (bool, error) {
    flag, err := r.flagService.Get(key)
    if err != nil {
        return false, err
    }

    // Check prerequisites
    for _, prereq := range flag.Prerequisites {
        prereqResult := r.flagService.Evaluate(prereq.FlagKey, userCtx)
        if prereqResult.Variation != prereq.RequiredVariation {
            return false, nil // Prerequisite not met
        }
    }

    // Check mutual exclusion (only one can be enabled)
    for _, exclusiveKey := range flag.MutuallyExclusive {
        if r.flagService.IsEnabled(exclusiveKey, userCtx) {
            return false, nil
        }
    }

    return r.flagService.IsEnabled(key, userCtx), nil
}
```

**Follow-ups:**
- "How do you prevent cycles?" Topological sort at flag save time. Reject any save that introduces a cycle with HTTP 409.
- "What is the performance cost of dependencies?" Each prerequisite is an extra evaluation. Cap depth at 3 and log a warning if violated. Measure p99 with dependencies engaged, not just the naive case.

### Question 5: Design an A/B Testing Framework

**What FAANG expects:** Sticky assignment, separation of eligibility from variant selection, and explicit exposure tracking. Candidates who treat A/B tests as "just a flag with variants" miss the statistical rigor: assignment must be persisted (or deterministically rederivable), exposure must be logged at the point of actual user impact (not at evaluation time), and SRM (sample ratio mismatch) checks must run on the analytics pipeline.

**Answer:**
An A/B testing framework must guarantee sticky assignments (the same user always sees the same variant), separate traffic allocation from variant selection, and track exposure events for downstream statistical analysis. The `GetVariant` method first checks for an existing persisted assignment before computing a new one, ensuring consistency across sessions:

```go
type ABTestFramework struct {
    experiments  map[string]*Experiment
    assignments  AssignmentStore // Persists user assignments
    analytics    AnalyticsService
}

// GetVariant returns the variant for a user.
func (f *ABTestFramework) GetVariant(
    experimentKey string,
    userID string,
) (*Variant, error) {
    // 1. Check for existing assignment (sticky)
    existing, err := f.assignments.Get(experimentKey, userID)
    if err == nil && existing != nil {
        return existing, nil
    }

    // 2. Check experiment eligibility
    exp := f.experiments[experimentKey]
    if exp == nil || exp.Status != Running {
        return nil, nil
    }

    // 3. Check traffic allocation
    if !f.isInTraffic(userID, exp) {
        return nil, nil
    }

    // 4. Assign variant
    variant := f.assignVariant(userID, exp)

    // 5. Persist assignment
    f.assignments.Set(experimentKey, userID, variant)

    // 6. Track exposure
    f.analytics.TrackExposure(experimentKey, userID, variant.Key)

    return variant, nil
}

// Key principles:
// - Sticky assignments (user always sees same variant)
// - Random but deterministic allocation
// - Separation of traffic allocation and variant assignment
// - Exposure tracking for accurate analysis
```

**Follow-ups:**
- "How do you detect a broken experiment?" SRM guardrails (expected 50/50 but observed 48/52 at p<0.001 means something is filtering users unevenly), plus kill-switch integration that auto-disables an experiment if a key business metric regresses beyond a threshold.
- "When would you NOT use A/B tests?" For hotfixes, security patches, and infrastructure migrations where there is no product hypothesis, a progressive rollout is cheaper and faster than a full experiment.

### Question 6: What's the Difference Between a Feature Flag and a Configuration Value?

**What FAANG expects:** Candidates must articulate that both are runtime-tunable inputs, but their lifecycle, blast radius, and audit requirements differ. Feature flags are typed (usually boolean or string variant), targeted per user/cohort, and short-lived. Configuration values are typed broadly (numbers, strings, URLs), global per environment, and long-lived. Treating them identically leads to bloat (flags used for config) or risk (config values changed without an audit trail that a flag system provides).

**Answer:**

| Dimension | Feature Flag | Configuration |
|-----------|--------------|---------------|
| **Lifetime** | Days to months (rollout), permanent (ops/entitlement) | Lifetime of the service |
| **Targeting** | Per user, cohort, region, percentage | Global per environment |
| **Type** | Boolean or small enum of variants | Any type: timeouts, URLs, limits |
| **Audit** | Every change logged with who/when/why, rollback in one click | Version-controlled (GitOps) or in a config service with change history |
| **Blast radius** | Scoped by targeting rules | Affects the whole service or fleet |
| **Example** | `new_checkout_flow` at 25% for US users | `database.max_connections = 50` |

Rule of thumb: if the value changes per user or cohort, it is a flag. If it changes per environment but is identical for all users within that environment, it is config. Using a flag system for static config wastes evaluation budget. Using config for per-user behavior forces redeployment.

**Follow-ups:**
- "Where does a rate limit belong?" Config if uniform, flag if tiered by plan. Tiered rate limits are a targeting problem, which is what flag systems solve.
- "Should feature flags live in the same store as config?" Often not. Flags need an evaluation engine and an analytics tap. Config needs a validation layer and a reload mechanism. Separate stores make failure domains independent.

### Question 7: Canary Deployment via Feature Flags vs Traffic Splitting at the Load Balancer

**What FAANG expects:** Both are valid, and the right answer depends on what you are changing. Candidates must distinguish a "deploy canary" (new binary, routed by LB or service mesh) from a "feature canary" (same binary, new code path gated by a flag). Strong answers cover when each wins and when to use both together.

**Answer:**

**LB/mesh traffic split (Istio, Linkerd, ALB weighted targets):**
- Good for: infra changes (new Go version, library upgrade), full-stack changes (new service wiring), database driver changes.
- Rolls back by shifting weight. Fast but coarse, either you are on the new binary or not.
- Cannot target by user attribute (unless the mesh supports header-based routing).

**Feature flag:**
- Good for: product changes, UX changes, algorithm swaps, anything below the process boundary.
- Rolls back without redeploy. Fine-grained: 1% of premium users in US only.
- Cannot gate infra changes (the new library is either linked into the binary or it isn't).

**Combined (FAANG default):**
1. Deploy new binary to 5% of fleet via LB weights.
2. Inside that binary, the new code path is gated by a flag at 0%.
3. Verify health metrics on the canary fleet.
4. Ramp the flag: 1%, 10%, 50%, 100% of users on the canary fleet.
5. If green, ramp LB weight to 100%. If red, flip the flag to 0% (instant rollback without a redeploy).

**Follow-ups:**
- "Which gives faster rollback?" Flag. LB weight shifts require a deploy-pipeline action. Flag flips propagate to all instances in seconds via the flag SDK.
- "Why not just use flags for everything?" You cannot flag-gate a change to the Go runtime, a TLS library, or a database driver, those are compiled in.

### Question 8: How Do You Prevent Feature Flag Sprawl?

**What FAANG expects:** A concrete program, not wishful thinking. Candidates must name the mechanisms: creation-time metadata, automated staleness detection, build-time enforcement, and a deletion workflow that removes flag plus code together.

**Answer:**

1. **Tag at creation**: every flag carries `type` (rollout/experiment/ops/permission), `owner` (team handle), `created_at`, `expected_lifetime` (typically 30, 90 days for rollouts), and `permanent` (bool, defaults false).
2. **Staleness detector**: a daily job queries for flags at 0% or 100% for longer than `expected_lifetime`. Results go to a dashboard and a Slack channel owned by the flag's team.
3. **Build-time lint**: a custom linter reads the flag registry and fails CI if the codebase references an archived flag key. This forces deletion PRs to land before the flag disappears.
4. **Deletion workflow**: a single PR removes the flag definition and the dead branch of the conditional. Reviewers reject PRs that archive a flag without cleaning up the code.
5. **Quarterly audit**: per-team report of flag count, oldest flag, ratio of permanent vs temporary. Surfacing this metric in engineering reviews changes behavior.

**Follow-ups:**
- "What if a flag has been at 100% for a year but the team is afraid to remove it?" That fear is a signal the rollout was never validated. Add observability, confirm the old path has zero traffic in production for 30 days, then delete.
- "How do you handle flags owned by teams that no longer exist?" Reassign ownership during team reorgs as a checklist item. Orphaned flags become platform-team debt and get aggressively pruned.

### Question 9: Secrets Rotation With Zero Downtime

**What FAANG expects:** The canonical answer is dual-credential rotation, not "restart everything." Candidates must articulate that rotation has three phases (new credential issued alongside old, workloads picked up new, old credential revoked) and that the rotation window is governed by the slowest consumer.

**Answer:**

```
Phase 1: Issue new credential. Both old and new are valid.
Phase 2: Roll workloads (or trigger hot-reload) so they pick up the new credential.
Phase 3: Verify zero traffic uses the old credential (via audit logs).
Phase 4: Revoke the old credential.
```

Automate with Vault's dynamic secrets (per-connection DB creds with TTL) or AWS Secrets Manager rotation Lambdas. For static third-party API keys, use a two-slot pattern: `API_KEY_A` and `API_KEY_B`, rotate one while the other is live, flip which slot is "active" via a flag.

**Follow-ups:**
- "What if a consumer has cached the old credential for an hour?" Your rotation window is an hour plus safety margin. Keep both credentials valid for at least 2x the cache TTL.
- "How do you rotate a JWT signing key?" Publish a JWKS endpoint with both old and new public keys. Sign new tokens with the new key. Keep the old key in JWKS until the longest-lived token has expired, then remove it.
- "How do you detect a leaked secret?" GitHub secret scanning, canary tokens (unused credentials monitored for any access attempt), and egress audit logs on the secret store.

### Question 10: Safe Hot-Reload of Configuration

**What FAANG expects:** Hot-reload is not just "re-read the file." Candidates must cover validation before swap, atomic pointer swap, readers without locks, and what to do when validation fails (keep the old config, log loudly, alert).

**Answer:**

The four rules of safe hot-reload:

1. **Validate first, swap second**. Parse and validate the new config into a fresh struct. If validation fails, keep the running config and emit a metric/alert. Never partially apply.
2. **Atomic swap**. Use `atomic.Pointer[Config]` or `atomic.Value`. Readers load the pointer with no lock, writers store the new pointer once validation passes.
3. **Immutable snapshots**. Never mutate a loaded config in place. Load, validate, swap. This eliminates read/write races by construction.
4. **Observability**. Emit a metric on every reload (success/failure), log the diff (with secrets redacted), and include the config version/hash in `/healthz` so you can verify which version is live.

```go
type Reloader struct {
    current atomic.Pointer[Config]
}

func (r *Reloader) Load() *Config { return r.current.Load() }

func (r *Reloader) Reload(path string) error {
    next, err := parseAndValidate(path) // may return errors
    if err != nil {
        metrics.Counter("config_reload_failed").Inc()
        return fmt.Errorf("reload rejected: %w", err)
    }
    r.current.Store(next) // atomic swap
    metrics.Counter("config_reload_ok").Inc()
    return nil
}
```

**Follow-ups:**
- "What config values are unsafe to hot-reload?" Anything that controls resource binding: listen port, TLS certs (mostly reloadable via `tls.Config.GetCertificate`), DB connection pool size (reloadable via `db.SetMaxOpenConns`). If the value is consumed once at startup and cached in private state, hot-reload will silently lie about taking effect.
- "How do you trigger a reload?" SIGHUP for on-box binaries, file watcher (fsnotify) for container configs mounted as volumes, or a polling loop against a remote config service. Prefer a pull model with jitter to avoid thundering herds across a fleet.
- "How do you test hot-reload?" Unit test the validator with bad inputs (rejected), integration test with an fsnotify trigger and assert the atomic pointer advances, chaos test by pushing a malformed config in staging and verifying the service keeps serving.

### Q (Staff track): How do you manage flag debt across 100 services?

**Answer**: Tagging at creation, automated staleness detection, lint rules for dead flag references, deletion of flag+code together. Publish a dashboard of stale flags. Make it team responsibility to clean up.

---
