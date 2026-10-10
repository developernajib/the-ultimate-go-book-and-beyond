## 47.6 Configuration Management

### The 2026 layering: env vars, ConfigMaps, and a secrets manager

Configuration in 2026 is a three-layer stack, not a single key-value store:

1. **Environment variables** remain the universal injection point at process start. Go services read them once into a typed struct (via `envconfig`, `koanf`, or a hand-written loader). Twelve-factor config, still correct.
2. **Non-sensitive configuration** - feature flags, timeouts, pool sizes, routing tables, sampling rates - lives in Kubernetes **ConfigMaps** (or the equivalent in your platform) and is either mounted as files or projected into environment variables. For cross-cluster or non-Kubernetes deployments, Consul KV, etcd, or AWS Parameter Store (non-`SecureString`) fills this slot.
3. **Secrets** - database passwords, API keys, JWT signing keys, TLS private keys - never go in ConfigMaps, never go in Git, and never hit disk unencrypted. The 2026 standard pattern is:
   - A **central secrets manager**: HashiCorp Vault (still dominant. Vault 1.21 added native SPIFFE auth and granular secret recovery, and the Vault Secrets Operator plus the Secrets Store CSI provider cover Kubernetes injection), AWS Secrets Manager, GCP Secret Manager, or Azure Key Vault.
   - **Injection at runtime** via the Vault Agent/Secrets Operator, the AWS/GCP Secrets Store CSI Driver, or the External Secrets Operator - which syncs external secret stores into native Kubernetes `Secret` objects without you writing glue code.
   - **Short-lived, on-demand credentials**: dynamic database credentials that expire in an hour, workload identities (SPIFFE/SPIRE, IRSA, Workload Identity Federation) that replace long-lived service account keys entirely. No static credentials in your cluster or codebase.
4. **Dynamic runtime configuration** (feature flags, rate limits, experiment assignments) goes in a dedicated feature-flag platform (LaunchDarkly, Unleash, OpenFeature) or a purpose-built KV watch pattern like the `ConfigStore` below. The key property is *hot reload* - the process observes changes and adjusts behavior without a restart.

**Hard rules, non-negotiable:** no hardcoded credentials in source. No `.env` files checked into Git. No plaintext secrets in ConfigMaps or container images. Never log the values of config structs at Info level if they contain secrets - use a `String()` method that redacts fields tagged sensitive.

### Distributed Configuration

In a microservices environment, each service needs configuration for database URLs, feature flags, rate limits, and upstream service addresses. Storing this configuration in a distributed key-value store like Consul lets operators change values at runtime without redeploying. The `ConfigStore` below caches values locally with `sync.Map` for fast reads, uses Consul's blocking queries to detect changes without polling, and notifies registered watchers when a value updates so the service can react (for example, adjusting a rate limiter) without a restart. The same pattern (blocking query + local cache + watcher callbacks) applies verbatim to etcd `Watch`, to Kubernetes `informers` on a ConfigMap, and to the Vault Agent's file-reload notifications.

```go
package config

import (
    "context"
    "encoding/json"
    "strings"
    "sync"
    "time"

    "github.com/hashicorp/consul/api"
)

// ConfigStore manages distributed configuration
type ConfigStore struct {
    client    *api.Client
    prefix    string
    cache     sync.Map
    watchers  map[string][]func(any)
    watcherMu sync.RWMutex
}

func NewConfigStore(consulAddr, prefix string) (*ConfigStore, error) {
    client, err := api.NewClient(&api.Config{
        Address: consulAddr,
    })
    if err != nil {
        return nil, err
    }

    return &ConfigStore{
        client:   client,
        prefix:   prefix,
        watchers: make(map[string][]func(any)),
    }, nil
}

// Get retrieves a configuration value
func (c *ConfigStore) Get(ctx context.Context, key string, value any) error {
    // Check cache first
    if cached, ok := c.cache.Load(key); ok {
        return json.Unmarshal(cached.([]byte), value)
    }

    // Fetch from Consul
    pair, _, err := c.client.KV().Get(c.prefix+"/"+key, nil)
    if err != nil {
        return err
    }

    if pair == nil {
        return ErrConfigNotFound
    }

    c.cache.Store(key, pair.Value)
    return json.Unmarshal(pair.Value, value)
}

// Set stores a configuration value
func (c *ConfigStore) Set(ctx context.Context, key string, value any) error {
    data, err := json.Marshal(value)
    if err != nil {
        return err
    }

    _, err = c.client.KV().Put(&api.KVPair{
        Key:   c.prefix + "/" + key,
        Value: data,
    }, nil)

    if err != nil {
        return err
    }

    c.cache.Store(key, data)
    c.notifyWatchers(key, value)
    return nil
}

// Watch registers a callback for configuration changes
func (c *ConfigStore) Watch(key string, callback func(any)) {
    c.watcherMu.Lock()
    c.watchers[key] = append(c.watchers[key], callback)
    c.watcherMu.Unlock()
}

func (c *ConfigStore) notifyWatchers(key string, value any) {
    c.watcherMu.RLock()
    watchers := c.watchers[key]
    c.watcherMu.RUnlock()

    for _, callback := range watchers {
        go callback(value)
    }
}

// WatchChanges watches for configuration changes
func (c *ConfigStore) WatchChanges(ctx context.Context) {
    var lastIndex uint64

    for {
        select {
        case <-ctx.Done():
            return
        default:
        }

        pairs, meta, err := c.client.KV().List(c.prefix+"/", &api.QueryOptions{
            WaitIndex: lastIndex,
            WaitTime:  time.Minute,
        })
        if err != nil {
            time.Sleep(5 * time.Second)
            continue
        }

        if meta.LastIndex != lastIndex {
            lastIndex = meta.LastIndex

            for _, pair := range pairs {
                key := strings.TrimPrefix(pair.Key, c.prefix+"/")

                // Update cache
                c.cache.Store(key, pair.Value)

                // Notify watchers
                var value any
                json.Unmarshal(pair.Value, &value)
                c.notifyWatchers(key, value)
            }
        }
    }
}
```

