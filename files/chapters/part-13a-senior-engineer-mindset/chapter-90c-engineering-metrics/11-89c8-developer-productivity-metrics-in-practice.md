## 90C.8 Developer Productivity Metrics in Practice

### DORA Metrics: Automated Collection via Go

The four DORA metrics only become actionable when you measure them continuously and automatically. Manual measurement every quarter is too slow and too inaccurate. This section builds a Go service that pulls live DORA metrics from GitHub, PagerDuty, and Jira.

#### Architecture of a DORA Metrics Collector

The service pulls data from three sources: GitHub for deployment frequency and lead time, PagerDuty for change failure rate and time to restore, and Jira for issue lead time. Each source feeds into a unified metrics store that exposes a Prometheus endpoint for Grafana dashboards.

```
┌─────────────────────────────────────────────────────────────┐
│                    DORA Metrics Service                     │
│                                                             │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────┐   │
│  │  GitHub API  │  │ PagerDuty API│  │     Jira API     │   │
│  │  (deployments│  │  (incidents) │  │  (issue lead     │   │
│  │  PR merges)  │  │              │  │   time)          │   │
│  └──────┬───────┘  └──────┬───────┘  └────────┬─────────┘   │
│         │                 │                   │             │
│         └─────────────────┴───────────────────┘             │
│                           │                                 │
│                    ┌──────▼───────┐                         │
│                    │  Aggregator  │                         │
│                    │  (Go service)│                         │
│                    └──────┬───────┘                         │
│                           │                                 │
│              ┌────────────┴─────────────┐                   │
│              │                          │                   │
│       ┌──────▼──────┐          ┌────────▼──────┐            │
│       │  Prometheus │          │  JSON Export  │            │
│       │  /metrics   │          │  (Grafana DS) │            │
│       └─────────────┘          └───────────────┘            │
└─────────────────────────────────────────────────────────────┘
```

#### Core Data Models

Before implementing the collection logic, establishing a shared data model ensures that all four metrics speak the same language. The `DORAMetrics` struct is the top-level result returned by the aggregator, and each sub-metric carries both its computed values and its DORA performer band classification. Using named string constants for `PerformanceBand` makes the classification readable in logs and JSON output without requiring the consumer to look up numeric thresholds.

```go
package dora

import "time"

// DORAMetrics holds all four DORA measurements for a time window.
type DORAMetrics struct {
    WindowStart       time.Time
    WindowEnd         time.Time
    DeploymentFreq    DeploymentFrequency
    LeadTime          LeadTimeMetrics
    ChangeFailureRate ChangeFailureRateMetrics
    MTTR              MTTRMetrics
    PerformanceBand   PerformanceBand
}

// PerformanceBand maps to the DORA research categories.
type PerformanceBand string

const (
    BandElite  PerformanceBand = "Elite"
    BandHigh   PerformanceBand = "High"
    BandMedium PerformanceBand = "Medium"
    BandLow    PerformanceBand = "Low"
)

// DeploymentFrequency represents how often deployments happen.
type DeploymentFrequency struct {
    TotalDeployments int
    PerDay           float64
    PerWeek          float64
    Band             PerformanceBand
}

// LeadTimeMetrics represents change lead time measurements.
type LeadTimeMetrics struct {
    P50Hours float64 // median
    P90Hours float64 // 90th percentile
    P99Hours float64 // 99th percentile
    Band     PerformanceBand
}

// ChangeFailureRateMetrics measures deployment failures.
type ChangeFailureRateMetrics struct {
    TotalDeployments int
    FailedDeployments int
    RatePercent       float64
    Band              PerformanceBand
}

// MTTRMetrics measures recovery time from incidents.
type MTTRMetrics struct {
    TotalIncidents   int
    P50MinutesFloat  float64
    P90MinutesFloat  float64
    Band             PerformanceBand
}
```

#### GitHub API Client for Deployment Frequency

The GitHub REST API provides deployment and pull request data that maps directly to deployment frequency and lead time. The client below wraps raw HTTP calls with proper authorization headers, handles pagination, and filters results to the requested time window before returning. Using a concrete `*http.Client` with an explicit timeout prevents the client from hanging indefinitely on slow API responses, which is critical when this code runs as an hourly cron job.

