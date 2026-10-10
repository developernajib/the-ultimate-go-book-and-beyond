## 37F.2 Index Mapping Design

### Production Mapping with Go

Before defining index mappings, you need a properly configured Elasticsearch client. The `go-elasticsearch` client supports connection pooling, retry with exponential backoff, TLS, and structured logging, all configured through a single `Config` struct. The client wrapper below sets sensible production defaults and verifies connectivity at startup.

```go
// go.mod
// require github.com/elastic/go-elasticsearch/v9 v9.0.0

package elasticsearch

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/elastic/go-elasticsearch/v9"
	"github.com/elastic/go-elasticsearch/v9/esapi"
)

// Config holds Elasticsearch connection configuration
type Config struct {
	Addresses      []string
	Username       string
	Password       string
	APIKey         string
	CloudID        string // Elastic Cloud
	MaxRetries     int
	RetryBackoff   func(int) time.Duration
	EnableMetrics  bool
	CACert         []byte
}

// NewClient creates a production-grade ES client
func NewClient(cfg Config, log *slog.Logger) (*elasticsearch.Client, error) {
	esCfg := elasticsearch.Config{
		Addresses:    cfg.Addresses,
		Username:     cfg.Username,
		Password:     cfg.Password,
		APIKey:       cfg.APIKey,
		CloudID:      cfg.CloudID,
		MaxRetries:   cfg.MaxRetries,
		RetryBackoff: cfg.RetryBackoff,
		// Transport with observability
		Transport: &http.Transport{
			MaxIdleConnsPerHost:   10,
			ResponseHeaderTimeout: 10 * time.Second,
			IdleConnTimeout:       60 * time.Second,
		},
		Logger: &esLogger{log: log},
	}

	if cfg.CACert != nil {
		esCfg.CACert = cfg.CACert
	}

	if cfg.RetryBackoff == nil {
		esCfg.RetryBackoff = func(i int) time.Duration {
			d := time.Duration(1<<uint(i)) * 100 * time.Millisecond
			if d > 5*time.Second {
				return 5 * time.Second
			}
			return d
		}
	}

	client, err := elasticsearch.NewClient(esCfg)
	if err != nil {
		return nil, fmt.Errorf("elasticsearch client: %w", err)
	}

	// Verify connectivity
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if _, err := client.Ping(client.Ping.WithContext(ctx)); err != nil {
		return nil, fmt.Errorf("elasticsearch ping: %w", err)
	}

	log.Info("elasticsearch connected", "addresses", cfg.Addresses)
	return client, nil
}

// esLogger wraps slog for ES request/response logging
type esLogger struct {
	log *slog.Logger
}

func (l *esLogger) LogRoundTrip(req *http.Request, res *http.Response, err error, start time.Time, dur time.Duration) error {
	if err != nil {
		l.log.Error("elasticsearch request failed",
			"method", req.Method,
			"url", req.URL.String(),
			"err", err,
			"duration_ms", dur.Milliseconds(),
		)
	} else if dur > 200*time.Millisecond {
		l.log.Warn("slow elasticsearch request",
			"method", req.Method,
			"url", req.URL.String(),
			"status", res.StatusCode,
			"duration_ms", dur.Milliseconds(),
		)
	}
	return nil
}

func (l *esLogger) RequestBodyEnabled() bool  { return false }
func (l *esLogger) ResponseBodyEnabled() bool { return false }
```

### Index Mapping Definition

Elasticsearch mappings define field types, analyzers, and index behavior, decisions that cannot be changed without reindexing once data is present. The mapping below models a product catalog with `keyword` fields for exact filtering, `text` fields with custom analyzers for full-text search, and `dense_vector` for semantic ranking.

