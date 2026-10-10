// benchmark/bench_test.go
package benchmark

import (
	"fmt"
	"math/rand/v2"
	"sync"
	"testing"
	"time"

	"gocache/client"
	"gocache/internal/server"
)

func BenchmarkSet(b *testing.B) {
	c := client.NewClient("localhost:6379", 100)
	defer c.Close()

	b.ResetTimer()
	b.RunParallel(func(pb *testing.PB) {
		i := 0
		for pb.Next() {
			key := fmt.Sprintf("key:%d", i)
			value := fmt.Appendf(nil, "value:%d", i)
			if err := c.Set(key, value, nil); err != nil {
				b.Fatal(err)
			}
			i++
		}
	})
}

func BenchmarkGet(b *testing.B) {
	c := client.NewClient("localhost:6379", 100)
	defer c.Close()

	// Pre-populate
	for i := range 10000 {
		key := fmt.Sprintf("key:%d", i)
		value := fmt.Appendf(nil, "value:%d", i)
		c.Set(key, value, nil)
	}

	b.ResetTimer()
	b.RunParallel(func(pb *testing.PB) {
		for pb.Next() {
			key := fmt.Sprintf("key:%d", rand.IntN(10000))
			_, err := c.Get(key)
			if err != nil {
				b.Fatal(err)
			}
		}
	})
}

func BenchmarkMixed(b *testing.B) {
	c := client.NewClient("localhost:6379", 100)
	defer c.Close()

	// Pre-populate
	for i := range 10000 {
		key := fmt.Sprintf("key:%d", i)
		value := fmt.Appendf(nil, "value:%d", i)
		c.Set(key, value, nil)
	}

	b.ResetTimer()
	b.RunParallel(func(pb *testing.PB) {
		for pb.Next() {
			if rand.Float32() < 0.8 {
				// 80% reads
				key := fmt.Sprintf("key:%d", rand.IntN(10000))
				c.Get(key)
			} else {
				// 20% writes
				key := fmt.Sprintf("key:%d", rand.IntN(10000))
				value := fmt.Appendf(nil, "value:%d", rand.IntN(10000))
				c.Set(key, value, nil)
			}
		}
	})
}

// Load Test
func TestLoadTest(t *testing.T) {
	srv := server.NewServer(":16389", 100*1024*1024)
	if err := srv.Start(); err != nil {
		t.Fatalf("failed to start test server: %v", err)
	}
	defer srv.Stop()
	time.Sleep(50 * time.Millisecond)

	c := client.NewClient("localhost:16389", 20)
	defer c.Close()

	duration := 2 * time.Second
	if testing.Short() {
		duration = 200 * time.Millisecond
	}
	concurrency := 10

	var (
		ops       int64
		errors    int64
		mu        sync.Mutex
		startTime = time.Now()
		wg        sync.WaitGroup
	)

	done := make(chan struct{})

	for range concurrency {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for {
				select {
				case <-done:
					return
				default:
					key := fmt.Sprintf("key:%d", rand.IntN(10000))

					if rand.Float32() < 0.8 {
						_, err := c.Get(key)
						if err != nil {
							mu.Lock()
							errors++
							mu.Unlock()
						}
					} else {
						value := fmt.Appendf(nil, "value:%d", rand.IntN(10000))
						err := c.Set(key, value, nil)
						if err != nil {
							mu.Lock()
							errors++
							mu.Unlock()
						}
					}

					mu.Lock()
					ops++
					mu.Unlock()
				}
			}
		}()
	}

	time.Sleep(duration)
	close(done)
	wg.Wait()

	mu.Lock()
	finalOps := ops
	finalErrors := errors
	mu.Unlock()

	elapsed := time.Since(startTime)
	opsPerSec := float64(finalOps) / elapsed.Seconds()

	t.Logf("Duration: %v", elapsed)
	t.Logf("Total ops: %d", finalOps)
	t.Logf("Errors: %d", finalErrors)
	t.Logf("Ops/sec: %.2f", opsPerSec)
	if finalOps > 0 {
		t.Logf("Avg latency: %.2fμs", float64(elapsed.Microseconds())/float64(finalOps))
	}
}
