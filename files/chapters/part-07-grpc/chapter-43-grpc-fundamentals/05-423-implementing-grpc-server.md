## 43.3 Implementing gRPC Server

### Server Implementation

Implementing a gRPC server requires defining a struct that embeds the generated `Unimplemented*Server` type and overrides the RPC methods. The `Unimplemented` embedding ensures forward compatibility when new methods are added to the proto without updating the server immediately.

```go
package server

import (
    "context"
    "errors"
    "io"
    "sync"

    "google.golang.org/grpc/codes"
    "google.golang.org/grpc/status"
    "google.golang.org/protobuf/types/known/emptypb"
    "google.golang.org/protobuf/types/known/timestamppb"

    userv1 "github.com/myapp/gen/user/v1"
)

// UserServer implements the UserService
type UserServer struct {
    userv1.UnimplementedUserServiceServer
    store UserStore
}

func NewUserServer(store UserStore) *UserServer {
    return &UserServer{store: store}
}

// GetUser implements unary RPC
func (s *UserServer) GetUser(ctx context.Context, req *userv1.GetUserRequest) (*userv1.GetUserResponse, error) {
    // Validate request
    if req.GetId() == "" {
        return nil, status.Error(codes.InvalidArgument, "id is required")
    }

    // Get user from store
    user, err := s.store.GetByID(ctx, req.GetId())
    if err != nil {
        if errors.Is(err, ErrNotFound) {
            return nil, status.Errorf(codes.NotFound, "user %s not found", req.GetId())
        }
        return nil, status.Errorf(codes.Internal, "failed to get user: %v", err)
    }

    return &userv1.GetUserResponse{
        User: toProtoUser(user),
    }, nil
}

// CreateUser implements unary RPC
func (s *UserServer) CreateUser(ctx context.Context, req *userv1.CreateUserRequest) (*userv1.CreateUserResponse, error) {
    // Validate request
    if err := validateCreateUserRequest(req); err != nil {
        return nil, status.Errorf(codes.InvalidArgument, "validation error: %v", err)
    }

    // Create user
    user, err := s.store.Create(ctx, &User{
        Email:    req.GetEmail(),
        Name:     req.GetName(),
        Password: req.GetPassword(),
        Roles:    req.GetRoles(),
    })
    if err != nil {
        if errors.Is(err, ErrDuplicate) {
            return nil, status.Error(codes.AlreadyExists, "email already exists")
        }
        return nil, status.Errorf(codes.Internal, "failed to create user: %v", err)
    }

    return &userv1.CreateUserResponse{
        User: toProtoUser(user),
    }, nil
}

// UpdateUser implements unary RPC with optional fields
func (s *UserServer) UpdateUser(ctx context.Context, req *userv1.UpdateUserRequest) (*userv1.UpdateUserResponse, error) {
    if req.GetId() == "" {
        return nil, status.Error(codes.InvalidArgument, "id is required")
    }

    // Build update
    update := &UserUpdate{}
    if req.Name != nil {
        name := req.GetName()
        update.Name = &name
    }
    if req.Email != nil {
        email := req.GetEmail()
        update.Email = &email
    }
    if req.Status != nil {
        s := fromProtoStatus(req.GetStatus())
        update.Status = &s
    }

    user, err := s.store.Update(ctx, req.GetId(), update)
    if err != nil {
        if errors.Is(err, ErrNotFound) {
            return nil, status.Errorf(codes.NotFound, "user %s not found", req.GetId())
        }
        return nil, status.Errorf(codes.Internal, "failed to update user: %v", err)
    }

    return &userv1.UpdateUserResponse{
        User: toProtoUser(user),
    }, nil
}

// DeleteUser implements unary RPC
func (s *UserServer) DeleteUser(ctx context.Context, req *userv1.DeleteUserRequest) (*emptypb.Empty, error) {
    if req.GetId() == "" {
        return nil, status.Error(codes.InvalidArgument, "id is required")
    }

    if err := s.store.Delete(ctx, req.GetId()); err != nil {
        if errors.Is(err, ErrNotFound) {
            return nil, status.Errorf(codes.NotFound, "user %s not found", req.GetId())
        }
        return nil, status.Errorf(codes.Internal, "failed to delete user: %v", err)
    }

    return &emptypb.Empty{}, nil
}

// ListUsers implements server streaming RPC
func (s *UserServer) ListUsers(req *userv1.ListUsersRequest, stream userv1.UserService_ListUsersServer) error {
    ctx := stream.Context()

    // Create filter
    filter := &UserFilter{
        PageSize: int(req.GetPageSize()),
        PageToken: req.GetPageToken(),
    }
    if req.GetStatusFilter() != userv1.UserStatus_USER_STATUS_UNSPECIFIED {
        status := fromProtoStatus(req.GetStatusFilter())
        filter.Status = &status
    }

    // Stream users
    users, err := s.store.List(ctx, filter)
    if err != nil {
        return status.Errorf(codes.Internal, "failed to list users: %v", err)
    }

    for _, user := range users {
        // Check for cancellation
        select {
        case <-ctx.Done():
            return status.FromContextError(ctx.Err()).Err()
        default:
        }

        if err := stream.Send(toProtoUser(user)); err != nil {
            return status.Errorf(codes.Internal, "failed to send user: %v", err)
        }
    }

    return nil
}

// BulkCreateUsers implements client streaming RPC
func (s *UserServer) BulkCreateUsers(stream userv1.UserService_BulkCreateUsersServer) error {
    ctx := stream.Context()
    var userIDs []string
    var createdCount int32

    for {
        req, err := stream.Recv()
        if err == io.EOF {
            // Client finished sending
            return stream.SendAndClose(&userv1.BulkCreateUsersResponse{
                CreatedCount: createdCount,
                UserIds:      userIDs,
            })
        }
        if err != nil {
            return status.Errorf(codes.Internal, "failed to receive: %v", err)
        }

        // Create user
        user, err := s.store.Create(ctx, &User{
            Email:    req.GetEmail(),
            Name:     req.GetName(),
            Password: req.GetPassword(),
            Roles:    req.GetRoles(),
        })
        if err != nil {
            // Log error but continue with other users
            continue
        }

        userIDs = append(userIDs, user.ID)
        createdCount++
    }
}

// UserUpdates implements bidirectional streaming RPC
func (s *UserServer) UserUpdates(stream userv1.UserService_UserUpdatesServer) error {
    ctx := stream.Context()

    // Track subscribed users
    var subscriptions sync.Map

    // Handle incoming subscription requests
    go func() {
        for {
            req, err := stream.Recv()
            if err == io.EOF {
                return
            }
            if err != nil {
                return
            }
            subscriptions.Store(req.GetUserId(), true)
        }
    }()

    // Send updates
    updates := s.store.Subscribe(ctx)
    for update := range updates {
        // Check if client is subscribed to this user
        if _, ok := subscriptions.Load(update.ID); ok {
            if err := stream.Send(toProtoUser(update)); err != nil {
                return status.Errorf(codes.Internal, "failed to send update: %v", err)
            }
        }
    }

    return nil
}

// Helper functions
func toProtoUser(u *User) *userv1.User {
    return &userv1.User{
        Id:        u.ID,
        Email:     u.Email,
        Name:      u.Name,
        Status:    toProtoStatus(u.Status),
        Roles:     u.Roles,
        CreatedAt: timestamppb.New(u.CreatedAt),
        UpdatedAt: timestamppb.New(u.UpdatedAt),
    }
}

func toProtoStatus(s UserStatus) userv1.UserStatus {
    switch s {
    case StatusActive:
        return userv1.UserStatus_USER_STATUS_ACTIVE
    case StatusInactive:
        return userv1.UserStatus_USER_STATUS_INACTIVE
    case StatusSuspended:
        return userv1.UserStatus_USER_STATUS_SUSPENDED
    default:
        return userv1.UserStatus_USER_STATUS_UNSPECIFIED
    }
}

func fromProtoStatus(s userv1.UserStatus) UserStatus {
    switch s {
    case userv1.UserStatus_USER_STATUS_ACTIVE:
        return StatusActive
    case userv1.UserStatus_USER_STATUS_INACTIVE:
        return StatusInactive
    case userv1.UserStatus_USER_STATUS_SUSPENDED:
        return StatusSuspended
    default:
        return StatusUnspecified
    }
}

func validateCreateUserRequest(req *userv1.CreateUserRequest) error {
    if req.GetEmail() == "" {
        return errors.New("email is required")
    }
    if req.GetName() == "" {
        return errors.New("name is required")
    }
    if req.GetPassword() == "" {
        return errors.New("password is required")
    }
    return nil
}
```

