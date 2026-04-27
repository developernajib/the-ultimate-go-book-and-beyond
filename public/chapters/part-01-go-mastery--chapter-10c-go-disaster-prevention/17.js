export default `## 10C.16 JSON Marshaling Disasters

Go's \`encoding/json\` package has several silent behaviors that can cause data loss or corruption. Unexported struct fields (those starting with a lowercase letter) are completely ignored during marshaling and unmarshaling, no error, no warning. Large integers lose precision because JSON numbers are decoded as \`float64\` by default. Nil pointers marshal to \`null\` instead of \`{}\`, which can break API contracts. Understanding these traps is critical for any Go service that communicates via JSON.

\`\`\`go
package main

import (
    "encoding/json"
    "fmt"
    "time"
)

// TRAP 1: Unexported fields are silently ignored
type User struct {
    Name     string // exported - serialized
    age      int    // unexported - silently IGNORED by json package!
    Password string \`json:"-"\` // explicitly excluded
}

func main() {
    u := User{Name: "Alice", age: 30}
    b, _ := json.Marshal(u)
    fmt.Println(string(b)) // {"Name":"Alice"} - age is missing!

    // Unmarshal also silently ignores unexported fields
    var u2 User
    json.Unmarshal([]byte(\`{"Name":"Bob","age":25}\`), &u2)
    fmt.Println(u2.age) // 0 - age was NOT parsed, silently!

    // TRAP 2: Pointer vs value receiver for MarshalJSON
    badJSON, _ := json.Marshal(BadTime{T: time.Now()})
    fmt.Println(string(badJSON))

    // TRAP 3: json.Number vs float64 for large integers
    data := \`{"id": 12345678901234567890}\` // exceeds float64 precision!
    var result map[string]any
    json.Unmarshal([]byte(data), &result)
    fmt.Println(result["id"]) // 1.2345678901234568e+19 - precision lost!

    // CORRECT: Use json.Number or Decoder with UseNumber
    var result2 map[string]json.Number
    json.Unmarshal([]byte(data), &result2)
    fmt.Println(result2["id"]) // 12345678901234567890 - exact string preserved

    // TRAP 4: time.Time marshals as RFC3339, but ParseInLocation issues
    now := time.Now()
    b2, _ := json.Marshal(now)
    fmt.Println(string(b2)) // "2024-03-15T10:30:00.123456789-05:00" - includes TZ

    // TRAP 5: Marshaling a nil pointer gives "null", not {}
    var p *User
    b3, _ := json.Marshal(p)
    fmt.Println(string(b3)) // null - not {} or error

    // TRAP 6: Integer fields become float64 when unmarshaling into interface{}
    var m map[string]any
    json.Unmarshal([]byte(\`{"count":42}\`), &m)
    count := m["count"]
    fmt.Printf("%T %v\\n", count, count) // float64 42 - NOT int 42!
    // Type assertion to int will PANIC:
    // count.(int) // panic: interface {} is float64, not int
    // CORRECT:
    countFloat := count.(float64)
    countInt := int(countFloat) // safe two-step conversion
    fmt.Println(countInt)       // 42
}

// TRAP 2 illustrated: value receiver vs pointer receiver
type BadTime struct {
    T time.Time
}

type GoodTime struct {
    T time.Time
}

// time.Time's MarshalJSON has pointer receiver - value copy doesn't get it
// (time.Time actually works with values, but custom marshalers might not)
func (g GoodTime) MarshalJSON() ([]byte, error) {
    return json.Marshal(struct {
        T string \`json:"t"\`
    }{T: g.T.Format(time.RFC3339)})
}
\`\`\`

---
`;
