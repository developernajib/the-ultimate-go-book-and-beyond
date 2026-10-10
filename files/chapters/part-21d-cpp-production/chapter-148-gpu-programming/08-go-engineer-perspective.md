## The Go Engineer's Perspective

A Go engineer at a machine learning company will encounter GPU systems daily without necessarily writing a single CUDA kernel. Understanding the system architecture, where Go lives, where C++ lives, and how they communicate, is as important as knowing the GPU programming model itself.

### Where Go Fits in a GPU System

The modern ML serving stack is a layered system. Each layer has a natural programming language:

```
┌─────────────────────────────────────────────────────────┐
│  Client (mobile app, web, other services)               │
└─────────────────────────────────────────────────────────┘
                          │ HTTP/gRPC
┌─────────────────────────────────────────────────────────┐
│  API Gateway / Load Balancer          ← Go              │
│  Rate limiting, auth, routing                           │
└─────────────────────────────────────────────────────────┘
                          │ gRPC
┌─────────────────────────────────────────────────────────┐
│  Request Batcher / Queue Manager      ← Go              │
│  Batch formation, priority queues, SLAs                 │
└─────────────────────────────────────────────────────────┘
                          │ gRPC / shared memory
┌─────────────────────────────────────────────────────────┐
│  Triton Inference Server              ← C++             │
│  TensorRT engines, GPU memory mgmt                      │
└─────────────────────────────────────────────────────────┘
                          │ CUDA / PCIe
┌─────────────────────────────────────────────────────────┐
│  GPU (A100/H100)                      ← CUDA C++        │
│  Kernel execution, tensor operations                    │
└─────────────────────────────────────────────────────────┘
```

Go owns the orchestration layers. C++ owns the GPU execution layer. This is not a compromise, it is the correct architecture. Go's goroutine model and gRPC ecosystem make it excellent for building high-throughput services that fan out to multiple GPU backends. C++ and CUDA make it excellent for squeezing every microsecond out of GPU hardware.

### Integration Options

| Approach | When to use | Complexity |
|---|---|---|
| **Triton Inference Server + gRPC** | Serving trained models at scale | Low (standard gRPC client) |
| **CGo + CUDA runtime** | Direct GPU control from Go | High (CGo friction + CUDA complexity) |
| `github.com/barnex/cuda5` | Simple CUDA operations in Go | Medium (limited functionality) |
| **Python subprocess** | Prototyping only | Low (but high latency, not production) |
| **ONNX Runtime Go bindings** | CPU inference with some GPU support | Medium |
| **Shared memory IPC** | Low-latency local GPU process | Medium (manual protocol design) |

### Triton Inference Server: The Production Pattern

Triton is the standard way Go services call GPU models. It exposes a gRPC API defined by `kserve/inference_protocol` that accepts tensor inputs and returns tensor outputs. The Go client is generated from protobuf.

```go
package main

import (
    "context"
    "fmt"
    "log"
    "time"

    "google.golang.org/grpc"
    "google.golang.org/grpc/credentials/insecure"

    // Generated from Triton's grpc_service.proto
    pb "github.com/triton-inference-server/client/src/grpc_generated/go/grpc-client"
)

type TritonClient struct {
    conn   *grpc.ClientConn
    client pb.GRPCInferenceServiceClient
}

func NewTritonClient(addr string) (*TritonClient, error) {
    conn, err := grpc.Dial(addr, grpc.WithTransportCredentials(insecure.NewCredentials()))
    if err != nil {
        return nil, fmt.Errorf("dial triton: %w", err)
    }
    return &TritonClient{
        conn:   conn,
        client: pb.NewGRPCInferenceServiceClient(conn),
    }, nil
}

// Classify a batch of images using a ResNet-50 TensorRT INT8 engine
func (c *TritonClient) ClassifyImages(ctx context.Context,
                                      images [][]float32,
                                      height, width int) ([]int, error) {
    batchSize := int64(len(images))

    // Flatten image data: [batch, 3, H, W]
    flat := make([]float32, 0, batchSize*3*int64(height)*int64(width))
    for _, img := range images {
        flat = append(flat, img...)
    }

    // Build inference request
    req := &pb.ModelInferRequest{
        ModelName:    "resnet50_int8",
        ModelVersion: "1",
        Inputs: []*pb.ModelInferRequest_InferInputTensor{
            {
                Name:     "input",
                Datatype: "FP32",
                Shape:    []int64{batchSize, 3, int64(height), int64(width)},
                Contents: &pb.InferTensorContents{
                    Fp32Contents: flat,
                },
            },
        },
        Outputs: []*pb.ModelInferRequest_InferRequestedOutputTensor{
            {Name: "output"},
        },
    }

    ctx, cancel := context.WithTimeout(ctx, 100*time.Millisecond)
    defer cancel()

    resp, err := c.client.ModelInfer(ctx, req)
    if err != nil {
        return nil, fmt.Errorf("triton infer: %w", err)
    }

    // Parse logits → argmax for each image
    logits := resp.Outputs[0].Contents.Fp32Contents
    numClasses := len(logits) / int(batchSize)

    classes := make([]int, batchSize)
    for b := 0; b < int(batchSize); b++ {
        best, bestVal := 0, logits[b*numClasses]
        for c := 1; c < numClasses; c++ {
            if logits[b*numClasses+c] > bestVal {
                best = c
                bestVal = logits[b*numClasses+c]
            }
        }
        classes[b] = best
    }
    return classes, nil
}

func (c *TritonClient) Close() error {
    return c.conn.Close()
}
```

### Request Batching: The Key Go Contribution

