## Capacity Estimation

Assumptions:
- 500M users, 100M daily active
- Average 100 files per user
- Average file size: 100KB (weighted by count)
- Large files: 5% are > 100MB

Storage:
- 500M × 100 × 100KB = 5 PB of files
- Metadata: 50B files × ~1KB per file = 50 TB

Bandwidth:
- 10M uploads/day × 5MB avg = 50 TB/day upload
- 50M downloads/day × 5MB avg = 250 TB/day download


### Junior → FAANG: Estimating Storage and Bandwidth for File Sync Systems

File sync systems have different capacity profiles than request-response APIs. Storage grows monotonically with users and file sizes. Bandwidth spikes on client sync events. Key numbers to reason through: average file size per user, average number of files, daily active sync rate, and average delta size per sync event (since good clients only upload diffs, not full files). A common mistake is estimating as if every sync uploads the full file. Demonstrate awareness that delta sync reduces bandwidth by an order of magnitude for typical document workloads.

### Senior @ FAANG: Capacity Planning as an Input to Storage Tiering and Cost Architecture

At the senior level, capacity estimates for file sync systems directly inform the storage tiering strategy. Hot storage (SSDs, high-availability object storage) is expensive. Cold storage (Glacier-class) is cheap but has retrieval latency. The ADR for storage tiering captures the access frequency thresholds for tier promotion and demotion, the acceptable retrieval latency for cold data, and the cost delta between tiers. Staff-level concerns include the interaction between storage tiering and compliance: data that must be retained for regulatory purposes often ends up in cold storage, but retrieval SLAs for e-discovery requests must still be met. The capacity estimate also informs the deduplication ROI calculation: if deduplication eliminates 30% of stored data, what is the storage cost saving per year at stated scale, and does that justify the implementation complexity and the performance overhead of the deduplication pipeline.
