// pkg/ingestion/statsd/receiver.go
package statsd

import (
	"bufio"
	"context"
	"fmt"
	"net"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/example/observability-platform/pkg/models"
	"github.com/example/observability-platform/pkg/pipeline"
)

// Receiver receives StatsD metrics
type Receiver struct {
	udpAddr  string
	tcpAddr  string
	pipeline *pipeline.Pipeline

	udpConn     *net.UDPConn
	tcpListener net.Listener

	mu      sync.RWMutex
	running bool
	stopCh  chan struct{}
	wg      sync.WaitGroup
}

// NewReceiver creates a new StatsD receiver
func NewReceiver(udpAddr, tcpAddr string, pipeline *pipeline.Pipeline) *Receiver {
	return &Receiver{
		udpAddr:  udpAddr,
		tcpAddr:  tcpAddr,
		pipeline: pipeline,
	}
}

// Start starts the StatsD receiver
func (r *Receiver) Start(ctx context.Context) error {
	r.mu.Lock()
	defer r.mu.Unlock()

	if r.running {
		return fmt.Errorf("receiver already running")
	}

	r.stopCh = make(chan struct{})

	// Start UDP listener
	if r.udpAddr != "" {
		if err := r.startUDP(); err != nil {
			return fmt.Errorf("starting UDP listener: %w", err)
		}
	}

	// Start TCP listener
	if r.tcpAddr != "" {
		if err := r.startTCP(); err != nil {
			r.stopUDP()
			return fmt.Errorf("starting TCP listener: %w", err)
		}
	}

	r.running = true
	return nil
}

// startUDP starts UDP listener
func (r *Receiver) startUDP() error {
	addr, err := net.ResolveUDPAddr("udp", r.udpAddr)
	if err != nil {
		return err
	}

	conn, err := net.ListenUDP("udp", addr)
	if err != nil {
		return err
	}

	r.udpConn = conn

	r.wg.Add(1)
	go r.handleUDP()

	return nil
}

// handleUDP handles UDP packets
func (r *Receiver) handleUDP() {
	defer r.wg.Done()

	buf := make([]byte, 65536)

	for {
		select {
		case <-r.stopCh:
			return
		default:
		}

		n, _, err := r.udpConn.ReadFrom(buf)
		if err != nil {
			continue
		}

		// Parse and process metrics
		metrics := r.parseMetrics(buf[:n])
		for _, metric := range metrics {
			r.pipeline.ProcessMetric(context.Background(), metric)
		}
	}
}

// startTCP starts TCP listener
func (r *Receiver) startTCP() error {
	listener, err := net.Listen("tcp", r.tcpAddr)
	if err != nil {
		return err
	}

	r.tcpListener = listener

	r.wg.Add(1)
	go r.acceptTCP()

	return nil
}

// acceptTCP accepts TCP connections
func (r *Receiver) acceptTCP() {
	defer r.wg.Done()

	for {
		conn, err := r.tcpListener.Accept()
		if err != nil {
			select {
			case <-r.stopCh:
				return
			default:
				continue
			}
		}

		r.wg.Add(1)
		go r.handleTCPConn(conn)
	}
}

// handleTCPConn handles a TCP connection
func (r *Receiver) handleTCPConn(conn net.Conn) {
	defer r.wg.Done()
	defer conn.Close()

	scanner := bufio.NewScanner(conn)

	for scanner.Scan() {
		metrics := r.parseMetrics(scanner.Bytes())
		for _, metric := range metrics {
			r.pipeline.ProcessMetric(context.Background(), metric)
		}
	}
}

// parseMetrics parses StatsD metrics from data
func (r *Receiver) parseMetrics(data []byte) []*models.Metric {
	var metrics []*models.Metric

	lines := strings.SplitSeq(string(data), "\n")
	for line := range lines {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}

		metric := r.parseMetric(line)
		if metric != nil {
			metrics = append(metrics, metric)
		}
	}

	return metrics
}

// parseMetric parses a single StatsD metric
// Format: <metric_name>:<value>|<type>[|@<sample_rate>][|#<tags>]
func (r *Receiver) parseMetric(line string) *models.Metric {
	// Split by pipe
	parts := strings.Split(line, "|")
	if len(parts) < 2 {
		return nil
	}

	// Parse name and value
	nameValue := strings.SplitN(parts[0], ":", 2)
	if len(nameValue) != 2 {
		return nil
	}

	name := nameValue[0]
	value, err := strconv.ParseFloat(nameValue[1], 64)
	if err != nil {
		return nil
	}

	metricType := parts[1]

	metric := &models.Metric{
		Name:      name,
		Timestamp: time.Now(),
		Value:     value,
		Labels:    make(models.Labels, 0),
	}

	// Determine metric type
	switch metricType {
	case "g": // Gauge
		metric.Type = models.MetricTypeGauge
	case "c": // Counter
		metric.Type = models.MetricTypeCounter
	case "ms", "h": // Timer/Histogram
		metric.Type = models.MetricTypeHistogram
	case "s": // Set (treat as gauge)
		metric.Type = models.MetricTypeGauge
	default:
		return nil
	}

	// Parse optional components
	for i := 2; i < len(parts); i++ {
		part := parts[i]

		if after, ok := strings.CutPrefix(part, "@"); ok {
			// Sample rate
			rateStr := after
			rate, err := strconv.ParseFloat(rateStr, 64)
			if err == nil && rate > 0 && rate < 1 {
				// Adjust value for sampling
				metric.Value = metric.Value / rate
			}
		} else if after, ok := strings.CutPrefix(part, "#"); ok {
			// Tags
			tagsStr := after
			tags := strings.SplitSeq(tagsStr, ",")
			for tag := range tags {
				kv := strings.SplitN(tag, ":", 2)
				if len(kv) == 2 {
					metric.Labels = append(metric.Labels, models.Label{
						Name:  kv[0],
						Value: kv[1],
					})
				}
			}
		}
	}

	return metric
}

// Stop stops the receiver
func (r *Receiver) Stop(ctx context.Context) error {
	r.mu.Lock()
	if !r.running {
		r.mu.Unlock()
		return nil
	}
	r.running = false
	close(r.stopCh)
	r.mu.Unlock()

	r.stopUDP()
	r.stopTCP()

	r.wg.Wait()
	return nil
}

// stopUDP stops UDP listener
func (r *Receiver) stopUDP() {
	if r.udpConn != nil {
		r.udpConn.Close()
	}
}

// stopTCP stops TCP listener
func (r *Receiver) stopTCP() {
	if r.tcpListener != nil {
		r.tcpListener.Close()
	}
}
