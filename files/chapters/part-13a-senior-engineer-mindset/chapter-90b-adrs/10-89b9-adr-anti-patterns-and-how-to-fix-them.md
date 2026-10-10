## 90B.9 ADR Anti-Patterns and How to Fix Them

While the previous section on common mistakes focused on problems within a single ADR, anti-patterns are systemic problems in how an organization uses ADRs as a whole. These are the failure modes that cause entire teams to abandon the practice, not because ADRs are a bad idea, but because the implementation went wrong. If your team has tried ADRs before and given up, one or more of these anti-patterns is likely the reason. Each anti-pattern includes a diagnostic test so you can recognize it early and a concrete fix to get back on track.

Section 90B.6 covered tactical mistakes in writing individual ADRs. This section addresses structural anti-patterns - failure modes in how ADRs are used across a team or organization.

### Anti-Pattern 1: The Retrospective ADR

**What it looks like**: An ADR written three months after the system was built, as a documentation exercise before an architecture review. The decision was already made. The ADR is a post-hoc rationalization.

**How to spot it**: The proposed date is months before the accepted date, or there is no proposed phase at all - the ADR was created directly in Accepted state. The "considered options" section lists alternatives that were never seriously evaluated. The consequences section is uniformly positive.

**Why it is harmful**: A retrospective ADR provides the appearance of a disciplined process without the substance. Future engineers trust it as a record of deliberate evaluation. The missing constraint that actually drove the decision - a deadline, an existing vendor contract, a VP preference - is invisible. When those constraints change, the decision is reconsidered without the real context.

**Fix**: Write retrospective ADRs with an explicit disclaimer:

```markdown

## Status
Accepted (retrospective - written after implementation)

## Note on This Record
This ADR was written retrospectively to document a decision made on
approximately [date]. The alternatives evaluation reflects the authors'
best reconstruction of what was considered, not a verbatim record of the
deliberation. Key constraints at the time included: [list them honestly].
```

A retrospective ADR with this disclaimer is far more valuable than either a fabricated clean-room ADR or no documentation at all.

### Anti-Pattern 2: The Tool, Not the Decision

**What it looks like**: An ADR titled "Use Prettier for Code Formatting" or "Migrate from npm to pnpm." These are tool choices that take ten minutes to reverse and affect no external systems.

**Why it is harmful**: Tool ADRs dilute the ADR corpus. When an engineer searches ADRs for guidance on a hard architectural decision, they wade through a list of trivial tool choices. The signal-to-noise ratio degrades until engineers stop reading ADRs entirely.

**The test**: Would reversing this decision require coordination across teams? Would it take more than a sprint to undo? Would a new engineer wonder "why?" when encountering it in the codebase? If the answer to all three is no, it is not an ADR.

**Fix**: Use a team decision log (a `docs/decisions.md` file or a Notion table) for reversible, low-stakes tool choices. Reserve ADRs for decisions that score at least two "yes" answers on the test above.

### Anti-Pattern 3: Decision Paralysis Through Over-Documentation

**What it looks like**: A team that requires an ADR for every significant decision produces so many ADRs in flight that no individual ADR gets adequate review. Six ADRs in Proposed state sit for three weeks while engineers debate the perfect format. Decisions are delayed waiting for the ADR process to complete.

**Why it is harmful**: The ADR process becomes a bottleneck rather than a governance tool. Engineers route around it by making decisions informally and backfilling paperwork.

**Fix**: Time-box the review process. In the ADR template, add:

```markdown

## Review Deadline
[Date - typically 5 business days from Proposed]

If no blocking objections are raised by this date and all required reviewers
have approved, this ADR advances to Accepted automatically.
```

Also apply the ADR threshold strictly: not every decision warrants an ADR. Keeping the corpus small keeps review velocity high.

### Anti-Pattern 4: The Permanent Proposed ADR

**What it looks like**: ADRs that have been in Proposed state for months. The decision was discussed, never formally concluded, and the ADR sits in limbo. The system was built using one option. The ADR records a different option as proposed.

