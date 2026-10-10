## 49.1 Event-Driven Concepts

### Understanding Events

An event is an immutable record of something that has already happened, modeled in Go as a struct with a stable type identifier, a UUID for idempotency tracking, and a timestamp. Embedding metadata alongside the domain payload in the same struct ensures every consumer receives everything it needs to deduplicate, route, and audit the message without additional round-trips. Using `json.RawMessage` for the payload field lets the envelope stay generic while each event type is deserialized only by consumers that understand it.

```go
// pkg/events/types.go
package events

import (
	"encoding/json"
	"time"
	"uuid"
)

// Event represents a domain event
type Event struct {
	ID            string            `json:"id"`
	Type          string            `json:"type"`
	Source        string            `json:"source"`
	Subject       string            `json:"subject,omitempty"`
	Time          time.Time         `json:"time"`
	DataVersion   string            `json:"data_version"`
	Data          json.RawMessage   `json:"data"`
	Metadata      map[string]string `json:"metadata,omitempty"`
	CorrelationID string            `json:"correlation_id,omitempty"`
	CausationID   string            `json:"causation_id,omitempty"`
}

// EventType constants
const (
	// Domain Events - represent business facts
	EventTypeOrderCreated     = "order.created"
	EventTypeOrderConfirmed   = "order.confirmed"
	EventTypeOrderShipped     = "order.shipped"
	EventTypeOrderDelivered   = "order.delivered"
	EventTypeOrderCanceled   = "order.canceled"

	EventTypePaymentReceived  = "payment.received"
	EventTypePaymentFailed    = "payment.failed"
	EventTypePaymentRefunded  = "payment.refunded"

	EventTypeInventoryReserved   = "inventory.reserved"
	EventTypeInventoryReleased   = "inventory.released"
	EventTypeInventoryDepleted   = "inventory.depleted"

	EventTypeUserRegistered   = "user.registered"
	EventTypeUserUpdated      = "user.updated"
	EventTypeUserDeleted      = "user.deleted"
)

// NewEvent creates a new event with proper defaults
func NewEvent(eventType, source string, data any) (*Event, error) {
	dataBytes, err := json.Marshal(data)
	if err != nil {
		return nil, err
	}

	return &Event{
		ID:          uuid.New().String(),
		Type:        eventType,
		Source:      source,
		Time:        time.Now().UTC(),
		DataVersion: "1.0",
		Data:        dataBytes,
		Metadata:    make(map[string]string),
	}, nil
}

// WithCorrelation adds correlation and causation IDs for tracing
func (e *Event) WithCorrelation(correlationID, causationID string) *Event {
	e.CorrelationID = correlationID
	e.CausationID = causationID
	return e
}

// WithMetadata adds metadata to the event
func (e *Event) WithMetadata(key, value string) *Event {
	if e.Metadata == nil {
		e.Metadata = make(map[string]string)
	}
	e.Metadata[key] = value
	return e
}

// DecodeData unmarshals the event data into the given target
func (e *Event) DecodeData(target any) error {
	return json.Unmarshal(e.Data, target)
}
```

### Event vs Command

Commands and events differ in intent and ownership: a command is a request directed at a specific service that may be rejected, while an event is a broadcast fact that no service can undo. In Go, this distinction maps to separate type hierarchies. Commands carry a target service and a correlation ID for the response, while events carry only a source and a version. Conflating the two leads to brittle contracts where consumers mutate shared state based on what should be read-only notifications.

```go
// pkg/events/command.go
package events

import (
	"encoding/json"
	"time"
	"uuid"
)

// Command represents an intent to change state
// Commands are imperative and may be rejected
type Command struct {
	ID            string            `json:"id"`
	Type          string            `json:"type"`
	Source        string            `json:"source"`
	Time          time.Time         `json:"time"`
	Data          json.RawMessage   `json:"data"`
	CorrelationID string            `json:"correlation_id,omitempty"`
	Metadata      map[string]string `json:"metadata,omitempty"`
}

// CommandType constants
const (
	// Commands are imperative - they may succeed or fail
	CommandCreateOrder   = "order.create"
	CommandCancelOrder   = "order.cancel"
	CommandProcessPayment = "payment.process"
	CommandReserveInventory = "inventory.reserve"
	CommandShipOrder     = "order.ship"
)

// NewCommand creates a new command
func NewCommand(commandType, source string, data any) (*Command, error) {
	dataBytes, err := json.Marshal(data)
	if err != nil {
		return nil, err
	}

	return &Command{
		ID:            uuid.New().String(),
		Type:          commandType,
		Source:        source,
		Time:          time.Now().UTC(),
		Data:          dataBytes,
		CorrelationID: uuid.New().String(),
		Metadata:      make(map[string]string),
	}, nil
}

// Key differences between Events and Commands:
//
// Events:
// - Past tense: "OrderCreated", "PaymentProcessed"
// - Facts that have happened - cannot be rejected
// - Multiple consumers can react
// - Producers don't know about consumers
//
// Commands:
// - Imperative: "CreateOrder", "ProcessPayment"
// - Requests that may be rejected
// - Usually single handler
// - Caller expects acknowledgment
```

