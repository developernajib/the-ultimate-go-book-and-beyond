## 99.15 Notification and Reporting

### Slack Notifications

GitHub Actions integrates with Slack through the official `slackapi/slack-github-action`, which posts structured Block Kit messages directly to a channel using a bot token. The `if: success()` and `if: failure()` conditionals are evaluated after every step, letting a single workflow file cover both the happy path and failure alerts without duplicating jobs. Including `github.sha` and a link to the run URL means the on-call engineer can jump straight from the Slack alert to the exact log that caused the failure.

```yaml
# .github/workflows/notify.yaml
name: Deploy with Notifications

on:
  push:
    branches: [main]

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Deploy
        id: deploy
        run: |
          # Deploy logic here
          echo "Deployment successful"

      - name: Notify Slack on success
        if: success()
        uses: slackapi/slack-github-action@v1
        with:
          channel-id: 'deployments'
          payload: |
            {
              "blocks": [
                {
                  "type": "section",
                  "text": {
                    "type": "mrkdwn",
                    "text": "✅ *Deployment Successful*\n*Service:* go-service\n*Version:* ${{ github.sha }}\n*Author:* ${{ github.actor }}"
                  }
                },
                {
                  "type": "actions",
                  "elements": [
                    {
                      "type": "button",
                      "text": {"type": "plain_text", "text": "View Logs"},
                      "url": "${{ github.server_url }}/${{ github.repository }}/actions/runs/${{ github.run_id }}"
                    }
                  ]
                }
              ]
            }
        env:
          SLACK_BOT_TOKEN: ${{ secrets.SLACK_BOT_TOKEN }}

      - name: Notify Slack on failure
        if: failure()
        uses: slackapi/slack-github-action@v1
        with:
          channel-id: 'deployments'
          payload: |
            {
              "blocks": [
                {
                  "type": "section",
                  "text": {
                    "type": "mrkdwn",
                    "text": "❌ *Deployment Failed*\n*Service:* go-service\n*Author:* ${{ github.actor }}\n*Error:* Check logs for details"
                  }
                }
              ]
            }
        env:
          SLACK_BOT_TOKEN: ${{ secrets.SLACK_BOT_TOKEN }}
```

### Deployment Tracking Dashboard

Slack alerts tell you a deployment happened, but they provide no historical view across services. This Go HTTP server records every deployment as a Postgres row with `start_time` and `end_time`, then exposes a `/deployments/metrics` endpoint that computes a rolling 24-hour success rate and average duration using a single aggregate query. The PATCH handler lets the CI pipeline mark a deployment complete by ID once smoke tests pass, turning the database into a lightweight audit log that feeds dashboards in Grafana or similar tools.

```go
// cmd/deploy-tracker/main.go
package main

import (
    "database/sql"
    "encoding/json"
    "net/http"
    "os"
    "time"

    _ "github.com/lib/pq"
)

type Deployment struct {
    ID        int64     `json:"id"`
    Service   string    `json:"service"`
    Version   string    `json:"version"`
    Deployer  string    `json:"deployer"`
    Status    string    `json:"status"`
    StartTime time.Time `json:"start_time"`
    EndTime   *time.Time `json:"end_time,omitempty"`
    Duration  int64     `json:"duration_seconds,omitempty"`
}

func main() {
    db, _ := sql.Open("postgres", os.Getenv("DATABASE_URL"))

    http.HandleFunc("POST /deployments", func(w http.ResponseWriter, r *http.Request) {
        var d Deployment
        json.NewDecoder(r.Body).Decode(&d)

        d.StartTime = time.Now()
        d.Status = "in_progress"

        err := db.QueryRow(`
            INSERT INTO deployments (service, version, deployer, status, start_time)
            VALUES ($1, $2, $3, $4, $5)
            RETURNING id
        `, d.Service, d.Version, d.Deployer, d.Status, d.StartTime).Scan(&d.ID)

        if err != nil {
            http.Error(w, err.Error(), 500)
            return
        }

        json.NewEncoder(w).Encode(d)
    })

    http.HandleFunc("PATCH /deployments/{id}", func(w http.ResponseWriter, r *http.Request) {
        id := r.PathValue("id")

        var update struct {
            Status string `json:"status"`
        }
        json.NewDecoder(r.Body).Decode(&update)

        now := time.Now()
        _, err := db.Exec(`
            UPDATE deployments
            SET status = $1, end_time = $2
            WHERE id = $3
        `, update.Status, now, id)

        if err != nil {
            http.Error(w, err.Error(), 500)
            return
        }

        w.WriteHeader(http.StatusOK)
    })

    http.HandleFunc("GET /deployments/metrics", func(w http.ResponseWriter, r *http.Request) {
        var metrics struct {
            TotalToday     int     `json:"total_today"`
            SuccessRate    float64 `json:"success_rate"`
            AvgDuration    float64 `json:"avg_duration_seconds"`
            FailedRecently int     `json:"failed_recently"`
        }

        db.QueryRow(`
            SELECT
                COUNT(*) as total,
                AVG(CASE WHEN status = 'success' THEN 1.0 ELSE 0.0 END) as success_rate,
                AVG(EXTRACT(EPOCH FROM (end_time - start_time))) as avg_duration
            FROM deployments
            WHERE start_time > NOW() - INTERVAL '24 hours'
        `).Scan(&metrics.TotalToday, &metrics.SuccessRate, &metrics.AvgDuration)

        json.NewEncoder(w).Encode(metrics)
    })

    http.ListenAndServe(":8080", nil)
}
```

---

### Junior → FAANG: Notifications That Are Actually Useful

Pipeline notifications are only valuable if they lead to action. A Slack channel that receives every CI run result, including the successful ones, quickly becomes noise that everyone ignores, including the failure notifications. The notification strategy should filter aggressively: notify on failure (not success), notify only when the failure is on a protected branch (PRs fail silently, encouraging the author to check before review), and include enough context in the notification to enable immediate action (which step failed, link to the failing run, link to the relevant logs).

The practical configuration: failure notifications to a team Slack channel for main branch failures, direct message to the PR author for PR failures, and a weekly digest of flaky test rates and build time trends to the team lead. This tiered approach ensures that critical failures get immediate attention without drowning the team in noise.

First-job habit: check whether your team's CI notification configuration leads to action. If the team has a shared Slack channel with CI notifications and nobody responds to failures within 30 minutes, the notification is not working. Either the channel is too noisy (signal is lost in noise) or the ownership of failures is unclear (nobody feels responsible to act). Both are problems worth raising.

### Senior @ FAANG: Pipeline Observability and the CI Feedback Loop

At staff level, pipeline notifications are part of a broader pipeline observability system. The goal is not just to notify when something is broken, but to provide enough context that the right person can take the right action immediately, without additional investigation.

The data that a well-designed pipeline observability system tracks: per-stage pass/fail rate over time (to detect regressions in specific stages), per-test pass/fail rate (to identify and quarantine flaky tests), per-service build time trend (to detect build time regressions before they become painful), and deployment success rate per environment (to detect environments that are receiving consistently broken deployments).

The incident correlation feature is the highest-value capability: when a production incident is detected (SLO alert fires), automatically surface recent deployments to that service, their success rate, and the specific changes they contained. This correlates the incident with its likely cause in seconds rather than minutes, directly reducing mean-time-to-detect. Building this correlation between the deployment system and the alerting system is an L6/L7 reliability engineering contribution that requires integration across multiple platforms (CI/CD system, monitoring system, incident management system).
