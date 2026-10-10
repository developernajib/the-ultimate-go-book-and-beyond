## Exercises

### Exercise 1: Review This Go Code

**Task**: Review the following Go code and provide categorized feedback (blocking, should fix, suggestion, nitpick).

```go
package user

import (
    "database/sql"
    "encoding/json"
    "net/http"
)

var db *sql.DB

type User struct {
    ID    int
    Name  string
    Email string
    Pass  string
}

func CreateUser(w http.ResponseWriter, r *http.Request) {
    var u User
    json.NewDecoder(r.Body).Decode(&u)

    query := "INSERT INTO users (name, email, password) VALUES ('" + u.Name + "', '" + u.Email + "', '" + u.Pass + "')"
    db.Exec(query)

    w.Write([]byte("OK"))
}

func GetUser(w http.ResponseWriter, r *http.Request) {
    id := r.URL.Query().Get("id")
    row := db.QueryRow("SELECT * FROM users WHERE id = " + id)

    var u User
    row.Scan(&u.ID, &u.Name, &u.Email, &u.Pass)

    json.NewEncoder(w).Encode(u)
}
```

**Solution**:

````markdown
# Code Review: User Service

## BLOCKING Issues (Must fix before merge)

### 1. SQL Injection Vulnerability (Security Critical)
**Lines 20-21, 29**

Both `CreateUser` and `GetUser` are vulnerable to SQL injection.

```go
// VULNERABLE:
query := "INSERT INTO users ... VALUES ('" + u.Name + "', ..."

// FIXED - use parameterized queries:
query := "INSERT INTO users (name, email, password) VALUES (?, ?, ?)"
_, err := db.Exec(query, u.Name, u.Email, hashedPassword)
```

This is a critical security vulnerability that could allow
attackers to read/modify/delete all data.

### 2. Passwords Stored in Plain Text
**Line 21**

Passwords must NEVER be stored in plain text.
```go
// Use bcrypt:
hashedPassword, err := bcrypt.GenerateFromPassword([]byte(u.Pass), bcrypt.DefaultCost)
if err != nil {
    http.Error(w, "Internal error", http.StatusInternalServerError)
    return
}
```

### 3. Password Returned in API Response
**Line 34**

`GetUser` returns the password field in the JSON response.
Never expose passwords, even hashed ones.
```go
// Create a response type without password:
type UserResponse struct {
    ID    int    `json:"id"`
    Name  string `json:"name"`
    Email string `json:"email"`
}
```

### 4. Missing Error Handling Throughout
**Lines 18, 21, 30, 32**

Every error is ignored. Database failures, JSON parsing errors,
and scan errors will cause silent failures or panics.
```go
if err := json.NewDecoder(r.Body).Decode(&u); err != nil {
    http.Error(w, "Invalid JSON", http.StatusBadRequest)
    return
}

result, err := db.Exec(query, ...)
if err != nil {
    http.Error(w, "Database error", http.StatusInternalServerError)
    return
}
```

---

## SHOULD FIX (Strongly recommended)

### 5. Global Database Variable
**Line 7**

Global `db` variable makes testing difficult and creates
hidden dependency.
```go
// Use dependency injection:
type UserService struct {
    db *sql.DB
}

func (s *UserService) CreateUser(w http.ResponseWriter, r *http.Request) {
    // use s.db
}
```

### 6. No Input Validation
**Line 18**

User input should be validated before database operations.
```go
if u.Email == "" || u.Name == "" || u.Pass == "" {
    http.Error(w, "Missing required fields", http.StatusBadRequest)
    return
}
if !isValidEmail(u.Email) {
    http.Error(w, "Invalid email format", http.StatusBadRequest)
    return
}
```

### 7. No Request Body Close
**Line 18**

While `json.Decoder` handles this for `r.Body`, it's good practice
to be explicit about resource cleanup.

---

## SUGGESTIONS (Nice to have)

