## 43.2 Protocol Buffers

### proto3, APIv2, and Protobuf Editions

Three version concepts need to be kept separate. The **syntax version** (`proto2`, `proto3`, or an **Edition** like `2023`) describes the `.proto` source language. The **runtime API version** describes the generated Go code, modern code uses the APIv2 runtime at `google.golang.org/protobuf`. The older APIv1 at `github.com/golang/protobuf` is deprecated and should appear in new code only via its thin wrapper shims that exist solely for backward compatibility. And the **protoc-gen-go plugin** binary generates Go code for any of the syntax versions against the APIv2 runtime.

Use `google.golang.org/protobuf` imports everywhere (`proto.Marshal`, `proto.Unmarshal`, `types/known/timestamppb`, `types/known/emptypb`). Do not import from `github.com/golang/protobuf` in new code.

**Protobuf Editions (2023)** unify proto2 and proto3 semantics behind per-file, per-message, and per-field feature flags. Features such as `field_presence` (`EXPLICIT`, `IMPLICIT`, `LEGACY_REQUIRED`), `enum_type` (`OPEN`, `CLOSED`), `repeated_field_encoding` (`PACKED`, `EXPANDED`), and `json_format` (`ALLOW`, `LEGACY_BEST_EFFORT`) replace the hardcoded syntax-level defaults. Editions do not change the wire format, existing proto3 messages continue to serialize identically, they just give you finer-grained control when you need it. The Protobuf team's current guidance is that proto3 remains fully supported and that new projects can stay on proto3. Adopt Editions when you need a feature that proto3's fixed defaults cannot express, such as re-introducing explicit presence on scalar fields without wrapping them in `optional`. An Edition file starts with `edition = "2023";` instead of `syntax = "proto3";`.

### Basic Proto Definitions

A `.proto` file defines the service contract: message types with typed fields and RPC methods that specify request and response message types. The `protoc` compiler with Go plugins generates Go types and server/client stubs from this definition.

```protobuf
// proto/user/v1/user.proto
syntax = "proto3";

package user.v1;

option go_package = "github.com/myapp/gen/user/v1;userv1";

import "google/protobuf/timestamp.proto";
import "google/protobuf/empty.proto";

// User represents a user account
message User {
  string id = 1;
  string email = 2;
  string name = 3;
  UserStatus status = 4;
  repeated string roles = 5;
  google.protobuf.Timestamp created_at = 6;
  google.protobuf.Timestamp updated_at = 7;

  // Optional fields (proto3)
  optional string phone = 8;
  optional Address address = 9;
}

// UserStatus enum
enum UserStatus {
  USER_STATUS_UNSPECIFIED = 0;
  USER_STATUS_ACTIVE = 1;
  USER_STATUS_INACTIVE = 2;
  USER_STATUS_SUSPENDED = 3;
}

// Address message
message Address {
  string street = 1;
  string city = 2;
  string state = 3;
  string zip_code = 4;
  string country = 5;
}

// Request/Response messages
message GetUserRequest {
  string id = 1;
}

message GetUserResponse {
  User user = 1;
}

message ListUsersRequest {
  int32 page_size = 1;
  string page_token = 2;
  UserStatus status_filter = 3;
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
  optional string name = 2;
  optional string email = 3;
  optional UserStatus status = 4;
}

message UpdateUserResponse {
  User user = 1;
}

message DeleteUserRequest {
  string id = 1;
}

// Service definition
service UserService {
  // Unary RPCs
  rpc GetUser(GetUserRequest) returns (GetUserResponse);
  rpc CreateUser(CreateUserRequest) returns (CreateUserResponse);
  rpc UpdateUser(UpdateUserRequest) returns (UpdateUserResponse);
  rpc DeleteUser(DeleteUserRequest) returns (google.protobuf.Empty);

  // Server streaming
  rpc ListUsers(ListUsersRequest) returns (stream User);

  // Client streaming
  rpc BulkCreateUsers(stream CreateUserRequest) returns (BulkCreateUsersResponse);

  // Bidirectional streaming
  rpc UserUpdates(stream UserUpdateRequest) returns (stream User);
}

message BulkCreateUsersResponse {
  int32 created_count = 1;
  repeated string user_ids = 2;
}

message UserUpdateRequest {
  string user_id = 1;
}
```

