## 45.2 Server Streaming

### Proto Definition

Server streaming is declared in a `.proto` file by placing the `stream` keyword before the return type. The client sends a single request, and the server responds with a sequence of messages of the declared type. Here, `ListUsers` returns a stream of `User` messages, and `WatchEvents` returns a stream of `Event` messages.

```protobuf
// proto/stream/v1/stream.proto
syntax = "proto3";

package stream.v1;

option go_package = "github.com/myapp/gen/stream/v1;streamv1";

import "google/protobuf/timestamp.proto";

// ListUsersRequest for server streaming
message ListUsersRequest {
    int32 page_size = 1;
    string status_filter = 2;
    bool include_deleted = 3;
}

message User {
    string id = 1;
    string name = 2;
    string email = 3;
    google.protobuf.Timestamp created_at = 4;
}

// WatchEventsRequest for real-time events
message WatchEventsRequest {
    repeated string event_types = 1;
    string resource_id = 2;
}

message Event {
    string id = 1;
    string type = 2;
    string resource_id = 3;
    bytes payload = 4;
    google.protobuf.Timestamp timestamp = 5;
}

service StreamService {
    // Server streaming - list all users
    rpc ListUsers(ListUsersRequest) returns (stream User);

    // Server streaming - watch events
    rpc WatchEvents(WatchEventsRequest) returns (stream Event);
}
```

### Server Implementation

The server-streaming handler receives the request and a typed stream object. It calls `stream.Send` once per result and returns `nil` when finished. The `ListUsers` handler below pages through a data store in batches, streaming each user individually. The `WatchEvents` handler subscribes to an event source and forwards events to the client as they arrive, exiting when the context is canceled or the channel closes.

```go
package server

import (
    "google.golang.org/grpc/codes"
    "google.golang.org/grpc/status"
    "google.golang.org/protobuf/types/known/timestamppb"

    streamv1 "github.com/myapp/gen/stream/v1"
)

type StreamServer struct {
    streamv1.UnimplementedStreamServiceServer
    userStore  UserStore
    eventStore EventStore
}

// ListUsers implements server streaming
func (s *StreamServer) ListUsers(req *streamv1.ListUsersRequest, stream streamv1.StreamService_ListUsersServer) error {
    ctx := stream.Context()

    // Create filter
    filter := &UserFilter{
        Status:         req.GetStatusFilter(),
        IncludeDeleted: req.GetIncludeDeleted(),
    }

    // Get users in batches
    pageSize := int(req.GetPageSize())
    if pageSize <= 0 {
        pageSize = 100
    }

    var cursor string
    for {
        // Check for cancellation
        select {
        case <-ctx.Done():
            return status.FromContextError(ctx.Err()).Err()
        default:
        }

        // Fetch batch
        users, nextCursor, err := s.userStore.List(ctx, filter, pageSize, cursor)
        if err != nil {
            return status.Errorf(codes.Internal, "failed to list users: %v", err)
        }

        // Stream each user
        for _, user := range users {
            if err := stream.Send(toProtoUser(user)); err != nil {
                return status.Errorf(codes.Internal, "failed to send user: %v", err)
            }
        }

        // Check if done
        if nextCursor == "" || len(users) < pageSize {
            break
        }
        cursor = nextCursor
    }

    return nil
}

// WatchEvents implements real-time event streaming
func (s *StreamServer) WatchEvents(req *streamv1.WatchEventsRequest, stream streamv1.StreamService_WatchEventsServer) error {
    ctx := stream.Context()

    // Subscribe to events
    eventChan, unsubscribe := s.eventStore.Subscribe(ctx, req.GetEventTypes(), req.GetResourceId())
    defer unsubscribe()

    // Send initial events (optional)
    initialEvents, err := s.eventStore.GetRecent(ctx, req.GetEventTypes(), req.GetResourceId(), 10)
    if err != nil {
        return status.Errorf(codes.Internal, "failed to get initial events: %v", err)
    }

    for _, event := range initialEvents {
        if err := stream.Send(toProtoEvent(event)); err != nil {
            return status.Errorf(codes.Internal, "failed to send event: %v", err)
        }
    }

    // Stream new events
    for {
        select {
        case <-ctx.Done():
            return status.FromContextError(ctx.Err()).Err()

        case event, ok := <-eventChan:
            if !ok {
                // Channel closed
                return nil
            }

            if err := stream.Send(toProtoEvent(event)); err != nil {
                return status.Errorf(codes.Internal, "failed to send event: %v", err)
            }
        }
    }
}

// Helper to convert to proto
func toProtoUser(u *User) *streamv1.User {
    return &streamv1.User{
        Id:        u.ID,
        Name:      u.Name,
        Email:     u.Email,
        CreatedAt: timestamppb.New(u.CreatedAt),
    }
}

func toProtoEvent(e *Event) *streamv1.Event {
    return &streamv1.Event{
        Id:         e.ID,
        Type:       e.Type,
        ResourceId: e.ResourceID,
        Payload:    e.Payload,
        Timestamp:  timestamppb.New(e.Timestamp),
    }
}
```

### Client Consuming Server Stream

The client calls the streaming RPC to receive a `ServerStreamingClient`, then loops calling `Recv` until it returns `io.EOF` (stream done) or a non-nil error (failure). Context cancellation passed to the initial call propagates to all in-flight `Recv` calls, so the client can abort the stream cleanly without waiting for the server to finish sending.

