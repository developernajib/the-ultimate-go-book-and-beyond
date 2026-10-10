// internal/config/config.go
package config

import (
	"time"
)

type Config struct {
	Server      ServerConfig
	Index       IndexConfig
	Storage     StorageConfig
	Sharding    ShardingConfig
	Replication ReplicationConfig
}

type ServerConfig struct {
	HTTPAddr     string        `yaml:"http_addr"`
	GRPCAddr     string        `yaml:"grpc_addr"`
	ReadTimeout  time.Duration `yaml:"read_timeout"`
	WriteTimeout time.Duration `yaml:"write_timeout"`
}

type IndexConfig struct {
	// Index settings
	DefaultAnalyzer string `yaml:"default_analyzer"`
	MaxSegmentSize  int64  `yaml:"max_segment_size"` // 100MB
	MergePolicy     string `yaml:"merge_policy"`     // "tiered"
	MergeFactor     int    `yaml:"merge_factor"`     // 10
	MaxCachedDocs   int    `yaml:"max_cached_docs"`  // 10000

	// Commit settings
	CommitInterval  time.Duration `yaml:"commit_interval"`  // 30s
	MaxBufferedDocs int           `yaml:"max_buffered_docs"` // 1000

	// Search settings
	DefaultPageSize int    `yaml:"default_page_size"` // 10
	MaxPageSize     int    `yaml:"max_page_size"`     // 1000
	DefaultOperator string `yaml:"default_operator"`  // "OR"
}

type StorageConfig struct {
	DataDir     string `yaml:"data_dir"`
	UseMmap     bool   `yaml:"use_mmap"`
	Compression string `yaml:"compression"` // "snappy", "zstd", "none"
	CacheSize   int64  `yaml:"cache_size"`  // bytes
}

type ShardingConfig struct {
	NumShards         int    `yaml:"num_shards"`
	ReplicationFactor int    `yaml:"replication_factor"`
	ShardingKey       string `yaml:"sharding_key"` // "hash", "range"
}

type ReplicationConfig struct {
	Enabled      bool          `yaml:"enabled"`
	SyncInterval time.Duration `yaml:"sync_interval"`
	MaxRetries   int           `yaml:"max_retries"`
}
