## Exercises

### Exercise 1: Build a DORA Metrics CLI from the GitHub API

Build a command-line tool `dora-cli` in Go that computes deployment frequency and lead time for changes from the GitHub API.

**Requirements**:
- Accept `--owner`, `--repo`, `--token`, `--env`, `--days` flags
- Use the GitHub REST API to fetch deployments and pull requests for the specified time window
- Compute deployment frequency (per day and per week) and lead time (P50, P90 in hours)
- Output results as a formatted table and as JSON (`--format json`)
- Classify each metric into its DORA performance band (Elite / High / Medium / Low)
- Handle GitHub API rate limiting gracefully with exponential backoff

**Stretch goals**:
- Paginate through all results, not just the first 100
- Add `--baseline-days` flag to compare current period against a historical baseline
- Cache API responses to disk for repeated runs against the same window
- Add a `--webhook` flag to POST results to a Slack or Teams webhook URL

**Evaluation criteria**:
- Correct percentile calculation
- Proper error handling for API failures and missing data
- Clean CLI interface using `flag` or `cobra`
- All exported functions documented with godoc comments
- At least 80% test coverage on the calculation functions (mock the HTTP client)

---

### Exercise 2: Design a Team Health Dashboard

Design (do not implement - focus on reasoning) a team health dashboard for a 12-person Go backend team. You must select exactly five metrics to track.

**Your deliverable**: A written design document (500+ words) covering:

1. **The five metrics you chose** and why each one was selected over alternatives you considered.

2. **How you would collect each metric** - what data sources, what tools, what automation.

3. **How you would present each metric** - time series, distribution, single number, traffic light? Explain the visualization choice.

4. **The review cadence** - who reviews these metrics, at what frequency, and what decisions can they make based on each metric?

5. **Goodhart's Law mitigation** - for each metric, describe one specific way a team could game it and how you would detect that gaming.

6. **What you explicitly decided NOT to track** - name two metrics you considered and rejected, and explain why.

**Evaluation criteria**:
- Evidence of understanding leading vs. lagging indicators (at least two leading indicators in your five)
- Explicit reasoning about Goodhart's Law for each metric
- Practical collection approach (not "we would manually measure this")
- Understanding of metric families - no metric should be isolated from its counterpart

**Example starter reasoning** (do not copy - develop your own):

"I would track PR review turnaround time as my primary leading indicator of cycle time. If review turnaround exceeds four hours, engineers lose context between writing code and receiving feedback, which extends the cognitive load of each change and slows subsequent changes. I would collect this from the GitHub API by computing the time from the first review request to the first substantive review comment. I would present it as a weekly P50 and P90 time series to see trends. The gaming risk: engineers could post a one-word review ('LGTM') within minutes to hit the SLA without actually reviewing. I would detect this by correlating review turnaround time with post-merge defect rate - fast reviews that precede high defect rates indicate rubber-stamping."

---

## Summary

Engineering metrics provide the objective baseline required to evaluate delivery performance, identify architectural bottlenecks, and protect team sustainability. By grounding engineering decisions in quantitative evidence rather than intuition, teams build lasting credibility with leadership and ensure continuous improvement.

### Key Takeaways

1. **Focus on DORA Metrics**: Track deployment frequency, lead time for changes, change failure rate, and time to restore service (MTTR) as the core indicators of delivery velocity and stability.
2. **Apply Flow Metrics and Little's Law**: Constrain work in progress (WIP) to decrease cycle time without increasing team burnout.
3. **Optimize Developer Experience (DevEx)**: Measure build durations, test suite execution times, and PR review turnaround to eliminate day-to-day friction.
4. **Beware Goodhart's Law**: Measure metric families rather than isolated targets to prevent gaming (e.g., pair velocity with defect escape rate).
5. **Demonstrate Staff-Level Leadership**: Use metric trends to make data-driven cases for tooling investments, refactoring initiatives, and organizational capacity planning.

---

*Next: Chapter 90D - Architecture Patterns in Go: Hexagonal, Clean, and Modular Monoliths*

---
