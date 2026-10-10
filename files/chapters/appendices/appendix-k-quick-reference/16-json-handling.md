## JSON Handling

The `encoding/json` package handles serialization (marshaling) and deserialization (unmarshaling) of Go values to and from JSON. Struct field tags like `json:"name,omitempty"` control the JSON key names and behavior, only exported (uppercase) fields are included. For streaming JSON over network connections or files, use `json.NewEncoder` and `json.NewDecoder` instead of `Marshal`/`Unmarshal`, since they work directly with `io.Reader` and `io.Writer`. When dealing with JSON of unknown structure, unmarshal into `map[string]any`, but remember that all JSON numbers become `float64` in this case.

```go
import "encoding/json"

// Struct tags
type Person struct {
    Name     string `json:"name"`
    Age      int    `json:"age"`
    Email    string `json:"email,omitempty"`  // Omit if empty
    Password string `json:"-"`                 // Never marshal
    AltName  string `json:"alt_name,omitempty"`
}

// Marshal (struct to JSON)
p := Person{Name: "Alice", Age: 30}
data, err := json.Marshal(p)
// data: []byte(`{"name":"Alice","age":30}`)

// Marshal with indent
data, err := json.MarshalIndent(p, "", "  ")

// Unmarshal (JSON to struct)
data := []byte(`{"name":"Alice","age":30}`)
var p Person
err := json.Unmarshal(data, &p)

// Encode to writer
encoder := json.NewEncoder(os.Stdout)
encoder.Encode(p)

// With indent
encoder.SetIndent("", "  ")

// Decode from reader
decoder := json.NewDecoder(response.Body)
var p Person
err := decoder.Decode(&p)

// Decode multiple values
decoder := json.NewDecoder(reader)
for {
    var p Person
    if err := decoder.Decode(&p); err == io.EOF {
        break
    } else if err != nil {
        return err
    }
    // Process p
}

// Dynamic JSON (map)
var data map[string]any
err := json.Unmarshal(jsonData, &data)

name := data["name"].(string)
age := data["age"].(float64)  // Numbers are float64!

// Check type safely
if name, ok := data["name"].(string); ok {
    // Use name
}

// JSON array
var items []string
err := json.Unmarshal(jsonData, &items)

// Nested structures
type Address struct {
    Street string `json:"street"`
    City   string `json:"city"`
}

type Person struct {
    Name    string  `json:"name"`
    Address Address `json:"address"`
}

// Custom marshaling
type Person struct {
    Name string
    Age  int
}

func (p Person) MarshalJSON() ([]byte, error) {
    return json.Marshal(struct {
        Name string `json:"name"`
        Age  int    `json:"age"`
    }{
        Name: strings.ToUpper(p.Name),
        Age:  p.Age,
    })
}

func (p *Person) UnmarshalJSON(data []byte) error {
    var v struct {
        Name string `json:"name"`
        Age  int    `json:"age"`
    }
    if err := json.Unmarshal(data, &v); err != nil {
        return err
    }
    p.Name = strings.ToLower(v.Name)
    p.Age = v.Age
    return nil
}

// Handle unknown fields
decoder := json.NewDecoder(reader)
decoder.DisallowUnknownFields()  // Error on unknown fields

// Time handling
type Event struct {
    Name string    `json:"name"`
    Time time.Time `json:"time"`
}
// Marshals to RFC3339: "2024-01-15T10:30:00Z"

// Custom time format
type CustomTime time.Time

func (ct CustomTime) MarshalJSON() ([]byte, error) {
    t := time.Time(ct)
    return json.Marshal(t.Format("2006-01-02"))
}

// RawMessage (delay parsing)
type Envelope struct {
    Type string          `json:"type"`
    Data json.RawMessage `json:"data"`
}

var env Envelope
json.Unmarshal(data, &env)

switch env.Type {
case "person":
    var p Person
    json.Unmarshal(env.Data, &p)
case "company":
    var c Company
    json.Unmarshal(env.Data, &c)
}

// Validate JSON
var js json.RawMessage
if err := json.Unmarshal(data, &js); err != nil {
    // Invalid JSON
}

// Pretty print
var prettyJSON bytes.Buffer
json.Indent(&prettyJSON, rawJSON, "", "  ")
fmt.Println(prettyJSON.String())

// Common gotchas
// 1. Exported fields only
type Person struct {
    name string  // Won't be marshaled (lowercase)
    Name string  // Will be marshaled
}

// 2. Pointer vs value
type Person struct {
    Name *string `json:"name,omitempty"`
}
// omitempty works with nil pointers, not empty strings

// 3. Zero values
type Config struct {
    Timeout int `json:"timeout,omitempty"`
}
// Won't omit 0, only if field is missing
```

### json/v2 (Go 1.27)

Go 1.27 promotes `encoding/json/v2` to general availability and reimplements the classic `encoding/json` on top of the v2 engine, so existing code gets faster decoding with no changes. New code can target v2 directly for stricter, faster behavior:

```go
import jsonv2 "encoding/json/v2"

// v2 API: strict by default (case-sensitive field matching,
// duplicate keys rejected), significantly faster decoding
data, err := jsonv2.Marshal(p)
err = jsonv2.Unmarshal(data, &p)

// Options replace the v1 sentinel behaviors
data, err = jsonv2.Marshal(p, jsonv2.Deterministic(true))

// Escape hatch during migration if v1-on-v2 surfaces an edge case:
// build with GOEXPERIMENT=nojsonv2
```

---
