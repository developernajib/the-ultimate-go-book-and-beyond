## 1. Project Foundation

Before writing any search logic, you need a well-organized project layout and a solid configuration system. This section establishes the directory structure, lists every external dependency the engine relies on, and defines the configuration types that control runtime behavior. Getting this foundation right early means each subsequent module slots cleanly into place without circular imports or tangled package boundaries.

### 1.1 Project Structure

The project structure establishes the layered package organization (handlers, services, repositories, domain) that enforces separation of concerns and prevents business logic from leaking into HTTP handler code. This architecture makes it straightforward to add new features without touching cross-cutting infrastructure.

```
gosearch/
├── cmd/
│   ├── server/              # Search server
│   ├── indexer/             # Bulk indexing tool
│   └── admin/               # Admin CLI
├── internal/
│   ├── analyzer/            # Text analysis
│   │   ├── tokenizer/       # Tokenization
│   │   ├── filter/          # Token filters
│   │   └── normalizer/      # Text normalization
│   ├── index/               # Indexing engine
│   │   ├── inverted/        # Inverted index
│   │   ├── forward/         # Forward index
│   │   └── posting/         # Posting lists
│   ├── query/               # Query processing
│   │   ├── parser/          # Query parser
│   │   ├── executor/        # Query executor
│   │   └── optimizer/       # Query optimizer
│   ├── ranking/             # Ranking algorithms
│   │   ├── tfidf/           # TF-IDF
│   │   ├── bm25/            # BM25
│   │   └── scorer/          # Custom scoring
│   ├── storage/             # Document storage
│   │   ├── docstore/        # Document store
│   │   ├── compression/     # Compression
│   │   └── segment/         # Segment management
│   ├── shard/               # Sharding logic
│   │   ├── coordinator/     # Query coordination
│   │   ├── replication/     # Replication
│   │   └── balancer/        # Load balancing
│   ├── api/                 # API handlers
│   │   ├── rest/            # REST API
│   │   ├── grpc/            # gRPC API
│   │   └── admin/           # Admin API
│   └── util/                # Utilities
│       ├── bitmap/          # Bitmaps
│       ├── skiplist/        # Skip lists
│       └── mmap/            # Memory mapping
├── pkg/
│   └── client/              # Go client library
├── api/
│   └── proto/               # Protocol buffers
├── configs/                 # Configuration files
├── scripts/                 # Build/deployment scripts
└── benchmarks/              # Performance benchmarks
```

### 1.2 Core Dependencies

The `go.mod` file pins the project's minimal dependency set: a chi router for the HTTP API, a Snowball stemmer for text analysis, and Snappy for document compression.

```
// go.mod
module github.com/yourorg/gosearch

go 1.27

require (
    github.com/blevesearch/segment v0.9.1      // Unicode segmentation
    google.golang.org/protobuf v1.36.0
    github.com/google/btree v1.1.2             // B-tree for in-memory index
    github.com/klauspost/compress v1.17.0      // Compression
    github.com/nats-io/nats.go v1.31.0         // Message queue
    github.com/peterbourgon/ff/v3 v3.4.0       // Configuration
    github.com/prometheus/client_golang v1.17.0 // Metrics
    github.com/redis/go-redis/v9 v9.3.0        // Caching
    github.com/roaringbitmap/roaring v1.6.0    // Compressed bitmaps
    github.com/stretchr/testify v1.8.4
    go.uber.org/zap v1.26.0                    // Logging
    golang.org/x/sync v0.5.0
    golang.org/x/text v0.14.0                  // Unicode normalization
    google.golang.org/grpc v1.59.0
    google.golang.org/protobuf v1.31.0
)
```

### 1.3 Configuration

The following configuration defines the deployment parameters for 1.3 Configuration, including resource allocation, environment-specific overrides, and dependency bindings. These settings are the primary operational knobs for tuning behavior between staging and production.

