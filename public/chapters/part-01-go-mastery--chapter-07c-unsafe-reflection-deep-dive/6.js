export default `## 7C.5 Creating Values Dynamically with reflect

Sometimes you need to create a value whose type is only known at runtime. A JSON decoder must create a \`*User\` or \`*Order\` based on what the caller passes in. A plugin system might instantiate types registered by name. The \`reflect\` package provides \`reflect.New(t)\` to allocate a new zero-value pointer for any \`reflect.Type\`, \`reflect.MakeSlice\` to create typed slices, and \`reflect.MakeMap\` to create typed maps. The example below builds a simple type registry that creates instances by string name, then demonstrates dynamic slice and map construction.

\`\`\`go
package main

import (
    "fmt"
    "reflect"
)

// Generic factory: creates a new instance of any registered type
var registry = map[string]reflect.Type{}

func Register(name string, v any) {
    registry[name] = reflect.TypeOf(v)
}

func Create(name string) (any, bool) {
    t, ok := registry[name]
    if !ok {
        return nil, false
    }
    // reflect.New creates *T (pointer to new zero value of type T)
    return reflect.New(t).Interface(), true
}

type Dog struct{ Name, Breed string }
type Cat struct {
    Name   string
    Indoor bool
}

func init() {
    Register("dog", Dog{})
    Register("cat", Cat{})
}

func main() {
    // Create instances by name
    animal, ok := Create("dog")
    if ok {
        dog := animal.(*Dog)
        dog.Name = "Rex"
        dog.Breed = "German Shepherd"
        fmt.Printf("%+v\\n", *dog)
    }

    // Build a slice of a dynamic type
    elemType := reflect.TypeOf(int(0))
    sliceType := reflect.SliceOf(elemType)
    slice := reflect.MakeSlice(sliceType, 0, 10)
    for i := range 5 {
        slice = reflect.Append(slice, reflect.ValueOf(i*i))
    }
    fmt.Println(slice.Interface()) // [0 1 4 9 16]

    // Build a map of dynamic types
    mapType := reflect.MapOf(reflect.TypeOf(""), reflect.TypeOf(0))
    m := reflect.MakeMap(mapType)
    m.SetMapIndex(reflect.ValueOf("key"), reflect.ValueOf(42))
    fmt.Println(m.Interface()) // map[key:42]
}
\`\`\`

### Code-Review Lens

Two patterns to flag:

1. **Dynamic value construction for a set of types known at compile time.** Replace with generics or typed constructors.
2. **Dynamic slice or map construction in a hot path.** Each \`reflect.MakeSlice\` or \`reflect.MakeMap\` allocates. If the type is known at compile time, use typed allocation.

---
`;
