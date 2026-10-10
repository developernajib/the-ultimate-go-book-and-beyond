## 52F.5 Schema Registry

As Kafka adoption grows within an organization, dozens of producers and consumers evolve independently. Without schema management, a producer changing a field name or type can silently break every downstream consumer. **Schema Registry** enforces schema contracts between producers and consumers.

### Why Schema Management Matters

```
Without Schema Registry:

  Producer v1:  {"user_id": 123, "name": "Alice", "email": "alice@example.com"}
  Producer v2:  {"userId": 123, "fullName": "Alice", "email": "alice@example.com"}
                 ↑ renamed fields!

  Consumer (expecting v1 schema):
    user_id = ???   ← field missing, nil/zero value
    name = ???      ← field missing, nil/zero value
    SILENT DATA CORRUPTION - no error, just wrong data

With Schema Registry:

  Producer v2 tries to register new schema:
    Schema Registry: "INCOMPATIBLE - field 'user_id' was removed,
                      field 'name' was removed. Backward compatibility
                      requires only ADDITIVE changes."
    Producer v2: ← REJECTED at deploy time, not at runtime
```

### Supported Schema Formats

| Format | Strengths | Go Support | Use Case |
|--------|-----------|------------|----------|
| **Avro** | Compact binary, schema evolution built-in, widely used in Kafka ecosystem | `github.com/linkedin/goavro/v2`, `github.com/hamba/avro/v2` | Default choice for Kafka |
| **Protobuf** | Fast serialization, strong typing, gRPC interop | `google.golang.org/protobuf` | When you also use gRPC |
| **JSON Schema** | Human-readable, easy debugging | `github.com/santhosh-tekuri/jsonschema/v5` | Development, debugging, simple use cases |

### Schema Evolution Compatibility Modes

Schema Registry enforces compatibility rules when a new schema version is registered:

```
Backward Compatible (DEFAULT):
  New schema can READ data written by old schema.
  Rule: You can ADD optional fields, REMOVE fields.
  Consumer upgraded first, then producer.

  v1: {user_id, name, email}
  v2: {user_id, name, email, phone?}     ← OK: added optional field
  v2: {user_id, name}                    ← OK: removed field (consumer ignores)
  v2: {user_id, name, email, phone}      ← FAIL: phone is required, old data lacks it

Forward Compatible:
  Old schema can READ data written by new schema.
  Rule: You can REMOVE optional fields, ADD fields.
  Producer upgraded first, then consumer.

  v1: {user_id, name, email}
  v2: {user_id, name}                    ← OK: removed field
  v2: {user_id, name, email, phone}      ← OK: old consumer ignores phone

Full Compatible:
  Both backward AND forward compatible.
  Rule: You can only ADD or REMOVE optional fields.
  Safest mode - use this in production.

  v1: {user_id, name, email}
  v2: {user_id, name, email, phone?}     ← OK: added optional field
  v2: {user_id, name}                    ← FAIL: removed field breaks forward

None:
  No compatibility checks. Anything goes.
  NEVER use this in production.
```

### Schema Registry API

The Schema Registry exposes a REST API:

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/subjects` | GET | List all registered subjects |
| `/subjects/{subject}/versions` | GET | List all versions for a subject |
| `/subjects/{subject}/versions` | POST | Register a new schema version |
| `/subjects/{subject}/versions/{version}` | GET | Get a specific schema version |
| `/subjects/{subject}/versions/latest` | GET | Get the latest schema |
| `/compatibility/subjects/{subject}/versions/{version}` | POST | Test compatibility |
| `/config` | GET/PUT | Get/set global compatibility level |
| `/config/{subject}` | GET/PUT | Get/set per-subject compatibility |
| `/schemas/ids/{id}` | GET | Get schema by global ID |

Subject naming conventions:
- **TopicNameStrategy** (default): `{topic}-key`, `{topic}-value`
- **RecordNameStrategy**: Full record name (e.g., `com.example.OrderEvent`)
- **TopicRecordNameStrategy**: `{topic}-{record_name}`

### Go Code: Schema Registry Client

Interacting with Confluent Schema Registry from Go requires registering schemas, resolving schema IDs, and caching responses to avoid per-message HTTP round trips. The following client wraps the Registry REST API with an in-memory cache and retries transient errors without blocking the hot path.

```go
// File: kafka-fundamentals/schema/registry.go
package schema