### 8. Add Context Support
For proper timeout handling and cancellation:
```go
func (s *UserService) CreateUser(ctx context.Context, w http.ResponseWriter, r *http.Request) {
    _, err := s.db.ExecContext(ctx, query, ...)
}
```

### 9. Add Structured Logging

Structured logging replaces free-form strings with key-value pairs, making logs machine-parseable and directly queryable in systems like Loki or Elasticsearch. When debugging a production incident, being able to filter by `user_id` or `email` across millions of log entries is far more valuable than grepping through unstructured text.

```go
log.Info("user created",
    "user_id", result.LastInsertId(),
    "email", u.Email,
)
```

### 10. Return Created User ID

Returning the newly created resource's ID in the response body follows REST convention and prevents the client from needing a second round-trip GET to discover the assigned identifier. Including both `id` and `status` gives the caller enough context to proceed without additional requests, which matters at scale when each extra call multiplies latency.

```go
w.Header().Set("Content-Type", "application/json")
json.NewEncoder(w).Encode(map[string]any{
    "id": id,
    "status": "created",
})
```

---

## NITPICKS (Take it or leave it)

### 11. Field Naming
`Pass` → `Password` would be clearer
`ID` → `Id` for consistency with Go conventions (though both are acceptable)

### 12. SELECT *
Using `SELECT *` can break if columns are reordered or added.
Consider explicit column selection.

---

## Summary
- 4 blocking issues (security + error handling)
- 3 should-fix items
- 3 suggestions
- 2 nitpicks

**Recommendation**: Request changes. Do not merge until blocking
issues are addressed.
````

---

### Exercise 2: Write Review Guidelines

**Task**: Create a code review guidelines document for a Go-focused engineering team.

**Solution**:

````markdown
# [Company] Go Code Review Guidelines

## Purpose
Code reviews ensure code quality, share knowledge, and catch
bugs before production. This document outlines expectations
for authors and reviewers.

---

## For Authors

### Before Requesting Review

- [ ] PR description explains WHAT changes and WHY
- [ ] PR is linked to issue/ticket
- [ ] Tests pass locally (`go test ./...`)
- [ ] Linter passes (`golangci-lint run`)
- [ ] Self-reviewed the diff
- [ ] PR size is reasonable (<400 lines, <10 files)

### PR Description Template

A good PR description shifts cognitive load from the reviewer to the author, who already holds all the context. By capturing the motivation, the approach chosen, and the alternatives rejected, the description turns the review into a validation exercise rather than a discovery exercise. The template below is intentionally minimal. It covers the what, the why, and the test plan, which are the three sections reviewers read before opening the diff.

```

## What
[Brief description of changes]

## Why
[Link to issue] - [context for why this change is needed]

## How to Test
[Steps to verify the changes work]

## Rollback Plan
[How to undo these changes if needed]

## Checklist
- [ ] Tests added/updated
- [ ] Documentation updated (if needed)
- [ ] Breaking changes noted (if any)
```

### Responding to Feedback

- Respond to ALL comments (even if just "Done")
- Don't take feedback personally - it's about the code
- Ask for clarification if feedback is unclear
- If you disagree, discuss - don't ignore
- After addressing feedback, re-request review

---

## For Reviewers

### Review Process

1. **Read PR description first** - Understand context
2. **Check tests** - Understand expected behavior
3. **High-level pass** - Is the approach sound?
4. **Detailed pass** - Line-by-line review
5. **Provide categorized feedback** - See below

### Review Priorities (in order)

1. **Security** - Auth, injection, secrets, validation
2. **Correctness** - Bugs, logic errors, edge cases
3. **Go-Specific** - Error handling, concurrency, resources
4. **Design** - Architecture, patterns, maintainability
5. **Tests** - Coverage, quality, edge cases
6. **Style** - Should mostly be handled by linter

### Go-Specific Checklist

