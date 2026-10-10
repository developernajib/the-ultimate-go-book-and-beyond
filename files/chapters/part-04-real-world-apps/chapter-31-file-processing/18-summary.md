## Summary

File processing essentials:

1. **Basics**: Read, write, file info with proper error handling
2. **Large Files**: Streaming and chunked processing to avoid memory issues
3. **Formats**: CSV, JSON, binary with proper encoding handling
4. **Compression**: gzip, zip archives with security considerations
5. **Directories**: Walking, copying, cleaning with efficient patterns
6. **Temp Files**: Atomic writes to prevent corruption
7. **Watching**: Monitor file changes with debouncing

### Junior to FAANG: Translating the summary into a first-job toolkit

The seven-item summary above is accurate and also insufficient for the FAANG bar. Each item expands into a first-job toolkit you should internalize before shipping production file-processing code.

Item 1, basics. At FAANG, "proper error handling" means error classification into transient (retry) versus permanent (surface), context propagation so cancellation reaches I/O, and structured error wrapping with `fmt.Errorf("%w", err)` so root causes are preserved across layers. If your error returns are `return err` with no context, you are at L3 and need to grow to L4 before your first on-call.

Item 2, large files. The FAANG interpretation is "bounded memory with observable progress." Streaming is table stakes. The next layer is resumability (durable checkpoint, `fsync`, idempotent record processing) and backpressure (the reader must not outrun the consumer). A large-file tool that cannot resume from a checkpoint is a toy.

Item 3, formats. The FAANG interpretation is "schema-driven, versioned, and decoupled from transport." CSV with implicit column order is a bilateral contract that breaks. JSON without a schema is a parse bomb waiting. Binary without versioning cannot evolve. The first-job instinct is to use a schema (Avro, protobuf, JSON Schema) and validate at the boundary.

Item 4, compression. The FAANG interpretation is "untrusted input flows through a sandboxed extractor with declared limits." Ratio caps, size caps, path-traversal checks, symlink rejection, and per-tenant quota are all table stakes. Writing your own tar extractor in application code is a 2015 pattern and a 2026 security incident.

Item 5, directories. The FAANG interpretation is "walking a tree is a potential DoS and a potential symlink-loop trap." `filepath.WalkDir` in Go 1.27 is the right primitive, but every walk needs a max-depth cap, a max-entry cap, and a loop detector. Network-mounted trees add a latency dimension that local code never hits.

Item 6, temp files. The FAANG interpretation is "atomic at the VFS layer is not durable across a power cycle." Atomic write means temp file plus `fsync` plus rename plus parent-directory `fsync`, always, everywhere, no exceptions, and on Windows it means handling `ERROR_ACCESS_DENIED` on rename-over.

Item 7, watching. The FAANG interpretation is "inotify is inode-based and breaks on rename-on-save, does not recurse, and has a per-user watch limit that is a production killer on trees with more than a few thousand entries." The first-job pattern is fsnotify for small trees plus a polling fallback for large ones plus a re-watch handler on rename-on-save.

Worked example, first-job triage. You are asked to review a PR that adds a feature to dump debug state to a file every minute. The naive PR calls `os.Create`, `json.NewEncoder(f).Encode(state)`, `f.Close`. The FAANG review comment walks the summary. (1) No atomic write, so a crash mid-encode leaves a corrupt debug dump. (2) No `fsync`, so the dump may not survive a power loss. (3) No rotation, so the file grows unbounded or overwrites a useful history. (4) No schema version, so consumers of the dump break when the struct evolves. (5) No size cap, so a misbehaving component can fill the disk. Each comment maps to an item on the summary. Writing this review is the L4 signal.

The "why did this fail?" reflex as a summary-driven checklist. Given any file-processing bug, read the seven-item summary as a diagnostic. If the bug is "data corruption," jump to item 6 (atomic writes). If the bug is "OOM," jump to item 2 (streaming). If the bug is "security alert," jump to item 4 (compression) or item 3 (format validation). If the bug is "cannot detect change," jump to item 7 (watching). The summary is the mental index. Senior engineers use it as muscle memory.

### Senior @ FAANG: Governance models, maturity ladders, and the summary as a contract

At staff plus, the summary is not a list of things you did in the chapter, it is the contract your platform exposes to internal tenants. Below is how I translate a seven-item summary into a governance artifact.

