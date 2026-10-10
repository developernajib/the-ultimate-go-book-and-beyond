## 7. encoding/json Package

### Basic Marshaling and Unmarshaling

`json.Marshal` converts a Go value to a JSON byte slice. `json.Unmarshal` does the reverse. Struct field tags control the JSON key names, omission of empty fields, and string-encoded numbers.

```go
package main

import (
    "encoding/json"
    "fmt"
)

type User struct {
    ID       int    `json:"id"`
    Username string `json:"username"`
    Email    string `json:"email"`
    Active   bool   `json:"active"`
}

func basicJSONExample() {
    // Marshal (struct to JSON)
    user := User{
        ID:       1,
        Username: "alice",
        Email:    "alice@example.com",
        Active:   true,
    }

    data, err := json.Marshal(user)
    if err != nil {
        panic(err)
    }
    fmt.Println(string(data))
    // {"id":1,"username":"alice","email":"alice@example.com","active":true}

    // MarshalIndent (pretty print)
    pretty, _ := json.MarshalIndent(user, "", "  ")
    fmt.Println(string(pretty))

    // Unmarshal (JSON to struct)
    jsonStr := `{"id":2,"username":"bob","email":"bob@example.com","active":false}`
    var user2 User
    err = json.Unmarshal([]byte(jsonStr), &user2)
    if err != nil {
        panic(err)
    }
    fmt.Printf("%+v\n", user2)
}
```

### Struct Tags Reference

```go
package main

import (
    "encoding/json"
    "fmt"
)

type Product struct {
    // Rename field in JSON
    ID int `json:"product_id"`

    // Omit if empty (zero value)
    Description string `json:"description,omitempty"`

    // Always omit from JSON
    InternalCode string `json:"-"`

    // Keep field name but omit if empty
    Tags []string `json:",omitempty"`

    // Embedded struct (flattened)
    Metadata

    // Embedded struct (as nested object)
    Details Details `json:"details"`

    // Pointer to distinguish between not set and zero value
    Price *float64 `json:"price,omitempty"`

    // String type for numbers (useful for precision)
    Amount json.Number `json:"amount"`
}

type Metadata struct {
    CreatedAt string `json:"created_at"`
    UpdatedAt string `json:"updated_at"`
}

type Details struct {
    Weight float64 `json:"weight"`
    Color  string  `json:"color"`
}

func structTagsExample() {
    price := 99.99
    p := Product{
        ID:           1,
        Description:  "", // Will be omitted
        InternalCode: "SECRET", // Will be omitted
        Tags:         nil, // Will be omitted
        Metadata: Metadata{
            CreatedAt: "2024-01-01",
            UpdatedAt: "2024-01-02",
        },
        Details: Details{
            Weight: 1.5,
            Color:  "red",
        },
        Price:  &price,
        Amount: "123.45",
    }

    data, _ := json.MarshalIndent(p, "", "  ")
    fmt.Println(string(data))
}
```

### Custom Marshaling

```go
package main

import (
    "encoding/json"
    "fmt"
    "time"
)

// Custom time format
type CustomTime struct {
    time.Time
}

func (ct CustomTime) MarshalJSON() ([]byte, error) {
    formatted := ct.Format("2006-01-02")
    return json.Marshal(formatted)
}

func (ct *CustomTime) UnmarshalJSON(data []byte) error {
    var s string
    if err := json.Unmarshal(data, &s); err != nil {
        return err
    }

    t, err := time.Parse("2006-01-02", s)
    if err != nil {
        return err
    }

    ct.Time = t
    return nil
}

// Custom enum marshaling
type Status int

const (
    StatusPending Status = iota
    StatusActive
    StatusInactive
)

func (s Status) MarshalJSON() ([]byte, error) {
    names := []string{"pending", "active", "inactive"}
    if s < 0 || int(s) >= len(names) {
        return nil, fmt.Errorf("invalid status: %d", s)
    }
    return json.Marshal(names[s])
}

func (s *Status) UnmarshalJSON(data []byte) error {
    var str string
    if err := json.Unmarshal(data, &str); err != nil {
        return err
    }

    switch str {
    case "pending":
        *s = StatusPending
    case "active":
        *s = StatusActive
    case "inactive":
        *s = StatusInactive
    default:
        return fmt.Errorf("invalid status: %s", str)
    }
    return nil
}

type Event struct {
    Date   CustomTime `json:"date"`
    Status Status     `json:"status"`
}

func customMarshalingExample() {
    event := Event{
        Date:   CustomTime{time.Now()},
        Status: StatusActive,
    }

    data, _ := json.MarshalIndent(event, "", "  ")
    fmt.Println(string(data))

    // Unmarshal
    jsonStr := `{"date":"2024-01-15","status":"active"}`
    var event2 Event
    json.Unmarshal([]byte(jsonStr), &event2)
    fmt.Printf("%+v\n", event2)
}
```

### Streaming JSON

