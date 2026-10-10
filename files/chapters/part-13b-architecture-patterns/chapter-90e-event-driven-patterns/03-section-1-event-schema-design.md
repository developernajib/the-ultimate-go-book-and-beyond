## 90E.2 Event Schema Design

A well-designed event schema is a contract between producers and consumers that must survive independently deployed services evolving at different speeds. Adopting the CloudEvents specification gives every event a standard envelope (source, type, ID, and timestamp) that tools, routers, and logging infrastructure can process without knowing the domain payload. Versioning event types using a reverse-DNS convention (for example `com.example.order.created.v2`) allows consumers to opt into new schemas while legacy consumers continue handling the old ones. The upcaster pattern shown below bridges the gap. It translates a V1 event into V2 automatically so that all consumers can be written against a single canonical schema over time.

```go
package events

import (
	"encoding/json"
	"fmt"
	"time"
)

// CloudEvent follows the CloudEvents spec (https://cloudevents.io)
type CloudEvent struct {
	// Required fields
	SpecVersion string `json:"specversion"` // "1.0"
	ID          string `json:"id"`          // UUID
	Source      string `json:"source"`      // URI (e.g., "/orders/service")
	Type        string `json:"type"`        // Reverse-DNS (e.g., "com.example.order.created")
	Time        time.Time `json:"time"`

	// Optional fields
	Subject     string `json:"subject,omitempty"`    // Specific resource
	DataSchema  string `json:"dataschema,omitempty"` // Schema URL
	ContentType string `json:"datacontenttype,omitempty"`

	// Payload
	Data json.RawMessage `json:"data"`
}

func NewCloudEvent(source, eventType string, data any) (*CloudEvent, error) {
	payload, err := json.Marshal(data)
	if err != nil {
		return nil, err
	}

	return &CloudEvent{
		SpecVersion: "1.0",
		ID:          generateEventID(),
		Source:      source,
		Type:        eventType,
		Time:        time.Now().UTC(),
		ContentType: "application/json",
		Data:        payload,
	}, nil
}

// EventRegistry maps event type strings to Go types
type EventRegistry struct {
	types map[string]func() any
}

func NewEventRegistry() *EventRegistry {
	return &EventRegistry{types: make(map[string]func() any)}
}

func (r *EventRegistry) Register(eventType string, factory func() any) {
	r.types[eventType] = factory
}

func (r *EventRegistry) Decode(event CloudEvent) (any, error) {
	factory, ok := r.types[event.Type]
	if !ok {
		return nil, fmt.Errorf("unknown event type: %s", event.Type)
	}

	payload := factory()
	if err := json.Unmarshal(event.Data, payload); err != nil {
		return nil, fmt.Errorf("decode %s: %w", event.Type, err)
	}
	return payload, nil
}

// ─── Event Versioning ───

// Versioned event type naming convention:
// com.example.order.created.v1
// com.example.order.created.v2

// OrderCreatedV1 - original version
type OrderCreatedV1 struct {
	OrderID    string `json:"order_id"`
	CustomerID string `json:"customer_id"`
	Total      int64  `json:"total"`
}

// OrderCreatedV2 - adds currency field (backward compatible)
type OrderCreatedV2 struct {
	OrderID    string `json:"order_id"`
	CustomerID string `json:"customer_id"`
	Total      int64  `json:"total"`
	Currency   string `json:"currency"` // NEW
	Items      int    `json:"items"`    // NEW
}

// Upcaster converts V1 events to V2 for consumers that only handle V2
func UpcasterV1ToV2(v1 OrderCreatedV1) OrderCreatedV2 {
	return OrderCreatedV2{
		OrderID:    v1.OrderID,
		CustomerID: v1.CustomerID,
		Total:      v1.Total,
		Currency:   "USD", // Default for old events
		Items:      0,     // Unknown for old events
	}
}

func generateEventID() string {
	return fmt.Sprintf("evt-%d", time.Now().UnixNano())
}
```

---
