# Chapter 94: Your First 90 Days - Starting Strong at Your New Role

*You never get a second chance to make a first impression, but in engineering, your first 90 days set the trajectory for your first three years.*

Joining a new company is one of the highest-leverage moments in your entire engineering career. The way you navigate the first 90 days determines whether you are perceived as someone who can be trusted with ambiguous, high-impact work or someone who needs close supervision to deliver. Studies of engineering onboarding at large tech companies consistently show that new hires who establish credibility in the first three months are promoted faster, assigned to higher-visibility projects, and rated more highly at their first performance review - not because they worked harder, but because they were more intentional about building relationships, delivering visible wins, and understanding how the organization actually operates beneath the org chart.

For Go engineers joining infrastructure teams, platform engineering groups, or backend services organizations - which is where the majority of Go roles live - the first 90 days carry additional technical dimensions. You are likely inheriting a large, interconnected codebase with its own conventions around error handling, logging, concurrency patterns, and service boundaries. Learning to contribute meaningfully without accidentally introducing regressions, understanding the deployment pipeline, and building trust with the team through code reviews and on-call participation are all skills that go far beyond what any interview process tests for.

This chapter gives you a structured 30-60-90 day framework designed specifically for software engineers, with concrete checklists, communication scripts, and strategies for each phase. The first 30 days focus on learning the system and building relationships. Days 31 through 60 shift toward consistent contribution and identifying where you can add distinct value. The final phase focuses on delivering visible impact, demonstrating ownership, and positioning yourself for long-term success at the company.

**What you'll learn in this chapter:**
- The 30-60-90 day framework: what to prioritize in each phase and why
- How to read a large Go codebase quickly and safely make your first contributions
- Building relationships with your manager, teammates, and cross-functional stakeholders
- Identifying and delivering early wins that build trust and social capital
- How to navigate on-call rotations and production incidents as a new hire
- Common onboarding mistakes that damage credibility and how to avoid them
- How to run effective 1:1s with your manager from day one
- Setting goals that align your personal development with team priorities

**Why this matters at scale:**
Google's Project Oxygen research established that manager quality is the dominant lever on team performance, and the onboarding relationship between a new hire and their manager is where that lever bites first - which is why large tech companies have formalized structured "new hire success" programs precisely because the cost of a mis-onboarded engineer at senior levels runs into hundreds of thousands of dollars in lost productivity and rehiring.

**Prerequisites:** Chapter 92 (interview process and offer acceptance), general familiarity with Go codebase navigation

### Junior → FAANG: What the First 90 Days Actually Determine

Most early-career engineers treat the first 90 days as an orientation period where mistakes are forgiven and expectations are low. That framing is partially true and dangerously incomplete. The first 90 days set the perception of your capabilities in the minds of the people you will work with for years. Perceptions formed in the first three months are slow to change. An engineer who is seen as careful and delivery-oriented in month one will get the benefit of the doubt in month six. An engineer who is seen as slow to ramp or reluctant to ask questions will carry that perception long after it has stopped being accurate.

The highest-leverage activity in the first 30 days is listening and asking questions, not shipping. New engineers who ship quickly before understanding context often ship the wrong thing and create cleanup work for the team. New engineers who spend the first few weeks deeply understanding the system architecture, the team's current priorities, and the implicit norms of the codebase will ship better work faster starting in month two.

Go-specific onboarding context: if the team uses Go in production, your first task should include reading the team's Go code before writing any of it. Look for patterns in error handling, interface design, and package organization. Understand whether the team prefers explicit dependency injection or uses global state, whether they use context propagation consistently, and how they structure tests. Adopting the team's style before proposing improvements is the signal of a high-trust new hire.

### Senior @ FAANG: Entering at Senior Level and the Coalition-Building Imperative

Senior engineers joining a new team face a different set of first-90-days challenges than early-career engineers. The technical ramp is usually shorter. The organizational and relational ramp is usually longer and more consequential.

The most common failure mode for senior engineers in their first 90 days is proposing significant technical changes before building the relationships and context needed to drive those changes. A new senior engineer who identifies a real architectural problem and proposes a solution in week three will often see the proposal rejected not because the solution is wrong but because the team does not yet trust the engineer's judgment about the system. The same proposal made in week twelve, after three months of demonstrated understanding and collaborative work, will often be received entirely differently.

The governance principle for senior onboarding: build trust before building change. Specifically, spend the first 30 days in listening mode. Understand not just the technical architecture but the organizational history: why was this component built this way, what was tried before and failed, which technical decisions are settled and which are still actively debated. This context is not in the documentation. It is in the heads of the people on the team, and the only way to get it is through relationship investment.

Staff-level joining dynamics are more complex still. At L7, you are expected to have an opinion about technical direction from relatively early in your tenure, but expressing that opinion before you have organizational credibility will damage rather than build your influence. The balance is: ask well-formed questions that reveal your thinking ("I've seen a few patterns for managing service-to-service authentication at scale, and I'm curious how this team settled on the current approach and what the known limitations are") rather than statements ("your current auth approach has these problems and here's what you should do instead"). The first approach builds the relationship and demonstrates depth simultaneously.

---
