## 87.1 The Purpose of Code Reviews

### Why Code Reviews Exist (It's Not About Catching Bugs)

Most engineers think code reviews are about finding bugs. They're not, or at least, that's the least important purpose. Microsoft's study of modern code review (Bacchelli and Bird, 2013) found that only about 15% of review comments concern defects at all, most address maintainability, readability, and knowledge transfer. Automated tests, linters, and CI catch the majority of outright bugs. If bug detection were the only goal, code reviews would be a terrible use of engineering time.

So why does every serious engineering organization mandate them?

**1. Knowledge distribution.** At Google, the "readability reviewer" system ensures that at least one engineer with deep expertise in the language reviews every change. The real value isn't catching a misplaced bracket. It's that after 6 months of reviewing Go code, a Java engineer has absorbed Go idioms, patterns, and pitfalls by osmosis. When that engineer's colleague goes on vacation, someone else can ship to their service without a multi-day ramp-up.

**2. Maintaining a consistent codebase.** Stripe has 1,000+ engineers writing Go. Without code reviews enforcing consistent patterns, you'd end up with 50 different approaches to error handling, 30 different HTTP client wrappers, and a codebase that reads like it was written by 1,000 different people (because it was). Code review is how you keep the codebase feeling like one system, not a thousand stitched-together projects.

**3. Mentoring in disguise.** The most effective mentoring at FAANG companies doesn't happen in 1:1 meetings. It happens in code reviews. A senior reviewer who writes "Consider using `errgroup` here instead of manual WaitGroup + error channel. It handles the error propagation for you" has just taught a junior engineer something they'll use for the rest of their career. At Uber, several staff engineers credit their growth to "brutal but educational" code reviews from senior colleagues.

**4. Collective ownership.** If only one person has ever seen a piece of code, that person becomes a single point of failure. At Amazon, the on-call engineer at 3 AM needs to understand code written by someone who left the company 6 months ago. Code reviews ensure that at least two people understand every change: the author and the reviewer.

### What Bad Code Reviews Look Like

**The rubber stamp:** "LGTM" on a 500-line change after 30 seconds. This is worse than no review at all because it creates false confidence. The team thinks the code was reviewed. It wasn't.

**The rewrite request:** "I would have done this completely differently." This isn't a code review. It's a design review happening too late. If the approach is wrong, that should have been caught during design, not after 3 days of implementation.

**The style police:** 40 comments about variable naming and brace placement on a change that introduces a subtle race condition. The reviewer missed the forest for the trees. Style issues should be caught by `gofmt` and linters, not humans.

**The ego trip:** A senior engineer who blocks every PR from junior engineers until the code looks exactly like they would have written it. This doesn't produce better code. It produces engineers who stop submitting PRs and start looking for new jobs.

Google's engineering practices guide puts it well: "A reviewer should approve a change that improves the overall code health of the system, even if the change isn't perfect." The bar is *better than before*, not *what I would have written*.

### Junior → FAANG: Internalizing the Real Purpose Before the Interview

The four purposes of code review, knowledge distribution, consistency, mentoring, and collective ownership, directly map to FAANG interview questions about code review philosophy. When a bar-raiser asks "what is the purpose of a code review?", the expected answer at L5 covers at least three of these dimensions, not just "catching bugs."

Candidates who demonstrate that they understand collective ownership by describing how they use reviews to ensure multiple engineers understand a change are signaling production awareness: they understand that the 3am incident is not just a technical problem but an organizational one, and reviews are part of the solution.

Study the "bad code review" examples carefully because they describe anti-patterns that are asked about directly in behavioral interviews: "Tell me about a time you saw a code review go wrong. What did you do?" Each bad pattern has a specific resolution strategy that shows judgment.

### Senior @ FAANG: Reframing Review Purpose for Organizational Alignment

At L6 and above, the real battle is not understanding the purpose of code review. It is ensuring that your organization's review culture actually serves those purposes rather than just going through the motions.

"The rubber stamp" anti-pattern is endemic at organizations where review is treated as a compliance gate rather than a quality mechanism. Staff engineers who want to address this need to make the case in economic terms: the cost of a production incident caused by a bug that a thorough reviewer would have caught, measured in engineering hours, customer impact, and SLA penalties, is almost always higher than the cost of 30 more minutes of review time. That argument, made with actual incident data from your organization, is more persuasive than appeals to engineering quality as an abstract value.

The "collective ownership" purpose has a governance implication that is rarely stated explicitly: code review is part of your bus factor risk management strategy. Teams with no review culture have all their knowledge concentrated in individual authors. At scale, this is a reliability risk because the on-call engineer on a Sunday night needs to understand code written by an engineer who is on vacation. Staff engineers who frame review investment in terms of incident preparedness and knowledge distribution are making a business case, not a craft case, and business cases are more likely to get funded.

---
