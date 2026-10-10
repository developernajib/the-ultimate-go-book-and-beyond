## 33.4 Full-Text Search

### Setting Up Full-Text Search

PostgreSQL full-text search converts documents to `tsvector` values at index time using `to_tsvector('english', body)`, which tokenizes, normalizes, and stems words, then stores the result in a GIN index for fast lookups. Search queries are formed as `tsquery` values with `to_tsquery` or `websearch_to_tsquery` (which parses natural-language query syntax like quoted phrases and minus-exclusions), and matched against the indexed column with the `@@` operator. Highlighting matched terms in results uses `ts_headline`, which accepts the original document text and the `tsquery` and returns a fragment with matching words wrapped in configurable markup.

```sql
-- Add tsvector column
ALTER TABLE articles ADD COLUMN search_vector tsvector;

-- Create index
CREATE INDEX idx_articles_search ON articles USING GIN(search_vector);

-- Create trigger to update search vector
CREATE OR REPLACE FUNCTION articles_search_trigger() RETURNS trigger AS $$
BEGIN
    NEW.search_vector :=
        setweight(to_tsvector('english', COALESCE(NEW.title, '')), 'A') ||
        setweight(to_tsvector('english', COALESCE(NEW.body, '')), 'B');
    RETURN NEW;
END
$$ LANGUAGE plpgsql;

CREATE TRIGGER tsvector_update BEFORE INSERT OR UPDATE
ON articles FOR EACH ROW EXECUTE FUNCTION articles_search_trigger();
```

> **Senior track**: On PostgreSQL 12+, prefer a generated column over a trigger. It is declarative, cannot drift out of sync, and is rewritten automatically on ALTER:
>
> ```sql
> ALTER TABLE articles ADD COLUMN search_vector tsvector
>   GENERATED ALWAYS AS (
>     setweight(to_tsvector('english', coalesce(title, '')), 'A') ||
>     setweight(to_tsvector('english', coalesce(body,  '')), 'B')
>   ) STORED;
> CREATE INDEX idx_articles_search ON articles USING GIN (search_vector);
> ```
>
> Pick the query-construction function that matches the input: `plainto_tsquery` for raw user words (ANDs terms), `phraseto_tsquery` for exact-phrase matching, `websearch_to_tsquery` for Google-style syntax (quoted phrases, `-exclusion`, `OR`), and `to_tsquery` when you need operator control (e.g. `:*` prefix matches). Never concatenate user input into `to_tsquery`, it will throw on punctuation. Normalize through `websearch_to_tsquery` instead.

### Searching with Go

With the search index in place, querying from Go is straightforward. The `plainto_tsquery` function converts a plain-text search string into a `tsquery` automatically, handling stemming and stop-word removal. The `ts_rank` function scores each matching row by how well the document matches the query, and `ts_headline` generates a snippet with the matching terms highlighted. For prefix matching (autocomplete-style search), you can construct a `tsquery` manually with `:*` suffixes on each term.

