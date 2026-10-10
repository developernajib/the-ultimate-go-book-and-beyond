## 45.3 Client Streaming

### Proto Definition

Client streaming is declared by placing the `stream` keyword before the request type. The client sends a sequence of messages, and the server responds with a single summary message after the stream closes. `UploadFile` accepts a stream of `FileChunk` messages and returns an `UploadResponse`. `BatchProcess` accepts a stream of `BatchItem` messages and returns a `BatchResponse` with per-item error details.

```protobuf
// File upload service
message FileChunk {
    string filename = 1;
    bytes content = 2;
    int64 offset = 3;
    bool is_last = 4;
}

message UploadResponse {
    string file_id = 1;
    int64 total_size = 2;
    string checksum = 3;
}

// Batch operations
message BatchItem {
    string operation = 1;  // create, update, delete
    string resource_type = 2;
    bytes data = 3;
}

message BatchResponse {
    int32 success_count = 1;
    int32 failure_count = 2;
    repeated BatchError errors = 3;
}

message BatchError {
    int32 index = 1;
    string error = 2;
}

service StreamService {
    // Client streaming - file upload
    rpc UploadFile(stream FileChunk) returns (UploadResponse);

    // Client streaming - batch operations
    rpc BatchProcess(stream BatchItem) returns (BatchResponse);
}
```

### Server Implementation

The client-streaming handler receives only the stream object, because there is no separate request parameter because the request *is* the stream. The handler calls `stream.Recv` in a loop until it gets `io.EOF`, then calls `stream.SendAndClose` to return the single response. The `UploadFile` handler below accumulates file chunks into a buffer while computing a SHA-256 checksum. The `BatchProcess` handler processes each item individually and tracks successes and failures for the summary response.

```go
package server

import (
    "bytes"
    "context"
    "crypto/sha256"
    "encoding/hex"
    "fmt"
    "io"

    "google.golang.org/grpc/codes"
    "google.golang.org/grpc/status"

    streamv1 "github.com/myapp/gen/stream/v1"
)

// UploadFile implements client streaming for file uploads
func (s *StreamServer) UploadFile(stream streamv1.StreamService_UploadFileServer) error {
    ctx := stream.Context()

    var (
        filename  string
        buffer    bytes.Buffer
        totalSize int64
        hash      = sha256.New()
    )

    for {
        // Check for cancellation
        select {
        case <-ctx.Done():
            return status.FromContextError(ctx.Err()).Err()
        default:
        }

        chunk, err := stream.Recv()
        if err == io.EOF {
            // Client finished sending
            break
        }
        if err != nil {
            return status.Errorf(codes.Internal, "failed to receive chunk: %v", err)
        }

        // First chunk - get filename
        if filename == "" {
            filename = chunk.GetFilename()
            if filename == "" {
                return status.Error(codes.InvalidArgument, "filename required")
            }
        }

        // Write to buffer and hash
        n, err := buffer.Write(chunk.GetContent())
        if err != nil {
            return status.Errorf(codes.Internal, "failed to write chunk: %v", err)
        }
        hash.Write(chunk.GetContent())
        totalSize += int64(n)

        // Check size limit
        if totalSize > maxFileSize {
            return status.Errorf(codes.InvalidArgument, "file too large (max %d bytes)", maxFileSize)
        }
    }

    // Save file
    fileID, err := s.fileStore.Save(ctx, filename, buffer.Bytes())
    if err != nil {
        return status.Errorf(codes.Internal, "failed to save file: %v", err)
    }

    // Send response
    return stream.SendAndClose(&streamv1.UploadResponse{
        FileId:    fileID,
        TotalSize: totalSize,
        Checksum:  hex.EncodeToString(hash.Sum(nil)),
    })
}

// BatchProcess implements client streaming for batch operations
func (s *StreamServer) BatchProcess(stream streamv1.StreamService_BatchProcessServer) error {
    ctx := stream.Context()

    var (
        successCount int32
        failureCount int32
        errors       []*streamv1.BatchError
        index        int32
    )

    for {
        select {
        case <-ctx.Done():
            return status.FromContextError(ctx.Err()).Err()
        default:
        }

        item, err := stream.Recv()
        if err == io.EOF {
            break
        }
        if err != nil {
            return status.Errorf(codes.Internal, "failed to receive item: %v", err)
        }

        // Process item
        if err := s.processItem(ctx, item); err != nil {
            failureCount++
            errors = append(errors, &streamv1.BatchError{
                Index: index,
                Error: err.Error(),
            })
        } else {
            successCount++
        }

        index++
    }

    return stream.SendAndClose(&streamv1.BatchResponse{
        SuccessCount: successCount,
        FailureCount: failureCount,
        Errors:       errors,
    })
}

func (s *StreamServer) processItem(ctx context.Context, item *streamv1.BatchItem) error {
    switch item.GetOperation() {
    case "create":
        return s.createResource(ctx, item.GetResourceType(), item.GetData())
    case "update":
        return s.updateResource(ctx, item.GetResourceType(), item.GetData())
    case "delete":
        return s.deleteResource(ctx, item.GetResourceType(), item.GetData())
    default:
        return fmt.Errorf("unknown operation: %s", item.GetOperation())
    }
}
```

