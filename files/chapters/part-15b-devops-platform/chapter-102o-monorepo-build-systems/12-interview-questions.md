## 102O.10 Interview Questions

**Q: When would you choose a monorepo over a polyrepo?**

A: Monorepo excels when: (1) teams collaborate heavily on shared code, (2) you need atomic commits across multiple services, (3) you want unified tooling and consistent dependency versions. Polyrepo is better when: (1) teams are truly independent with separate release cycles, (2) different tech stacks per service, (3) compliance requires strict isolation. Most FAANG companies use monorepos for their core systems.

**Q: How do you prevent monorepo CI times from growing unboundedly?**

A: (1) Affected-change detection: only build/test services touched by a PR. (2) Remote build cache (Bazel/Gradle): cache compilation artifacts by content hash. (3) Parallel execution: matrix builds across services. (4) Module boundaries: changes to shared libraries rebuild all dependents but changes to a single service don't. (5) Test sharding: distribute test suites across workers.

**Q: How does `go.work` differ from `replace` directives?**

A: `replace` directives in `go.mod` redirect one module version to another path - they must be manually maintained and don't compose well across modules. `go.work` is a workspace-level file that declares which local modules to use for development, overriding the published versions. `go.work` doesn't need to be committed (though `go.work.sum` should be), doesn't affect published module dependencies, and works seamlessly across the workspace.

### Junior → FAANG: Delivering Strong Answers to These Three Questions

These three questions appear in some form in nearly every infrastructure or platform engineering interview at mid-level companies and FAANG. The framing that makes answers strong is leading with the tradeoff rather than the tool: not "use a monorepo when you want atomic commits" but "the key tradeoff is that monorepos require investment in build tooling to stay fast at scale, while polyrepos keep CI simple at the cost of making cross-service changes painful."

For the CI time question, the answer is strongest when you can quantify: "in a 50-service repo, affected detection can reduce CI time from O(all services) to O(critical path of affected services), which for a localized change is typically 1-3 services." Quantified answers in infrastructure interviews signal that you have thought about real systems, not just read documentation.

For the `go.work` question, the key detail most candidates miss is that `go.work` is a local development tool and `go.work.sum` is the artifact that belongs in the repository. Interviewers specifically probe whether you know which file to commit.

### Senior @ FAANG: Bar-Raiser Follow-Up Questions

A bar-raiser interviewer will follow each of these answers with a depth probe. For the monorepo-vs-polyrepo question: "your team has decided on a monorepo. 18 months later, CI is taking 30 minutes per PR. Walk me through how you diagnose and fix this." The expected answer covers: profile CI job timing to find the bottleneck, check whether affected detection is implemented and whether it is correctly scoped, check remote cache hit rates, and identify whether the critical path is compute-bound or waiting on external services.

For the affected-change question: "your affected detection is marking too many services as affected, causing unnecessary rebuilds. How do you make it more precise without introducing false negatives?" The expected answer covers building a package-level dependency graph (not just path prefixes), handling transitive dependencies correctly, and the validation strategy (shadow mode comparing old and new affected sets before promoting the more precise version).

For the `go.work` question: "you have 15 modules in your workspace. A developer adds a new external dependency to one module. Walk me through what happens to `go.work.sum` and how CI handles it." The expected answer demonstrates knowledge of how workspace-level sum verification works and why `go work sync` must be run before committing.

