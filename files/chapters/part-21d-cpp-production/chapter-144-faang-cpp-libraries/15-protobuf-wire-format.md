## Protobuf Wire Format

Protocol Buffers is the lingua franca of Google. Every RPC, every disk record, every config blob in google3 is a proto. To work effectively at FAANG scale you need to know what is on the wire, not just the generated API. This file covers the wire format, the generated C++ code, and the corner cases that separate a proto user from a proto expert.

### The Mental Model

A serialized protobuf message is a sequence of (tag, value) pairs. There are no field names on the wire. Decoders work by field number, which is why renumbering a field is a breaking change but renaming it is free.

A tag is a varint that encodes two things:

```
tag = (field_number << 3) | wire_type
```

The bottom 3 bits are the wire type. The top bits are the field number. For field numbers 1 to 15, the entire tag fits in a single byte. This is why frequently-used fields should claim numbers 1 to 15.

### Varint Encoding

A varint encodes an unsigned 64-bit integer in 1 to 10 bytes. Each byte uses 7 bits for payload and 1 bit (the MSB) as a continuation flag. The bytes are little-endian groups of 7 bits.

```
300 in binary:        00000001 00101100
varint groups (7-bit): 0000010 0101100
reverse for LE:        0101100 0000010
add continuation MSB:  10101100 00000010 = 0xAC 0x02
```

Decoder pseudocode:

```cpp
uint64_t ReadVarint(const uint8_t*& p) {
  uint64_t v = 0;
  int shift = 0;
  while (true) {
    uint8_t b = *p++;
    v |= uint64_t(b & 0x7F) << shift;
    if (!(b & 0x80)) return v;
    shift += 7;
  }
}
```

Signed integers (`int32`, `int64`) are encoded as varints by reinterpretation. A negative `int32` therefore costs 10 bytes on the wire (because it sign-extends to 64 bits). For negative numbers you should use `sint32` / `sint64`, which apply zigzag encoding:

```
zigzag(n) = (n << 1) ^ (n >> 31)   // for int32
```

This maps -1 to 1, 1 to 2, -2 to 3, and so on. Small negatives stay small.

### Wire Types

| Wire type | Value | Used for |
|-----------|-------|----------|
| VARINT | 0 | int32, int64, uint32, uint64, sint32, sint64, bool, enum |
| I64 | 1 | fixed64, sfixed64, double |
| LEN | 2 | string, bytes, embedded message, packed repeated |
| SGROUP | 3 | start group (deprecated, proto2 only) |
| EGROUP | 4 | end group (deprecated) |
| I32 | 5 | fixed32, sfixed32, float |

A length-delimited (LEN) field is encoded as `tag, length_varint, payload_bytes`. Strings, embedded messages, and bytes all share this format. The decoder cannot tell them apart from the wire alone, only from the schema.

### Packed Repeated

In proto3, repeated scalar fields are packed by default. Instead of:

```
tag value tag value tag value
```

You get:

```
tag length_varint value value value
```

with wire type LEN and the values concatenated as raw varints (or fixed-width bytes for fixed types). This saves one tag byte per element. For a `repeated int32` of 1000 small numbers, that is roughly 1 KB saved.

In proto2, you must explicitly mark `[packed = true]`. A correct decoder accepts both packed and unpacked encodings of the same field, regardless of how the schema declares it. This is required for forward compatibility.

### Embedded Messages

A nested message is just another length-delimited blob. The parent message has no idea what is inside. This is what makes proto extensible: you can add new fields to the inner message without breaking the outer.

```
message Outer { Inner inner = 1; }
message Inner { int32 x = 1; }

Outer{inner: {x: 42}} encodes to:
0a 02 08 2a
^   ^  ^  ^
|   |  |  +-- value 42 as varint
|   |  +-- tag (field 1, wire type 0) of Inner.x
|   +-- length 2 (Inner is 2 bytes)
+-- tag (field 1, wire type 2) of Outer.inner
```

### oneof

A `oneof` block declares mutually exclusive fields. On the wire, only the set field appears. The generated C++ class stores the oneof as a tagged union: a `case_` enum plus a union of the field types.

```cpp
class Request {
 public:
  enum PayloadCase { kText = 1, kBinary = 2, PAYLOAD_NOT_SET = 0 };
  PayloadCase payload_case() const;
  // ... text() / binary() accessors
};
```

If the parser sees two oneof members in the same message (a malformed encoding or a race), the last one wins. Setting any member clears the others.

### Unknown Fields

If a parser encounters a field number it does not know, it does not error out. It stores the raw bytes in an `UnknownFieldSet`. On reserialization, those bytes are written back, preserving forward compatibility.

This is why a proxy can deserialize, modify, and reserialize a proto without losing fields it has never seen. In proto3, unknown field preservation was off by default in early versions, then reinstated in 2018 because the lossy behavior broke too many systems.

### Deterministic Serialization

Protobuf does not guarantee a canonical encoding by default. Field order in maps is unspecified. Floating point can vary. For caching, signing, or content-addressed storage you need:

```cpp
std::string out;
google::protobuf::io::StringOutputStream stream(&out);
google::protobuf::io::CodedOutputStream coded(&stream);
coded.SetSerializationDeterministic(true);
msg.SerializeToCodedStream(&coded);
```

This sorts map entries by key and stabilizes ordering. It is still not canonical across language implementations, only within the C++ runtime. For true canonical bytes, use a separate canonicalization pass or switch to a format with one (CBOR canonical, JCS for JSON).

### proto2 vs proto3 Semantics

The headline difference is presence tracking.

- proto2: every field has presence. `has_x()` tells you if it was set on the wire. Default values are explicit.
- proto3 (original): no presence for scalars. A field set to its zero value is indistinguishable from unset. No `has_x()` for scalars.
- proto3 (since 2020): you can opt into presence with the `optional` keyword. `has_x()` returns. The wire format becomes identical to proto2 for that field.

The presence question matters for partial updates (PATCH semantics), where "absent" and "zero" must differ. Use `optional` in proto3 for any field that participates in partial updates.

### MessageLite vs Message

The full `Message` base class includes:

- Reflection (iterate fields by descriptor at runtime).
- Text format parsing and printing.
- Descriptor pool.
- Default instance via `MessageFactory`.

All of this pulls in the descriptor metadata. For a binary that only needs to encode and decode, this is dead weight (megabytes of code and data).

`MessageLite` is the slim base. The generated code uses `LITE_RUNTIME` mode if the `.proto` file declares `option optimize_for = LITE_RUNTIME;`. The generated class then inherits from `MessageLite` and skips reflection. Used in mobile (Android Play services) and embedded binaries to keep size down.

Trade-off: no `DebugString()`, no text format, no `MergeFrom` between dynamically loaded types. Most server code at Google uses the full runtime.

### Generated C++ Code Anatomy

Given:

```proto
syntax = "proto3";
package example;
message User {
  string name = 1;
  int32 age = 2;
  repeated string emails = 3;
}
```

The generated header contains:

```cpp
class User final : public ::google::protobuf::Message {
 public:
  // Constructors
  User();
  User(const User&);
  User(User&&) noexcept;

  // Field 1: name
  const std::string& name() const;
  void set_name(absl::string_view value);
  std::string* mutable_name();
  void clear_name();

  // Field 2: age
  int32_t age() const;
  void set_age(int32_t value);
  void clear_age();

  // Field 3: emails (repeated)
  int emails_size() const;
  const std::string& emails(int index) const;
  std::string* mutable_emails(int index);
  void add_emails(absl::string_view value);
  const ::google::protobuf::RepeatedPtrField<std::string>& emails() const;
  ::google::protobuf::RepeatedPtrField<std::string>* mutable_emails();

  // Reflection
  static const ::google::protobuf::Descriptor* descriptor();
  static const User& default_instance();

  // Serialization
  bool SerializeToString(std::string* out) const;
  bool ParseFromString(const std::string& in);
  size_t ByteSizeLong() const;
};
```

The implementation in `.pb.cc` includes the `_InternalParse` function (a generated tail-recursive parser, since 2020 the "table-driven" parser), `_InternalSerialize`, and the descriptor table that registers field metadata.

The generated parser is hand-tuned per message. It opens a switch on the tag varint with cases for each field number, reads the value with the right wire type, and stores it directly into the message. No reflection on the hot path. This is why protobuf parsing is competitive with hand-rolled binary formats.

### Arena Allocation

`google::protobuf::Arena` is a bump allocator. You pass an arena to a message constructor:

```cpp
google::protobuf::Arena arena;
User* u = google::protobuf::Arena::CreateMessage<User>(&arena);
```

All sub-objects allocated via the arena live and die together. No per-field free, no destructor calls (for trivially destructible types). For high-QPS RPC servers, arenas turn allocation cost from O(fields) to O(1) per request.

### Junior to FAANG: Wire Format Fluency

A junior says "protobuf is binary JSON". A FAANG-track engineer can decode `0a 05 68 65 6c 6c 6f` by hand (field 1, length 5, "hello") and explain why renaming a field is safe but renumbering breaks every existing consumer. In an interview you will be asked to debug a proto compatibility issue. The wire format is the answer.

### Senior at FAANG: Schema Evolution Rules

The hard-won rules every Google engineer internalizes:

1. Never reuse a field number. Use `reserved 5;` to fence off retired numbers.
2. Never change a field's type, except within the compatible families (int32 / int64 / uint32 / uint64 / bool all share wire type VARINT and round-trip cleanly within range).
3. Adding a field is always safe.
4. Removing a field is safe if no consumer depends on it. Mark `reserved` for the number and name.
5. Changing `optional` to `repeated` of the same type is safe (a singleton is a one-element repeated).
6. Changing `singular` to `oneof` is risky. Document and stage.

These rules let a multi-thousand-service mesh evolve without coordinated deploys. That is the real value of protobuf at scale.