Individual inference requests arrive one at a time. GPUs are most efficient with large batches. The Go layer bridges this gap with a **dynamic batcher**, a pattern where individual requests are collected for a few milliseconds and sent to the GPU as a batch.

```go
package batcher

import (
    "context"
    "sync"
    "time"
)

type InferRequest struct {
    Input    []float32
    ResultCh chan InferResult
}

type InferResult struct {
    Output []float32
    Err    error
}

type DynamicBatcher struct {
    maxBatchSize  int
    maxWait       time.Duration
    inferenceFn   func(inputs [][]float32) ([][]float32, error)

    mu       sync.Mutex
    pending  []InferRequest
    timer    *time.Timer
}

func NewDynamicBatcher(maxBatch int, maxWait time.Duration,
                       fn func([][]float32) ([][]float32, error)) *DynamicBatcher {
    b := &DynamicBatcher{
        maxBatchSize: maxBatch,
        maxWait:      maxWait,
        inferenceFn:  fn,
    }
    return b
}

// Infer adds a request to the pending batch and waits for the result.
func (b *DynamicBatcher) Infer(ctx context.Context, input []float32) ([]float32, error) {
    ch := make(chan InferResult, 1)
    b.mu.Lock()
    b.pending = append(b.pending, InferRequest{Input: input, ResultCh: ch})

    if len(b.pending) == 1 {
        // First request in this batch: start the timer
        b.timer = time.AfterFunc(b.maxWait, b.flush)
    }

    shouldFlush := len(b.pending) >= b.maxBatchSize
    b.mu.Unlock()

    if shouldFlush {
        b.flush()
    }

    select {
    case result := <-ch:
        return result.Output, result.Err
    case <-ctx.Done():
        return nil, ctx.Err()
    }
}

// flush dispatches the current batch to the GPU via inferenceFn.
func (b *DynamicBatcher) flush() {
    b.mu.Lock()
    if len(b.pending) == 0 {
        b.mu.Unlock()
        return
    }
    if b.timer != nil {
        b.timer.Stop()
    }
    batch := b.pending
    b.pending = nil
    b.mu.Unlock()

    inputs := make([][]float32, len(batch))
    for i, req := range batch {
        inputs[i] = req.Input
    }

    outputs, err := b.inferenceFn(inputs)

    for i, req := range batch {
        if err != nil {
            req.ResultCh <- InferResult{Err: err}
        } else {
            req.ResultCh <- InferResult{Output: outputs[i]}
        }
    }
}
```

This batcher collects requests for up to `maxWait` (typically 2-10ms) or until `maxBatchSize` is reached, whichever comes first. A batch of 32 RTX 4090 inferences often runs faster than 32 sequential single-element inferences by 10-20×.

### CGo + CUDA: When You Need Direct Control

For cases where Triton is too heavy, CGo provides direct CUDA runtime access:

```go
// cuda_wrapper.go
package cuda

/*
#cgo CFLAGS: -I/usr/local/cuda/include
#cgo LDFLAGS: -L/usr/local/cuda/lib64 -lcudart -lcublas

#include <cuda_runtime.h>
#include <cublas_v2.h>
#include <stdlib.h>

float* cuda_malloc_float(int n) {
    float* ptr;
    cudaMalloc((void**)&ptr, n * sizeof(float));
    return ptr;
}

void cuda_memcpy_h2d(float* dst, const float* src, int n) {
    cudaMemcpy(dst, src, n * sizeof(float), cudaMemcpyHostToDevice);
}

void cuda_memcpy_d2h(float* dst, const float* src, int n) {
    cudaMemcpy(dst, src, n * sizeof(float), cudaMemcpyDeviceToHost);
}

void cuda_free(void* ptr) { cudaFree(ptr); }
*/
import "C"
import "unsafe"

type DeviceFloat struct {
    ptr *C.float
    n   int
}

func NewDeviceFloat(n int) *DeviceFloat {
    return &DeviceFloat{ptr: C.cuda_malloc_float(C.int(n)), n: n}
}

func (d *DeviceFloat) CopyFromHost(data []float32) {
    C.cuda_memcpy_h2d(d.ptr, (*C.float)(unsafe.Pointer(&data[0])), C.int(d.n))
}

func (d *DeviceFloat) CopyToHost(data []float32) {
    C.cuda_memcpy_d2h((*C.float)(unsafe.Pointer(&data[0])), d.ptr, C.int(d.n))
}

func (d *DeviceFloat) Free() {
    C.cuda_free(unsafe.Pointer(d.ptr))
}
```

CGo works but carries significant friction: compile times increase substantially, cross-compilation is painful, cgo-related panics are hard to debug, and the Go garbage collector does not know about GPU memory. Reserve CGo for cases where the abstraction genuinely cannot be provided by a service boundary.

### What Go Engineers Actually Build at ML Companies

- **Feature stores**: Serving precomputed embeddings via Redis/Cassandra to the inference layer
- **Request routing**: Load-balance across GPU nodes, implement canary deployments of model versions
- **Data pipelines**: Ingest, validate, and preprocess training data at scale
- **Experiment tracking**: Record model versions, hyperparameters, evaluation metrics
- **Serving infrastructure**: Rate limiting, authentication, SLA enforcement around Triton
- **Batch job orchestration**: Kubernetes jobs for offline inference over large datasets
- **Model registry**: Store and version model artifacts (ONNX files, TRT engines)

Go engineers who understand the GPU layer, who can read a TensorRT build log, interpret Nsight Compute output, or debug a CUDA OOM, are significantly more effective because they understand the system they're orchestrating. You don't need to write CUDA to benefit from understanding it.

---
