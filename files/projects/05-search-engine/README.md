# GoSearch - Full-Text Search Engine

A production-grade full-text search engine built from scratch in Go. Implements a pipeline from raw text to ranked search results: Unicode-aware tokenization → stop-word filtering → inverted index with posting lists → BM25/TF-IDF ranking → LRU query cache → HTTP API.

No Elasticsearch, no Lucene - pure Go with zero external storage dependencies.

---

## Prerequisites

| Tool | Version |
|------|---------|
| Go | 1.27+   |
| make | any     |
| Docker + Docker Compose | 20.10+ (optional) |

---

## Architecture Overview

```
cmd/server/          HTTP server entrypoint (-addr flag)
internal/
  config/            Config structs (server, index, storage, sharding)
  analyzer/          Text analysis pipeline
    tokenizer/       Unicode tokenizer, splits on whitespace and punctuation
    filter/          Lowercase, stop-word removal, stemming filters
  index/
    inverted/        In-memory inverted index (field → term → posting list)
    posting/         Sorted posting lists with term frequency
  query/
    parser/          Query language parser: AND, OR, NOT, phrase, field-scoped
    executor/        Executes AST against index, merges posting lists
  ranking/
    bm25.go          BM25 Okapi scorer (k1=1.2, b=0.75)
    tfidf.go         Classic TF-IDF scorer
  storage/
    docstore/        Document store (field map, per-doc metadata)
  util/
    cache/           LRU cache for query results
  api/rest/          HTTP handlers: /search, /index, /health
benchmarks/          Indexing and search throughput benchmarks
tests/               Integration tests (index → search → verify)
```

---

## Step-by-Step Build Guide

### Step 1 - Tokenizer and Analyzer

**What:** Convert raw text into normalized tokens that can be stored in the index.

**Files:** `internal/analyzer/tokenizer/tokenizer.go`, `internal/analyzer/filter/filter.go`, `internal/analyzer/analyzer.go`

**Pipeline:**
1. **Tokenizer** - splits on Unicode letter/digit boundaries (handles accented chars via `golang.org/x/text`)
2. **Lowercase filter** - folds everything to lowercase
3. **Stop-word filter** - removes common English words ("the", "a", "is", …)
4. **Stemmer** - reduces words to their root form ("running" → "run")

**Test it:**
```go
a := analyzer.NewEnglishAnalyzer()
tokens := a.Analyze("The quick brown foxes are running")
// → ["quick", "brown", "fox", "run"]
```

---

### Step 2 - Posting Lists

**What:** Store which documents contain each term, along with the term frequency in that document.

**Files:** `internal/index/posting/posting.go`

**What it does:**
- `PostingList` holds a sorted `[]Posting{DocID uint32, Freq uint32}` slice
- `Add(docID, freq)` inserts in sorted order (enables merge without re-sorting)
- `Merge` intersects two lists (AND) or unions them (OR) using a two-pointer sweep - O(n+m)
- `Difference` computes NOT by walking both lists in order

---

### Step 3 - Inverted Index

**What:** Map every (field, term) pair to its posting list. This is the core data structure that makes full-text search fast.

**Files:** `internal/index/inverted/inverted.go`

**What it does:**
- `InvertedIndex` is a nested map: `field → term → *PostingList`
- `IndexDocument(doc)` runs the analyzer over each field and upserts posting entries
- `Lookup(field, term)` returns the posting list in O(1)
- `DocCount()` and `AvgFieldLength(field)` power the BM25 scorer
- Concurrent-safe via `sync.RWMutex` - reads never block each other

**Test it:**
```bash
go test ./internal/index/...
```

---

### Step 4 - Query Parser

**What:** Turn a query string like `"golang AND (web OR api) NOT deprecated"` into an AST.

**Files:** `internal/query/parser/parser.go`, `internal/query/parser/ast.go`

**AST node types:**
- `TermNode` - single term (optionally field-scoped: `title:golang`)
- `PhraseNode` - exact phrase: `"quick brown fox"`
- `BooleanNode` - AND / OR / NOT combining child nodes

**Test it:**
```go
p := parser.NewParser("_all", "OR")
ast, _ := p.Parse(`title:"go programming" AND tags:concurrency`)
```

---

### Step 5 - Query Executor

**What:** Walk the AST, look up posting lists, and merge them according to boolean logic.

**Files:** `internal/query/executor/executor.go`

**What it does:**
- `Execute(ast, limit)` recursively evaluates the tree
- AND: intersect posting lists (smallest-first to minimize work)
- OR: union posting lists
- NOT: difference against a universe set
- Returns `ResultSet{Results []ScoredDoc, TotalHits int, MaxScore float64}`

---

### Step 6 - BM25 and TF-IDF Ranking

**What:** Score each matching document so the most relevant result ranks first.

**Files:** `internal/ranking/bm25.go`, `internal/ranking/tfidf.go`

