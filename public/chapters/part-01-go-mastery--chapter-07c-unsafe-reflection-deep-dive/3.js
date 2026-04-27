export default `## 7C.2 The reflect Package

### Core Types: reflect.Type and reflect.Value

The \`reflect\` package is built around two types. \`reflect.Type\` represents a Go type, its kind, name, fields, methods, and layout. \`reflect.Value\` holds a concrete value alongside its type information, letting you read fields, call methods, and modify data without knowing the static type at compile time. You obtain them with \`reflect.TypeOf(x)\` and \`reflect.ValueOf(x)\` respectively, both of which accept an \`any\` parameter.

\`\`\`
┌──────────────────────────────────────────────────────────────────────┐
│                   reflect Package Overview                            │
├──────────────────────────────────────────────────────────────────────┤
│                                                                       │
│  reflect.TypeOf(x)  → reflect.Type                                  │
│    Describes the TYPE of a value                                     │
│    - Kind() - base kind: Int, String, Struct, Slice, Ptr...         │
│    - Name() - type name (e.g., "User")                              │
│    - NumField(), Field(i) - struct fields                           │
│    - NumMethod(), Method(i) - methods                               │
│    - Elem() - element type of Ptr, Slice, Array, Chan, Map          │
│    - Key() - key type of Map                                        │
│                                                                       │
│  reflect.ValueOf(x) → reflect.Value                                 │
│    Holds the VALUE of a variable                                     │
│    - Kind() - same as Type.Kind()                                   │
│    - Int(), String(), Bool(), Float() - extract primitive values    │
│    - Elem() - dereference pointer or interface                      │
│    - Field(i) - access struct field value                           │
│    - Index(i) - access slice/array element                          │
│    - MapIndex(key) - access map value                               │
│    - Call(args) - call function                                     │
│    - Set*(v) - set value (requires CanSet())                        │
│                                                                       │
│  reflect.New(t) - creates *T, returns Value of the pointer          │
│  reflect.Zero(t) - zero value of type t                             │
│  reflect.MakeSlice(t, len, cap) - creates a new slice               │
│  reflect.MakeMap(t) - creates a new map                             │
└──────────────────────────────────────────────────────────────────────┘
\`\`\`

### reflect.Type in Detail

\`reflect.Type\` exposes everything the compiler knows about a type: its kind (struct, slice, map, etc.), name, package path, size, alignment, and method set. For struct types, you can iterate fields, read their tags, and check whether they are exported. For container types like slices and maps, \`Elem()\` and \`Key()\` reveal the element and key types. The following example shows the most common \`reflect.Type\` operations and how to check interface implementation at runtime.

\`\`\`go
package main

import (
    "fmt"
    "reflect"
    "time"
)

type Address struct {
    Street string
    City   string \`json:"city" validate:"required"\`
    Zip    string \`json:"zip,omitempty"\`
}

type User struct {
    ID        int
    Name      string    \`json:"name"\`
    Email     string    \`json:"email,omitempty"\`
    CreatedAt time.Time \`json:"created_at"\`
    Address   Address
    Tags      []string
    Scores    map[string]int
    parent    *User // unexported
}

func inspectType(v any) {
    t := reflect.TypeOf(v)

    // If v is a pointer, get the underlying type
    if t.Kind() == reflect.Ptr {
        fmt.Printf("Pointer to: %s\\n", t.Elem().Name())
        t = t.Elem()
    }

    fmt.Printf("Type: %s, Kind: %s, PkgPath: %s\\n", t.Name(), t.Kind(), t.PkgPath())

    if t.Kind() != reflect.Struct {
        return
    }

    fmt.Printf("Fields (%d):\\n", t.NumField())
    for i := range t.NumField() {
        f := t.Field(i)
        fmt.Printf("  [%d] %-12s  type=%-20s exported=%-5v  tag=%q\\n",
            i, f.Name, f.Type, f.IsExported(), f.Tag)

        // Parse specific tags
        if jsonTag := f.Tag.Get("json"); jsonTag != "" {
            fmt.Printf("       json tag: %q\\n", jsonTag)
        }
        if validateTag := f.Tag.Get("validate"); validateTag != "" {
            fmt.Printf("       validate: %q\\n", validateTag)
        }
    }

    fmt.Printf("Methods (%d):\\n", t.NumMethod())
    for i := range t.NumMethod() {
        m := t.Method(i)
        fmt.Printf("  [%d] %s %s\\n", i, m.Name, m.Type)
    }
}

func main() {
    inspectType(User{})
    fmt.Println()
    inspectType(&User{})

    // Type comparisons
    t1 := reflect.TypeOf(int(0))
    t2 := reflect.TypeOf(int64(0))
    fmt.Println(t1 == t2) // false
    fmt.Println(t1.Kind() == t2.Kind()) // false: Int vs Int64

    // Checking if a type implements an interface
    errorType := reflect.TypeOf((*error)(nil)).Elem()
    userPtrType := reflect.TypeOf(&User{})
    fmt.Println(userPtrType.Implements(errorType)) // false

    // Slice/Map element type inspection
    sliceType := reflect.TypeOf([]string{})
    fmt.Println(sliceType.Kind())     // slice
    fmt.Println(sliceType.Elem())     // string

    mapType := reflect.TypeOf(map[string]int{})
    fmt.Println(mapType.Key())        // string
    fmt.Println(mapType.Elem())       // int
}
\`\`\`

### reflect.Value in Detail

While \`reflect.Type\` describes what a value is, \`reflect.Value\` wraps the value itself. It provides type-specific extraction methods (\`Int()\`, \`String()\`, \`Bool()\`) and general-purpose operations like \`Len()\`, \`Index()\`, and \`MapKeys()\`. The \`Kind()\` method on \`reflect.Value\` returns the same kind as the underlying type, so you can switch on it to handle each category of value differently. This pattern forms the core of every reflect-based library.

\`\`\`go
package main

import (
    "fmt"
    "reflect"
)

type Point struct {
    X, Y float64
}

func (p Point) Distance() float64 {
    return p.X*p.X + p.Y*p.Y
}

func inspectValue(v any) {
    rv := reflect.ValueOf(v)
    fmt.Printf("Value: %v, Kind: %s, Type: %s\\n", rv, rv.Kind(), rv.Type())

    switch rv.Kind() {
    case reflect.Int, reflect.Int8, reflect.Int16, reflect.Int32, reflect.Int64:
        fmt.Printf("  int value: %d\\n", rv.Int())
    case reflect.String:
        fmt.Printf("  string value: %q\\n", rv.String())
    case reflect.Float64, reflect.Float32:
        fmt.Printf("  float value: %f\\n", rv.Float())
    case reflect.Bool:
        fmt.Printf("  bool value: %v\\n", rv.Bool())
    case reflect.Slice:
        fmt.Printf("  slice len=%d cap=%d\\n", rv.Len(), rv.Cap())
        for i := range rv.Len() {
            fmt.Printf("    [%d] %v\\n", i, rv.Index(i))
        }
    case reflect.Map:
        fmt.Printf("  map len=%d\\n", rv.Len())
        for _, key := range rv.MapKeys() {
            fmt.Printf("    %v → %v\\n", key, rv.MapIndex(key))
        }
    case reflect.Struct:
        fmt.Printf("  struct with %d fields\\n", rv.NumField())
        t := rv.Type()
        for i := range rv.NumField() {
            f := rv.Field(i)
            fmt.Printf("    %s = %v\\n", t.Field(i).Name, f)
        }
    case reflect.Ptr:
        if rv.IsNil() {
            fmt.Println("  nil pointer")
        } else {
            fmt.Println("  pointer, dereferencing:")
            inspectValue(rv.Elem().Interface())
        }
    }
}

func main() {
    inspectValue(42)
    inspectValue("hello")
    inspectValue([]int{1, 2, 3})
    inspectValue(map[string]int{"a": 1, "b": 2})
    inspectValue(Point{3, 4})
    inspectValue(&Point{1, 2})
}
\`\`\`

### Setting Values with reflect (CanSet Rule)

Modifying values through reflection requires the value to be addressable, meaning it was obtained by reflecting on a pointer and then dereferencing it. The \`CanSet\` method must return true before calling \`Set\`.

\`\`\`go
package main

import (
    "fmt"
    "reflect"
)

type Config struct {
    Host    string
    Port    int
    Debug   bool
    timeout int // unexported - cannot be set via reflect
}

func setFieldByName(structPtr any, fieldName string, value any) error {
    rv := reflect.ValueOf(structPtr)
    if rv.Kind() != reflect.Ptr || rv.Elem().Kind() != reflect.Struct {
        return fmt.Errorf("structPtr must be a pointer to struct")
    }

    rv = rv.Elem() // dereference pointer to get to the struct
    field := rv.FieldByName(fieldName)

    if !field.IsValid() {
        return fmt.Errorf("field %q not found", fieldName)
    }
    if !field.CanSet() {
        // CanSet is false for unexported fields and non-addressable values
        return fmt.Errorf("field %q cannot be set (unexported?)", fieldName)
    }

    val := reflect.ValueOf(value)
    if field.Type() != val.Type() {
        // Try to convert if possible
        if val.Type().ConvertibleTo(field.Type()) {
            val = val.Convert(field.Type())
        } else {
            return fmt.Errorf("type mismatch: field is %s, value is %s",
                field.Type(), val.Type())
        }
    }

    field.Set(val)
    return nil
}

func main() {
    cfg := &Config{Host: "localhost", Port: 8080}

    setFieldByName(cfg, "Host", "production.example.com")
    setFieldByName(cfg, "Port", 443)
    setFieldByName(cfg, "Debug", true)

    err := setFieldByName(cfg, "timeout", 30) // unexported - will fail
    fmt.Println("Error setting timeout:", err)

    fmt.Printf("Config: %+v\\n", *cfg)
    // Config: {Host:production.example.com Port:443 Debug:true timeout:0}

    // CanSet requires the value to be addressable
    // Non-pointer: cannot set
    v := reflect.ValueOf(Config{})
    fmt.Println(v.Field(0).CanSet()) // false - not addressable

    // Pointer: can set
    v2 := reflect.ValueOf(&Config{}).Elem()
    fmt.Println(v2.Field(0).CanSet()) // true - addressable (pointer → deref)
}
\`\`\`

### Calling Functions Dynamically

When you receive a function through a plugin system, RPC handler registry, or command dispatcher, you may not know its signature at compile time. \`reflect.Value.Call\` handles this: it takes a slice of \`reflect.Value\` arguments, validates their types against the function's signature, invokes the function, and returns results as a \`reflect.Value\` slice. For methods, the receiver counts as the first argument when calling through \`reflect.Type.Method().Func\`.

\`\`\`go
package main

import (
    "fmt"
    "reflect"
)

func Add(a, b int) int { return a + b }
func Greet(name string) string { return "Hello, " + name }

type Calculator struct{ name string }
func (c Calculator) Multiply(a, b int) int { return a * b }
func (c *Calculator) SetName(name string) { c.name = name }

func callFunction(fn any, args ...any) []any {
    fnVal := reflect.ValueOf(fn)
    if fnVal.Kind() != reflect.Func {
        panic("not a function")
    }

    fnType := fnVal.Type()
    if fnType.NumIn() != len(args) {
        panic(fmt.Sprintf("expected %d args, got %d", fnType.NumIn(), len(args)))
    }

    // Convert args to reflect.Value
    argVals := make([]reflect.Value, len(args))
    for i, arg := range args {
        argVals[i] = reflect.ValueOf(arg)
        // Convert if types don't match exactly
        if argVals[i].Type() != fnType.In(i) {
            argVals[i] = argVals[i].Convert(fnType.In(i))
        }
    }

    // Call the function
    results := fnVal.Call(argVals)

    // Convert results back to interface{}
    out := make([]any, len(results))
    for i, r := range results {
        out[i] = r.Interface()
    }
    return out
}

func main() {
    // Call regular functions
    result := callFunction(Add, 3, 4)
    fmt.Println(result[0]) // 7

    result2 := callFunction(Greet, "World")
    fmt.Println(result2[0]) // Hello, World

    // Call method on struct
    calc := Calculator{name: "calc"}
    calcType := reflect.TypeOf(calc)
    method, _ := calcType.MethodByName("Multiply")
    // Method call needs the receiver as the first argument
    results := method.Func.Call([]reflect.Value{
        reflect.ValueOf(calc),
        reflect.ValueOf(5),
        reflect.ValueOf(6),
    })
    fmt.Println(results[0].Int()) // 30
}
\`\`\`

### Struct Tags: Definition, Parsing, and Building Validators

Struct tags are raw string literals attached to struct fields, formatted as space-separated \`key:"value"\` pairs. The standard library's \`encoding/json\`, \`encoding/xml\`, and \`database/sql\` packages all read struct tags to control field naming and behavior. You can define your own tags for validation, database mapping, or any other metadata. The example below builds a struct validator from scratch, showing the full pattern: iterate fields, read the \`validate\` tag, parse its comma-separated rules, and check each rule against the field's runtime value.

\`\`\`go
package main

import (
    "fmt"
    "reflect"
    "strconv"
    "strings"
)

// Struct tags are string metadata attached to struct fields
// Format: \`key:"value" key2:"value2,option"\`
type Employee struct {
    ID       int     \`json:"id" db:"employee_id" validate:"required,min=1"\`
    Name     string  \`json:"name" db:"full_name" validate:"required,minlen=2,maxlen=100"\`
    Email    string  \`json:"email" db:"email" validate:"required,email"\`
    Age      int     \`json:"age" db:"age" validate:"min=18,max=130"\`
    Salary   float64 \`json:"salary,omitempty" db:"salary"\`
    Internal bool    \`json:"-" db:"-"\` // excluded from JSON and DB
}

// TagInfo parsed from a struct tag
type TagInfo struct {
    Name    string
    Options map[string]string
}

// ParseTag parses a struct tag value into name + options
// Example: "name,omitempty,minlen=2" → {Name:"name", Options:{"omitempty":"", "minlen":"2"}}
func ParseTag(tag string) TagInfo {
    parts := strings.Split(tag, ",")
    info := TagInfo{
        Name:    parts[0],
        Options: make(map[string]string),
    }
    for _, opt := range parts[1:] {
        if idx := strings.Index(opt, "="); idx >= 0 {
            info.Options[opt[:idx]] = opt[idx+1:]
        } else {
            info.Options[opt] = ""
        }
    }
    return info
}

// ValidationError represents a failed field validation
type ValidationError struct {
    Field   string
    Message string
}

func (e ValidationError) Error() string {
    return fmt.Sprintf("validation failed for field %q: %s", e.Field, e.Message)
}

// Validate validates a struct using "validate" struct tags
func Validate(v any) []error {
    rv := reflect.ValueOf(v)
    if rv.Kind() == reflect.Ptr {
        rv = rv.Elem()
    }
    if rv.Kind() != reflect.Struct {
        return []error{fmt.Errorf("expected struct, got %s", rv.Kind())}
    }

    rt := rv.Type()
    var errs []error

    for i := range rt.NumField() {
        field := rt.Field(i)
        value := rv.Field(i)

        validateTag := field.Tag.Get("validate")
        if validateTag == "" {
            continue
        }

        rules := strings.Split(validateTag, ",")
        for _, rule := range rules {
            var err error
            if rule == "required" {
                err = validateRequired(field.Name, value)
            } else if strings.HasPrefix(rule, "min=") {
                min, _ := strconv.Atoi(strings.TrimPrefix(rule, "min="))
                err = validateMin(field.Name, value, min)
            } else if strings.HasPrefix(rule, "max=") {
                max, _ := strconv.Atoi(strings.TrimPrefix(rule, "max="))
                err = validateMax(field.Name, value, max)
            } else if strings.HasPrefix(rule, "minlen=") {
                min, _ := strconv.Atoi(strings.TrimPrefix(rule, "minlen="))
                err = validateMinLen(field.Name, value, min)
            } else if rule == "email" {
                err = validateEmail(field.Name, value)
            }
            if err != nil {
                errs = append(errs, err)
            }
        }
    }
    return errs
}

func validateRequired(name string, v reflect.Value) error {
    switch v.Kind() {
    case reflect.String:
        if v.Len() == 0 {
            return ValidationError{Field: name, Message: "is required"}
        }
    case reflect.Int, reflect.Int64:
        if v.Int() == 0 {
            return ValidationError{Field: name, Message: "is required (non-zero)"}
        }
    }
    return nil
}

func validateMin(name string, v reflect.Value, min int) error {
    if v.Kind() == reflect.Int && v.Int() < int64(min) {
        return ValidationError{Field: name, Message: fmt.Sprintf("must be >= %d", min)}
    }
    return nil
}

func validateMax(name string, v reflect.Value, max int) error {
    if v.Kind() == reflect.Int && v.Int() > int64(max) {
        return ValidationError{Field: name, Message: fmt.Sprintf("must be <= %d", max)}
    }
    return nil
}

func validateMinLen(name string, v reflect.Value, min int) error {
    if v.Kind() == reflect.String && v.Len() < min {
        return ValidationError{Field: name, Message: fmt.Sprintf("must have length >= %d", min)}
    }
    return nil
}

func validateEmail(name string, v reflect.Value) error {
    if v.Kind() == reflect.String && !strings.Contains(v.String(), "@") {
        return ValidationError{Field: name, Message: "must be a valid email"}
    }
    return nil
}

func main() {
    emp := Employee{
        ID:    0, // will fail required + min=1
        Name:  "A", // will fail minlen=2
        Email: "not-an-email", // will fail email
        Age:   15, // will fail min=18
    }

    errs := Validate(emp)
    for _, err := range errs {
        fmt.Println(err)
    }
    // validation failed for field "ID": is required (non-zero)
    // validation failed for field "ID": must be >= 1
    // validation failed for field "Name": must have length >= 2
    // validation failed for field "Email": must be a valid email
    // validation failed for field "Age": must be >= 18
}
\`\`\`

### Building a Mini Struct-to-Map Serializer

To see how \`encoding/json\` works internally, this example implements a minimal \`StructToMap\` function that converts any struct to \`map[string]any\`. It handles JSON tag renaming, \`omitempty\` semantics, nested structs (recursively), slices, \`time.Time\` formatting, nil pointer safety, and unexported field skipping. The same field-iteration and tag-parsing pattern applies to building custom serializers, config loaders, and database row mappers.

\`\`\`go
package main

import (
    "fmt"
    "reflect"
    "strings"
    "time"
)

// StructToMap converts a struct to map[string]any using json struct tags
func StructToMap(v any) (map[string]any, error) {
    rv := reflect.ValueOf(v)
    if rv.Kind() == reflect.Ptr {
        if rv.IsNil() {
            return nil, fmt.Errorf("nil pointer")
        }
        rv = rv.Elem()
    }
    if rv.Kind() != reflect.Struct {
        return nil, fmt.Errorf("expected struct, got %s", rv.Kind())
    }

    result := make(map[string]any)
    rt := rv.Type()

    for i := range rt.NumField() {
        field := rt.Field(i)
        value := rv.Field(i)

        // Skip unexported fields
        if !field.IsExported() {
            continue
        }

        // Get JSON tag name
        name := field.Name
        jsonTag := field.Tag.Get("json")
        if jsonTag == "-" {
            continue // skip excluded fields
        }
        if jsonTag != "" {
            parts := strings.Split(jsonTag, ",")
            if parts[0] != "" {
                name = parts[0]
            }
            // Handle omitempty
            if len(parts) > 1 && parts[1] == "omitempty" {
                if isZero(value) {
                    continue
                }
            }
        }

        result[name] = extractValue(value)
    }
    return result, nil
}

func isZero(v reflect.Value) bool {
    switch v.Kind() {
    case reflect.String:
        return v.Len() == 0
    case reflect.Bool:
        return !v.Bool()
    case reflect.Int, reflect.Int8, reflect.Int16, reflect.Int32, reflect.Int64:
        return v.Int() == 0
    case reflect.Float32, reflect.Float64:
        return v.Float() == 0
    case reflect.Ptr, reflect.Interface:
        return v.IsNil()
    case reflect.Slice, reflect.Map:
        return v.IsNil() || v.Len() == 0
    }
    return false
}

func extractValue(v reflect.Value) any {
    switch v.Kind() {
    case reflect.Ptr:
        if v.IsNil() {
            return nil
        }
        return extractValue(v.Elem())
    case reflect.Struct:
        // Handle time.Time specially
        if v.Type() == reflect.TypeOf(time.Time{}) {
            return v.Interface().(time.Time).Format(time.RFC3339)
        }
        nested, _ := StructToMap(v.Interface())
        return nested
    case reflect.Slice:
        if v.IsNil() {
            return nil
        }
        result := make([]any, v.Len())
        for i := range v.Len() {
            result[i] = extractValue(v.Index(i))
        }
        return result
    default:
        return v.Interface()
    }
}

func main() {
    type Address struct {
        City    string \`json:"city"\`
        Country string \`json:"country,omitempty"\`
    }
    type Person struct {
        ID        int       \`json:"id"\`
        Name      string    \`json:"name"\`
        Email     string    \`json:"email,omitempty"\` // omitted if empty
        Address   Address   \`json:"address"\`
        Tags      []string  \`json:"tags,omitempty"\`
        CreatedAt time.Time \`json:"created_at"\`
        secret    string    // unexported - skipped
    }

    p := Person{
        ID:        1,
        Name:      "Alice",
        Address:   Address{City: "NYC"},
        CreatedAt: time.Now(),
        secret:    "hidden",
    }

    m, err := StructToMap(p)
    if err != nil {
        panic(err)
    }
    for k, v := range m {
        fmt.Printf("%s: %v\\n", k, v)
    }
    // id: 1
    // name: Alice
    // address: map[city:NYC]
    // created_at: 2024-03-15T10:30:00Z
    // email and tags are omitted (omitempty + zero value)
    // secret is skipped (unexported)
}
\`\`\`

### When Reflection Is the Right Answer

For a senior engineer, reflection is the right tool in a narrow set of cases:

1. **Serialisation to a format whose schema is determined at runtime.** \`encoding/json\`, \`encoding/xml\`, \`encoding/gob\`, and user-defined equivalents.
2. **Framework code that operates on user-defined types.** Validation libraries, ORMs, dependency-injection containers.
3. **Testing helpers that need to inspect values generically.** \`testify\`'s assertions use reflection for deep equality.
4. **Migration and refactoring tools that operate on arbitrary data.** Offline, not in a hot path.

For everything else in 2026, generics are the right answer. The rule is "if the type is knowable at compile time, use generics; if it is truly only known at runtime, use reflection".

### Code-Review Lens (Senior Track)

Three patterns to flag in reflection-heavy PRs:

1. **Reflection in a hot path.** Benchmark. Reflection is 10-100x slower than direct access. If the path is hot, move the reflection out of the loop (cache the result once) or replace with generics.
2. **Reflection for a case generics could handle.** If the function signature is \`func F[T any](x T)\` and you know T at compile time, drop the reflection.
3. **Reflection without caching.** \`reflect.TypeOf\` is not free. In a repeated call site, cache the type once at init.

---
`;
