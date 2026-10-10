## 94.13 Your First On-Call Experience

Going on-call for the first time is one of the most anxiety-inducing experiences for new engineers, but it is also one of the fastest ways to learn a system deeply. When you are responsible for keeping a service running, you develop a much richer understanding of how it works, what can go wrong, and how the pieces fit together. The goal of this section is to help you prepare thoroughly so that when you do get paged, you have a clear process to follow rather than relying on panic and guesswork.

### Preparing for On-Call

Effective on-call preparation happens before the first page arrives, not during it. The goal is to build a mental model of what "healthy" looks like for each service so that anomalies in dashboards and logs are immediately recognizable, you cannot diagnose a problem in a system you have never observed under normal conditions. Walking through existing runbooks, triggering non-critical alerts in a staging environment, and shadowing a senior engineer during their rotation are the three highest-leverage activities for compressing this learning curve.

```markdown
# Preparing for Your First On-Call Rotation

## TIMELINE:

### Before You Go On-Call:
Week -4: Shadow current on-call engineer
Week -2: Secondary on-call (backup, observe)
Week -1: Review runbooks, practice procedures
Day 0: Primary on-call (with senior backup)

## PRE-ON-CALL CHECKLIST:

### Access:
□ PagerDuty/Opsgenie account configured
□ Phone notifications working
□ Laptop configured for remote access
□ VPN works from home
□ Access to production systems
□ Access to monitoring dashboards
□ Access to logging systems

### Knowledge:
□ Read all runbooks for your services
□ Understand escalation procedures
□ Know who to contact for different issues
□ Understand SLAs and priorities
□ Practiced common procedures

### Setup:
□ Phone charged, not on silent
□ Backup notification method (email/Slack)
□ Can access systems from phone if needed
□ Know where laptop is if paged overnight
□ Partner/family knows you might be paged

## SHADOWING CHECKLIST:

When shadowing someone on-call, observe:
□ How they respond to pages
□ What dashboards they check first
□ How they communicate in incident channels
□ When they escalate vs. handle alone
□ How they update stakeholders
□ How they write postmortems
```

### Handling Your First Incident

```markdown
# First Incident Response Guide

## WHEN YOU GET PAGED:

### First 5 Minutes:
1. Acknowledge the page
2. Take a breath - you have time to think
3. Open monitoring dashboard
4. Check if it's a real incident or false alarm
5. If real, join the incident channel

### Initial Assessment (5-15 minutes):

The first 15 minutes of an incident determine whether you spend the next hour fixing the right thing or chasing a red herring. Answering these five questions in order establishes blast radius before you touch anything: knowing whether the problem is worsening and what recently changed often narrows the cause from dozens of possibilities to one or two, preventing the common mistake of rolling back an innocent deploy while the real culprit keeps running.

```
Questions to answer quickly:
1. What's the impact? (Users affected?)
2. Is it getting worse?
3. What changed recently?
4. Is this a known issue with a runbook?
5. Do I need to escalate immediately?
```

### If You're Unsure:
IT IS OKAY TO ESCALATE
- Better to wake someone up unnecessarily
  than to let an incident grow
- Say: "I'm seeing X, I've tried Y, I'm not sure
  how to proceed and want another set of eyes"

### Communication Template:

During an incident, stakeholders need a single source of truth that answers "what happened, who is on it, and what is being done" without requiring them to interrupt the responder. This template enforces the discipline of separating observable facts (timeline) from current theory, which prevents confirmation bias from hardening a wrong hypothesis into assumed truth before the root cause is actually identified.

```
🔴 INCIDENT: [Service] - [Brief description]

Impact: [Who/what is affected]
Status: Investigating / Mitigating / Resolved

Timeline:
- HH:MM - Alert triggered
- HH:MM - [Person] acknowledged
- HH:MM - [Action taken]