**BM25 formula** (Okapi BM25):
```
score(D, Q) = Σ IDF(qi) · (tf(qi,D) · (k1+1)) / (tf(qi,D) + k1·(1 - b + b·|D|/avgdl))
```
- `k1 = 1.2` - term frequency saturation
- `b = 0.75` - length normalization
- `IDF` - log((N - df + 0.5) / (df + 0.5) + 1)

**Test it:**
```bash
go test ./internal/ranking/...
```

---

### Step 7 - Document Store

**What:** Persist raw document fields so search results can return actual content, not just IDs.

**Files:** `internal/storage/docstore/docstore.go`

**What it does:**
- `DocStore` holds `map[uint32]Document` in memory
- `Store(doc)` assigns an auto-incremented `DocID` and saves the field map
- `Get(docID)` retrieves the original fields for result rendering
- Optional: serialize to disk with `encoding/gob` or `klauspost/compress` for persistence across restarts

---

### Step 8 - HTTP API

**What:** Expose index and search over HTTP so any client can use the engine.

**Files:** `internal/api/rest/server.go`

**Endpoints:**

| Method | Path      | Description                              |
|--------|-----------|------------------------------------------|
| `POST` | `/index`  | Index one or more documents              |
| `GET`  | `/search` | Search with `?q=query&limit=10`          |
| `POST` | `/search` | Search with JSON body                    |
| `GET`  | `/health` | Returns `200 OK` when server is ready    |

**Run it:**
```bash
go run ./cmd/server -addr :8080
curl "http://localhost:8080/search?q=golang+concurrency&limit=5"
```

---

### Step 9 - LRU Query Cache

**What:** Cache recent search results to avoid re-executing identical queries against the index.

**Files:** `internal/util/cache/cache.go`

**What it does:**
- Fixed-capacity LRU evicts the least-recently-used query when full
- Cache key is the normalized query string + limit + offset
- Hit rate tracked via counters exposed on `/metrics`
- Thread-safe via `sync.Mutex`

**Test it:**
```bash
go test ./internal/util/cache/...
```

---

## Running the Server

```bash
# Build and start
make build
make run

# Run in dev mode (auto-reload not included; use air)
make run-dev

# Run all tests
make test

# Run benchmarks (indexing + search throughput)
make bench
```

### Index some documents

```bash
curl -X POST http://localhost:8080/index \
  -H "Content-Type: application/json" \
  -d '{
    "documents": [
      {"fields": {"title": "Go Concurrency Patterns", "body": "Goroutines channels select pipelines fan-out"}},
      {"fields": {"title": "Building Microservices in Go", "body": "gRPC REST API gateway service mesh"}},
      {"fields": {"title": "Go Performance Optimization", "body": "profiling benchmarking pprof escape analysis"}}
    ]
  }'
```

### Search

```bash
# Simple search
curl "http://localhost:8080/search?q=goroutine+channel&limit=5"

# Boolean search with POST
curl -X POST http://localhost:8080/search \
  -H "Content-Type: application/json" \
  -d '{"query": "go AND (concurrency OR performance)", "limit": 10}'
```

### Example Response

```json
{
  "results": [
    {"doc_id": 1, "score": 3.142, "fields": {"title": "Go Concurrency Patterns", "body": "..."}},
    {"doc_id": 3, "score": 1.871, "fields": {"title": "Go Performance Optimization", "body": "..."}}
  ],
  "total_hits": 2,
  "max_score": 3.142,
  "query_time_us": 84
}
```

---

## Environment Variables

Copy `.env.example` to `.env`:

```bash
cp .env.example .env
```

| Variable              | Default      | Description                            |
|-----------------------|--------------|----------------------------------------|
| `SERVER_ADDR`         | `:8080`      | HTTP listen address                    |
| `INDEX_DATA_DIR`      | `./data`     | Directory for on-disk index segments   |
| `INDEX_MAX_CACHE`     | `10000`      | Max cached query results (LRU)         |
| `INDEX_ANALYZER`      | `english`    | Default text analyzer                  |
| `LOG_LEVEL`           | `info`       | debug / info / warn / error            |
| `SHARD_COUNT`         | `1`          | Number of index shards                 |
| `REPLICATION_FACTOR`  | `1`          | Replication factor per shard           |

---

## API Reference

### `POST /index`

```json
{
  "documents": [
    { "id": 1, "fields": { "title": "...", "body": "..." } }
  ]
}
```

Response:
```json
{ "indexed": 3, "errors": [] }
```

### `GET /search?q=...&limit=10`

| Parameter | Type   | Description                    |
|-----------|--------|--------------------------------|
| `q`       | string | Query string (required)        |
| `limit`   | int    | Max results (default 10)       |
| `offset`  | int    | Pagination offset (default 0)  |

### `POST /search`

```json
{ "query": "golang AND concurrency", "limit": 10, "offset": 0 }
```

### `GET /health`

Returns `200 OK` with body `OK`.
