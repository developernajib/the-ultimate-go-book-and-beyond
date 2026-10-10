## Key Points

1. **Always stream large files** - Never load more than you need into memory
2. **Use atomic writes** - Write to temp, sync, then rename to prevent corruption
3. **Buffer your I/O** - Use bufio for significant performance gains
4. **Check scanner errors** - Buffer overflow silently stops scanning
5. **Validate archive paths** - Prevent path traversal attacks when extracting
6. **Close files in loops** - Use helper functions to avoid leaking file handles
7. **Debounce file watches** - Multiple events fire for single changes

### Junior to FAANG: Each point as a prerequisite, a worked example, and an interview hook

Takeaway 1, stream large files. Prerequisite: understand that `io.Reader` is the universal abstraction and every Go I/O type implements it. Worked example: the 40 GB apache log analyzer. The junior loads it to memory and OOMs. The first-job engineer streams with `bufio.Scanner`, sizes the buffer, and checks `scanner.Err`. The FAANG answer adds a resumable checkpoint and bounded concurrency. Interview hook: "I would stream rather than load, and I would size the buffer against a declared input SLA."

Takeaway 2, atomic writes. Prerequisite: the POSIX `rename` semantics and the difference between atomic-at-VFS and durable-across-power-loss. Worked example: the config-reload feature. The junior's version is `os.Create` plus `Write` plus `Close`, and crashes mid-write leave a corrupt config. The FAANG version is temp file plus `Write` plus `Sync` plus `Close` plus `Rename` plus parent-directory `Sync`. Interview hook: "I would use temp file plus rename with fsync on the file and fsync on the parent directory."

Takeaway 3, buffer your I/O. Prerequisite: the syscall cost model. A raw `Read` of one byte is one syscall. A `bufio.Reader` with a 4 KB default amortizes 4096 calls into one syscall. Worked example: parsing a 100 MB config by byte. Without buffering, 100 million syscalls. With buffering, 25 thousand. Interview hook: "I would wrap in bufio unless the source is already buffered or the reads are large enough to make buffering a net copy cost."

Takeaway 4, check scanner errors. Prerequisite: `bufio.Scanner`'s `MaxScanTokenSize` default of 64 KB and the silent-truncation behavior when a token exceeds it. Worked example: the customer who uploads a 2 MB cell, and 50,000 subsequent rows silently vanish. Interview hook: "I would size the buffer and always check scanner.Err, returning bufio.ErrTooLong distinctly."

Takeaway 5, validate archive paths. Prerequisite: the path-traversal attack model and `filepath.Clean` behavior on absolute, relative, and `..`-prefixed inputs. Worked example: the zip with a member named `../../../etc/passwd`. Interview hook: "I would resolve the destination to absolute, validate that every extracted path has the destination as a prefix with separator, and reject symlinks."

Takeaway 6, close files in loops. Prerequisite: `defer` semantics, which run at function return, not at loop iteration end. Worked example: the batch job that opens 10,000 files in a loop with `defer f.Close()` and hits `EMFILE`. Interview hook: "I would extract per-file work into a helper so defer is scoped to the iteration."

Takeaway 7, debounce file watches. Prerequisite: how editors save (rename-on-save produces `Rename` plus `Create` plus `Write` plus `Chmod` events in rapid succession) and the inotify inode model. Worked example: the config reloader that fires three times on each save and reloads the same config three times, sometimes mid-write. Interview hook: "I would debounce per path with a small window, and I would re-watch on Rename events because inotify is inode-based."

The "why did this fail?" reflex, takeaway edition. When a file-processing bug hits production, map it to one of the seven takeaways before fixing. "OOM on the parser" maps to takeaway 1. "Corrupt file after crash" maps to takeaway 2. "Slow I/O" maps to takeaway 3. "Missing records" maps to takeaway 4. "Path escape" maps to takeaway 5. "File descriptor exhaustion" maps to takeaway 6. "Reload fires three times" maps to takeaway 7. The mapping is the skill. The fix follows mechanically.

### Senior @ FAANG: These points as platform contracts, SLOs, and the forcing function for maturity

Staff plus engineers do not recite takeaways, they turn them into enforced platform contracts. Below is the translation matrix.

Takeaway 1 as contract: the platform library exposes only streaming reads above a threshold, rejects `ReadFile` calls against files over 10 MB, and emits a metric on every read path. SLO: zero OOM incidents per quarter attributable to unbounded reads. Enforcement: lint rule plus runtime guard in the platform library.

Takeaway 2 as contract: the `AtomicWriter` primitive is the sole approved write path for commit-contract writes, direct `os.Rename` on commit paths is banned by lint. SLO: zero lost-write incidents per quarter given correct client usage. Maturity target: level 5, platform service enforced at the network boundary.

