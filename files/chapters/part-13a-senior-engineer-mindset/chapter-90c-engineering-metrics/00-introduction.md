# Chapter 90C: Engineering Metrics - DORA, Flow, and Team Health

*You can't manage what you can't measure.*

*Be careful what you measure, because you will get it.*

Software engineering teams make continuous investment decisions - in CI/CD infrastructure, in testing practices,
in code review processes, in developer tooling - and most of them cannot tell whether those investments are
paying off. Developers who would never ship a feature without measuring its impact on user behavior routinely
improve their deployment pipeline without checking whether deployment frequency actually increased. Engineering
managers who hold weekly retrospectives on team health cannot say whether the team is trending better or worse
over a quarter. This is not a failure of care. It is a failure of measurement infrastructure, and it is nearly
universal. The engineers and teams that rise above it instrument their own delivery process with the same rigor
they apply to their production services.

Go teams have a particular advantage here: Go's toolchain and ecosystem make it unusually straightforward to
build custom engineering metrics infrastructure. The GitHub API has a well-documented Go client. Prometheus
exporters are trivial to write in idiomatic Go. The `go test` and `go build` output can be parsed and persisted
to a time-series database in under 100 lines. A Go team that wants a custom dashboard showing DORA metrics, PR
review turnaround time, and flaky test rate can build one in an afternoon - rather than waiting months for
approval of a commercial tool's enterprise contract that may not measure what the team actually cares about.

This chapter builds both the conceptual framework and the practical implementation toolkit for engineering
metrics. You will understand the DORA research that established deployment frequency, lead time, change failure
rate, and MTTR as the four metrics most predictive of organizational performance. You will learn flow metrics and
their connection to Little's Law for diagnosing where work stalls. You will understand Goodhart's Law and how
to design measurement programs that resist gaming. And you will build a real engineering metrics dashboard using
the GitHub API and Grafana, with Go handling all data collection, transformation, and export.

**What you'll learn in this chapter:**
- The distinction between vanity metrics (lines of code, story points, PRs merged) and meaningful metrics
  (lead time, change failure rate, cycle time) - and why measuring the wrong things is worse than measuring nothing
- All four DORA metrics in depth: how to calculate deployment frequency, lead time for changes, change failure
  rate, and MTTR, and how to benchmark your team against elite, high, medium, and low performer profiles
- Flow metrics and Little's Law: flow time, flow efficiency, flow velocity, and flow load as a framework for
  diagnosing delivery bottlenecks and identifying where work accumulates in the system
- Developer experience metrics that correlate with both productivity and retention: build times, flaky test
  rates, PR review turnaround, and on-call burden measured objectively over time
- Goodhart's Law in practice: concrete case studies of metrics programs that were gamed into uselessness, and
  design principles for building incentive-resistant measurement frameworks
- Building an engineering metrics dashboard in Go: collecting data from GitHub's API, transforming it into
  Prometheus time-series metrics, and building Grafana dashboards for weekly and quarterly trend analysis
- Presenting metrics to engineering leadership: how to frame metric trends as evidence for investment decisions
  in tooling, process improvement, and headcount planning
- Senior and staff engineering interview questions on metrics: how to answer "how do you measure engineering
  effectiveness" and "how would you demonstrate the ROI of this platform investment"

**Why this matters at scale:**
The DORA research program - originally Google-backed and now part of DORA.dev - studied over 32,000 engineering
teams across five years and found that elite organizations deploy 973 times more frequently with 6,570 times
faster lead times than low performers. Stripe, Netflix, and Uber have each published engineering posts describing
how they use DORA and flow metrics internally to drive investment decisions and measure platform engineering ROI.

**Prerequisites:** Chapters 84--90B (senior engineer mindset and ADRs), and familiarity with observability and metrics.

### Junior → FAANG: Why Metrics Are Part of the Engineering Job, Not a Management Tool

Junior engineers often experience metrics as something done to them: velocity tracking by a PM, code coverage requirements from a team standard, SLA reporting to a client. That experience creates a misconception that metrics are a management control mechanism rather than an engineering tool.

At FAANG, the engineers most respected for their impact are those who define their own metrics before anyone asks them to. They ship a feature and then instrument it with the specific signals that will tell them whether it worked. They propose a refactor and then define the measurement that will tell them whether performance improved. They onboard onto a team and then ask "how do we currently measure the health of this system, and what would we need to add?"

The entry-level habit: after every significant piece of work, write a two-sentence summary of how you would know whether it succeeded. That practice builds the metrics intuition that staff-level interviews probe explicitly.

### Senior @ FAANG: Metrics as Platform Governance

At FAANG, engineering metrics serve three distinct functions that must be managed carefully to avoid conflation: diagnostic tools that help engineering teams identify problems, accountability mechanisms that help engineering leaders evaluate team health, and incentive structures that shape what engineers prioritize. Conflating these functions produces the Goodhart's Law failures discussed later in this chapter.

The governance challenge at scale: a metric that is appropriate as a diagnostic tool becomes an incentive structure the moment it is surfaced in a team health dashboard reviewed by engineering directors. Engineers will optimize for the metric rather than the underlying behavior it was intended to measure. Staff engineers who propose metrics programs must anticipate this shift and design the metric system with gaming-resistance built in, not added as an afterthought.

The maturity model for engineering metrics programs at FAANG: Level 1 is instrumentation (you can measure things). Level 2 is visibility (teams can see their own metrics). Level 3 is diagnosis (teams use metrics to identify problems). Level 4 is prediction (metrics are leading indicators that surface problems before they become incidents). Level 5 is governance (metrics programs are tied to engineering investment decisions, technology choices, and team health reviews with clear accountability). Most teams operate at Level 2 or 3. Staff engineers who drive a team to Level 4 or 5 are creating genuine organizational leverage.

---
