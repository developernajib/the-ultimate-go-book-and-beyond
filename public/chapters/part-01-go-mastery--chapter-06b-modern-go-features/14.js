export default `## Common Mistakes

The features covered in this chapter introduce new failure modes that differ from classic Go pitfalls. Most stem from misunderstanding resource ownership (pull iterators require explicit cleanup), misapplying tuning parameters (GC knobs optimized for the wrong workload), or using development data where production data is required (PGO profiles).

| Mistake | Problem | Fix |
|---------|---------|-----|
| Not calling \`stop()\` from \`iter.Pull\` | Goroutine leak | Always \`defer stop()\` after \`iter.Pull\` |
| \`yield\` called after iterator returns | Panic | Iterator framework prevents this |
| Pre-sizing maps too large | Wasted memory | Size to expected count, not max possible |
| Setting GOGC=off | No GC = OOM | Always set GOMEMLIMIT instead |
| PGO with dev/test profiles | Wrong optimizations | Only use production profiles for PGO |
| json/v2 UnmarshalJSONV2 without reading token | Infinite loop | Always consume the decoder token |
| SIMD without fallback | Breaks on older CPUs | Always check CPU features first |
| Goroutine leak in tests | Flaky tests | Use \`goleak.VerifyNone(t)\` |

### Escalation Guide for Each Mistake

For a senior engineer building the team's code-review checklist:

1. **Iterator cleanup missed.** Code-review catch. Rarely shows up in a linter because the escape is data-flow-dependent. Train reviewers to check.
2. **Map over-allocation.** Benchmark catch. If the map grows and shrinks dramatically, the allocation pattern shows in pprof. Fix with the right initial hint.
3. **GOGC=off.** Production incident catch. Almost always the wrong answer. If you are tempted, the real fix is either \`GOMEMLIMIT\` or reducing allocations.
4. **PGO with wrong profile.** Performance regression catch. Compare before and after. If the "after" is worse, the profile is wrong.
5. **json/v2 handler bugs.** Integration-test catch. Tests that do round-trips on all the types the service handles.
6. **SIMD without CPU detection.** CI catch. Run the test suite on a CPU that does not support the feature.
7. **Goroutine leak in tests.** \`goleak.VerifyNone(t)\` catches all of these at test time.

The senior-track rule: every mistake on this list has a detection mechanism. Wire them all in, or accept that the bugs will ship.

---
`;
