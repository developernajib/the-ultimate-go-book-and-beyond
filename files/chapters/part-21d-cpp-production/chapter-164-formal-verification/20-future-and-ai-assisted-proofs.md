## The Future and AI-Assisted Proofs

The state of formal verification in 2026 is shaped by two converging forces: large language models capable of meaningful proof tactics, and proof assistants whose tooling is finally good enough for non-specialist engineers. These two forces, together, lower the cost of verification more than any single advance in the previous two decades.

This is not a prediction of universal verification. It is a description of where the floor and ceiling are moving, and what that means for senior C++ engineers.

### What LLMs do well in proofs

Empirically, by 2026, models like Claude, GPT-4o, and Gemini handle several specific proof tasks competently:

1. **Tactic suggestion** in interactive proof states. Given the current goal in Coq or Lean 4, suggest the next tactic. Hit rate on textbook proofs is high, hit rate on novel research mathematics is lower but improving.
2. **SMT-style reasoning hand-off**. Given a Hoare triple in plain language, propose an SMT-LIB encoding the user can verify.
3. **Invariant suggestion**. Given a loop and a postcondition, propose a loop invariant. This is the bottleneck in deductive verification, and ML-assisted invariant synthesis is making real progress.
4. **Spec drafting**. Given a function and a description, draft a formal pre/post-condition. Often wrong in subtle ways, but good as a starting point.
5. **Proof reconstruction from informal arguments**. Given a math-style proof in prose, formalize it. Mixed results, but useful as a scaffold.

What LLMs do *not* do well:

1. **Determine what to prove**. Specs encode intent, models have no privileged access to intent.
2. **Detect proof gaps that the kernel does not catch**. If the proof type-checks, an LLM cannot tell you the spec was wrong.
3. **Manage long-lived projects**. Refactoring a 50000-line proof base is still beyond models in 2026.
4. **Domain-specific reasoning** outside well-represented training data. Bespoke industry specs are sparsely represented.

### Lean Copilot

Lean Copilot (Yang et al., open-sourced 2024) integrates LLMs into Lean 4 tactic mode. The architecture:

```
user    --writes goal--> Lean 4
Lean 4  --queries-->     LLM (local or remote)
LLM     --proposes-->    candidate tactics
Lean 4  --verifies-->    accepts proof or rejects
```

The kernel verifies. The LLM suggests. The trust boundary remains the kernel. This is the right architectural pattern for AI-assisted proofs: the model is a productivity tool, the kernel is the guarantee.

Adoption inside mathlib4 development is now common. Hard proofs still require human ingenuity, routine proofs are increasingly handed off.

### GitHub Copilot and Claude for verification

By 2026 the IDE assistant landscape includes models tuned or prompted for verification work. Concrete uses:

- **ACSL annotation generation**. Given a C function, propose `requires`, `ensures`, `assigns`, and loop invariants. Reviewed by a human, refined, run through Frama-C/WP.
- **CBMC harness scaffolding**. Given a function signature, generate a harness with bounded inputs and reasonable assertions.
- **TLA+ skeleton generation**. Given a description of a protocol, draft an initial TLA+ spec the engineer refines.
- **Counterexample interpretation**. Given a CBMC counterexample trace, explain in prose what went wrong.

The productivity gain on each individual task is moderate (2x to 5x). The compounding effect across an entire verification project is substantial: tasks that were tedious become fast, and engineer time concentrates on the genuine intellectual work (spec design, proof architecture, hard lemmas).

### DeepMind's AlphaProof and AlphaProofz

AlphaProof (DeepMind, 2024) reached IMO silver medal performance by combining Lean 4 with reinforcement learning on synthetic proof data. The successor, AlphaProofz (DeepMind, late 2025), reportedly handles undergraduate-level mathematics across topology, analysis, and algebra at performance comparable to capable graduate students.

The relevance to engineering verification is indirect: the techniques (RL on proof search, self-play with verified outputs, neuro-symbolic integration) port naturally to engineering verification. By 2027 or 2028, expect proof-search tooling derived from this lineage to ship in commercial verification products.

### What stays human

Even with strong AI assistance, four tasks remain reliably human in 2026:

#### 1. Specification authoring

A model can draft a spec from a description, but the description came from somewhere, and the spec encodes intent. Customers, regulators, and senior engineers determine what "correct" means. A model writing a spec without supervision is a model writing a spec for a hypothetical product, not yours.

#### 2. Architectural decomposition

