## 52H.4 NATS JetStream - Key-Value Store

The NATS KV API is a distributed key-value store built on JetStream streams. Each bucket maps to a stream with subject pattern `$KV.<bucket>.>`. Internally, a `Put` is a `js.Publish`, a `Get` is a stream `GetMsg`, and `Watch` uses a push consumer on the KV stream.

```go
// file: internal/nats/kv/store.go
package kv

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"time"

	"github.com/nats-io/nats.go"
)

// Store wraps a JetStream KV bucket with typed operations.
type Store[T any] struct {
	bucket nats.KeyValue
	logger *slog.Logger
}

// BucketConfig configures a KV bucket.
type BucketConfig struct {
	Bucket      string
	TTL         time.Duration
	History     uint8  // number of historical revisions to keep
	Storage     nats.StorageType
	Replicas    int
	Description string
}

// NewStore creates or binds to a KV bucket.
func NewStore[T any](js nats.JetStreamContext, cfg BucketConfig, logger *slog.Logger) (*Store[T], error) {
	kvCfg := &nats.KeyValueConfig{
		Bucket:      cfg.Bucket,
		TTL:         cfg.TTL,
		History:     cfg.History,
		Storage:     cfg.Storage,
		Replicas:    cfg.Replicas,
		Description: cfg.Description,
	}

	bucket, err := js.CreateKeyValue(kvCfg)
	if err != nil {
		// If bucket exists, bind to it.
		bucket, err = js.KeyValue(cfg.Bucket)
		if err != nil {
			return nil, fmt.Errorf("binding to kv bucket %s: %w", cfg.Bucket, err)
		}
	}

	logger.Info("kv store ready", slog.String("bucket", cfg.Bucket))
	return &Store[T]{bucket: bucket, logger: logger}, nil
}

// Put stores a value. Overwrites any existing value for the key.
func (s *Store[T]) Put(ctx context.Context, key string, value T) (uint64, error) {
	data, err := json.Marshal(value)
	if err != nil {
		return 0, fmt.Errorf("marshaling value for key %s: %w", key, err)
	}

	rev, err := s.bucket.Put(key, data)
	if err != nil {
		return 0, fmt.Errorf("kv put %s: %w", key, err)
	}

	s.logger.Debug("kv put", slog.String("key", key), slog.Uint64("revision", rev))
	return rev, nil
}

// Get retrieves a value. Returns (zero, ErrKeyNotFound) if absent.
func (s *Store[T]) Get(ctx context.Context, key string) (T, uint64, error) {
	var zero T
	entry, err := s.bucket.Get(key)
	if err != nil {
		return zero, 0, fmt.Errorf("kv get %s: %w", key, err)
	}

	var value T
	if err := json.Unmarshal(entry.Value(), &value); err != nil {
		return zero, 0, fmt.Errorf("unmarshaling value for key %s: %w", key, err)
	}

	return value, entry.Revision(), nil
}

// Update performs a compare-and-swap update.
// Only succeeds if the current revision matches lastRevision.
func (s *Store[T]) Update(ctx context.Context, key string, value T, lastRevision uint64) (uint64, error) {
	data, err := json.Marshal(value)
	if err != nil {
		return 0, fmt.Errorf("marshaling value for update %s: %w", key, err)
	}

	rev, err := s.bucket.Update(key, data, lastRevision)
	if err != nil {
		return 0, fmt.Errorf("kv update %s (rev %d): %w", key, lastRevision, err)
	}

	s.logger.Debug("kv updated",
		slog.String("key", key),
		slog.Uint64("new_revision", rev),
	)
	return rev, nil
}

// Delete marks a key as deleted (tombstone). Use Purge to remove all history.
func (s *Store[T]) Delete(ctx context.Context, key string) error {
	if err := s.bucket.Delete(key); err != nil {
		return fmt.Errorf("kv delete %s: %w", key, err)
	}
	return nil
}

// WatchEntry is a typed wrapper around a KV entry.
type WatchEntry[T any] struct {
	Key      string
	Value    T
	Revision uint64
	Delta    uint64
	Op       nats.KeyValueOp
}

// Watch subscribes to changes on a specific key.
// Sends the current value immediately, then all subsequent updates.
func (s *Store[T]) Watch(ctx context.Context, key string) (<-chan WatchEntry[T], error) {
	watcher, err := s.bucket.Watch(key)
	if err != nil {
		return nil, fmt.Errorf("kv watch %s: %w", key, err)
	}

	ch := make(chan WatchEntry[T], 64)

	go func() {
		defer close(ch)
		defer watcher.Stop() //nolint:errcheck

		for {
			select {
			case <-ctx.Done():
				return
			case entry, ok := <-watcher.Updates():
				if !ok {
					return
				}
				if entry == nil {
					// nil signals end of initial values.
					continue
				}

				var value T
				if len(entry.Value()) > 0 {
					if err := json.Unmarshal(entry.Value(), &value); err != nil {
						s.logger.Error("kv watch unmarshal error",
							slog.String("key", entry.Key()),
							slog.String("error", err.Error()),
						)
						continue
					}
				}

				ch <- WatchEntry[T]{
					Key:      entry.Key(),
					Value:    value,
					Revision: entry.Revision(),
					Delta:    entry.Delta(),
					Op:       entry.Operation(),
				}
			}
		}
	}()

	return ch, nil
}

// WatchAll watches the entire bucket for any key change.
func (s *Store[T]) WatchAll(ctx context.Context) (<-chan WatchEntry[T], error) {
	watcher, err := s.bucket.WatchAll()
	if err != nil {
		return nil, fmt.Errorf("kv watch all: %w", err)
	}

	ch := make(chan WatchEntry[T], 256)

	go func() {
		defer close(ch)
		defer watcher.Stop() //nolint:errcheck

		for {
			select {
			case <-ctx.Done():
				return
			case entry, ok := <-watcher.Updates():
				if !ok {
					return
				}
				if entry == nil {
					continue
				}

				var value T
				if len(entry.Value()) > 0 {
					if err := json.Unmarshal(entry.Value(), &value); err != nil {
						s.logger.Error("kv watch all unmarshal error",
							slog.String("key", entry.Key()),
							slog.String("error", err.Error()),
						)
						continue
					}
				}

				ch <- WatchEntry[T]{
					Key:      entry.Key(),
					Value:    value,
					Revision: entry.Revision(),
					Delta:    entry.Delta(),
					Op:       entry.Operation(),
				}
			}
		}
	}()

	return ch, nil
}

// FeatureFlags demonstrates KV used for reactive feature flag configuration.
type FeatureFlags struct {
	EnableNewCheckout bool   `json:"enable_new_checkout"`
	MaxUploadSizeMB   int    `json:"max_upload_size_mb"`
	MaintenanceMode   bool   `json:"maintenance_mode"`
	RolloutPercent    int    `json:"rollout_percent"`
	BannerMessage     string `json:"banner_message"`
}

// ReactiveConfig watches KV and calls onChange whenever flags change.
func ReactiveConfig(
	ctx context.Context,
	store *Store[FeatureFlags],
	onChange func(FeatureFlags),
	logger *slog.Logger,
) error {
	ch, err := store.Watch(ctx, "feature-flags")
	if err != nil {
		return fmt.Errorf("watching feature flags: %w", err)
	}

	go func() {
		for entry := range ch {
			if entry.Op == nats.KeyValuePut {
				logger.Info("feature flags updated",
					slog.Uint64("revision", entry.Revision),
				)
				onChange(entry.Value)
			}
		}
	}()

	return nil
}
```

