## 23.14 Interview Questions

Chaos engineering comes up frequently in system design and SRE interviews at major technology companies. Interviewers want to see that you understand the practical safety controls, tooling decisions, and metrics, not just the theory. The questions below cover the most commonly asked topics, from basic definitions to architecture-level design of chaos pipelines.

### Question 1: What is Chaos Engineering and Why is it Important?

**What FAANG expects:** The Netflix-origin definition ("build confidence by experimenting on production") plus the five Principles of Chaos Engineering: build a hypothesis around steady-state behavior, vary real-world events, run experiments in production, automate experiments to run continuously, and minimize blast radius. The one candidates most often drop is automation, and dropping it is revealing: a chaos program that is a series of hand-run events is a series of events, not a program, and it decays the moment its champion changes team. Weak answers talk about "breaking things for fun". Strong answers talk about hypothesis-driven experiments with a falsifiable steady-state definition and an abort condition wired to SLO burn.

**Answer**: Chaos engineering is the discipline of experimenting on a distributed system to build confidence in its ability to withstand turbulent conditions in production. It differs from traditional testing because:

1. **Proactive vs Reactive**: Traditional testing validates known scenarios. Chaos engineering discovers unknown failure modes
2. **Production focus**: Tests run in production (with safety controls) to find real-world issues
3. **Systemic view**: Tests entire system behavior, not just individual components

Importance:
- **Reveals hidden dependencies**: Services you didn't know depended on each other
- **Validates recovery mechanisms**: Circuit breakers, retry logic, failover
- **Tests operational readiness**: Runbooks, alerts, on-call response
- **Builds confidence**: Teams know the system can handle failures

**Follow-ups:**
- *Why run experiments in production at all?* Because staging lies. Traffic patterns, tenant mix, and cache warmth are all different. A retry bug that needs real user load to manifest will never show up in staging. The Principles of Chaos Engineering put it directly: only a production environment with real traffic and real dependencies gives an accurate picture of resiliency, and that is what separates chaos engineering from traditional testing. Note the honest caveat an interviewer will be listening for: "run in production" is the *last* principle you earn, not the first you adopt. It presupposes the steady-state hypothesis and the bounded blast radius. Without those, you are not running principle 3, you are having an incident.
- *What is a steady-state hypothesis and why is it the hardest part?* A measurable business metric that should not change during the experiment (e.g. "checkout success rate stays above 99.5%"). Hard because most teams do not have a single metric they trust enough to bet a chaos run on.
- *What is Netflix's ChAP (Chaos Automation Platform)?* A layer above Chaos Monkey that compares a small treatment group against a control group in real time, with automated abort if SLOs diverge. The "statistical chaos" evolution of just-kill-instances.

### Question 2: How Would You Implement Blast Radius Control?

**What FAANG expects:** Five layers of containment: percentage cap, absolute cap, time limit, tenant allowlist, and automatic abort on SLO burn. Strong candidates also mention the big red button (one-command global abort) and the out-of-band health check (a separate monitoring path that is not itself affected by the experiment).

**Answer**: Blast radius control limits the impact of chaos experiments by constraining how many targets are affected and for how long. A controller selects a subset of targets based on both a percentage cap and an absolute maximum, then enforces a hard time limit that cancels the experiment automatically.

```go
type BlastRadiusController struct {
    maxPercentage float64
    maxTargets    int
    maxDuration   time.Duration

    mu              sync.Mutex
    affectedTargets []Target // Not []string: keep what you must roll back.
}

// SelectTargets returns the targets to affect, or an error explaining why it
// will not proceed. Returning an error rather than an empty slice matters:
// see the rounding note below.
func (b *BlastRadiusController) SelectTargets(all []Target) ([]Target, error) {
    if len(all) == 0 {
        return nil, errors.New("no targets")
    }
    if b.maxTargets <= 0 {
        // A zero absolute cap must not read as "unlimited" on a safety field.
        return nil, errors.New("maxTargets must be set")
    }

    // int() truncates. On a 9-instance fleet a 10% radius computes to 0.9 and
    // truncates to zero targets, so the experiment injects nothing, breaks
    // nothing, and reports success. A green run that never ran is worse than
    // a red one. Round up to at least one and let the absolute cap bound it.
    n := max(int(math.Ceil(float64(len(all))*b.maxPercentage)), 1)
    n = min(n, b.maxTargets, len(all))

    selected := randomSample(all, n)

    b.mu.Lock()
    b.affectedTargets = selected
    b.mu.Unlock()

    return selected, nil
}

// WithDeadline bounds the experiment. Prefer this to a bare time.AfterFunc:
// the timer from AfterFunc has no owner, keeps running after the experiment
// finishes early, and holds its closure alive until it fires.
func (b *BlastRadiusController) WithDeadline(ctx context.Context) (context.Context, context.CancelFunc) {
    return context.WithTimeout(ctx, b.maxDuration)
}
```