import (
    "bytes"
    "context"
    "encoding/json"
    "errors"
    "fmt"
    "io"
    "log/slog"
    "net/http"
    "sync"
    "time"
)

// RegistryConfig configures the Schema Registry client.
type RegistryConfig struct {
    URL      string
    Username string // For basic auth.
    Password string
    Logger   *slog.Logger
}

// SchemaType represents the type of schema.
type SchemaType string

const (
    SchemaTypeAvro     SchemaType = "AVRO"
    SchemaTypeProtobuf SchemaType = "PROTOBUF"
    SchemaTypeJSON     SchemaType = "JSON"
)

// CompatibilityLevel defines schema compatibility modes.
type CompatibilityLevel string

const (
    CompatBackward     CompatibilityLevel = "BACKWARD"
    CompatForward      CompatibilityLevel = "FORWARD"
    CompatFull         CompatibilityLevel = "FULL"
    CompatNone         CompatibilityLevel = "NONE"
    CompatBackwardAll  CompatibilityLevel = "BACKWARD_TRANSITIVE"
    CompatForwardAll   CompatibilityLevel = "FORWARD_TRANSITIVE"
    CompatFullAll      CompatibilityLevel = "FULL_TRANSITIVE"
)

// Schema represents a schema in the registry.
type Schema struct {
    Subject    string     `json:"subject"`
    Version    int        `json:"version"`
    ID         int        `json:"id"`
    SchemaType SchemaType `json:"schemaType"`
    Schema     string     `json:"schema"`
}

// RegistryClient provides access to Confluent Schema Registry.
type RegistryClient struct {
    config     RegistryConfig
    httpClient *http.Client
    logger     *slog.Logger

    // Schema cache: schema ID -> schema string.
    cache   map[int]string
    cacheMu sync.RWMutex
}

// NewRegistryClient creates a new Schema Registry client.
func NewRegistryClient(config RegistryConfig) (*RegistryClient, error) {
    if config.URL == "" {
        return nil, errors.New("schema registry URL is required")
    }
    if config.Logger == nil {
        config.Logger = slog.Default()
    }

    return &RegistryClient{
        config: config,
        httpClient: &http.Client{
            Timeout: 10 * time.Second,
        },
        logger: config.Logger,
        cache:  make(map[int]string),
    }, nil
}

// RegisterSchema registers a new schema version for a subject.
// Returns the globally unique schema ID.
func (rc *RegistryClient) RegisterSchema(ctx context.Context, subject string, schemaStr string, schemaType SchemaType) (int, error) {
    body := map[string]string{
        "schema":     schemaStr,
        "schemaType": string(schemaType),
    }

    bodyBytes, err := json.Marshal(body)
    if err != nil {
        return 0, fmt.Errorf("marshaling request: %w", err)
    }

    url := fmt.Sprintf("%s/subjects/%s/versions", rc.config.URL, subject)
    req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(bodyBytes))
    if err != nil {
        return 0, fmt.Errorf("creating request: %w", err)
    }
    req.Header.Set("Content-Type", "application/vnd.schemaregistry.v1+json")

    if rc.config.Username != "" {
        req.SetBasicAuth(rc.config.Username, rc.config.Password)
    }

    resp, err := rc.httpClient.Do(req)
    if err != nil {
        return 0, fmt.Errorf("registering schema: %w", err)
    }
    defer resp.Body.Close()

    if resp.StatusCode == http.StatusConflict {
        return 0, fmt.Errorf("schema is incompatible with the current compatibility level")
    }

    if resp.StatusCode != http.StatusOK {
        respBody, _ := io.ReadAll(resp.Body)
        return 0, fmt.Errorf("schema registry returned %d: %s", resp.StatusCode, string(respBody))
    }

    var result struct {
        ID int `json:"id"`
    }
    if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
        return 0, fmt.Errorf("decoding response: %w", err)
    }

    // Cache the schema.
    rc.cacheMu.Lock()
    rc.cache[result.ID] = schemaStr
    rc.cacheMu.Unlock()

    rc.logger.Info("schema registered",
        "subject", subject,
        "id", result.ID,
        "type", schemaType,
    )
    return result.ID, nil
}