### Running the Server

The `main` function creates a TCP listener on the gRPC port, constructs a `grpc.Server` with the desired chain of interceptors, registers the service implementation, and calls `Serve` in a goroutine while the main goroutine blocks on OS signal to trigger graceful shutdown via `GracefulStop`.

A production server configuration has four knobs worth setting explicitly even in the minimal example:

- **Keepalive policy.** Long-lived HTTP/2 connections traverse stateful NATs, cloud load balancers, and ingresses that drop idle flows silently. Without keepalive pings, the first RPC after a silent drop fails with an `UNAVAILABLE` that could have been prevented. Set `KeepaliveParams` on the server (ping clients and tear down dead connections) and `KeepaliveEnforcementPolicy` (reject clients that ping too aggressively, defaulting to `MinTime: 5 * time.Minute`, production clients typically need `PermitWithoutStream: true` and shorter `MinTime`).
- **Max message size.** Defaults are 4 MiB receive, unlimited send. Unbounded inbound messages are an availability risk. cap with `grpc.MaxRecvMsgSize` and signal the limit in your `.proto` comments so clients can paginate or stream when they approach it.
- **Deadlines originate at the client.** The server does not impose a default deadline on inbound RPCs. Every handler must treat `ctx.Done()` as the authoritative cancel signal, long-running work needs to poll `ctx.Err()` in its loop or pass the context through to downstream calls. If clients routinely forget to set deadlines, add a unary interceptor that synthesizes one on the server side.
- **Graceful drain on shutdown.** `GracefulStop` stops accepting new RPCs, lets in-flight unary calls finish, and closes idle streams. Pair it with a short `time.AfterFunc` that falls back to `Stop` after a bounded drain window so a stuck handler cannot block the deployment forever.

