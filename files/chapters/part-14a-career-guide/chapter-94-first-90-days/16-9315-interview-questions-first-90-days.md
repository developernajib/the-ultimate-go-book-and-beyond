## 94.15 Interview Questions: First 90 Days

Many interviews, especially for mid-level and senior roles, include questions about how you approach onboarding, learning new codebases, and building relationships. These questions test your self-awareness, communication skills, and ability to navigate ambiguity. The following examples show you what interviewers are really evaluating and how to structure your answers to demonstrate maturity and intentionality.

### Question 1: "Tell me about how you onboarded at your last company. What worked well and what would you do differently?"

**What They're Evaluating:**
- Self-awareness about learning style
- Ability to adapt and integrate
- Proactive vs. Passive mindset
- Communication skills during transition

**Strong Answer Framework:**
```markdown
SITUATION: Describe the onboarding context
- Company size, team size, remote/in-person
- How structured was the onboarding?
- What resources were available?

APPROACH: What you did proactively
- How did you structure your learning?
- How did you build relationships?
- What did you do beyond assigned onboarding?

RESULTS: Concrete outcomes
- How quickly were you productive?
- Specific early contributions
- Relationships you built

LEARNINGS: Self-reflection
- What would you do differently?
- What did you learn about your learning style?
- How will you apply that here?
```

**Example Answer:**
> "At my last role at [Company], I joined a team of 8 engineers building a payments service. The onboarding was semi-structured - there was a 2-week program but then you were largely on your own.
>
> What worked well: I created my own 30-60-90 day plan and shared it with my manager for alignment. I scheduled 1:1s with everyone on the team in the first two weeks, which helped me understand who knew what. I also kept a learning log that I reviewed with my manager weekly.
>
> What I'd do differently: I was too focused on code initially and didn't invest enough in understanding the business context. The second month was harder because I was making technical decisions without understanding why certain product choices had been made. Next time, I'd spend more of week one with product and business stakeholders.
>
> By day 45, I shipped my first feature, and by day 90, I was leading a small project. The relationships I built early were key - when I got stuck, I knew exactly who to ask."

**Red Flags:**
- Blaming the company for poor onboarding
- No proactive steps taken
- No specific examples
- No self-reflection

---

### Question 2: "You join a team and the codebase is complex with minimal documentation. How do you approach getting up to speed?"

**What They're Evaluating:**
- Problem-solving approach
- Self-sufficiency vs. Asking for help balance
- Systematic thinking
- Communication during ambiguity

**Strong Answer Framework:**
```markdown
1. SYSTEMATIC EXPLORATION:
   - Start with README and any existing docs
   - Understand high-level architecture first
   - Map out key components and data flow
   - Read tests to understand expected behavior

2. ACTIVE LEARNING:
   - Trace a request end-to-end through the system
   - Debug a real issue to learn the codebase
   - Read recent PRs to understand current work
   - Run the system locally with a debugger

3. PEOPLE RESOURCES:
   - Identify who knows what areas
   - Schedule pairing sessions
   - Ask questions with context ("I tried X, saw Y...")
   - Capture answers for future reference

4. CONTRIBUTION TO DOCUMENTATION:
   - Document what you learn as you go
   - Fix docs that are wrong
   - Create missing guides
   - Help future new hires
```

**Example Answer:**
> "I approach undocumented codebases systematically. First, I'd get it running locally and trace a simple request through the system, drawing my own architecture diagram. This usually reveals 80% of the structure.
>
> Then I'd read recent PRs and git history for files I'll be working with - this shows me current patterns and recent decisions. Tests are also great documentation. I'd read the test suite to understand expected behavior.
>
> For what I can't figure out, I'd identify the experts for different areas and schedule short pairing sessions. I'd come prepared with specific questions and what I've already tried. After each session, I'd document what I learned and either add it to the wiki or send it to my buddy for review.
>
> I did this at [Previous Company] where I joined a team with a 200K line codebase and sparse docs. Within 3 weeks, I'd created a 10-page onboarding guide that became the standard for future hires."

---

### Question 3: "You're a senior engineer joining a new team. In week 2, you notice a significant architectural problem. What do you do?"

**What They're Evaluating:**
- Judgment and timing
- Respect for existing context
- Influence without authority
- Communication approach

