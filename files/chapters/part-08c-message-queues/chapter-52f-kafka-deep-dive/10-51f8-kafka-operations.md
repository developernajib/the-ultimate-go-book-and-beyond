## 52F.8 Kafka Operations

### Key Metrics to Monitor

Effective Kafka operations require monitoring metrics across brokers, producers, consumers, and topics:

```
┌───────────────────────────────────────────────────────────────┐
│                  Kafka Monitoring Dashboard                   │
│                                                               │
│  ┌─────────────────────────────────────────────────────┐      │
│  │  BROKER HEALTH                                      │      │
│  │  Active Controllers: 1    Under-Replicated: 0       │      │
│  │  Offline Partitions: 0    ISR Shrinks/s: 0.0        │      │
│  │  Request Latency p99: 12ms                          │      │
│  └─────────────────────────────────────────────────────┘      │
│                                                               │
│  ┌─────────────────────────────────────────────────────┐      │
│  │  THROUGHPUT                                         │      │
│  │  Bytes In/s:  ████████████████░░░░  450 MB/s        │      │
│  │  Bytes Out/s: ██████████████████░░  520 MB/s        │      │
│  │  Messages/s:  ████████████░░░░░░░░  1.2M            │      │
│  └─────────────────────────────────────────────────────┘      │
│                                                               │
│  ┌─────────────────────────────────────────────────────┐      │
│  │  CONSUMER LAG                                       │      │
│  │  order-processor:     ██░░░░░░░░░░  1,234           │      │
│  │  analytics-pipeline:  ████████░░░░  45,678          │      │
│  │  search-indexer:      █░░░░░░░░░░░  456             │      │
│  └─────────────────────────────────────────────────────┘      │
│                                                               │
│  ┌─────────────────────────────────────────────────────┐      │
│  │  PARTITION HEALTH                                   │      │
│  │  Total Partitions: 2,400                            │      │
│  │  Under-Replicated: 0                                │      │
│  │  Under Min ISR: 0                                   │      │
│  │  Leader Imbalance: 2.3%                             │      │
│  └─────────────────────────────────────────────────────┘      │
└───────────────────────────────────────────────────────────────┘
```

| Metric | Source (JMX Bean) | Warning Threshold | Critical Threshold |
|--------|-------------------|-------------------|--------------------|
| Under-replicated partitions | `kafka.server:type=ReplicaManager,name=UnderReplicatedPartitions` | > 0 for 5 min | > 0 for 15 min |
| Offline partitions | `kafka.controller:type=KafkaController,name=OfflinePartitionsCount` | N/A | > 0 |
| Active controller count | `kafka.controller:type=KafkaController,name=ActiveControllerCount` | N/A | != 1 |
| ISR shrink rate | `kafka.server:type=ReplicaManager,name=IsrShrinksPerSec` | > 0/s sustained | > 5/s |
| Request latency (p99) | `kafka.network:type=RequestMetrics,name=TotalTimeMs` | > 100ms | > 500ms |
| Consumer lag | Consumer group describe | > 10,000 | > 100,000 |
| Bytes in/out per second | `kafka.server:type=BrokerTopicMetrics` | > 80% capacity | > 95% capacity |
| Log flush latency | `kafka.log:type=LogFlushStats` | > 50ms | > 200ms |
| Network handler idle % | `kafka.server:type=KafkaRequestHandlerPool` | < 30% | < 10% |

### Prometheus/JMX Monitoring Setup

Kafka exposes hundreds of JMX metrics covering broker health, producer throughput, and consumer lag. Translating these into Prometheus format is the standard approach for modern observability stacks. The following configuration and scrape rules show how to deploy the JMX Exporter alongside your Kafka brokers and which metrics to prioritize for SLA alerting.

```yaml
# prometheus.yml
global:
  scrape_interval: 15s
  evaluation_interval: 15s

scrape_configs:
  - job_name: 'kafka'
    static_configs:
      - targets:
        - 'kafka-broker-1:7071'
        - 'kafka-broker-2:7071'
        - 'kafka-broker-3:7071'
    metrics_path: /metrics

  - job_name: 'kafka-consumer-lag'
    static_configs:
      - targets:
        - 'kafka-lag-exporter:9999'
    metrics_path: /metrics

rule_files:
  - 'kafka_alerts.yml'
```

