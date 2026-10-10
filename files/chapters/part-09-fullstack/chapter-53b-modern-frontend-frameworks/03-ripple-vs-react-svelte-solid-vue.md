## 53B.3 Ripple vs React, Svelte, Solid, and Vue

Framework comparisons are easy to botch because the strengths of each show up at different project sizes. The following table focuses on the dimensions Go backend engineers care about when picking a frontend for a full-stack product.

| Dimension | React 19 | Vue 3.5 | Svelte 5 | Solid 1.9 | Ripple 0.3 |
|-----------|----------|---------|----------|-----------|------------|
| Rendering model | Virtual DOM diff | Virtual DOM diff | Compiled, fine-grained | Fine-grained signals | Fine-grained tracking |
| State primitive | `useState` / `useReducer` | `ref` / `reactive` | `$state` rune | `createSignal` | `track` + lazy destructuring |
| Derived state | `useMemo` | `computed` | `$derived` | `createMemo` | `track(() => ...)` |
| Side effects | `useEffect` | `watchEffect` | `$effect` | `createEffect` | `effect` |
| Dependency tracking | Manual (deps array) | Automatic | Automatic | Automatic | Automatic |
| Component body | Function return JSX | SFC with `<template>` | `<script>` + markup | Function return JSX | `component` keyword + JSX |
| Error boundaries | Class component or lib | `<ErrorCapture>` | `<svelte:boundary>` | `<ErrorBoundary>` | Native `try/catch` |
| Control flow | JSX expressions | `v-if`, `v-for` | `{#if}`, `{#each}` | `<Show>`, `<For>` | Native `if`, `for`, `try` |
| TypeScript fit | Retrofit, awkward generics | Good, SFC tooling | Good since v5 | Excellent | Designed around TS |
| Bundle size (small app) | 45 KB gzip | 34 KB gzip | 3 KB gzip | 7 KB gzip | 4 KB gzip |
| Ecosystem depth | Vast | Large | Growing | Niche but strong | Early |
| Production maturity | Extensive | Extensive | Production-ready | Production-ready | Pre-1.0, evaluate carefully |
| Learning curve (from React) | Baseline | 1-2 weeks | 2-3 weeks | 1-2 weeks | 2-3 weeks |

### Where Ripple Wins

**Data-dense UIs.** Dashboards with thousands of rows, real-time charts, order books, and admin panels all benefit from fine-grained updates. React's virtual DOM diff dominates CPU time at this scale. Ripple (like Solid and Svelte) updates only the DOM nodes whose data actually changed.

**Type safety.** TypeScript support is first-class rather than bolted on. Generic components, inferred props, and reactive values type-flow cleanly through component boundaries without the `forwardRef` / `ComponentPropsWithoutRef` dance that React + TypeScript requires.

**Cleaner authoring.** The `component` keyword plus native control flow plus reactive collections mean fewer APIs to learn and fewer places to put bugs. `useCallback` / `useMemo` discipline disappears.

**AI pair-programming fit.** Large language models produce cleaner code in Ripple than in React with hooks, because the rules-of-hooks constraint disappears. This is a real 2026 advantage when Claude Code, Copilot, and Cursor are reviewing and generating large parts of component code.

### Where Ripple Loses

**Ecosystem depth.** React has a library for everything. Vue has Element Plus and Vuetify. Ripple in 2026 is pre-1.0 and the library ecosystem is thin. For apps that need charting, date pickers, rich text, and complex forms, you will be building more from scratch or wrapping web components.

**Hiring and onboarding.** A React engineer can join any React codebase in a week. A Ripple engineer pool does not exist at scale yet, so every new hire means onboarding cost.

**Production track record.** Large production deployments are the ultimate test. As of early 2026, the biggest Ripple apps are single-team internal tools. React, Vue, Svelte, and Solid have all shipped at consumer scale.

**Stability.** Pre-1.0 means breaking changes. If your product has a 5-year maintenance horizon, a Ripple migration in 2027 to the 1.0 API is a real cost you need to plan for.

### Decision Rubric

| Your situation | Recommendation |
|---------------|----------------|
| Shipping a product in 2026 that must survive 5 years of team turnover | React or Vue |
| Greenfield internal tool, small team, willing to migrate at 1.0 | Ripple or Solid |
| Data-dense real-time dashboard | Solid or Ripple |
| Existing Svelte codebase | Stay on Svelte 5 |
| Existing React codebase | Don't migrate. Adopt Ripple for new surface area if the team is excited |
| CMS-style content sites | Vue or Astro |
| Need React Native / Expo | React |

