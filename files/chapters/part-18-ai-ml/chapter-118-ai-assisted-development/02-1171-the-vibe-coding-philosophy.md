## 118.1 The Vibe Coding Philosophy

### What Vibe Coding Actually Is

On February 2, 2025, Andrej Karpathy, a founding member of OpenAI and former AI Director at Tesla, posted a throwaway tweet that named a generation of developers:

> "There's a new kind of coding I call 'vibe coding', where you fully give in to the vibes, embrace exponentials, and forget that the code even exists. It's possible because the LLMs (e.g. Cursor Composer w Sonnet) are getting too good. [...] I 'Accept All' always, I don't read the diffs anymore. When I get error messages I just copy paste them in with no comment, usually that fixes it. The code grows beyond my usual comprehension, I'd have to really read through it for a while."

Karpathy described a workflow where you describe what you want, AI writes it, you run it, it breaks, you paste the error back to AI, it fixes it, and you barely read the code in between. The code becomes almost irrelevant. The output is what matters.

This is a real and genuinely new way to build software. For certain tasks, including rapid prototyping, throwaway scripts, and exploring an unfamiliar library, it is liberating. A researcher who needs a data pipeline doesn't need to know Go idioms. A designer building a quick internal tool doesn't need to understand goroutines. For these use cases, vibe coding is a gift.

But read the rest of Karpathy's tweet, because the part that got quoted everywhere is not the part that matters. He also wrote that when the model could not fix a bug, he would "just work around it or ask for random changes until it goes away," and he closed with the actual scope of the idea: "It's not too bad for throwaway weekend projects." He was describing his own weekend hacking. He was not describing how to build a payment processor, a healthcare system, or a distributed database.

The problem is that the phrase escaped its context.

In 2025, "vibe coding" became both a celebration and a warning sign. The celebration: AI has made software development dramatically more accessible. The warning sign: production codebases being shipped by engineers who never read what AI wrote.

**This chapter is about something different: disciplined AI-augmented engineering.** You use AI aggressively, you move fast, you build more than you ever could alone, but you remain the engineer. You understand what's running. You own the quality.

### The Right Mental Model: You Are the Architect

Here is the mental model that changes everything:

**AI is your senior pair programmer. You are the tech lead.**

A senior pair programmer is invaluable. They can write boilerplate fast. They know patterns you haven't seen. They can review your code. They can explain unfamiliar libraries. They're available at 3am.

But a senior pair programmer doesn't own your architecture. They don't understand your business domain. They don't know the reason a certain design decision was made six months ago. They don't bear responsibility for what ships to production.

You do.

When you internalize this model, your relationship with AI changes entirely:

- You stop asking AI "build me an auth system" and start asking "implement the JWT validation middleware using this interface I've designed"
- You stop accepting the first output and start treating it as a draft that needs review
- You stop skipping tests because AI didn't generate them and start requiring AI to generate tests as part of every code request
- You start using AI for the work that doesn't require your judgment (boilerplate, documentation, test scaffolding) so you can focus on the work that does (architecture, domain logic, system design)

### The Spectrum of AI Assistance

There is a spectrum of AI involvement in development, and each point on the spectrum is appropriate for different contexts:

```text
AI Autocomplete → AI Pair Programming → AI Agent → Long-Horizon Autonomy
     (Copilot)         (Claude Code)      (Agents)     (Coding agents)
```
**AI Autocomplete** (GitHub Copilot inline, Cursor tab completion): Line-by-line suggestions as you type. Best for: finishing sentences, filling in known patterns, writing boilerplate you understand. Risk level: low, because you see every line before it runs.

**AI Pair Programming** (Claude Code, Cursor, Copilot Chat): You describe a task, AI writes a chunk of code, you review and integrate. Best for: functions, tests, documentation, debugging. Risk level: medium, because you must review before committing.

