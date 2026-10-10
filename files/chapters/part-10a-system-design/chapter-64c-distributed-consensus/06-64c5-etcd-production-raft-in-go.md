## 64C.5 etcd - Production Raft in Go

### etcd as the Gold Standard

etcd is an open-source, distributed key-value store implemented in Go, using the Raft consensus algorithm. It is maintained by the CNCF and is the production-grade reference implementation of Raft in Go.

etcd is the backbone of Kubernetes: every cluster configuration, pod spec, service definition, and secret lives in etcd. Understanding etcd is essential for any engineer working in the cloud-native ecosystem.

Key characteristics:
- Strong consistency (linearizable reads and writes by default)
- Watch mechanism for real-time change notification
- TTL-based leases for ephemeral keys
- Multi-version concurrency control (MVCC)
- Transactions (compare-and-swap)

### How Kubernetes Uses etcd

```
Kubernetes Control Plane
┌─────────────────────────────────────────────────────┐
│                                                     │
│  kube-apiserver ──→ etcd cluster (3 or 5 nodes)     │
│       ↑                    ↓                        │
│  kubectl          Watch for changes                 │
│                            ↓                        │
│  kube-controller-manager ←─┘                        │
│  kube-scheduler ←──────────┘                        │
│                                                     │
└─────────────────────────────────────────────────────┘

Every API object (Pod, Service, Deployment...) is stored
in etcd under a key like:
  /registry/pods/default/my-pod
  /registry/services/default/my-service
```

### etcd v3 API in Go

