## 87.5 Mentoring Through Reviews

### Teaching in Code Reviews

Code reviews are one of the most effective mentoring tools available to senior engineers. When you review a junior engineer's code, you have a direct opportunity to teach them the patterns, idioms, and reasoning that make production code reliable. The key is to explain the "why" behind your feedback, not just the "what." A junior who understands the reasoning will apply that lesson across their entire codebase, not just in the specific line you commented on.

```
FOR JUNIOR ENGINEERS:

1. BE PATIENT AND THOROUGH
   - Explain the "why" not just the "what"
   - Link to documentation and examples
   - Don't assume knowledge

2. BALANCE FEEDBACK VOLUME
   - Don't overwhelm with 50 comments
   - Prioritize the most important lessons
   - Group learning into themes

3. PAIR ON COMPLEX CHANGES
   - Offer to walk through together
   - Screen share can be more effective

4. CELEBRATE GROWTH
   - Note improvements from past reviews
   - Acknowledge when they apply feedback

EXAMPLE TEACHING COMMENT:
"This is a common pattern question! In Go, we typically
return (result, error) rather than checking a global error.

Here's why: [explanation]

See this blog post for more: [link]

For this code, it would look like:
```

```go
result, err := doSomething()
if err != nil {
    return err
}
```

### Building Reviewer Skills

Reviewing code well is itself a skill that must be developed deliberately. New reviewers often feel uncertain about what to comment on, how to phrase feedback, or whether their observations are worth mentioning. Just as you would mentor someone on writing code, you should mentor new reviewers on how to review effectively. The following progression shows how reviewer skills typically develop over time.

```
FOR NEW REVIEWERS:

1. START WITH SMALLER PRs
   - Less overwhelming
   - Faster feedback loop

2. SHADOW SENIOR REVIEWERS
   - Watch how they comment
   - Ask about their thought process

3. GET YOUR REVIEWS REVIEWED
   - Senior can give feedback on your feedback
   - Learn the team's standards

4. USE CHECKLISTS
   - Ensures consistency
   - Develops muscle memory

REVIEWER GROWTH LADDER:
Level 1: Review for obvious bugs
Level 2: Review for edge cases and error handling
Level 3: Review for design and architecture
Level 4: Review for system-wide impact
Level 5: Set review standards for the org
```

### Junior → FAANG: The Reviewer Growth Ladder as a Career Signal

The reviewer growth ladder in this section describes the exact progression that FAANG interviewers use to calibrate review experience. A candidate who reviews for "obvious bugs" is at Level 1. A candidate who reviews for "system-wide impact" is at Level 4. Know which level you are at and have concrete examples that demonstrate it.

For L5 targeting, Level 3 is the minimum expected: "Review for design and architecture." If your review history contains only error handling and edge case comments but no design-level feedback, you are presenting below the L5 bar. To develop Level 3 reviewer skills, practice asking "is this the right abstraction?" and "will this design hold under 10x load?" before going line by line.

Shadowing senior reviewers, described in the "Building Reviewer Skills" section, is both a development practice and an interview preparation technique. If you have shadowed a Staff or Principal engineer's review process and can describe what you learned from watching them prioritize concerns, that story demonstrates learning agility and professional initiative simultaneously.

### Senior @ FAANG: Scaling Mentorship Through Systematic Review Infrastructure

At L6 and above, mentoring through reviews stops being a one-to-one activity and becomes a systems design problem. How do you build review infrastructure that distributes senior-level mentorship across an organization of 50 or 500 engineers without requiring every senior engineer to personally review every PR?

Google's readability reviewer system is the canonical answer: create a cadre of certified language experts who review specifically for quality, separate from the domain review. This allows language-specific mentorship to scale across every team without each team needing its own language expert. Staff engineers who design analogous systems for their organization, even informally, achieve mentorship leverage that personal reviewing cannot match.

The reviewer growth ladder is also a performance review artifact. Staff engineers who are asked "how have you grown the engineers around you?" can point to a reviewer who has moved from Level 1 to Level 3 under their mentorship, describing the specific reviews where they gave feedback on feedback quality and the progression they observed. That answer is more concrete and more compelling than "I mentored several junior engineers."

PR size conventions that the team enforces through CODEOWNERS and automated size checks are a mentoring infrastructure investment. Large PRs are hard to review and hard to learn from. Small PRs produce more review interactions, faster feedback cycles, and more cumulative mentoring per quarter. Staff engineers who set and enforce PR size norms are optimizing the mentoring throughput of the entire team.

---
