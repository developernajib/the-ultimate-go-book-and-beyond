## 43.10 Exercises with Complete Solutions

### Exercise 1: Build a Chat Service with Bidirectional Streaming

**Requirements:**
- Users can join chat rooms
- Messages broadcast to all users in room
- Support user presence (online/offline)
- Handle disconnections gracefully

**Solution:**

```go
// proto/chat/v1/chat.proto
/*
syntax = "proto3";
package chat.v1;

message JoinRequest {
  string room_id = 1;
  string user_id = 2;
  string username = 3;
}

message ChatMessage {
  string message_id = 1;
  string room_id = 2;
  string user_id = 3;
  string username = 4;
  string content = 5;
  google.protobuf.Timestamp timestamp = 6;
}

message ChatEvent {
  oneof event {
    ChatMessage message = 1;
    UserJoined user_joined = 2;
    UserLeft user_left = 3;
  }
}

message UserJoined {
  string room_id = 1;
  string user_id = 2;
  string username = 3;
}

message UserLeft {
  string room_id = 1;
  string user_id = 2;
  string username = 3;
}

service ChatService {
  rpc Chat(stream ChatMessage) returns (stream ChatEvent);
  rpc JoinRoom(JoinRequest) returns (stream ChatEvent);
}
*/

package chat

import (
    "context"
    "io"
    "sync"

    "github.com/google/uuid"
    "google.golang.org/grpc"
    "google.golang.org/grpc/codes"
    "google.golang.org/grpc/status"
    "google.golang.org/protobuf/types/known/timestamppb"

    chatv1 "github.com/myapp/gen/chat/v1"
)

// ChatServer implements the chat service
type ChatServer struct {
    chatv1.UnimplementedChatServiceServer

    rooms   map[string]*Room
    roomsMu sync.RWMutex
}

// Room represents a chat room
type Room struct {
    id       string
    users    map[string]*User
    usersMu  sync.RWMutex
    messages chan *chatv1.ChatEvent
}

// User represents a connected subscriber. Each RPC handler owns its own stream
// and drains send into it, so the broadcaster never calls Send on a stream
// directly. Chat and JoinRoom use different stream types, so a shared typed
// stream field cannot work for both.
type User struct {
    id       string
    username string
    send     chan *chatv1.ChatEvent
    done     chan struct{}
}

func NewChatServer() *ChatServer {
    return &ChatServer{
        rooms: make(map[string]*Room),
    }
}

func (s *ChatServer) getOrCreateRoom(roomID string) *Room {
    s.roomsMu.Lock()
    defer s.roomsMu.Unlock()

    room, ok := s.rooms[roomID]
    if !ok {
        room = &Room{
            id:       roomID,
            users:    make(map[string]*User),
            messages: make(chan *chatv1.ChatEvent, 100),
        }
        s.rooms[roomID] = room

        // Start message broadcaster
        go room.broadcast()
    }

    return room
}

func (r *Room) broadcast() {
    for event := range r.messages {
        r.usersMu.RLock()
        for _, user := range r.users {
            // Non-blocking fan-out: a slow or disconnected subscriber never
            // blocks delivery to the rest of the room.
            select {
            case user.send <- event:
            case <-user.done:
            default:
            }
        }
        r.usersMu.RUnlock()
    }
}

func (r *Room) addUser(user *User) {
    r.usersMu.Lock()
    r.users[user.id] = user
    r.usersMu.Unlock()

    // Broadcast user joined
    r.messages <- &chatv1.ChatEvent{
        Event: &chatv1.ChatEvent_UserJoined{
            UserJoined: &chatv1.UserJoined{
                RoomId:   r.id,
                UserId:   user.id,
                Username: user.username,
            },
        },
    }
}

func (r *Room) removeUser(userID string) {
    r.usersMu.Lock()
    user, ok := r.users[userID]
    if ok {
        delete(r.users, userID)
    }
    r.usersMu.Unlock()

    if ok {
        // Broadcast user left
        r.messages <- &chatv1.ChatEvent{
            Event: &chatv1.ChatEvent_UserLeft{
                UserLeft: &chatv1.UserLeft{
                    RoomId:   r.id,
                    UserId:   user.id,
                    Username: user.username,
                },
            },
        }
    }
}

// JoinRoom handles users joining a room
func (s *ChatServer) JoinRoom(req *chatv1.JoinRequest, stream chatv1.ChatService_JoinRoomServer) error {
    if req.RoomId == "" || req.UserId == "" || req.Username == "" {
        return status.Error(codes.InvalidArgument, "room_id, user_id, and username are required")
    }

    room := s.getOrCreateRoom(req.RoomId)

    user := &User{
        id:       req.UserId,
        username: req.Username,
        send:     make(chan *chatv1.ChatEvent, 16),
        done:     make(chan struct{}),
    }

    room.addUser(user)
    defer room.removeUser(req.UserId)

    // Deliver room events to this client until it disconnects.
    for {
        select {
        case event := <-user.send:
            if err := stream.Send(event); err != nil {
                return err
            }
        case <-stream.Context().Done():
            return nil
        }
    }
}

// Chat handles bidirectional chat streaming
func (s *ChatServer) Chat(stream chatv1.ChatService_ChatServer) error {
    // First message should establish the room
    firstMsg, err := stream.Recv()
    if err != nil {
        return status.Error(codes.InvalidArgument, "expected initial message")
    }

    room := s.getOrCreateRoom(firstMsg.RoomId)

    user := &User{
        id:       firstMsg.UserId,
        username: firstMsg.Username,
        send:     make(chan *chatv1.ChatEvent, 16),
        done:     make(chan struct{}),
    }

    room.addUser(user)
    defer room.removeUser(user.id)

    // Receive messages from the client and broadcast them to the room.
    // Closing user.done signals the send loop below to return.
    go func() {
        defer close(user.done)

        for {
            msg, err := stream.Recv()
            if err == io.EOF {
                return
            }
            if err != nil {
                return
            }

            // Assign message ID and timestamp
            msg.MessageId = uuid.New().String()
            msg.Timestamp = timestamppb.Now()

            room.messages <- &chatv1.ChatEvent{
                Event: &chatv1.ChatEvent_Message{
                    Message: msg,
                },
            }
        }
    }()

    // Deliver room events to this client.
    for {
        select {
        case event := <-user.send:
            if err := stream.Send(event); err != nil {
                return err
            }
        case <-stream.Context().Done():
            return nil
        case <-user.done:
            return nil
        }
    }
}

// ChatClient for testing
type ChatClient struct {
    client   chatv1.ChatServiceClient
    roomID   string
    userID   string
    username string
}

func NewChatClient(conn *grpc.ClientConn, roomID, userID, username string) *ChatClient {
    return &ChatClient{
        client:   chatv1.NewChatServiceClient(conn),
        roomID:   roomID,
        userID:   userID,
        username: username,
    }
}

func (c *ChatClient) Join(ctx context.Context, events chan<- *chatv1.ChatEvent) error {
    stream, err := c.client.JoinRoom(ctx, &chatv1.JoinRequest{
        RoomId:   c.roomID,
        UserId:   c.userID,
        Username: c.username,
    })
    if err != nil {
        return err
    }

    for {
        event, err := stream.Recv()
        if err == io.EOF {
            close(events)
            return nil
        }
        if err != nil {
            return err
        }
        events <- event
    }
}
```