**Strong Answer Framework:**
```markdown
FIRST: VALIDATE YOUR UNDERSTANDING
- Am I sure this is a problem?
- Do I understand why it's built this way?
- Could there be constraints I don't know?

THEN: GATHER CONTEXT
- Ask: "I'm curious about the architecture of X. Can you help me understand the history?"
- Look for design docs or decision records
- Talk to people who were there when it was built

THEN: ASSESS URGENCY
- Is this causing active problems?
- Is it blocking upcoming work?
- Can it wait until I have more credibility?

FINALLY: APPROACH THOUGHTFULLY
- Start with questions, not assertions
- Acknowledge trade-offs and constraints
- Offer to help, not just criticize
- Propose small, incremental improvements
```

**Example Answer:**
> "My first instinct would be to pump the brakes. In week 2, I probably don't have full context on why it's built that way. There might be constraints - business, historical, or technical - that I don't understand yet.
>
> I'd start by asking questions: 'I'm trying to understand the architecture of X. Can you help me understand how it evolved?' This often reveals that there were good reasons, or that the team is already aware and has it on the roadmap.
>
> If after gathering context I still believe it's a significant issue, I'd consider urgency. Is it causing active problems? If not, I'd likely wait until I've built more credibility - maybe month 2 or 3 - before proposing major changes.
>
> When I do raise it, I'd frame it as a question: 'I've been thinking about X and wondering if we've considered Y approach. It seems like it might help with Z. What am I missing?' This invites dialogue rather than triggering defensiveness.
>
> At [Previous Company], I joined a team with what I thought was a problematic caching strategy. I waited 6 weeks, and when I proposed a change with supporting data, the team was receptive because I'd earned credibility and understood the constraints."

---

### Question 4: "Describe a time when you had to build relationships quickly in a new environment. How did you approach it?"

**What They're Evaluating:**
- Interpersonal skills
- Proactive networking
- Emotional intelligence
- Adaptability

**Strong Answer Framework:**
```markdown
CONTEXT: The situation and why relationships mattered
ACTION: Specific steps you took
RESULT: Outcomes and impact
LEARNING: What you'd do again or differently
```

**Example Answer:**
> "When I joined [Company], I was the first Go engineer on a team of Python developers. I needed to build credibility quickly to influence technical decisions around our new Go services.
>
> I took a multi-pronged approach. First, I scheduled 30-minute 1:1s with every team member in my first two weeks - not to talk about work, but to understand their backgrounds, interests, and concerns. Second, I offered to pair with people on their tasks, helping them while learning the codebase.
>
> The key breakthrough was when I helped a senior Python engineer debug a performance issue by bringing profiling techniques from the Go world. That built technical credibility. From there, I started a weekly 'lunch and learn' where we shared knowledge across languages.
>
> By month 2, when I proposed using Go for a new service, I had built enough relationships that people trusted my judgment. The proposal was approved, and several Python engineers wanted to learn Go and work on it with me.
>
> What I learned: relationships are built through helping others, not just by being skilled. I'd do more pairing earlier next time - it accelerates both learning and relationship building."

### Junior → FAANG: Turning Your Onboarding Into Interview Stories

The onboarding experience you are building now will become the foundation of your behavioral interview answers for the next two to three job searches. Interviewers frequently ask "tell me about a time you had to get up to speed quickly in an unfamiliar codebase" or "tell me about how you built relationships at a new company." These are questions about your first 90 days at your current role.

Document your onboarding experience specifically enough to be useful as interview material. What problems did you encounter in your first month, what approaches did you try, what worked and what did not, and what did you learn that you applied to future situations. The specific numbers are particularly valuable: "I was productive enough to ship my first meaningful contribution by day 35" is more compelling than "I ramped up quickly."

The relationship-building stories from your first 90 days are often your strongest early-career behavioral signals because they demonstrate social and professional maturity that technical skills cannot demonstrate on their own.

### Senior @ FAANG: First-90-Days Narrative for Senior Interviews and Promotion Cases

At senior level, your first-90-days experience is a key component of your next senior interview narrative and potentially your promotion case at the current company. The story of how you entered a complex organizational environment, built credibility, identified the highest-leverage technical improvements, and drove alignment around them is precisely the story that hiring committees and promotion committees are looking for.

Document this story explicitly while it is happening. By day 90, you should be able to write a one-page narrative that describes: what you found when you arrived, what assessments you made and what drove them, what you did to build organizational credibility, and what technical changes you drove or initiated as a result. This narrative is the promotion packet material that will matter in six to eighteen months, and it is much easier to write accurately while the events are fresh than to reconstruct from memory after the fact.

The bar-raiser framing for this story: it should demonstrate that you created organizational capability or structural improvement, not just that you contributed individually. "I ramped up and shipped several features" is an L4 story. "I assessed the technical landscape, identified the three highest-leverage interventions, built alignment around one of them, and drove it to completion while creating a framework the team can use for the next two" is an L6 story.

---