Takeaway 3 as contract: the storage client wraps all reads in sized buffers, clients do not choose buffer sizes, the platform tunes them against workload. SLO: p99 read throughput within 20 percent of hardware ceiling for sequential workloads.

Takeaway 4 as contract: the ingest pipeline rejects unbounded scanner configurations, all parsers declare a max-record size, violations are observed as metrics and alarmed. SLO: record-level parse success rate above 99.9 percent on conformant input, with silent-truncation treated as a sev-2 bug by definition.

Takeaway 5 as contract: archive extraction is centralized in a sandboxed service, direct use of `archive/zip` and `archive/tar` in application code is banned by lint. SLO: zero successful zip-bomb, path-traversal, or symlink-escape incidents per quarter. Maturity target: level 5, service isolated in its own failure domain.

Takeaway 6 as contract: the platform's file client owns lifecycle, callers pass paths and receive results, the platform handles open and close correctly. At lower levels, a linter flags `defer f.Close()` inside a loop as an error. SLO: zero file-descriptor-exhaustion incidents per quarter in services that use the platform client.

Takeaway 7 as contract: the `ChangeFeed` service abstracts over fsnotify, polling, and managed CDC, clients subscribe to changes without knowing the transport. SLO: p95 change-detection latency under 1 second for local filesystems, under 5 seconds for networked. Maturity target: level 4 platform service with a clear path to managed CDC at level 5.

Governance ADR: treating takeaways as enforceable invariants.

```
# ADR-NNN: File Processing Invariants as Platform Contracts

## Context
- Historical incident rate of 6 file-processing incidents per quarter
  across 40 services, each rooted in a violation of one of seven takeaways
  documented in the internal Go book.
- Review process catches an estimated 40 percent of violations.

## Decision
Codify the seven takeaways as platform contracts. Build primitives that
make the correct path the easy path. Enforce via lint rules, runtime
guards, and service boundaries.

## Rollout Playbook
- Quarter 1: library primitives shipped for takeaways 1, 2, 3, 6.
- Quarter 2: service boundaries for takeaways 4, 5, 7.
- Quarter 3: lint rules in warn mode, migration PRs opened.
- Quarter 4: lint rules in error mode, decommission legacy patterns.

## Success Criteria
- File-processing incident rate drops to under 1 per quarter.
- Onboarding time for new engineer reduced by 50 percent because the
  correct path is now the only path.
- Zero-instance streak on each takeaway class for at least one quarter
  before graduating that takeaway to "solved" status.

## Consequences
- Platform team headcount grows by 2 to own the primitives.
- Application teams lose direct access to some Go standard library APIs.
- Rollback: feature flags per primitive, each primitive can be disabled
  independently.
```

Maturity ladder for each takeaway. Takeaway 1, 2, 6 are typical level 4 to 5 candidates because the blast radius of a failure is high. Takeaway 3 is typically level 3 (library) because the cost of getting it wrong is performance, not correctness. Takeaways 4 and 5 are level 4 to 5 because adversarial input is involved. Takeaway 7 ranges from level 3 to 5 depending on whether the org has a CDC platform. The staff engineer's annual plan is a level-movement plan for each takeaway, with documented success criteria.

Incident retrospective template aligned to takeaways. When an incident hits, the postmortem asks: which takeaway was violated, what was its maturity level at the time, what level would have prevented the incident, and what is the plan to climb to that level. The action item is always a ladder-climb, never a one-off fix. This is how an org turns "hard-won experience" into "cannot happen again."

Oncall rotation structured around takeaways. The runbook is organized by takeaway. Every oncall page is triaged into one of seven buckets. The page-to-bucket mapping itself is a metric: a bucket with growing page volume signals a maturity gap that demands investment. The staff engineer reviews the distribution quarterly and reallocates platform team effort accordingly.

Deprecation path for homegrown tooling, per takeaway. Takeaway 1 tools (custom streamers) deprecate into the platform's read client. Takeaway 2 tools (hand-rolled atomic writers) deprecate into `AtomicWriter`. Takeaway 4 tools (bespoke parsers) deprecate into the schema registry plus ingest service. Takeaway 5 tools (homegrown extractors) deprecate into the sandboxed extractor service. Takeaway 7 tools (custom watchers) deprecate into the `ChangeFeed` service or a managed CDC. The 2026 migration pattern consistently trades in-house correctness risk for vendor lock-in risk, and the senior decision is whether that trade is right for the org.

Team onboarding, takeaway-indexed. A new engineer learns the seven takeaways as a mental index on week one, reviews a recent incident for each on week two, reads the corresponding ADR on week three, and writes a platform-library PR on week four. An engineer who cannot name all seven and cite a real incident for each at end of week four is not ready for oncall. This is the rubric that translates a reading list into operational capability.
