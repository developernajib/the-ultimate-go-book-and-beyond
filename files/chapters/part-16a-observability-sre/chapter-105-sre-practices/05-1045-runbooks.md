## 105.5 Runbooks

### Runbook Template

Runbooks document the diagnostic and remediation steps for known failure modes, enabling on-call engineers to resolve incidents quickly and consistently under stress. The following template captures the alert trigger, impact assessment, investigation queries, and mitigation actions for a specific failure scenario.

```go
package runbook

import (
    "fmt"
    "strings"
)

type Runbook struct {
    Title           string
    AlertName       string
    Severity        string
    Description     string
    Impact          string
    DiagnosticSteps []Step
    MitigationSteps []Step
    Escalation      EscalationPath
    RelatedRunbooks []string
}

type Step struct {
    Order       int
    Description string
    Command     string
    Expected    string
    Notes       string
}

type EscalationPath struct {
    Level1 string
    Level2 string
    Level3 string
}

// Example runbook for high error rate
var HighErrorRateRunbook = Runbook{
    Title:       "High Error Rate",
    AlertName:   "HighErrorRate",
    Severity:    "P2",
    Description: "Error rate exceeds 5% threshold",
    Impact:      "Users experiencing failures on requests",
    DiagnosticSteps: []Step{
        {
            Order:       1,
            Description: "Check current error rate",
            Command:     `curl -s "http://prometheus:9090/api/v1/query?query=sum(rate(http_requests_total{status=~\"5..\"}[5m]))/sum(rate(http_requests_total[5m]))"`,
            Expected:    "Should show error rate > 0.05",
        },
        {
            Order:       2,
            Description: "Identify error patterns",
            Command:     `kubectl logs -l app=go-service --tail=100 | grep -i error | head -20`,
            Expected:    "Look for common error messages",
        },
        {
            Order:       3,
            Description: "Check recent deployments",
            Command:     `kubectl rollout history deployment/go-service`,
            Expected:    "Identify if recent deployment correlates with errors",
        },
        {
            Order:       4,
            Description: "Check downstream dependencies",
            Command:     `curl -s "http://prometheus:9090/api/v1/query?query=up{job=\"dependencies\"}"`,
            Expected:    "All dependencies should be up (value=1)",
        },
        {
            Order:       5,
            Description: "Check database connectivity",
            Command:     `kubectl exec -it deploy/go-service -- pg_isready -h $DB_HOST`,
            Expected:    "Should return 'accepting connections'",
        },
    },
    MitigationSteps: []Step{
        {
            Order:       1,
            Description: "If recent deployment: rollback",
            Command:     `kubectl rollout undo deployment/go-service`,
            Notes:       "Only if deployment correlates with errors",
        },
        {
            Order:       2,
            Description: "Scale up if capacity issue",
            Command:     `kubectl scale deployment/go-service --replicas=10`,
            Notes:       "Temporary measure while investigating",
        },
        {
            Order:       3,
            Description: "Enable circuit breaker for failing dependency",
            Command:     `kubectl set env deployment/go-service CIRCUIT_BREAKER_ENABLED=true`,
            Notes:       "Fails fast instead of cascading failures",
        },
    },
    Escalation: EscalationPath{
        Level1: "On-call engineer",
        Level2: "Service team lead",
        Level3: "Engineering manager + SRE lead",
    },
    RelatedRunbooks: []string{
        "DatabaseConnectionIssues",
        "HighLatency",
        "DependencyFailure",
    },
}

// GenerateMarkdown creates markdown documentation
func (r Runbook) GenerateMarkdown() string {
    var sb strings.Builder

    sb.WriteString(fmt.Sprintf("# %s\n\n", r.Title))
    sb.WriteString(fmt.Sprintf("**Alert:** %s\n", r.AlertName))
    sb.WriteString(fmt.Sprintf("**Severity:** %s\n\n", r.Severity))
    sb.WriteString(fmt.Sprintf("## Description\n%s\n\n", r.Description))
    sb.WriteString(fmt.Sprintf("## Impact\n%s\n\n", r.Impact))

    sb.WriteString("## Diagnostic Steps\n\n")
    for _, step := range r.DiagnosticSteps {
        sb.WriteString(fmt.Sprintf("### %d. %s\n", step.Order, step.Description))
        sb.WriteString(fmt.Sprintf("```bash\n%s\n```\n", step.Command))
        sb.WriteString(fmt.Sprintf("**Expected:** %s\n\n", step.Expected))
    }

    sb.WriteString("## Mitigation Steps\n\n")
    for _, step := range r.MitigationSteps {
        sb.WriteString(fmt.Sprintf("### %d. %s\n", step.Order, step.Description))
        sb.WriteString(fmt.Sprintf("```bash\n%s\n```\n", step.Command))
        if step.Notes != "" {
            sb.WriteString(fmt.Sprintf("**Note:** %s\n\n", step.Notes))
        }
    }

    sb.WriteString("## Escalation Path\n")
    sb.WriteString(fmt.Sprintf("1. %s\n", r.Escalation.Level1))
    sb.WriteString(fmt.Sprintf("2. %s\n", r.Escalation.Level2))
    sb.WriteString(fmt.Sprintf("3. %s\n", r.Escalation.Level3))

    return sb.String()
}
```

### Junior → FAANG: Runbooks Are Documentation You Read Under Pressure

A runbook that requires reading the entire document to understand what to do is useless during an incident. The most important runbook design principle is progressive disclosure: the first section tells you what is happening and gives the most likely fix in under 60 seconds. The later sections provide diagnostic steps for less common causes and escalation paths.

For a first job, write a runbook for every alert you own. Even if the runbook is just five bullet points, it forces you to think through what the alert means, what you should check first, and who to escalate to. The discipline of writing runbooks before incidents is what separates engineers who respond well under pressure from those who improvise.

### Senior @ FAANG: Runbook Governance and Automation

At L6, runbooks are maintained as code (in a git repository with the same review process as code) and linked directly from alert annotations. A runbook that is not linked from an alert is an undiscoverable document. A runbook that is outdated (refers to services or commands that no longer exist) is actively harmful, because an engineer following it during an incident will waste time on dead ends.

The platform team implements runbook quality gates: every alert must have a `runbook_url` annotation pointing to a valid URL (tested in CI), and runbooks must be reviewed after every incident where they were used. When a runbook step fails or misleads an engineer, the post-mortem action item is "update the runbook," not "the engineer should have known better."

At staff level, the goal is runbook automation: if a runbook step can be executed programmatically (restart a service, drain a node, flush a cache), it should be a button in the incident management tool rather than a manual command. Automating the top five runbook actions for the highest-frequency alerts can reduce MTTR by 50% or more.

---
