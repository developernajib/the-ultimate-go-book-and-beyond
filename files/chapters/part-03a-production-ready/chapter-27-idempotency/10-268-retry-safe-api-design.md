## 27.8 Retry-Safe API Design

### Designing Idempotent Endpoints

API design choices determine whether an operation is safe to retry without additional infrastructure. `PUT` is naturally idempotent because it replaces an entire resource, the same request produces the same state regardless of how many times it is sent. `POST` creates a new resource on each call and requires an explicit `Idempotency-Key` header combined with server-side deduplication to become retry-safe.

```go
package api

import (
    "encoding/json"
    "net/http"
)

// Idempotent: PUT replaces entire resource
func (h *Handler) UpdateUser(w http.ResponseWriter, r *http.Request) {
    var user User
    if err := json.NewDecoder(r.Body).Decode(&user); err != nil {
        http.Error(w, err.Error(), http.StatusBadRequest)
        return
    }

    // Replace entire resource - same request = same result
    if err := h.userRepo.Replace(r.Context(), user.ID, &user); err != nil {
        http.Error(w, err.Error(), http.StatusInternalServerError)
        return
    }

    json.NewEncoder(w).Encode(user)
}

// NOT idempotent without key: POST creates new resource
// Made idempotent with Idempotency-Key
func (h *Handler) CreatePayment(w http.ResponseWriter, r *http.Request) {
    idempotencyKey := r.Header.Get("Idempotency-Key")
    if idempotencyKey == "" {
        http.Error(w, "Idempotency-Key required", http.StatusBadRequest)
        return
    }

    // ... use idempotency handler
}

// Conditional update: only update if condition matches
func (h *Handler) ConditionalUpdate(w http.ResponseWriter, r *http.Request) {
    etag := r.Header.Get("If-Match")

    user, err := h.userRepo.Get(r.Context(), userID)
    if err != nil {
        http.Error(w, err.Error(), http.StatusInternalServerError)
        return
    }

    if etag != "" && etag != user.ETag() {
        http.Error(w, "Precondition failed", http.StatusPreconditionFailed)
        return
    }

    // Proceed with update...
}
```

### Staff Lens: Idempotent APIs Are the Default

Every mutation API should support idempotency keys. Document in API reference. Clients that do not use them are still safe. Clients that do benefit from retry safety.

---
