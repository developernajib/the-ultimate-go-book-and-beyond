## 37E.11 Compaction Strategies

### Choosing the Right Compaction

Compaction strategies in Cassandra control how SSTables are merged and garbage-collected, directly affecting read latency, write amplification, and disk usage. Cassandra 5.0 consolidates the old STCS/LCS/TWCS decision tree into the Unified Compaction Strategy (UCS), which is density-aware and tunable via a single scaling parameter, but the legacy strategies are still supported and still the right choice for a few specific workloads (notably TTL-heavy time-series).

```
Compaction Strategy Selection (Cassandra 5.0):
════════════════════════════════════════════════

UCS (UnifiedCompactionStrategy) - RECOMMENDED DEFAULT in 5.0
- Density-aware SSTable organization + shard-parallel compaction
- Single `scaling_parameters` knob interpolates between STCS-like (T4, T8)
  and LCS-like (L10) behavior, with no more picking a strategy per table
- Combines STCS's write efficiency with LCS's read amplification
- Safer incremental compaction (no LCS "all-or-nothing" L0→L1 stalls)
- Use for: ~90% of workloads in 5.0, including mixed read/write tables

TWCS (TimeWindowCompactionStrategy) - TIME-SERIES / TTL
- Best for: time-series, IoT, event data with a default_time_to_live
- Compacts within a time window; closed windows are never recompacted,
  so TTL'd SSTables are dropped wholesale (no tombstone scanning)
- Still superior to UCS for pure append + TTL workloads in 5.0
- Config: window_unit = HOURS/DAYS, window_size chosen so each window
  is ~20-30x smaller than the TTL

STCS (SizeTieredCompactionStrategy) - LEGACY DEFAULT
- Groups SSTables by size, compacts groups of 4+ similar-sized tables
- Still the fallback for pre-5.0 write-heavy rarely-read tables
- Cons: up to 2x temporary space amp, unpredictable read amp on hot tables

LCS (LeveledCompactionStrategy) - LEGACY READ-HEAVY
- L0→L1→L2… with 10x size multiplier per level, and ~1 SSTable touched per read
- Superseded by UCS with an L-biased scaling_parameter in 5.0
- Cons: 2-5x write amp vs STCS, with L0 backpressure under bursty writes

CQL for UCS (Cassandra 5.0):
ALTER TABLE orders_by_user WITH compaction = {
  'class': 'UnifiedCompactionStrategy',
  'scaling_parameters': 'T4',          -- T4=STCS-like, T8=middle, L10=LCS-like
  'target_sstable_size': '1GiB'
};

CQL for TWCS (time-series stays on TWCS):
ALTER TABLE sensor_readings WITH compaction = {
  'class': 'TimeWindowCompactionStrategy',
  'compaction_window_unit': 'DAYS',
  'compaction_window_size': 1,
  'max_threshold': 32,
  'min_threshold': 4
};
```

### Junior → FAANG: Compaction as a First Mental Model

If you are new to Cassandra, compaction is the single most confusing piece, and most production incidents in your first year will trace back to it. The prerequisite gap is usually LSM intuition. An LSM engine writes to a memtable, flushes it to an immutable SSTable, and then has to merge overlapping SSTables in the background so reads do not have to touch dozens of files. Compaction is that merge. The strategy you pick decides how aggressive the merge is, how much extra disk you burn during the merge, and how many SSTables a single read ends up touching.

Worked example. You are on-call at your first job and p99 reads on `orders_by_user` jumped from 6ms to 180ms overnight. Before you page a senior, walk the reflex ladder. First, `nodetool tablestats orders_by_user` and look at `SSTable count`. If it is 40+, compaction is falling behind. Second, check `nodetool compactionstats` for a pending queue. Third, check `tombstone_scanned_histogram`. If the table is STCS and write-heavy with occasional deletes, you have probably accumulated tombstones inside large SSTables that rarely get compacted, and every read is scanning them. The fix is not "restart the node." The fix is usually to switch to UCS with a read-biased scaling parameter, or to run a major compaction only after you have verified it will not starve the cluster of disk headroom.

