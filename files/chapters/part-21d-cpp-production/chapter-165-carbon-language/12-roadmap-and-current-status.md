## Roadmap and Current Status

This section is the most time-sensitive in the chapter. By the time you read it, the specifics will have moved. Treat the structure of the roadmap as more durable than the milestone names, and verify the current state against the carbon-lang repository.

### How the Carbon Project Talks About Its Own Roadmap

The Carbon team has been deliberate about avoiding overpromising. The repository's documentation describes phases rather than dates, and the phases are defined by capability rather than by calendar. The high-level shape of the roadmap as the project itself has stated it:

1. **Design phase**: Write the design documents that specify the language. Get them reviewed, debated, and merged. Build a working prototype that demonstrates the design decisions.
2. **Toolchain milestone (0.1, 0.2, etc)**: Implement enough of the language in a real compiler that small programs can be written and run. This phase is where the project is during 2024 and 2025.
3. **Pre-1.0 alpha**: Feature-complete enough for early adopters, with explicit "do not use in production" warnings.
4. **1.0**: Stable language definition, stable interop, stable toolchain. Production-ready in the sense that the team is willing to support it for real workloads.
5. **Beyond 1.0**: Evolution toward the safety story (the phase 2 and 3 of the memory model chapter).

The honest version is that the project has been in phase 1 and 2 for years and the timeline to phase 3 is measured in years more, not months.

### What Is Currently Stable in the Design

Areas where the design documents are firm and unlikely to change in major ways:

- **High-level syntax**: declarations, function syntax, package model, import model.
- **Generics-versus-templates direction**: constraint-based, definition-site checked.
- **Class versus interface separation**: single inheritance for state, interfaces for protocols.
- **No exceptions**: settled.
- **C++ interop being first-class**: the entire premise of the project.
- **LLVM and Bazel as the toolchain foundation**: settled.

These are unlikely to flip. Specific spellings and details will keep moving, but the shape is set.

### What Is Currently in Active Design

Areas where the design is real but not finished, and where you should expect significant change:

- **The memory and ownership model in detail**: the evolutionary path is committed to in principle, but the specific safe-subset design is open.
- **Error handling syntax and library types**: the direction (result types, no exceptions) is set, the spelling and ergonomics are not.
- **Operator overloading and traits**: partial design.
- **Concurrency**: largely undecided.
- **Macros, metaprogramming, reflection**: the high-level position (less metaprogramming than C++, more disciplined than C++ templates) is set, concrete proposals are in flight.
- **C++ interop edge cases**: macros, heavy template metaprogramming, exception boundaries, ABI details on less common platforms.

If you are reading the design documents, expect these areas to look different in twelve months.

### What Is Currently Implemented in the Toolchain

Distinct from "what is designed", "what is implemented" is a smaller set. The implementation lags the design substantially. Areas where the toolchain has working code (subject to verification against the current state of carbon-lang):

- Basic parsing and lowering of small programs.
- A subset of the type system enough to typecheck simple functions and classes.
- Code generation through LLVM for simple programs.
- A starting C++ interop layer that handles a subset of C++ headers.
- The Carbon Explorer running a subset of the language in the browser.

What is not in the toolchain but is in the design includes most of generics, most of inheritance, most of interop, and almost all of the safety story.

The gap between design and toolchain is normal for a pre-1.0 project. It does become misleading if you read the design documents and assume they describe a working language. They describe an intended language.

### How to Read Project Signals

When you check in on Carbon every few months, useful signals include:

- **Design document merges**: the carbon-lang repository has a `proposals` directory where design changes are reviewed and merged. Counting accepted proposals is a rough measure of design progress.
- **Toolchain milestone announcements**: the project posts milestone summaries when significant capabilities ship. These are the most reliable signal of real progress.
- **GitHub issue and discussion activity**: live discussions about specific design decisions tell you what is actively being worked on.
- **Talks and conference presentations**: Chandler Carruth and others present at C++ conferences (CppCon, CppNorth) and updates from those talks summarize where things stand.

Less useful signals:

- **Star count on the repository**.
- **Hacker News and Reddit activity**.
- **Tweets from non-contributors**.

The first set of signals tells you about real progress. The second set tells you about social attention, which is loosely correlated and often misleading.

### Honest Assessment of Pace

Languages take a long time. Rust took roughly a decade from initial work (2006) to 1.0 (2015), and longer to mature. Swift took several years from announcement to maturity. Go took a few years, helped by being designed and shepherded by a small focused team at Google with full corporate backing.

Carbon's pace looks closer to Rust's than to Go's. The design is community-driven (which slows decisions), the team is small (which limits implementation throughput), and the goals (cheap C++ interop, evolutionary safety) are technically harder than the goals Go set for itself. A reasonable expected timeline is 2028 to 2030 for a 1.0 that is meaningful, with full safety and ecosystem maturity later still.

If you are planning around Carbon, plan for "available in late 2020s" rather than "available in 2026".

### Junior at FAANG

You should know that Carbon is pre-1.0, that the toolchain lags the design, and that production use is years away. Avoid claiming it is closer to ready than it is.

### Senior at FAANG

You should be able to track the project's real progress through design proposals and toolchain milestones, ignore social signal, and update your team's plans based on actual capability shifts. A staff engineer's job is to be the calm voice in the room when other engineers get excited about a Hacker News post about Carbon, and to be the alert voice when a real milestone lands that the Hacker News crowd has not noticed yet.

---