```go
package github

import (
    "context"
    "encoding/json"
    "fmt"
    "net/http"
    "time"
)

// Client wraps GitHub REST API calls.
type Client struct {
    httpClient *http.Client
    baseURL    string
    token      string
    org        string
    repo       string
}

// NewClient creates a GitHub API client.
// token is a GitHub personal access token with repo:read scope.
func NewClient(token, org, repo string) *Client {
    return &Client{
        httpClient: &http.Client{Timeout: 30 * time.Second},
        baseURL:    "https://api.github.com",
        token:      token,
        org:        org,
        repo:       repo,
    }
}

// Deployment represents a GitHub deployment record.
type Deployment struct {
    ID          int64     `json:"id"`
    Environment string    `json:"environment"`
    CreatedAt   time.Time `json:"created_at"`
    UpdatedAt   time.Time `json:"updated_at"`
    SHA         string    `json:"sha"`
    Ref         string    `json:"ref"`
    Task        string    `json:"task"`
}

// DeploymentStatus represents the outcome of a deployment.
type DeploymentStatus struct {
    State     string    `json:"state"` // success, failure, error, inactive, pending
    CreatedAt time.Time `json:"created_at"`
}

// ListDeployments fetches deployments for the repo within a time window.
func (c *Client) ListDeployments(ctx context.Context, env string, since, until time.Time) ([]Deployment, error) {
    url := fmt.Sprintf("%s/repos/%s/%s/deployments?environment=%s&per_page=100",
        c.baseURL, c.org, c.repo, env)

    req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
    if err != nil {
        return nil, fmt.Errorf("creating request: %w", err)
    }
    req.Header.Set("Authorization", "Bearer "+c.token)
    req.Header.Set("Accept", "application/vnd.github+json")

    resp, err := c.httpClient.Do(req)
    if err != nil {
        return nil, fmt.Errorf("executing request: %w", err)
    }
    defer resp.Body.Close()

    if resp.StatusCode != http.StatusOK {
        return nil, fmt.Errorf("GitHub API returned %d", resp.StatusCode)
    }

    var deployments []Deployment
    if err := json.NewDecoder(resp.Body).Decode(&deployments); err != nil {
        return nil, fmt.Errorf("decoding response: %w", err)
    }

    // Filter by time window
    var filtered []Deployment
    for _, d := range deployments {
        if d.CreatedAt.After(since) && d.CreatedAt.Before(until) {
            filtered = append(filtered, d)
        }
    }
    return filtered, nil
}

// GetDeploymentStatuses fetches the status history for a deployment.
func (c *Client) GetDeploymentStatuses(ctx context.Context, deploymentID int64) ([]DeploymentStatus, error) {
    url := fmt.Sprintf("%s/repos/%s/%s/deployments/%d/statuses",
        c.baseURL, c.org, c.repo, deploymentID)

    req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
    if err != nil {
        return nil, fmt.Errorf("creating request: %w", err)
    }
    req.Header.Set("Authorization", "Bearer "+c.token)
    req.Header.Set("Accept", "application/vnd.github+json")

    resp, err := c.httpClient.Do(req)
    if err != nil {
        return nil, fmt.Errorf("executing request: %w", err)
    }
    defer resp.Body.Close()

    var statuses []DeploymentStatus
    if err := json.NewDecoder(resp.Body).Decode(&statuses); err != nil {
        return nil, fmt.Errorf("decoding response: %w", err)
    }
    return statuses, nil
}

// PullRequest represents a merged pull request.
type PullRequest struct {
    Number   int       `json:"number"`
    Title    string    `json:"title"`
    MergedAt time.Time `json:"merged_at"`
    CreatedAt time.Time `json:"created_at"`
    Head     struct {
        SHA string `json:"sha"`
    } `json:"head"`
}

// ListMergedPRs fetches merged pull requests within a time window.
func (c *Client) ListMergedPRs(ctx context.Context, since, until time.Time) ([]PullRequest, error) {
    url := fmt.Sprintf("%s/repos/%s/%s/pulls?state=closed&per_page=100&sort=updated&direction=desc",
        c.baseURL, c.org, c.repo)

    req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
    if err != nil {
        return nil, fmt.Errorf("creating request: %w", err)
    }
    req.Header.Set("Authorization", "Bearer "+c.token)
    req.Header.Set("Accept", "application/vnd.github+json")

    resp, err := c.httpClient.Do(req)
    if err != nil {
        return nil, fmt.Errorf("executing request: %w", err)
    }
    defer resp.Body.Close()

    var prs []PullRequest
    if err := json.NewDecoder(resp.Body).Decode(&prs); err != nil {
        return nil, fmt.Errorf("decoding response: %w", err)
    }

    var merged []PullRequest
    for _, pr := range prs {
        if !pr.MergedAt.IsZero() && pr.MergedAt.After(since) && pr.MergedAt.Before(until) {
            merged = append(merged, pr)
        }
    }
    return merged, nil
}
```