### Junior -> FAANG: When to Use NATS KV vs Other Config Systems

NATS KV is one of three common choices for distributed configuration in Go services. Understanding when each is appropriate prevents over-engineering and under-engineering.

Use NATS KV when your service already connects to a NATS cluster and needs real-time config propagation. The `ReactiveConfig` pattern above is genuinely elegant: the watcher goroutine delivers config changes within milliseconds of a `Put`, and the consumer gets typed Go structs rather than raw bytes.

Use environment variables or Kubernetes ConfigMaps when your config changes rarely (less than once per deploy cycle). The operational simplicity of not needing a watcher goroutine outweighs the convenience of hot-reload for stable config.

Use etcd or Consul when your organization already operates one of those systems and has the tooling and runbooks in place. Adding NATS KV to get config propagation when etcd already exists trades operational simplicity for a marginally nicer API.

The `Update` method in the code above uses compare-and-swap via `lastRevision`. Always prefer `Update` over `Put` when writing config that multiple processes might modify concurrently, including admin scripts and CI pipelines. Using `Put` unconditionally is a last-write-wins race condition waiting to surface in production.

### Senior @ FAANG: NATS KV as a Platform Config Primitive

The `Store[T any]` generic type in this section is a clean API design, but a platform-level KV integration needs additional considerations that go beyond the single-bucket use case shown here.

The first is schema evolution. When `FeatureFlags` gains a new field, all services must be updated to understand it. In a monorepo, this is manageable. In a polyglot service mesh, the `FeatureFlags` struct needs versioning. One approach is to version the bucket name (`feature-flags-v2`) and run parallel watches during a transition period. Another is to use a flexible envelope type with a version field and dispatch on it inside `onChange`. Document which approach your platform uses in the internal architecture guide, because individual service teams will implement both and create inconsistency without a standard.

The second concern is `WatchAll` at scale. The `WatchAll` implementation creates a push consumer on the entire bucket stream. If the bucket contains thousands of keys, the initial value delivery on watcher creation delivers all current values as a burst. For a service that only needs a subset of keys, `WatchAll` wastes bandwidth and the consumer's message buffer. Prefer `Watch(key)` or a multi-key watcher when the bucket contains more than 100 keys that are not all relevant to the watcher.

The third concern is the interaction between `History` (revision count per key) and storage costs. `History: 10` on a bucket with 100,000 keys and frequent updates can consume orders of magnitude more storage than `History: 1`. The JetStream stream underlying the bucket retains up to `MaxMsgsPerSubject` revisions per key. A platform cost review should include KV bucket storage as a first-class concern, with quotas enforced at the bucket level via the underlying stream's `MaxBytes` setting.

For feature flag systems specifically, the `ReactiveConfig` pattern should include a validator that runs before calling `onChange`. An invalid flag config (malformed JSON, out-of-range values, contradictory flags) written to KV should not propagate to running services. The watch goroutine is the right place to intercept and discard invalid configs while alerting the flag-writing system.

---