**AI Agent** (Claude Code with tools, Aider, Cursor Agent): AI reads your codebase, makes file edits, runs commands, iterates. Best for: well-scoped tasks with clear acceptance criteria. Risk level: higher, because the agent is making decisions independently and touching your filesystem. You must review all changes, and you should constrain what the agent is permitted to run.

**Long-Horizon Autonomy** (GitHub's Copilot coding agent, Devin, and similar): the agent takes an issue and works a whole branch with minimal input, opening a PR at the end. Best for: well-defined, low-risk tasks on mature codebases. Risk level: highest, and it requires strong review gates precisely because nobody watched the intermediate steps.

Note that this tier is the most volatile part of the entire tool landscape. GitHub's Copilot Workspace, the product that popularized the category, was sunset on May 30, 2025, and its ideas were folded into Copilot's agent mode and coding agent instead. Treat the product names in this section as illustrations of a shape, not as a shopping list, and check what exists before you plan around it. The shape is durable. The vendors are not.

The maturity to know which mode is appropriate for which task is itself a senior engineering skill.

### Why Senior Engineers Use AI Differently Than Juniors

The two patterns below are archetypes rather than survey data, but the difference they illustrate is the one that shows up in code review every day.

**Junior/Intern pattern:**
1. Get a task: "add user authentication"
2. Prompt AI: "write user authentication in Go"
3. Paste output into codebase
4. It compiles, push to PR
5. Never understand how it works

**Senior engineer pattern:**
1. Get a task: "add user authentication"
2. Design the interfaces and data models first (5 minutes on a whiteboard)
3. Write the interface definitions and test contracts (15 minutes)
4. Use AI to implement each concrete function against those contracts (20 minutes)
5. Review every line of AI output for security, error handling, edge cases (20 minutes)
6. Run the tests, fix failures (10 minutes)
7. Understand what shipped

The senior path looks slower on paper, and sometimes it genuinely is on the day. The difference shows up later. The senior engineer owns the result: they can explain every design decision, debug the production issue at 3am, and extend the system six months on. The junior's version shipped sooner and will be paid for repeatedly, by someone, at a time nobody chose. The timings on those steps are illustrative, not measured, and this is exactly the kind of comparison you should distrust when a vendor puts numbers on it.

### The Risk of Vibing Without Understanding

Let's be concrete about what goes wrong when you ship AI-generated code you don't understand.

**Security holes**: In 2024, multiple security researchers demonstrated that AI code assistants reliably suggest insecure patterns: MD5 for password hashing, JWT decoding without signature verification, SQL concatenation instead of parameterized queries. These bugs look exactly like correct code to someone who doesn't know what to look for.

**Wrong abstractions**: AI doesn't know your business domain. It will create abstractions that seem reasonable but don't map to how your domain actually works. These mismatches compound, and each new feature becomes harder to add correctly.

**Unmaintainable code**: AI-generated code is often verbose, repetitive, and lacks the coherent design vision that comes from a human who thought deeply about the problem. Three months later, no one, including the original author, can reason about it.

**Performance traps**: AI will happily write N+1 queries, allocate in hot loops, miss obvious caching opportunities. It doesn't feel the pain of a slow system. You do.

**Dependency bloat**: AI defaults to adding libraries for everything. It will suggest a 50,000-line library to parse a simple config file.

These are not hypothetical. They are the real bugs in production systems today. The solution is not to use less AI. It is to stay in the driver's seat.

### The Goal: More Leverage Without Losing the Quality Bar

Here is the promise, stated plainly and without the usual inflation:

An engineer who uses AI tools well can move meaningfully faster on the parts of the job that are mechanical, while holding the same quality bar. That is the honest claim, and it is worth a great deal. The "5x to 10x engineer" version of this claim, which you will see everywhere, has no evidence behind it. The largest speedup ever measured in a controlled trial is GitHub's 55% on a single greenfield task, and the best evidence we have from real work in real repositories (METR, 2025) found a slowdown. Anyone selling you a 10x multiplier is selling you something.

This matters beyond honesty in advertising, because the size of the multiplier you believe in determines how you work. An engineer expecting 10x skips review to reach it. An engineer expecting a solid gain on mechanical work reviews everything and gets the gain.

The leverage comes from:
- Eliminating the time spent writing boilerplate (tests, validation, DTOs, documentation)
- Accelerating the learning curve for unfamiliar libraries and frameworks
- Getting instant feedback on architecture decisions
- Automating the mechanical parts of code review
- Generating draft documentation and ADRs in minutes

The quality comes from:
- You still design the architecture
- You still write the tests contracts
- You still review every line of AI output
- You still own the security properties
- You still understand the system end-to-end

This is the goal. The rest of this chapter is how to achieve it.

### Junior → FAANG: Vibe Coding as a Discipline, Not a Shortcut

The word "vibe" is misleading to engineers who interpret it as casual or undisciplined. In the context of AI-assisted development, vibe coding means maintaining a high-level mental model of what you are building and delegating the implementation details to AI, while staying responsible for correctness. The discipline is in knowing which details you can safely delegate and which require your direct attention. You can delegate boilerplate HTTP handler structure to AI. You cannot delegate the decision of which fields to include in a JWT payload, because that decision has security implications that require engineering judgment.

For FAANG interviews, the vibe coding philosophy reframes the question "what did you build?" to "what did you design and verify?" Engineers who understand this distinction describe their AI-assisted work in terms of decisions: "I decided on the interface, defined the test cases that captured the contract, used AI to generate the implementation, and reviewed the implementation for correctness and security." Engineers who do not understand the distinction say "I had AI write it," which raises questions about whether they understand the code they merged. Practice describing any AI-assisted project in terms of the decisions you made, the things you verified, and the issues you caught and corrected.

The concrete Go examples in this section (interface definition before implementation, test cases before generation, prompt with context before a generic prompt) are the workflow habits that produce AI-assisted code quality high enough for FAANG production environments. Internalize them as defaults: never ask AI to generate a function without first specifying its signature and at least one test case. Never accept AI-generated code without checking error handling and edge cases. Never merge AI-generated code without running the test suite. These three habits, applied consistently, close most of the quality gap between AI-generated and carefully hand-written code.

### Senior @ FAANG: Vibe Coding Philosophy as Team Engineering Culture

At senior level, the vibe coding philosophy defines a team's relationship with AI tools in terms of accountability and review standards. The philosophy must be operationalized into concrete policies: what is the minimum required review checklist for AI-generated PRs? At what percentage of AI-generated code does a PR require a second reviewer? How do you track which code in the codebase is AI-generated, for the purpose of future audits and incident analysis? These policies do not exist by default. Staff engineers define them and embed them in the team's code review workflow.

The "delegate implementation, own decisions" framing of vibe coding has an organizational corollary: as AI capabilities increase, the set of decisions that require senior engineers shifts upward toward higher abstraction. Senior engineers no longer need to spend time on function implementation details. They spend time on interface design, data model decisions, security architecture, and system-level trade-offs. This shift is measurable in terms of where senior engineers' time goes over a 6-month period before and after AI tool adoption. Teams that measure this shift and consciously redirect the freed time toward higher-abstraction design work capture the productivity gains from AI adoption. Teams that do not measure it often find that senior engineers' time fills with AI-generated code review rather than architectural work, which is a suboptimal allocation.

The philosophy of maintaining a high-level mental model while delegating implementation connects directly to the "L6 thinks in systems, not functions" principle from FAANG calibration. An L6 engineer using AI tools is designing the system architecture, defining the interfaces between components, and specifying the correctness criteria. An L4 engineer using AI tools is implementing the function bodies and unit tests. The AI tool does not change the hierarchy. It shifts the work at each level upward toward design and specification while automating the implementation expression. Recognizing and communicating this shift is part of how staff engineers frame AI adoption strategy to engineering leadership.

---
