## Exercises

### Exercise 1: Resume Rewrite with Impact

**Scenario:**
You're a mid-level Go engineer applying to a Senior Engineer position at a fintech company. Rewrite the following weak resume bullets into strong, impact-based statements.

**Weak Bullets to Transform:**
1. "Worked on the payments team"
2. "Responsible for maintaining microservices"
3. "Participated in code reviews"
4. "Helped improve system performance"
5. "Used Go, Kubernetes, and PostgreSQL"

**Your Task:**
Transform each bullet using the XYZ formula (Accomplished X measured by Y by doing Z).

**Solution:**

```markdown
# Transformed Resume Bullets

## Original → Transformed:

### 1. "Worked on the payments team"
→ "Designed and implemented payment processing system handling
   $15M daily transaction volume with 99.97% uptime, reducing
   checkout failures by 35% through improved retry logic"

Why it works: Quantified scale, reliability metrics, business impact

### 2. "Responsible for maintaining microservices"
→ "Owned 8 production microservices processing 50K requests/second,
   reducing incidents from 12 to 2 per quarter through proactive
   monitoring improvements and architectural refactoring"

Why it works: Shows ownership, scale, and measurable improvement

### 3. "Participated in code reviews"
→ "Led code review process for team of 6 engineers, establishing
   review standards that reduced bug escape rate by 40% and
   decreased review turnaround time from 48 to 12 hours"

Why it works: Shows leadership, process improvement, multiple metrics

### 4. "Helped improve system performance"
→ "Reduced API latency by 70% (from 500ms to 150ms p95) through
   database query optimization and caching layer implementation,
   enabling 3x traffic growth without infrastructure changes"

Why it works: Specific improvement with before/after, explains how

### 5. "Used Go, Kubernetes, and PostgreSQL"
→ "Built distributed cache in Go with custom Kubernetes operator,
   reducing database load by 60% and saving $8K monthly in
   infrastructure costs while improving p99 latency 5x"

Why it works: Technologies in context of achievement, cost impact

## Key Patterns:

1. Replace "worked on" with "designed," "built," "led," "owned"
2. Add at least one number (%, count, $, time)
3. Show business impact, not just technical change
4. Include scale where relevant
5. Explain the "so what"
```

---

### Exercise 2: LinkedIn Profile Optimization

**Scenario:**
Optimize the following weak LinkedIn headline and About section for a Go engineer looking for Senior/Staff positions at top tech companies.

**Current (Weak):**
```
Headline: Software Engineer at Tech Company

About: I am a software engineer with experience in backend
development. I have worked with various technologies and
am looking for new opportunities. Feel free to connect.
```

**Your Task:**
1. Write a new headline that's searchable and compelling
2. Write a new About section (300-500 words)
3. Explain your optimization choices

**Solution:**

```markdown
# Optimized LinkedIn Profile

## NEW HEADLINE:
"Senior Go Engineer | Distributed Systems & Payments |
Building high-scale financial infrastructure at [Company]"

Why it works:
- Level included (Senior)
- Primary technology (Go)
- Specialization (Distributed Systems, Payments)
- Current work (adds credibility)
- Keyword-rich for recruiter searches

---

## NEW ABOUT SECTION:

"""
Senior Software Engineer building payment systems that handle
billions of dollars with millisecond latency and 99.99% reliability.

Currently at [Company], I lead technical initiatives on the
payments platform team. Highlights:

• Redesigned payment routing engine handling $50M daily,
  reducing latency by 40% and saving $200K annually in
  processing fees

• Built real-time fraud detection system processing 500K
  events/second with <10ms p99 latency

• Mentored 4 engineers through promotion cycles; established
  team's code review standards and technical interview process

Previously at [Previous Company], I worked on [domain] systems:

• Led migration of monolithic service to microservices
  architecture, enabling 3 teams to deploy independently

• Reduced on-call incidents by 60% through improved
  observability and runbook documentation

Tech I work with daily: Go, Kubernetes, PostgreSQL, Kafka,
gRPC, AWS, Terraform

I write about distributed systems and Go engineering on my
blog: [link]

Currently open to: Senior/Staff Engineering roles focused on
payments, financial infrastructure, or distributed systems
at companies solving hard technical problems at scale.

Best way to reach me: [email] or DM here

Let's connect if you're working on interesting systems
problems or want to chat about Go and distributed systems.
"""

---

## OPTIMIZATION CHOICES EXPLAINED:

### First Line (Hook):
Opens with value proposition visible before "see more"
Uses keywords recruiters search: "Senior Software Engineer"

### Highlights Section:
- Bullets are scannable
- Each has quantified impact
- Shows progression (current then previous)
- Demonstrates breadth (technical + leadership)

### Tech List:
Explicit list for keyword matching
Organized logically

### Call to Action:
- Clear about what you're looking for
- Specific enough to be useful
- Contact info provided
- Invites connection

### Tone:
- Confident but not arrogant
- Specific not generic
- Professional but human
```