### Junior → FAANG: Configuration as a First-Class Concern

Junior engineers often treat configuration as an afterthought: hardcode a value, move it to an environment variable when a reviewer complains, stop there. At FAANG companies, configuration is a first-class system with its own governance.

The twelve-factor app rule is the correct starting point: configuration is anything that differs between deployment environments (dev, staging, prod). It belongs in environment variables, not in code. In Go, read config once at startup into a typed struct. Do not scatter `os.Getenv` calls throughout the codebase.

The three-layer model to memorize: environment variables for startup config, ConfigMaps/Consul KV for non-sensitive runtime config, secrets manager (Vault, AWS Secrets Manager) for credentials. The distinction matters in interviews: an interviewer who asks "how do you handle configuration in a microservices system?" wants to hear all three layers, not just "environment variables."

Dynamic configuration is the intermediate level. The `ConfigStore` implementation in this chapter shows how a service can react to a config change without restarting. Practical use case: a feature flag that enables or disables a new algorithm. Without dynamic config, enabling the feature requires a deploy. With dynamic config, it requires updating a key in Consul or your feature flag platform.

In interviews, the most common configuration-related question is about secrets: "where do you store database passwords in a microservices system?" The wrong answer is "environment variables" (they are fine for local dev, but hardcoding them in Kubernetes pod specs is not secure). The correct answer is a secrets manager with short-lived credentials rotated automatically, injected into the pod at runtime by Vault Agent or the Secrets Store CSI Driver.

### Senior @ FAANG: Secrets Governance, Dynamic Config, and Configuration as a Platform

At L6/L7, configuration management is a platform engineering problem. The questions are not "how do I read a config value" but "how do I ensure that no team can accidentally expose a secret, that config changes are auditable, and that a bad config push cannot take down production?"

**Secrets governance at the platform level.** The platform team owns the Vault cluster, the PKI backend (for dynamic TLS certificates), and the database secrets engine (for short-lived Postgres credentials). Application teams get a Vault role that grants access to specific secret paths via IRSA (AWS), Workload Identity (GCP), or Kubernetes ServiceAccount auth. They do not get long-lived tokens. Rotation is automatic: database credentials have a TTL of 1 to 24 hours, and the Vault Agent renews them before expiry and writes the refreshed credential to a tmpfs volume that the application reads. No human ever sees the production database password. This eliminates the "credential rotation is painful" class of incidents.

**Configuration change governance.** A misconfigured rate limit or feature flag can cause an outage as effectively as a bad deploy. Platform-level mitigations: (a) config changes go through the same PR review process as code changes, enforced by a GitOps workflow (ArgoCD reads ConfigMaps from Git, so every change is a commit with an author and a review). (b) Config changes to production require a staged rollout: push to 10% of instances, observe RED metrics for N minutes, then roll forward or rollback. The Consul watch pattern in this chapter can be extended to support this: a `canary_weight` key controls what percentage of instances pick up the new config. (c) Config validation runs in CI before merge: a linting step that checks type correctness, value ranges, and dependency constraints.

**Feature flag platforms as the dynamic config layer.** LaunchDarkly, Unleash, and OpenFeature all provide more than key-value lookup. They provide: targeting (enable for user IDs in a beta group, enable for employees only), gradual rollouts (enable for 1%, then 10%, then 100% of traffic), kill switches (disable immediately without a deploy), and audit logs. The OpenFeature standard is the 2026 abstraction: a vendor-neutral SDK that applications use, with a provider backend (LaunchDarkly, Unleash, or in-house) swappable without changing application code. Staff engineers advocate for OpenFeature adoption to prevent vendor lock-in in the feature flagging layer.

**Hot reload correctness.** Dynamic config is deceptively difficult to get right in a concurrent Go program. The watcher callback in the `ConfigStore` fires in a goroutine. If the application uses the config value in a hot path without synchronization, it can read a partially-updated struct during the write. The correct Go pattern is to use an `atomic.Pointer[Config]` or a channel-based replacement of the entire config struct, so readers always see a consistent snapshot. Never update individual config fields in place under a lock that is also held during the hot path, or you create lock contention proportional to your request rate.

---
