## 53B.5 When to Pick Ripple (and When Not To)

Honest evaluation frameworks beat fan-club recommendations. Below is the criteria list we use when we recommend Ripple to teams, inverted so you can also see when to walk away.

### Pick Ripple when

- The product is greenfield and the team is comfortable with a pre-1.0 framework.
- TypeScript-first authoring is a priority (the whole team writes TS, not a mix).
- The UI is data-dense (dashboards, admin panels, real-time views) where fine-grained updates outperform virtual DOM diffing.
- You want less runtime code and smaller bundles than React gives you.
- Your team has built SPAs before and can evaluate framework trade-offs critically. Ripple is not the framework for someone's first SPA.
- You are willing to contribute small fixes upstream. Pre-1.0 frameworks get better when their users report and fix issues.

### Pick something else when

- You need a component library with the breadth of MUI, Element Plus, or Radix. As of 2026, the Ripple component ecosystem is thin.
- The product must survive 5+ years with minimal framework-level churn. Pre-1.0 status means at least one more breaking change is coming.
- Your team has shallow TypeScript bench strength. Ripple leans harder on the type system than React does.
- You are hiring frontend engineers off the open market and cannot afford a 2-3 week onboarding ramp per hire.
- You need React Native (or Expo) for mobile. Ripple is web-only.
- The product is a CMS-driven content site. Astro, Next.js, or Nuxt give you more CMS-integration leverage out of the box.

### The Rust Analogy

Ripple in 2026 feels like Rust in 2018: technically excellent, beloved by its users, clearly on track to be important, but pre-1.0 in the parts of the ecosystem (tooling, libraries, hiring) that matter for production. If you can absorb that risk in exchange for a materially better authoring experience, the payoff is real. If you cannot, wait for 1.0.

### Integration Points with Other Chapters

- **Chapter 53** (Frontend Integration Fundamentals): CORS, cookies, session handling, WebSocket auth. These patterns are framework-agnostic and apply to Ripple the same way they apply to React.
- **Chapter 56** (GraphQL with Go): Ripple components consume GraphQL subscriptions through `graphql-ws` the same way React components do. The reactive-collections story is smoother than Apollo Client's cache invalidation.
- **Chapter 57** (BFF Pattern): the BFF chapter is where the Go + Ripple stack composes best. One BFF per experience, one Ripple SPA per surface, shared TypeScript types generated from the BFF's OpenAPI spec.
- **Chapter 38** (REST Fundamentals) and **Chapter 42C** (gRPC / GraphQL / Webhooks): API design decisions shape how pleasant Ripple's data layer will be.

### Common Mistakes

**Over-using `effect` as "the `useEffect` I know."** Reactive tracking makes most `useEffect` patterns unnecessary. Before reaching for `effect`, ask: "Can this be a `track(() => ...)` derived value?" or "Can this live inside the event handler that triggered it?" Many `useEffect` habits in React are working around React's re-render model. Ripple does not have those constraints.

**Mutating non-reactive objects and expecting updates.** `RippleArray` / `RippleObject` / `RippleMap` / `RippleSet` track mutations. Plain `Array`, `Object`, `Map`, `Set` do not. A common bug is receiving plain arrays from `fetch` and pushing into them directly without wrapping, then wondering why the UI did not update.

**Leaking reactivity across async boundaries.** When you read a tracked value inside an async function, the reactive context ends at the first `await`. If the function resumes later and writes, the write still triggers updates to subscribers, but reads after the first await no longer subscribe. For complex flows, pass `.value` explicitly or re-enter the reactive context with `effect`.

**Putting heavy logic inside the template.** The `component` body is a reactive context. Inlining a 200-line function inside the JSX works, but debugging it is painful. Extract to named helpers outside the component.

### Senior-Track Observations

**For engineers at FAANG-equivalent companies choosing frontends:** Ripple is a high-signal bet. The creator's track record is exceptional, the technical design is coherent, and the velocity of the project is accelerating. The risk is not "will Ripple survive?" but "will Ripple reach 1.0 before your project ships?" For 12-month-or-longer greenfield bets, Ripple is worth the evaluation slot. For anything shipping this quarter, pick the framework with the biggest existing bench.

