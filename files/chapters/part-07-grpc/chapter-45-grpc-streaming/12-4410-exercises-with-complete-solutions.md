## 45.10 Exercises with Complete Solutions

### Exercise 1: Build a Resumable File Download Service

**Requirements:**
- Support resuming from any byte offset
- Report progress percentage
- Handle network disconnections gracefully
- Verify file integrity with checksum

**Solution:**

```go
// Proto definition
/*
message DownloadRequest {
    string file_id = 1;
    int64 offset = 2;      // Resume from this byte offset
    int64 chunk_size = 3;  // Preferred chunk size (default 64KB)
}

message FileChunk {
    bytes data = 1;
    int64 offset = 2;
    int64 total_size = 3;
    bool is_last = 4;
    string checksum = 5;   // MD5 of entire file (only in last chunk)
}
*/

package download

import (
    "context"
    "crypto/md5"
    "encoding/hex"
    "fmt"
    "io"
    "os"
    "path/filepath"
    "time"

    "google.golang.org/grpc/codes"
    "google.golang.org/grpc/status"
)

const defaultChunkSize = 64 * 1024 // 64KB

// Server implementation
type FileServer struct {
    pb.UnimplementedFileServiceServer
    storageDir string
}

func (s *FileServer) Download(req *pb.DownloadRequest, stream pb.FileService_DownloadServer) error {
    ctx := stream.Context()

    // Open file
    filePath := filepath.Join(s.storageDir, req.FileId)
    file, err := os.Open(filePath)
    if err != nil {
        if os.IsNotExist(err) {
            return status.Errorf(codes.NotFound, "file not found: %s", req.FileId)
        }
        return status.Errorf(codes.Internal, "open failed: %v", err)
    }
    defer file.Close()

    // Get file info
    stat, err := file.Stat()
    if err != nil {
        return status.Errorf(codes.Internal, "stat failed: %v", err)
    }
    totalSize := stat.Size()

    // Validate offset
    offset := req.Offset
    if offset < 0 || offset >= totalSize {
        return status.Errorf(codes.InvalidArgument,
            "invalid offset %d for file size %d", offset, totalSize)
    }

    // Seek to offset
    if offset > 0 {
        if _, err := file.Seek(offset, io.SeekStart); err != nil {
            return status.Errorf(codes.Internal, "seek failed: %v", err)
        }
    }

    // Determine chunk size
    chunkSize := int(req.ChunkSize)
    if chunkSize <= 0 {
        chunkSize = defaultChunkSize
    }

    // Calculate file checksum (for verification)
    checksum, err := s.calculateChecksum(filePath)
    if err != nil {
        return status.Errorf(codes.Internal, "checksum failed: %v", err)
    }

    // Stream file
    buffer := make([]byte, chunkSize)
    currentOffset := offset

    for {
        // Check for cancellation
        select {
        case <-ctx.Done():
            return status.FromContextError(ctx.Err()).Err()
        default:
        }

        // Read chunk
        n, err := file.Read(buffer)
        if err == io.EOF {
            break
        }
        if err != nil {
            return status.Errorf(codes.Internal, "read failed: %v", err)
        }

        isLast := currentOffset+int64(n) >= totalSize

        chunk := &pb.FileChunk{
            Data:      buffer[:n],
            Offset:    currentOffset,
            TotalSize: totalSize,
            IsLast:    isLast,
        }

        // Include checksum in last chunk
        if isLast {
            chunk.Checksum = checksum
        }

        if err := stream.Send(chunk); err != nil {
            return status.Errorf(codes.Internal, "send failed: %v", err)
        }

        currentOffset += int64(n)
    }

    return nil
}

func (s *FileServer) calculateChecksum(filePath string) (string, error) {
    file, err := os.Open(filePath)
    if err != nil {
        return "", err
    }
    defer file.Close()

    hash := md5.New()
    if _, err := io.Copy(hash, file); err != nil {
        return "", err
    }

    return hex.EncodeToString(hash.Sum(nil)), nil
}

// Client implementation
type DownloadClient struct {
    client      pb.FileServiceClient
    progressCb  func(downloaded, total int64)
}

type DownloadResult struct {
    FilePath string
    Size     int64
    Checksum string
    Verified bool
}

func (c *DownloadClient) DownloadFile(ctx context.Context, fileID, destPath string) (*DownloadResult, error) {
    // Check if partial download exists
    var offset int64
    if stat, err := os.Stat(destPath + ".partial"); err == nil {
        offset = stat.Size()
    }

    // Open destination file
    var file *os.File
    var err error
    if offset > 0 {
        file, err = os.OpenFile(destPath+".partial", os.O_WRONLY|os.O_APPEND, 0644)
    } else {
        file, err = os.Create(destPath + ".partial")
    }
    if err != nil {
        return nil, fmt.Errorf("create file: %w", err)
    }

    // Download with retry
    result, err := c.downloadWithRetry(ctx, fileID, file, offset)
    file.Close()

    if err != nil {
        return nil, err
    }

    // Rename to final path
    if err := os.Rename(destPath+".partial", destPath); err != nil {
        return nil, fmt.Errorf("rename: %w", err)
    }

    result.FilePath = destPath
    return result, nil
}

func (c *DownloadClient) downloadWithRetry(ctx context.Context, fileID string, file *os.File, startOffset int64) (*DownloadResult, error) {
    const maxRetries = 5
    offset := startOffset
    var serverChecksum string
    var totalSize int64

    for attempt := 0; attempt < maxRetries; attempt++ {
        if attempt > 0 {
            // Exponential backoff
            select {
            case <-ctx.Done():
                return nil, ctx.Err()
            case <-time.After(time.Duration(1<<attempt) * time.Second):
            }

            // Get current file position for resume
            pos, _ := file.Seek(0, io.SeekEnd)
            offset = pos
        }

        // Start download stream
        stream, err := c.client.Download(ctx, &pb.DownloadRequest{
            FileId: fileID,
            Offset: offset,
        })
        if err != nil {
            if isRetryable(err) {
                continue
            }
            return nil, err
        }

        // Receive chunks
        for {
            chunk, err := stream.Recv()
            if err == io.EOF {
                // Verify checksum
                if err := file.Sync(); err != nil {
                    return nil, fmt.Errorf("sync: %w", err)
                }

                // Calculate local checksum
                file.Seek(0, io.SeekStart)
                hash := md5.New()
                io.Copy(hash, file)
                localChecksum := hex.EncodeToString(hash.Sum(nil))

                verified := localChecksum == serverChecksum

                return &DownloadResult{
                    Size:     totalSize,
                    Checksum: serverChecksum,
                    Verified: verified,
                }, nil
            }

            if err != nil {
                if isRetryable(err) {
                    break // Retry from current position
                }
                return nil, err
            }

            // Write chunk
            if _, err := file.Write(chunk.Data); err != nil {
                return nil, fmt.Errorf("write: %w", err)
            }

            totalSize = chunk.TotalSize
            if chunk.IsLast {
                serverChecksum = chunk.Checksum
            }

            // Report progress
            if c.progressCb != nil {
                downloaded := chunk.Offset + int64(len(chunk.Data))
                c.progressCb(downloaded, totalSize)
            }
        }
    }

    return nil, fmt.Errorf("max retries exceeded")
}

func isRetryable(err error) bool {
    st, ok := status.FromError(err)
    if !ok {
        return false
    }
    switch st.Code() {
    case codes.Unavailable, codes.DeadlineExceeded, codes.Aborted:
        return true
    }
    return false
}
```

