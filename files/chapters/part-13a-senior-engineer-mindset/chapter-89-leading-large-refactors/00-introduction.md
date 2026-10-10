# Chapter 89: Leading Large Refactors

> "Big-bang rewrites are the most seductive and most dangerous idea in software engineering. They promise a clean slate and they deliver a second system that carries all the original debt plus the new debt you accumulated under pressure. The strangler fig wins every time - not because it's elegant, but because it keeps working while you improve it." - Martin Fowler

Every engineering organization has a system it is afraid to touch. It might be a 200,000-line monolith that processes all financial transactions. It might be a service whose author left three years ago and whose behavior is documented only in production logs. It might be a data model that made perfect sense in 2018 and now requires six JOINs and a prayer to answer a simple question. These systems accumulate technical debt the way old houses accumulate settling damage - gradually, then suddenly, until the cost of maintenance starts to threaten the ability to deliver new value entirely. At some point, someone has to lead the refactor.

Leading a large refactor is one of the hardest things a senior engineer does. It is hard technically: you are modifying a system that is in production, serving real users, often without the luxury of a full test suite or complete documentation. It is hard organizationally: you need to maintain the confidence of your team, your manager, and your stakeholders across a migration that may take months or years, while simultaneously keeping the existing system running and continuing to ship other work. And it is hard personally: large refactors frequently lose momentum, get deprioritized when the next urgent feature appears, or get abandoned halfway through - leaving the codebase in a worse state than where it started, a half-migrated ghost town that exhausts everyone who has to maintain it.

The engineers who successfully lead large refactors share a set of behaviors that are almost entirely about risk management and stakeholder communication rather than technical cleverness. They choose patterns like the strangler fig and branch-by-abstraction precisely because these patterns allow incremental, reversible progress rather than a high-risk cutover. They define success metrics upfront - what does "done" actually mean, and how will we know when we're there? They communicate progress in terms that business stakeholders understand: improved deployment frequency, reduced incident rate, reduced time-to-onboard for new engineers. And they are ruthlessly disciplined about scope - the refactor that tries to fix everything at once finishes nothing. This chapter is your tactical guide to leading these efforts the way the best senior engineers do.

**What you'll learn in this chapter:**

- The strangler fig pattern in depth: how to incrementally replace a legacy system while keeping it operational, with Go-specific implementation strategies
- Branch-by-abstraction: how to introduce an interface layer that lets you swap implementations without a flag day or a big-bang cutover
- How to plan a large refactor: scoping, sequencing, dependency analysis, and identifying the highest-risk migration steps
- Stakeholder alignment for long-running technical projects: how to communicate progress, manage expectations, and prevent the refactor from being deprioritized at the first roadmap review
- Measuring success: defining and tracking metrics that demonstrate the business value of a refactor - not just "the code is cleaner" but "deployments are 40% faster"
- Managing risk during active migration: feature freezes, dual-write patterns, canary deployments, and rollback strategies
- How to coordinate large refactors across multiple teams with different priorities, ownership boundaries, and velocity constraints
- When to stop: recognizing when a refactor has achieved enough value that continuing has diminishing returns and knowing how to declare it done

**The senior engineer perspective:**

Engineers who have led large migrations at scale - the kind that touch hundreds of services or migrate billions of records - consistently describe the same bottleneck: not the technical complexity, but the organizational stamina required to keep the effort funded and staffed over many quarters. One staff engineer at LinkedIn described a two-year database migration: "The technical design was done in three weeks. The actual execution took 22 months - and 18 of those months were spent on stakeholder management, prioritization negotiations, and keeping the team motivated when it felt like we were running on a treadmill." At Uber, the migration from one service framework to another required a dedicated migration team, explicit metrics tied to business outcomes, and a hard deadline set by leadership - because without a deadline, engineers always find something more urgent to work on. The lesson is consistent: the engineering is the easy part. The organizational problem is what kills large refactors.

**Prerequisites:** Chapters 1--88, experience with production Go services, familiarity with deployment and testing patterns.

### Junior → FAANG: Getting Your First Refactor on the Record

Entry-level engineers at FAANG are rarely handed a large refactor to own, but they are frequently asked in interviews to describe a time they improved a system incrementally. The gap between candidates who have nothing to say and those who do is usually not experience, it is intentionality. Before your interview, identify one place in your current codebase where you introduced a cleaner abstraction, extracted a function, or replaced a brittle pattern with a testable one, and write up the before and after. That is your raw material.

The most important concept to internalize from this chapter before a junior interview is why big-bang rewrites fail. Interviewers at Google and Meta routinely probe this with "tell me about a time you proposed a technical change and it did not go as planned." A candidate who says "we rewrote the service over six months and shipped it" has described execution. A candidate who says "we planned a six-month rewrite, realized two months in that we had underestimated the hidden dependencies, and pivoted to a strangler fig that let us ship partial value every three weeks" has described engineering judgment.

Build the vocabulary: strangler fig, branch-by-abstraction, dual-write, canary rollout, feature flag cutover. These terms signal to the interviewer that you think about risk, not just code.

### Senior @ FAANG: Refactor Leadership as an Organizational Competency

At L6 and above, leading a large refactor is a staff-level event that is judged not just on technical outcome but on organizational impact. Bar-raiser interviewers at Amazon and Google ask two questions simultaneously: did the system improve, and did the organization get better at running migrations because of how you did this one? The second question is harder to answer and separates L6 from L7.

The governance dimension matters enormously. Before the first line of migration code is written, you should have a written ADR explaining why the current architecture is no longer fit, a migration RFC with sign-off from affected team leads, a defined success metric tied to a business outcome (not just code quality), and a deprecation timeline with a hard date. At FAANG scale, refactors without a deprecation deadline reliably fail because product teams always find something more urgent. The hard date, backed by an architectural principle that prevents new feature development on the old path, is what forces completion.

Maturity model thinking applies directly here. A team at migration maturity level 1 does big-bang rewrites under deadline pressure. A team at level 2 uses the strangler fig but still coordinates manually across teams. A team at level 3 has codemods, automated adoption dashboards, and deprecation enforcement built into CI. Your job as a staff engineer is not just to run the current migration well, it is to leave the organization at a higher maturity level than you found it. The investment in migration tooling that saves the next team six weeks is the kind of leverage that shows up in a principal engineer promotion packet.

When preparing for a staff loop, have a concrete answer to: "What migration infrastructure did you create that other teams used?" If your best answer is "I documented the process," you are presenting at L5 scope. The L6 answer names an artifact (a codemod, a traffic-routing library, a migration checklist with automated validation gates) that other teams adopted independently.

---
