package circuitbreaker

import (
	"errors"
	"testing"
	"time"
)

func TestCircuitBreaker_ClosedSuccess(t *testing.T) {
	cb := New("test-service", Config{
		MaxRequests: 1,
		Interval:    time.Minute,
		Timeout:     time.Minute,
	})

	err := cb.Execute(func() error {
		return nil
	})
	if err != nil {
		t.Fatalf("expected nil error, got: %v", err)
	}

	if cb.State() != StateClosed {
		t.Errorf("expected closed state, got %v", cb.State())
	}
}

func TestCircuitBreaker_TripsToOpen(t *testing.T) {
	cb := New("test-service", Config{
		MaxRequests: 1,
		Interval:    time.Minute,
		Timeout:     time.Minute,
		ReadyToTrip: func(counts Counts) bool {
			return counts.ConsecutiveFailures >= 2
		},
	})

	failErr := errors.New("backend failure")

	_ = cb.Execute(func() error { return failErr })
	if cb.State() != StateClosed {
		t.Errorf("expected still closed after 1 failure")
	}

	_ = cb.Execute(func() error { return failErr })
	if cb.State() != StateOpen {
		t.Errorf("expected open after 2 failures, got %v", cb.State())
	}

	// Next call should fail immediately with ErrCircuitOpen
	err := cb.Execute(func() error { return nil })
	if !errors.Is(err, ErrCircuitOpen) {
		t.Errorf("expected ErrCircuitOpen, got %v", err)
	}
}