```go
package main

import (
    "context"
    "strings"

    "github.com/jackc/pgx/v5/pgxpool"
)

type SearchResult struct {
    ID       int64
    Title    string
    Body     string
    Rank     float64
    Headline string
}

func searchArticles(ctx context.Context, pool *pgxpool.Pool, query string) ([]SearchResult, error) {
    sql := `
        SELECT
            id,
            title,
            body,
            ts_rank(search_vector, plainto_tsquery('english', $1)) as rank,
            ts_headline('english', body, plainto_tsquery('english', $1),
                'StartSel=<mark>, StopSel=</mark>, MaxWords=50') as headline
        FROM articles
        WHERE search_vector @@ plainto_tsquery('english', $1)
        ORDER BY rank DESC
        LIMIT 20
    `

    rows, err := pool.Query(ctx, sql, query)
    if err != nil {
        return nil, err
    }
    defer rows.Close()

    var results []SearchResult
    for rows.Next() {
        var r SearchResult
        if err := rows.Scan(&r.ID, &r.Title, &r.Body, &r.Rank, &r.Headline); err != nil {
            return nil, err
        }
        results = append(results, r)
    }

    return results, rows.Err()
}

// Phrase search
func phraseSearch(ctx context.Context, pool *pgxpool.Pool, phrase string) ([]SearchResult, error) {
    sql := `
        SELECT id, title, body,
               ts_rank(search_vector, phraseto_tsquery('english', $1)) as rank,
               ts_headline('english', body, phraseto_tsquery('english', $1),
                   'StartSel=<mark>, StopSel=</mark>, MaxWords=50') as headline
        FROM articles
        WHERE search_vector @@ phraseto_tsquery('english', $1)
        ORDER BY rank DESC
        LIMIT 20
    `
    rows, err := pool.Query(ctx, sql, phrase)
    if err != nil {
        return nil, err
    }
    defer rows.Close()

    var results []SearchResult
    for rows.Next() {
        var r SearchResult
        if err := rows.Scan(&r.ID, &r.Title, &r.Body, &r.Rank, &r.Headline); err != nil {
            return nil, err
        }
        results = append(results, r)
    }
    return results, rows.Err()
}

// Advanced query with prefix matching
func advancedSearch(ctx context.Context, pool *pgxpool.Pool, query string) ([]SearchResult, error) {
    terms := strings.Fields(query)
    if len(terms) == 0 {
        return nil, nil
    }
    tsQuery := strings.Join(terms, ":* & ") + ":*"

    sql := `
        SELECT id, title, body,
               ts_rank(search_vector, to_tsquery('english', $1)) as rank,
               ts_headline('english', body, to_tsquery('english', $1),
                   'StartSel=<mark>, StopSel=</mark>, MaxWords=50') as headline
        FROM articles
        WHERE search_vector @@ to_tsquery('english', $1)
        ORDER BY rank DESC
        LIMIT 20
    `
    rows, err := pool.Query(ctx, sql, tsQuery)
    if err != nil {
        return nil, err
    }
    defer rows.Close()

    var results []SearchResult
    for rows.Next() {
        var r SearchResult
        if err := rows.Scan(&r.ID, &r.Title, &r.Body, &r.Rank, &r.Headline); err != nil {
            return nil, err
        }
        results = append(results, r)
    }
    return results, rows.Err()
}
```

### Junior → FAANG: FTS Basics That Pass a Code Review

First-month-on-the-job FTS mistakes are predictable. A junior stores raw text and runs `WHERE body ILIKE '%go%'` on a 10M row table, then escalates about query latency. The idiomatic answer always starts with a `tsvector` column built as a stored generated column, a GIN index on it, and queries that use `@@` with a `tsquery` constructor.

Prerequisite gap. You need to understand four normalization stages and three query constructors. The stages: parsing (split on word boundaries and punctuation), dictionary lookup (lowercase, accent folding), stop-word removal (remove "the", "is", "a" for the English config), and stemming (collapse "running" to "run"). The query constructors: `plainto_tsquery` AND-joins all terms (safe for raw user input but limited), `websearch_to_tsquery` parses Google-style syntax including quoted phrases and `-exclusion` (the right default for user-facing search in 2026), and `to_tsquery` requires operator-correct syntax and will throw on punctuation (never pass raw user input to this, only internal code paths). `phraseto_tsquery` is a specialist for exact phrase queries.

Worked example of the generated-column pattern. The junior version uses a trigger. The senior version uses a generated column:

```sql
ALTER TABLE articles ADD COLUMN search_vector tsvector
  GENERATED ALWAYS AS (
    setweight(to_tsvector('english', coalesce(title, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(body,  '')), 'B')
  ) STORED;
CREATE INDEX idx_articles_search ON articles USING GIN (search_vector);
```

The generated column cannot drift out of sync the way a trigger can if someone drops or alters the trigger by mistake. `setweight` lets `ts_rank` weight title matches higher than body matches. A-D weights map to 1.0, 0.4, 0.2, 0.1 by default, overridable via the `weights` parameter on `ts_rank`.

