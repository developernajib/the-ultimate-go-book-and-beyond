## 10C.16 JSON Marshaling Disasters

Go's `encoding/json` package has several silent behaviors that can cause data loss or corruption. Unexported struct fields (those starting with a lowercase letter) are completely ignored during marshaling and unmarshaling, no error, no warning. Large integers lose precision because JSON numbers are decoded as `float64` by default. Nil pointers marshal to `null` instead of `{}`, which can break API contracts. Understanding these traps is critical for any Go service that communicates via JSON. Note that `encoding/json/v2`, GA in Go 1.27, fixes some of them and leaves others exactly as they are: unexported fields are still invisible, numbers into `any` are still float64, and a nil pointer still marshals to `null`. Migrating is not a substitute for knowing what follows.

```go
package main

import (
    "encoding/json"
    "fmt"
    "time"
)

// TRAP 1: Unexported fields are silently ignored
type User struct {
    Name     string     // exported, so it is serialized
    age      int        // unexported, so the json package cannot see it at all
    Password string `json:"-"` // exported but explicitly excluded
}

func main() {
    u := User{Name: "Alice", age: 30}
    b, _ := json.Marshal(u)
    fmt.Println(string(b)) // {"Name":"Alice"}, age is gone

    // Unmarshal ignores unexported fields just as silently
    var u2 User
    json.Unmarshal([]byte(`{"Name":"Bob","age":25}`), &u2)
    fmt.Println(u2.age) // 0, the payload had 25 and nobody complained

    // TRAP 2: a pointer-receiver MarshalJSON is skipped for value operands
    silent, _ := json.Marshal(Temp{C: 100})
    fmt.Println(string(silent)) // {"C":100}, MarshalJSON never ran
    called, _ := json.Marshal(&Temp{C: 100})
    fmt.Println(string(called)) // "100C", MarshalJSON ran
    // The value-receiver version works either way:
    good, _ := json.Marshal([]GoodTemp{{C: 100}})
    fmt.Println(string(good)) // ["100C"]

    // TRAP 3: json.Number vs float64 for large integers
    data := `{"id": 12345678901234567890}` // exceeds float64 precision!
    var result map[string]any
    json.Unmarshal([]byte(data), &result)
    fmt.Println(result["id"]) // 1.2345678901234568e+19, the low digits are gone
    // Note this is silent and lossy in both directions: marshal that value
    // back out and you ship a different number than you received. Any ID
    // above 2^53 from an external system is at risk.

    // CORRECT: json.Number keeps the literal text, deferring the decision
    var result2 map[string]json.Number
    json.Unmarshal([]byte(data), &result2)
    fmt.Println(result2["id"]) // 12345678901234567890, exact
    // For a decoder, the equivalent is dec.UseNumber() before Decode.
    // Best of all: give the field a real type. `ID uint64` decodes exactly
    // and errors loudly on overflow instead of rounding.

    // TRAP 4: time.Time round-trips the offset, not the location.
    now := time.Now()
    b2, _ := json.Marshal(now)
    fmt.Println(string(b2)) // "2024-03-15T10:30:00.123456789-05:00", RFC3339Nano
    // Unmarshaling that gives a time with a fixed -05:00 zone, NOT
    // America/New_York. The zone name and its DST rules are not in the
    // payload and cannot be recovered from it. If the location matters to
    // your domain, carry the IANA name in a separate field.

    // TRAP 5: marshaling a nil pointer gives "null", not {}
    var p *User
    b3, _ := json.Marshal(p)
    fmt.Println(string(b3)) // null, not {} and not an error

    // TRAP 6: Integer fields become float64 when unmarshaling into interface{}
    var m map[string]any
    json.Unmarshal([]byte(`{"count":42}`), &m)
    count := m["count"]
    fmt.Printf("%T %v\n", count, count) // float64 42, not int 42
    // Type assertion to int will PANIC:
    // count.(int) // panic: interface {} is float64, not int
    // CORRECT:
    countFloat := count.(float64)
    countInt := int(countFloat) // safe two-step conversion
    fmt.Println(countInt)       // 42
}

// TRAP 2 illustrated: value receiver vs pointer receiver.
//
// A method with a pointer receiver is in *Temp's method set, not Temp's.
// json.Marshal reflects over the value it was handed, so passing a Temp
// finds no MarshalJSON and falls back to default struct encoding. No error,
// no warning, just quietly wrong output. Passing &Temp finds it.
//
// This bites hardest when the type is nested: a []Temp or a struct field of
// type Temp gives the encoder values, not pointers, so a custom marshaler
// that works in your unit test on &Temp{} silently stops working in the
// payload that actually ships.
//
// The rule: define MarshalJSON on a VALUE receiver. Then it is in both
// method sets and works everywhere. This is exactly what time.Time does,
// which is why time.Time and *time.Time both marshal correctly.
type Temp struct {
    C int
}

// BUG: pointer receiver, so Temp{} does not implement json.Marshaler
func (t *Temp) MarshalJSON() ([]byte, error) {
    return json.Marshal(fmt.Sprintf("%dC", t.C))
}

// FIXED: value receiver, so both GoodTemp and *GoodTemp implement it
type GoodTemp struct {
    C int
}

func (t GoodTemp) MarshalJSON() ([]byte, error) {
    return json.Marshal(fmt.Sprintf("%dC", t.C))
}
```

---