#### PagerDuty Client for MTTR

MTTR requires incident data with both open and resolve timestamps, which PagerDuty exposes through its v2 incidents endpoint. The client queries resolved incidents in a specific time window and returns the raw `Incident` structs that the aggregator will use to compute percentile recovery times. Querying only high-urgency incidents is a deliberate choice, SEV3 noise from minor alerts would artificially inflate MTTR and obscure the signal from customer-impacting outages.

```go
package pagerduty

import (
    "context"
    "encoding/json"
    "fmt"
    "net/http"
    "time"
)

// Client wraps PagerDuty REST API v2.
type Client struct {
    httpClient *http.Client
    apiKey     string
    serviceID  string
}

// NewClient creates a PagerDuty client.
// apiKey is a PagerDuty API token with read access.
func NewClient(apiKey, serviceID string) *Client {
    return &Client{
        httpClient: &http.Client{Timeout: 30 * time.Second},
        apiKey:     apiKey,
        serviceID:  serviceID,
    }
}

// Incident represents a PagerDuty incident.
type Incident struct {
    ID               string    `json:"id"`
    Title            string    `json:"title"`
    Status           string    `json:"status"` // triggered, acknowledged, resolved
    CreatedAt        time.Time `json:"created_at"`
    ResolvedAt       *time.Time `json:"resolved_at"`
    Urgency          string    `json:"urgency"` // high, low
    AcknowledgedAt   *time.Time `json:"first_trigger_log_entry_created_at"`
}

// ListResolvedIncidents fetches resolved incidents within a window.
func (c *Client) ListResolvedIncidents(ctx context.Context, since, until time.Time) ([]Incident, error) {
    url := fmt.Sprintf(
        "https://api.pagerduty.com/incidents?service_ids[]=%s&statuses[]=resolved&since=%s&until=%s&limit=100",
        c.serviceID,
        since.Format(time.RFC3339),
        until.Format(time.RFC3339),
    )

    req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
    if err != nil {
        return nil, fmt.Errorf("creating request: %w", err)
    }
    req.Header.Set("Authorization", "Token token="+c.apiKey)
    req.Header.Set("Accept", "application/vnd.pagerduty+json;version=2")

    resp, err := c.httpClient.Do(req)
    if err != nil {
        return nil, fmt.Errorf("executing request: %w", err)
    }
    defer resp.Body.Close()

    var result struct {
        Incidents []Incident `json:"incidents"`
    }
    if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
        return nil, fmt.Errorf("decoding response: %w", err)
    }
    return result.Incidents, nil
}
```

#### DORA Aggregator: Computing All Four Metrics

The aggregator wires together the GitHub and PagerDuty clients, fetches the raw data, and delegates each metric's computation to a focused private function. Each `compute*` function is intentionally pure, it takes slices and returns a result struct, which makes unit testing straightforward without any HTTP mocking. The overall band is derived by scoring all four individual bands and computing the arithmetic mean, producing a single number that executives can track on a dashboard.