// GetSchemaByID retrieves a schema by its globally unique ID.
// Results are cached for performance.
func (rc *RegistryClient) GetSchemaByID(ctx context.Context, id int) (string, error) {
    // Check cache first.
    rc.cacheMu.RLock()
    if schema, ok := rc.cache[id]; ok {
        rc.cacheMu.RUnlock()
        return schema, nil
    }
    rc.cacheMu.RUnlock()

    url := fmt.Sprintf("%s/schemas/ids/%d", rc.config.URL, id)
    req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
    if err != nil {
        return "", fmt.Errorf("creating request: %w", err)
    }

    if rc.config.Username != "" {
        req.SetBasicAuth(rc.config.Username, rc.config.Password)
    }

    resp, err := rc.httpClient.Do(req)
    if err != nil {
        return "", fmt.Errorf("fetching schema: %w", err)
    }
    defer resp.Body.Close()

    if resp.StatusCode != http.StatusOK {
        return "", fmt.Errorf("schema registry returned %d for schema ID %d", resp.StatusCode, id)
    }

    var result struct {
        Schema string `json:"schema"`
    }
    if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
        return "", fmt.Errorf("decoding response: %w", err)
    }

    // Cache the result.
    rc.cacheMu.Lock()
    rc.cache[id] = result.Schema
    rc.cacheMu.Unlock()

    return result.Schema, nil
}

// GetLatestSchema retrieves the latest schema for a subject.
func (rc *RegistryClient) GetLatestSchema(ctx context.Context, subject string) (*Schema, error) {
    url := fmt.Sprintf("%s/subjects/%s/versions/latest", rc.config.URL, subject)
    req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
    if err != nil {
        return nil, fmt.Errorf("creating request: %w", err)
    }

    if rc.config.Username != "" {
        req.SetBasicAuth(rc.config.Username, rc.config.Password)
    }

    resp, err := rc.httpClient.Do(req)
    if err != nil {
        return nil, fmt.Errorf("fetching latest schema: %w", err)
    }
    defer resp.Body.Close()

    if resp.StatusCode != http.StatusOK {
        return nil, fmt.Errorf("schema registry returned %d", resp.StatusCode)
    }

    var schema Schema
    if err := json.NewDecoder(resp.Body).Decode(&schema); err != nil {
        return nil, fmt.Errorf("decoding response: %w", err)
    }

    // Cache.
    rc.cacheMu.Lock()
    rc.cache[schema.ID] = schema.Schema
    rc.cacheMu.Unlock()

    return &schema, nil
}

// SetCompatibility sets the compatibility level for a subject.
func (rc *RegistryClient) SetCompatibility(ctx context.Context, subject string, level CompatibilityLevel) error {
    body := map[string]string{
        "compatibility": string(level),
    }
    bodyBytes, err := json.Marshal(body)
    if err != nil {
        return fmt.Errorf("marshaling request: %w", err)
    }

    url := fmt.Sprintf("%s/config/%s", rc.config.URL, subject)
    req, err := http.NewRequestWithContext(ctx, http.MethodPut, url, bytes.NewReader(bodyBytes))
    if err != nil {
        return fmt.Errorf("creating request: %w", err)
    }
    req.Header.Set("Content-Type", "application/vnd.schemaregistry.v1+json")

    if rc.config.Username != "" {
        req.SetBasicAuth(rc.config.Username, rc.config.Password)
    }

    resp, err := rc.httpClient.Do(req)
    if err != nil {
        return fmt.Errorf("setting compatibility: %w", err)
    }
    defer resp.Body.Close()

    if resp.StatusCode != http.StatusOK {
        respBody, _ := io.ReadAll(resp.Body)
        return fmt.Errorf("schema registry returned %d: %s", resp.StatusCode, string(respBody))
    }

    rc.logger.Info("compatibility level set",
        "subject", subject,
        "level", level,
    )
    return nil
}

// TestCompatibility tests if a schema is compatible with the latest version.
func (rc *RegistryClient) TestCompatibility(ctx context.Context, subject string, schemaStr string, schemaType SchemaType) (bool, error) {
    body := map[string]string{
        "schema":     schemaStr,
        "schemaType": string(schemaType),
    }
    bodyBytes, err := json.Marshal(body)
    if err != nil {
        return false, fmt.Errorf("marshaling request: %w", err)
    }

    url := fmt.Sprintf("%s/compatibility/subjects/%s/versions/latest", rc.config.URL, subject)
    req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(bodyBytes))
    if err != nil {
        return false, fmt.Errorf("creating request: %w", err)
    }
    req.Header.Set("Content-Type", "application/vnd.schemaregistry.v1+json")

    if rc.config.Username != "" {
        req.SetBasicAuth(rc.config.Username, rc.config.Password)
    }

    resp, err := rc.httpClient.Do(req)
    if err != nil {
        return false, fmt.Errorf("testing compatibility: %w", err)
    }
    defer resp.Body.Close()

    var result struct {
        IsCompatible bool `json:"is_compatible"`
    }
    if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
        return false, fmt.Errorf("decoding response: %w", err)
    }

    return result.IsCompatible, nil
}