First-job context. Interviewers at mid-tier shops love to ask "why did your read latency get worse even though your write rate is stable?" The textbook answer is read amplification from too many SSTables per partition, usually caused by a strategy mismatch (STCS on a read-heavy table) or by a compaction backlog (I/O saturated, `concurrent_compactors` too low). Memorize this ladder: SSTable count, pending compactions, tombstone ratio, bloom filter false positive rate, key cache hit rate. Five numbers, in that order, diagnose 80% of latency regressions on a wide-column store.

Entry-point interview question. "You have a table that stores user sessions with a 24-hour TTL and 200k writes per second. Which compaction strategy?" Answer: TWCS with a one-hour window. Not UCS, because UCS still has to scan tombstones. Not STCS, because expired SSTables will never age out cleanly. TWCS drops whole windows once every row inside is past `gc_grace_seconds + TTL`, which is free disk reclamation with zero read amplification. If you can say that in an interview, you are already above the median L4 candidate.

### Senior @ FAANG: Compaction Governance, Cost Models, and the UCS ADR

At staff and principal level the question is not which strategy, it is how the org chooses, reviews, and rolls back strategies at fleet scale. You are writing an ADR, not a config change.

ADR template for "Adopt UCS as the default in Cassandra 5.0."

Context. Cassandra 5.0 GA in late 2024 shipped UnifiedCompactionStrategy as production-ready, merging the operational properties of STCS, LCS, and a Twitter-style tiered hybrid into a single strategy controlled by `scaling_parameters`. Before 5.0, every new table at Netflix, Apple, and Instagram required a per-workload strategy decision reviewed by a DBA. That review is a scaling bottleneck when you add 500 tables a quarter.

Decision. Default all new tables to UCS with `scaling_parameters: T4` for write-heavy and `L8` for read-heavy, keep TWCS for any table with a `default_time_to_live`, and deprecate new LCS adoption. Existing LCS tables migrate opportunistically during major version upgrades, not in a big-bang.

Consequences. Write amplification drops 30 to 50% versus LCS on read-heavy tables. Operators lose the mental model of "levels" and need retraining on sharded compaction and density tiers. Rollback path is `ALTER TABLE ... WITH compaction = {...}` plus a forced major compaction, which is safe but expensive on 10TB+ nodes.

Maturity model for wide-column compaction operations.

L1 Reactive. Strategy is whatever the first engineer picked. Nobody tunes `gc_grace_seconds`. Compaction backlogs are discovered through user complaints.

L2 Reproducible. Strategy is recorded in schema-as-code (CQL files in git). Dashboards exist for SSTable count, pending compactions, and tombstone ratio per table.

L3 Proactive. Every new table requires a strategy justification in the PR. Tombstone alerts fire before latency degrades. Compaction is throttled per node using `compaction_throughput_mb_per_sec` tied to a live I/O budget.

L4 Optimized. A cost model predicts write amplification, space amplification, and read amplification per strategy from historical workload traces. `nodetool` metrics feed an autotuner that can propose strategy migrations. Reaper or ScyllaDB Manager owns repair scheduling and coordinates with compaction windows so the two never collide.

L5 Adaptive. UCS `scaling_parameters` are adjusted automatically based on measured read/write ratio per table, with human review on the PR. Migrations across strategies are blue-green at the table level using dual-write plus checksum reconciliation.

Compaction tuning cost model. The three amplifications are not independent. For a table with read:write ratio R and average row size S, a first-order model says write_amp_LCS approximately equals log10(dataset_size / L0_size) plus level_overhead, whereas write_amp_STCS stays near 2. Read_amp_STCS scales with the number of SSTables touched per read which degrades as sqrt(dataset_size / memtable_flush_size), whereas read_amp_LCS stays near 1. UCS interpolates. A staff engineer builds this model once, parameterises it with a weekend of `nodetool tablehistograms` dumps, and uses it to justify migrations in ADRs rather than arguing from vibes.

Governance hook. Treat compaction strategy as a first-class schema attribute. A CI lint rejects `ALTER TABLE` that downgrades from LCS/UCS to STCS on a table tagged `read_heavy`, and rejects any table with `default_time_to_live` that is not TWCS. Ship this lint once, delete a year of production incidents.

---
