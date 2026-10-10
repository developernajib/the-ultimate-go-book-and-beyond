// pkg/events/events.go
package events

import "time"

// Event represents a domain event
type Event struct {
	ID        string            `json:"id"`
	Type      string            `json:"type"`
	TenantID  string            `json:"tenant_id,omitempty"`
	Payload   map[string]any    `json:"payload"`
	Timestamp time.Time         `json:"timestamp"`
	Metadata  map[string]string `json:"metadata,omitempty"`
}

// Publisher publishes events
type Publisher interface {
	Publish(ctx any, event Event) error
}

// NoOpPublisher is a publisher that does nothing
type NoOpPublisher struct{}

func (n *NoOpPublisher) Publish(_ any, _ Event) error { return nil }
