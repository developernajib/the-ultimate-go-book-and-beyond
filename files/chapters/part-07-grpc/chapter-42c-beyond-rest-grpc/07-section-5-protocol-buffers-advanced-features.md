## Section 5: Protocol Buffers Advanced Features

### 5.1 oneof - Mutually Exclusive Fields

`oneof` prevents illegal state at the schema level: only one field in the group can be set, and the generated code reflects this.

```protobuf
// notification.proto
syntax = "proto3";
package notification.v1;
option go_package = "github.com/example/notification/v1;notificationv1";

message Notification {
  string id = 1;
  string recipient_id = 2;

  // Only one delivery channel can be set per notification.
  oneof channel {
    EmailChannel  email  = 3;
    SMSChannel    sms    = 4;
    PushChannel   push   = 5;
    SlackChannel  slack  = 6;
  }
}

message EmailChannel {
  string to      = 1;
  string subject = 2;
  string body    = 3;
}

message SMSChannel {
  string phone_number = 1;
  string text         = 2;
}

message PushChannel {
  string device_token = 1;
  string title        = 2;
  string body         = 3;
}

message SlackChannel {
  string webhook_url = 1;
  string text        = 2;
}
```

Go usage - type switch on the oneof:

```go
package notification

import (
	"fmt"
	notificationv1 "github.com/example/notification/v1"
)

func route(n *notificationv1.Notification) error {
	switch ch := n.Channel.(type) {
	case *notificationv1.Notification_Email:
		return sendEmail(ch.Email)
	case *notificationv1.Notification_Sms:
		return sendSMS(ch.Sms)
	case *notificationv1.Notification_Push:
		return sendPush(ch.Push)
	case *notificationv1.Notification_Slack:
		return sendSlack(ch.Slack)
	case nil:
		return fmt.Errorf("notification %s: no channel set", n.Id)
	default:
		return fmt.Errorf("notification %s: unknown channel type %T", n.Id, ch)
	}
}
```

### 5.2 Field Masks - Partial Updates

`google.protobuf.FieldMask` is the protobuf equivalent of a PATCH request. It lets callers specify which fields to update without sending the full resource.

```protobuf
// user_service.proto
syntax = "proto3";
import "google/protobuf/field_mask.proto";

service UserService {
  rpc UpdateUser(UpdateUserRequest) returns (User);
}

message UpdateUserRequest {
  string user_id                        = 1;
  User   user                           = 2;
  google.protobuf.FieldMask update_mask = 3; // e.g. "display_name,avatar_url"
}

message User {
  string user_id      = 1;
  string email        = 2;
  string display_name = 3;
  string avatar_url   = 4;
  string phone        = 5;
}
```

Go server-side field mask application using `fieldmaskpb`:

```go
package userservice

import (
	"context"
	"fmt"

	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/reflect/protoreflect"
	"google.golang.org/protobuf/types/known/fieldmaskpb"

	userv1 "github.com/example/user/v1"
)

func (s *UserServer) UpdateUser(ctx context.Context, req *userv1.UpdateUserRequest) (*userv1.User, error) {
	if req.UpdateMask == nil || len(req.UpdateMask.Paths) == 0 {
		return nil, fmt.Errorf("update_mask is required for partial updates")
	}

	// Normalize and validate the field mask.
	req.UpdateMask.Normalize()
	if !req.UpdateMask.IsValid(req.User) {
		return nil, fmt.Errorf("invalid field mask paths: %v", req.UpdateMask.Paths)
	}

	// Load current state from storage.
	existing, err := s.repo.Get(ctx, req.UserId)
	if err != nil {
		return nil, fmt.Errorf("get user: %w", err)
	}

	// Apply only the fields specified in the mask.
	proto.Merge(existing, applyMask(req.User, req.UpdateMask))

	if err := s.repo.Update(ctx, existing); err != nil {
		return nil, fmt.Errorf("update user: %w", err)
	}
	return existing, nil
}

// applyMask returns a proto with only the masked fields populated.
func applyMask(src proto.Message, mask *fieldmaskpb.FieldMask) proto.Message {
	dst := src.ProtoReflect().New().Interface()
	for _, path := range mask.Paths {
		fd := src.ProtoReflect().Descriptor().Fields().ByName(protoreflect.Name(path))
		if fd == nil {
			continue
		}
		dst.ProtoReflect().Set(fd, src.ProtoReflect().Get(fd))
	}
	return dst
}
```