```go
package elasticsearch

// ProductMapping defines the Elasticsearch index mapping for products
const ProductMapping = `{
  "settings": {
    "number_of_shards": 3,
    "number_of_replicas": 1,
    "refresh_interval": "1s",
    "analysis": {
      "analyzer": {
        "product_analyzer": {
          "type": "custom",
          "tokenizer": "standard",
          "filter": [
            "lowercase",
            "asciifolding",
            "synonym_filter",
            "product_stop",
            "word_delimiter_graph"
          ]
        },
        "autocomplete_analyzer": {
          "type": "custom",
          "tokenizer": "standard",
          "filter": ["lowercase", "autocomplete_filter"]
        },
        "autocomplete_search_analyzer": {
          "type": "custom",
          "tokenizer": "standard",
          "filter": ["lowercase"]
        }
      },
      "filter": {
        "autocomplete_filter": {
          "type": "edge_ngram",
          "min_gram": 2,
          "max_gram": 20
        },
        "synonym_filter": {
          "type": "synonym",
          "synonyms": [
            "phone,mobile,smartphone",
            "laptop,notebook,computer",
            "tv,television,display"
          ]
        },
        "product_stop": {
          "type": "stop",
          "stopwords": ["the", "a", "an", "and", "or"]
        }
      }
    }
  },
  "mappings": {
    "dynamic": "strict",
    "properties": {
      "id": { "type": "keyword" },
      "name": {
        "type": "text",
        "analyzer": "product_analyzer",
        "search_analyzer": "product_analyzer",
        "fields": {
          "keyword": { "type": "keyword", "ignore_above": 256 },
          "autocomplete": {
            "type": "text",
            "analyzer": "autocomplete_analyzer",
            "search_analyzer": "autocomplete_search_analyzer"
          }
        }
      },
      "description": {
        "type": "text",
        "analyzer": "product_analyzer",
        "index_options": "offsets"
      },
      "category": {
        "type": "keyword",
        "fields": {
          "text": { "type": "text" }
        }
      },
      "brand": { "type": "keyword" },
      "price": { "type": "scaled_float", "scaling_factor": 100 },
      "discount_price": { "type": "scaled_float", "scaling_factor": 100 },
      "stock": { "type": "integer" },
      "rating": { "type": "half_float" },
      "review_count": { "type": "integer" },
      "tags": { "type": "keyword" },
      "attributes": {
        "type": "nested",
        "properties": {
          "name": { "type": "keyword" },
          "value": { "type": "keyword" }
        }
      },
      "images": { "type": "keyword", "index": false },
      "location": { "type": "geo_point" },
      "embedding": {
        "type": "dense_vector",
        "dims": 1536,
        "index": true,
        "similarity": "cosine"
      },
      "active": { "type": "boolean" },
      "created_at": { "type": "date" },
      "updated_at": { "type": "date" }
    }
  }
}`

// IndexManager handles index lifecycle
type IndexManager struct {
	client *elasticsearch.Client
	log    *slog.Logger
}

// CreateIndex creates an index with mapping (idempotent)
func (m *IndexManager) CreateIndex(ctx context.Context, name, mapping string) error {
	// Check if exists
	res, err := m.client.Indices.Exists([]string{name},
		m.client.Indices.Exists.WithContext(ctx))
	if err != nil {
		return fmt.Errorf("check index: %w", err)
	}
	defer res.Body.Close()

	if res.StatusCode == 200 {
		m.log.Debug("index already exists", "index", name)
		return nil
	}

	// Create index
	res2, err := m.client.Indices.Create(
		name,
		m.client.Indices.Create.WithBody(strings.NewReader(mapping)),
		m.client.Indices.Create.WithContext(ctx),
	)
	if err != nil {
		return fmt.Errorf("create index: %w", err)
	}
	defer res2.Body.Close()

	if res2.IsError() {
		return fmt.Errorf("create index error: %s", res2.String())
	}

	m.log.Info("index created", "index", name)
	return nil
}

// UpdateMapping adds new fields to existing index
func (m *IndexManager) UpdateMapping(ctx context.Context, index string, mapping map[string]any) error {
	body, _ := json.Marshal(map[string]any{"properties": mapping})

	res, err := m.client.Indices.PutMapping(
		[]string{index},
		bytes.NewReader(body),
		m.client.Indices.PutMapping.WithContext(ctx),
	)
	if err != nil {
		return err
	}
	defer res.Body.Close()

	if res.IsError() {
		return fmt.Errorf("put mapping: %s", res.String())
	}
	return nil
}
```

