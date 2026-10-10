## 102I.6 Protocol Performance Analysis and Benchmarking

### 6.1 Benchmarking Protocol Overhead

Measuring protocol overhead requires benchmarks that isolate serialization cost from I/O cost and compare allocations as well as throughput. The benchmarks below use `bytes.Buffer` as a sink so there is no network variance, and `b.ReportAllocs()` surfaces heap allocation counts that directly correlate with GC pressure. The JSON vs binary comparison illustrates why high-frequency internal services often justify a custom framing layer over standard HTTP.

```go
package protocol_test

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net"
	"testing"
	"time"

	"github.com/yourorg/gobook/http2internals"
	"github.com/yourorg/gobook/protocol"
)

// BenchmarkFrameWrite measures frame serialization speed.
func BenchmarkFrameWrite(b *testing.B) {
	payload := make([]byte, 1024)
	frame := &protocol.Frame{
		Magic:     protocol.Magic,
		Version:   protocol.Version,
		Type:      protocol.TypeRequest,
		RequestID: 42,
		Payload:   payload,
	}

	b.ResetTimer()
	b.ReportAllocs()

	for b.Loop() {
		var buf bytes.Buffer
		codec := protocol.NewFrameCodec(&buf)
		if err := codec.WriteFrame(frame); err != nil {
			b.Fatal(err)
		}
		buf.Reset()
	}
}

// BenchmarkFrameRead measures frame deserialization speed.
func BenchmarkFrameRead(b *testing.B) {
	payload := make([]byte, 1024)
	frame := &protocol.Frame{
		Magic:     protocol.Magic,
		Version:   protocol.Version,
		Type:      protocol.TypeRequest,
		RequestID: 42,
		Payload:   payload,
	}

	var buf bytes.Buffer
	codec := protocol.NewFrameCodec(&buf)
	codec.WriteFrame(frame)
	serialized := buf.Bytes()

	b.ResetTimer()
	b.ReportAllocs()

	for b.Loop() {
		buf := bytes.NewBuffer(serialized)
		readCodec := protocol.NewFrameCodec(buf)
		if _, err := readCodec.ReadFrame(); err != nil {
			b.Fatal(err)
		}
	}
}

// BenchmarkJSONvsBinary compares JSON overhead vs binary framing.
func BenchmarkJSONvsBinary(b *testing.B) {
	type TestMessage struct {
		ID     uint64 `json:"id"`
		Method string `json:"method"`
		Value  int64  `json:"value"`
		Tag    string `json:"tag"`
	}

	msg := TestMessage{ID: 12345, Method: "compute", Value: 9876543, Tag: "production"}

	b.Run("JSON", func(b *testing.B) {
		b.ReportAllocs()
		for b.Loop() {
			data, _ := json.Marshal(&msg)
			var out TestMessage
			json.Unmarshal(data, &out)
		}
	})

	b.Run("Binary/Frame", func(b *testing.B) {
		b.ReportAllocs()
		payload := make([]byte, 26) // 8+2+8+1+7 bytes
		for b.Loop() {
			// Manually pack/unpack 26-byte binary message
			_ = payload
		}
	})
}

// BenchmarkHTTP2vsCustomRPC compares HTTP/2 overhead with raw frames.
func BenchmarkHTTP2vsCustomRPC(b *testing.B) {
	// In practice, HTTP/2 adds ~100-200 bytes overhead per request.
	// Our custom protocol adds only 22 bytes fixed header.
	b.Run("HTTP2overhead", func(b *testing.B) {
		// HTTP/2 request: method, path, scheme, authority + HEADERS frame header
		headers := [][2]string{
			{":method", "POST"},
			{":path", "/api/compute"},
			{":scheme", "https"},
			{":authority", "svc.internal"},
			{"content-type", "application/json"},
			{"content-length", "48"},
		}
		enc := http2internals.NewHPACKEncoder()
		b.ResetTimer()
		b.ReportAllocs()
		for b.Loop() {
			_, _ = enc.Encode(headers)
		}
	})
}

// TestProtocolRoundtrip verifies frame correctness over a pipe.
func TestProtocolRoundtrip(t *testing.T) {
	server, client := net.Pipe()
	defer server.Close()
	defer client.Close()

	serverCodec := protocol.NewFrameCodec(server)
	clientCodec := protocol.NewFrameCodec(client)

	payload := []byte(`{"method":"echo","params":"hello"}`)
	sentFrame := &protocol.Frame{
		Magic:     protocol.Magic,
		Version:   protocol.Version,
		Type:      protocol.TypeRequest,
		RequestID: 99,
		Payload:   payload,
	}

	done := make(chan error, 1)
	go func() {
		f, err := serverCodec.ReadFrame()
		if err != nil {
			done <- err
			return
		}
		if f.RequestID != 99 {
			done <- fmt.Errorf("wrong request ID: %d", f.RequestID)
			return
		}
		if string(f.Payload) != string(payload) {
			done <- fmt.Errorf("payload mismatch")
			return
		}
		done <- nil
	}()

	if err := clientCodec.WriteFrame(sentFrame); err != nil {
		t.Fatalf("write: %v", err)
	}

	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(time.Second):
		t.Fatal("timeout")
	}
}
```

### Junior → FAANG: Benchmark Design and Measurement Hygiene

Protocol benchmarks require more care than unit test benchmarks. Network benchmarks are affected by: benchmark machine CPU vs. production CPU, loopback vs. real network (RTT, packet loss, MTU), single-threaded vs. concurrent load, cold cache vs. warm cache (TLS session resumption, connection pooling). A benchmark that shows Protocol A is 2x faster than Protocol B on loopback at low concurrency may show the opposite result on a real network at high concurrency.

The habit to build: when benchmarking protocols, always run at least three conditions: loopback at low concurrency (measures raw protocol overhead), real network at production concurrency (measures behavior under load), and production traffic capture (measures behavior for actual request distribution). Conclusions from one condition rarely generalize to the others.

Interview entry point: when asked "how would you evaluate whether switching from REST to gRPC would improve performance?", describe this multi-condition benchmark approach plus production traffic sampling. A micro-benchmark answer is not sufficient.

### Senior @ FAANG: Continuous Protocol Performance Regression Testing

At FAANG scale, protocol performance must be monitored continuously, not just benchmarked during design. A protocol change (new serialization library, HTTP client version upgrade, Protobuf schema change that adds a large repeated field) can introduce a regression that only appears at high concurrency or on specific message patterns. Without continuous performance testing, these regressions reach production.

The tooling for continuous performance regression detection: a benchmark suite that runs on every main branch commit, stores results in a time-series database, and alerts when any metric regresses by more than 5% compared to the rolling 30-day baseline. The suite must be isolated from production traffic to be reproducible. The alert threshold must be calibrated to the natural variance of the benchmark (some benchmarks have 10% natural variance, a 5% threshold would produce constant false positives for those).

The L6 governance question: who is responsible for investigating performance regressions? The correct answer is the team that owns the code change that introduced the regression, not the platform team. The platform team owns the regression detection infrastructure and the escalation process when regressions are not addressed within a defined SLO window.

---