Two details in that code are worth calling out if the interviewer probes. Tracking `affectedTargets` as `[]string` while selecting `[]Target` does not compile, which sounds trivial until you notice what the field is for: it is the list you replay to undo the damage, and it wants the full target, not a name you will have to resolve again later while the system is on fire. And the rounding is a genuine trap. Blast radius percentages are written by people thinking about fleets of thousands, then applied to a service running five replicas, and truncation quietly turns the experiment into a no-op.

Implementation strategies:
- **Percentage-based**: Affect only X% of instances
- **Canary deployment**: Start with non-critical services
- **Geographic isolation**: Limit to one region/zone
- **Time-boxed**: Automatic stop after duration

**Follow-ups:**
- *What is the biggest source of blast-radius accidents?* Experiments that target "10% of instances" but hit a shared downstream that every instance calls. The instance-level radius is small, but the dependency-level radius is 100%. Always model the transitive impact, not just the direct one.
- *How do you abort an experiment automatically?* Wire an SLO burn-rate watcher (Prometheus/Grafana alert) to the experiment's cancel function. If error rate exceeds the budget faster than expected, abort and roll back. The abort itself must not depend on the thing being chaos-tested.
- *What is the "out-of-band" health check principle?* Monitor from a path that is not affected by the fault. If you are injecting network latency into service A, do not read service A's own `/health` endpoint to decide whether to abort, read a dashboard fed by an independent probe.

### Question 3: Design a Chaos Engineering Pipeline for CI/CD

**What FAANG expects:** A staged progression (staging → canary → prod) where each stage has a clear gate: pre-flight check, experiment run, steady-state verification, and automated rollback path. Strong answers show the pipeline is declarative (experiments-as-code), versioned alongside the service, and integrated with the deploy system so a known-bad build never reaches the chaos stage.

**Answer**: A chaos CI/CD pipeline should gate progression through environments, staging, canary, production, with each stage requiring the previous one to pass. Pre-flight health checks confirm the system is stable before any fault is injected, and blast radius increases gradually at each stage.

```yaml
# .github/workflows/chaos.yml
name: Chaos Pipeline

on:
  schedule:
    - cron: '0 2 * * *'  # Daily at 2 AM
  workflow_dispatch:
    inputs:
      experiment:
        description: 'Experiment to run'
        required: true
        type: choice
        options:
          - latency
          - error-injection
          - pod-failure

# Scheduled runs have no dispatch inputs, so `inputs.experiment` is empty and
# the command would resolve to `experiments/.yaml`. Default it at the env
# level so both triggers work.
env:
  EXPERIMENT: ${{ inputs.experiment || 'latency' }}

concurrency:
  group: chaos-pipeline
  cancel-in-progress: false

jobs:
  pre-checks:
    runs-on: ubuntu-latest
    steps:
      - name: Verify system health
        run: |
          # Check all services are healthy
          # Check no ongoing incidents
          # Check on-call is available

  chaos-staging:
    needs: pre-checks
    runs-on: ubuntu-latest   # Every job needs one. Without it the workflow
    environment: staging     # fails to parse, before a single check runs.
    steps:
      - name: Run chaos in staging
        run: |
          chaosctl run --config experiments/${EXPERIMENT}.yaml
          chaosctl verify --wait 5m

  chaos-canary:
    needs: chaos-staging
    runs-on: ubuntu-latest
    environment: canary
    steps:
      - name: Run chaos on canary
        run: |
          chaosctl run --config experiments/${EXPERIMENT}.yaml \
            --blast-radius 5%

  chaos-production:
    needs: chaos-canary
    runs-on: ubuntu-latest
    environment: production
    steps:
      - name: Run chaos in production
        run: |
          chaosctl run --config experiments/${EXPERIMENT}.yaml \
            --blast-radius 10% \
            --max-duration 5m

  report:
    needs: [chaos-staging, chaos-canary, chaos-production]
    runs-on: ubuntu-latest
    # always(), not the default. Without this the report job is SKIPPED
    # whenever a chaos job fails, which is precisely when the experiment
    # found something and the report is worth reading.
    if: always()
    steps:
      - name: Generate report
        run: chaosctl report --format markdown
```