### Junior → FAANG: Mapping fundamentals, worked example, interview traps

The single rule to internalise before writing any mapping: you cannot change a field's type after the index has data. You can add new fields, and you can add multi-fields to an existing field, but you cannot flip `text` to `keyword` or widen a `scaled_float` to `double`. Every "mapping change" beyond those additive cases is a reindex. This is why a strict mapping from day one is so much cheaper than fixing it later.

Worked example of `text` versus `keyword`. Index the value `"Apple iPhone 15 Pro"` into a `text` field with the standard analyser, and it becomes the tokens `[apple, iphone, 15, pro]` stored in the inverted index. Index the same value into a `keyword` field, and the entire string is stored as one token `"Apple iPhone 15 Pro"`. A `match` query against the text field matches `"apple"` or `"pro"`. A `term` query against the keyword field matches only the exact string. Aggregations (`terms` bucketing, `cardinality`) need a `keyword` field because they group on exact values. Sorting on a text field requires fielddata which is a heap-resident structure and a production hazard. The universal fix is the multi-field pattern visible in the `name` mapping above: the main field is `text` for matching, a subfield `name.keyword` is keyword for aggregations and sort.

Interview entry-point trap: "How would you do a case-insensitive exact match?" A junior answer says `keyword` and `term`. The correct answer is `keyword` with a `normalizer` that lowercases at index time and query time, or a multi-field with both raw and lowercase variants. This is a common screening question precisely because it exposes whether the candidate understands that keyword fields are not analyzed, which is why you need a normalizer rather than an analyser to apply lowercase.

Common first-job mistakes to avoid. Using `"dynamic": true` (the default) on a public-facing index, which lets a malicious or buggy client add fields until mapping explosion crashes the cluster. Using `text` for an identifier, which tokenises UUIDs and produces surprising match behavior. Using `long` for monetary values (rounding errors on scale), when `scaled_float` with `scaling_factor: 100` is the idiomatic choice for cents. Using `nested` unnecessarily, which is expensive: every nested object becomes a hidden document, and nested queries have a different cost profile. Reach for `nested` only when you have arrays of objects and need to preserve the relationship between sibling fields inside the same array element, such as the `attributes` array of `{name, value}` above where you want to match name and value on the same element.

### Senior @ FAANG: Schema governance, analyser design, and migration discipline

At staff level, mappings are a versioned contract between producers and consumers. The production posture is `"dynamic": "strict"` on every user-facing index, with `"dynamic": "runtime"` as the escape hatch when a team genuinely needs a late-bound field. Runtime fields are defined at search time, computed via Painless or defined from source, and cost nothing at index time. They are the correct answer to "we need to surface this new field in one dashboard" and they are a trap if they leak into hot query paths because they are computed per-hit at query time. The governance pattern is a mapping repository in git with a PR template requiring mapping change type (additive, runtime, or reindex), a backfill plan, and a rollback switch.

Dynamic templates are the primary mechanism to express a family of fields without enumerating each one. A template that maps any field ending in `_id` to keyword with `doc_values: true` and `index: true`, any field ending in `_count` to long, any field ending in `_at` to date with a set of accepted formats, gives producers a stable contract without a central bottleneck. Combined with strict dynamic for everything else, the schema stays disciplined and the producer contract is enforced at index time rather than in code review.