```yaml
# kafka_alerts.yml
groups:
  - name: kafka_critical
    rules:
      - alert: KafkaOfflinePartitions
        expr: kafka_controller_kafkacontroller_offlinepartitionscount > 0
        for: 1m
        labels:
          severity: critical
        annotations:
          summary: "Kafka has {{ $value }} offline partitions"
          description: >
            Offline partitions cannot serve reads or writes.
            Immediate investigation required. Check broker logs
            and disk health.

      - alert: KafkaUnderReplicatedPartitions
        expr: kafka_server_replicamanager_underreplicatedpartitions > 0
        for: 10m
        labels:
          severity: warning
        annotations:
          summary: "{{ $value }} under-replicated partitions on {{ $labels.instance }}"
          description: >
            Under-replicated partitions indicate a follower is falling behind
            the leader. Check network connectivity, disk I/O, and broker load.

      - alert: KafkaNoActiveController
        expr: sum(kafka_controller_kafkacontroller_activecontrollercount) != 1
        for: 1m
        labels:
          severity: critical
        annotations:
          summary: "Kafka cluster has {{ $value }} active controllers (expected 1)"
          description: >
            The cluster must have exactly one active controller.
            Zero means no controller election has succeeded.
            More than one indicates a split-brain scenario.

      - alert: KafkaConsumerLagHigh
        expr: kafka_consumergroup_lag_sum > 100000
        for: 15m
        labels:
          severity: warning
        annotations:
          summary: "Consumer group {{ $labels.consumergroup }} has high lag: {{ $value }}"
          description: >
            Consumer group is falling behind. Check consumer health,
            processing errors, and consider scaling consumer instances.

      - alert: KafkaISRShrinkRate
        expr: rate(kafka_server_replicamanager_isrshrinkspersec[5m]) > 5
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "High ISR shrink rate on {{ $labels.instance }}: {{ $value }}/s"
          description: >
            Frequent ISR shrinks indicate brokers are struggling to keep up
            with replication. Check disk I/O, network, and broker load.

      - alert: KafkaBrokerDiskUsage
        expr: (kafka_log_log_size / kafka_log_log_maxsize) > 0.85
        for: 30m
        labels:
          severity: warning
        annotations:
          summary: "Kafka broker disk usage above 85% on {{ $labels.instance }}"
          description: >
            Disk is filling up. Review retention policies, increase disk
            capacity, or move partitions to other brokers.

      - alert: KafkaRequestLatencyHigh
        expr: kafka_network_requestmetrics_totaltimems{quantile="0.99"} > 500
        for: 10m
        labels:
          severity: warning
        annotations:
          summary: "Kafka request latency p99 is {{ $value }}ms on {{ $labels.instance }}"
```

### Capacity Planning

Accurate Kafka capacity planning requires modeling retention bytes, replication factor, producer throughput, and consumer group count against available disk I/O and network bandwidth. The following worksheet translates peak message rates and retention periods into concrete broker sizing recommendations.

```
Capacity Planning Formula:

Daily Data Volume = Messages/day × Average Message Size
                  = 100M msgs × 1 KB = 100 GB/day

Storage Required  = Daily Volume × Retention Days × Replication Factor
                  = 100 GB × 7 days × 3 replicas = 2.1 TB

With 20% overhead for indexes and OS:
  Total Storage = 2.1 TB × 1.2 = 2.52 TB

Partitions per Topic:
  Target Throughput / Per-Partition Throughput
  = 500 MB/s / 10 MB/s per partition = 50 partitions

Broker Count:
  Consider: CPU, memory, disk I/O, network bandwidth
  Rule of thumb: 1 broker per 6-12 TB of storage
  For 2.52 TB with growth: 3 brokers minimum (for replication factor 3)

Network Bandwidth per Broker:
  Ingress = Total Ingress / Broker Count
  Egress  = Ingress × (Replication Factor - 1 + Consumer Count)
  Example: 500 MB/s ingress, 3 brokers, RF=3, 2 consumer groups
           Per broker ingress = 167 MB/s
           Per broker egress  = 167 × (2 + 2) = 668 MB/s
           Need: 10 Gbps NIC minimum
```

