## 86.1 Engineering Career Ladders

### How Levels Actually Work

Every major tech company has an engineering ladder, and the levels roughly map to each other:

| Level | Google | Meta | Amazon | Microsoft | Stripe |
|-------|--------|------|--------|-----------|--------|
| Junior | L3 | E3 | SDE I | 59 | L1 |
| Mid | L4 | E4 | SDE II | 61-62 | L2 |
| Senior | L5 | E5 | SDE III | 63-64 | L3 |
| Staff | L6 | E6 | Principal | 65-66 | L4 |
| Sr. Staff | L7 | E7 | Sr. Principal | 67 | L5 |
| Principal | L8 | E8 | Distinguished | 68+ | N/A |

But the levels are misleading. A Google L5 and an Amazon SDE III are both "Senior," yet the expectations are different. At Google, L5 means you own a significant component and drive its technical direction. At Amazon, SDE III means you operate across multiple services and are the go-to person for an entire domain. Stripe's L3 might have more scope than Google's L5 because Stripe is smaller. There's simply more surface area per engineer.

**Don't obsess over level mapping.** Focus on what each company actually evaluates at promotion time.

### What Really Changes Between Levels

The biggest trap in career growth is thinking promotion means "I do the same thing, but better." It doesn't. Each level changes *what* you do, not just how well you do it.

**Junior → Mid: From "Can you build this?" to "Can you build this right?"**

A junior engineer gets a task, implements it, and asks for review. A mid-level engineer gets a task, thinks about edge cases, writes tests, considers how it interacts with existing systems, and produces code that the team trusts in production. The shift is from "it works" to "it works and I understand why."

A real example: At Uber, a junior engineer might implement a new API endpoint for ride tracking. A mid-level engineer would also design the database schema, add monitoring, handle backward compatibility with mobile clients, and write a brief design doc explaining their approach.

**Mid → Senior: From "Can you build this right?" to "What should we build?"**

This is the hardest transition because it's the first time you're expected to identify problems, not just solve them. A senior engineer looks at the system, notices that the payment retry logic is causing duplicate charges, writes an RFC proposing an idempotency solution, builds consensus with the payments team, implements it, and mentors a junior through part of the work.

Google's promotion committee for L4→L5 looks for "demonstrates consistent impact at the project level and begins to influence technical direction." In practice, this means your L5 packet should show 2-3 projects where *you* defined the approach, not just executed someone else's design.

**Senior → Staff: From "What should we build?" to "What should the team build?"**

This transition breaks many good engineers. You go from being the best coder on the team to the person who makes the team better at coding. Your output is measured in the team's output, not yours.

Will Larson (author of *Staff Engineer*) describes it as "you stop being the best player and start being the coach." At Stripe, a Staff Engineer might spend weeks designing a new deployment pipeline that saves every engineer on the team 30 minutes per deploy. They write zero production features during that period, and that's exactly right for their level.

The staff promotion packet at Meta (E5→E6) typically requires demonstrating cross-team impact: a project that involved coordinating with 2+ teams, where you were the technical driver who made the architecture decisions and resolved disagreements.

**Staff → Principal/Distinguished: Setting direction for organizations**

At this level, you're defining multi-year technical strategies. Google's Distinguished Engineers (L8+) typically own an entire technical domain, such as Jeff Dean on distributed systems and Sanjay Ghemawat on infrastructure. These aren't just good engineers. They've shaped how thousands of other engineers work.

Most engineers will never reach this level, and that's fine. The IC track is a pyramid. Each level has roughly 3-5x fewer people than the one below it.

### Why Engineers Get Stuck

**Stuck at Mid-level (2-4 years at this level is common):**
- Writing good code but not identifying which code to write
- Waiting to be assigned work instead of finding impactful work
- Not writing design docs or RFCs
- Fix: Pick a persistent pain point on the team, write a proposal, and drive it to completion

**Stuck at Senior (the "terminal level" at most companies):**
- Doing excellent individual work but not multiplying others
- Staying in their comfort zone (same type of work, same codebase)
- Not building relationships outside their immediate team
- Fix: Mentor 1-2 juniors, lead a cross-team project, write a technical strategy doc

**Stuck at Staff:**
- Optimizing locally (making their team better) without organizational impact
- Getting pulled into management work without the title or authority
- Fix: Identify a problem that affects multiple teams, propose a solution at the org level, and build a coalition to implement it

### Junior → FAANG: Reading the Ladder as a Map, Not a Ceiling

The engineering career ladder is a map, not a ceiling. The mistake many junior engineers make is reading the level descriptions as a description of what they are allowed to do, rather than what they should aspire to do. At FAANG, you are explicitly expected to operate at the next level before you are promoted to it. The engineers who wait to be given staff-level work before doing it are the engineers who plateau.

Practice reading level descriptions from a FAANG company (many are publicly discussed) and identifying the concrete behaviors that distinguish each level. Then identify the current level you are operating at versus where you want to be, and plan three to five specific activities in the next quarter that demonstrate next-level behavior. Share this plan with your manager.

### Senior @ FAANG: Calibrating the Ladder Across Organizations

At staff and principal levels, you have likely worked at multiple companies with different career ladders and different cultural interpretations of what "senior" or "staff" means. This experience is valuable when interviewing: you can calibrate your level expectations accurately against the company's actual bar rather than the title it assigns.

A practical governance contribution: if your organization's career ladder descriptions are vague or inconsistently applied, write more concrete behavioral descriptions for each level. Include specific examples of decisions, artifacts, and impact that each level should produce. Share these with your manager and director. Even if they are not formally adopted, they often influence how calibration discussions are framed in promotion cycles. This is exactly the kind of organizational infrastructure contribution that distinguishes L6 from L7.

---