- [ ] All errors handled (no `_ = err`)
- [ ] Errors wrapped with context (`fmt.Errorf("...: %w", err)`)
- [ ] Resources cleaned up (`defer f.Close()`)
- [ ] Context propagated to blocking calls
- [ ] Concurrent code is race-free
- [ ] Appropriate use of pointers vs values
- [ ] Exported types/functions documented

### Comment Categories

Labeling every comment with a category eliminates the ambiguity that causes most review friction: authors no longer have to guess whether a remark is a hard blocker or a passing thought. A `BLOCKING` label signals that merging without addressing the issue risks a production bug or security hole, while `nit` explicitly grants the author permission to disagree and move on. This shared vocabulary also makes it easy to scan a review at a glance and prioritize the work queue without reading every comment in full.

```
**BLOCKING**: Must fix before merge
"This will cause a nil panic when..."

**SHOULD FIX**: Strongly recommended
"This is missing edge case handling for..."

**SUGGESTION**: Nice to have
"Consider using sync.Pool here for..."

**QUESTION**: Need clarification
"I'm curious why you chose X over Y?"

**PRAISE**: Acknowledge good work
"Nice solution to the concurrency issue!"

**nit**: Take it or leave it
"nit: Maybe `usersByID` instead of `m`?"
```

### Response Time SLOs

- **First response**: Within 4 business hours
- **Complete review**: Within 24 business hours
- **Urgent PRs** (labeled): Within 2 hours

If you can't meet these, comment with expected timeline or
reassign to backup reviewer.

### When to Request Changes vs Approve

**Request Changes**:
- Security vulnerability
- Bug that will affect production
- Missing error handling that could crash
- Fundamentally wrong approach

**Approve with Comments**:
- Suggestions for improvement
- Minor issues that don't affect correctness
- Questions about approach

---

## Handling Disagreements

1. **First**: Clarify understanding via comments
2. **If stuck**: Move to synchronous discussion (call)
3. **Time-box**: 15 minutes max, then escalate
4. **Escalate to**: Tech lead or designated tie-breaker
5. **Document**: Record decision for future reference
6. **Commit**: Once decided, support fully

---

## Metrics We Track

| Metric | Target |
|--------|--------|
| First response time | < 4 hours |
| Review completion time | < 24 hours |
| Review cycles | < 3 rounds |
| PR size | < 400 lines |

---

## Automation

We automate these so reviewers can focus on substance:
- Formatting: `gofmt` (required to pass)
- Linting: `golangci-lint` (must pass)
- Tests: `go test` (must pass)
- Coverage: Minimum 80% (enforced)
- Security: `gosec` scanning

If any automated check fails, fix before requesting review.

---

## Questions?

- Slack: #code-review-help
- Documentation: [internal wiki link]
- Guidelines updates: PR to this document!
````

---

### Exercise 3: Improve This Review Comment

**Task**: Rewrite these review comments to be more constructive.

**Original Comments**:
1. "This is wrong."
2. "Why did you do it this way?"
3. "This is inefficient."
4. "LGTM"

**Solution**:

````markdown
# Review Comment Improvements

## Comment 1: "This is wrong."

### Problem:
- No explanation of what's wrong
- No guidance on how to fix
- Can feel hostile

