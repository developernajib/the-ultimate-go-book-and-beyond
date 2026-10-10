## Summary

| Topic | Key Tool | When to Use |
|-------|----------|-------------|
| Enum String() | stringer | Any exported int-based enum |
| Mock generation | mockgen | Any interface used for testing |
| Type-safe SQL | sqlc | PostgreSQL/MySQL queries in Go services |
| Custom generation | go/ast + template | Project-specific boilerplate |
| Plugins | hashicorp/go-plugin | Extensions in separate processes |
| File embedding | embed.FS | Templates, migrations, web assets in binaries |
| DI small project | Manual wiring | Under 20 services, always readable |
| DI medium project | Google Wire | Type-safe, compile-time checked, no reflection |
| DI large project | Uber Fx | Teams, lifecycle management, complex graphs |
| Serialization APIs | encoding/json | External APIs, human-readable |
| Serialization gRPC | Protobuf | Internal services, high throughput |
| Serialization cache | MessagePack | Redis, smaller than JSON |
| Serialization Go↔Go | encoding/gob | Long-lived Go-to-Go streams, native Go types. Reuse one Encoder: a fresh Encoder per message re-sends type definitions and is slower and larger than JSON |

---

*Next chapter: Chapter 26 - Feature Flags & Configuration*

### For the Senior-at-FAANG Track

Adopt code generation systematically, use embed for self-contained binaries, and pick a DI approach deliberately.

### For the Staff and Principal Track

Drive org-wide standards for code generation, serialization, dependency injection. Consistency compounds value over years.