### Exercise 2: Implement a File Upload Service with Client Streaming

**Requirements:**
- Upload large files in chunks
- Support resumable uploads
- Calculate checksum for verification
- Progress tracking

**Solution:**

```go
// proto/upload/v1/upload.proto
/*
syntax = "proto3";
package upload.v1;

message UploadRequest {
  oneof request {
    UploadMetadata metadata = 1;
    FileChunk chunk = 2;
  }
}

message UploadMetadata {
  string filename = 1;
  int64 total_size = 2;
  string content_type = 3;
  string upload_id = 4;  // For resumable uploads
}

message FileChunk {
  bytes data = 1;
  int64 offset = 2;
  string checksum = 3;  // MD5 of chunk
}

message UploadResponse {
  string file_id = 1;
  string upload_id = 2;
  int64 bytes_received = 3;
  bool complete = 4;
  string file_checksum = 5;
}

message UploadStatusRequest {
  string upload_id = 1;
}

message UploadStatusResponse {
  string upload_id = 1;
  int64 bytes_received = 2;
  int64 total_size = 3;
  bool complete = 4;
}

service UploadService {
  rpc Upload(stream UploadRequest) returns (UploadResponse);
  rpc GetUploadStatus(UploadStatusRequest) returns (UploadStatusResponse);
}
*/

package upload

import (
    "context"
    "crypto/md5"
    "encoding/hex"
    "fmt"
    "hash"
    "io"
    "os"
    "path/filepath"
    "sync"

    "github.com/google/uuid"
    "google.golang.org/grpc/codes"
    "google.golang.org/grpc/status"

    uploadv1 "github.com/myapp/gen/upload/v1"
)

// UploadServer handles file uploads
type UploadServer struct {
    uploadv1.UnimplementedUploadServiceServer

    uploadDir string
    uploads   sync.Map // upload_id -> *UploadState
}

type UploadState struct {
    ID            string
    Filename      string
    TotalSize     int64
    BytesReceived int64
    ContentType   string
    TempPath      string
    File          *os.File
    Hash          hash.Hash
    mu            sync.Mutex
}

func NewUploadServer(uploadDir string) *UploadServer {
    os.MkdirAll(uploadDir, 0755)
    return &UploadServer{uploadDir: uploadDir}
}

func (s *UploadServer) Upload(stream uploadv1.UploadService_UploadServer) error {
    var state *UploadState

    for {
        req, err := stream.Recv()
        if err == io.EOF {
            // Upload complete
            if state == nil {
                return status.Error(codes.InvalidArgument, "no data received")
            }
            return s.completeUpload(stream, state)
        }
        if err != nil {
            return status.Errorf(codes.Internal, "receive error: %v", err)
        }

        switch r := req.Request.(type) {
        case *uploadv1.UploadRequest_Metadata:
            // Initialize or resume upload
            state, err = s.initUpload(r.Metadata)
            if err != nil {
                return err
            }

        case *uploadv1.UploadRequest_Chunk:
            if state == nil {
                return status.Error(codes.InvalidArgument, "metadata must be sent first")
            }

            if err := s.writeChunk(state, r.Chunk); err != nil {
                return err
            }
        }
    }
}

func (s *UploadServer) initUpload(meta *uploadv1.UploadMetadata) (*UploadState, error) {
    // Check for resumable upload
    if meta.UploadId != "" {
        if existing, ok := s.uploads.Load(meta.UploadId); ok {
            return existing.(*UploadState), nil
        }
    }

    // Create new upload
    uploadID := uuid.New().String()
    tempPath := filepath.Join(s.uploadDir, uploadID+".tmp")

    file, err := os.Create(tempPath)
    if err != nil {
        return nil, status.Errorf(codes.Internal, "failed to create temp file: %v", err)
    }

    state := &UploadState{
        ID:          uploadID,
        Filename:    meta.Filename,
        TotalSize:   meta.TotalSize,
        ContentType: meta.ContentType,
        TempPath:    tempPath,
        File:        file,
        Hash:        md5.New(),
    }

    s.uploads.Store(uploadID, state)
    return state, nil
}

func (s *UploadServer) writeChunk(state *UploadState, chunk *uploadv1.FileChunk) error {
    state.mu.Lock()
    defer state.mu.Unlock()

    // Verify chunk checksum if provided
    if chunk.Checksum != "" {
        chunkHash := md5.Sum(chunk.Data)
        if hex.EncodeToString(chunkHash[:]) != chunk.Checksum {
            return status.Error(codes.InvalidArgument, "chunk checksum mismatch")
        }
    }

    // Seek to offset for resumable uploads
    if chunk.Offset > 0 {
        if _, err := state.File.Seek(chunk.Offset, 0); err != nil {
            return status.Errorf(codes.Internal, "seek error: %v", err)
        }
    }

    // Write chunk
    n, err := state.File.Write(chunk.Data)
    if err != nil {
        return status.Errorf(codes.Internal, "write error: %v", err)
    }

    // Update hash
    state.Hash.Write(chunk.Data)

    // Update bytes received
    state.BytesReceived += int64(n)

    return nil
}

func (s *UploadServer) completeUpload(stream uploadv1.UploadService_UploadServer, state *UploadState) error {
    state.mu.Lock()
    defer state.mu.Unlock()

    // Close temp file
    if err := state.File.Close(); err != nil {
        return status.Errorf(codes.Internal, "close error: %v", err)
    }

    // Verify total size
    if state.BytesReceived != state.TotalSize {
        return status.Errorf(codes.InvalidArgument,
            "size mismatch: received %d, expected %d", state.BytesReceived, state.TotalSize)
    }

    // Calculate final checksum
    fileChecksum := hex.EncodeToString(state.Hash.Sum(nil))

    // Move to final location
    finalPath := filepath.Join(s.uploadDir, state.ID+"_"+state.Filename)
    if err := os.Rename(state.TempPath, finalPath); err != nil {
        return status.Errorf(codes.Internal, "rename error: %v", err)
    }

    // Cleanup
    s.uploads.Delete(state.ID)

    return stream.SendAndClose(&uploadv1.UploadResponse{
        FileId:        state.ID,
        UploadId:      state.ID,
        BytesReceived: state.BytesReceived,
        Complete:      true,
        FileChecksum:  fileChecksum,
    })
}

func (s *UploadServer) GetUploadStatus(ctx context.Context, req *uploadv1.UploadStatusRequest) (*uploadv1.UploadStatusResponse, error) {
    state, ok := s.uploads.Load(req.UploadId)
    if !ok {
        return nil, status.Error(codes.NotFound, "upload not found")
    }

    upload := state.(*UploadState)
    upload.mu.Lock()
    defer upload.mu.Unlock()

    return &uploadv1.UploadStatusResponse{
        UploadId:      upload.ID,
        BytesReceived: upload.BytesReceived,
        TotalSize:     upload.TotalSize,
        Complete:      upload.BytesReceived == upload.TotalSize,
    }, nil
}

// UploadClient with progress tracking
type UploadClient struct {
    client uploadv1.UploadServiceClient
}

func (c *UploadClient) UploadFile(ctx context.Context, filePath string, progress chan<- float64) (*uploadv1.UploadResponse, error) {
    file, err := os.Open(filePath)
    if err != nil {
        return nil, fmt.Errorf("open file: %w", err)
    }
    defer file.Close()

    stat, err := file.Stat()
    if err != nil {
        return nil, fmt.Errorf("stat file: %w", err)
    }

    stream, err := c.client.Upload(ctx)
    if err != nil {
        return nil, fmt.Errorf("create stream: %w", err)
    }

    // Send metadata
    err = stream.Send(&uploadv1.UploadRequest{
        Request: &uploadv1.UploadRequest_Metadata{
            Metadata: &uploadv1.UploadMetadata{
                Filename:    filepath.Base(filePath),
                TotalSize:   stat.Size(),
                ContentType: "application/octet-stream",
            },
        },
    })
    if err != nil {
        return nil, fmt.Errorf("send metadata: %w", err)
    }

    // Send chunks
    buffer := make([]byte, 64*1024) // 64KB chunks
    var offset int64

    for {
        n, err := file.Read(buffer)
        if err == io.EOF {
            break
        }
        if err != nil {
            return nil, fmt.Errorf("read file: %w", err)
        }

        // Calculate chunk checksum
        chunkHash := md5.Sum(buffer[:n])

        err = stream.Send(&uploadv1.UploadRequest{
            Request: &uploadv1.UploadRequest_Chunk{
                Chunk: &uploadv1.FileChunk{
                    Data:     buffer[:n],
                    Offset:   offset,
                    Checksum: hex.EncodeToString(chunkHash[:]),
                },
            },
        })
        if err != nil {
            return nil, fmt.Errorf("send chunk: %w", err)
        }

        offset += int64(n)

        // Report progress
        if progress != nil {
            progress <- float64(offset) / float64(stat.Size()) * 100
        }
    }

    if progress != nil {
        close(progress)
    }

    return stream.CloseAndRecv()
}
```