### Improved:
"**BLOCKING**: This could cause a nil pointer dereference if
`GetUser` returns nil (which happens when user isn't found).

Consider adding a nil check:

```go
user, err := GetUser(id)
if err != nil {
    return fmt.Errorf("get user: %w", err)
}
if user == nil {
    return ErrNotFound
}
```

Alternatively, we could change `GetUser` to return an error
for not-found cases. Happy to discuss which approach fits
better here."

---

## Comment 2: "Why did you do it this way?"

### Problem:
- Can feel like an accusation
- Doesn't share what you're confused about
- Author doesn't know what to address

### Improved:
"**QUESTION**: I'm curious about using a map here instead of a
slice. My initial thought was that slice iteration would be
faster for small collections (<100 items).

Is there a reason you chose map? Maybe I'm missing context
about how this will be used. Happy to learn if there's a
pattern I don't know!"

---

## Comment 3: "This is inefficient."

### Problem:
- Vague criticism
- No data or specifics
- No alternative suggested

### Improved:
"**SUGGESTION**: This nested loop is O(n²) - for each user,
we iterate through all permissions. With our expected data
size (~10K users × ~100 permissions), this could take
several seconds.

Consider building a permission lookup map first:
```go
permByID := make(map[int]*Permission, len(permissions))
for _, p := range permissions {
    permByID[p.ID] = p
}

// Now O(1) lookup
for _, user := range users {
    perm := permByID[user.PermissionID]
    ...
}
```

This brings it to O(n + m) instead of O(n × m).

Not blocking if this code path is rarely called, but worth
considering for the hot path."

---

## Comment 4: "LGTM"

### Problem:
- No evidence of actual review
- No learning for author
- Misses opportunity for praise

### Improved:
"**LGTM!** Nice work on this.

A few things I particularly liked:
- Clean separation between validation and processing
- Good use of table-driven tests
- Error messages are clear and actionable

One minor thought for next time: consider adding a benchmark
test for the hot path (line 45). Not needed for this PR, just
for future optimization work."

---

## Summary: Good Comment Structure

A well-structured comment does three things at once: it tells the author what was observed, why it matters to the codebase or users, and what a concrete fix looks like. Without the "why it matters" layer, reviewers slip into personal-preference territory and authors rightfully push back. Offering to discuss keeps the tone collaborative and signals that the goal is a better outcome, not winning an argument.

```
[CATEGORY]: [Brief title]

[What I observed/question]

[Why it matters/context]

[Suggested solution or question]

[Offer to discuss if needed]
```

This structure ensures comments are:
- Categorized (author knows priority)
- Specific (author knows what to address)
- Actionable (author knows how to fix)
- Kind (focus on code, not person)
````

### Junior → FAANG: Using the Code Review Exercise as Interview Rehearsal

The code review exercise in this section, reviewing the user service with SQL injection and missing error handling, is a simplified version of what FAANG interviewers ask in code review assessment rounds. The key skill demonstrated in the solution is not just finding the issues but categorizing them and explaining why each category has the priority it does.

Practice narrating your review out loud. "I'm starting with a high-level pass... the approach looks reasonable but I want to check the security boundaries first... I see string concatenation in a SQL query on line 29, which is a SQL injection vulnerability. This is blocking because it would allow an attacker to read or modify any data in the database." That narration is the interview answer. The ability to think out loud with structured priority reasoning is what the interviewer is actually assessing.

The "improve this review comment" exercise is particularly valuable because it forces you to practice the specific skill that separates L4 from L5 review behavior: writing actionable, specific, categorized feedback rather than vague criticism. Do this exercise with your own past review comments. Find three comments you have written in the past month and rewrite them using the template structure.

### Senior @ FAANG: Using These Exercises to Calibrate Team Review Quality

At L6 and above, the code review exercise is a team calibration tool. Running the "review this code" exercise as a team activity, where all engineers independently review the same PR and then compare their feedback, surfaces the variance in review quality across the team.

High variance means the team has inconsistent review standards. Engineers are prioritizing different concerns, categorizing feedback differently, and producing a different experience depending on which reviewer an author is assigned. The path to lower variance is not more rules. It is shared review examples: sample PRs with annotated ideal reviews that the team uses as calibration references.

The "write review guidelines" exercise, done as a team rather than individually, produces team ownership of the resulting document. Guidelines written by one person and handed down to a team are followed out of compliance. Guidelines co-authored by the team are followed because everyone understands the reasoning behind every line. Staff engineers who facilitate this co-authorship process rather than writing the guidelines alone are investing in the team's intrinsic motivation to maintain the culture they helped create.

---