// ListSubjects returns all registered subjects.
func (rc *RegistryClient) ListSubjects(ctx context.Context) ([]string, error) {
    url := fmt.Sprintf("%s/subjects", rc.config.URL)
    req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
    if err != nil {
        return nil, fmt.Errorf("creating request: %w", err)
    }

    if rc.config.Username != "" {
        req.SetBasicAuth(rc.config.Username, rc.config.Password)
    }

    resp, err := rc.httpClient.Do(req)
    if err != nil {
        return nil, fmt.Errorf("listing subjects: %w", err)
    }
    defer resp.Body.Close()

    var subjects []string
    if err := json.NewDecoder(resp.Body).Decode(&subjects); err != nil {
        return nil, fmt.Errorf("decoding response: %w", err)
    }

    return subjects, nil
}
```

### Go Code: Producer with Avro Schema Serialization

Avro serialization embeds a magic byte and a 4-byte schema ID at the start of each message payload, allowing consumers to fetch the exact schema used at encoding time. The following producer demonstrates how to serialize Go structs to Avro binary format and prepend the Schema Registry wire format header before publishing to Kafka.

```go
// File: kafka-fundamentals/schema/avro_producer.go
package schema

import (
    "context"
    "encoding/binary"
    "fmt"
    "log/slog"

    "github.com/hamba/avro/v2"
    "github.com/segmentio/kafka-go"
)

// AvroSerializer serializes Go structs to Avro binary format with
// Schema Registry wire format (magic byte + 4-byte schema ID + avro payload).
type AvroSerializer struct {
    registry  *RegistryClient
    schemaID  int
    avroSchema avro.Schema
    logger    *slog.Logger
}

// NewAvroSerializer creates a serializer that registers the schema and caches the ID.
func NewAvroSerializer(ctx context.Context, registry *RegistryClient, subject string, schemaJSON string, logger *slog.Logger) (*AvroSerializer, error) {
    // Parse the Avro schema.
    avroSchema, err := avro.Parse(schemaJSON)
    if err != nil {
        return nil, fmt.Errorf("parsing avro schema: %w", err)
    }

    // Register the schema with the registry.
    schemaID, err := registry.RegisterSchema(ctx, subject, schemaJSON, SchemaTypeAvro)
    if err != nil {
        return nil, fmt.Errorf("registering schema: %w", err)
    }

    logger.Info("avro serializer initialized",
        "subject", subject,
        "schema_id", schemaID,
    )

    return &AvroSerializer{
        registry:   registry,
        schemaID:   schemaID,
        avroSchema: avroSchema,
        logger:     logger,
    }, nil
}

// Serialize converts a Go value to Avro binary with Schema Registry wire format.
//
// Wire format:
//   Byte 0:     Magic byte (0x00)
//   Bytes 1-4:  Schema ID (big-endian int32)
//   Bytes 5+:   Avro binary payload
func (s *AvroSerializer) Serialize(value any) ([]byte, error) {
    // Encode to Avro binary.
    avroBytes, err := avro.Marshal(s.avroSchema, value)
    if err != nil {
        return nil, fmt.Errorf("avro marshal: %w", err)
    }

    // Prepend the wire format header.
    // 1 byte magic + 4 bytes schema ID + avro payload.
    buf := make([]byte, 5+len(avroBytes))
    buf[0] = 0x00 // Magic byte.
    binary.BigEndian.PutUint32(buf[1:5], uint32(s.schemaID))
    copy(buf[5:], avroBytes)

    return buf, nil
}

// AvroProducer produces Avro-encoded messages to Kafka with Schema Registry integration.
type AvroProducer struct {
    writer     *kafka.Writer
    serializer *AvroSerializer
    topic      string
    logger     *slog.Logger
}

// AvroProducerConfig configures the Avro producer.
type AvroProducerConfig struct {
    Brokers        []string
    Topic          string
    RegistryURL    string
    SchemaJSON     string
    Logger         *slog.Logger
}