Analyser design is the single most effective place a staff engineer spends time on a search index. The analyser chain is character filters, then tokenizer, then token filters. Character filters run first on raw text and are the right place for HTML stripping, pattern replacement, or ICU normalization of Unicode. The tokenizer decides how the string breaks into tokens: `standard` for most Latin text, `whitespace` for preserving punctuation, `keyword` for one-token-equals-the-string, `pattern` for regex-driven splits, `icu_tokenizer` for CJK and mixed-script content, and custom tokenizers such as `path_hierarchy` for category paths. Token filters run after tokenization and are where lowercase, asciifolding, stemming, synonyms, stopwords, word-delimiter-graph, shingle, and edge-ngram live. The order matters. `lowercase` before `synonym` means synonyms are case-insensitive. `asciifolding` before `stemming` means accented forms share the same stem. `word_delimiter_graph` is the correct modern token filter over the deprecated `word_delimiter` because it preserves positions for phrase matching on split tokens.

Language analysers versus custom chains. Elasticsearch ships per-language analysers (english, french, spanish, and so on) that combine a language-specific tokenizer, stopwords, and stemmer. They are a fine starting point and the wrong long-term answer. They are opaque, not easily tunable, and their stopword lists or stemmers may not match your domain. A product search on an e-commerce catalog often wants a custom chain that omits stemming (because "phones" and "phone" are marketed as distinct SKUs), preserves model numbers, and uses a curated synonym set. A blog search probably does want stemming. The discipline is to pick per-field, not per-index, and to document the rationale in the mapping repo.

Synonym governance is a surprisingly political problem. Two patterns both work and fail differently. The analyser-embedded `synonym` or `synonym_graph` filter loads synonyms from a file or inline list, and changes require an index close-open cycle or the `_reload_search_analyzers` call when combined with search-time-only synonyms. The newer synonyms API in Elasticsearch 8.10 and later (and the OpenSearch equivalent) stores synonym sets in a system index, supports atomic updates, and integrates with RBAC. For a marketplace with thousands of merchant-specific synonyms, the API approach scales. For a small controlled vocabulary, the file approach with git review is simpler. The cross-cutting discipline is that synonyms are search-time only during learning and iteration, and only promoted to index-time after a synonym set has stabilised for a release cycle, because every index-time synonym change is a reindex.

Dense vector mappings warrant their own paragraph. In Elasticsearch 9, `dense_vector` with `index: true` and `similarity: cosine` or `dot_product` defaults to HNSW with sensible `m` and `ef_construction` values. Tuning these is the same memory versus recall trade as in any HNSW system. Better Binary Quantization (BBQ) in Elastic 9 cuts memory by 32x at a small recall cost and is the correct default for any index over roughly 10 million vectors. OpenSearch 3 offers FAISS and Lucene engines with different tradeoffs: FAISS is faster and uses more memory, Lucene is more integrated and shares segment lifecycle with BM25 fields. For hybrid retrieval, the dense vector lives alongside the text fields in the same document, and retrieval fuses BM25 and kNN via RRF. The common mistake is sizing `dims` to a foundation model default (1536 for OpenAI small, 3072 for large) without considering that Matryoshka-trained embeddings can be truncated to 256 or 512 dimensions with minimal recall loss and 3x to 6x memory savings.

Reindex runbooks. The zero-downtime pattern is: (1) create `products_v2` with the new mapping and settings, (2) point writes at an alias `products_write` that currently resolves to `products_v1`, (3) start a `_reindex` from v1 to v2 with a query slice to parallelise, (4) add v2 to the write alias so writes dual-write, (5) tail-sync residual changes via `_update_by_query` using `version_type: external_gte` to avoid lost updates, (6) run a judgment-set `_rank_eval` regression comparing v1 and v2, (7) flip the read alias `products_read` atomically to v2, (8) remove v1 from the write alias, (9) retain v1 read-only for a rollback window before deletion. Every step is a discrete change with a kill switch. The most common failure is step 5: assuming the reindex caught up and cutting over before the tail-sync is complete. The correct gating is a lag metric comparing max `updated_at` between v1 and v2 that must be below a threshold for a sustained interval before the cutover proceeds.

---
