## Failure Handling

At the scale of a search engine, hardware failures are not exceptional events but a daily reality. The system must continue serving results even when individual index shards, ranking services, or auxiliary components go down. The strategy is graceful degradation: each component has replicas, and when a primary fails, traffic is routed to the lowest-latency replica. Non-critical features like spell correction and autocomplete can be disabled entirely without breaking the core search experience.

```go
package failover

type ShardRouter struct {
	replicas map[int][]string
	latency  map[string]float64
}

func (r *ShardRouter) Route(shardID int) string {
	best := r.replicas[shardID][0]
	bestLat := r.latency[best]
	for _, rep := range r.replicas[shardID][1:] {
		if l := r.latency[rep]; l < bestLat {
			best = rep
			bestLat = l
		}
	}
	return best
}
// Each shard: 3 replicas. Leader fails -> follower promoted in seconds.
```

| Failure | Degradation |
|---------|-------------|
| Index shard down | Route to replica |
| Spell checker down | Disable "did you mean" |
| PageRank stale | Use last scores |
| Autocomplete down | Disable typeahead |

---
