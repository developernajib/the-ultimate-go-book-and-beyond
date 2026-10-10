# Chapter 88: Technical Writing & RFCs

> If you cannot write it clearly, you have not thought it through. The act of writing a design doc is not how you communicate a decision, it is how you make it. The clarity comes from the writing, not before it.

There is a direct correlation between writing ability and career trajectory in software engineering that almost no one talks about early enough. The engineers who advance fastest at senior levels are not always the best coders in the room - they are almost always the clearest thinkers and the clearest writers. At L5 and above, a disproportionate share of your impact happens through documents: design docs that align a team before a line of code is written, RFCs that resolve multi-team disagreements about architecture, postmortems that turn painful incidents into lasting improvements, and strategy documents that shape how an organization prioritizes its technical investments. If you cannot write these documents well, you will consistently have less influence than your technical capabilities deserve.

The RFC - Request for Comments - is the canonical format for technical decision-making at scale. The format was invented by the Internet engineering community in the 1960s and has been refined by decades of use at every major technology organization. A well-written RFC does several things simultaneously: it documents the problem clearly enough that readers without context can understand it, it presents the proposed solution with its tradeoffs honestly disclosed, it anticipates objections and addresses them, and it creates a durable record of the decision and its rationale that future engineers can reference when they ask "why does this work the way it does?" A poorly written RFC, by contrast, generates endless comment threads, gets tabled indefinitely, or - worst of all - gets approved without genuine understanding, resulting in an implementation that surprises everyone when it ships.

Writing well for a technical audience is a learnable skill, and it is distinct from writing well in general. Technical writing requires a specific discipline: leading with the problem and the proposed solution before diving into detail, calibrating the depth of explanation to the audience's background knowledge, separating what is decided from what is still open, and being honest about uncertainty rather than projecting false confidence. It also requires an understanding of how decisions actually get made in organizations - which stakeholders need to be consulted, when to socialize a proposal informally before asking for formal review, and how to write an RFC that makes it easy for a busy VP to understand the tradeoffs and give a timely decision. This chapter covers all of these skills with Go-focused examples and templates you can adapt immediately.

**What you'll learn in this chapter:**

- The anatomy of an effective RFC: problem statement, context, proposed solution, alternatives considered, tradeoffs, and open questions
- How to write design documents for different audiences - peer engineers, cross-functional stakeholders, and technical leadership - with appropriate calibration for each
- The RFC process from inception to decision: when to write one, how to socialize it, how to manage the review period, and how to close it
- Architecture Decision Records (ADRs): when and how to use lightweight decision records alongside full RFCs
- Writing postmortems that are genuinely useful - blameless, specific, and oriented toward systemic improvement
- Technical strategy documents: how to write the kind of long-horizon technical investment case that influences roadmaps and headcount decisions
- Common failure modes in technical writing - burying the lede, false precision, avoiding tradeoffs, writing for consensus rather than clarity - and how to fix them
- Practical templates and examples for RFCs, design docs, ADRs, and postmortems in a Go services context

**The senior engineer perspective:**

At Stripe, writing is considered a core engineering competency, not a soft skill. Senior engineers are evaluated in part on the quality of their written output - design docs, technical proposals, postmortems - because the company operates largely asynchronously across time zones and the written record is how decisions get made and preserved. One Stripe L5 described the RFC process as "the forcing function that separates engineers who have good instincts from engineers who can actually justify their instincts." At Amazon, the six-page memo format (prose, no slides) is legendary - but the principle behind it applies everywhere: if you cannot write a narrative explanation of a technical decision, you probably don't understand it well enough to implement it. Engineers who master technical writing at senior levels consistently report that it gives them outsized influence - their proposals get acted on, their concerns get taken seriously, and their expertise becomes visible to people who would otherwise never see their code.

**Prerequisites:** Chapters 1--87, familiarity with system design and architectural decision-making.

### Junior → FAANG: Writing as the Missing Interview Skill

Most engineers preparing for FAANG interviews focus entirely on coding and system design. The behavioral round, which is substantially a writing quality assessment in disguise, receives far less preparation. When a bar-raiser asks "tell me about a major technical decision you drove," they are evaluating whether you can construct a clear problem statement, articulate the alternatives you considered, explain the tradeoffs you weighed, and describe the outcome. That is an RFC structure, narrated verbally.

Before your FAANG interview, write one RFC for a real problem you have faced or are facing. The act of writing it forces you to clarify your thinking in the same way the chapter describes. The resulting document becomes both a development artifact and the source material for your most compelling behavioral interview stories.

First-job engineers underestimate how much their written communication matters from day one. Design doc quality is visible to everyone who reads it, including skip-levels and senior engineers you have never met. A well-structured design doc signals senior-level thinking even at junior levels, which accelerates promotion timelines.

### Senior @ FAANG: Writing as Organizational Leverage

At L6 and above, your written output is your primary leverage mechanism. You cannot personally attend every architecture discussion. You cannot personally mentor every engineer. But a well-written RFC can align ten teams. A well-written design doc can prevent a class of architectural mistakes for two years. A well-written technical strategy document can shape roadmap priorities for three quarters without your direct involvement in any single planning meeting.

The engineering leaders who describe writing as their "superpower" at staff and principal level are not exaggerating. They have discovered that a well-reasoned document that preempts the obvious objections, presents the alternatives honestly, and leads with the recommendation rather than the background creates decisions faster than any meeting. The Amazon six-pager culture is explicit about this: the written narrative replaces the slide deck because it forces the author to have thought through the problem rather than assembled an impression of thinking.

At the governance level, technical writing also creates accountability infrastructure. A team that has documented its architectural decisions in ADRs can answer "why does this system work this way?" without calling an all-hands or hunting for the person who made the original decision three years ago. Staff engineers who build this documentation culture are investing in organizational resilience. The team that can onboard a new engineer using documents alone, without requiring a three-week oral history from senior members, is more robust than the team that stores all context in people's heads.

---