### Client Sending Stream

The client iterates over its data, calling `Send` for each chunk, then calls `CloseAndRecv` to half-close the stream and receive the server's single summary response. The `Send` call blocks until the HTTP/2 flow control window allows it, providing implicit backpressure when the server is processing more slowly than the client is producing.

```go
package client

import (
    "context"
    "io"
    "os"
    "strings"

    streamv1 "github.com/myapp/gen/stream/v1"
)

const chunkSize = 64 * 1024 // 64KB chunks

// UploadFile uploads a file using client streaming
func (c *StreamClient) UploadFile(ctx context.Context, filepath string) (*streamv1.UploadResponse, error) {
    // Open file
    file, err := os.Open(filepath)
    if err != nil {
        return nil, err
    }
    defer file.Close()

    // Create stream
    stream, err := c.client.UploadFile(ctx)
    if err != nil {
        return nil, err
    }

    // Get filename
    filename := filepath[strings.LastIndex(filepath, "/")+1:]

    // Send chunks
    buffer := make([]byte, chunkSize)
    var offset int64

    for {
        n, err := file.Read(buffer)
        // Process the n bytes first: Read may return n > 0 together with
        // io.EOF, and checking the error before sending would drop the last
        // chunk. This matters for readers other than *os.File (gzip, network).
        if n > 0 {
            chunk := &streamv1.FileChunk{
                Filename: filename,
                Content:  buffer[:n],
                Offset:   offset,
            }
            if sendErr := stream.Send(chunk); sendErr != nil {
                return nil, sendErr
            }
            offset += int64(n)
        }

        if err == io.EOF {
            break
        }
        if err != nil {
            return nil, err
        }
    }

    // Close and receive response
    return stream.CloseAndRecv()
}

// BatchProcess sends batch items
func (c *StreamClient) BatchProcess(ctx context.Context, items []BatchItem) (*streamv1.BatchResponse, error) {
    stream, err := c.client.BatchProcess(ctx)
    if err != nil {
        return nil, err
    }

    for _, item := range items {
        protoItem := &streamv1.BatchItem{
            Operation:    item.Operation,
            ResourceType: item.ResourceType,
            Data:         item.Data,
        }

        if err := stream.Send(protoItem); err != nil {
            return nil, err
        }
    }

    return stream.CloseAndRecv()
}

type BatchItem struct {
    Operation    string
    ResourceType string
    Data         []byte
}
```

### Junior -> FAANG: Client Streaming First-Job Habits

Client streaming has two failure modes that beginners consistently miss, and both show up in code review.