### Wire Format, Field Tags, and Schema Evolution

A Protobuf message on the wire is a flat sequence of `(tag, value)` records. The tag is a single varint encoding `(field_number << 3) | wire_type`. Varints use 7 bits of payload per byte with a continuation bit, so small integers and small field numbers are one byte each. Field numbers 1-15 encode their tag in a single byte. 16-2047 take two. Reserve 1-15 for the fields you expect to appear on every message (your ID, your status enum) because they pay the lowest serialization cost.

Four rules keep a schema forward- and backward-compatible with deployed clients and servers:

1. **Never change a field's number or wire type.** The number is the message's identity. The wire type (varint, length-delimited, fixed32, fixed64) determines how many bytes the decoder reads. Either change silently corrupts old messages.
2. **Never reuse a removed field's number or name.** A new field with an old number will deserialize old bytes into the wrong field. Use `reserved 5, 7, 9 to 11; reserved "old_name";` to tell the compiler to reject anyone who tries.
3. **Removing a field is safe if you reserve its number.** Any field can be dropped from the schema, but its number and name must be reserved so they are never reused (rule 2). A peer still running the old schema treats the now-absent field as unknown, and proto3 preserves unknown fields across a re-encode (since protobuf 3.5), so data a newer peer does not model round-trips intact instead of being silently dropped.
4. **Adding a field is always safe** provided you pick an unused number and do not mark it required (proto3 has no `required`, and Editions' `LEGACY_REQUIRED` is named that way for a reason).

```protobuf
// Safe schema evolution: reserve removed fields so they can't be reused.
message User {
  string id = 1;
  string email = 2;
  // string username = 3;  // removed in v2: DO NOT reuse number 3 or name "username"
  reserved 3;
  reserved "username";

  string name = 4;
  repeated string roles = 5;
}
```

### Code Generation

`protoc` with Go plugins transforms `.proto` definitions into `_pb.go` files containing message structs and `_grpc.pb.go` files containing server and client interfaces. Running code generation in CI or with `go generate` ensures the generated code stays synchronized with the proto definition.

```bash
# Install protoc compiler
# macOS
brew install protobuf

# Linux
apt-get install protobuf-compiler

# Install Go plugins
go install google.golang.org/protobuf/cmd/protoc-gen-go@latest
go install google.golang.org/grpc/cmd/protoc-gen-go-grpc@latest

# Generate code
protoc --go_out=. --go_opt=paths=source_relative \
       --go-grpc_out=. --go-grpc_opt=paths=source_relative \
       proto/user/v1/user.proto
```

### buf.yaml Configuration

The `buf` tool provides an alternative to invoking `protoc` directly. It manages dependencies, applies linting rules, detects breaking changes, and simplifies code generation through declarative YAML configuration. The `buf.yaml` file defines linting and breaking change policies, while `buf.gen.yaml` specifies which plugins to run and where to write output.

```yaml
# buf.yaml
version: v1
name: buf.build/myorg/myapp
lint:
  use:
    - DEFAULT
  except:
    - PACKAGE_VERSION_SUFFIX
breaking:
  use:
    - FILE
deps:
  - buf.build/googleapis/googleapis
```

The generation configuration lives in a separate `buf.gen.yaml` file. It declares which protoc plugins to run and where to write the output files.

```yaml
# buf.gen.yaml
version: v1
managed:
  enabled: true
  go_package_prefix:
    default: github.com/myapp/gen
plugins:
  - plugin: buf.build/protocolbuffers/go
    out: gen
    opt: paths=source_relative
  - plugin: buf.build/grpc/go
    out: gen
    opt: paths=source_relative
```

With both files in place, a single command generates all Go code:

```bash
# Generate with buf
buf generate
```

### Junior → FAANG: Proto Fundamentals You Must Own Before the Interview

The two concepts juniors most often misunderstand about Protocol Buffers:

**Field numbers are the identity of a field, not its position.** When you see `string email = 2;`, the `2` is not "the second field in memory." It is the tag that appears on the wire. If you rename the field to `email_address` but keep the number `2`, old clients that decode this binary message will read `email_address` where they expected `email`. If you change the number to `4` while keeping the name `email`, new clients reading old binary messages will find field `2` unknown and skip it, deserializing `email` as the empty string. Both mistakes cause silent data corruption with no compile error and no runtime exception.

**The `reserved` keyword is your safety net.** When you remove a field, add `reserved 3;` (for the number) and `reserved "old_field_name";` (for the name). This tells `protoc` to reject any future `.proto` that tries to reuse either the number or the name. Without `reserved`, you are one careless PR away from a silent corruption bug that shows up months later in production.

Practical skill for your first job: run `buf breaking --against '.git#branch=main'` on every proto PR. This command compares your changes against the main branch and fails if any backward-incompatible change is detected. Set it up in CI on day one. If you wait until you have a breaking-change incident to add it, you have already paid the cost.

The `buf.yaml` and `buf.gen.yaml` configuration shown above is the correct way to manage code generation. Never check generated `*.pb.go` files into source control. They should be generated in CI and in developer environments via `buf generate`. Checking them in causes PR diffs that are 95% generated code noise and makes it impossible to catch drift between the `.proto` files and the generated output.

### Senior @ FAANG: Proto Schema Design as an Organizational API Surface

At the senior level, every `.proto` file you approve is a contract you are implicitly signing on behalf of the organization. The design decisions embedded in a proto definition have multi-year consequences.

**Resource-oriented design and the Google AIP standard.** The Google API Improvement Proposals (AIPs) at `aip.dev` are the closest thing to a universal style guide for proto-based APIs. AIP-121 (resource-oriented design), AIP-131 (Standard Get), AIP-132 (Standard List), and AIP-158 (Pagination) are the most relevant. Following this standard means your APIs can be wrapped by gRPC-Gateway to produce REST/JSON endpoints that conform to Google API conventions, which client teams already know. Deviating requires explicit justification in the API review.

**Field masks and partial updates.** The `UpdateUser` pattern in this chapter uses `optional` fields to distinguish "set to empty" from "not specified." This works but does not scale: with 30 optional fields, a single update RPC has a 2^30 state space. `google.protobuf.FieldMask` is the correct solution: the client sends a `update_mask.paths` list containing only the field names being changed. The server applies only those fields. This is what Google Cloud APIs use for all standard Update methods.

**Protobuf Editions and long-term schema management.** The chapter correctly notes that Editions are opt-in and that proto3 remains fully supported. The senior-level decision: adopt Editions for new service schemas where you need `EXPLICIT` field presence on scalar fields without wrapping them in `optional`. The most common case is distinguishing "the client explicitly set this boolean to false" from "the client did not include this field." In proto3, both produce the zero value (`false`). In Editions with `field_presence = EXPLICIT`, the runtime can detect the difference. Document this decision in the proto style guide so teams adopt Editions consistently rather than mixing syntaxes.

**Code generation as a platform service.** At L6, code generation is not a local dev tool. It is a platform service. The platform team maintains a reproducible `buf.gen.yaml` that generates Go, Java, Python, and TypeScript stubs from a single invocation. Generated SDKs are published to internal package registries (Go module proxy, Maven, PyPI mirror) with semantic versioning tied to the proto version. Teams consume the generated SDK as a dependency, not by running `buf generate` themselves. This approach gives the platform team control over which plugin versions are used, ensures consistency across languages, and lets them deliver generated SDK updates as ordinary package upgrades.

**Wire format compatibility vs JSON compatibility.** The proto evolution incident described in the pitfalls file (renaming a field from `user_id` to `customer_id`) illustrates a critical distinction: protobuf binary format is field-number-based and survives field renames. JSON transcoding (via gRPC-Gateway or `proto.MarshalJSON`) uses field names by default. A rename that is binary-compatible is JSON-breaking. If any of your gRPC services are exposed via gRPC-Gateway or are serialized to JSON for storage, field names become part of the contract. Enforce this with `buf lint --include-imports` using the `FIELD_NAMES_LOWER_CAMEL_CASE` and related rules, and treat JSON-format breaking changes under the same policy as binary-format breaking changes.

---