```go
package dora

import (
    "context"
    "math"
    "sort"
    "time"

    "yourmodule/github"
    "yourmodule/pagerduty"
)

// Aggregator computes DORA metrics from data sources.
type Aggregator struct {
    github     *github.Client
    pagerduty  *pagerduty.Client
    environment string // e.g., "production"
}

// NewAggregator creates a new DORA metrics aggregator.
func NewAggregator(gh *github.Client, pd *pagerduty.Client, env string) *Aggregator {
    return &Aggregator{
        github:      gh,
        pagerduty:   pd,
        environment: env,
    }
}

// Compute calculates all four DORA metrics for the given window.
func (a *Aggregator) Compute(ctx context.Context, since, until time.Time) (*DORAMetrics, error) {
    deployments, err := a.github.ListDeployments(ctx, a.environment, since, until)
    if err != nil {
        return nil, err
    }

    prs, err := a.github.ListMergedPRs(ctx, since, until)
    if err != nil {
        return nil, err
    }

    incidents, err := a.pagerduty.ListResolvedIncidents(ctx, since, until)
    if err != nil {
        return nil, err
    }

    days := until.Sub(since).Hours() / 24
    weeks := days / 7

    df := computeDeploymentFrequency(deployments, days, weeks)
    lt := computeLeadTime(prs)
    cfr := computeChangeFailureRate(ctx, deployments, a.github)
    mttr := computeMTTR(incidents)

    metrics := &DORAMetrics{
        WindowStart:       since,
        WindowEnd:         until,
        DeploymentFreq:    df,
        LeadTime:          lt,
        ChangeFailureRate: cfr,
        MTTR:              mttr,
    }
    metrics.PerformanceBand = computeOverallBand(metrics)
    return metrics, nil
}

func computeDeploymentFrequency(deployments []github.Deployment, days, weeks float64) DeploymentFrequency {
    n := len(deployments)
    perDay := float64(n) / days
    perWeek := float64(n) / weeks

    var band PerformanceBand
    switch {
    case perDay >= 1:
        band = BandElite   // multiple per day or on-demand
    case perWeek >= 1:
        band = BandHigh    // once per week to once per month
    case perWeek >= 0.25:
        band = BandMedium  // once per month to once every 6 months
    default:
        band = BandLow
    }

    return DeploymentFrequency{
        TotalDeployments: n,
        PerDay:           perDay,
        PerWeek:          perWeek,
        Band:             band,
    }
}

func computeLeadTime(prs []github.PullRequest) LeadTimeMetrics {
    var hours []float64
    for _, pr := range prs {
        if !pr.MergedAt.IsZero() {
            h := pr.MergedAt.Sub(pr.CreatedAt).Hours()
            hours = append(hours, h)
        }
    }
    if len(hours) == 0 {
        return LeadTimeMetrics{Band: BandLow}
    }

    slices.Sort(hours)
    p50 := percentile(hours, 50)
    p90 := percentile(hours, 90)
    p99 := percentile(hours, 99)

    var band PerformanceBand
    switch {
    case p50 < 1:
        band = BandElite   // less than one hour
    case p50 < 24:
        band = BandHigh    // less than one day
    case p50 < 168:
        band = BandMedium  // less than one week
    default:
        band = BandLow
    }

    return LeadTimeMetrics{
        P50Hours: p50,
        P90Hours: p90,
        P99Hours: p99,
        Band:     band,
    }
}

func computeChangeFailureRate(ctx context.Context, deployments []github.Deployment, gh *github.Client) ChangeFailureRateMetrics {
    if len(deployments) == 0 {
        return ChangeFailureRateMetrics{}
    }

    failed := 0
    for _, d := range deployments {
        statuses, err := gh.GetDeploymentStatuses(ctx, d.ID)
        if err != nil {
            continue
        }
        for _, s := range statuses {
            if s.State == "failure" || s.State == "error" {
                failed++
                break
            }
        }
    }

    rate := float64(failed) / float64(len(deployments)) * 100

    var band PerformanceBand
    switch {
    case rate < 5:
        band = BandElite
    case rate < 10:
        band = BandHigh
    case rate < 15:
        band = BandMedium
    default:
        band = BandLow
    }

    return ChangeFailureRateMetrics{
        TotalDeployments:  len(deployments),
        FailedDeployments: failed,
        RatePercent:       rate,
        Band:              band,
    }
}

func computeMTTR(incidents []pagerduty.Incident) MTTRMetrics {
    var minutes []float64
    for _, inc := range incidents {
        if inc.ResolvedAt != nil {
            m := inc.ResolvedAt.Sub(inc.CreatedAt).Minutes()
            minutes = append(minutes, m)
        }
    }
    if len(minutes) == 0 {
        return MTTRMetrics{Band: BandLow}
    }

    slices.Sort(minutes)
    p50 := percentile(minutes, 50)
    p90 := percentile(minutes, 90)

    var band PerformanceBand
    switch {
    case p50 < 60:
        band = BandElite   // less than one hour
    case p50 < 1440:
        band = BandHigh    // less than one day
    case p50 < 10080:
        band = BandMedium  // less than one week
    default:
        band = BandLow
    }

    return MTTRMetrics{
        TotalIncidents:  len(incidents),
        P50MinutesFloat: p50,
        P90MinutesFloat: p90,
        Band:            band,
    }
}

func percentile(sorted []float64, p float64) float64 {
    if len(sorted) == 0 {
        return 0
    }
    idx := p / 100 * float64(len(sorted)-1)
    lower := int(math.Floor(idx))
    upper := int(math.Ceil(idx))
    if lower == upper {
        return sorted[lower]
    }
    frac := idx - float64(lower)
    return sorted[lower]*(1-frac) + sorted[upper]*frac
}

func computeOverallBand(m *DORAMetrics) PerformanceBand {
    bands := []PerformanceBand{
        m.DeploymentFreq.Band,
        m.LeadTime.Band,
        m.ChangeFailureRate.Band,
        m.MTTR.Band,
    }
    score := 0
    for _, b := range bands {
        switch b {
        case BandElite:
            score += 4
        case BandHigh:
            score += 3
        case BandMedium:
            score += 2
        case BandLow:
            score += 1
        }
    }
    avg := score / len(bands)
    switch {
    case avg >= 4:
        return BandElite
    case avg >= 3:
        return BandHigh
    case avg >= 2:
        return BandMedium
    default:
        return BandLow
    }
}
```