```go
// etcd/client.go
package etcdclient

import (
	"context"
	"fmt"
	"log"
	"time"

	clientv3 "go.etcd.io/etcd/client/v3"
)

// ─── Connection ───────────────────────────────────────────────────────────────

func NewClient(endpoints []string) (*clientv3.Client, error) {
	cfg := clientv3.Config{
		Endpoints:   endpoints,
		DialTimeout: 5 * time.Second,
		// TLS config for production:
		// TLS: &tls.Config{...},
	}
	return clientv3.New(cfg)
}

// ─── KV Operations ────────────────────────────────────────────────────────────

// BasicKVOps demonstrates put, get, delete, and list operations.
func BasicKVOps(client *clientv3.Client) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	// Put a key
	_, err := client.Put(ctx, "/config/database/host", "db.example.com")
	if err != nil {
		log.Fatalf("put: %v", err)
	}

	// Get a key
	resp, err := client.Get(ctx, "/config/database/host")
	if err != nil {
		log.Fatalf("get: %v", err)
	}
	for _, kv := range resp.Kvs {
		fmt.Printf("key=%s value=%s version=%d\n", kv.Key, kv.Value, kv.Version)
	}

	// Get all keys with prefix
	resp, err = client.Get(ctx, "/config/", clientv3.WithPrefix())
	if err != nil {
		log.Fatalf("get prefix: %v", err)
	}
	for _, kv := range resp.Kvs {
		fmt.Printf("  %s = %s\n", kv.Key, kv.Value)
	}

	// Delete a key
	delResp, err := client.Delete(ctx, "/config/database/host")
	if err != nil {
		log.Fatalf("delete: %v", err)
	}
	fmt.Printf("Deleted %d keys\n", delResp.Deleted)
}

// ─── Transactions (Compare-and-Swap) ─────────────────────────────────────────

// AtomicUpdate performs a compare-and-swap: only update if current value matches.
func AtomicUpdate(client *clientv3.Client, key, expectedVal, newVal string) (bool, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	txnResp, err := client.Txn(ctx).
		// IF key's value equals expectedVal
		If(clientv3.Compare(clientv3.Value(key), "=", expectedVal)).
		// THEN update the value
		Then(clientv3.OpPut(key, newVal)).
		// ELSE do nothing
		Else(clientv3.OpGet(key)).
		Commit()
	if err != nil {
		return false, fmt.Errorf("txn: %w", err)
	}
	return txnResp.Succeeded, nil
}

// ─── Watch ────────────────────────────────────────────────────────────────────

// WatchPrefix watches all keys with a given prefix and calls onChange for each event.
func WatchPrefix(ctx context.Context, client *clientv3.Client, prefix string,
	onChange func(eventType, key, value string)) {

	watchChan := client.Watch(ctx, prefix, clientv3.WithPrefix())
	for {
		select {
		case watchResp, ok := <-watchChan:
			if !ok {
				log.Printf("watch channel closed")
				return
			}
			if watchResp.Err() != nil {
				log.Printf("watch error: %v", watchResp.Err())
				return
			}
			for _, event := range watchResp.Events {
				var eventType string
				switch event.Type {
				case clientv3.EventTypePut:
					eventType = "PUT"
				case clientv3.EventTypeDelete:
					eventType = "DELETE"
				}
				onChange(eventType, string(event.Kv.Key), string(event.Kv.Value))
			}
		case <-ctx.Done():
			return
		}
	}
}

// ─── Lease (TTL-based ephemeral keys) ────────────────────────────────────────

// KeepAliveKey creates a key that is automatically deleted if the lease is not
// renewed. Used for health indicators, ephemeral registrations, etc.
func KeepAliveKey(ctx context.Context, client *clientv3.Client,
	key, value string, ttlSeconds int64) error {

	// Create a lease
	leaseResp, err := client.Grant(ctx, ttlSeconds)
	if err != nil {
		return fmt.Errorf("grant lease: %w", err)
	}
	leaseID := leaseResp.ID

	// Put the key with the lease attached
	_, err = client.Put(ctx, key, value, clientv3.WithLease(leaseID))
	if err != nil {
		return fmt.Errorf("put with lease: %w", err)
	}

	// Keep the lease alive until ctx is canceled
	keepAliveChan, err := client.KeepAlive(ctx, leaseID)
	if err != nil {
		return fmt.Errorf("keep alive: %w", err)
	}

	go func() {
		for {
			select {
			case _, ok := <-keepAliveChan:
				if !ok {
					log.Printf("lease %x expired or keep-alive closed", leaseID)
					return
				}
				// Lease renewed successfully
			case <-ctx.Done():
				// Revoke the lease explicitly so the key is deleted immediately
				revokeCtx, revokeCancel := context.WithTimeout(context.Background(), 3*time.Second)
				defer revokeCancel()
				if _, err := client.Revoke(revokeCtx, leaseID); err != nil {
					log.Printf("revoke lease: %v", err)
				}
				return
			}
		}
	}()

	return nil
}

// ─── etcd Health Check ────────────────────────────────────────────────────────

func HealthCheck(client *clientv3.Client) error {
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()

	_, err := client.Get(ctx, "health-check-probe")
	return err
}

// ─── etcd Cluster Ops ─────────────────────────────────────────────────────────

func ListMembers(client *clientv3.Client) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	resp, err := client.MemberList(ctx)
	if err != nil {
		log.Fatalf("member list: %v", err)
	}
	for _, member := range resp.Members {
		fmt.Printf("ID=%x Name=%s PeerURLs=%v ClientURLs=%v IsLearner=%v\n",
			member.ID, member.Name, member.PeerURLs, member.ClientURLs, member.IsLearner)
	}
}
```

### etcd Performance Characteristics

| Operation | Typical Latency | Notes |
|---|---|---|
| Write (leader) | 1-10ms local | One Raft round trip to quorum |
| Read (linearizable) | 1-10ms | Requires leader confirmation |
| Read (serializable) | <1ms | Can serve from any node (possibly stale) |
| Watch notification | <10ms | Streamed from leader |
| Lease grant | 1-10ms | One Raft round trip |
| Throughput | ~10,000 writes/sec | With 3-node cluster, small values |

**Key performance considerations:**
- etcd is optimized for **small values** (typically < 8KB per key). Storing large blobs (images, binaries) is an anti-pattern.
- **Watch is efficient**: clients watch for changes rather than polling.
- **Compaction** must be configured: etcd stores all historical revisions by default. Without periodic compaction, storage grows unboundedly.
- **Defragmentation** reclaims disk space after compaction.

### Junior → FAANG: Using etcd Correctly from Day One

etcd is the first consensus system most Go engineers interact with directly. Kubernetes runs on it, and many microservice platforms expose etcd (or Consul, which has a similar API) for configuration and service discovery. Here are the habits to build from the start.

**Always use contexts with timeouts.** Every etcd operation should have a `context.WithTimeout`. A missing timeout on a Put or Get call means your service can block indefinitely if the etcd cluster is unavailable. The standard timeout for point operations is 5 seconds. For watches, use a cancellable context tied to the service lifecycle, not a timeout context (watches are long-lived by design).

