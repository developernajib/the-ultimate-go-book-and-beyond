## 23.10 Post-Mortem Culture

Chaos experiments are only valuable if you learn from their results. A blameless post-mortem culture ensures that when an experiment or a real incident reveals a weakness, the team documents what happened, why it happened, and what concrete actions will prevent it from happening again. The key metrics to track are Time to Detection (TTD), Time to Mitigation (TTM), and Time to Resolution (TTR). The Go types below model an incident report and render it.

### Incident Template

Structuring incident data in Go rather than in a free-form document enforces completeness. Every post-mortem records timestamps for detection, mitigation, and resolution, which makes the duration metrics arithmetic rather than recollection. The `ActionItem` type makes follow-up work first-class data with an owner, due date, and status, which addresses the most common failure mode in the whole practice: action items noted in a document and never tracked to closure. Typed incidents also enable analysis across many reports, such as sorting by `TTD` to find which service classes are hardest to detect failures in.

Two things decide whether this type earns its keep, and both are easy to get wrong.

**Most reports are written while the incident is still open.** The struct has four timestamps and, at the moment someone starts the doc, usually only two of them are set. A naive `TTM()` of `MitigationTime.Sub(DetectionTime)` against a zero `MitigationTime` does not return zero, it returns `-2562047h47m16.854775808s`, because subtracting a real time from year 1 underflows into the minimum `time.Duration`. The report then prints "Mitigated: 0001-01-01T00:00:00Z" next to a negative duration the width of the universe. Make the phase metrics return an `ok` flag and render the incomplete phases as pending.

**Be explicit about what each metric measures from.** TTD runs from start to detection, TTM from *detection* to mitigation, and TTR from *start* to resolution. Those are the conventional definitions and they use different baselines on purpose, so TTD plus TTM does not equal TTR and was never meant to. Write the baseline into the comment on each method, because someone will otherwise "fix" the inconsistency and quietly change the meaning of a metric the org tracks quarter over quarter.

```go
package chaos

import (
    "fmt"
    "strings"
    "time"
)

type Severity string

const (
    SevP0 Severity = "P0" // Total outage, revenue-impacting.
    SevP1 Severity = "P1" // Major degradation, SLO breached.
    SevP2 Severity = "P2" // Partial degradation, SLO at risk.
    SevP3 Severity = "P3" // Minor, no customer impact.
)

type Status string

const (
    StatusOpen       Status = "open"
    StatusInProgress Status = "in-progress"
    StatusDone       Status = "done"
)

type Incident struct {
    ID       string
    Title    string
    Severity Severity

    // Zero means "not yet". Every consumer must handle that.
    StartTime      time.Time
    DetectionTime  time.Time
    MitigationTime time.Time
    ResolutionTime time.Time

    ImpactSummary       string
    Timeline            []TimelineEvent
    RootCauses          []string
    ContributingFactors []string
    ActionItems         []ActionItem
    LessonsLearned      []string
}

type TimelineEvent struct {
    Time        time.Time
    Description string
    Actor       string
}

type ActionItem struct {
    Description string
    Owner       string
    DueDate     time.Time
    Priority    string
    Status      Status
}

func (a ActionItem) Pending() bool { return a.Status != StatusDone }

// TTD is start to detection: how long the system was broken before anyone knew.
func (i *Incident) TTD() (time.Duration, bool) {
    return span(i.StartTime, i.DetectionTime)
}

// TTM is detection to mitigation: how long it took to stop the bleeding once
// the team knew. Note the baseline is detection, not start.
func (i *Incident) TTM() (time.Duration, bool) {
    return span(i.DetectionTime, i.MitigationTime)
}

// TTR is start to resolution: total customer-visible duration. It overlaps
// TTD by design, so TTD+TTM != TTR.
func (i *Incident) TTR() (time.Duration, bool) {
    return span(i.StartTime, i.ResolutionTime)
}

// span refuses to do arithmetic on timestamps that have not happened yet.
// Subtracting a real time from the zero time underflows time.Duration.
func span(from, to time.Time) (time.Duration, bool) {
    if from.IsZero() || to.IsZero() {
        return 0, false
    }
    return to.Sub(from), true
}

func (i *Incident) PendingActionItems() []ActionItem {
    var out []ActionItem
    for _, a := range i.ActionItems {
        if a.Pending() {
            out = append(out, a)
        }
    }
    return out
}
```

### Rendering the Report

The rendering half is where a post-mortem template usually betrays its own purpose, so read the requirements against the output.

A `## Root Causes` section that formats a `[]string` with `%v` prints `[TTL synchronised across all keys no request coalescing]`. The two causes run together with no delimiter, and a reader cannot tell where one ends and the next begins. Format slices as lists.

Worse, an `## Action Items` section that prints `len(i.ActionItems)` under the label "%d items pending" is wrong twice over. It counts completed items as pending, so a report with three items of which two are done still claims three are outstanding. And it prints a *number* where the whole argument for the `ActionItem` type was that owners and due dates get tracked. The report drops every owner, every date, and every status. The section that exists to prevent forgotten follow-ups is the one section that forgets them.

Render every field the struct bothers to carry. If a `Timeline` and `ContributingFactors` are worth collecting, they are worth printing. If they are not, delete the fields.