### Performance Tuning Matrix

| Parameter | Default | Latency-Optimized | Throughput-Optimized | Balanced |
|-----------|---------|-------------------|----------------------|----------|
| `batch.size` (producer) | 16384 | 1 | 524288 | 65536 |
| `linger.ms` (producer) | 0 | 0 | 50 | 10 |
| `buffer.memory` (producer) | 33554432 | 33554432 | 134217728 | 67108864 |
| `compression.type` (producer) | none | none | lz4 | snappy |
| `acks` (producer) | all | 1 | all | all |
| `fetch.min.bytes` (consumer) | 1 | 1 | 65536 | 1024 |
| `fetch.max.wait.ms` (consumer) | 500 | 100 | 500 | 500 |
| `max.poll.records` (consumer) | 500 | 100 | 1000 | 500 |
| `num.io.threads` (broker) | 8 | 8 | 16 | 8 |
| `num.network.threads` (broker) | 3 | 3 | 8 | 4 |
| `socket.send.buffer.bytes` (broker) | 102400 | 102400 | 1048576 | 524288 |
| `socket.receive.buffer.bytes` (broker) | 102400 | 102400 | 1048576 | 524288 |

### Go Code: Consumer Lag Monitor

Consumer lag (the gap between the latest produced offset and the last committed consumer offset) is the single most important Kafka health signal in production. The following Go service polls the Kafka broker for partition high-watermarks and consumer group committed offsets, then emits Prometheus gauges that trigger alerts before lag grows critical.

