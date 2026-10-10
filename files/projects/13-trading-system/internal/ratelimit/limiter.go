// internal/ratelimit/limiter.go
package ratelimit

import (
	"context"

	"golang.org/x/time/rate"
)

// Limiter implements token bucket rate limiting
type Limiter struct {
	limiter *rate.Limiter
}

// NewLimiter creates a rate limiter
func NewLimiter(requestsPerSecond float64, burst int) *Limiter {
	return &Limiter{
		limiter: rate.NewLimiter(rate.Limit(requestsPerSecond), burst),
	}
}

// Allow checks if a request is allowed
func (l *Limiter) Allow() bool {
	return l.limiter.Allow()
}

// Wait waits for permission to proceed
func (l *Limiter) Wait(ctx context.Context) error {
	return l.limiter.Wait(ctx)
}

// Reserve reserves capacity for a request
func (l *Limiter) Reserve() *rate.Reservation {
	return l.limiter.Reserve()
}

// SetLimit updates the rate limit
func (l *Limiter) SetLimit(requestsPerSecond float64) {
	l.limiter.SetLimit(rate.Limit(requestsPerSecond))
}

// SetBurst updates the burst size
func (l *Limiter) SetBurst(burst int) {
	l.limiter.SetBurst(burst)
}