---

### Exercise 3: GitHub Portfolio Curation

**Scenario:**
You have 47 GitHub repositories ranging from tutorial code to work projects to abandoned experiments. You need to curate your profile to impress hiring managers at top tech companies.

**Current State:**
- 15 forked repos (never modified)
- 12 tutorial follow-alongs (TODO apps, etc.)
- 8 abandoned side projects (no README)
- 5 school projects (varying quality)
- 4 work-related utilities (good code but private)
- 3 legitimate side projects (need polish)

**Your Task:**
1. Decide what to keep, archive, and delete
2. Choose 6 repos to pin
3. Create a profile README
4. Explain your curation strategy

**Solution:**

```markdown
# GitHub Portfolio Curation Strategy

## STEP 1: TRIAGE REPOSITORIES

### DELETE or MAKE PRIVATE:
- 15 forked repos (never modified) → Archive/Delete
  Reason: Shows you forked but never contributed

- 12 tutorial follow-alongs → Archive most, keep 1-2 if excellent
  Reason: Everyone has these, they don't differentiate

- 8 abandoned side projects → Delete if no README, otherwise archive
  Reason: Unfinished work signals poor follow-through

### KEEP AND IMPROVE:
- 5 school projects → Keep 1-2 best, archive rest
  Strategy: Add professional READMEs to best ones

- 4 work-related utilities → Make generic versions public
  Strategy: Remove company-specific code, document well

- 3 legitimate side projects → These are your stars
  Strategy: Polish significantly (see below)

## STEP 2: POLISH YOUR STARS

For each of your 3-4 best repos:

### Documentation:
□ Professional README with:
  - Clear project title
  - One-line description
  - Problem it solves
  - Installation instructions
  - Usage examples
  - Architecture overview (for complex projects)
  - Screenshots or demos

### Code Quality:
□ Remove commented-out code
□ Consistent formatting
□ Clear variable/function names
□ Add or improve tests
□ Handle errors properly

### Project Hygiene:
□ Add LICENSE file
□ Add .gitignore
□ Clean commit history (or start fresh)
□ Add GitHub Actions for CI
□ Create releases if applicable

## STEP 3: 6 REPOS TO PIN

1. **distributed-cache** (Side Project)
   Your best technical project - shows system design skills

2. **go-ratelimiter** (Side Project)
   Practical library - shows you can build reusable code

3. **payment-gateway-demo** (Work Utility, Genericized)
   Domain-relevant - shows payments expertise

4. **data-structures-go** (School Project, Polished)
   Fundamentals - shows you understand basics

5. **cli-toolkit** (Side Project)
   Practical tool - shows you solve real problems

6. **contribution to popular project** (Fork with changes)
   Open source - shows you can contribute to others' code

## STEP 4: PROFILE README

Create repo: username/username (special repo)

```

```markdown
# Hi, I'm Alex Chen 👋

Senior Go Engineer building distributed systems that
Handle real money at scale.

## 🔨 What I'm Building
Currently working on payment infrastructure at [Company].
Previously: rider matching at Uber, startup payments platform.

## 💡 Featured Projects
- **[distributed-cache](link)** - Redis-compatible distributed
 cache in Go, implementing Raft consensus
- **[go-ratelimiter](link)** - Production-ready token bucket
 rate limiter with Redis backend

## 📝 Writing
I write about Go and distributed systems: [blog link]
Latest: "How We Reduced Payment Latency by 70%"

## 🛠️ Technologies
![Go](badge) ![Kubernetes](badge) ![PostgreSQL](badge)
![Kafka](badge) ![Redis](badge) ![AWS](badge)

## 📫 Get in Touch
- Email: alex@example.com
- LinkedIn: linkedin.com/in/alexchen
- Blog: alexchen.dev

---

*Currently open to Senior/Staff roles in payments
And distributed systems*
```

