## Monitoring & Alerting

### Key Metrics Table

| Metric | Description | Alert Threshold | Dashboard |
|--------|-------------|-----------------|-----------|
| `media.rtt_p99` | Round-trip time for media packets (P99) | > 300ms | Call Quality |
| `media.packet_loss_rate` | Percentage of packets lost | > 5% | Call Quality |
| `media.jitter_ms` | Packet arrival jitter | > 100ms | Call Quality |
| `media.mos_score` | Mean Opinion Score (1-5) | < 3.5 | Call Quality |
| `sfu.active_rooms` | Number of active meeting rooms | > 90% capacity | SFU Capacity |
| `sfu.cpu_usage` | SFU server CPU utilization | > 75% | SFU Capacity |
| `sfu.bandwidth_gbps` | Total bandwidth per SFU node | > 8 Gbps | SFU Capacity |
| `sfu.participants_per_room` | Average participants per room | > 500 | SFU Capacity |
| `turn.active_allocations` | Number of active TURN relay allocations | > 80% capacity | TURN |
| `turn.bytes_relayed` | Total bytes relayed per second | > 5 Gbps | TURN |
| `signaling.ws_connections` | Active WebSocket connections | > 90% capacity | Signaling |
| `signaling.offer_latency_p99` | SDP offer/answer exchange latency | > 2s | Signaling |
| `recording.pipeline_lag` | Recording pipeline delay | > 5s | Recording |
| `recording.storage_usage` | Recording storage consumption rate | > 80% disk | Recording |
| `e2ee.key_exchange_failures` | Failed E2EE key exchanges | > 1% | Security |
| `cdn.cache_hit_rate` | Static asset CDN cache hit rate | < 90% | Infrastructure |

### Dashboard Recommendations

1. **Call Quality Dashboard**: Real-time MOS scores heatmap, packet loss / jitter / RTT per region, bitrate adaptation timeline, participant quality distribution.
2. **SFU Capacity Dashboard**: Active rooms per node, CPU/bandwidth utilization, simulcast layer distribution, cascade link health.
3. **TURN Dashboard**: Active allocations, bytes relayed, allocation success rate, port exhaustion warnings.
4. **Signaling Dashboard**: WebSocket connection count, offer/answer latency, ICE negotiation success rate, reconnection rates.
5. **Regional Dashboard**: Per-PoP quality metrics, inter-region cascade latency, failover events, geographic distribution of users.

### Alerting Rules

These Prometheus alerting rules encode the operational thresholds from the metrics table above into actionable notifications. Each rule uses a `for` duration to suppress transient spikes. The right duration is a judgement about how fast the failure hurts: two minutes of sustained packet loss filters out brief network hiccups without ignoring a real regional problem, five minutes of high CPU is fine because an SFU degrades gradually, but TURN port exhaustion gets 30 seconds because a drained port pool rejects every new allocation immediately. Set the `for` window by how quickly users feel the failure, not by copying one number down the file.

```yaml
groups:
  - name: zoom_critical
    rules:
      - alert: HighPacketLoss
        expr: avg(media_packet_loss_rate) by (region) > 0.05
        for: 2m
        labels:
          severity: critical
        annotations:
          summary: "Packet loss exceeds 5% in {{ $labels.region }}"

      - alert: SFUOverloaded
        expr: sfu_cpu_usage > 0.75
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "SFU CPU usage above 75%, consider scaling"

      - alert: TURNPortExhaustion
        expr: turn_active_allocations / turn_max_allocations > 0.9
        # 30s, not 5m: an exhausted pool rejects new allocations now, and
        # every rejected allocation is a call that never connects.
        for: 30s
        labels:
          severity: critical
        annotations:
          summary: "TURN relay port pool nearly exhausted"

      - alert: SignalingLatencyHigh
        # histogram_quantile needs the _bucket series, a rate() over a
        # window, and a sum by (le). Passing it the bare metric name is a
        # rule that never fires.
        expr: >
          histogram_quantile(0.99,
            sum(rate(signaling_offer_latency_seconds_bucket[5m])) by (le)
          ) > 2
        for: 3m
        labels:
          severity: warning
        annotations:
          summary: "P99 signaling latency exceeds 2 seconds"
```

---
