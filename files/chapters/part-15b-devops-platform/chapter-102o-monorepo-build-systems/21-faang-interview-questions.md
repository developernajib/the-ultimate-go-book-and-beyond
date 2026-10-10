## 102O.19 FAANG Interview Questions: Monorepo & Build Systems

### Q1 (Google, L6): Bazel vs go build for a 5M-LOC Go monorepo.

Bazel wins on remote caching, remote execution, and hermetic builds once the repo crosses the point where `go build ./...` stops fitting in developer memory. Go's native tooling wins on simplicity for small repos. Google ships Go with Bazel internally for a reason: cache hit rates above 90 percent on incremental builds.

### Q2 (Amazon, L5): Affected-change detection in a monorepo CI.

Compute the dependency graph from go.mod and internal package imports, diff against merge-base, test only affected modules. Bazel gives this for free via `bazel query`. Without Bazel, tools like `go list -deps` plus a custom differ work. The failure mode is flaky global tests pinning CI time.

### Q3 (Meta, E6): How do you handle code generation in a monorepo?

Check in generated code. Verify in CI that regeneration produces no diff. This preserves IDE navigation, avoids build-step coupling, and makes code review honest. The alternative, generating at build time, hides intent and breaks bisect. Bazel `genrule` with checked-in outputs plus a `verify_generated` target is the mainstream pattern.

### Q4 (Netflix, Senior): Release engineering for microservices in a monorepo.

Independent semantic versioning per service, driven by Conventional Commits filtered by path. Release on merge via a release-please style bot. Tag format `service-name/vX.Y.Z`. Avoid repo-wide version numbers. They force lockstep releases and defeat the monorepo purpose.

### Q5 (Apple, ICT5): Dependency and license compliance across thousands of modules.

Renovate for automated updates, FOSSA or a self-hosted license scanner gating merges, an SBOM generated per release artifact (SPDX or CycloneDX). Quarantine new dependencies in an allowlist reviewed by security. Track time-to-patch as a first-class SLO. Known-CVE exposure is the number executives ask about after an incident.

### Junior → FAANG: How to Approach FAANG-Level Questions Before You Are There

These questions are calibrated for L5 and above, but preparing for them as a junior engineer is one of the highest-value study activities available. The reason: FAANG questions at L5 are often questions that a strong L4 candidate should also be able to answer, and the gap between "can answer this" and "cannot answer this" is usually a matter of deliberate study, not years of experience.

For Q1 (Bazel vs go build): you do not need to have operated a 5M-LOC monorepo to give a strong answer. You need to understand why hermetic builds and remote caching matter at scale, and why the simpler tooling breaks down at a specific threshold. Practice articulating the threshold and the breakdown.

For Q2 (affected-change detection): implement a simple version yourself. The core of the algorithm is `git diff --name-only main...HEAD | map to service paths | traverse import graph`. Writing even a 100-line version that works for a toy monorepo makes the concept concrete in a way that reading about it does not.

For Q5 (dependency compliance): look up what SBOM means, read the May 2021 US executive order on cybersecurity, and understand what SPDX and CycloneDX are. These are topics that appear in FAANG interviews because they are real compliance requirements that engineering organizations deal with. Knowing the terminology shows awareness of the broader engineering context.

### Senior @ FAANG: What Each Question Tests at the Bar-Raiser Level

Each of these five questions has a different primary dimension at bar-raiser rounds. Q1 tests architectural judgment: can you reason about when complexity is justified? The wrong answer confidently advocates for Bazel at all scales, ignoring the onboarding cost for small teams. Q2 tests systems thinking: can you identify the correctness risks (false negatives) alongside the algorithmic design? Q3 tests operational maturity: do you understand that "check in generated code" is a governance decision with operational implications, not just a technical preference?

Q4 tests release engineering depth. The phrase "avoid repo-wide version numbers" is a signal to probe: "why?" The answer involves the lockstep release problem: if every service must increment version together, teams lose deployment independence, which is one of the core values of a monorepo for independently deploying services. The candidate who knows this and can explain the tag format `service-name/vX.Y.Z` and the conventional commit filtering by path is showing L6-level release engineering knowledge.

Q5 tests security governance maturity. "Track time-to-patch as a first-class SLO" is the key phrase. Candidates who describe the tooling (Renovate, FOSSA) but not the SLO and the accountability mechanism (which team is responsible for merging updates within the SLO window, and what happens when they miss it) are showing L5 thinking. The L6 answer includes the organizational accountability structure, not just the tooling.

### Junior → FAANG: Preparing for These Five Questions

These five questions are real examples of what L5/L6 infrastructure and platform interviews ask at FAANG companies. The pattern across all five: the answer is never just a tool name, it is a tool name plus the reasoning for choosing it, plus the operational tradeoff it introduces. "Bazel" is not an answer. "Bazel because it provides content-addressed remote caching that achieves 90% cache hit rates on incremental builds, at the cost of a steep learning curve and platform team maintenance overhead that becomes worthwhile at 200+ engineers" is an answer.

For preparation: pick two of these five questions and practice answering them out loud for 3 minutes each, without notes. Time yourself. If you run out of things to say before 2 minutes, you do not know the material well enough yet. Read the relevant section of this chapter and try again. The ability to speak fluently about monorepo build systems for 2-3 minutes without prompting is the standard at L5 FAANG infrastructure interviews.

### Senior @ FAANG: What Bar-Raisers Listen For

Bar-raiser interviewers at L6 are not checking whether you know what Bazel is. They are checking whether you can reason about the organizational and operational implications of technical choices. For Q1 (Bazel vs go build): a bar-raiser wants to hear you discuss the adoption strategy, not just the technical comparison. "Bazel wins on caching, but the migration requires a platform team and a staged rollout. The decision is not purely technical." For Q3 (code generation): a bar-raiser wants to hear about the governance model. "Checked-in generated code works because the round-trip verify in CI acts as a correctness guarantee. The alternative, generating at build time, provides no such guarantee and breaks IDE tooling." For Q5 (license compliance): a bar-raiser wants to hear about the exception process and the SLO. "The scanner gates merges, but you need a structured exception workflow for cases where a license-restricted dependency cannot be replaced quickly. Without the exception workflow, the scanner becomes a bottleneck that teams work around."

The pattern: every technical answer has an organizational dimension. Bar-raisers are evaluating whether you will make good decisions at the scale where technical choices have organizational consequences. Demonstrating that you think in both dimensions simultaneously is the signal that earns an L6 hire.

