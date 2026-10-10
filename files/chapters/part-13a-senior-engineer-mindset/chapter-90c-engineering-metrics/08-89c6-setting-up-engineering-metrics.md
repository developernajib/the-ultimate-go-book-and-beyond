## 90C.6 Setting Up Engineering Metrics

### Commercial Tools

**LinearB**: Focused on engineering metrics with Git integration. Automatically computes DORA metrics, PR cycle time, and review analytics from GitHub/GitLab. Strong for teams that want metrics without building the pipeline.

**Swarmia**: Similar to LinearB with better team health dashboards. Good for developer experience surveys combined with quantitative metrics.

**Jellyfish**: Connects engineering data (Git, Jira) with business outcomes. Strong for aligning engineering metrics with product and business KPIs.

**Comparison**:

| Tool | DORA | Flow | DevEx | Price | Setup Time |
|------|------|------|-------|-------|------------|
| LinearB | ✅ | ✅ | ✅ | $$ | < 1 day |
| Swarmia | ✅ | ✅ | ✅ | $$ | < 1 day |
| Jellyfish | ✅ | ✅ | ⚠️ | $$$ | 1-2 days |
| DIY (GitHub API + Grafana) | ✅ | ⚠️ | ⚠️ | $ (time) | 1-2 weeks |

### DIY with GitHub API + Grafana

For teams that want full control over their metrics pipeline or need to integrate with custom systems, a DIY approach using the GitHub API and Grafana is viable.

**Architecture**:

```
GitHub API → Go Collector → PostgreSQL → Grafana
              (cron every 1h)   (metrics DB)  (dashboards)
```

**Go collector implementation**:

```go
package main

import (
    "context"
    "database/sql"
    "fmt"
    "log"
    "time"

    "github.com/google/go-github/v57/github"
    "golang.org/x/oauth2"
    _ "github.com/lib/pq"
)

// MetricsCollector gathers engineering metrics from GitHub.
type MetricsCollector struct {
    github *github.Client
    db     *sql.DB
    org    string
    repo   string
}

// NewMetricsCollector creates a collector for a GitHub repository.
func NewMetricsCollector(token, org, repo string, db *sql.DB) *MetricsCollector {
    ts := oauth2.StaticTokenSource(&oauth2.Token{AccessToken: token})
    tc := oauth2.NewClient(context.Background(), ts)

    return &MetricsCollector{
        github: github.NewClient(tc),
        db:     db,
        org:    org,
        repo:   repo,
    }
}

// CollectPRMetrics collects pull request metrics for the last N days.
func (c *MetricsCollector) CollectPRMetrics(ctx context.Context, days int) error {
    since := time.Now().AddDate(0, 0, -days)

    opts := &github.PullRequestListOptions{
        State:     "closed",
        Sort:      "updated",
        Direction: "desc",
        ListOptions: github.ListOptions{PerPage: 100},
    }

    for {
        prs, resp, err := c.github.PullRequests.List(ctx, c.org, c.repo, opts)
        if err != nil {
            return fmt.Errorf("listing PRs: %w", err)
        }

        for _, pr := range prs {
            if pr.MergedAt == nil {
                continue // Skip closed but unmerged PRs
            }
            if pr.MergedAt.Before(since) {
                return nil // We've gone past our window
            }

            if err := c.storePRMetric(ctx, pr); err != nil {
                log.Printf("storing PR %d metrics: %v", pr.GetNumber(), err)
            }
        }

        if resp.NextPage == 0 {
            break
        }
        opts.Page = resp.NextPage
    }

    return nil
}

// storePRMetric persists a single PR's metrics to the database.
func (c *MetricsCollector) storePRMetric(ctx context.Context, pr *github.PullRequest) error {
    // Calculate lead time: first commit to merge
    commits, _, err := c.github.PullRequests.ListCommits(
        ctx, c.org, c.repo, pr.GetNumber(), nil,
    )
    if err != nil {
        return fmt.Errorf("listing commits for PR %d: %w", pr.GetNumber(), err)
    }

    var firstCommitAt time.Time
    for _, commit := range commits {
        if t := commit.GetCommit().GetAuthor().GetDate().Time; firstCommitAt.IsZero() || t.Before(firstCommitAt) {
            firstCommitAt = t
        }
    }

    leadTime := pr.MergedAt.Time.Sub(firstCommitAt)
    cycleTime := pr.MergedAt.Time.Sub(pr.GetCreatedAt().Time)

    // Get review turnaround (time to first review)
    reviews, _, err := c.github.PullRequests.ListReviews(
        ctx, c.org, c.repo, pr.GetNumber(), nil,
    )
    if err != nil {
        return fmt.Errorf("listing reviews for PR %d: %w", pr.GetNumber(), err)
    }
    var firstReviewAt *time.Time
    for _, review := range reviews {
        t := review.GetSubmittedAt().Time
        if firstReviewAt == nil || t.Before(*firstReviewAt) {
            firstReviewAt = &t
        }
    }

    var reviewTurnaround *float64
    if firstReviewAt != nil {
        d := firstReviewAt.Sub(pr.GetCreatedAt().Time).Hours()
        reviewTurnaround = &d
    }

    _, err = c.db.ExecContext(ctx, `
        INSERT INTO pr_metrics (
            repo, pr_number, merged_at, lead_time_hours,
            cycle_time_hours, review_turnaround_hours,
            additions, deletions
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        ON CONFLICT (repo, pr_number) DO UPDATE SET
            merged_at = EXCLUDED.merged_at,
            lead_time_hours = EXCLUDED.lead_time_hours
    `,
        c.repo,
        pr.GetNumber(),
        pr.MergedAt.Time,
        leadTime.Hours(),
        cycleTime.Hours(),
        reviewTurnaround,
        pr.GetAdditions(),
        pr.GetDeletions(),
    )
    return err
}
```

**Grafana dashboard queries**:

```sql
-- Deployment frequency (deploys per day, rolling 30 days)
SELECT
    DATE_TRUNC('day', deployed_at) as day,
    COUNT(*) as deployments
FROM deployments
WHERE
    environment = 'production'
    AND deployed_at > NOW() - INTERVAL '30 days'
GROUP BY DATE_TRUNC('day', deployed_at)
ORDER BY day;

-- Lead time distribution (p50, p95)
SELECT
    PERCENTILE_CONT(0.50) WITHIN GROUP (ORDER BY lead_time_hours) as p50_hours,
    PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY lead_time_hours) as p95_hours,
    AVG(lead_time_hours) as mean_hours
FROM pr_metrics
WHERE merged_at > NOW() - INTERVAL '30 days';

-- PR review turnaround trend (weekly)
SELECT
    DATE_TRUNC('week', merged_at) as week,
    PERCENTILE_CONT(0.50) WITHIN GROUP (ORDER BY review_turnaround_hours) as p50_turnaround
FROM pr_metrics
WHERE
    merged_at > NOW() - INTERVAL '90 days'
    AND review_turnaround_hours IS NOT NULL
GROUP BY DATE_TRUNC('week', merged_at)
ORDER BY week;
```

### Avoiding Goodhart's Law

Goodhart's Law states: "When a measure becomes a target, it ceases to be a good measure."

This is the most dangerous failure mode in engineering metrics programs. Examples of Goodhart's Law in action:

| Metric | Gaming Behavior | Effect |
|--------|----------------|--------|
| Deployment frequency | Break one deployment into ten one-line deploys | High frequency metric, no actual increase in throughput |
| PR merge count | Merge tiny cosmetic PRs | High PR count, no meaningful delivery |
| Test coverage | Write tests that execute code but assert nothing | Coverage %, zero bug detection |
| Incident count | Stop tracking incidents | Fewer incidents on paper, same problems in production |
| Code review comments | Leave superficial comments | Meets metric, adds no review value |

**Protection strategies**:

1. **Use metric families, not individual metrics**: It is hard to game all four DORA metrics simultaneously. Improving deployment frequency while degrading change failure rate is visible.

2. **Never use individual metrics in performance reviews**: Use them for team health signals, never for individual performance measurement. Individual measurement creates the strongest gaming incentives.

3. **Validate with qualitative signals**: Survey engineers quarterly on their experience. If metrics say "improving" but engineers say "frustrating," your metrics are being gamed or are measuring the wrong things.

4. **Rotate the focus metric**: Instead of optimizing all metrics simultaneously, focus on one per quarter. This reduces the incentive to game the metric in focus by making it less permanently high-stakes.

5. **Transparent methodology**: Publish how metrics are calculated. Hidden methodology creates suspicion and encourages engineers to question rather than use metrics.

### Metrics Review Cadence

**Weekly (Team Lead)**:
- Build time, test time, CI time
- Flaky test count
- PR review turnaround
- Deployment frequency (last 7 days)

**Monthly (Engineering Manager + Tech Lead)**:
- Full DORA scorecard (30-day rolling)
- Flow efficiency and cycle time trend
- Defect escape rate
- Technical debt backlog ratio
- Security vulnerability aging

**Quarterly (Director + Staff Engineers)**:
- Year-over-year DORA performer category
- Developer experience survey results
- Onboarding time trend
- Code coverage trend (not absolute value - trend)
- Alignment between engineering metrics and business metrics

---