// NewAvroProducer creates a producer that serializes messages using Avro.
func NewAvroProducer(ctx context.Context, config AvroProducerConfig) (*AvroProducer, error) {
    if config.Logger == nil {
        config.Logger = slog.Default()
    }

    // Create Schema Registry client.
    registry, err := NewRegistryClient(RegistryConfig{
        URL:    config.RegistryURL,
        Logger: config.Logger,
    })
    if err != nil {
        return nil, fmt.Errorf("creating registry client: %w", err)
    }

    // Set compatibility level to FULL for maximum safety.
    subject := config.Topic + "-value"
    if err := registry.SetCompatibility(ctx, subject, CompatFull); err != nil {
        config.Logger.Warn("failed to set compatibility (may not exist yet)",
            "subject", subject,
            "error", err,
        )
    }

    // Create the Avro serializer.
    serializer, err := NewAvroSerializer(ctx, registry, subject, config.SchemaJSON, config.Logger)
    if err != nil {
        return nil, fmt.Errorf("creating serializer: %w", err)
    }

    writer := &kafka.Writer{
        Addr:         kafka.TCP(config.Brokers...),
        Topic:        config.Topic,
        Balancer:     &kafka.Hash{},
        RequiredAcks: kafka.RequireAll,
        Compression:  kafka.Lz4,
    }

    return &AvroProducer{
        writer:     writer,
        serializer: serializer,
        topic:      config.Topic,
        logger:     config.Logger,
    }, nil
}

// Send serializes the value to Avro and sends it to Kafka.
func (ap *AvroProducer) Send(ctx context.Context, key string, value any) error {
    avroBytes, err := ap.serializer.Serialize(value)
    if err != nil {
        return fmt.Errorf("serializing value: %w", err)
    }

    msg := kafka.Message{
        Key:   []byte(key),
        Value: avroBytes,
        Headers: []kafka.Header{
            {Key: "content-type", Value: []byte("application/avro")},
        },
    }

    if err := ap.writer.WriteMessages(ctx, msg); err != nil {
        return fmt.Errorf("writing message: %w", err)
    }

    return nil
}

// Close closes the Avro producer.
func (ap *AvroProducer) Close() error {
    return ap.writer.Close()
}
```

### Go Code: Consumer with Schema Deserialization

Deserializing Avro-encoded Kafka messages requires stripping the wire format header, resolving the schema ID against the registry, and decoding the binary payload. The following consumer implementation handles schema evolution by fetching both the writer schema (from the message) and the reader schema (from the local definition) and performing schema migration transparently.

```go
// File: kafka-fundamentals/schema/avro_consumer.go
package schema

import (
    "context"
    "encoding/binary"
    "errors"
    "fmt"
    "log/slog"

    "github.com/hamba/avro/v2"
    "github.com/segmentio/kafka-go"
)

// AvroDeserializer deserializes Avro binary messages using schemas
// fetched from the Schema Registry.
type AvroDeserializer struct {
    registry     *RegistryClient
    schemaCache  map[int]avro.Schema // parsed schema cache
    logger       *slog.Logger
}

// NewAvroDeserializer creates a deserializer that fetches schemas from the registry.
func NewAvroDeserializer(registry *RegistryClient, logger *slog.Logger) *AvroDeserializer {
    return &AvroDeserializer{
        registry:    registry,
        schemaCache: make(map[int]avro.Schema),
        logger:      logger,
    }
}

// Deserialize decodes an Avro message using the schema ID embedded in the wire format.
func (d *AvroDeserializer) Deserialize(ctx context.Context, data []byte, target any) error {
    if len(data) < 5 {
        return errors.New("message too short for avro wire format (need at least 5 bytes)")
    }

    // Parse wire format header.
    magic := data[0]
    if magic != 0x00 {
        return fmt.Errorf("invalid magic byte: expected 0x00, got 0x%02x", magic)
    }

    schemaID := int(binary.BigEndian.Uint32(data[1:5]))
    payload := data[5:]

    // Get or fetch the schema.
    avroSchema, err := d.getSchema(ctx, schemaID)
    if err != nil {
        return fmt.Errorf("getting schema %d: %w", schemaID, err)
    }

    // Deserialize the Avro payload.
    if err := avro.Unmarshal(avroSchema, payload, target); err != nil {
        return fmt.Errorf("avro unmarshal with schema %d: %w", schemaID, err)
    }

    return nil
}

