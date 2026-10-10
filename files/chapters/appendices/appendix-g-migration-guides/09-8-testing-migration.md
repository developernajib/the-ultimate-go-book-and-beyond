## 8. Enterprise Testing & Contract Verification

### 8.1 Testing Philosophy: Mocks vs Native Testcontainers

In dynamic languages (Python, Ruby, JavaScript), testing relies heavily on runtime monkey-patching: mocking external APIs by stubbing global methods at runtime. In Go, code is statically typed and functions cannot be monkey-patched.

Enterprise Go adopts two foundational testing disciplines:
1. **Interface-Based Unit Testing**: Inject interfaces into services, allowing lightweight in-memory fake implementations for fast, deterministic unit tests.
2. **Testcontainers for Real Integration Testing**: Test against real, ephemeral Docker instances of PostgreSQL, Redis, and Kafka using `testcontainers-go`, eliminating flaky mock mismatches.

---

### 8.2 Shadow Traffic Assertion (Semantic Parity)

When replacing an existing service with Go, verify semantic equivalence by comparing production response payloads:

```go
package verify

import (
	"encoding/json"
	"reflect"
	"testing"
)

// CompareJSON asserts semantic equivalence while ignoring volatile fields (timestamps, UUIDs)
func AssertSemanticParity(t *testing.T, legacyJSON, goJSON []byte, volatileKeys []string) {
	var legacyMap, goMap map[string]any
	if err := json.Unmarshal(legacyJSON, &legacyMap); err != nil {
		t.Fatalf("failed unmarshaling legacy response: %v", err)
	}
	if err := json.Unmarshal(goJSON, &goMap); err != nil {
		t.Fatalf("failed unmarshaling go response: %v", err)
	}

	for _, k := range volatileKeys {
		delete(legacyMap, k)
		delete(goMap, k)
	}

	if !reflect.DeepEqual(legacyMap, goMap) {
		t.Errorf("semantic mismatch between legacy and Go outputs:\nLegacy: %+v\nGo: %+v", legacyMap, goMap)
	}
}
```