Current theory: [What we think is happening]
Next steps: [What we're trying]

Updates: Will update every 15 min or on change
```

## COMMON FIRST-INCIDENT MISTAKES:

### Mistake 1: Panicking
WRONG: Frantically trying random things
RIGHT: Follow runbook, escalate if unsure

### Mistake 2: Not Communicating
WRONG: Silently investigating for an hour
RIGHT: Update incident channel every 15 minutes

### Mistake 3: Not Escalating
WRONG: Struggling alone for 2 hours at 3 AM
RIGHT: Wake someone up after 30 min if stuck

### Mistake 4: Forgetting to Document
WRONG: Fixing and going back to sleep
RIGHT: Note what you did, write postmortem

### Mistake 5: Making Changes Without Telling Anyone
WRONG: Pushing a fix without announcing
RIGHT: "I'm about to [action]. Any concerns?"
```

### Building On-Call Confidence

```go
// Example: On-Call Checklist Application in Go

package main

import (
    "bufio"
    "fmt"
    "os"
    "time"
)

// IncidentChecklist guides new on-call engineers through incident response
type IncidentChecklist struct {
    StartTime     time.Time
    Acknowledged  bool
    Assessed      bool
    Communicated  bool
    Steps         []Step
}

type Step struct {
    Name      string
    Question  string
    Completed bool
    Answer    string
}

func NewIncidentChecklist() *IncidentChecklist {
    return &IncidentChecklist{
        StartTime: time.Now(),
        Steps: []Step{
            {Name: "Acknowledge", Question: "Have you acknowledged the page?"},
            {Name: "Impact", Question: "What's the user impact? (None/Low/Medium/High/Critical)"},
            {Name: "Scope", Question: "What services/systems are affected?"},
            {Name: "Recent Changes", Question: "What changed in the last 24 hours?"},
            {Name: "Runbook", Question: "Is there a runbook for this? Have you checked?"},
            {Name: "Communication", Question: "Have you posted in the incident channel?"},
            {Name: "Escalation", Question: "Do you need to escalate? (If unsure for >30min, yes)"},
            {Name: "Mitigation", Question: "What's your mitigation plan?"},
        },
    }
}

func (c *IncidentChecklist) Run() {
    scanner := bufio.NewScanner(os.Stdin)

    fmt.Println("🚨 INCIDENT RESPONSE CHECKLIST")
    fmt.Printf("Started: %s\n\n", c.StartTime.Format("15:04:05"))

    for i, step := range c.Steps {
        fmt.Printf("[%d/%d] %s\n", i+1, len(c.Steps), step.Name)
        fmt.Printf("    Q: %s\n", step.Question)
        fmt.Print("    A: ")

        scanner.Scan()
        c.Steps[i].Answer = scanner.Text()
        c.Steps[i].Completed = true

        elapsed := time.Since(c.StartTime)
        if elapsed > 30*time.Minute && !c.hasEscalated() {
            fmt.Println("\n⚠️  30 minutes elapsed - consider escalating!")
        }
        fmt.Println()
    }

    c.printSummary()
}

func (c *IncidentChecklist) hasEscalated() bool {
    for _, s := range c.Steps {
        if s.Name == "Escalation" && s.Completed {
            return s.Answer != "" && s.Answer != "no"
        }
    }
    return false
}

func (c *IncidentChecklist) printSummary() {
    fmt.Println("📋 INCIDENT SUMMARY")
    fmt.Println("==================")
    for _, step := range c.Steps {
        fmt.Printf("- %s: %s\n", step.Name, step.Answer)
    }
    fmt.Printf("\nDuration so far: %s\n", time.Since(c.StartTime))
}

func main() {
    checklist := NewIncidentChecklist()
    checklist.Run()
}
```

### On-Call Best Practices from Top Companies

```markdown
# On-Call Practices at Top Companies

## GOOGLE SRE MODEL:

### Key Principles:
- 50% cap on ops work (rest is development)
- Error budgets drive reliability vs. velocity
- Blameless postmortems
- Shared on-call between Dev and SRE

### On-Call Structure:
- Primary and secondary on-call
- 12-hour shifts (day/night)
- Maximum 2 incidents per shift (ideal)
- Handoff documentation required

### New Hire On-Call Path:
1. Training on monitoring and tools
2. Shadow experienced SRE for 2 weeks
3. Secondary on-call for 2 rotations
4. Primary with experienced secondary
5. Full primary after demonstrating competence

## NETFLIX:

### "Freedom and Responsibility":
- Engineers own their services end-to-end
- On-call is for the team that built it
- No separate ops team

### On-Call Philosophy:
- You build it, you run it
- On-call pain drives better engineering
- Focus on reducing pages, not just handling them

### For New Engineers:
- Join on-call after demonstrating system knowledge
- Usually month 2-3
- Always paired with veteran initially

## META:

### Bootcamp On-Call:
- Don't join on-call during bootcamp
- After team placement, gradual introduction
- Shadow → Secondary → Primary path

### Severity Levels:
- SEV0: All hands on deck
- SEV1: Primary on-call + manager
- SEV2: Primary on-call
- SEV3: Next business day

### On-Call Expectations:
- Acknowledge within 5 minutes
- Escalate within 15 if can't resolve
- Update every 30 minutes for active incidents

## AMAZON:

### "Ops is Everyone's Job":
- Weekly ops review meetings
- COE (Correction of Errors) for incidents
- On-call from early in tenure

### On-Call Ramp:
- Shadow within first month
- On-call in month 2 typically
- Fast ramp due to ownership culture

### COE Culture:
- Detailed incident analysis
- Focus on process improvement
- No blame, only learning
```

### Junior → FAANG: Approaching On-Call as an Accelerated Learning Opportunity

On-call is uncomfortable for new engineers because it surfaces knowledge gaps in real time, under pressure, with production consequences. The engineers who handle this well treat it as deliberately accelerated learning: every page is a question the system is asking you about how it works, and every incident resolution is a concrete answer that becomes part of your mental model.

The most important on-call preparation is reading recent post-mortems before your first rotation. Post-mortems describe the actual failure modes the system has experienced, the symptoms that appeared, and the remediation steps that worked. Reading five to ten recent post-mortems before going on-call means that when you get paged for a known failure pattern, you have a starting hypothesis rather than starting from zero.

Shadow on-call for at least two weeks before taking primary responsibility. During shadow periods, treat every page as practice: write down what you would do before asking the primary on-call what they are doing. Compare your approach with theirs and understand the differences. This builds the on-call judgment that can only be developed through experience, accelerating your ramp.

### Senior @ FAANG: On-Call Governance at Senior Level and the Runbook Standard

At senior level, your role in the on-call rotation includes not just responding to incidents but improving the team's ability to respond to future incidents. After each incident you handle or observe, ask whether the runbook was sufficient: was the diagnostic information available and actionable, was the remediation step clearly described, and are there automation opportunities that would reduce the MTTR for this class of incident.

The governance standard for senior on-call ownership is that the runbooks in your domain should be self-sufficient for an L4 engineer to follow during a page. If an incident requires senior-level judgment to resolve and that judgment is not captured in the runbook, the runbook is incomplete. Senior engineers who maintain high-quality runbooks are multiplying their operational knowledge across the team rather than hoarding it as indispensable expertise.

Production incident governance at L6 also includes post-mortem quality standards. Post-mortems should identify systemic causes, not individual contributors. They should produce specific actionable items with owners and deadlines. And they should be shared with adjacent teams when the failure mode is not unique to the immediate system. Senior engineers who push for higher-quality post-mortems are doing organizational improvement work that extends beyond their immediate team.

---
