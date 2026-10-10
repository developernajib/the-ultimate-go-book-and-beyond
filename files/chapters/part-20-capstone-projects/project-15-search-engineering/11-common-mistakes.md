## Common Mistakes

Search engines involve many moving parts, and small oversights in tokenization, scoring, or caching can silently degrade result quality without any obvious error messages. The table below lists the most frequent mistakes that beginners and even experienced engineers make when building search systems, along with the problems they cause and how to fix them.

| Mistake | Problem | Solution |
|---------|---------|----------|
| Not stemming/normalizing tokens | "running" ≠ "run" in search | Apply stemmer and lowercase normalization |
| BM25 k1/b defaults not tuned | Suboptimal ranking | Tune on your data: k1=1.2-2.0, b=0.3-0.75 |
| Ignoring field weights | Title matches = body matches | Boost title^3, tags^2, body^1 |
| No stop word filtering | "the dog" → 3× results for "the" | Remove stop words before indexing |
| Wildcard queries on full text | O(n) scan, slow | Use n-gram index for prefix/suffix queries |
| Not caching frequent queries | High CPU on hot queries | LRU cache with short TTL (1-5 minutes) |
| Relevance without evaluation | Improvements are guesses | Always measure NDCG/MRR with human labels |
| No query understanding | "iphone apple" = two terms | Entity extraction + synonym expansion |
| Ignoring click-through data | Misaligned with user intent | Use CTR as implicit relevance signal |