```go
package client

import (
    "context"
    "io"
    "log"

    streamv1 "github.com/myapp/gen/stream/v1"
)

func (c *StreamClient) ListAllUsers(ctx context.Context, statusFilter string) ([]*streamv1.User, error) {
    stream, err := c.client.ListUsers(ctx, &streamv1.ListUsersRequest{
        PageSize:     100,
        StatusFilter: statusFilter,
    })
    if err != nil {
        return nil, err
    }

    var users []*streamv1.User
    for {
        user, err := stream.Recv()
        if err == io.EOF {
            // Stream completed successfully
            break
        }
        if err != nil {
            return nil, err
        }
        users = append(users, user)
    }

    return users, nil
}

// WatchEvents with callback pattern
func (c *StreamClient) WatchEvents(ctx context.Context, eventTypes []string, handler func(*streamv1.Event) error) error {
    stream, err := c.client.WatchEvents(ctx, &streamv1.WatchEventsRequest{
        EventTypes: eventTypes,
    })
    if err != nil {
        return err
    }

    for {
        event, err := stream.Recv()
        if err == io.EOF {
            return nil
        }
        if err != nil {
            return err
        }

        if err := handler(event); err != nil {
            log.Printf("handler error: %v", err)
            // Continue processing other events
        }
    }
}

// WatchEvents with channel pattern
func (c *StreamClient) WatchEventsChannel(ctx context.Context, eventTypes []string) (<-chan *streamv1.Event, <-chan error) {
    events := make(chan *streamv1.Event)
    errs := make(chan error, 1)

    go func() {
        defer close(events)
        defer close(errs)

        stream, err := c.client.WatchEvents(ctx, &streamv1.WatchEventsRequest{
            EventTypes: eventTypes,
        })
        if err != nil {
            errs <- err
            return
        }

        for {
            event, err := stream.Recv()
            if err == io.EOF {
                return
            }
            if err != nil {
                errs <- err
                return
            }

            select {
            case events <- event:
            case <-ctx.Done():
                return
            }
        }
    }()

    return events, errs
}
```

### Junior -> FAANG: Server Streaming First-Job Habits

Three habits separate server-streaming code that passes code review from code that gets sent back.

**Always cursor-paginate, never load-all-then-stream.** The `ListUsers` handler above fetches users in batches of 100 from the store. A beginner version calls `s.userStore.ListAll(ctx)` into a slice and then ranges over the slice calling `stream.Send`. This loads the entire result set into memory before the first message reaches the client. For a table with 10 million rows, that is an OOM waiting to happen. Cursor-based fetching keeps the server's memory footprint proportional to the batch size, not the result set size.

**Check context before every expensive operation, not just between sends.** The handler in this section checks `ctx.Done()` before each database fetch batch. Many beginners only check after `stream.Send`. If the database query takes 500ms and the client cancels during that query, the server wastes 500ms completing a query whose result will never be sent. Move the context check before the expensive operation.

**Use the callback pattern for event streams.** The `WatchEvents` function with a `handler func(*streamv1.Event) error` callback is cleaner for callers than the channel pattern for simple use cases. The channel pattern (`WatchEventsChannel`) is better when the caller wants to fan-out to multiple consumers or merge with other channel sources. Know when to use each. For interview purposes, demonstrate both and explain the trade-off.

One common interview question: "How would you implement a server-streaming list RPC that supports filtering applied after retrieval from the store?" The answer must address the case where filtering reduces the result set significantly: if you page 100 items and 95 are filtered out, you are doing 19x more database work than necessary. Push filters to the store query, not the application layer.

### Senior @ FAANG: Server Streaming at Platform Scale

**Per-stream rate limiting.** The `WatchEvents` handler above broadcasts every event to every subscriber with no rate limiting per client. At Twitch or Discord scale, a single high-traffic resource (a popular channel, a shared document) can generate thousands of events per second. Clients on slow connections or mobile networks cannot consume at that rate. Per-client rate limiting means each subscriber gets at most N events per second, with excess events either dropped (lossy) or buffered up to a bound (bounded loss). The policy choice (drop vs buffer) belongs in the service's SLA documentation, not buried in code comments.

**Fan-out topology.** Broadcasting from within the server handler (as in `WatchEvents`) couples event generation to stream delivery. Under high fan-out, a single slow client blocks the broadcast loop if the channel send is synchronous. The production pattern separates event generation from delivery: a shared event bus (Redis pub/sub, Kafka, or an in-process ring buffer) produces events, and each stream handler has its own consumer that independently reads from the bus and calls `stream.Send`. This decouples producer speed from consumer speed and allows slow consumers to fall behind and be detected independently.

**Versioning server-streaming APIs.** A server-streaming RPC that adds a new field to the response message is a compatible change (old clients ignore unknown fields). A server-streaming RPC that removes a field or changes the ordering semantics of the stream is a breaking change that requires a new RPC version. The policy for streaming API versioning is stricter than for unary APIs because clients may be consuming a stream for hours and cannot gracefully handle mid-stream schema changes. Establish a rule: streaming RPC response messages are append-only for the lifetime of the major version. New fields are added at the end. Semantic changes require a new RPC with a `V2` suffix.

**Observability: time-to-first-message.** For server streaming, the most meaningful latency metric is not total stream duration but time-to-first-message: the elapsed time between the client initiating the RPC and receiving the first `Recv` response. This is the metric users feel. Instrument it with a histogram per RPC method. A p99 time-to-first-message regression is immediately visible in dashboards and correlates with user-facing "loading" experience. Alert on this metric separately from stream duration.

---