Interview entry-point questions. What does `to_tsvector` do internally. Why is the language config load-bearing. Why is `search_vector @@ to_tsquery('english', user_input)` dangerous and what is the safe alternative. Why is the `tsvector` a stored generated column rather than computed at query time. Why is a GIN index on `tsvector` faster than a `trigram` index on raw text. Know these cold.

Traps. First, forgetting to wrap `title` and `body` in `coalesce` so a NULL value nulls the entire `tsvector` (fatal, drops the row from search). Second, passing the wrong language config for multilingual content. Third, trying to use `ts_rank` in a WHERE clause or as a filter (it is not indexable and requires a full scan). The correct pattern is filter with `@@` first, then rank in the projection, and always `LIMIT` the result set.

### Senior @ FAANG: FTS Ceiling, Hybrid Retrieval, and the Search Tier Migration Question

The FTS-in-Postgres strategy has clear ceilings and clear alternatives in 2026. Your staff-level job is to know where the ceiling is and what lies past it.

Scaling ceiling for Postgres FTS. On a well-tuned Postgres 17 primary with a GIN index on `tsvector`, keyword queries stay under 100ms p99 up to roughly 10 to 50 million documents depending on average document size and query selectivity. The main failure modes as you scale: (1) GIN `fastupdate = on` pending list accumulates and forces in-query merges, causing query latency variance, fixable with `fastupdate = off` for read-heavy indexes plus scheduled `gin_clean_pending_list` or frequent autovacuum, (2) lexeme cardinality blowup on diverse corpora (millions of distinct tokens) degrades index locality and inflates size, (3) `ts_rank` is not indexable and with a large match set the ranking dominates query cost, (4) phrase queries with `<->` distance operators scan the full match set rather than using the index efficiently.

Language config governance. `regconfig` is a per-query parameter. The sin is hardcoding `'english'` across a corpus that contains multiple languages. The senior pattern is a `language` column on each document, populated by a language-detection service (fastText or a heuristic), then `to_tsvector(language::regconfig, body)` in the generated column. Unknown languages fall back to `'simple'` which is plain tokenization without stemming. At FAANG scale you own a `text_search_configuration` for each supported language with shared custom dictionaries (synonym maps, thesaurus files) loaded at database start. Changes to dictionaries require a reindex, so the deployment process for dictionary changes is part of your runbook.

pg_trgm for fuzzy matching. `tsvector` does not tolerate typos. `pg_trgm` indexes character trigrams and supports `%` (similarity), `<%` (word similarity), and `<<%` (strict word similarity) operators. The hybrid pattern: use `tsvector` GIN for recall on correctly-spelled queries, plus `pg_trgm` GIN on the same columns for typo tolerance. Fuse with a UNION and a combined rank. The gotcha is that `pg_trgm` GIN indexes are large (roughly 2x the text they index) and have high write cost. Use them where typo tolerance matters (user names, product titles) and not broadly.

ParadeDB and pg_search. ParadeDB ships `pg_search` which embeds Tantivy (Rust Lucene) inside Postgres as an extension. It gives you BM25 scoring, fuzzy matching, faceted search, and language-aware tokenization via Lucene tokenizers, all inside Postgres with SQL-visible indexes. This is the 2026 answer to "we outgrew Postgres FTS but do not want to run Elasticsearch." The tradeoff is extension availability (ParadeDB is not available on AWS RDS as of 2026, only on self-managed or ParadeDB Cloud). For managed Postgres users this is a real migration cost. Benchmarks put `pg_search` at rough parity with Elasticsearch for most keyword workloads on corpora up to roughly 100M documents, with meaningfully lower operational cost because there is no separate system.

Zombodb. Older approach. Indexes Postgres tables into Elasticsearch via a Postgres extension, queries flow through Postgres but execute in Elasticsearch. Still maintained but mostly superseded by `pg_search` in 2026 for new deployments. The remaining niche is organizations with existing Elasticsearch investment who want SQL-facing queries.