**Missing `SendAndClose` on the server.** The server handler for a client-streaming RPC must call either `stream.SendAndClose(response)` or return an error. If the handler returns `nil` without calling `SendAndClose`, the client's `CloseAndRecv()` call blocks forever waiting for the response frame. The gRPC runtime does not enforce this. It is purely a programming discipline issue. Write a test that checks the RPC returns within a deadline to catch this class of bug.

**Missing `CloseAndRecv` on the client.** As shown in the common mistakes section, forgetting `CloseAndRecv()` leaves the server's `Recv` loop waiting for `io.EOF` that never arrives. The fix is always to use `stream.CloseAndRecv()` at the end of the send loop, not `stream.CloseSend()` followed by a separate receive call (which is valid for bidirectional streams but awkward for client streaming). Make `CloseAndRecv` the canonical ending for every client-streaming caller.

**Chunk sizing for file uploads.** The `chunkSize = 64 * 1024` constant in the upload example is a reasonable default. Too small (1 KB) and the per-message framing overhead dominates. Too large (10 MB) and a single failed send loses a large chunk of progress. For production file uploads, choose chunk size based on the expected network reliability: unreliable (mobile): 64 KB to 256 KB. Reliable datacenter: 512 KB to 2 MB. Always include the byte offset in each chunk so the server can detect gaps and the client can resume.

For interviews: be ready to trace through the `UploadFile` handler and client together, explaining which side sees `io.EOF`, which side sends the response, and what happens if the client disconnects mid-upload.

### Senior @ FAANG: Client Streaming at Platform Scale

**Ingest pipeline design.** Client streaming is the natural fit for high-volume data ingestion: telemetry, audit logs, IoT sensor readings. At platform scale, the client-streaming handler is not the final destination. It is the entry point into an ingestion pipeline that validates, deduplicates, batches, and writes to a durable store (Kafka, Bigtable, Spanner). The handler's job is to accept bytes safely and acknowledge. The processing job is async. This separation allows the ingestion endpoint to absorb traffic spikes without slowing down because of downstream processing latency. Design the split explicitly and document the at-least-once vs exactly-once delivery semantics for each stage.

**Checksum and streaming to storage.** The `UploadFile` handler above buffers all chunks into a `bytes.Buffer` in memory while hashing incrementally. For multi-gigabyte files, buffering the entire payload in RAM is an OOM risk. The production pattern streams chunks directly to disk or object storage using an `io.MultiWriter(dstFile, hash)` to write and hash simultaneously with a constant, bounded memory footprint, then compares the digest against a client-provided checksum in the final chunk's metadata field. This validates integrity in a single pass without unconstrained memory growth.

**Resumable uploads as a first-class protocol.** The `UploadFile` RPC in this section is all-or-nothing: if the connection drops, the client must restart from byte 0. Production file upload systems (Google Cloud Storage resumable uploads, AWS S3 multipart upload) use a two-phase protocol: initiate an upload session (returns a session ID), then upload chunks referencing the session ID with byte range headers. The server acknowledges each chunk with the highest contiguous byte offset received. On reconnect, the client queries the server for the current offset and resumes from there. Implement this as a pair of RPCs (`InitiateUpload` unary + `UploadChunk` client streaming) rather than cramming resumption into a single client-streaming RPC.

**Admission control for batch ingestion.** A client-streaming batch endpoint is a natural target for accidental volume bursts: a misconfigured job sending 10x normal volume. Without admission control, this saturates the ingestion server and starves legitimate traffic. Implement per-client rate limiting at the stream level: if a single client sends more than N bytes per second, return `ResourceExhausted` on the next `Recv` and close the stream. Track ingestion volume per client in a sliding window counter (Redis with Lua atomic operations or a local token bucket). Log the rate-limit event with the client identity (extracted from mTLS certificate or JWT) for capacity planning.

---
