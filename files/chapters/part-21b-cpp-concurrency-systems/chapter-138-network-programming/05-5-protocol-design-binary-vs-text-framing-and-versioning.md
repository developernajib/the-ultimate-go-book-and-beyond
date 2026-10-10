## 5. Protocol Design: Binary vs Text, Framing, and Versioning

### Binary vs Text Protocols

Text protocols (HTTP/1.1, SMTP, Redis RESP) are human-readable and debuggable with `telnet` or `curl`. Binary protocols (HTTP/2, Protocol Buffers, MessagePack) are compact and fast to parse.

```cpp
// Text protocol: simple key-value store
// SET key value\r\n
// GET key\r\n
// Response: +OK\r\n or $<len>\r\n<data>\r\n

// Binary protocol: length-prefixed frames
struct BinaryFrame {
    uint8_t  version;     // protocol version
    uint8_t  type;        // message type
    uint16_t flags;       // bitfield for options
    uint32_t length;      // payload length (network byte order)
    // followed by `length` bytes of payload
} __attribute__((packed));

// Encode a binary frame
std::vector<uint8_t> encode_frame(uint8_t type, uint16_t flags,
                                   std::span<const uint8_t> payload) {
    std::vector<uint8_t> buf(sizeof(BinaryFrame) + payload.size());
    auto* header = reinterpret_cast<BinaryFrame*>(buf.data());
    header->version = 1;
    header->type = type;
    header->flags = htons(flags);
    header->length = htonl(static_cast<uint32_t>(payload.size()));
    std::memcpy(buf.data() + sizeof(BinaryFrame), payload.data(), payload.size());
    return buf;
}

// Decode - returns payload span or empty on incomplete data
std::optional<std::span<const uint8_t>>
decode_frame(std::span<const uint8_t> data, BinaryFrame& header) {
    if (data.size() < sizeof(BinaryFrame)) return std::nullopt;

    std::memcpy(&header, data.data(), sizeof(BinaryFrame));
    header.flags = ntohs(header.flags);
    header.length = ntohl(header.length);

    size_t total = sizeof(BinaryFrame) + header.length;
    if (data.size() < total) return std::nullopt;

    return data.subspan(sizeof(BinaryFrame), header.length);
}
```

### Framing Strategies

Without framing, TCP's byte stream has no message boundaries. Three common approaches:

1. **Length-prefixed**: A fixed-size header encodes the payload length. Used by gRPC, Kafka, and most binary protocols. Simple and efficient.
2. **Delimiter-based**: Messages end with a special byte sequence (`\r\n` in HTTP/1.1, `\0` in some protocols). Requires scanning every byte and escaping the delimiter in payloads.
3. **Fixed-size**: Every message is exactly N bytes. Rarely used outside specialized systems (financial exchanges with fixed-width fields).

### Versioning

Every protocol evolves. Plan for it from day one:

```cpp
// Version negotiation in the handshake
struct Handshake {
    uint32_t magic = 0x4E455450;    // "NETP" - identifies our protocol
    uint8_t  min_version = 1;
    uint8_t  max_version = 3;
    uint16_t reserved = 0;
};

// Server picks the highest mutually supported version
uint8_t negotiate_version(const Handshake& client, const Handshake& server) {
    uint8_t version = std::min(client.max_version, server.max_version);
    if (version < client.min_version || version < server.min_version) {
        return 0;  // no compatible version
    }
    return version;
}
```

**Design rules**: Use additive-only changes within a version. Add new fields with default values. Never remove or reorder fields. Bump the major version for breaking changes.

---
