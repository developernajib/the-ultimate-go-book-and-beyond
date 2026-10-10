## 25B.5 Serialization Deep Dive

### encoding/json: Advanced Patterns

> **Senior track**: `encoding/json/v2` is generally available as of Go 1.27. The v2 API splits into `encoding/json/v2` (marshal/unmarshal) and `encoding/json/jsontext` (streaming tokens), fixes long-standing v1 pain points (case-insensitive matching via `case:ignore`, options struct instead of behavioral flags), and generally improves performance, but benchmark on your workload before migrating. Write new code against v2 where the team agrees; the v1 package remains supported.

Go's `encoding/json` package calls `MarshalJSON` and `UnmarshalJSON` if a type implements them, giving complete control over wire representation. This is the correct approach for types where the in-memory representation differs from the API contract, such as a `Money` type stored in integer cents but serialized as a decimal string. Streaming with `json.Decoder` avoids loading entire large JSON arrays into memory by decoding one element at a time.

```go
package main

import (
    "bytes"
    "encoding/json"
    "fmt"
)

// Custom JSON marshaling: control exactly how a type serializes
type Money struct {
    Amount   int64  // stored as cents
    Currency string
}

func (m Money) MarshalJSON() ([]byte, error) {
    // Serialize as: {"amount": "10.50", "currency": "USD"}
    return json.Marshal(struct {
        Amount   string `json:"amount"`
        Currency string `json:"currency"`
    }{
        Amount:   fmt.Sprintf("%.2f", float64(m.Amount)/100),
        Currency: m.Currency,
    })
}

func (m *Money) UnmarshalJSON(data []byte) error {
    var raw struct {
        Amount   string `json:"amount"`
        Currency string `json:"currency"`
    }
    if err := json.Unmarshal(data, &raw); err != nil {
        return err
    }
    m.Currency = raw.Currency
    var dollars float64
    fmt.Sscanf(raw.Amount, "%f", &dollars)
    m.Amount = int64(dollars * 100)
    return nil
}

// Streaming JSON: process large JSON arrays without loading all into memory
func streamLargeJSON(data []byte) error {
    dec := json.NewDecoder(bytes.NewReader(data))

    // Read opening bracket
    if _, err := dec.Token(); err != nil {
        return err
    }

    for dec.More() {
        var item map[string]any
        if err := dec.Decode(&item); err != nil {
            return err
        }
        fmt.Println("processed item:", item["id"])
    }
    return nil
}

// RawMessage: defer parsing of specific fields
type Event struct {
    Type    string          `json:"type"`
    Payload json.RawMessage `json:"payload"` // not parsed yet
}

func handleEvent(data []byte) error {
    var event Event
    if err := json.Unmarshal(data, &event); err != nil {
        return err
    }

    switch event.Type {
    case "user_created":
        var payload struct {
            UserID string `json:"user_id"`
            Email  string `json:"email"`
        }
        return json.Unmarshal(event.Payload, &payload)
    case "order_placed":
        var payload struct {
            OrderID string `json:"order_id"`
            Total   int64  `json:"total_cents"`
        }
        return json.Unmarshal(event.Payload, &payload)
    }
    return nil
}

// json.Number: use for large integers or when type is uncertain
func useJsonNumber() {
    data := `{"id": 12345678901234567890, "name": "test"}`
    dec := json.NewDecoder(bytes.NewReader([]byte(data)))
    dec.UseNumber() // tell decoder to use json.Number instead of float64

    var result map[string]any
    dec.Decode(&result)

    id := result["id"].(json.Number) // safe: json.Number, not float64
    fmt.Println(id.String()) // 12345678901234567890 - exact!
    n, _ := id.Int64()
    fmt.Println(n) // may lose precision for very large numbers
}

func main() {
    m := Money{Amount: 1050, Currency: "USD"}
    b, _ := json.Marshal(m)
    fmt.Println(string(b)) // {"amount":"10.50","currency":"USD"}

    var m2 Money
    json.Unmarshal(b, &m2)
    fmt.Println(m2.Amount, m2.Currency) // 1050 USD
}
```

### encoding/gob: Go-Specific Binary Serialization

`encoding/gob` is a compact, self-describing binary format designed exclusively for Go-to-Go communication, think inter-process pipelines, RPC implementations, or storing session state in Redis without the JSON overhead. Unlike JSON, gob preserves Go-native types such as maps, slices, and interfaces with no structural mapping required, but it requires explicit `gob.Register` calls for any concrete type that will be encoded behind an interface value.