**Why it is harmful**: Engineers reading the ADR index see an open decision and spend time investigating what was actually built, only to discover the ADR is stale. Proposed ADRs imply the decision is still open. Stale proposed ADRs create false uncertainty.

**Fix**: If a proposed ADR has not advanced within the review window, it must be explicitly withdrawn or rejected. Add a Withdrawn status for proposals that were abandoned:

```markdown

## Status
Withdrawn - 2025-08-15

The team proceeded with [alternative] without a formal ADR decision. See [commit SHA]
for the implementation. A retrospective ADR will be written under ADR-NNNN.
```

### Anti-Pattern 5: The Monolithic ADR

**What it looks like**: An ADR that is fifteen pages long, covers three interrelated decisions, includes a full design document as an appendix, and has been in review for four weeks because reviewers keep adding comments.

**Why it is harmful**: Long ADRs are not read. The review process drags because reviewers cannot find the decision amid the context. The structure breaks the principle that an ADR is a decision record, not a design document.

**Fix**: The one-decision rule. If your ADR covers more than one distinct decision, split it. If it exceeds three pages, extract the supporting analysis into a linked design document and reference it from the ADR's Links section.

### Anti-Pattern 6: ADRs Without Owners

**What it looks like**: ADRs that list no deciders, no author, and no reviewers. Anonymous ADRs with no human accountability.

**Why it is harmful**: When an ADR needs to be superseded or a question arises about the original decision, there is no one to ask. The Deciders section exists precisely to identify who can be consulted about the reasoning that was not captured in writing.

**Fix**: Mandate the Deciders field in your CI lint check. An ADR with no Deciders field fails the pipeline.

```go
// In the ADR linter:
func checkDeciders(content string) error {
    if !strings.Contains(content, "## Deciders") {
        return fmt.Errorf("ADR missing required '## Deciders' section")
    }
    // Check that the section is not empty.
    re := regexp.MustCompile(`(?s)## Deciders\s*\n(.*?)(?:\n##|\z)`)
    m := re.FindStringSubmatch(content)
    if m == nil || strings.TrimSpace(m[1]) == "" {
        return fmt.Errorf("ADR '## Deciders' section is empty")
    }
    return nil
}
```

### Junior → FAANG: Spotting Anti-Patterns Before They Calcify

Anti-patterns in ADR writing are easiest to fix during the initial review, before the ADR is merged and before the decision becomes the accepted baseline. As a junior engineer reviewing an ADR (or reviewing your own draft), apply the structural checks described in this section as a final step before submitting for review.

The "deciders missing" anti-pattern is worth special attention. An ADR with no named deciders is an orphan document: nobody is accountable for the quality of the decision or the accuracy of the documentation. In a FAANG interview, if you describe an ADR you wrote that had no named deciders, you will be asked why. The correct answer is that named accountability is essential to the document's function as a governance artifact. The wrong answer is that you did not think it mattered.

### Senior @ FAANG: Linting ADRs as a Maturity Signal

The Go linter in this section, which validates structural requirements programmatically, is a maturity signal for an ADR practice. Teams at FAANG that have implemented automated ADR linting have made a commitment to the practice that goes beyond social norms: they have invested in tooling that enforces the standard consistently, without relying on human reviewers to remember to check.

The linter catches structural anti-patterns but cannot catch semantic ones: a section that is present but content-free ("alternatives: none considered") passes the linter but fails the governance test. The human review layer exists specifically to catch semantic anti-patterns. Staff engineers reviewing ADRs should not read quickly looking for problems. They should read slowly with the specific question: does this document give a future engineer enough context to understand the decision without asking anyone?

At the L7 level, the anti-pattern of "ADRs as compliance theater" is the most important to address. This anti-pattern manifests when an organization has the form of an ADR practice (templates exist, ADRs are written, a directory is maintained) but not the substance (ADRs are written post-hoc, alternatives sections are perfunctory, nobody references ADRs when making new decisions). Diagnosing this anti-pattern requires asking engineering teams, not just checking the ADR corpus. If engineers cannot name an ADR that changed a decision they were about to make, the practice is theater. If they can, the practice is functional.

---