```go
package main

import (
    "encoding/json"
    "os"
    "strings"
)

func streamingEncoderExample() {
    // Write to file
    file, _ := os.Create("users.json")
    defer file.Close()

    encoder := json.NewEncoder(file)
    encoder.SetIndent("", "  ") // Pretty print

    users := []User{
        {ID: 1, Username: "alice", Email: "alice@example.com", Active: true},
        {ID: 2, Username: "bob", Email: "bob@example.com", Active: false},
    }

    for _, user := range users {
        if err := encoder.Encode(user); err != nil {
            panic(err)
        }
    }
}

func streamingDecoderExample() {
    // Read from string (could be file, network, etc.)
    jsonStream := `
        {"id":1,"username":"alice","email":"alice@example.com","active":true}
        {"id":2,"username":"bob","email":"bob@example.com","active":false}
    `

    decoder := json.NewDecoder(strings.NewReader(jsonStream))

    for decoder.More() {
        var user User
        if err := decoder.Decode(&user); err != nil {
            panic(err)
        }
        // fmt.Printf("Decoded: %+v\n", user)
    }
}

// Large array streaming
func streamLargeArray() {
    jsonData := `[
        {"id":1,"username":"user1"},
        {"id":2,"username":"user2"},
        {"id":3,"username":"user3"}
    ]`

    decoder := json.NewDecoder(strings.NewReader(jsonData))

    // Read opening bracket
    _, _ = decoder.Token()

    // Stream array elements
    for decoder.More() {
        var user User
        decoder.Decode(&user)
        // Process user without loading entire array
    }

    // Read closing bracket
    _, _ = decoder.Token()
}
```

### json.RawMessage

```go
package main

import (
    "encoding/json"
    "fmt"
)

type Config struct {
    Type   string          `json:"type"`
    Config json.RawMessage `json:"config"` // Delay parsing
}

type DatabaseConfig struct {
    Host string `json:"host"`
    Port int    `json:"port"`
}

type CacheConfig struct {
    TTL int `json:"ttl"`
}

func rawMessageExample() {
    jsonStr := `{
        "type": "database",
        "config": {"host": "localhost", "port": 5432}
    }`

    var cfg Config
    json.Unmarshal([]byte(jsonStr), &cfg)

    // Parse config based on type
    switch cfg.Type {
    case "database":
        var dbCfg DatabaseConfig
        json.Unmarshal(cfg.Config, &dbCfg)
        fmt.Printf("Database: %+v\n", dbCfg)
    case "cache":
        var cacheCfg CacheConfig
        json.Unmarshal(cfg.Config, &cacheCfg)
        fmt.Printf("Cache: %+v\n", cacheCfg)
    }
}

// Conditional marshaling
type Response struct {
    Success bool            `json:"success"`
    Data    json.RawMessage `json:"data,omitempty"`
    Error   string          `json:"error,omitempty"`
}

func conditionalMarshalingExample() {
    // Success response
    userData, _ := json.Marshal(map[string]any{
        "id":   1,
        "name": "Alice",
    })

    resp := Response{
        Success: true,
        Data:    userData,
    }

    output, _ := json.MarshalIndent(resp, "", "  ")
    fmt.Println(string(output))
}
```

### Handling Unknown Fields

```go
package main

import (
    "encoding/json"
    "fmt"
)

// Disallow unknown fields (strict parsing)
func strictUnmarshalExample() {
    type Person struct {
        Name string `json:"name"`
        Age  int    `json:"age"`
    }

    jsonStr := `{"name":"Alice","age":30,"extra":"field"}`

    decoder := json.NewDecoder(strings.NewReader(jsonStr))
    decoder.DisallowUnknownFields() // Enable strict mode

    var p Person
    err := decoder.Decode(&p)
    if err != nil {
        fmt.Println("Error:", err) // json: unknown field "extra"
    }
}

// Capture unknown fields
type FlexibleUser struct {
    ID       int                    `json:"id"`
    Username string                 `json:"username"`
    Extra    map[string]any `json:"-"` // Capture unknowns
}

func (fu *FlexibleUser) UnmarshalJSON(data []byte) error {
    // First, unmarshal into a map
    var m map[string]any
    if err := json.Unmarshal(data, &m); err != nil {
        return err
    }

    // Extract known fields
    if id, ok := m["id"].(float64); ok {
        fu.ID = int(id)
    }
    if username, ok := m["username"].(string); ok {
        fu.Username = username
    }

    // Store everything else
    fu.Extra = make(map[string]any)
    for k, v := range m {
        if k != "id" && k != "username" {
            fu.Extra[k] = v
        }
    }

    return nil
}
```

### Go 1.27: json/v2

Everything above continues to work unchanged in Go 1.27, and gets faster: the classic `encoding/json` is now implemented on top of the `encoding/json/v2` engine, which reached general availability in 1.27. New code can import `encoding/json/v2` directly for stricter semantics (case-sensitive field matching, duplicate-key rejection) and better performance. Chapter 10B covers the migration posture in depth.

---