That YAML has three bugs an interviewer may well plant on purpose. Only the first job declares `runs-on`, and a job without it is invalid, so the workflow never runs at all. `${{ inputs.experiment }}` is empty on the scheduled trigger, which is the trigger that runs 364 days a year. And `report` without `if: always()` is skipped exactly when a chaos stage fails.

**Follow-ups:**
- *What is a pre-flight check and what belongs in it?* A short checklist run before any fault: no active incidents, on-call is paged and acknowledged, SLOs green for the last 30 minutes, no deploy in flight. If any fails, the experiment is rescheduled. Prevents chaos on top of existing chaos.
- *Why separate canary and production stages?* Canary is a small fleet running the production build with production traffic but a fraction of users. It catches experiments that fail in real traffic before you touch the bulk of users. Without a canary stage the first production run is the first real test.
- *How do you prevent chaos pipelines from running during a freeze (Black Friday, product launch)?* Gate on a freeze-calendar service or a feature flag that on-call can flip. The pipeline reads the flag before starting and aborts cleanly if it is set.

### Question 4: How Do You Measure the Success of Chaos Engineering?

**What FAANG expects:** The program's value is measured in incidents it prevents, not experiments it runs. Strong answers give a before/after metric (incident frequency, MTTD, MTTR) and point to specific bugs found via chaos that would otherwise have surfaced in production. Counting experiments-run is a vanity metric.

**Answer**: Track these key metrics over time to quantify the impact of your chaos program:

1. **Mean Time to Detection (MTTD)**: How quickly issues are detected
2. **Mean Time to Recovery (MTTR)**: How quickly systems recover
3. **Incident Rate**: Reduction in production incidents
4. **Steady State Maintenance**: SLO compliance during experiments

A maturity score can combine these into a single number, and this is where a good interviewer will push back, so be ready to push back first.

```go
type ChaosMetrics struct {
    ExperimentsRun      int
    FindingsDiscovered  int
    FindingsRemediated  int
    SLOBreaches         int
    AutoRecoveries      int
    ManualInterventions int
    AverageMTTD         time.Duration
    AverageMTTR         time.Duration
}

// RemediationRate is the single number worth reporting to leadership. A
// program that finds problems and fixes them is working. A program that
// finds problems and files them is a very expensive bug tracker.
func (m *ChaosMetrics) RemediationRate() (float64, bool) {
    if m.FindingsDiscovered == 0 {
        return 0, false // No findings is not a 100% remediation rate.
    }
    return float64(m.FindingsRemediated) / float64(m.FindingsDiscovered), true
}

func (m *ChaosMetrics) CalculateMaturityScore() float64 {
    score := 0.0

    // Detection time (target: < 1 minute)
    switch {
    case m.AverageMTTD < time.Minute:
        score += 30
    case m.AverageMTTD < 5*time.Minute:
        score += 15
    }

    // Recovery time (target: < 5 minutes)
    switch {
    case m.AverageMTTR < 5*time.Minute:
        score += 30
    case m.AverageMTTR < 15*time.Minute:
        score += 15
    }

    // Did the findings actually get fixed?
    if rate, ok := m.RemediationRate(); ok {
        score += rate * 40
    }

    return score
}
```

Be ready to explain what you deliberately left out, because that is the actual question. The obvious scoring function awards points for `AutoRecoveries / ExperimentsRun`, and it is perverse in two directions at once. A system so robust that no experiment ever triggers a recovery scores *zero* on that term, so the metric punishes exactly the outcome the program exists to produce. And because the denominator is `ExperimentsRun`, you can raise your score by running more trivial experiments, which is the vanity metric the question is testing you on, wearing a ratio as a disguise.

The same trap sits in `SLOBreaches == 0` earning points. Zero SLO breaches during chaos experiments means either the system is resilient or the experiments were too timid to matter, and the number cannot tell you which. Any metric that a do-nothing program can max out is not measuring the program.

The honest answer to "how do you measure success" is that you measure it the way you would measure a security team: in things that did not happen, which is genuinely hard, plus one thing that is easy and that almost nobody tracks, which is whether findings get fixed. If `FindingsRemediated / FindingsDiscovered` is trending toward zero, the program is generating work, not resilience, and no dashboard will save it.