### 5.3 google.protobuf.Any - Dynamic Types

`Any` packs an arbitrary protobuf message into a wire-opaque envelope. Use it when the exact type is determined at runtime - for example, event payloads in an event bus.

```protobuf
// event.proto
syntax = "proto3";
import "google/protobuf/any.proto";

message DomainEvent {
  string event_id   = 1;
  string event_type = 2;
  google.protobuf.Any payload = 3;
}
```

```go
package events

import (
	"fmt"

	"google.golang.org/protobuf/types/known/anypb"
	"google.golang.org/protobuf/proto"

	eventv1  "github.com/example/event/v1"
	orderv1  "github.com/example/order/v1"
)

func packOrderCreated(order *orderv1.CreateOrderResponse) (*eventv1.DomainEvent, error) {
	payload, err := anypb.New(order)
	if err != nil {
		return nil, fmt.Errorf("pack Any: %w", err)
	}
	return &eventv1.DomainEvent{
		EventId:   "evt-001",
		EventType: "order.created",
		Payload:   payload,
	}, nil
}

func unpackEvent(event *eventv1.DomainEvent) (proto.Message, error) {
	msg, err := event.Payload.UnmarshalNew()
	if err != nil {
		return nil, fmt.Errorf("unpack Any: %w", err)
	}

	switch m := msg.(type) {
	case *orderv1.CreateOrderResponse:
		fmt.Printf("Order created: %s, total: %d cents\n", m.OrderId, m.TotalCents)
		return m, nil
	default:
		return nil, fmt.Errorf("unknown event payload type: %T", m)
	}
}
```

### 5.4 Schema Evolution - Backward/Forward Compatibility Rules

Protobuf schema evolution is governed by field number stability: clients and servers compiled against different versions of the proto schema must be able to exchange messages without errors. Adding new fields with previously unused numbers is safe. Renaming fields, changing field types, or reusing field numbers for a different type all break wire compatibility.

```
┌────────────────────────────────────────────────────────────────────┐
│              Protobuf Schema Evolution Rules                       │
│                                                                    │
│  SAFE changes (backward AND forward compatible):                   │
│  ✓ Add a new optional field (new field number)                     │
│  ✓ Add a new enum value                                            │
│  ✓ Add a new RPC method                                            │
│  ✓ Rename a field (field number is identity, not name)             │
│                                                                    │
│  UNSAFE changes (will break at least one direction):               │
│  ✗ Change a field number                                           │
│  ✗ Change a field type (int32→int64 may work; int32→string won't)  │
│  ✗ Change a field from optional to repeated (or vice versa)        │
│  ✗ Remove a required field (proto2)                                │
│  ✗ Reuse a deleted field number (use `reserved` instead)           │
│                                                                    │
│  Best practices:                                                   │
│  • Reserve deleted field numbers: reserved 5, 7, 10 to 15;         │
│  • Reserve deleted field names:  reserved "old_name";              │
│  • Use buf lint to enforce compatibility automatically             │
│  • Version your package: package order.v1 → order.v2               │
└────────────────────────────────────────────────────────────────────┘
```

Reserved fields in proto prevent accidental field number reuse:

```protobuf
message Product {
  reserved 4, 8 to 12;        // deleted field numbers - never reuse
  reserved "old_price_usd";   // deleted field name

  string id          = 1;
  string name        = 2;
  string description = 3;
  int64  price_cents = 5;
  bool   in_stock    = 6;
}
```

### 5.5 Protobuf Editions (the successor to proto2/proto3 syntax)