How to break a large verification project into modules, layers, and refinement steps. This is the seL4 design call: refinement chain from abstract to concrete, each level has its own invariants, composition matters. Models help fill in details inside the architecture, they do not yet design the architecture.

#### 3. Trust boundary design

Where does the verified region end and the unverified region begin? Where does the spec become hardware assumption? What does the customer audit? These are engineering and organizational decisions humans make.

#### 4. Spec maintenance over years

As the system evolves, the spec must evolve. Maintaining the spec, deciding when an evolution is a refactor versus a behavioral change, deprecating obsolete invariants. This is the work that keeps a verification project alive past the original engineer's tenure.

### Proof assistants becoming developer tools

A pattern visible by 2026: proof assistants are becoming first-class developer environments, not academic curiosities.

- **Lean 4 IDE**: VS Code extension with go-to-definition, hover, error squiggles, inline goal display. Comparable to Rust Analyzer.
- **Coq Platform / VsCoq2**: similar progress for Coq.
- **Isabelle/jEdit**: usable for daily proof work, weaker than Lean/Coq IDE.
- **Frama-C GUI**: the WP plugin's interactive proof workflow has improved markedly.
- **Why3 IDE**: similar trajectory.

A senior C++ engineer can become productive in Lean 4 in roughly 3 months part-time. This was not true in 2018 with Coq. The tooling barrier to entry has dropped substantially.

### Programmatic specification generation

A specific 2026 trend: tools that generate formal specs from informal artifacts.

- **Behavior-driven test specs to TLA+**: Given a Cucumber/Gherkin spec, propose a TLA+ skeleton.
- **API documentation to Frama-C ACSL**: Given Doxygen comments and types, draft ACSL.
- **Protocol RFCs to TLA+**: Given an RFC, scaffold a TLA+ spec.
- **Code to property-based test generators**: Given a function, propose a RapidCheck/Hypothesis property.

None of these eliminate the human review step. All of them reduce the friction of starting a verification effort.

### What the next five years probably bring

Cautious predictions for 2026 to 2031:

1. **Verified Rust becomes routine** for new safety-critical systems work. Verus, Prusti, Aeneas mature into industrial tools. C++ stays where it has ecosystem dominance.
2. **TLA+ adoption spreads** further into distributed systems engineering. By 2030, a senior backend engineer at a major cloud provider is expected to read TLA+ even if they do not write it primarily.
3. **C++26 contracts ship** in all major compilers, with verification tools (CBMC, Frama-C) consuming them. C++ catches up to where C was with ACSL a decade ago.
4. **Verified crypto becomes default**. New crypto code in production is HACL\* / fiat-crypto / equivalents, not handwritten.
5. **AI-assisted invariant synthesis** crosses the practical-utility threshold for routine deductive verification. Lean Copilot-style tooling becomes standard in proof workflows.
6. **End-to-end verified compilers for restricted C++** appear at academic prototype level, not production.
7. **CHERI-based hardware** ships in selected commercial silicon (Morello-derived), starting with defense and high-assurance niches.

What probably does *not* happen by 2031:

- A fully verified C++ compiler covering C++26.
- Universal formal verification of mainstream commercial software.
- LLMs that handle novel research-grade verification autonomously.
- Replacement of testing by verification at scale.

### The senior engineer's positioning

Three decisions worth making explicitly:

1. **Personal fluency**. Pick one of TLA+, Lean 4, or Frama-C/ACSL and become fluent over the next year. The opportunities to deploy formal methods in C++ careers are increasing, and the cost of acquiring fluency is dropping.
2. **Team capability**. Identify which components in your codebase would benefit from verification, and build the lightest viable assurance argument first (fuzzing, property tests, sound static analysis). Escalate selectively.
3. **Architectural design**. When designing new systems, consider where the verified subset should live. Crypto, parsers, kernels, and hot algorithmic cores are obvious candidates. Make the architectural call early, retrofitting verification into a complete system is harder than designing for it.

### The closing observation

Formal verification is no longer the exotic discipline it was in 2010. Tooling has matured, AI assistance is real, and adoption in regulated industries is moving from edge cases to expected practice. The C++ engineer who treats verification as alien is increasingly out of step. The C++ engineer who treats it as one tool among several, with a clear understanding of cost and benefit, is positioned for the work the next decade will demand.

> **Senior at FAANG.** The next time you propose a major project, include a verification cost line and a verification-alternative-considered note in the design doc. Even if the answer is "we will not verify, here is why", the discipline of having considered it forces the right architectural decisions and signals to leadership that the team thinks about assurance seriously. That signal compounds over time.