### Event Envelope and Versioning

An event envelope wraps every domain payload in a versioned container so that consumers can inspect the schema version before attempting deserialization, enabling rolling upgrades where old and new consumers read from the same topic simultaneously. The `Version` field in the envelope triggers the correct unmarshaling path, and older consumers can safely skip or log-and-discard messages with unrecognized versions rather than panicking. This pattern is the minimum viable contract for evolving event schemas in a system where producers and consumers deploy independently.

```go
// pkg/events/envelope.go
package events

import (
	"encoding/json"
	"fmt"
)

// EventEnvelope wraps events for transport
type EventEnvelope struct {
	SchemaVersion string          `json:"schema_version"`
	EventType     string          `json:"event_type"`
	EventVersion  string          `json:"event_version"`
	Payload       json.RawMessage `json:"payload"`
}

// EventRegistry manages event schemas and versioning
type EventRegistry struct {
	schemas   map[string]map[string]EventSchema
	upgraders map[string]EventUpgrader
}

// EventSchema defines the structure of an event
type EventSchema struct {
	Version    string
	Fields     []SchemaField
	Validator  func(data json.RawMessage) error
}

// SchemaField represents a field in an event schema
type SchemaField struct {
	Name     string
	Type     string
	Required bool
}

// EventUpgrader upgrades events from one version to another
type EventUpgrader func(oldData json.RawMessage) (json.RawMessage, error)

// NewEventRegistry creates a new event registry
func NewEventRegistry() *EventRegistry {
	return &EventRegistry{
		schemas:   make(map[string]map[string]EventSchema),
		upgraders: make(map[string]EventUpgrader),
	}
}

// RegisterSchema registers an event schema
func (r *EventRegistry) RegisterSchema(eventType, version string, schema EventSchema) {
	if r.schemas[eventType] == nil {
		r.schemas[eventType] = make(map[string]EventSchema)
	}
	r.schemas[eventType][version] = schema
}

// RegisterUpgrader registers an upgrader for migrating between versions
func (r *EventRegistry) RegisterUpgrader(eventType, fromVersion, toVersion string, upgrader EventUpgrader) {
	key := fmt.Sprintf("%s:%s->%s", eventType, fromVersion, toVersion)
	r.upgraders[key] = upgrader
}

// Upgrade upgrades an event to the latest version
func (r *EventRegistry) Upgrade(eventType, currentVersion string, data json.RawMessage) (json.RawMessage, string, error) {
	versions := r.getVersionChain(eventType, currentVersion)

	current := data
	var err error

	for i := 0; i < len(versions)-1; i++ {
		key := fmt.Sprintf("%s:%s->%s", eventType, versions[i], versions[i+1])
		upgrader, exists := r.upgraders[key]
		if !exists {
			return nil, "", fmt.Errorf("no upgrader for %s", key)
		}

		current, err = upgrader(current)
		if err != nil {
			return nil, "", fmt.Errorf("upgrade %s failed: %w", key, err)
		}
	}

	return current, versions[len(versions)-1], nil
}

func (r *EventRegistry) getVersionChain(eventType, fromVersion string) []string {
	// Simple version chain - in production, use semver
	versions := []string{"1.0", "1.1", "2.0"}

	startIdx := 0
	for i, v := range versions {
		if v == fromVersion {
			startIdx = i
			break
		}
	}

	return versions[startIdx:]
}

// Example: Upgrading OrderCreated event from v1 to v2
func SetupOrderEventUpgraders(registry *EventRegistry) {
	// v1.0 -> v1.1: Added customer_email field
	registry.RegisterUpgrader(
		EventTypeOrderCreated, "1.0", "1.1",
		func(oldData json.RawMessage) (json.RawMessage, error) {
			var old struct {
				OrderID    string  `json:"order_id"`
				CustomerID string  `json:"customer_id"`
				TotalCents int64  `json:"total_cents"`
			}

			if err := json.Unmarshal(oldData, &old); err != nil {
				return nil, err
			}

			// Add new field with default
			newData := struct {
				OrderID       string  `json:"order_id"`
				CustomerID    string  `json:"customer_id"`
				CustomerEmail string  `json:"customer_email"`
				TotalCents    int64  `json:"total_cents"`
			}{
				OrderID:       old.OrderID,
				CustomerID:    old.CustomerID,
				CustomerEmail: "", // Default for migrated events
				TotalCents:    old.TotalCents,
			}

			return json.Marshal(newData)
		},
	)

	// v1.1 -> v2.0: Split total into subtotal and tax
	registry.RegisterUpgrader(
		EventTypeOrderCreated, "1.1", "2.0",
		func(oldData json.RawMessage) (json.RawMessage, error) {
			var old struct {
				OrderID       string  `json:"order_id"`
				CustomerID    string  `json:"customer_id"`
				CustomerEmail string  `json:"customer_email"`
				TotalCents    int64  `json:"total_cents"`
			}

			if err := json.Unmarshal(oldData, &old); err != nil {
				return nil, err
			}

			// Estimate tax (in reality, you'd need historical data).
			// Integer math: derive tax by rounding half up, then subtotal by
			// subtraction so the parts always sum to the total.
			estimatedTaxCents := (old.TotalCents*8 + 50) / 100
			subtotalCents := old.TotalCents - estimatedTaxCents

			newData := struct {
				OrderID       string  `json:"order_id"`
				CustomerID    string  `json:"customer_id"`
				CustomerEmail string  `json:"customer_email"`
				SubtotalCents int64  `json:"subtotal_cents"`
				TaxCents      int64  `json:"tax_cents"`
				TotalCents    int64  `json:"total_cents"`
			}{
				OrderID:       old.OrderID,
				CustomerID:    old.CustomerID,
				CustomerEmail: old.CustomerEmail,
				SubtotalCents: subtotalCents,
				TaxCents:      estimatedTaxCents,
				TotalCents:    old.TotalCents,
			}

			return json.Marshal(newData)
		},
	)
}
```