```go
package main

import (
    "log"
    "net"
    "os"
    "os/signal"
    "syscall"
    "time"

    "google.golang.org/grpc"
    "google.golang.org/grpc/keepalive"
    "google.golang.org/grpc/reflection"

    userv1 "github.com/myapp/gen/user/v1"
    "github.com/myapp/server"
)

func main() {
    // Create listener
    lis, err := net.Listen("tcp", ":50051")
    if err != nil {
        log.Fatalf("failed to listen: %v", err)
    }

    // Create gRPC server with production-sane defaults.
    grpcServer := grpc.NewServer(
        grpc.MaxRecvMsgSize(16*1024*1024), // cap inbound at 16 MiB
        grpc.KeepaliveParams(keepalive.ServerParameters{
            MaxConnectionIdle: 15 * time.Minute,
            Time:              30 * time.Second,
            Timeout:           10 * time.Second,
        }),
        grpc.KeepaliveEnforcementPolicy(keepalive.EnforcementPolicy{
            MinTime:             10 * time.Second,
            PermitWithoutStream: true,
        }),
    )

    // Register services
    userStore := NewInMemoryUserStore()
    userServer := server.NewUserServer(userStore)
    userv1.RegisterUserServiceServer(grpcServer, userServer)

    // Register reflection for grpcurl/grpcui
    reflection.Register(grpcServer)

    // Graceful shutdown on SIGINT/SIGTERM. GracefulStop unblocks Serve below,
    // so main returns once in-flight RPCs drain.
    go func() {
        sigCh := make(chan os.Signal, 1)
        signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)
        <-sigCh

        log.Println("Shutting down gRPC server...")
        grpcServer.GracefulStop()
    }()

    // Start server
    log.Printf("gRPC server listening on %s", lis.Addr())
    if err := grpcServer.Serve(lis); err != nil {
        log.Fatalf("failed to serve: %v", err)
    }
}
```

### Junior → FAANG: Server Implementation Habits That Signal Seniority

Three habits that separate a junior gRPC server implementation from one that passes a FAANG code review:

**Always embed `Unimplemented*Server`.** The generated `UnimplementedUserServiceServer` struct implements every method in the service interface by returning `codes.Unimplemented`. Embedding it in your server struct means: (a) your server satisfies the interface even if you have not yet implemented all methods, (b) when a new method is added to the proto, your server still compiles and returns a clear `UNIMPLEMENTED` error instead of a compile error that breaks your binary, and (c) you get forward compatibility for free. Never skip this embedding, even for small services.

**Context cancellation in streaming handlers.** The `ListUsers` streaming implementation checks `ctx.Done()` before each `stream.Send`. This is not optional. Without it, a client that cancels mid-stream holds server resources until the entire list is exhausted. The check costs almost nothing and prevents resource leaks. Practice writing streaming handlers where the cancellation check is the first thing you add.

**Status codes over raw errors.** Every error returned from a gRPC handler must be a `*status.Status`. Returning a plain `errors.New("something failed")` results in `codes.Unknown` at the client, which is untypeable and impossible to handle specifically. The `status.Errorf(codes.NotFound, ...)` pattern is mandatory. Build the habit of wrapping every error at the handler boundary.

For the `main` function: notice the graceful shutdown pattern with a bounded drain window. The common mistake in first jobs is calling `grpcServer.Stop()` directly in the signal handler, which kills all in-flight RPCs instantly. `GracefulStop` is the correct default. Pair it with a timeout so a stuck handler cannot block your deployment pipeline indefinitely.

### Senior @ FAANG: Production Server Design Beyond the Basics

The server implementation shown above is correct for a single service. At the L6 level you design server infrastructure shared by dozens of services. The decisions made here are multiplied across the fleet.

**Interceptor chain design as a platform standard.** The `grpc.NewServer()` call should never appear in product code. It belongs in a platform package that constructs the server with the standard interceptor chain: authentication, authorization, rate limiting, request validation, observability (metrics, traces, logs), and error sanitization. Teams register their service implementation but do not configure the interceptor chain. This ensures that every service in the fleet has consistent security and observability behavior from the first request. The platform package publishes its interceptors as an internal module with semantic versioning, so security updates can be delivered as dependency bumps.

**Keepalive policy for load balancer compatibility.** The chapter covers `KeepaliveParams` and `KeepaliveEnforcementPolicy`. The senior-level concern is that your keepalive settings must be coordinated with your load balancer's idle timeout settings. AWS NLB, GCP L4 LB, and Nginx all have different idle timeout defaults and behaviors. A common production incident: the load balancer silently drops connections idle for 350 seconds, but the server's `MaxConnectionIdle` is set to 15 minutes. The first RPC after the silent drop fails with `UNAVAILABLE`. The fix is to set `MaxConnectionIdle` to a value comfortably below the load balancer's idle timeout (for AWS NLB, the default is 350 seconds, so `MaxConnectionIdle: 300 * time.Second` is a safe upper bound). Document this relationship in your platform's runbook.

**Graceful drain under rolling deployments.** `GracefulStop` is necessary but not sufficient for zero-downtime rolling deploys. The sequence is: (1) the load balancer or service mesh marks the pod `NotReady` and stops routing new connections to it, (2) the pod waits for in-flight requests to complete, (3) the pod terminates. The gap between steps 1 and 2 is where requests are still arriving from clients that have not yet observed the `NotReady` state (because DNS or load balancer state propagation has latency). Mitigate with a `preStop` hook that sleeps a few seconds before `GracefulStop` is called, giving the load balancer time to drain the pod from rotation before the server stops accepting new streams. This is a Kubernetes deployment concern, but it surfaces as a gRPC server configuration problem.

**`max_connection_age` for client-side load balancing.** When clients use client-side load balancing with the DNS resolver, they resolve addresses once and hold connections indefinitely. If you scale from 4 pods to 20 pods, new pods get no traffic until a client reconnects. Setting `MaxConnectionAge` and `MaxConnectionAgeGrace` on the server forces periodic connection draining, which triggers client reconnection and re-resolution. This is the mechanism that distributes traffic to new pods without requiring a service mesh. The trade-off is more frequent connection churn, which adds a small latency spike each time. Tune the value based on your scale-up frequency.

---
