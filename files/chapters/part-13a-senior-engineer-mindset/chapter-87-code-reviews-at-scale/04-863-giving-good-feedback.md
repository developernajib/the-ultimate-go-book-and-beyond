## 87.3 Giving Good Feedback

### The Feedback Ladder

Not all review feedback carries the same weight, and failing to communicate priority is one of the most common review mistakes. The feedback ladder is a system for categorizing your comments so the author knows which issues must be fixed before merging and which are optional suggestions. Using clear categories like "blocking," "suggestion," and "nit" prevents authors from guessing at your intent and keeps the review process efficient.

```
┌──────────────────────────────────────────────────────────────────┐
│                   FEEDBACK PRIORITY                              │
├──────────────────────────────────────────────────────────────────┤
│                                                                  │
│  BLOCKING (Must fix before merge):                               │
│  ├── Bugs that will break production                             │
│  ├── Security vulnerabilities                                    │
│  ├── Data corruption risks                                       │
│  └── Missing error handling that could crash                     │
│                                                                  │
│  SHOULD FIX (Strongly recommended):                              │
│  ├── Logic issues that may cause future bugs                     │
│  ├── Missing tests for critical paths                            │
│  ├── Performance issues under expected load                      │
│  └── Significant code clarity problems                           │
│                                                                  │
│  SUGGESTIONS (Nice to have):                                     │
│  ├── Alternative approaches                                      │
│  ├── Minor refactoring ideas                                     │
│  ├── Style improvements beyond linter                            │
│  └── Documentation additions                                     │
│                                                                  │
│  PRAISE (Include these!):                                        │
│  ├── Clever solutions                                            │
│  ├── Good test coverage                                          │
│  ├── Clear documentation                                         │
│  └── Improvement from previous code                              │
│                                                                  │
│  NITPICKS (Mark clearly as nit:):                                │
│  ├── Minor style preferences                                     │
│  ├── Naming suggestions                                          │
│  └── "Take it or leave it" comments                              │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘
```

### Writing Constructive Comments

The way you phrase review comments has an enormous impact on how they are received. A comment that says "this is wrong" gives the author no information about what to fix or why, and can feel like a personal attack. Good review comments are specific about the problem, explain the consequence, and suggest a path forward. The following table contrasts poor comments with constructive alternatives.

```
BAD COMMENTS                    GOOD COMMENTS
──────────────────────────────────────────────────────────────────

"This is wrong"                 "This could cause a nil pointer
                                dereference if GetUser returns nil.
                                Consider adding a nil check here."

"Why did you do it this way?"   "I'm curious about this approach.
                                What led you to choose X over Y?
                                I might be missing context."

"This is inefficient"           "This is O(n²) due to the nested
                                loops. For our dataset size (~10K),
                                this could cause timeouts. Consider
                                using a map for O(n) lookup."

"Use a different name"          "nit: Consider `usersByID` instead
                                of `m` for clarity. The current
                                name doesn't convey the map's
                                purpose."

"LGTM"                          "LGTM! Really like how you
                                structured the error handling here.
                                The table-driven tests are clear."

"Fix this"                      "This needs to handle the case
                                where the slice is empty. Something
                                like: `if len(items) == 0 { return
                                nil, ErrEmptyList }`"
```

### Comment Templates

Having ready-made templates for common review comment types helps you write faster, more consistent feedback. These templates ensure you always include the key elements: what the issue is, why it matters, and what to do about it. Over time, using structured templates becomes second nature and raises the quality of your entire team's review culture.

````markdown

## For blocking issues:
**Blocking**: [Description of issue]

This could cause [consequence]. Consider [solution].

Example:
**Blocking**: Missing error check on line 42

If `db.Query()` fails, we'll get a nil pointer panic on line 45.

```go
rows, err := db.Query(query)
if err != nil {
    return fmt.Errorf("query users: %w", err)
}
defer rows.Close()
```

## For suggestions:
**Suggestion**: [Title]

[Explanation of why this might be better]

Optional, but could improve [readability/performance/etc].

## For questions:
**Question**: [Your question]

I want to understand [context]. Is [assumption] correct?

## For praise:
**Nice!** [What you liked]

This is a clean solution to [problem].

## For nitpicks:
**nit**: [Minor suggestion]

Take it or leave it: [suggestion]
````

### Junior → FAANG: The Feedback Ladder as an Interview Signal

Interviewers at FAANG companies actively look for whether candidates can distinguish blocking from non-blocking feedback. A candidate who has never made this distinction explicit has not developed the reviewer judgment that senior-level roles require.

In behavioral interviews, when describing a code review you gave, explicitly name the category of your feedback. "I left a blocking comment explaining the race condition" and "I left a suggestion for an alternative approach, but I approved the PR" both signal calibrated judgment. "I left a comment" signals nothing.

The praise category is often skipped by junior reviewers who feel uncomfortable appearing sycophantic. Resist this instinct. FAANG review cultures explicitly value positive feedback because it reinforces the behaviors you want repeated. A reviewer who never praises is leaving half their mentorship tool unused.

### Senior @ FAANG: Feedback Quality as a Team Culture Lever

At L6 and above, the quality of review feedback across your team is a measurable cultural indicator. Teams where feedback is consistently vague ("this doesn't seem right"), or where non-blocking feedback is routinely treated as blocking, have a review culture problem that accumulates organizational debt.

Staff engineers who want to improve team feedback quality start by modeling the behavior explicitly and visibly. When you write a review comment that follows the template structure (category, observation, consequence, suggestion), you are demonstrating the standard. When you then point to your own comment in a team discussion and explain why you structured it that way, you are teaching the standard. Documentation helps but behavior modeling changes practice.

The praise dimension has an organizational retention implication that is rarely tracked explicitly. Engineers who receive consistent positive feedback in code reviews report higher satisfaction with their team environment and lower intent to leave. Staff engineers who create cultures where good work is explicitly recognized, not just where bad work is corrected, are investing in retention without a budget line item. The easiest way to start is to write one genuine "Nice!" comment per review and explain why the code is good. That habit, propagated across a team, changes the emotional experience of the review process for everyone.

---