```go
package main

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
    "sort"
	"sync"
	"syscall"
	"time"

	"github.com/IBM/sarama"
)

// PartitionLag holds lag information for a single partition.
type PartitionLag struct {
	Topic           string `json:"topic"`
	Partition       int32  `json:"partition"`
	CurrentOffset   int64  `json:"current_offset"`
	LogEndOffset    int64  `json:"log_end_offset"`
	Lag             int64  `json:"lag"`
	ConsumerID      string `json:"consumer_id,omitempty"`
}

// GroupLag holds lag information for an entire consumer group.
type GroupLag struct {
	Group         string          `json:"group"`
	TotalLag      int64           `json:"total_lag"`
	Partitions    []PartitionLag  `json:"partitions"`
	State         string          `json:"state"`
	LastChecked   time.Time       `json:"last_checked"`
}

// LagMonitor continuously monitors consumer group lag.
type LagMonitor struct {
	admin       sarama.ClusterAdmin
	client      sarama.Client
	logger      *slog.Logger
	interval    time.Duration
	alertThresh int64

	mu       sync.RWMutex
	lagState map[string]*GroupLag
	history  map[string][]lagSnapshot
}

type lagSnapshot struct {
	timestamp time.Time
	totalLag  int64
}

// LagMonitorConfig holds configuration for the lag monitor.
type LagMonitorConfig struct {
	Brokers        []string
	Interval       time.Duration
	AlertThreshold int64
	Logger         *slog.Logger
}

// NewLagMonitor creates a new consumer lag monitor.
func NewLagMonitor(cfg LagMonitorConfig) (*LagMonitor, error) {
	config := sarama.NewConfig()
	config.Version = sarama.V3_6_0_0

	client, err := sarama.NewClient(cfg.Brokers, config)
	if err != nil {
		return nil, fmt.Errorf("creating client: %w", err)
	}

	admin, err := sarama.NewClusterAdminFromClient(client)
	if err != nil {
		client.Close()
		return nil, fmt.Errorf("creating admin: %w", err)
	}

	return &LagMonitor{
		admin:       admin,
		client:      client,
		logger:      cfg.Logger,
		interval:    cfg.Interval,
		alertThresh: cfg.AlertThreshold,
		lagState:    make(map[string]*GroupLag),
		history:     make(map[string][]lagSnapshot),
	}, nil
}

// Start begins the monitoring loop.
func (m *LagMonitor) Start(ctx context.Context) {
	ticker := time.NewTicker(m.interval)
	defer ticker.Stop()

	// Run immediately on start.
	m.checkAllGroups()

	for {
		select {
		case <-ctx.Done():
			m.logger.Info("lag monitor stopped")
			return
		case <-ticker.C:
			m.checkAllGroups()
		}
	}
}

func (m *LagMonitor) checkAllGroups() {
	groups, err := m.admin.ListConsumerGroups()
	if err != nil {
		m.logger.Error("failed to list consumer groups", "error", err)
		return
	}

	groupNames := make([]string, 0, len(groups))
	for name := range groups {
		groupNames = append(groupNames, name)
	}

	for _, group := range groupNames {
		lag, err := m.getGroupLag(group)
		if err != nil {
			m.logger.Error("failed to get lag",
				"group", group,
				"error", err,
			)
			continue
		}

		m.mu.Lock()
		m.lagState[group] = lag

		// Record history for trend analysis.
		m.history[group] = append(m.history[group], lagSnapshot{
			timestamp: time.Now(),
			totalLag:  lag.TotalLag,
		})
		// Keep only the last 360 snapshots (1 hour at 10s intervals).
		if len(m.history[group]) > 360 {
			m.history[group] = m.history[group][1:]
		}
		m.mu.Unlock()

		// Check alert threshold.
		if lag.TotalLag > m.alertThresh {
			m.logger.Warn("consumer lag exceeds threshold",
				"group", group,
				"total_lag", lag.TotalLag,
				"threshold", m.alertThresh,
				"state", lag.State,
			)
			m.checkLagTrend(group)
		}
	}
}

func (m *LagMonitor) getGroupLag(group string) (*GroupLag, error) {
	// Describe the consumer group to get member assignments.
	groupDescs, err := m.admin.DescribeConsumerGroups([]string{group})
	if err != nil {
		return nil, fmt.Errorf("describing group: %w", err)
	}

	if len(groupDescs) == 0 {
		return nil, fmt.Errorf("no description returned for group %s", group)
	}

	desc := groupDescs[0]

	// List committed offsets for the group.
	offsets, err := m.admin.ListConsumerGroupOffsets(group, nil)
	if err != nil {
		return nil, fmt.Errorf("listing offsets: %w", err)
	}

	var partitions []PartitionLag
	var totalLag int64

	// Build a map of member assignments for consumer ID lookup.
	memberMap := make(map[string]string) // "topic:partition" -> consumer ID
	for _, member := range desc.Members {
		assignment, err := member.GetMemberAssignment()
		if err != nil {
			continue
		}
		for topic, parts := range assignment.Topics {
			for _, p := range parts {
				key := fmt.Sprintf("%s:%d", topic, p)
				memberMap[key] = member.ClientId
			}
		}
	}

	for topic, partitionOffsets := range offsets.Blocks {
		for partition, block := range partitionOffsets {
			if block.Offset == -1 {
				continue // No committed offset.
			}

			// Get the log end offset (latest offset) for this partition.
			logEndOffset, err := m.client.GetOffset(topic, partition, sarama.OffsetNewest)
			if err != nil {
				m.logger.Error("failed to get log end offset",
					"topic", topic,
					"partition", partition,
					"error", err,
				)
				continue
			}

			lag := logEndOffset - block.Offset
			if lag < 0 {
				lag = 0
			}

			key := fmt.Sprintf("%s:%d", topic, partition)
			pl := PartitionLag{
				Topic:         topic,
				Partition:     partition,
				CurrentOffset: block.Offset,
				LogEndOffset:  logEndOffset,
				Lag:           lag,
				ConsumerID:    memberMap[key],
			}
			partitions = append(partitions, pl)
			totalLag += lag
		}
	}

	// Sort partitions by lag descending for easy identification of hotspots.
	sort.Slice(partitions, func(i, j int) bool {
		return partitions[i].Lag > partitions[j].Lag
	})

	return &GroupLag{
		Group:       group,
		TotalLag:    totalLag,
		Partitions:  partitions,
		State:       desc.State,
		LastChecked: time.Now(),
	}, nil
}

func (m *LagMonitor) checkLagTrend(group string) {
	m.mu.RLock()
	history := m.history[group]
	m.mu.RUnlock()

	if len(history) < 6 {
		return // Not enough data for trend analysis.
	}

	// Compare the average lag of the last 3 snapshots with the prior 3.
	recent := history[len(history)-3:]
	prior := history[len(history)-6 : len(history)-3]

	var recentAvg, priorAvg float64
	for _, s := range recent {
		recentAvg += float64(s.totalLag)
	}
	recentAvg /= 3

	for _, s := range prior {
		priorAvg += float64(s.totalLag)
	}
	priorAvg /= 3

	if recentAvg > priorAvg*1.5 {
		m.logger.Error("consumer lag is INCREASING rapidly",
			"group", group,
			"recent_avg_lag", recentAvg,
			"prior_avg_lag", priorAvg,
			"growth_ratio", recentAvg/priorAvg,
		)
	} else if recentAvg < priorAvg*0.8 {
		m.logger.Info("consumer lag is DECREASING",
			"group", group,
			"recent_avg_lag", recentAvg,
			"prior_avg_lag", priorAvg,
		)
	}
}

// GetLagState returns the current lag state for all groups.
func (m *LagMonitor) GetLagState() map[string]*GroupLag {
	m.mu.RLock()
	defer m.mu.RUnlock()

	result := make(map[string]*GroupLag, len(m.lagState))
	for k, v := range m.lagState {
		result[k] = v
	}
	return result
}

// ServeHTTP exposes lag metrics via an HTTP endpoint.
func (m *LagMonitor) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	state := m.GetLagState()

	w.Header().Set("Content-Type", "application/json")
	if err := json.NewEncoder(w).Encode(state); err != nil {
		m.logger.Error("failed to encode lag state", "error", err)
		http.Error(w, "internal server error", http.StatusInternalServerError)
	}
}

// Close releases resources held by the lag monitor.
func (m *LagMonitor) Close() error {
	m.admin.Close()
	return m.client.Close()
}

func main() {
	logger := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{
		Level: slog.LevelInfo,
	}))

	monitor, err := NewLagMonitor(LagMonitorConfig{
		Brokers:        []string{"localhost:9092"},
		Interval:       10 * time.Second,
		AlertThreshold: 10000,
		Logger:         logger,
	})
	if err != nil {
		logger.Error("failed to create lag monitor", "error", err)
		os.Exit(1)
	}
	defer monitor.Close()

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	sigChan := make(chan os.Signal, 1)
	signal.Notify(sigChan, syscall.SIGINT, syscall.SIGTERM)

	// Start HTTP server for lag metrics endpoint.
	mux := http.NewServeMux()
	mux.HandleFunc("/lag", monitor.ServeHTTP)
	mux.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		w.Write([]byte(`{"status":"ok"}`))
	})

	server := &http.Server{
		Addr:         ":8080",
		Handler:      mux,
		ReadTimeout:  10 * time.Second,
		WriteTimeout: 10 * time.Second,
		IdleTimeout:  60 * time.Second,
	}

	go func() {
		logger.Info("starting lag metrics server", "addr", ":8080")
		if err := server.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			logger.Error("HTTP server error", "error", err)
		}
	}()

	// Start the monitoring loop.
	go monitor.Start(ctx)

	logger.Info("lag monitor running",
		"interval", "10s",
		"alert_threshold", 10000,
		"metrics_endpoint", "http://localhost:8080/lag",
	)

	<-sigChan
	logger.Info("shutdown signal received")
	cancel()

	shutdownCtx, shutdownCancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer shutdownCancel()
	server.Shutdown(shutdownCtx)

	logger.Info("lag monitor shut down")
}
```