**Follow-ups:**
- *Which metric matters most?* MTTD. If detection is slow, every other number gets worse, recovery cannot start until the on-call knows. Chaos programs that measurably drop MTTD (by forcing alerts to fire and runbooks to be exercised) are the ones that stick.
- *How do you compare "before chaos" to "after chaos" honestly?* Fix the incident-counting definition first (severity threshold, scope, deduplication) and then compare rolling windows. Without a stable definition, any improvement can be explained away.
- *What is a "chaos finding" and how do you track it?* A bug or gap discovered through an experiment, tracked like any other bug with owner, severity, and due date. Netflix publishes internal "top findings" to make the program visible. If findings are not being remediated, the program is running in circles.

### Question 5: Compare Chaos Engineering Tools and When to Use Each

**What FAANG expects:** Awareness of the 2026 landscape: the original Netflix **Simian Army is retired** (its components either rolled into Spinnaker-integrated Chaos Monkey or superseded). CNCF has two active chaos projects, **Chaos Mesh** and **LitmusChaos**, both incubating. **Gremlin** remains the enterprise SaaS. **AWS Fault Injection Service (FIS)** has matured as the native option for AWS-heavy shops. Tool choice follows the platform, not vice versa.

**Answer**: The right tool depends on your platform, budget, and the breadth of fault types you need. Here is a comparison of the most widely used options:

| Tool | Best For | Strengths | Limitations |
|------|----------|-----------|-------------|
| **Chaos Monkey (modern)** | Spinnaker shops | Instance-kill, battle-tested at Netflix | Requires Spinnaker. Simian Army retired |
| **Gremlin** | Enterprise, mixed envs | Rich UI, many fault types, SaaS | Cost, vendor dependency |
| **LitmusChaos** | Kubernetes, OSS | CNCF incubating, large experiment catalog | K8s-only |
| **Chaos Mesh** | Kubernetes, OSS | CNCF incubating, broad fault catalog (pod, network, stress, IO, kernel, time), web UI | K8s-only, operational complexity |
| **AWS FIS** | AWS-heavy shops | Native, IAM-integrated, safety rails | AWS-only |
| **Custom** | Specific needs | Full control | Dev+maintenance cost |

```go
// Decision framework. Note what it does NOT branch on: budget is not the
// axis that separates Litmus from Chaos Mesh, because both are free CNCF
// open source. Choosing between them on price is a tell that you have not
// used either.
func ChooseChaosTool(r Requirements) string {
    switch {
    case r.Platform == "kubernetes":
        // Both are CNCF incubating and both are free. Pick on fit:
        // Chaos Mesh for the broader network/resource/kernel fault catalog
        // and its web UI, Litmus for a GitOps-first workflow and the
        // community experiment hub.
        if r.GitOps {
            return "litmus"
        }
        return "chaos-mesh"

    case r.Platform == "aws":
        // NOT chaos-monkey: that needs Spinnaker, which is a deployment
        // platform, not an AWS feature. FIS is the native answer.
        return "aws-fis"

    case r.Platform == "spinnaker":
        return "chaos-monkey"

    case r.MixedEnvironments && r.Budget == "high":
        return "gremlin" // Buys breadth across VMs, containers, and cloud.

    default:
        return "custom" // Last resort. See the Staff Lens in 23.11.
    }
}
```

**Follow-ups:**
- *Why did Netflix retire the Simian Army?* Normal software lifecycle. The per-monkey split (Chaos Monkey, Latency Monkey, Conformity Monkey, etc.) stopped matching Netflix's environment. Functionality got absorbed into Spinnaker-integrated Chaos Monkey and the ChAP platform. The conceptual framing (typed failures) is still valid, the monolithic toolkit is not.
- *Chaos Mesh vs LitmusChaos, how do you pick?* Chaos Mesh has the richer fault catalog and a polished web UI, stronger when you want one tool covering network/resource/kernel faults. Litmus has the bigger community-contributed experiment hub and better fit for GitOps-first teams. Both are CNCF, both are mature, the choice usually comes down to UI preference and existing Kubernetes tooling.
- *Where does AWS FIS fit?* It is the pragmatic answer for AWS-only stacks because it integrates with IAM, CloudWatch, and Systems Manager out of the box. No separate tool to operate, no cross-account headaches. Trade-off: zero portability if you ever leave AWS.

### Q (Staff track): How do you get leadership buy-in for chaos engineering?

**Answer**: Start with staging. Run experiments. Document findings. Calculate incident cost avoided. Present the ROI. Without leadership buy-in, production chaos is blocked. With it, the program can progress.

---
