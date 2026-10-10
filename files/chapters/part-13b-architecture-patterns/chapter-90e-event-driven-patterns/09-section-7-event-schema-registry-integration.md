## 90E.8 Event Schema Registry Integration

A schema registry provides a central catalog of all event schemas so that producers and consumers can agree on message format without embedding schema definitions inside every service binary. Confluent Schema Registry is the most widely adopted implementation and uses a compact wire format: a 5-byte prefix containing a magic byte and a 4-byte schema ID is prepended to every message, allowing consumers to fetch the correct schema on first encounter and cache it locally thereafter. The `SchemaRegistry` client below implements this lookup with a read-through in-memory cache keyed on schema ID, which means the HTTP round-trip to the registry is paid only once per unique schema version over the life of the process.

```go
package schemaregistry

import (
	"bytes"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"sync"
)

// SchemaRegistry client for Confluent Schema Registry
type SchemaRegistry struct {
	baseURL string
	client  *http.Client
	mu      sync.RWMutex
	cache   map[int]string // schemaID -> schema JSON
}

type SchemaResponse struct {
	ID      int    `json:"id"`
	Schema  string `json:"schema"`
	Subject string `json:"subject"`
	Version int    `json:"version"`
}

func NewSchemaRegistry(baseURL string) *SchemaRegistry {
	return &SchemaRegistry{
		baseURL: baseURL,
		client:  &http.Client{},
		cache:   make(map[int]string),
	}
}

// GetSchema retrieves a schema by ID
func (r *SchemaRegistry) GetSchema(id int) (string, error) {
	r.mu.RLock()
	if schema, ok := r.cache[id]; ok {
		r.mu.RUnlock()
		return schema, nil
	}
	r.mu.RUnlock()

	resp, err := r.client.Get(fmt.Sprintf("%s/schemas/ids/%d", r.baseURL, id))
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()

	body, _ := io.ReadAll(resp.Body)
	var sr SchemaResponse
	if err := json.Unmarshal(body, &sr); err != nil {
		return "", err
	}

	r.mu.Lock()
	r.cache[id] = sr.Schema
	r.mu.Unlock()

	return sr.Schema, nil
}

// RegisterSchema registers a new schema version
func (r *SchemaRegistry) RegisterSchema(subject, schema string) (int, error) {
	body, _ := json.Marshal(map[string]string{"schema": schema})

	resp, err := r.client.Post(
		fmt.Sprintf("%s/subjects/%s/versions", r.baseURL, subject),
		"application/vnd.schemaregistry.v1+json",
		bytes.NewReader(body),
	)
	if err != nil {
		return 0, err
	}
	defer resp.Body.Close()

	var result struct {
		ID int `json:"id"`
	}
	json.NewDecoder(resp.Body).Decode(&result)
	return result.ID, nil
}

// Confluent wire format: [0x00][4-byte schema ID][Avro/JSON payload]
func EncodeWithSchemaID(schemaID int, payload []byte) []byte {
	buf := make([]byte, 5+len(payload))
	buf[0] = 0x00 // Magic byte
	binary.BigEndian.PutUint32(buf[1:5], uint32(schemaID))
	copy(buf[5:], payload)
	return buf
}

func DecodeWithSchemaID(data []byte) (schemaID int, payload []byte, err error) {
	if len(data) < 5 {
		return 0, nil, fmt.Errorf("invalid confluent format: too short")
	}
	if data[0] != 0x00 {
		return 0, nil, fmt.Errorf("invalid magic byte: %x", data[0])
	}
	schemaID = int(binary.BigEndian.Uint32(data[1:5]))
	return schemaID, data[5:], nil
}
```

---