> **Operational Wisdom**: The most important metric in Kafka operations is **consumer lag**. Every production deployment should have lag monitoring from day one. Monitor *lag velocity* (rate of change), not just absolute lag, a lag of 100,000 that is decreasing is healthy. a lag of 1,000 that is increasing exponentially will become a crisis. Netflix uses lag thresholds to trigger automatic consumer scaling when lag exceeds limits for more than 5 minutes.

### Junior -> FAANG: Reading Kafka Metrics Before You Need Them

The metrics in this section cover three categories: broker health (under-replicated partitions, active controllers, ISR shrink rate), throughput (bytes in/out, messages per second), and consumer lag. Most new engineers only look at consumer lag when something is wrong. Build the habit of checking all three categories during normal operations, so you recognize what normal looks like before an incident.

The Prometheus alert rules in this section are a production-ready starting point. Add them to your repository at the same time you deploy your first Kafka consumer. There is no valid reason to wait until you have a problem to add monitoring.

The `LagMonitor` code has a feature worth studying: the trend analysis in `checkLagTrend`. It compares the average lag of the last three snapshots against the prior three. A growing trend at 1,000 messages/second is more urgent than a stable lag of 50,000 messages. Absolute lag is not enough. Rate of change is the actionable signal.

For capacity planning, the formula in this section gives you a concrete calculation to present in system design interviews: `storage = messages_per_day * message_size * retention_days * replication_factor`. Being able to derive a storage number from throughput requirements, rather than guessing, is an L4/L5 differentiator.