```go
// internal/config/config.go
package config

import (
    "time"
)

type Config struct {
    Server     ServerConfig
    Index      IndexConfig
    Storage    StorageConfig
    Sharding   ShardingConfig
    Replication ReplicationConfig
}

type ServerConfig struct {
    HTTPAddr    string        `yaml:"http_addr"`
    GRPCAddr    string        `yaml:"grpc_addr"`
    ReadTimeout time.Duration `yaml:"read_timeout"`
    WriteTimeout time.Duration `yaml:"write_timeout"`
}

type IndexConfig struct {
    // Index settings
    DefaultAnalyzer   string  `yaml:"default_analyzer"`
    MaxSegmentSize    int64   `yaml:"max_segment_size"`    // 100MB
    MergePolicy       string  `yaml:"merge_policy"`        // "tiered"
    MergeFactor       int     `yaml:"merge_factor"`        // 10
    MaxCachedDocs     int     `yaml:"max_cached_docs"`     // 10000

    // Commit settings
    CommitInterval    time.Duration `yaml:"commit_interval"` // 30s
    MaxBufferedDocs   int     `yaml:"max_buffered_docs"`   // 1000

    // Search settings
    DefaultPageSize   int     `yaml:"default_page_size"`   // 10
    MaxPageSize       int     `yaml:"max_page_size"`       // 1000
    DefaultOperator   string  `yaml:"default_operator"`    // "OR"
}

type StorageConfig struct {
    DataDir         string `yaml:"data_dir"`
    UseMmap         bool   `yaml:"use_mmap"`
    Compression     string `yaml:"compression"` // "snappy", "zstd", "none"
    CacheSize       int64  `yaml:"cache_size"`  // bytes
}

type ShardingConfig struct {
    NumShards       int    `yaml:"num_shards"`
    ReplicationFactor int  `yaml:"replication_factor"`
    ShardingKey     string `yaml:"sharding_key"` // "hash", "range"
}

type ReplicationConfig struct {
    Enabled         bool          `yaml:"enabled"`
    SyncInterval    time.Duration `yaml:"sync_interval"`
    MaxRetries      int           `yaml:"max_retries"`
}
```

### Junior → FAANG: Project Structure as a Cognitive Map

A well-organized project structure reduces the mental overhead of navigating an unfamiliar codebase. The layered package organization (handlers → services → repositories → domain) creates a clear dependency direction: higher layers depend on lower layers, never the reverse. This unidirectional dependency graph prevents import cycles and makes it obvious where to add new code.

For a search engine specifically, package boundaries should reflect the major conceptual boundaries: `analysis/` for text processing, `index/` for the inverted index, `query/` for query parsing and execution, `storage/` for document persistence, `api/` for HTTP/gRPC interfaces. This organization makes it possible for a new contributor to understand the system by reading the package names.

The configuration system (environment-variable-driven config with default values) is the foundation for deployment flexibility. Hardcoded values that belong in configuration are the most common source of "works on my laptop, fails in production" bugs.

### Senior @ FAANG: Project Foundation as a Team Productivity Investment

At senior level, the project foundation is an investment in team productivity. The package boundaries you establish now will shape how new engineers contribute and where new features are added. Poorly defined boundaries lead to packages that accumulate unrelated code (the "utils" package problem) and circular imports that block refactoring.

Dependency graph analysis (visualizing which packages import which) is a useful diagnostic for large projects. In Go, `go list -f '{{.ImportPath}} -> {{.Imports}}' ./...` produces the dependency graph. A cyclic dependency (A imports B, B imports A) is a compile error. A near-cyclic dependency (A imports B imports C imports A, broken by an interface) is an architectural smell worth addressing before it grows.

Module versioning for internal packages (using Go workspace mode or replace directives) enables teams to work on shared packages without coupling their release cycles. If the `analysis/` package is owned by one team and the `index/` package by another, workspace mode allows each team to develop independently while sharing a common module graph.

---