**For managers staffing a team:** the current hiring pool for Ripple is small, so you will be onboarding React, Svelte, or Solid engineers into it. Budget 2-3 weeks of ramp per engineer. The onboarding is cheaper than it sounds because there is less framework surface area to learn than React has. The retention upside is real: engineers who have used fine-grained reactive frameworks tend not to want to go back.

### Junior → FAANG: Turning a "When to Use" List Into a Decision Habit

The "pick Ripple when" and "pick something else when" lists are useful starting points, but in practice you will face situations that fall in both lists simultaneously. For example: the product is greenfield (Ripple column) but you need to hire frontend engineers off the open market (not-Ripple column). Learning to resolve those tensions is the skill that gets you promoted.

The resolution process has three steps. First, identify which criteria are hard constraints (if violated, the project fails) versus soft preferences (nice to have). Needing React Native is a hard constraint. Wanting smaller bundles is a soft preference. Hard constraints eliminate options. Soft preferences rank the remaining ones.

Second, weight the criteria by the product timeline. For a product shipping this quarter, pre-1.0 stability is a hard constraint. For a product shipping in 18 months, it is a soft preference because the framework may reach 1.0 before you ship.

Third, make the decision and document it. The documentation step is what separates junior from mid-level engineers. A junior writes code. A mid-level engineer writes code and leaves a comment explaining why React was chosen over Ripple for this specific project. A senior engineer writes an ADR.

The four "common mistakes" in this section are interview gold. If you are asked about Ripple in a technical screen, leading with "here are the three mistakes engineers make when adopting Ripple, and here is how I would avoid each" signals that you have thought about the framework at a production-readiness level, not just a tutorial level.

The Rust analogy is accurate and useful for calibrating stakeholder expectations. Use it: "Ripple in 2026 is where Rust was in 2018. The people using it love it and it is clearly the future, but the tooling and ecosystem are not mature yet. Our plan is to adopt it for this bounded surface and upgrade to 1.0 when it lands."

### Senior @ FAANG: Pre-1.0 Adoption Governance and Technical Risk Management

The "over-using `effect`" and "mutating non-reactive objects" mistakes listed in this section are correctness bugs with a common root cause: engineers are translating their React mental model directly into Ripple without understanding the different execution semantics. That translation failure is predictable, and it has a governance response: structured onboarding.

Structured onboarding for a pre-1.0 framework at a FAANG-equivalent company should include four elements. First, a written list of the three to five most common React-to-Ripple translation errors, with before-and-after code examples. The mistakes in this section give you three: overuse of `effect`, non-reactive object mutation, and reactivity loss across async boundaries. These should be in your team's engineering wiki, not just a book chapter. Second, a lint rule or code review checklist that flags the most detectable forms of each error. Third, a shared test utility that makes it easy to assert that a specific DOM node updated (or did not update) in response to a state change, so correctness bugs surface in CI rather than in production. Fourth, a designated Ripple champion per team, someone who is further along the learning curve and can answer the translation questions quickly.

The "async boundary reactivity" mistake is architecturally significant beyond the debugging annoyance. It means that Ripple's reactive system has a formal constraint that is not present in React: reactive subscriptions established before an `await` are valid, while subscriptions established after an `await` inside an `effect` are not. That constraint is a consequence of how Ripple tracks the current reactive owner. At the platform level, this constraint should be documented in the architecture decision record for any service that uses Ripple for real-time data with complex async fetch chains. The pattern "read tracked values before any `await`, pass their `.value` explicitly into the async path" should be a documented convention, not left to each engineer to discover independently.

The FAANG bar-raiser question for this section: "How do you prevent a pre-1.0 framework adoption from creating long-term technical debt?" The expected answer covers bounded adoption scope, documented exit criteria, automated migration tooling evaluation at 1.0, and a sunset plan for the current version if the 1.0 API breaks significantly. An answer that covers "we adopted it carefully and the team was excited" without touching governance or reversibility is an L4 answer, not an L6 one.

Staff-level maturity model signal: the section ends with a retention claim ("engineers who have used fine-grained reactive frameworks tend not to want to go back"). That claim has an organizational implication that is easy to miss. If fine-grained reactive frameworks produce higher developer satisfaction, and you adopt Ripple, and then 1.0 forces a migration that temporarily degrades the authoring experience, you have a retention risk. Engineers who joined for the Ripple DX may become frustrated during the 1.0 transition if the migration is disruptive. Planning the 1.0 migration as a first-class engineering project, not an afterthought, is the staff-level response to that risk.

---
