## Future and Uncertainty

This section is the honest assessment of where Carbon might go and how confident anyone can be about that. The right disposition toward Carbon today is calibrated uncertainty: take the project seriously, do not overcommit, watch for specific signals that resolve the uncertainty in either direction.

### Google's Track Record on Languages

Google has launched several programming languages and platforms with varying outcomes. The honest pattern:

- **Go (2009)**: succeeded. Now used widely inside and outside Google. Backed by a small focused team with sustained corporate support. Filled a real niche (statically typed, simple, fast-compiling) that no other language was occupying.
- **Dart (2011)**: survived through a long search for a niche, eventually finding one through Flutter as a UI language. The original positioning (a JavaScript replacement in browsers) failed, the eventual positioning (mobile and desktop UI through Flutter) is real.
- **AngularDart, GWT, NaCl, PNaCl, Caja**: various Google language and platform projects that did not survive. Some failed because the underlying bet was wrong, some failed because Google de-prioritized them, some failed because the world moved in a different direction.

The lesson is that Google can ship languages successfully, but it is not automatic. The track record is mixed. Carbon's success is plausible but not assured.

### What Could Make Carbon Succeed

The plausible success path:

1. The toolchain reaches a level of maturity where small teams inside Google start using it for real internal services. This is the "first real customer" inflection point.
2. The interop story delivers, demonstrably, at scale. A Google team migrates a non-trivial subsystem from C++ to Carbon and reports the results honestly.
3. The safety story starts to land. A safe subset specification is published and used by at least one team.
4. External adopters appear, validating that the language is not Google-specific.
5. The language reaches 1.0 with a stability commitment.
6. Tooling matures (language server, debugger, package manager).

If most of these happen on a reasonable timeline (late 2020s through early 2030s), Carbon becomes a real option for the codebases that match its target profile.

### What Could Make Carbon Fail

The plausible failure paths:

1. **Google de-prioritizes it**. Google's internal pressure to migrate to Rust and the broader Google focus on AI infrastructure could reduce the engineering investment in Carbon.
2. **The safety story does not arrive**. If five years of evolutionary safety work produces no usable safe subset, Carbon ends up being a slightly cleaner C++ with no safety upside, which is not enough to justify migration.
3. **Rust interop tooling improves enough** that the original problem (painful Rust to C++ interop) becomes manageable, removing Carbon's reason for existing.
4. **C++ itself improves enough** that the gap Carbon is filling closes. C++26 with profiles, contracts, and reflection could be much closer to what Carbon offers.
5. **No one outside Google adopts it**. A language that is only used inside one company is hard to sustain even with corporate backing.
6. **The community process gets stuck**. Carbon is community-governed, and community-governed language projects can deadlock on contentious decisions.

Each of these is plausible. The combined probability of at least one of them firing is meaningful.

### Realistic Expected Outcomes

Three scenarios with rough mental probabilities:

- **Scenario A: Carbon succeeds at its stated goals**, becomes the migration path for a meaningful slice of large C++ codebases over the late 2020s and 2030s. Plausible but not the most likely single scenario.
- **Scenario B: Carbon delivers partial value**, becomes a useful language for a smaller niche than originally targeted, ships to some Google internal teams, has limited external adoption. Probably the most likely single scenario.
- **Scenario C: Carbon fails to deliver**, gets de-prioritized or ossifies in alpha for so long that the world moves on. Plausible.

You should not bet your codebase on scenario A. You should plan for B as the median case and C as a tail risk. That implies: track Carbon, do not migrate to it yet, do not assume it will be there when you need it, and have a parallel plan based on Rust or modern C++ that does not depend on Carbon shipping.

### What This Chapter Cannot Tell You

This chapter cannot tell you whether Carbon will succeed because no one knows. The Carbon team does not know. Chandler Carruth does not know. The most honest position from inside the project is "we are betting this works and we are putting in the engineering investment to make it work, and we accept that bets sometimes do not pay off".

The right disposition for a reader is to take the same view. Engage with Carbon as a serious design effort, learn from it, watch its progress, and resist both extremes (treating it as inevitable and treating it as a doomed Google side project).

### How to Stay Informed

A short list of useful sources:

- The carbon-lang GitHub repository and its README, which the team keeps current with the actual project state.
- Conference talks by the Carbon team, primarily at CppCon and CppNorth.
- The carbon-lang Discord or whatever community channel the project is using when you read this.
- Periodic blog posts from the Carbon team announcing milestones.

What to ignore:

- Hot takes on social media.
- Tutorials on YouTube produced by people who have not actually run the toolchain.
- Hacker News threads, which are entertaining but not informative.

Spend ten minutes a quarter checking the real signals and you will have a more accurate view of Carbon than the loud people in the room.

### Junior at FAANG

You should hold a calibrated view: Carbon is interesting, not ready, may or may not succeed. Avoid being the person in the room who confidently declares either "Carbon is the future" or "Carbon is dead". Both confident takes are wrong.

### Senior at FAANG

You should be prepared to update your team's plans if Carbon's signals shift in either direction. The most valuable thing a staff engineer does about emerging technology is set the conditions under which the team's strategy changes, rather than picking a strategy and defending it past the point where the evidence supports it.

---
