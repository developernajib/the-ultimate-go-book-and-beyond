## Deep Dive: Agent-Side Pre-Aggregation

Before metrics even leave the host, the agent performs local pre-aggregation to reduce network bandwidth. Rather than sending every individual measurement to the ingest service, the agent collects raw samples over a configurable interval (typically 10 seconds), computes summary statistics (average, min, max, P95, count), and sends only those summaries. This means a host reporting 100 raw measurements per second transmits just 5 aggregated data points per metric every 10 seconds, dramatically reducing the load on the central ingestion pipeline.

```go
package agent

import (
	"bytes"
	"encoding/json"
	"fmt"
	"log"
	"math"
	"net/http"
	"slices"
	"sync"
	"time"
)

type MetricsAgent struct {
	endpoint      string
	agentID       string
	collectors    []Collector
	buffer        map[string]*AggBuf
	mu            sync.Mutex
	flushInterval time.Duration
}

type AggBuf struct {
	Name   string
	Tags   map[string]string
	Values []float64
	Min    float64
	Max    float64
	Sum    float64
	Count  int
}

func (a *MetricsAgent) CollectAndFlush() {
	collect := time.NewTicker(time.Second) // sample collectors every second
	flush := time.NewTicker(a.flushInterval)
	defer collect.Stop()
	defer flush.Stop()
	for {
		select {
		case <-collect.C:
			a.collect()
		case <-flush.C:
			a.flush()
		}
	}
}

func (a *MetricsAgent) collect() {
	a.mu.Lock()
	defer a.mu.Unlock()
	for _, c := range a.collectors {
		for _, p := range c.Collect() {
			key := metricKey(p.Name, p.Tags)
			buf, ok := a.buffer[key]
			if !ok {
				buf = &AggBuf{Name: p.Name, Tags: p.Tags, Min: math.MaxFloat64, Max: -math.MaxFloat64}
				a.buffer[key] = buf
			}
			buf.Values = append(buf.Values, p.Value)
			buf.Sum += p.Value
			buf.Count++
			if p.Value < buf.Min {
				buf.Min = p.Value
			}
			if p.Value > buf.Max {
				buf.Max = p.Value
			}
		}
	}
}

func (a *MetricsAgent) flush() {
	a.mu.Lock()
	bufs := a.buffer
	a.buffer = make(map[string]*AggBuf)
	a.mu.Unlock()

	if len(bufs) == 0 {
		return
	}

	now := time.Now().UnixMilli()
	var metrics []MetricPoint
	for _, b := range bufs {
		avg := b.Sum / float64(b.Count)
		p95 := percentile(b.Values, 0.95)
		metrics = append(metrics,
			MetricPoint{Name: b.Name + ".avg", Tags: b.Tags, Value: avg, Timestamp: now},
			MetricPoint{Name: b.Name + ".min", Tags: b.Tags, Value: b.Min, Timestamp: now},
			MetricPoint{Name: b.Name + ".max", Tags: b.Tags, Value: b.Max, Timestamp: now},
			MetricPoint{Name: b.Name + ".p95", Tags: b.Tags, Value: p95, Timestamp: now},
			MetricPoint{Name: b.Name + ".count", Tags: b.Tags, Value: float64(b.Count), Timestamp: now})
	}

	body, err := json.Marshal(map[string]any{"agent_id": a.agentID, "metrics": metrics})
	if err != nil {
		return
	}
	resp, err := http.Post(a.endpoint+"/api/v1/metrics", "application/json", bytes.NewReader(body))
	if err != nil {
		log.Printf("metric flush failed: %v", err)
		return
	}
	resp.Body.Close()
}

func percentile(v []float64, p float64) float64 {
	if len(v) == 0 {
		return 0
	}
	s := make([]float64, len(v))
	copy(s, v)
	slices.Sort(s)
	idx := int(math.Ceil(p*float64(len(s)))) - 1
	if idx < 0 {
		idx = 0
	}
	if idx >= len(s) {
		idx = len(s) - 1
	}
	return s[idx]
}

func metricKey(name string, tags map[string]string) string {
	keys := make([]string, 0, len(tags))
	for k := range tags {
		keys = append(keys, k)
	}
	slices.Sort(keys)
	r := name
	for _, k := range keys {
		r += fmt.Sprintf(",%s=%s", k, tags[k])
	}
	return r
}

type Collector interface {
	Collect() []MetricPoint
}

type MetricPoint struct {
	Name      string
	Tags      map[string]string
	Value     float64
	Timestamp int64
}
```

---