Common first-job mistake: setting `fetch.min.bytes` too high on a low-throughput consumer. With `fetch.min.bytes=65536` (64KB) and a topic producing 1KB messages per second, the consumer waits up to `fetch.max.wait.ms` (default 500ms) before receiving any messages. This inflates perceived latency artificially. Set `fetch.min.bytes` based on your actual throughput, not the throughput-optimized preset.

### Senior @ FAANG: Kafka Operations as a Platform Engineering Discipline

Kafka operations at FAANG scale is a platform engineering discipline with its own on-call rotation, SLO, and tooling. Senior engineers on platform teams are responsible for the operational health of clusters that dozens of product teams depend on.

**Capacity planning governance.** The capacity planning formula in this section should be part of a formal topic onboarding process. Before a team can create a production topic with more than 12 partitions or more than 7-day retention, they submit a topic request that includes the throughput requirement, message size, retention period, and consumer group count. The platform team runs the capacity formula, checks available broker headroom, and either approves or requests broker expansion. Without this process, clusters fill up when three teams simultaneously increase throughput for a product launch.

**Partition reassignment under load.** When broker disk fills up or a broker is decommissioned, partitions must be reassigned to other brokers. This is a data movement operation that generates significant replication traffic. At FAANG scale, uncontrolled partition reassignment can saturate the replication network and cause ISR shrinks for partitions that are not being moved. Use `kafka-reassign-partitions.sh --throttle` to limit replication bandwidth during reassignment. A throttle of 50 MB/s per broker is a safe default for most clusters during business hours, with higher limits acceptable during maintenance windows.

**Cruise Control for automated cluster rebalancing.** LinkedIn's open-source Cruise Control continuously monitors partition distribution, replication traffic, and broker disk usage, and automatically triggers partition reassignments to keep the cluster balanced. At FAANG scale, manual rebalancing is not feasible: a cluster with 50 brokers and 50,000 partitions requires automated tooling to maintain balance as brokers are added or replaced. Cruise Control is the standard tool for this. The platform team owns the Cruise Control configuration and reviews any automated rebalancing decisions before they execute in production.

**Broker rolling restart protocol.** Restarting a broker without triggering unnecessary ISR shrinks or leader elections requires: (1) set `controlled.shutdown.enable=true` so the broker transfers leadership before stopping, (2) wait for all partitions to be reassigned before killing the process (`kafka-leader-election.sh --type preferred` to restore preferred leaders), (3) verify ISR count is fully restored before proceeding to the next broker. Skipping any of these steps during a rolling restart can leave the cluster degraded. Write a runbook for broker rolling restarts and include automated verification steps.

**SLO definition for the Kafka platform.** The platform team should own explicit SLOs: producer latency p99 below X ms, consumer lag below Y messages for critical consumer groups, zero offline partitions at steady state, and cluster availability (fraction of time all brokers are healthy) above 99.9%. These SLOs drive alert thresholds, capacity planning decisions, and the priority of platform engineering work. Without explicit SLOs, every incident is a surprise and every capacity decision is ad hoc.

---