### The "Post-React" Category

Ripple, Solid, and Svelte 5 share a thesis: **the virtual DOM was a useful abstraction for 2013, but 2026 engineers know enough about the browser to do better.** Fine-grained reactivity, compiled templates, and tracked collections all push render work closer to the specific DOM mutation rather than diffing an entire tree.

If you are choosing between these three post-React frameworks for a new project, the honest decision is:

- **Svelte 5**: biggest community among the three, most mature tooling, best for teams that want a "learn once, deploy anywhere" story.
- **Solid**: most React-like authoring (functions + JSX + signals), lowest friction for React engineers. Best tooling for data visualization.
- **Ripple**: cleanest syntax, best TypeScript story, but pre-1.0 and thinner ecosystem.

All three are better than React for most greenfield SPAs in 2026. The main reason to pick React anyway is ecosystem lock-in (React Native, existing component libraries, available hires).

### Junior → FAANG: How to Read a Framework Comparison Table

Comparison tables are one of the most misread artifacts in software engineering. Junior engineers tend to count the "wins" and pick the framework with the most green cells. That approach produces consistently bad decisions.

The right way to read the table in this section:

First, identify which dimensions are non-negotiable for your project. If you need React Native, every other column is irrelevant. If your team is building a CMS-driven site, "bundle size" and "fine-grained reactivity" are much less important than "ecosystem depth" and "SSG/SSR tooling."

Second, distinguish between table cells that are stable and cells that are actively changing. "Production maturity: Extensive" for React is stable. "Production maturity: Pre-1.0" for Ripple is a cell that will change within 12-18 months. Building your decision on a snapshot metric without noting its trajectory is a mistake.

Third, the "Learning curve (from React)" row is biased toward React engineers. If your team is primarily Svelte engineers, the curve for Ripple is not "2-3 weeks from React," it is different and possibly shorter.

Interview preparation: a common FAANG system design warm-up asks you to compare two technologies and recommend one. Practice structuring your answer as: "My non-negotiables are X and Y. On those dimensions, framework A wins for these specific reasons. The trade-off is Z, and I accept it because..." That structure signals that you understand trade-offs rather than memorizing rankings.

### Senior @ FAANG: Framework Selection as an Organizational Decision

The decision rubric in this section is technically sound but treats framework selection as an individual engineering choice. At L6 and above, the frame shifts: the question is not "which framework should I pick for this project" but "what framework governance process should my organization have, and which framework does that process currently endorse?"

The difference matters. A principal engineer who picks Ripple for their project and is correct on the technical merits has still made a point decision when a policy decision was needed. The downstream cost: three other teams independently evaluate the same space, one picks Ripple, one picks Solid, one picks Svelte 5, and now the platform team is supporting three different build pipelines, three different component library ecosystems, and three different onboarding paths.

The "post-React category" framing is a useful narrative for a conference talk. For an organizational decision, it obscures the real question: is this organization ready to take a coordinated bet on a post-React framework, or are we in the phase where React is still the standard and deviations require a formal exception process?

For staff engineers designing a frontend platform: the comparison table is an input to a maturity model, not an output. The maturity model for framework adoption looks like this. At Level 1, one team is experimenting. At Level 2, three or more teams have adopted and are sharing learnings. At Level 3, the platform team has built shared tooling (component library, design tokens, build pipeline). At Level 4, the framework is the organizational default. At Level 5, the framework has a formal migration path for incoming teams. Ripple is at Level 1 for most organizations in 2026. That is the right level to be experimenting, but the wrong level to be making hiring decisions around.

The "don't migrate" recommendation in the decision rubric for existing React codebases is correct and often ignored. Senior engineers at FAANG-equivalent companies regularly propose whole-codebase migrations as the solution to framework dissatisfaction. The ROI calculation almost never closes. A 200,000-line React codebase represents years of product iteration locked inside the component model. The migration cost is linear in codebase size and exponential in coupling (state managers, component libraries, test utilities all need parallel migration). The better strategy is the one the rubric implies: adopt the new framework for new surface areas, let the strangler-fig pattern do the work over 2-3 years, and do not gate product launches on migration completion.

Bar-raiser interview signal: if a candidate proposes a big-bang framework migration as a solution to performance or DX problems, ask them to walk through the migration plan at the granularity of a sprint. Candidates who have done large-scale migrations will immediately identify the risks (component parity verification, test coverage gaps during migration, team context-switching cost). Candidates who have not will describe the ideal end state without a credible path to reach it.

---
