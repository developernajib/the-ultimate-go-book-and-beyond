## 57.8 Response Transformation Patterns

Response transformation is where BFFs earn their keep: converting downstream currency amounts from cents to formatted strings, merging fields from two services into a single response type, and filtering out fields the current user's role cannot see. Go's type system makes these transformations explicit and testable without reflection. Each transformer is a pure function that maps one concrete type to another. The patterns below demonstrate field merging, unit conversion, and role-based field omission as composable transformation functions.

```go
// shared/pkg/transformer/transformer.go
package transformer

import (
    "reflect"
    "strings"
)

// Transformer provides response transformation utilities
type Transformer struct {
    imageService ImageService
}

// TransformOptions controls transformation behavior
type TransformOptions struct {
    // Image handling
    ImageSize     int  // Target size for images
    IncludeImages bool // Whether to include images at all

    // Field handling
    IncludeFields []string // Only include these fields (whitelist)
    ExcludeFields []string // Exclude these fields (blacklist)

    // Text handling
    TruncateTextAt int // Max length for text fields

    // Expansion
    ExpandRelations bool // Whether to expand related objects
}

// Transform applies options to transform an object
func (t *Transformer) Transform(src any, opts TransformOptions) map[string]any {
    result := make(map[string]any)

    v := reflect.ValueOf(src)
    if v.Kind() == reflect.Ptr {
        v = v.Elem()
    }

    typ := v.Type()

    for i := 0; i < v.NumField(); i++ {
        field := typ.Field(i)
        fieldValue := v.Field(i)

        // Get JSON tag name
        jsonTag := field.Tag.Get("json")
        if jsonTag == "" || jsonTag == "-" {
            continue
        }

        // Remove omitempty suffix
        if idx := strings.Index(jsonTag, ","); idx != -1 {
            jsonTag = jsonTag[:idx]
        }

        // Check whitelist/blacklist
        if len(opts.IncludeFields) > 0 && !contains(opts.IncludeFields, jsonTag) {
            continue
        }
        if contains(opts.ExcludeFields, jsonTag) {
            continue
        }

        value := fieldValue.Interface()

        // Transform images
        if strings.Contains(strings.ToLower(jsonTag), "image") {
            if !opts.IncludeImages {
                continue
            }
            if opts.ImageSize > 0 {
                if str, ok := value.(string); ok {
                    value = t.imageService.Resize(str, opts.ImageSize)
                }
            }
        }

        // Truncate text
        if opts.TruncateTextAt > 0 {
            if str, ok := value.(string); ok && len(str) > opts.TruncateTextAt {
                value = str[:opts.TruncateTextAt-3] + "..."
            }
        }

        result[jsonTag] = value
    }

    return result
}

// TransformList transforms a slice of objects
func (t *Transformer) TransformList(src any, opts TransformOptions) []map[string]any {
    v := reflect.ValueOf(src)
    if v.Kind() != reflect.Slice {
        return nil
    }

    result := make([]map[string]any, v.Len())
    for i := 0; i < v.Len(); i++ {
        result[i] = t.Transform(v.Index(i).Interface(), opts)
    }

    return result
}

func contains(slice []string, item string) bool {
    for _, s := range slice {
        if s == item {
            return true
        }
    }
    return false
}
```

### Junior -> FAANG: Transformation as Pure Functions

The reflection-based `Transformer` shown above is a generic utility. In production BFFs, most transformations should be typed pure functions: a function that takes a concrete downstream type and returns a concrete BFF response type, with no side effects and no reflection.

Typed pure transformations are the right default because they are readable (the compiler tells you exactly which fields are mapped), testable (table-driven tests cover all field combinations without mocking), and performant (no reflection overhead at runtime). The reflection-based transformer is useful for dynamic field filtering (when the client can request a subset of fields via a `?fields=` query parameter), but it should be a narrow exception, not the default approach.

A first-job habit: when writing a transformer function, write the test first with at least these three cases: full downstream object maps to correct BFF object, zero-value downstream fields produce correct BFF zero values, and optional fields (pointer types) are nil when the source field is absent. Transformation bugs are often discovered only in edge cases, not in the happy path.

In interviews, if asked to implement response transformation, write a typed function signature first. Do not reach for `map[string]any` or reflection. Typed transformation is the idiomatic Go approach and signals production experience.

### Senior @ FAANG: Transformation Pipelines and Performance

At senior level, the transformation layer is where performance optimization has the most effective. A BFF that transforms 1,000 product records per request and allocates a new struct for each field will generate significant GC pressure. Profiling the transformation layer is often the first step when investigating BFF latency spikes under load.

Optimization strategies, in order of impact: First, preallocate slices with `make([]*WebProduct, len(products))` rather than using `append` in a loop. This eliminates repeated slice growth allocations. Second, avoid string concatenation in transformation hot paths. Truncating a name with `name[:27] + "..."` allocates a new string on every call. Use a bytes pool and write to it, or precompute the truncation. Third, for transformations that involve image URL rewriting, memoize the URL template expansion for repeated base URLs.

Transformation correctness has a security dimension in the admin BFF: field filtering must be implemented as an allowlist, not a denylist. The `ExcludeFields` option in the generic transformer is dangerous. If a new PII field is added to the downstream type and is not explicitly added to the exclude list, it leaks to the client. An `IncludeFields` allowlist ensures that new fields are opt-in for each BFF response type. This principle applies whenever transformation logic controls what data clients can see.

At staff level, transformation is also where schema versioning concerns surface. If the web BFF is currently returning product cards with a `badge` string field and you want to migrate to a `badges []string` array field for multi-badge support, you have a client migration problem. The BFF transformation layer is the right place to implement version negotiation: if the client sends `Accept-Version: v2`, the transformer returns the new field shape, otherwise it returns the v1 shape. This lets the web team and the BFF team migrate independently.

---
