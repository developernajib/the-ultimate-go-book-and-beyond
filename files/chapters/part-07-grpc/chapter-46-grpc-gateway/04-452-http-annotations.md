## 46.2 HTTP Annotations

### Basic Proto Annotations

The Protocol Buffer definition below specifies the message schema and service contract. Field numbers must remain stable across versions. Adding new fields with previously unused numbers is backward compatible, while renumbering or removing fields breaks existing clients.

```protobuf
// proto/user/v1/user.proto
syntax = "proto3";

package user.v1;

option go_package = "github.com/myapp/gen/user/v1;userv1";

import "google/api/annotations.proto";
import "google/protobuf/empty.proto";
import "google/protobuf/field_mask.proto";
import "protoc-gen-openapiv2/options/annotations.proto";

// OpenAPI metadata
option (grpc.gateway.protoc_gen_openapiv2.options.openapiv2_swagger) = {
    info: {
        title: "User API";
        version: "1.0";
        description: "API for managing users";
        contact: {
            name: "API Support";
            email: "support@example.com";
        };
    };
    schemes: HTTPS;
    consumes: "application/json";
    produces: "application/json";
    security_definitions: {
        security: {
            key: "Bearer";
            value: {
                type: TYPE_API_KEY;
                in: IN_HEADER;
                name: "Authorization";
                description: "JWT token";
            };
        };
    };
    security: {
        security_requirement: {
            key: "Bearer";
            value: {};
        };
    };
};

message User {
    string id = 1;
    string email = 2;
    string name = 3;
    string status = 4;
    repeated string roles = 5;
}

message GetUserRequest {
    string id = 1;
}

message GetUserResponse {
    User user = 1;
}

message ListUsersRequest {
    int32 page_size = 1;
    string page_token = 2;
    string status_filter = 3;
}

message ListUsersResponse {
    repeated User users = 1;
    string next_page_token = 2;
    int32 total_count = 3;
}

message CreateUserRequest {
    string email = 1;
    string name = 2;
    string password = 3;
    repeated string roles = 4;
}

message CreateUserResponse {
    User user = 1;
}

message UpdateUserRequest {
    string id = 1;
    User user = 2;
    google.protobuf.FieldMask update_mask = 3;
}

message UpdateUserResponse {
    User user = 1;
}

message DeleteUserRequest {
    string id = 1;
}

service UserService {
    // Get a user by ID
    rpc GetUser(GetUserRequest) returns (GetUserResponse) {
        option (google.api.http) = {
            get: "/api/v1/users/{id}"
        };
        option (grpc.gateway.protoc_gen_openapiv2.options.openapiv2_operation) = {
            summary: "Get user";
            description: "Retrieves a user by ID";
            tags: "Users";
        };
    }

    // List all users
    rpc ListUsers(ListUsersRequest) returns (ListUsersResponse) {
        option (google.api.http) = {
            get: "/api/v1/users"
        };
        option (grpc.gateway.protoc_gen_openapiv2.options.openapiv2_operation) = {
            summary: "List users";
            description: "Returns a paginated list of users";
            tags: "Users";
        };
    }

    // Create a new user
    rpc CreateUser(CreateUserRequest) returns (CreateUserResponse) {
        option (google.api.http) = {
            post: "/api/v1/users"
            body: "*"
        };
        option (grpc.gateway.protoc_gen_openapiv2.options.openapiv2_operation) = {
            summary: "Create user";
            description: "Creates a new user";
            tags: "Users";
        };
    }

    // Update an existing user
    rpc UpdateUser(UpdateUserRequest) returns (UpdateUserResponse) {
        option (google.api.http) = {
            patch: "/api/v1/users/{id}"
            body: "user"
        };
        option (grpc.gateway.protoc_gen_openapiv2.options.openapiv2_operation) = {
            summary: "Update user";
            description: "Partially updates a user";
            tags: "Users";
        };
    }

    // Delete a user
    rpc DeleteUser(DeleteUserRequest) returns (google.protobuf.Empty) {
        option (google.api.http) = {
            delete: "/api/v1/users/{id}"
        };
        option (grpc.gateway.protoc_gen_openapiv2.options.openapiv2_operation) = {
            summary: "Delete user";
            description: "Deletes a user by ID";
            tags: "Users";
        };
    }
}
```

### Advanced HTTP Mappings

Advanced annotations use `additional_bindings` to expose the same RPC at multiple HTTP paths, `body: "*"` to bind the full request body, and nested field path parameters (e.g., `{user.id}`) to extract deeply nested proto fields from the URL. The `HttpRule` options accept wildcard paths and custom HTTP verbs for non-standard REST semantics.