```go
func (i *Incident) GenerateReport() string {
    var b strings.Builder

    fmt.Fprintf(&b, "# Incident Report: %s\n\n", i.Title)
    fmt.Fprintf(&b, "**ID:** %s  \n**Severity:** %s\n\n", i.ID, i.Severity)

    b.WriteString("## Key Metrics\n\n")
    fmt.Fprintf(&b, "- **Start:** %s\n", stamp(i.StartTime))
    fmt.Fprintf(&b, "- **Detected:** %s (TTD: %s)\n", stamp(i.DetectionTime), dur(i.TTD()))
    fmt.Fprintf(&b, "- **Mitigated:** %s (TTM: %s)\n", stamp(i.MitigationTime), dur(i.TTM()))
    fmt.Fprintf(&b, "- **Resolved:** %s (TTR: %s)\n\n", stamp(i.ResolutionTime), dur(i.TTR()))

    fmt.Fprintf(&b, "## Impact\n\n%s\n\n", i.ImpactSummary)

    if len(i.Timeline) > 0 {
        b.WriteString("## Timeline\n\n")
        for _, e := range i.Timeline {
            fmt.Fprintf(&b, "- **%s** (%s) %s\n",
                e.Time.Format("15:04:05"), e.Actor, e.Description)
        }
        b.WriteString("\n")
    }

    b.WriteString(list("Root Causes", i.RootCauses))
    b.WriteString(list("Contributing Factors", i.ContributingFactors))

    pending := i.PendingActionItems()
    fmt.Fprintf(&b, "## Action Items (%d of %d still open)\n\n",
        len(pending), len(i.ActionItems))
    for _, a := range i.ActionItems {
        box := " "
        if !a.Pending() {
            box = "x"
        }
        fmt.Fprintf(&b, "- [%s] %s (owner: %s, due: %s, priority: %s)\n",
            box, a.Description, a.Owner, stamp(a.DueDate), a.Priority)
    }
    b.WriteString("\n")

    b.WriteString(list("Lessons Learned", i.LessonsLearned))
    return b.String()
}

func stamp(t time.Time) string {
    if t.IsZero() {
        return "_pending_"
    }
    return t.Format(time.RFC3339)
}

func dur(d time.Duration, ok bool) string {
    if !ok {
        return "_pending_"
    }
    return d.String()
}

func list(heading string, items []string) string {
    if len(items) == 0 {
        return ""
    }
    var b strings.Builder
    fmt.Fprintf(&b, "## %s\n\n", heading)
    for _, s := range items {
        fmt.Fprintf(&b, "- %s\n", s)
    }
    b.WriteString("\n")
    return b.String()
}
```

An incident still in progress now renders honestly: `Mitigated: _pending_ (TTM: _pending_)` rather than a timestamp from the year 1 and a negative duration.

### Staff Lens: Blameless Postmortems Drive Improvement

Blameless culture means incidents are learning opportunities, not personal failures. Teams that practice this write better postmortems, identify deeper root causes, and ship more durable fixes. Teams with blame cultures hide incidents, produce shallow reports, and repeat the same mistakes.

The mechanism matters as much as the intent. Blamelessness is not a mood, it is what happens when the artifact asks structural questions instead of personal ones. A template with a `RootCauses` slice invites more than one answer and makes "Ana pushed the bad config" visibly incomplete as a cause. A `ContributingFactors` field creates somewhere for "the staging environment does not have the same replica count" to live, which is where the real fix usually hides. And an `ActionItem` with an owner and a due date is what separates a document that changed something from a document that was written.

Track the pending count across incidents. If it only grows, your post-mortems are theatre, and no amount of blamelessness will fix that.

---


### The Timeline Section

The timeline is the backbone of every post-mortem. It records when the incident started, when a human or an alert first noticed (detection), when the bleeding stopped (mitigation), and when the system returned to a fully healthy state (resolution). Those four timestamps yield the three metrics that matter across incidents: TTD tells you whether your alerting works, TTM tells you whether your runbooks and rollback machinery work, and TTR tells you how expensive the whole class of incident is. Write timeline entries as observations with timestamps, not interpretations. The analysis belongs in the root-cause section.


### The Impact Section

Impact is stated in user-visible and business terms, not internal ones. "Checkout error rate reached 14% for 22 minutes, roughly 3,100 failed orders" is an impact statement. "The payments pod restarted" is not. Quantify affected users, failed requests, data loss or corruption if any, and revenue exposure where it can be estimated. This is the section leadership reads first, and it is what justifies (or fails to justify) the engineering time the action items will ask for.


### The Root-Cause Section

Real incidents almost never have a single root cause. They have a trigger (the deploy, the traffic spike, the expired certificate) and a set of contributing conditions that allowed the trigger to become an outage (missing timeout, absent circuit breaker, alert that paged nobody). List all of them. The five-whys technique works when applied honestly: stop only when the answer is a system property you can change, never when it is a person's name.


### The Action-Items Section

An action item without an owner and a due date is a wish. Track each one as first-class data (the `ActionItem` struct in the incident template exists for exactly this reason) and review open items weekly until they close. The strongest signal of a healthy post-mortem culture is not the quality of the documents, it is the closure rate of the action items they produce.


### The Lessons-Learned Section

Lessons learned capture what the incident taught the organization beyond the specific fixes: which assumptions proved wrong, which signals were missed, which parts of the response went well and should be repeated. Good lessons are transferable ("our synthetic checks only exercise the happy path") rather than incident-specific ("service X needed more memory"). Feed them back into chaos experiments: every lesson learned is a hypothesis for the next GameDay.