```go
package main

import (
    "bytes"
    "encoding/gob"
    "fmt"
)

// gob is Go-specific, not interoperable with other languages
// Pros: fast, handles Go types natively (interfaces, maps, slices)
// Cons: Go-only, not human readable, fragile schema evolution

type Session struct {
    UserID    int64
    Email     string
    Roles     []string
    ExpiresAt int64
    Metadata  map[string]string
}

func gobEncode(v any) ([]byte, error) {
    var buf bytes.Buffer
    enc := gob.NewEncoder(&buf)
    if err := enc.Encode(v); err != nil {
        return nil, err
    }
    return buf.Bytes(), nil
}

func gobDecode(data []byte, v any) error {
    dec := gob.NewDecoder(bytes.NewReader(data))
    return dec.Decode(v)
}

func main() {
    sess := Session{
        UserID:    123,
        Email:     "alice@example.com",
        Roles:     []string{"admin", "user"},
        ExpiresAt: 1234567890,
        Metadata:  map[string]string{"device": "mobile"},
    }

    encoded, err := gobEncode(&sess)
    if err != nil {
        panic(err)
    }
    fmt.Printf("gob size: %d bytes\n", len(encoded))

    var decoded Session
    if err := gobDecode(encoded, &decoded); err != nil {
        panic(err)
    }
    fmt.Printf("%+v\n", decoded)

    // gob with interfaces: must register concrete types
    gob.Register(map[string]any{})
    gob.Register([]any{})
    // Without Register, encoding an interface value panics!
}
```

### Protocol Buffers: Cross-Language, Versioned Serialization

Protocol Buffers encode data as a compact binary format guided by a `.proto` schema, which `protoc` compiles into type-safe Go structs, typically several times smaller and faster to marshal than the equivalent JSON. The schema acts as a contract between services: field numbers are stable identifiers that allow adding new fields without breaking existing readers, making Protobuf the standard choice for gRPC services and any system where structured schema evolution matters.

```protobuf
// file: proto/user.proto
syntax = "proto3";
package user;
option go_package = "myapp/gen/user";

message User {
    int64  id         = 1;
    string name       = 2;
    string email      = 3;
    repeated string roles = 4;
    int64  created_at = 5;  // unix timestamp
}

message GetUserRequest {
    int64 id = 1;
}

message GetUserResponse {
    User user = 1;
}
```

After running `protoc --go_out=. user.proto`, you get generated Go structs with field accessors and `proto.Marshal`/`proto.Unmarshal` support. Adding new fields to the `.proto` file is backward-compatible, existing binaries simply ignore unknown field numbers during deserialization.

```go
// Generated code usage (after: protoc --go_out=. user.proto)
package main

import (
    "fmt"
    "google.golang.org/protobuf/proto"
    pb "myapp/gen/user"
)

func main() {
    // Create a protobuf message
    user := &pb.User{
        Id:        1,
        Name:      "Alice",
        Email:     "alice@example.com",
        Roles:     []string{"admin", "user"},
        CreatedAt: 1234567890,
    }

    // Serialize
    encoded, err := proto.Marshal(user)
    if err != nil {
        panic(err)
    }
    fmt.Printf("proto size: %d bytes\n", len(encoded))

    // Deserialize
    var decoded pb.User
    if err := proto.Unmarshal(encoded, &decoded); err != nil {
        panic(err)
    }
    fmt.Println(decoded.Name) // Alice

    // Schema evolution: unknown fields are preserved during round-trip
    // Adding new fields is backward-compatible
    // Removing required fields breaks old readers - use optional always

    // Clone a message
    clone := proto.Clone(user).(*pb.User)
    fmt.Println(clone.Id) // 1

    // JSON representation (useful for debugging)
    // jsonBytes, _ := protojson.Marshal(user)
    // fmt.Println(string(jsonBytes))
}
```

### MessagePack: Fast Binary JSON Alternative

MessagePack is a schema-less binary format that maps directly onto JSON's type system, objects, arrays, strings, numbers, booleans, and nulls, but encodes them in a compact binary representation. Expect roughly a third off the wire size for a typical struct (a small user record measured 98 bytes against JSON's 148, about 66% of the size), with the saving growing as field names repeat across a collection. It is a good drop-in replacement for JSON in performance-sensitive paths such as cache payloads stored in Redis, where you want smaller bytes and lower CPU cost without adopting a mandatory schema.

```go
package main

import (
    "fmt"
    "github.com/vmihailenco/msgpack/v5"
)

type Order struct {
    ID         int64  `msgpack:"id"`
    UserID     int64  `msgpack:"user_id"`
    TotalCents int64  `msgpack:"total_cents"` // integer cents, never float64
    Items      []Item `msgpack:"items"`
}

type Item struct {
    SKU        string `msgpack:"sku"`
    Quantity   int    `msgpack:"qty"`
    PriceCents int64  `msgpack:"price_cents"`
}

func main() {
    order := Order{
        ID:         1001,
        UserID:     42,
        TotalCents: 2999,
        Items: []Item{
            {SKU: "BOOK-001", Quantity: 1, PriceCents: 1999},
            {SKU: "PEN-001", Quantity: 2, PriceCents: 500},
        },
    }

    // Serialize
    encoded, err := msgpack.Marshal(&order)
    if err != nil {
        panic(err)
    }
    fmt.Printf("msgpack size: %d bytes\n", len(encoded))

    // Deserialize
    var decoded Order
    if err := msgpack.Unmarshal(encoded, &decoded); err != nil {
        panic(err)
    }
    fmt.Printf("%+v\n", decoded)
}
```