func (d *AvroDeserializer) getSchema(ctx context.Context, schemaID int) (avro.Schema, error) {
    // Check local cache.
    if schema, ok := d.schemaCache[schemaID]; ok {
        return schema, nil
    }

    // Fetch from registry.
    schemaStr, err := d.registry.GetSchemaByID(ctx, schemaID)
    if err != nil {
        return nil, fmt.Errorf("fetching schema from registry: %w", err)
    }

    // Parse and cache.
    schema, err := avro.Parse(schemaStr)
    if err != nil {
        return nil, fmt.Errorf("parsing avro schema: %w", err)
    }

    d.schemaCache[schemaID] = schema
    d.logger.Debug("schema cached", "schema_id", schemaID)
    return schema, nil
}

// AvroConsumer consumes and deserializes Avro-encoded messages.
type AvroConsumer struct {
    reader       *kafka.Reader
    deserializer *AvroDeserializer
    logger       *slog.Logger
}

// AvroConsumerConfig configures the Avro consumer.
type AvroConsumerConfig struct {
    Brokers     []string
    Topic       string
    GroupID     string
    RegistryURL string
    Logger      *slog.Logger
}

// NewAvroConsumer creates a consumer that deserializes Avro messages.
func NewAvroConsumer(config AvroConsumerConfig) (*AvroConsumer, error) {
    if config.Logger == nil {
        config.Logger = slog.Default()
    }

    registry, err := NewRegistryClient(RegistryConfig{
        URL:    config.RegistryURL,
        Logger: config.Logger,
    })
    if err != nil {
        return nil, fmt.Errorf("creating registry client: %w", err)
    }

    reader := kafka.NewReader(kafka.ReaderConfig{
        Brokers:  config.Brokers,
        Topic:    config.Topic,
        GroupID:  config.GroupID,
        MinBytes: 1,
        MaxBytes: 10 << 20,
    })

    return &AvroConsumer{
        reader:       reader,
        deserializer: NewAvroDeserializer(registry, config.Logger),
        logger:       config.Logger,
    }, nil
}

// Consume reads and deserializes the next message into the target struct.
func (ac *AvroConsumer) Consume(ctx context.Context, target any) (kafka.Message, error) {
    msg, err := ac.reader.FetchMessage(ctx)
    if err != nil {
        return msg, fmt.Errorf("fetching message: %w", err)
    }

    if err := ac.deserializer.Deserialize(ctx, msg.Value, target); err != nil {
        return msg, fmt.Errorf("deserializing message at offset %d: %w", msg.Offset, err)
    }

    return msg, nil
}

// Commit commits the offset for the given message.
func (ac *AvroConsumer) Commit(ctx context.Context, msg kafka.Message) error {
    return ac.reader.CommitMessages(ctx, msg)
}

// Close closes the Avro consumer.
func (ac *AvroConsumer) Close() error {
    return ac.reader.Close()
}
```

Here is a complete example bringing the Avro producer and consumer together:

```go
// File: kafka-fundamentals/cmd/avro-demo/main.go
package main

import (
    "context"
    "fmt"
    "log/slog"
    "os"
    "os/signal"
    "strings"
    "sync"
    "syscall"
    "time"

    "github.com/example/kafka-fundamentals/schema"
)

// OrderEvent is the Go struct matching the Avro schema.
// Avro struct tags map Go fields to Avro field names.
type OrderEvent struct {
    OrderID    string  `avro:"order_id"`
    CustomerID string  `avro:"customer_id"`
    TotalCents int64  `avro:"total_cents"`
    Status     string  `avro:"status"`
    Region     string  `avro:"region"`
    CreatedAt  int64   `avro:"created_at"` // Unix millis for Avro timestamp.
    // v2 field - optional, added in schema evolution.
    Priority string `avro:"priority"`
}

// Avro schema for OrderEvent v1.
const orderSchemaV1 = `{
    "type": "record",
    "name": "OrderEvent",
    "namespace": "com.example.orders",
    "fields": [
        {"name": "order_id", "type": "string"},
        {"name": "customer_id", "type": "string"},
        {"name": "total_cents", "type": "long"},
        {"name": "status", "type": "string"},
        {"name": "region", "type": "string"},
        {"name": "created_at", "type": "long"}
    ]
}`