### Exercise 2: Build a Real-Time Collaboration System

**Requirements:**
- Multiple users can edit same document simultaneously
- Changes sync in real-time using bidirectional streaming
- Handle offline edits and conflicts
- Operational transformation for concurrent edits

**Solution:**

```go
// Simplified operational transformation for collaborative editing
package collab

import (
    "io"
    "sync"
    "time"

    "google.golang.org/grpc/codes"
    "google.golang.org/grpc/status"
)

// Operation represents a document change
type Operation struct {
    Type     string // "insert", "delete"
    Position int
    Text     string
    UserID   string
    Version  int64
}

// Document represents a collaborative document
type Document struct {
    ID       string
    Content  string
    Version  int64
    mu       sync.RWMutex
    clients  map[string]*ClientSession
    ops      chan *Operation
}

type ClientSession struct {
    userID   string
    stream   pb.Collab_EditServer
    lastSeen int64
    updates  chan *Operation
}

// CollabServer handles collaborative editing
type CollabServer struct {
    pb.UnimplementedCollabServiceServer
    documents sync.Map // docID -> *Document
}

func (s *CollabServer) Edit(stream pb.Collab_EditServer) error {
    ctx := stream.Context()

    // Receive initial join message
    msg, err := stream.Recv()
    if err != nil {
        return err
    }

    join := msg.GetJoin()
    if join == nil {
        return status.Error(codes.InvalidArgument, "expected join message")
    }

    // Get or create document
    doc := s.getOrCreateDocument(join.DocumentId)

    // Create client session
    session := &ClientSession{
        userID:   join.UserId,
        stream:   stream,
        lastSeen: time.Now().UnixNano(),
        updates:  make(chan *Operation, 100),
    }

    doc.mu.Lock()
    doc.clients[join.UserId] = session
    doc.mu.Unlock()

    defer func() {
        doc.mu.Lock()
        delete(doc.clients, join.UserId)
        doc.mu.Unlock()
    }()

    // Send current document state
    if err := stream.Send(&pb.EditResponse{
        Response: &pb.EditResponse_Sync{
            Sync: &pb.DocumentSync{
                Content: doc.Content,
                Version: doc.Version,
            },
        },
    }); err != nil {
        return err
    }

    // Handle incoming operations
    incoming := make(chan *pb.EditRequest, 10)
    errChan := make(chan error, 1)

    go func() {
        for {
            msg, err := stream.Recv()
            if err != nil {
                errChan <- err
                return
            }
            incoming <- msg
        }
    }()

    updates := session.updates

    for {
        select {
        case <-ctx.Done():
            return ctx.Err()

        case err := <-errChan:
            if err == io.EOF {
                return nil
            }
            return err

        case msg := <-incoming:
            if op := msg.GetOperation(); op != nil {
                // Apply operation
                transformed, err := doc.ApplyOperation(&Operation{
                    Type:     op.Type,
                    Position: int(op.Position),
                    Text:     op.Text,
                    UserID:   session.userID,
                })
                if err != nil {
                    return err
                }

                // Acknowledge to sender
                if err := stream.Send(&pb.EditResponse{
                    Response: &pb.EditResponse_Ack{
                        Ack: &pb.OperationAck{
                            Version: transformed.Version,
                        },
                    },
                }); err != nil {
                    return err
                }
            }

        case op := <-updates:
            // Send operation to client
            if err := stream.Send(&pb.EditResponse{
                Response: &pb.EditResponse_Operation{
                    Operation: &pb.Operation{
                        Type:     op.Type,
                        Position: int32(op.Position),
                        Text:     op.Text,
                        UserId:   op.UserID,
                        Version:  op.Version,
                    },
                },
            }); err != nil {
                return err
            }
        }
    }
}

func (d *Document) ApplyOperation(op *Operation) (*Operation, error) {
    d.mu.Lock()
    defer d.mu.Unlock()

    // Transform operation against concurrent operations
    transformed := d.transformOperation(op)

    // Apply to document
    switch transformed.Type {
    case "insert":
        if transformed.Position > len(d.Content) {
            transformed.Position = len(d.Content)
        }
        d.Content = d.Content[:transformed.Position] + transformed.Text + d.Content[transformed.Position:]

    case "delete":
        end := transformed.Position + len(transformed.Text)
        if end > len(d.Content) {
            end = len(d.Content)
        }
        d.Content = d.Content[:transformed.Position] + d.Content[end:]
    }

    d.Version++
    transformed.Version = d.Version

    // Broadcast to other clients
    go d.broadcast(transformed)

    return transformed, nil
}

func (d *Document) transformOperation(op *Operation) *Operation {
    // Simplified OT - in production, use proper CRDT or OT algorithm
    transformed := &Operation{
        Type:     op.Type,
        Position: op.Position,
        Text:     op.Text,
        UserID:   op.UserID,
    }

    // Adjust position based on pending operations
    // This is a simplified version - real OT is more complex

    return transformed
}

func (d *Document) broadcast(op *Operation) {
    d.mu.RLock()
    defer d.mu.RUnlock()

    for userID, session := range d.clients {
        if userID == op.UserID {
            continue // Don't send back to originator
        }

        select {
        case session.updates <- op:
        default:
            // Buffer full: drop or handle slow client to avoid stalling broadcast
        }
    }
}

func (s *CollabServer) getOrCreateDocument(docID string) *Document {
    doc, _ := s.documents.LoadOrStore(docID, &Document{
        ID:      docID,
        clients: make(map[string]*ClientSession),
        ops:     make(chan *Operation, 100),
    })
    return doc.(*Document)
}
```