### Serialization Format Comparison

Choosing a serialization format requires weighing payload size, encoding speed, human readability, and whether you need a shared schema between services. The following table and benchmarks provide a side-by-side reference.

```
┌──────────────────────────────────────────────────────────────────────────────┐
│              Serialization Format Comparison                                 │
├──────────────┬───────────────┬────────────┬──────────────┬───────────────────┤
│  Format      │  Size         │  Speed     │  Human Read  │  Schema           │
├──────────────┼───────────────┼────────────┼──────────────┼───────────────────┤
│  JSON        │ Large (verbose)│ Slow (text)│ ✓ Yes        │ Optional         │
│  JSON (+gzip)│ Small         │ Slow + gz  │ ✓ compressed  │ Optional         │
│  gob         │ Small streamed│ Fast ONLY  │ ✗ Binary      │ Go-implicit      │
│              │ Large one-shot│ if Encoder │              │ (Go only)         │
│              │ (type defs)   │ is reused  │              │                   │
│  Protobuf    │ Small         │ Very fast  │ ✗ Binary      │ Required (.proto)│
│  MessagePack │ Small         │ Fast       │ ✗ Binary      │ Optional         │
│  CBOR        │ Small         │ Fast       │ ✗ Binary      │ Optional         │
│  Avro        │ Smallest      │ Fastest    │ ✗ Binary      │ Required (JSON)  │
├──────────────┼───────────────┼────────────┼──────────────┼───────────────────┤
│  Best for    │              │            │              │                    │
│  JSON        │ REST APIs, debugging, config files        │                   │
│  gob         │ Go-to-Go STREAMS (reuse one Encoder)      │                   │
│  Protobuf    │ gRPC, cross-language, high-throughput     │                   │
│  MessagePack │ Replace JSON where perf matters (Redis)   │                   │
│  Avro        │ Kafka messages, Hadoop ecosystem          │                   │
└──────────────┴───────────────┴────────────┴──────────────┴───────────────────┘

Rule of thumb:
- External APIs: JSON (human-readable, universal support)
- Internal gRPC services: Protobuf (schema-enforced, fastest)
- Cache/Redis: MessagePack (smaller than JSON, no schema needed)
- Go-to-Go STREAMS: gob (Go-native types, no schema file)
- Event streaming (Kafka): Protobuf or Avro (schema registry)
```

**On gob, and why "fast" needs a qualifier.** gob is usually listed as a fast, compact, Go-native format, and that is true only when you reuse one `Encoder` across many values. A `gob.Encoder` transmits a description of each type the first time it sees it, so the first message on a fresh encoder carries the whole type definition with it. Measure a single `gob.NewEncoder(&buf).Encode(v)`, which is what "marshal this struct" usually means, and gob comes out both slower and *larger* than `encoding/json`:

| Encoding of one small struct | Bytes |
|---|---|
| JSON | 148 |
| gob, first message on a new Encoder | 191 |
| gob, subsequent message on the same Encoder | 73 |

The same split shows up in time. On one machine, `json.Marshal` measured about 13µs/op, a fresh-encoder gob about 67µs/op (roughly five times slower, with ten times the allocations), and a reused-encoder gob about 6µs/op (about twice as fast as JSON). Both gob figures are real. Which one you get depends entirely on whether your code creates an encoder per message or per connection.

So the honest guidance is narrower than the table suggests: gob is a good choice for a long-lived stream between two Go processes, and a poor choice for caching individual values in Redis or storing one-off blobs, which is exactly where people reach for it after reading "fast, Go-native, no schema".

**On the numbers above.** Treat them as ratios on one machine, not constants. Absolute ns/op depends on CPU, Go version, and the shape of your struct, and figures quoted in books (including these) drift. The only benchmark that settles an argument is the one you run on your data:

```go
func BenchmarkJSON(b *testing.B) {
    b.ReportAllocs()
    for i := 0; i < b.N; i++ {
        if _, err := json.Marshal(v); err != nil {
            b.Fatal(err)
        }
    }
}
```

Run it with `-benchmem`, and compare alternatives with `benchstat` (25.5) so you can tell a real difference from noise.

> **Senior track**: Do not reach for `sonic`, `go-json`, or `easyjson` reflexively. The stdlib `encoding/json` is fast enough for most services, benchmark first, profile with `-benchmem` and `pprof`, and only swap if allocations in the decoder dominate a proven hot path. Non-standard JSON libraries introduce API drift, fuzz surface, and CVE exposure that almost always costs more than the speedup.

### Staff Lens: Serialization Choice Is Architectural

The choice locks the service's wire protocol. Changing serialization later is a coordinated migration. Pick deliberately at design time: JSON for external API, Protobuf for internal RPC, MessagePack or gob for internal caching.

---