### Junior → FAANG: Getting Maximum Value from These Exercises

The two exercises above (chat service and file upload) are FAANG-level system design exercises compressed into coding exercises. Work through them in order.

**Chat service exercise.** The design challenge is room membership management under concurrent joins and leaves. Notice that the `Room` struct uses `sync.RWMutex` to protect the `users` map and a buffered channel for the message broadcast loop. The broadcast goroutine runs per-room, not per-connection. A common mistake is running a goroutine per subscriber: with 10,000 subscribers, that is 10,000 goroutines per room. The channel-based broadcast collapses this to one goroutine per room plus one goroutine per subscriber's `Send` loop.

Practice narrating the failure modes before you write code: what happens if a subscriber's `stream.Send` blocks? (it blocks the broadcaster for all subscribers in that room, a head-of-line blocking problem). The implementation above uses a `select` with a `user.done` channel to skip dead connections non-blockingly. Understand why this design choice was made before your next interview.

**File upload exercise.** The resumable upload pattern (upload ID, per-chunk offset and checksum, state stored in `sync.Map`) demonstrates three important concepts: the `oneof` proto field for discriminating message types in a stream, checksum verification as an integrity mechanism, and idempotent partial operations (seeking to `chunk.Offset` before writing means retransmitting a chunk is safe). Practice explaining why storing upload state in memory (`sync.Map`) is insufficient for production (server restart loses all state) and what the correct storage is (a database or distributed cache with TTL).

