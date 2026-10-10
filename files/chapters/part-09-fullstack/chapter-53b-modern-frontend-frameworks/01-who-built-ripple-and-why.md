## 53B.1 Who Built Ripple and Why It Matters

Ripple is the work of **Dominic Gannaway**, a JavaScript framework engineer with an unusual CV: he was a core contributor to React at Facebook (where he worked on the Fiber reconciler, concurrent rendering, and Suspense), he created **Inferno** (a high-performance React-compatible library that pioneered many of the optimization techniques later adopted by React itself), he built **Lexical** (Meta's extensible rich-text editor that now powers Facebook, Instagram, and WhatsApp web clients), and he was a principal author of **Svelte 5** (including the runes system).

That pedigree matters. Most frontend frameworks are designed by teams who love one paradigm (React's virtual DOM, Vue's templates, Svelte's compiler) and push it as far as it can go. Ripple is designed by someone who has shipped all three paradigms in production, seen where each hits a wall, and built something that deliberately avoids the known failure modes.

### The Problems Ripple Is Trying to Solve

From Dominic's public writing and conference talks, the core frustrations that drove Ripple are:

**1. React hooks feel like they leak implementation.** `useMemo`, `useCallback`, `useEffect` with dependency arrays, and the "rules of hooks" force component authors to think about the render cycle on every line of code. Fine-grained reactive frameworks (Solid, Svelte, Vue, now Ripple) remove that leakage by tracking dependencies automatically.

**2. Virtual DOM diffing is expensive at scale.** React re-renders entire component trees and diffs the output. For a typical SPA that is fine. For a data-dense dashboard with thousands of rows, the diff cost dominates. Ripple compiles to fine-grained DOM updates that touch only the specific nodes whose source data changed.

**3. TypeScript grafted onto JSX feels awkward.** Generic components, forwardRef types, and prop inference have been a long-running pain in React + TypeScript. Ripple designs the component syntax around TypeScript from the start, so types flow through components, props, and reactive values without the ceremony.

**4. Component authoring syntax is noisy.** React has JSX + hooks + refs + keys + fragments + context. Svelte has `$:`, `$state`, `$derived`, `$effect`, slots, reactive declarations, runes. Ripple collapses these into one primitive (`track`) plus the `component` keyword, and uses native control flow (`if`, `for`, `try/catch`) inside the template instead of inventing new directives.

### Why This Matters for Go Engineers

Ripple is not "just another framework." It is the framework where the person who built large chunks of React, Inferno, Lexical, and Svelte 5 has had 10+ years to figure out what is actually wrong with each of them. If you are picking a frontend framework for a new Go-backed product in 2026 and you care about long-term maintenance cost, Ripple deserves the evaluation slot that most teams default to React.

**Project links (as of 2026-04):**

- Repository: [github.com/Ripple-TS/ripple](https://github.com/Ripple-TS/ripple)
- Creator: [@trueadm on GitHub](https://github.com/trueadm) (Dominic Gannaway)
- Maturity: v0.3.x, 7,000+ GitHub stars, 280+ releases, active community on Discord
- License: Open source, TypeScript + MIT model
- VSCode extension, Prettier plugin, and ESLint integration available

**Honest caveat.** Ripple is pre-1.0. The API is stabilizing but not frozen, and you should expect at least one more breaking change before 1.0 lands. For production systems with long-tail maintenance requirements, this is a real risk. For greenfield projects with a 2026-2027 launch window, the risk is acceptable in exchange for a materially better developer experience.

### Junior → FAANG: Why Creator Pedigree Matters When Evaluating Tools

When you are evaluating any library or framework for the first time, one of the fastest trust signals is the creator's track record. Dominic Gannaway is not a hobbyist framework author. He shipped optimization work inside React at Facebook, built Inferno as a proof-of-concept that the virtual DOM could be made dramatically faster, and was a principal author of Svelte 5's runes system. Each of those projects was a response to a concrete performance or DX problem.

The junior habit to build: when you evaluate a new tool, spend 15 minutes reading the creator's blog posts, GitHub issues, and conference talks before you read the documentation. You will understand the documentation twice as fast because you will know what problem each design decision is solving.

The four problems listed in this section (hooks leakage, virtual DOM cost at scale, TypeScript awkwardness, noisy authoring) are not opinions. They are patterns that showed up repeatedly in large production codebases. If you have never worked on a codebase with 500+ React components, some of these may feel theoretical. They are not. Dependency-array bugs in `useEffect` and `useMemo` are a real maintenance cost in large React codebases. Understanding that history gives you language to explain your framework choice in an interview.

Interview entry point: "Walk me through how you evaluate a new open-source dependency." The expected answer covers creator credibility, project velocity (commit frequency, issue response time), license, test coverage, and reversibility cost if you need to migrate away. Most junior answers stop at "it had a lot of GitHub stars."

### Senior @ FAANG: Creator Pedigree, ADRs, and the Governance of Third-Party Framework Adoption

The creator-pedigree framing in this section is correct but incomplete for staff-level decision-making. Dominic Gannaway's track record is strong evidence that Ripple's technical design is thoughtful. It is not sufficient evidence that Ripple will be maintained at the support level your organization needs.

The questions that belong in your ADR when adopting a framework backed by a single principal author:

First, succession risk: what happens if the principal author leaves the project? React survived because Facebook had institutional ownership. Inferno did not die but it effectively stalled. Ripple in 2026 is in the Inferno-risk zone: architecturally excellent, principally maintained by one person. For a framework that becomes a load-bearing dependency, this is a governance concern you must name explicitly.

Second, the "lessons learned" claim deserves scrutiny. Every framework author claims to have learned from their predecessors. The specific claim here is that Ripple avoids the known failure modes of React, Inferno, Lexical, and Svelte. The way to validate that at a senior level is to find the exact failure mode in each predecessor and check that Ripple's design eliminates it. For hooks leakage: yes, `track` with lazy destructuring removes dependency arrays. For virtual DOM cost: yes, the compiler generates direct DOM updates. For TypeScript fit: the `component` keyword and prop type flow are materially cleaner than React's `forwardRef` and `ComponentPropsWithoutRef`. For authoring noise: yes, native `if` / `for` / `try` replace invented directives. The claim holds in each case. That kind of specific validation is what raises your argument above "the creator is experienced."

Third, the GitHub star count (7,000+) and release count (280+) are leading indicators, not trailing ones. Stars measure hype. The more informative metric is "number of organizations with more than 5 engineers who have adopted Ripple in production." As of 2026, that number is small. For a bar-raiser interview at L6+, you are expected to distinguish between adoption metrics and usage metrics.

Platform governance implication: if you are running a frontend platform team, the adoption of a pre-1.0 framework by any product team should trigger a formal review. The review criteria: is the team using Ripple for a bounded, reversible surface, or are they coupling core product features to the pre-1.0 API? Bounded adoption (one experimental product, one team, with a documented migration plan to 1.0) is acceptable. Unbounded adoption (framework used across the platform before 1.0) is a governance failure that your platform team should catch.

Staff-level signal: the "honest caveat" at the end of this section is exactly what a trustworthy technical document looks like. It names the risk, quantifies the horizon (5-year maintenance vs. 2026-2027 launch window), and gives you the tradeoff without overselling. When you produce technical evaluations in your own work, that structure is the bar you should aim for.

---