### Junior → FAANG: Getting the Event vs Command Distinction Right

The event-vs-command distinction is one of the most common sources of confusion for engineers new to EDA, and it surfaces in design reviews and interviews alike. Here is the practical test: if a service sends a message and cares whether it is accepted or rejected, it is a command. If it sends a message and does not care who reacts or whether anyone reacts at all, it is an event.

The naming convention enforces this: events are past tense ("OrderCreated", "PaymentReceived") because they describe something that already happened and cannot be undone. Commands are imperative ("CreateOrder", "ProcessPayment") because they are requests that the target service may decline. Getting naming wrong is not just a style issue. It causes bugs when developers treat an event as a command (trying to "reject" it) or treat a command as an event (publishing it to many consumers who all try to handle it and collide).

**The `json.RawMessage` pattern.** The `Event` struct in this section uses `json.RawMessage` for the `Data` field. This is the correct approach for a generic event envelope because it defers deserialization to the consumer, which knows the concrete type. The alternative, using `any` and casting, loses type safety. A common first-job mistake is to put the concrete domain struct directly in the envelope, which forces every consumer to import the producer's domain package and creates the tight coupling EDA is designed to avoid.

**Versioning from day one.** The `DataVersion` field in `NewEvent` defaults to `"1.0"`. Fill this in from the very first commit. Retroactively adding versioning to an event schema after events have been persisted requires either a migration (touching immutable historical data) or accepting that old events will forever be version-less. Neither is pleasant. The `EventRegistry` and upgrader pattern here is the right long-term approach: register a chain of upgraders and let the framework apply them transparently.

**Interview habit.** When sketching an event-driven design on a whiteboard, label each arrow as either "event" or "command" and explain the naming choice. Interviewers at FAANG companies will probe this distinction to see whether you have thought about contracts and ownership.

### Senior @ FAANG: Event Schema Governance as a Platform Concern

The `EventRegistry` in this section is a correct application-level abstraction, but at platform scale the registry is not something each service team implements independently. It is a shared service with an API.

**Schema registry as organizational infrastructure.** Confluent Schema Registry and Apicurio Registry both provide HTTP APIs for registering, looking up, and validating schemas. The key feature is compatibility enforcement: when a producer publishes a new schema version, the registry checks it against the registered compatibility mode (BACKWARD, FORWARD, FULL, NONE) and rejects incompatible changes before any production message is published. This moves schema breakage detection from "consumer crashes at 3 AM" to "CI pipeline fails on the producer's pull request." At L6/L7 you advocate for making schema registration and compatibility checking a required step in the CI pipeline for any service that publishes events.

**The upcaster placement question.** The `EventUpgrader` in this section applies upgrades at the event store level. An alternative is to apply upgrades in the consumer. The event store approach is better for event sourcing systems where you want aggregates to always replay using the latest schema. The consumer approach is better for pure messaging systems where the event store is the broker (Kafka) and you cannot rewrite historical messages. Document this decision in an ADR: where upcasting lives determines who is responsible for maintaining upgrade chains and for how long.

**Field deletion is never safe, field renaming is never safe.** These rules feel obvious but are violated constantly. When a field is deleted, consumers that read it receive a zero value silently, which may look like valid data. When a field is renamed, consumers that read the old name receive zero values and producers that write the old name have their data silently dropped. The only safe operations are: add a new optional field with a default value, or deprecate an old field by documenting it as ignored and removing it only after a consumer census confirms no active consumer reads it. Automate the census by tracking field access in deserialization with a custom unmarshaler that logs which fields are read, aggregated in your observability platform.

**CorrelationID and CausationID in distributed tracing.** The `Event` struct includes both `CorrelationID` and `CausationID`. These fields are underused in most implementations. `CorrelationID` should be the same across all events and commands in a single business transaction (a user pressing "Place Order" generates a correlation ID that propagates through OrderCreated, InventoryReserved, PaymentProcessed, and every downstream event). `CausationID` is the ID of the specific event or command that caused this one. Together they allow you to reconstruct the causal graph of a distributed transaction in your observability platform, which is invaluable for debugging production incidents in event-driven systems.

---
