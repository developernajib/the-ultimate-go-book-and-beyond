## Summary

| Topic | Key Algorithm/Tool |
|-------|-------------------|
| Inverted index | Term → posting list (docID, freq, positions) |
| BM25 | IDF × TF-norm, k1=1.5, b=0.75 defaults |
| TF-IDF | log(TF+1) × log(N/df), length-normalized |
| Query parsing | Recursive descent, AND/OR/NOT/phrase/field |
| Autocomplete | Trie (prefix) + Levenshtein (fuzzy) + popularity |
| Highlighting | Best fragment selection + term marking |
| Elasticsearch | `multi_match`, `bool`, `term`, `range`, aggregations |
| NDCG@K | DCG@K / IDCG@K, graded relevance |
| MRR | 1/rank of first relevant result |
| AP | Area under precision-recall curve |

---