### Junior -> FAANG: Working Through the Exercises

Both exercises in this section are designed to reveal specific weaknesses that show up in interviews and first-job code reviews.

**Exercise 1 (Resumable File Download):** The key insight is that `offset` in the `DownloadRequest` and `offset` in each `FileChunk` serve different purposes. The request offset tells the server where to seek before starting. The chunk offset tells the client where this chunk belongs in the file. A beginner implementation often only includes one of the two. The second key insight is that the MD5 checksum in the final chunk is computed over the entire file, not just the final chunk. Verifying the checksum requires the client to seek back to the beginning of the partial file and re-read it entirely, which is an I/O cost that scales with file size. For large files, consider a rolling Merkle tree checksum (one hash per 1 MB block) so that verification is incremental rather than all-at-once.

**Exercise 2 (Real-Time Collaboration):** The `transformOperation` function is marked as simplified. Real operational transformation (OT) is a research topic with published algorithms (Jupiter, Google Wave). For interviews, the important points are: (1) you need OT or CRDT when multiple clients can make concurrent edits without locking, (2) the server must be the authority for operation ordering (assign a server-side version to each operation before broadcasting), (3) clients apply incoming remote operations using the transform function before updating their local state. You do not need to implement a correct OT algorithm in an interview. You need to demonstrate awareness of why naive application of concurrent operations produces inconsistency and what category of solution (OT or CRDT) exists.

