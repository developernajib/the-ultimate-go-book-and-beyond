## 94.1 The 30-60-90 Day Framework

Your first 90 days at a new company determine your trajectory for the next 2-3 years. Mess it up, by trying to prove yourself too fast, or by staying invisible too long, and you'll spend months recovering.

Here's what actually works, based on patterns from engineers who've successfully onboarded at Google, Meta, Amazon, and Stripe.

### Days 1-30: Learn (Don't Try to Be a Hero)

**Your only goal: understand how things work here.** Not how they *should* work. Not what you'd change. How they work *now*.

**Week 1, Survive and observe:**
- Set up your dev environment. At Google this takes 1-2 days. At startups it might take an hour. Don't judge the company by this
- Get the main service running locally. If you can't, ask your onboarding buddy, not figuring it out alone for 3 days
- Read the team's on-call runbook. This tells you what breaks, which tells you what matters
- Schedule 1:1s with every person on your team (15-30 min each). Ask: "What are you working on? What's the hardest part?"

**Weeks 2-4, Ship something small:**
- Pick a "good first issue" or small bug fix. Something that takes 1-3 days, not 2 weeks
- The purpose isn't the code, it's learning the PR process, CI pipeline, deployment flow, and code review norms
- At Amazon, new engineers are expected to ship their first change within 2 weeks. At Google, it's typically within the first month
- **Don't** propose architectural improvements yet. You don't understand enough to know if your ideas are good or if they were already tried and rejected

**What you should know by Day 30:**
- How to build, test, and deploy the team's main services
- Who owns what (the informal org chart, not the official one)
- Where the bodies are buried (the tech debt everyone knows about but hasn't fixed)
- How decisions get made (RFC? Tech lead decides? Team vote?)

### Days 31-60: Contribute (Earn Trust Through Reliability)

**Your goal: become someone the team can depend on.** Not someone who has big ideas, someone who ships what they commit to, on time, without breaking things.

- Take on a medium-sized project (1-2 sprints). Own it end-to-end: design, implementation, testing, deployment
- Start reviewing other people's code. This is the fastest way to learn the codebase AND build relationships
- Attend architecture discussions. Listen more than you talk. When you do speak, ask questions ("What happens if this service goes down?") rather than making statements ("We should use Kafka instead")
- Identify one thing that frustrates the team. Don't fix it yet, just notice it and validate that others feel the same way

**The common mistake at this stage:** Trying to prove you're smart by pointing out everything that's wrong. The team already knows what's wrong. What they need is someone who can fix things without creating new problems.

### Days 61-90: Impact (Now You've Earned the Right)

**Your goal: deliver something that the team talks about.** This is when you propose that fix for the thing you identified on Day 45.

- Deliver your medium-sized project successfully. "Successfully" means: it works, it's tested, it's documented, and it didn't require heroics
- Propose an improvement based on initial onboarding discoveries. Write a short doc (not a 20-page RFC) explaining the problem, your proposed solution, and the trade-offs. If the team likes it, implement it
- At your 90-day check-in with your manager, you should be able to say: "I shipped X, I learned Y about our systems, and I think we should do Z next"

**What success looks like at Day 90:** Your teammates come to you with questions about the code you've touched. You're assigned to a project without your manager needing to qualify it with "this is a stretch for them." You're included in design discussions because people value your input, not because you demanded to be there.

**What failure looks like at Day 90:** You still need help running the main service. You haven't shipped anything beyond your first "good first issue." Or worse, you shipped a big refactor that broke production because you didn't understand the system well enough yet.

### Junior → FAANG: Using the Framework to Manage Your Manager's Expectations

The 30-60-90 framework is most useful when shared explicitly with your manager in your first week. Most managers at FAANG companies will appreciate a new hire who says "here is how I am thinking about my first 90 days, does this match your expectations, and what would you change?" This conversation serves two purposes: it aligns expectations explicitly rather than leaving them implicit, and it demonstrates the kind of ownership mindset that FAANG performance reviews reward.

A common failure mode at early career is over-optimizing for the Day 30 milestone (understanding the system) at the expense of the Day 60 milestone (shipping something). The research phase can expand indefinitely if it is not time-bounded. Set a hard commitment to ship your first meaningful contribution by day 45 at the latest, even if it is smaller than you would prefer. Shipping is the primary signal that you are able to contribute, and it changes how the team treats you regardless of the size of the contribution.

### Senior @ FAANG: 30-60-90 as a Strategic Alignment Tool at L6

At L6, the 30-60-90 framework serves a different purpose than at early career. The three phases are not learn, ship, contribute. They are understand the landscape, form opinions, and begin driving change. The risk is not spending too long in learning mode: it is forming opinions too quickly and driving change before you have the organizational credibility to do it effectively.

A governance practice for senior onboarding: at the end of day 30, write a two-page technical landscape document. Describe what you have observed about the team's architecture, the known technical debt, the strongest and weakest parts of the system, and the most impactful improvements you could imagine making. Share it with your manager as a "here is what I am seeing, does this match your view" document, not as a change proposal. This positions you as someone who has done serious analysis, surfaces misalignments between your observations and your manager's, and builds credibility for the change proposals you will make in days 60 through 90.

---
