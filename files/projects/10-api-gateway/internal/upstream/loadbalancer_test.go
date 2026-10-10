// internal/upstream/loadbalancer_test.go
package upstream

import (
	"context"
	"testing"
)

func TestRoundRobinBalancer(t *testing.T) {
	targets := []*Target{
		{ID: "t1", Host: "host1", Port: 8080, Weight: 100},
		{ID: "t2", Host: "host2", Port: 8080, Weight: 100},
		{ID: "t3", Host: "host3", Port: 8080, Weight: 100},
	}

	// Wrap targets with health status
	for _, target := range targets {
		target.Metadata = map[string]string{"healthy": "true"}
	}

	lb := NewRoundRobinBalancer()
	ctx := context.Background()

	// Test round-robin distribution
	selected := make(map[string]int)
	for range 9 {
		target, err := lb.Select(ctx, targets)
		if err != nil {
			t.Fatal(err)
		}
		selected[target.ID]++
	}

	// Each target should be selected 3 times
	for id, count := range selected {
		if count != 3 {
			t.Errorf("Target %s selected %d times, expected 3", id, count)
		}
	}
}

func TestWeightedRandomBalancer(t *testing.T) {
	targets := []*Target{
		{ID: "t1", Host: "host1", Port: 8080, Weight: 50},
		{ID: "t2", Host: "host2", Port: 8080, Weight: 30},
		{ID: "t3", Host: "host3", Port: 8080, Weight: 20},
	}

	for _, target := range targets {
		target.Metadata = map[string]string{"healthy": "true"}
	}

	lb := NewWeightedRandomBalancer()
	ctx := context.Background()

	// Test weighted distribution
	selected := make(map[string]int)
	iterations := 10000

	for range iterations {
		target, err := lb.Select(ctx, targets)
		if err != nil {
			t.Fatal(err)
		}
		selected[target.ID]++
	}

	// Check approximate distribution
	t1Percent := float64(selected["t1"]) / float64(iterations)
	t2Percent := float64(selected["t2"]) / float64(iterations)
	t3Percent := float64(selected["t3"]) / float64(iterations)

	if t1Percent < 0.45 || t1Percent > 0.55 {
		t.Errorf("t1 selected %.2f%%, expected ~50%%", t1Percent*100)
	}
	if t2Percent < 0.25 || t2Percent > 0.35 {
		t.Errorf("t2 selected %.2f%%, expected ~30%%", t2Percent*100)
	}
	if t3Percent < 0.15 || t3Percent > 0.25 {
		t.Errorf("t3 selected %.2f%%, expected ~20%%", t3Percent*100)
	}
}