**Understand the difference between linearizable and serializable reads.** The default etcd Get is linearizable: it confirms with the leader before returning. This is correct for most coordination uses (checking if a lock is held, reading a configuration value that must be current). Serializable reads (`clientv3.WithSerializable()`) can be served from any follower and may return stale data. Using serializable reads to make a coordination decision (e.g., "check if key X exists before acquiring lock Y") is unsafe: the value you read may already be outdated by the time you act on it. Use serializable reads only for non-critical read paths where staleness is explicitly acceptable.

**Lease renewal and the keepalive goroutine.** The `KeepAliveKey` pattern in this section shows how to maintain a lease-backed key. A common junior mistake is to grant a lease, put a key, and then not keep the lease alive, causing the key to expire and the downstream watchers to see a DELETE event that was not intentional. Always pair lease creation with a keepalive goroutine. Always handle the case where the keepalive channel closes unexpectedly (it closes when the context is canceled or the lease expires on the server side).

**MVCC and revision-based watches.** etcd's watch mechanism is revision-based: you can start a watch at a specific revision and receive all events since that point. This means watches are reliable across reconnections: if your watch goroutine restarts, re-establish the watch with the last seen revision rather than watching from "now." Missing events between reconnection and the new watch start is a common source of configuration drift in Go services using etcd.

### Senior @ FAANG: etcd as Platform Infrastructure

**ADR: etcd cluster topology per environment.** A three-node etcd cluster is standard for production Kubernetes. But what about development, staging, and CI environments? Running a three-node etcd cluster in CI is expensive and slow to provision. A single-node etcd instance is fast but has no fault tolerance and gives false confidence about multi-node behavior. The ADR should document: what topology runs in each environment, what failure modes are not exercised in non-production environments, and what chaos testing covers those gaps. The upstream Kubernetes project itself runs partition and failure tests against multi-node etcd clusters in dedicated test environments that mimic production topology, which is the model to copy.

**Operational runbook: etcd compaction and defragmentation.** Without compaction, etcd storage grows without bound because MVCC retains every revision of every key. The production runbook must specify: the compaction mode (periodic with `--auto-compaction-mode=periodic --auto-compaction-retention=1h` is standard), the defragmentation schedule (weekly defrag on each member, one at a time, during low-traffic windows), and the monitoring alert for database size approaching the `--quota-backend-bytes` limit (default 2GB, raise to 8GB for large clusters but document the decision). Skipping this runbook is one of the most common causes of etcd-related Kubernetes outages.

**Governance: etcd key space ownership.** In a Kubernetes cluster, every custom resource, secret, configmap, and pod spec is a key in etcd. Teams that store large annotations, large ConfigMaps, or many fine-grained keys can degrade etcd performance for everyone. Staff engineers define key space policies: maximum annotation size (typically 256KB), maximum ConfigMap size (1MB), key naming conventions that enable prefix-based access control, and an alerting threshold for key count growth per namespace.

**Watch cardinality as a platform concern.** Each watch stream holds server-side state in etcd. A controller that watches individual keys for 10,000 resources rather than using a prefix watch creates 10,000 watch streams. At scale, this causes memory pressure on the etcd server and increases the load on the leader during watch notification fanout. Staff engineers enforce the pattern: watch a prefix, filter client-side. Document this as a platform coding standard with a code review checklist item.

**L6/L7 concern: etcd and Kubernetes control plane latency.** In a large Kubernetes cluster (10,000 nodes), the etcd cluster receives write traffic from every pod create, update, and delete event. During a deployment of 1,000 pods, the API server may send hundreds of writes per second to etcd. If etcd write latency spikes (due to disk pressure, compaction, or election), the kube-scheduler and kube-controller-manager fall behind, causing pod scheduling latency to increase. Staff engineers who own Kubernetes infrastructure must correlate etcd write latency with scheduler throughput and set alerts that trigger before scheduling latency becomes user-visible. The causal chain is: disk IOPS saturation on etcd nodes causes fsync latency increase, which causes Raft commit latency increase, which causes API server latency increase, which causes control plane slowdown, which causes pod startup latency increase. Tracing this chain requires distributed tracing across etcd and the Kubernetes control plane, not just per-service metrics.

---