### Step 5: Ongoing Maintenance

### Monthly:
- Review and archive abandoned repos
- Update pinned repos if better work emerges
- Keep contribution graph active

### After Each Project:
- Document immediately (don't wait)
- Add to profile if showcase-worthy
- Archive if not

## Summary

- **Deliberate practice over passive experience**: Simply accumulating years on the job does not equal growth - intentional, focused practice on hard problems accelerates skill development far faster.
- **Building a learning system**: Create a repeatable process for consuming, retaining, and applying new knowledge - structured notes, spaced repetition, and project application all compound over time.
- **T-shaped skillset development**: Go deep in one primary domain while maintaining broad working knowledge across adjacent areas. This makes you both specialized and highly versatile on teams.
- **Compound interest of consistent daily improvement**: Small daily investments in learning and practice accumulate exponentially - 1% better each day yields dramatically different outcomes over a year than sporadic bursts of effort.
- **Side projects vs open source contribution**: Side projects build end-to-end ownership skills. Open source builds public credibility and exposes you to production-quality codebases - both serve distinct career purposes.
- **Writing as career accelerator**: Blog posts, RFCs, and technical articles force clarity of thought, establish domain authority, and create a discoverable body of work that opens doors without active networking.
- **Networking authentically**: Build relationships by giving value first - answering questions, sharing insights, helping others - rather than transactional outreach focused on what you can extract.
- **Choosing high-leverage companies and teams**: The environment you work in shapes your growth ceiling. Teams with strong engineers, real production scale, and a culture of feedback teach more than titles or salaries alone.
- **Mentorship relationships**: Seek mentors who are 2-3 levels ahead, are willing to give honest feedback, and have navigated paths you aspire to - reciprocate by being a highly engaged mentee.
- **Tracking career progress explicitly**: Maintain a brag document of accomplishments, impact metrics, and skills acquired. Regular review reveals blind spots and ensures your growth narrative is concrete at review time.

### Junior → FAANG: Using These Exercises to Build Verifiable Evidence

The exercises in this section are valuable only if you complete them to the point where the output is something you would actually show a hiring manager. A resume rewrite exercise that produces a slightly improved bullet point is not the goal. The goal is a resume that could be submitted to a FAANG company tomorrow. Hold the output to that standard.

For the GitHub exercises specifically: do not finish the exercise until the repository has a README that explains the problem, the design, and the next steps. A code exercise with no documentation teaches you to write code. A code exercise with documentation teaches you to communicate your technical thinking, which is the actual skill you are building.

Build a habit of revisiting these exercises every three months. Your materials should evolve as your experience evolves. An engineer who updates their resume and LinkedIn profile every three months stays current with their own growth. An engineer who updates them only when job searching is always presenting a version of themselves that is six to eighteen months out of date.

### Senior @ FAANG: Exercises as Promotion Packet Preparation

At senior level, the exercises in this chapter serve a second purpose: they are the building blocks of a promotion packet. The resume rewrite exercise is practice for articulating the scope and impact that a promotion committee needs to see. The branding exercise is practice for the narrative you will present when your manager makes your case. The GitHub and portfolio exercises are practice for producing the public artifacts that establish your level externally.

The brag document habit named in the key takeaways above is the most important ongoing practice for senior engineers at FAANG. Maintain a running document, updated at minimum monthly, that records specific contributions, cross-team interactions, technical decisions made, and measurable outcomes. This document becomes the raw material for your performance review self-assessment, your promotion packet, and your resume the next time you are in the job market. Engineers who maintain this habit consistently report that both their performance reviews and their job searches are dramatically easier than colleagues who reconstruct their accomplishments from memory.

Specific exercise for L5 engineers targeting L6: write a one-page technical leadership narrative that answers the following questions. What is the largest ambiguous technical problem you have owned from problem identification to solution? Who were the stakeholders you aligned, and how? What was the measurable organizational outcome? What would have happened if you had not driven this? If you cannot answer all four questions with specific, verifiable evidence, that gap identifies the scope expansion work you need to do before you are ready for an L6 promotion conversation.

---

*Next: [Chapter 92: Job Search Strategy](../chapter-92-job-search-strategy/00-introduction.md)*