For first-job practice: complete Exercise 1 fully (server, client, retry logic, checksum verification) in a runnable Go project with tests. This forces you to confront all the edge cases (file not found, invalid offset, mid-download disconnect) in concrete code rather than in the abstract.

### Senior @ FAANG: Exercise Extensions for Staff-Level Depth

Both exercises above are correct at the single-server, single-client level. Extending them to production scale reveals the design decisions that separate mid-level from staff-level thinking.

**Exercise 1 extension: multi-region resumable downloads.** In a content delivery system, the file is replicated across multiple geographic regions. The client resumes from the nearest region. But the `checksum` in the `DownloadRequest` must match across regions (content-addressed storage ensures this). The `offset` in the request must be validated against the file size on the regional replica (which may be slightly stale if replication is async). Design the protocol so that the client can detect a stale replica (the regional file is shorter than the expected total size) and fall back to the origin. This requires the server to return `total_size` in the first chunk response, not just in the final chunk. The client compares `total_size` against its expected size and redirects if they differ.

**Exercise 2 extension: multi-server collaborative editing.** The `CollabServer` above holds all `Document` state in memory. In a multi-server deployment, two clients editing the same document may connect to different servers. The `broadcast` function only reaches clients on the same server instance. Extending to multi-server requires: (1) a shared operation log (Kafka topic per document, or Spanner sequence), (2) each server subscribes to the operation log for its active documents, (3) the server applies incoming operations to its local document state and broadcasts to its local clients. The OT transform function must be applied at the server level (against all concurrent operations in the log, not just local ones). This transforms the problem from a single-server in-memory state machine into a distributed event sourcing system with OT applied at the consumer level. Document this architecture in an ADR: the choice of event log (Kafka vs Spanner) has different cost, latency, and ordering guarantee profiles that affect the OT algorithm's correctness assumptions.

**Shared primitive: the resumable transfer service.** Rather than each team implementing their own resumable download and upload protocols, design a shared platform service: a content-addressed blob store with a unified API for initiating, resuming, and completing transfers. The API exposes `InitiateTransfer` (returns a transfer ID and presigned URLs for direct client-to-storage upload), `GetTransferStatus` (returns bytes received, chunks confirmed), and `CompleteTransfer` (validates checksum, triggers post-processing). Teams call this API instead of implementing streaming handlers. This eliminates the class of bugs demonstrated in both exercises by concentrating the complexity in a single, well-tested service.

---