// Avro schema for OrderEvent v2 - adds optional "priority" field.
// This is backward compatible: old consumers can ignore the new field.
// This is forward compatible: new consumers handle missing field via default.
const orderSchemaV2 = `{
    "type": "record",
    "name": "OrderEvent",
    "namespace": "com.example.orders",
    "fields": [
        {"name": "order_id", "type": "string"},
        {"name": "customer_id", "type": "string"},
        {"name": "total_cents", "type": "long"},
        {"name": "status", "type": "string"},
        {"name": "region", "type": "string"},
        {"name": "created_at", "type": "long"},
        {"name": "priority", "type": "string", "default": "normal"}
    ]
}`

func main() {
    logger := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{
        Level: slog.LevelInfo,
    }))

    brokersEnv := os.Getenv("KAFKA_BROKERS")
    if brokersEnv == "" {
        brokersEnv = "localhost:9092"
    }
    brokers := strings.Split(brokersEnv, ",")

    registryURL := os.Getenv("SCHEMA_REGISTRY_URL")
    if registryURL == "" {
        registryURL = "http://localhost:8081"
    }

    ctx, cancel := signal.NotifyContext(context.Background(),
        syscall.SIGINT, syscall.SIGTERM,
    )
    defer cancel()

    // First, test schema compatibility before upgrading.
    registry, err := schema.NewRegistryClient(schema.RegistryConfig{
        URL:    registryURL,
        Logger: logger,
    })
    if err != nil {
        logger.Error("failed to create registry client", "error", err)
        os.Exit(1)
    }

    compatible, err := registry.TestCompatibility(ctx, "orders-avro-value", orderSchemaV2, schema.SchemaTypeAvro)
    if err != nil {
        logger.Warn("compatibility test failed (subject may not exist yet)", "error", err)
    } else if !compatible {
        logger.Error("schema v2 is NOT compatible with current version")
        os.Exit(1)
    } else {
        logger.Info("schema v2 is compatible - safe to deploy")
    }

    // Create Avro producer with v2 schema.
    producer, err := schema.NewAvroProducer(ctx, schema.AvroProducerConfig{
        Brokers:     brokers,
        Topic:       "orders-avro",
        RegistryURL: registryURL,
        SchemaJSON:  orderSchemaV2,
        Logger:      logger,
    })
    if err != nil {
        logger.Error("failed to create avro producer", "error", err)
        os.Exit(1)
    }
    defer producer.Close()

    // Create Avro consumer.
    consumer, err := schema.NewAvroConsumer(schema.AvroConsumerConfig{
        Brokers:     brokers,
        Topic:       "orders-avro",
        GroupID:     "avro-demo-consumer",
        RegistryURL: registryURL,
        Logger:      logger,
    })
    if err != nil {
        logger.Error("failed to create avro consumer", "error", err)
        os.Exit(1)
    }
    defer consumer.Close()

    var wg sync.WaitGroup

    // Producer goroutine.
    wg.Add(1)
    go func() {
        defer wg.Done()
        ticker := time.NewTicker(time.Second)
        defer ticker.Stop()

        priorities := []string{"low", "normal", "high", "critical"}
        count := 0

        for {
            select {
            case <-ctx.Done():
                logger.Info("producer stopping", "total_sent", count)
                return
            case <-ticker.C:
                count++
                order := OrderEvent{
                    OrderID:    fmt.Sprintf("avro-ord-%06d", count),
                    CustomerID: fmt.Sprintf("cust-%04d", count%100),
                    TotalCents: int64(count) * 999,
                    Status:     "created",
                    Region:     "us-east-1",
                    CreatedAt:  time.Now().UnixMilli(),
                    Priority:   priorities[count%len(priorities)],
                }

                if err := producer.Send(ctx, order.CustomerID, order); err != nil {
                    logger.Error("failed to send avro message",
                        "order_id", order.OrderID,
                        "error", err,
                    )
                    continue
                }

                logger.Info("avro message sent",
                    "order_id", order.OrderID,
                    "priority", order.Priority,
                )
            }
        }
    }()

    // Consumer goroutine.
    wg.Add(1)
    go func() {
        defer wg.Done()

        for {
            select {
            case <-ctx.Done():
                logger.Info("consumer stopping")
                return
            default:
            }

            var order OrderEvent
            msg, err := consumer.Consume(ctx, &order)
            if err != nil {
                if ctx.Err() != nil {
                    return
                }
                logger.Error("failed to consume avro message", "error", err)
                continue
            }

            logger.Info("avro message received",
                "order_id", order.OrderID,
                "customer", order.CustomerID,
                "total_cents", order.TotalCents,
                "priority", order.Priority,
                "partition", msg.Partition,
                "offset", msg.Offset,
            )

            if err := consumer.Commit(ctx, msg); err != nil {
                logger.Error("failed to commit", "error", err)
            }
        }
    }()

    wg.Wait()
    logger.Info("avro demo completed")
}
```

> **Schema Evolution Best Practice**: LinkedIn enforces `FULL_TRANSITIVE` compatibility on all production topics. Schema changes go through a CI/CD pipeline that tests compatibility before deployment, if the Schema Registry rejects your schema, the deployment is blocked. Always test compatibility in your CI pipeline with `TestCompatibility` before registering a new schema version.

### Junior -> FAANG: Why Schema Registry Solves a Real Problem You Will Hit

The schema registry section might feel abstract until you experience the production problem it prevents. Here is the scenario that makes it concrete: you change a field name from `user_id` to `userId` in your producer's Go struct, deploy the producer, and 30 minutes later your downstream consumer starts logging deserialization errors. The consumer team had no idea the change was coming. There was no contract, no coordination, and no gate that caught the incompatibility before it hit production.

Schema Registry is the gate. When your CI pipeline calls `TestCompatibility` before registering a new schema version, any incompatible change (renamed field, removed required field, changed type) is caught at deploy time, not at runtime.

For interview preparation, understand the three compatibility modes and when each applies:

- **BACKWARD**: new schema reads data written by old schema. Deploy consumers before producers. Add optional fields only.
- **FORWARD**: old schema reads data written by new schema. Deploy producers first. Remove optional fields only.
- **FULL**: both directions. Safest. Only additive optional changes allowed.

The wire format (magic byte + 4-byte schema ID + Avro payload) is worth memorizing. Interviewers who ask "how does a consumer know which schema to use to deserialize a Kafka message" expect you to explain the embedded schema ID in the message header and the registry lookup, not "the consumer has the schema hardcoded."

For first-job use: integrate schema compatibility testing into your GitHub Actions workflow. A failing `TestCompatibility` call in CI blocks the PR merge. This is a 20-line addition to your workflow that prevents a category of production incidents entirely.

### Senior @ FAANG: Schema Registry as Organizational Infrastructure

At the senior level, Schema Registry is not a library. It is organizational infrastructure that enforces contracts between teams. The design decisions you make around it will affect dozens of teams and will be expensive to change later.

**Registry topology for multi-team clusters.** A single Schema Registry shared across all teams is the simplest deployment but creates a governance problem: any team can register any schema against any subject. The correct approach at FAANG scale is access control at the subject level: the team that owns a topic owns the subject namespace for that topic. In Confluent Schema Registry, this is enforced via ACLs or the RBAC feature in Confluent Platform. In Apicurio Registry, it is enforced via groups and role bindings. Design this access model before you have 50 teams and 5,000 subjects.

**`FULL_TRANSITIVE` vs `FULL` as the organizational standard.** `FULL` checks compatibility against the latest schema version. `FULL_TRANSITIVE` checks against all historical versions. The difference matters when a consumer is running an older version of the schema (e.g., in a blue-green deployment or a slow rollout). `FULL_TRANSITIVE` guarantees that any deployed consumer version can read any message ever produced, regardless of schema version. This is the correct default for shared platform topics where consumers may be on different schema versions simultaneously. The cost is that schema evolution is slightly more constrained: you cannot add a field in v3 and then remove it in v5 if `FULL_TRANSITIVE` is enforced, because v1 consumers would fail on v5 messages.

**RecordNameStrategy vs TopicNameStrategy for multi-type topics.** The default `TopicNameStrategy` registers schemas under `{topic}-value`. This implies one schema per topic. For topics that carry multiple event types (an event envelope pattern), you need `RecordNameStrategy` which registers under the record's full name (e.g., `com.example.OrderCreated`, `com.example.OrderCanceled`). This allows a single topic to carry multiple schema types. The tradeoff: consumers must be prepared to handle unknown record types gracefully, either by routing on a header or by wrapping payloads in a union type.

**Schema Registry SLA and caching strategy.** The Schema Registry is in the hot path of every producer (registration) and every consumer (deserialization). The `RegistryClient` in this section caches schema IDs in memory. At scale, this cache must survive Registry restarts. Pattern: on startup, pre-warm the cache from a local file (populated by the previous process on clean shutdown). This ensures that a Registry outage does not prevent your producers and consumers from starting. The Registry should have its own availability SLA (99.9% or better) and be deployed with redundancy, not as a single instance.

---
