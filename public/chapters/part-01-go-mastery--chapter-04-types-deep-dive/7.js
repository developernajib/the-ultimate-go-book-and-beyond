export default `## 4.6 Structs

Structs are Go's primary mechanism for defining custom types with multiple fields.

### Struct Basics

Structs are Go's primary mechanism for grouping related data. Fields are accessed with dot notation, and struct literals initialize all fields in one expression.

\`\`\`go
type Person struct {
    Name    string
    Age     int
    Email   string
    private bool  // unexported (lowercase)
}

// Creation - named fields (preferred)
p1 := Person{Name: "Alice", Age: 30, Email: "alice@example.com"}

// Creation - positional (fragile, avoid)
p2 := Person{"Bob", 25, "bob@example.com", false}

// Zero value
var p3 Person  // {"", 0, "", false}

// Pointer creation
p4 := &Person{Name: "Carol", Age: 28}

// Access
fmt.Println(p1.Name)
p1.Age = 31
\`\`\`

### Field Ordering and Memory

Field order affects memory layout due to alignment requirements:

\`\`\`go
// Unoptimized: 24 bytes (on 64-bit system)
type Bad struct {
    a bool    // 1 byte + 7 padding
    b int64   // 8 bytes
    c bool    // 1 byte + 7 padding
}

// Optimized: 16 bytes
type Good struct {
    b int64   // 8 bytes
    a bool    // 1 byte
    c bool    // 1 byte + 6 padding
}

// Verify with unsafe.Sizeof
fmt.Println(unsafe.Sizeof(Bad{}))   // 24
fmt.Println(unsafe.Sizeof(Good{}))  // 16
\`\`\`

### Memory Layout Visualization

The Go compiler arranges struct fields according to alignment requirements, potentially inserting padding. Reordering fields from largest to smallest alignment minimizes padding and reduces struct size.

\`\`\`
Bad struct (24 bytes):
┌─────────┬───────────────────────┬─────────┬───────────────────────┐
│ a (1B)  │     padding (7B)      │   b     │  b (8 bytes total)   │
├─────────┼───────────────────────┼─────────┼───────────────────────┤
│    c    │      padding (7B)     │         │                       │
└─────────┴───────────────────────┴─────────┴───────────────────────┘

Good struct (16 bytes):
┌─────────────────────────────────┬─────┬─────┬───────────────────────┐
│         b (8 bytes)             │  a  │  c  │     padding (6B)      │
└─────────────────────────────────┴─────┴─────┴───────────────────────┘
\`\`\`

Rule: **Order fields from largest to smallest to minimize padding.**

### How Uber Optimizes Struct Layout

Uber uses the \`fieldalignment\` tool to find misaligned structs:

\`\`\`bash
go install golang.org/x/tools/go/analysis/passes/fieldalignment/cmd/fieldalignment@latest
fieldalignment -fix ./...
\`\`\`

\`\`\`go
// Before (Uber's geofence service)
type GeoPoint struct {
    IsValid   bool    // 1 byte + 7 padding
    Latitude  float64 // 8 bytes
    Longitude float64 // 8 bytes
    Accuracy  float32 // 4 bytes + 4 padding
}
// Size: 32 bytes

// After optimization
type GeoPoint struct {
    Latitude  float64 // 8 bytes
    Longitude float64 // 8 bytes
    Accuracy  float32 // 4 bytes
    IsValid   bool    // 1 byte + 3 padding
}
// Size: 24 bytes (25% reduction!)
\`\`\`

### Anonymous Structs

When a type is only needed in one place, a test case, a quick JSON response, or an inline data structure, an anonymous struct avoids polluting the package namespace with a named type. Declare the struct inline at the point of use.

\`\`\`go
// Inline declaration
person := struct {
    Name string
    Age  int
}{
    Name: "Alice",
    Age:  30,
}

// In function signatures
func process(data struct{ X, Y int }) {
    fmt.Println(data.X, data.Y)
}

// Common for JSON (API responses)
resp := struct {
    Status  string \`json:"status"\`
    Message string \`json:"message"\`
    Data    struct {
        UserID int    \`json:"user_id"\`
        Token  string \`json:"token"\`
    } \`json:"data"\`
}{
    Status:  "ok",
    Message: "Login successful",
}
resp.Data.UserID = 123
resp.Data.Token = "abc"

// Table-driven tests
tests := []struct {
    name     string
    input    int
    expected int
}{
    {"positive", 5, 25},
    {"zero", 0, 0},
    {"negative", -3, 9},
}
\`\`\`

### Struct Embedding

Embedding is Go's mechanism for composition. When you embed a type inside a struct without giving it a field name, all of the embedded type's exported fields and methods are promoted to the outer struct. This gives you the code reuse benefits of inheritance without the tight coupling. The outer type can always override promoted methods, and the relationship is explicit in the struct definition.

\`\`\`go
type Address struct {
    Street string
    City   string
    ZIP    string
}

type Person struct {
    Name    string
    Address  // Embedded - no field name
}

p := Person{
    Name: "Alice",
    Address: Address{
        Street: "123 Main St",
        City:   "San Francisco",
        ZIP:    "94102",
    },
}

// Fields are promoted - access directly
fmt.Println(p.Street)  // Same as p.Address.Street
fmt.Println(p.City)    // Same as p.Address.City

// Can still access via Address
fmt.Println(p.Address.ZIP)
\`\`\`

### Method Promotion

When a type is embedded, its methods become callable on the outer type as if they were defined directly on it. The outer type can override a promoted method by defining its own method with the same name. The original method is still accessible through the embedded field name.

\`\`\`go
type Address struct {
    City string
}

func (a Address) String() string {
    return a.City
}

func (a *Address) SetCity(city string) {
    a.City = city
}

type Person struct {
    Name string
    Address  // Embedded
}

p := Person{Name: "Alice", Address: Address{City: "NYC"}}

// Method promotion
fmt.Println(p.String())  // "NYC" - Address.String is promoted
p.SetCity("LA")          // Works through embedding
fmt.Println(p.City)      // "LA"

// Person can override
func (p Person) String() string {
    return fmt.Sprintf("%s from %s", p.Name, p.Address.String())
}
fmt.Println(p.String())  // "Alice from LA"
\`\`\`

### Struct Tags

Struct tags are raw string literals attached to fields that provide metadata for serialization, validation, and database mapping. Libraries like \`encoding/json\`, \`encoding/xml\`, and third-party packages like \`sqlx\` and \`validator\` read these tags at runtime via reflection. The convention is \`key:"value"\` pairs separated by spaces.

\`\`\`go
type User struct {
    ID        int       \`json:"id" db:"user_id" validate:"required"\`
    Email     string    \`json:"email,omitempty" db:"email" validate:"email"\`
    Password  string    \`json:"-" db:"password_hash"\`  // Excluded from JSON
    CreatedAt time.Time \`json:"created_at" db:"created_at"\`
    DeletedAt *time.Time \`json:"deleted_at,omitempty" db:"deleted_at"\`
}
\`\`\`

Common tag formats:
- \`json:"field_name,omitempty"\` - JSON encoding
- \`xml:"field_name,attr"\` - XML encoding
- \`yaml:"field_name"\` - YAML encoding
- \`db:"column_name"\` - Database mapping (sqlx, GORM)
- \`validate:"required,min=1,max=100"\` - Validation
- \`mapstructure:"field_name"\` - Config parsing

### Reading Tags with Reflection

Struct tags are accessible at runtime via the \`reflect\` package. The \`reflect.StructTag.Lookup\` method retrieves tag values for a given key, returning an empty string and \`false\` when absent.

\`\`\`go
import "reflect"

type User struct {
    Email string \`json:"email,omitempty" validate:"required,email"\`
}

t := reflect.TypeOf(User{})
field, _ := t.FieldByName("Email")

jsonTag := field.Tag.Get("json")           // "email,omitempty"
validateTag := field.Tag.Get("validate")   // "required,email"

// Parse JSON tag
parts := strings.Split(jsonTag, ",")
fieldName := parts[0]  // "email"
hasOmitempty := len(parts) > 1 && parts[1] == "omitempty"
\`\`\`

### How Stripe Uses Struct Tags

Stripe's Go SDK uses extensive struct tags:

\`\`\`go
// From stripe-go SDK
type PaymentIntent struct {
    ID                   string             \`json:"id"\`
    Object               string             \`json:"object"\`
    Amount               int64              \`json:"amount"\`
    AmountCapturable     int64              \`json:"amount_capturable"\`
    AmountReceived       int64              \`json:"amount_received"\`
    CanceledAt           int64              \`json:"canceled_at"\`
    CancellationReason   CancellationReason \`json:"cancellation_reason"\`
    CaptureMethod        CaptureMethod      \`json:"capture_method"\`
    ClientSecret         string             \`json:"client_secret"\`
    ConfirmationMethod   ConfirmationMethod \`json:"confirmation_method"\`
    Created              int64              \`json:"created"\`
    Currency             Currency           \`json:"currency"\`
    Customer             *Customer          \`json:"customer"\`
    Description          string             \`json:"description"\`
    LastPaymentError     *Error             \`json:"last_payment_error"\`
    Livemode             bool               \`json:"livemode"\`
    Metadata             map[string]string  \`json:"metadata"\`
    PaymentMethod        *PaymentMethod     \`json:"payment_method"\`
    PaymentMethodTypes   []string           \`json:"payment_method_types"\`
    Status               Status             \`json:"status"\`
}
\`\`\`

### Struct Comparison

A struct is comparable with \`==\` only if all of its fields are comparable types. Structs containing slices, maps, or functions cannot use \`==\` and must be compared with \`reflect.DeepEqual\` or a custom equality method. For types with non-comparable fields, defining an explicit \`Equal\` method is both clearer and faster than reflection.

\`\`\`go
type Point struct {
    X, Y int
}

p1 := Point{1, 2}
p2 := Point{1, 2}
fmt.Println(p1 == p2)  // true

// Structs with slices or maps aren't comparable
type Bad struct {
    Data []int  // Not comparable
}
// var b1, b2 Bad
// b1 == b2  // Compile error

// Use reflect.DeepEqual for non-comparable types
import "reflect"
b1 := Bad{Data: []int{1, 2, 3}}
b2 := Bad{Data: []int{1, 2, 3}}
fmt.Println(reflect.DeepEqual(b1, b2))  // true
\`\`\`

### Empty Struct

The empty struct \`struct{}\` occupies zero bytes of memory. This makes it the ideal type when you need a type but carry no data, sets implemented as \`map[K]struct{}\`, signal-only channels, and stateless method receivers all benefit from zero-size values.

\`\`\`go
fmt.Println(unsafe.Sizeof(struct{}{}))  // 0

// Use case 1: Set implementation
type Set map[string]struct{}

s := make(Set)
s["key"] = struct{}{}

if _, ok := s["key"]; ok {
    fmt.Println("exists")
}

// Use case 2: Channel signaling (no data, just event)
done := make(chan struct{})
go func() {
    // work
    close(done)  // Signal completion
}()
<-done

// Use case 3: Method receiver for stateless operations
type validator struct{}

func (validator) ValidateEmail(email string) bool {
    return strings.Contains(email, "@")
}
\`\`\`

### Struct Field Alignment in Hot Paths

The \`fieldalignment\` analyser catches structs whose fields are poorly ordered. For a small number of structs with small sizes, this is cosmetic. For structs that are allocated millions of times or live in tight arrays (\`[]Position\`, \`[]Order\`, \`[]Event\`), the savings compound:

1. **Total heap pressure.** A million \`Position\` structs at 32 bytes use 32MB of heap. At 24 bytes, they use 24MB. The 25% reduction is visible in RSS and in GC pause time.
2. **Cache line occupancy.** Modern CPUs load memory in 64-byte cache lines. A 32-byte struct gives you two per line. A 24-byte struct gives you two or three per line depending on alignment. For sequential iteration, the smaller struct means fewer cache-line fetches per thousand elements.
3. **False sharing in concurrent code.** If two goroutines mutate fields that happen to fall in the same cache line, they invalidate each other's CPU cache. For structs that are accessed concurrently, the rule flips: you deliberately want each goroutine's data on its own cache line, often by padding with a \`[64]byte\` dummy field.

The \`fieldalignment -fix ./...\` command applies the reordering automatically. The senior-track discipline is to wire it into CI for services where struct allocation is a hot path, and to ignore it for services where structs are allocated infrequently.

### Struct Tags Are Stringly Typed

Struct tags are strings. A typo in \`json:"naem"\` compiles but silently produces wrong JSON. A missing tag means the field serialises with its Go name (capitalised), which is usually wrong for external APIs. The defences:

1. **Linters.** \`go-critic\`'s \`fieldalignment\` for layout, \`tagliatelle\` for tag style consistency, \`staticcheck\`'s ST1003 for naming. Wire them into CI.
2. **Tests that exercise serialisation.** A round-trip test (marshal then unmarshal) catches typos in tags by structure rather than by string inspection. Write one for every public API struct.
3. **Naming discipline.** Keep Go field names and JSON tag values close in shape, so a typo becomes visible to code review. \`UserID int64 \\\`json:"user_id"\\\`\` is a clear pair. \`UsrId int64 \\\`json:"user_identifier"\\\`\` is a code smell.

### Embedding Is Composition, Not Inheritance

Embedding promotes fields and methods. It does not establish an "is-a" relationship, does not enable virtual dispatch, and does not participate in interface satisfaction in the way inheritance would in Java. Three rules that matter at code review time:

1. **An embedded type's methods are on the outer type's method set**, but only by forwarding. The outer method \`p.String()\` dispatches to \`p.Address.String()\`. You cannot pass a \`Person\` to a function that takes \`Address\`.
2. **Method shadowing is by name**, not by signature. If \`Person\` defines \`String()\`, it shadows \`Address.String()\` regardless of argument types. This is usually what you want.
3. **Ambiguity is an error.** If two embedded types both have a method of the same name, calling the method on the outer type is a compile error. The outer type must define the method (forwarding to one of the embeds explicitly) to resolve.

The Java engineer's reflex to treat embedding as inheritance will produce Go that compiles and behaves differently than intended. Spot it in code review when you see "override the base class method" language in the PR description.

### Code-Review Lens (Senior Track)

Three patterns a staff reviewer flags in struct-heavy PRs:

1. **Positional struct literals (\`User{"Alice", 30, ...}\`).** Fragile to field additions. Require named literals as a team convention.
2. **Exported fields on domain types with invariants.** \`User.Email\` exposed publicly lets any caller bypass validation. Make the field unexported and provide an accessor that enforces the invariant.
3. **Struct fields out of alignment order in a hot allocation path.** Run \`fieldalignment\` and accept its suggestions when the struct is allocated frequently.

### Migration Lens

Coming from Java, the mental shift from class to struct is the biggest. Structs have no implicit identity (no built-in \`equals\` that compares by reference), no inheritance, no static methods (use package functions). The replacement is smaller types with explicit composition. Coming from Python, structs are similar to dataclasses with a stricter type system. Struct tags play the role of \`@dataclass(field(metadata={...}))\`. Coming from Rust, Go structs are similar to Rust structs but with looser memory discipline. There is no borrow checker, no lifetimes, no trait implementations required. The trade is less compile-time safety for faster ship velocity.

---
`;