When to leave Postgres FTS entirely. Clear triggers. (1) Corpus size above roughly 100M documents with sustained sub-second latency SLOs. (2) Need for learned sparse retrieval (SPLADE) or dense retrieval with cross-encoder reranking. (3) Faceted search with dozens of aggregations per query. (4) Multi-region active-active search with cross-region query federation. (5) Real-time personalization requiring per-user learned ranking. Below these thresholds, leaving Postgres is premature optimization that you will pay for in operational surface area.

MeiliSearch, Typesense, Elasticsearch at 100M+ docs. Typesense is the lowest-friction alternative for typeahead and small-to-medium corpus search (under 50M docs) with excellent tooling and a managed cloud option. MeiliSearch is similar, strong on typo tolerance, weak on faceting at scale. Elasticsearch/OpenSearch remain the default at large scale because of their query language, aggregation engine, and horizontal sharding, at the cost of being a separate cluster with separate capacity, replication, and backup concerns. A useful rule: if the answer is "we need faceted search with live filters across 20 dimensions at 100M docs," Elasticsearch wins. If the answer is "we need keyword search with decent ranking on 30M docs," Postgres FTS or `pg_search` wins.

Hybrid retrieval with pgvector for RAG. Modern retrieval-augmented generation pipelines do not use keyword OR semantic search, they do both and fuse. The pattern inside a single Postgres: `tsvector` with GIN for keyword recall, `pgvector` with HNSW index for semantic recall, fuse with reciprocal rank fusion (RRF) in SQL. Example structure:

```sql
WITH keyword AS (
    SELECT id, ts_rank_cd(search_vector, websearch_to_tsquery('english', $1)) AS score,
           row_number() OVER (ORDER BY ts_rank_cd(search_vector, websearch_to_tsquery('english', $1)) DESC) AS rank
    FROM docs
    WHERE search_vector @@ websearch_to_tsquery('english', $1)
    LIMIT 100
), semantic AS (
    SELECT id, 1 - (embedding <=> $2) AS score,
           row_number() OVER (ORDER BY embedding <=> $2) AS rank
    FROM docs
    ORDER BY embedding <=> $2
    LIMIT 100
)
SELECT d.id, d.title,
       coalesce(1.0/(60 + k.rank), 0) + coalesce(1.0/(60 + s.rank), 0) AS rrf_score
FROM docs d
LEFT JOIN keyword k ON k.id = d.id
LEFT JOIN semantic s ON s.id = d.id
WHERE k.id IS NOT NULL OR s.id IS NOT NULL
ORDER BY rrf_score DESC
LIMIT 20;
```

This pattern is the 2026 default for RAG retrieval under a billion documents. `pgvector` 0.8+ HNSW indexes support iterative scan with filter predicates, which historically was a weak point versus specialized vector databases. Pinecone, Weaviate, and Qdrant still lead for billion-scale vector workloads with complex multi-tenant isolation, but for most RAG workloads pgvector is the right answer.

JSONB over-indexing for FTS. A common anti-pattern is storing document text inside a JSONB column and trying to FTS against it. Technically possible via `to_tsvector('english', data->>'body')` and an expression index, but you lose `setweight` multi-field ranking, pay detoast cost on every access, and generally regret it. The senior pattern is to keep searchable text in typed columns and JSONB for non-searchable metadata.

Staff ADR for FTS. Required answers: (1) expected corpus size in 1 year and 3 years, (2) query latency SLO (p50 and p99), (3) language set and config governance plan, (4) typo tolerance requirement and whether `pg_trgm` is sufficient, (5) fuzzy/semantic requirement and whether pgvector is sufficient, (6) the measurable trigger that would force migration to `pg_search`, Elasticsearch, or a dedicated vector DB, (7) who owns the reindex runbook. Without these seven answers the ADR is not complete.

---