### SPACE Framework for Developer Productivity

The SPACE framework, published by GitHub and Microsoft Research in 2021, addresses what DORA does not: the human dimensions of productivity. SPACE stands for Satisfaction, Performance, Activity, Communication, and Efficiency.

| Dimension | What It Measures | Example Metrics |
|-----------|-----------------|-----------------|
| **S**atisfaction | Developer wellbeing, engagement, fulfillment | eNPS, burnout survey scores, retention rate |
| **P**erformance | Quality outcomes of work | Defect escape rate, customer-reported bugs, SLO compliance |
| **A**ctivity | Volume of actions completed | PRs merged, deployments, code reviews done |
| **C**ommunication | How information flows | PR review turnaround, documentation freshness, async response time |
| **E**fficiency | Flow, low interruptions, minimal friction | Flow time, context-switch interruptions, WIP levels |

Critical rule: **never use a single dimension in isolation.** Activity metrics (commits per day, PRs per week) are the most misused. An engineer can have high Activity and low Performance (lots of code, lots of bugs). SPACE only works as a system.

#### Measuring Satisfaction: Survey Tooling in Go

Quantitative metrics like DORA tell you what is happening, but satisfaction surveys tell you why, and whether engineers are burning out before the metrics show it. The survey service below accepts HTTP POST submissions, validates Likert scale values at the boundary to prevent corrupt data from skewing trends, and persists responses for aggregate analysis. Keeping respondent IDs anonymized removes the social pressure that causes engineers to inflate their scores when they fear their responses are identifiable.

```go
package survey

import (
    "encoding/json"
    "net/http"
    "time"
)

// SurveyResponse captures a developer productivity survey response.
type SurveyResponse struct {
    RespondentID    string    `json:"respondent_id"` // anonymized
    Team            string    `json:"team"`
    SubmittedAt     time.Time `json:"submitted_at"`
    // 1-5 Likert scale responses
    ToolingScore    int       `json:"tooling_score"`
    ProcessScore    int       `json:"process_score"`
    ClarityScore    int       `json:"clarity_score"`
    MeetingLoadScore int      `json:"meeting_load_score"` // inverted: 5=few meetings
    OverallScore    int       `json:"overall_score"`
    FreeText        string    `json:"free_text"`
}

// TeamSatisfactionScore computes aggregate satisfaction for a team.
func TeamSatisfactionScore(responses []SurveyResponse, team string) float64 {
    var total, count float64
    for _, r := range responses {
        if r.Team == team {
            avg := float64(r.ToolingScore+r.ProcessScore+r.ClarityScore+r.MeetingLoadScore+r.OverallScore) / 5.0
            total += avg
            count++
        }
    }
    if count == 0 {
        return 0
    }
    return total / count
}

// SurveyHandler handles POST /survey submissions.
func SurveyHandler(store SurveyStore) http.HandlerFunc {
    return func(w http.ResponseWriter, r *http.Request) {
        if r.Method != http.MethodPost {
            http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
            return
        }

        var response SurveyResponse
        if err := json.NewDecoder(r.Body).Decode(&response); err != nil {
            http.Error(w, "invalid payload", http.StatusBadRequest)
            return
        }

        // Validate Likert scale values
        for _, score := range []int{response.ToolingScore, response.ProcessScore,
            response.ClarityScore, response.MeetingLoadScore, response.OverallScore} {
            if score < 1 || score > 5 {
                http.Error(w, "scores must be between 1 and 5", http.StatusUnprocessableEntity)
                return
            }
        }

        response.SubmittedAt = time.Now().UTC()
        if err := store.Save(r.Context(), response); err != nil {
            http.Error(w, "internal error", http.StatusInternalServerError)
            return
        }

        w.WriteHeader(http.StatusCreated)
    }
}
```

---