Since 2024 Protocol Buffers have been transitioning from the `syntax = "proto2"` / `syntax = "proto3"` dichotomy to **Editions**. Instead of picking a syntax version, you declare an edition year and tune individual behaviors with `features` options - for example, field presence tracking, UTF-8 validation strictness, or enum open/closed semantics. The wire format is unchanged, so Editions files interoperate with existing proto2/proto3 producers and consumers. No forced migration. `protoc` continues to support proto3 alongside Editions.

```protobuf
edition = "2023";
package order.v1;

option features.field_presence = EXPLICIT;   // track presence even for scalars
option features.enum_type      = CLOSED;     // reject unknown enum values

message Order {
  string id   = 1;
  int64  cents = 2;
}
```

Recommendation for new services in 2026: start with `edition = "2023"` (or later) and let `buf lint` / `buf breaking` drive migration decisions. Existing proto3 files can stay as-is - they are not deprecated.

---

### Junior → FAANG: Understanding Proto Advanced Features Through Concrete Failure Scenarios

The `oneof` feature exists because without it, proto3 has no way to express "exactly one of these channels must be set." Without `oneof`, you might have four separate optional fields (email, sms, push, slack) and your server code has to validate that exactly one is set, and that validation happens at runtime rather than at the schema level. The `oneof` constraint pushes that validation into the generated code: the generated Go type makes it impossible to set two fields simultaneously. The type-switch dispatch pattern in the example is the idiomatic way to consume a `oneof`, and the `nil` case must always be handled to avoid panics.

Field masks are the protobuf answer to the PATCH vs PUT distinction in REST. Without field masks, a partial update RPC has two bad options: require clients to send the full resource (over-fetching, race conditions on unrelated fields), or use a separate message type for every possible subset of updatable fields (combinatorial explosion). Field masks solve both: the client sends only the fields it wants to update and names them explicitly in the mask. The server applies only those fields. The `proto.Merge(existing, applyMask(req.User, req.UpdateMask))` pattern in the example is the correct server-side application.

The backward compatibility table in Section 5.4 should be memorized for FAANG interviews. The key insight is that the field number is the wire identity, not the field name. A field rename is safe on the wire. A field number change is catastrophic: old clients reading the renamed-number field will interpret the bytes as a different type, producing silent data corruption.

### Senior @ FAANG: Schema Governance, buf BSR, and Protobuf Editions Migration Strategy

At staff level, the concern is not whether individual developers know the proto safety rules but whether those rules are enforced automatically before any change lands. The `buf lint` and `buf breaking` tools provide this enforcement at CI time. `buf lint` catches style violations (field naming, package naming, missing comments on RPC methods). `buf breaking` compares the current proto against a baseline (typically the previous commit on main, or the published version in the buf schema registry) and rejects any change that breaks wire compatibility.

The buf schema registry (BSR) is the organizational primitive that makes this work at scale. A central BSR hosts all `.proto` files for the organization, versioned and dependency-tracked. When a producer team updates their proto, the BSR validates it against `buf breaking` before publishing. Consumer teams declare their dependency on `order.v1` at a specific version in their `buf.yaml`, and the BSR pins them to a known-good version until they explicitly upgrade. This is the same model as Go modules for proto dependencies, and it solves the same problem: without pinning, a producer breaking change immediately affects all consumers simultaneously.

Protobuf Editions (2023+) introduces a governance question: when do you migrate existing proto3 files? The wire format is identical, so migration is safe at any time. The pragmatic answer is to migrate when you need a behavior that Editions enables and proto3 does not, or when starting a new service. Batch migrating 300 existing proto3 files in an organization requires careful planning. The edit itself is mechanical because the wire format is identical: change `syntax = "proto3"` to `edition = "2023"` and add explicit `features` wherever the proto3 default differs from the edition default. Validate each converted file against `buf breaking` to confirm no semantic change, and roll them out incrementally with per-team review. (Note that `buf convert` is unrelated here: it converts message data between binary, JSON, and text, not schema files.) The `features.field_presence = EXPLICIT` change is the most likely to affect generated code: it enables presence tracking for scalar fields (distinguishing "field is absent" from "field is zero"), which can affect conditional logic in handlers that previously treated zero and absent as equivalent. Audit your handlers before enabling this feature.