For both exercises: run them, then deliberately introduce the common mistakes from the previous section (no context cancellation check, no stream error handling) and verify that your tests catch them. This turns the exercises into test-first development practice.

### Senior @ FAANG: Design Extensions for Production Scale

**Chat service production gaps.** The exercise implementation is correct for a single server process. Identify the production gaps and design the fixes:

- Room state is in-process memory. A second server instance has no visibility into rooms on the first instance. Fix: externalize room membership and the message broadcast channel to a distributed pub/sub system (Redis Streams, Kafka, NATS JetStream). The server becomes a relay between the client stream and the distributed queue. This adds latency (one additional hop) but enables horizontal scaling and eliminates the single-process limitation.
- The `messages` channel per room is bounded (`100` in the example). Under a broadcast spike, the broadcaster blocks when the channel fills. Fix: either increase the buffer size, drop messages for slow consumers with a metric (`broadcast_messages_dropped`), or implement backpressure by having the broadcaster track per-subscriber send lag and disconnect subscribers that fall too far behind.
- There is no authentication or authorization on room membership. Fix: the `JoinRoom` handler extracts user identity from the context (populated by the auth interceptor), validates that the user is permitted to join the specified room, and associates the stream with a verified principal rather than a client-supplied `user_id`.

**File upload production gaps.** The exercise stores upload state in a `sync.Map` (in-memory, single-process) and writes to the local filesystem. Production issues and their fixes:

- Upload state is lost on server restart. Fix: store upload state in a database (upload ID, bytes received, expected size, checksum accumulator, temp file path) with a TTL-based expiration for abandoned uploads.
- The temp file is on the local filesystem. With multiple server instances, a resumed upload that reaches a different server cannot find the temp file. Fix: write chunks directly to object storage (S3, GCS) using the multipart upload API, which provides native resumability and cross-instance consistency.
- Checksum accumulation is in-memory in `UploadState.Hash`. On server restart during a large upload, the checksum cannot be reconstructed from the stored chunks without re-reading them. Fix: compute the checksum per-chunk and store the per-chunk checksums in the database alongside the chunk offsets. Reconstruct the final file checksum from the stored per-chunk values at completion time.
- The size limit check (`totalSize > maxFileSize`) happens after writing to disk. A malicious client can start 100 concurrent uploads of 950 MB each, filling the disk before any single upload exceeds the limit. Fix: reject uploads at the metadata phase based on the declared `TotalSize`. Clients that lie about `TotalSize` are caught by the final size verification at `completeUpload`.

---