```protobuf
// Advanced URL patterns

service ProductService {
    // Nested resource path
    rpc GetProductReview(GetProductReviewRequest) returns (ProductReview) {
        option (google.api.http) = {
            get: "/api/v1/products/{product_id}/reviews/{review_id}"
        };
    }

    // Multiple HTTP bindings
    rpc SearchProducts(SearchProductsRequest) returns (SearchProductsResponse) {
        option (google.api.http) = {
            get: "/api/v1/products:search"
            additional_bindings {
                post: "/api/v1/products:search"
                body: "*"
            }
        };
    }

    // Custom action (non-RESTful)
    rpc PublishProduct(PublishProductRequest) returns (Product) {
        option (google.api.http) = {
            post: "/api/v1/products/{id}:publish"
        };
    }

    // Query parameters mapping
    rpc ListProducts(ListProductsRequest) returns (ListProductsResponse) {
        option (google.api.http) = {
            get: "/api/v1/products"
            // Query params are automatically mapped:
            // ?category=electronics&min_price_cents=10000&max_price_cents=50000&in_stock=true
        };
    }
}

message ListProductsRequest {
    string category = 1;           // ?category=electronics
    int64 min_price_cents = 2;     // ?min_price_cents=10000 (integer cents)
    int64 max_price_cents = 3;     // ?max_price_cents=50000 (integer cents)
    bool in_stock = 4;             // ?in_stock=true
    int32 page_size = 5;           // ?page_size=20
    string page_token = 6;         // ?page_token=abc123
    repeated string tags = 7;      // ?tags=sale&tags=featured
}

message GetProductReviewRequest {
    string product_id = 1;  // From URL path
    string review_id = 2;   // From URL path
}

message SearchProductsRequest {
    string query = 1;
    repeated string filters = 2;
    string sort_by = 3;
}
```

### Junior -> FAANG: Writing Annotations That Do What You Think They Do

The most common annotation mistake for junior engineers is assuming that the field name in the proto automatically becomes the JSON key and the URL parameter name. The reality is more nuanced.

By default, `protojson` serializes `snake_case` proto field names as `camelCase` JSON keys. So `page_token` in the proto becomes `pageToken` in the JSON body and the query string. If your client sends `?page_token=abc`, the gateway drops it silently because it does not match `pageToken`. Setting `UseProtoNames: true` on the marshaler makes the JSON layer use `snake_case`, matching the proto field names exactly. Be consistent across all services on your team. Mixed conventions are worse than either choice alone.

The `additional_bindings` pattern in the `SearchProducts` example is useful but confusing at first. Each binding is an independent HTTP route. The gateway will match either the `GET /api/v1/products:search` or the `POST /api/v1/products:search` binding, each mapping the request differently (query params for GET, full body for POST). When you see unexpected behavior on one binding, always verify which binding matched by checking the gateway logs or adding a temporary `WithMetadata` annotator that logs the matched pattern.

Path parameter names in the URL must match field names (or nested field paths like `{user.id}`) in the request message exactly. A mismatch produces a startup-time error when `protoc-gen-grpc-gateway` validates the annotation, not a runtime error. This is good: it means annotation bugs fail fast.

The `google/api/annotations.proto` import is required for the `(google.api.http)` option to be recognized. Missing this import produces a confusing error from `protoc` about an unknown option. Always check your imports first when annotations fail to compile.

Interview habit: practice writing annotations for five common REST patterns (get by ID, list with filters, create with body, partial update with field mask, delete) from memory. Interviewers asking about gRPC-Gateway often start with "annotate this proto for a RESTful user service" before going deeper.

### Senior @ FAANG: Annotation Design as an API Contract Decision

At the senior level, HTTP annotations are not just a technical configuration, they are a public API contract. The choices you make in the annotation layer determine what your external clients must code against, and changing them later is a breaking change.

**Path parameter naming and resource hierarchy.** Google's AIP guidelines (aip.dev) recommend that resource collection names appear in the path and identifiers use the pattern `{resource}_id` or just `{id}` when the resource is unambiguous from context. Consistency matters: if one service uses `/users/{user_id}` and another uses `/users/{id}`, API consumers writing generic tooling (logging, testing, SDK generation) must handle both forms. A platform-level `buf lint` rule enforcing a standard naming convention prevents this drift.

**The `additional_bindings` governance question.** Each additional binding is a separate URL that clients can discover and use. Once a binding is published, removing it is a breaking change. Teams that add `additional_bindings` for convenience during development often end up maintaining URLs they did not intend to be permanent. The ADR for a platform should specify when `additional_bindings` is appropriate (canonical URL plus a deprecated alias during migration) and when it is not (convenience aliases that have no migration purpose).

**Custom method verbs (``:publish``, ``:search``)** implement the Google AIP custom method pattern. This is the correct way to handle operations that do not map cleanly to GET/POST/PUT/PATCH/DELETE semantics. The colon syntax is intentional: it distinguishes the custom action from a resource identifier in the URL. However, some API gateways (AWS API Gateway v1, some Nginx configs) do not handle the colon in path segments correctly. If your REST surface must pass through third-party API infrastructure, validate that the custom method paths work end-to-end before committing to the pattern.

**Query parameter binding for repeated fields.** The `ListProductsRequest` example shows `repeated string tags = 7` binding to `?tags=sale&tags=featured`. This is standard but not universal: some clients serialize repeated fields as `?tags[]=sale&tags[]=featured` (PHP convention) or `?tags=sale,featured` (comma-separated). The gateway supports only the multi-key form by default. If you have clients that use a different convention, you need a pre-processing middleware that normalizes the query string before the gateway parses it. Document the expected format explicitly in the OpenAPI spec.

**FieldMask in PATCH annotations.** Using `body: "user"` with a separate `update_mask` field follows the Google AIP-134 pattern for partial updates. This is preferable to `body: "*"` for update operations because it makes the field mask an explicit part of the request structure that clients must populate. Without a field mask, a PATCH with a partial body causes ambiguity: did the client mean to set omitted fields to zero, or did the client not intend to touch them? The field mask removes the ambiguity. Enforce this with a `buf lint` rule or a gRPC interceptor that rejects PATCH-mapped RPCs where `update_mask` is nil or empty.

---