Platform contract, one sentence per item. (1) Basics: the platform exposes a `FileClient` interface, and direct use of `os` file APIs is prohibited outside the platform library. (2) Large files: every read path is bounded in memory, every write path is back-pressure aware, every long-running job checkpoints. (3) Formats: every ingest endpoint validates against a registered schema, unknown schemas are rejected with a clear error. (4) Compression: all compressed input flows through the sandboxed extractor service with per-tenant limits. (5) Directories: directory walks are issued through a `WalkService` that enforces depth, entry, and symlink-loop caps. (6) Temp files: atomic writes are issued through a single `AtomicWriter` that does `fsync` plus rename plus parent-directory `fsync`, and direct `os.Rename` is prohibited. (7) Watching: file-change notifications are issued through a `ChangeFeed` service that abstracts over fsnotify, polling, or managed CDC.

Maturity ladder for each summary item. Level 1 (scripts): each developer writes their own implementation. Level 2 (shared helpers): a shared internal library. Level 3 (platform library): a versioned library with tests and SLAs. Level 4 (platform service): a network service with quotas and metrics. Level 5 (managed): the service is owned by a platform team with 24x7 oncall and a published SLO. Every summary item climbs this ladder independently. At a mature org, items 4 (compression) and 6 (temp files) are at level 5 because they are high-risk. Items 5 (directories) and 7 (watching) may still be at level 3 if the workload does not justify the investment.

Governance model, ADR-backed. Every item in the summary has a corresponding ADR that documents the decision, the trade-offs, and the deprecation plan. A sample for item 6:

```
# ADR-NNN: AtomicWriter Platform Primitive

## Context
- Historical incidents: 4 durability incidents in 18 months traced to
  hand-rolled temp-file patterns missing parent-directory fsync.
- Windows rename-over behavior differs from POSIX, causing cross-platform
  corruption in the config subsystem.

## Decision
Ship AtomicWriter as the sole approved write path for commit-contract writes.
Enforce via lint rule banning os.Rename in application code.

## Consequences
- All existing call sites audited and migrated within one quarter.
- Platform team owns the primitive with an SLO of "zero lost writes per
  quarter given correct client usage."
- Training session for all backend engineers on the new primitive.

## Rollout Playbook
- Week 1-2: library published, docs written, lint rule in warn mode.
- Week 3-6: migration PRs opened against every offending call site.
- Week 7: lint rule flipped to error mode.
- Week 8-12: audit, confirm zero direct os.Rename in application code.
```

Incident retrospective pattern applied to the summary. When an incident maps to any summary item, the postmortem asks "what level was this item at when the incident happened, and what level prevents the next instance?" If item 6 was at level 3 (platform library) and the incident was a call site that did not use the library, the action is to move to level 4 (platform service, enforced by network boundary) or level 5 (lint rule, enforced by CI). Each incident is evidence for moving up the ladder. The class-level action in the postmortem is always a ladder-climb, not a point fix.

SLO framing aligned to the summary. Item 2 (large files) has a throughput SLO. Item 6 (temp files) has a durability SLO. Item 7 (watching) has a change-detection-latency SLO. Item 4 (compression) has a safety SLO (zero successful zip bombs per quarter). Item 3 (formats) has a correctness SLO (parse success rate). Each SLO has an SLI, a burn-rate alert, a runbook, and a quarterly review. The summary is the skeleton of the SLO taxonomy.

Deprecation path from the summary. Every item in the summary has a homegrown instance that ships on day one and a managed replacement that arrives later. The deprecation playbook is the same for each: shadow-mode, dual-write, gradual cutover, decommission. The 2026 canonical replacements are: item 3 formats managed by a schema registry (Confluent, Apicurio, or in-house), item 4 compression managed by a sandboxed extractor service, item 7 watching managed by CDC (Debezium or cloud-native equivalents). Items 1, 2, 5, and 6 remain platform-library concerns. The staff engineer's roadmap is a quarter-by-quarter plan for which items move from library to service to managed.

Team onboarding against the summary. A new engineer on the platform team spends week one reading the seven ADRs, week two reviewing historical incidents for each item, week three shadowing oncall for pages that touch each item, and week four writing their first PR against the platform library. The summary is the index that structures the onboarding. An engineer who cannot recite the contract for each item at end of week four is not ready for oncall.

---
