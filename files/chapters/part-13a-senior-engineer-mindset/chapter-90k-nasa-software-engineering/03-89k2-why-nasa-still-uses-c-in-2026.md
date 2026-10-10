## 90K.2 Why NASA Still Uses C in 2026

As of 2026, the vast majority of NASA's flight software - the code that runs on
spacecraft processors in the vacuum of space - is written in C. The Curiosity rover, the
Perseverance rover, the James Webb Space Telescope, the Orion spacecraft, and the
Artemis missions all run C code compiled for radiation-hardened processors. This is not
inertia or ignorance. It is a deliberate engineering decision with concrete technical
justifications.

### The Hardware Constraint

Flight computers use radiation-hardened (rad-hard) processors that are generations behind
commercial hardware. The RAD750, which powered Curiosity and several other missions, is a
single-core PowerPC processor running at 200 MHz with access to 256 MB of RAM and 2 GB
of flash storage. The RAD5500, its successor, is a quad-core LEON4 SPARC processor  - 
still orders of magnitude less powerful than a modern smartphone. These processors are
hardened against single-event upsets (SEUs) caused by cosmic radiation, which can flip
bits in memory and corrupt data. Hardening a processor is expensive and time-consuming,
so flight-qualified processors lag commercial ones by 10 to 20 years.

On hardware this constrained, every byte matters. A garbage-collected language like Go or
Java would need a runtime that consumes memory and CPU cycles unpredictably. A GC pause
during a critical maneuver - say, during the "seven minutes of terror" Mars entry,
descent, and landing sequence - could be catastrophic. C gives the programmer
deterministic control over every byte of memory and every CPU cycle.

### Worst-Case Execution Time (WCET)

Safety-critical systems require WCET analysis: proving that a given function will
complete within a fixed time bound under all possible inputs and execution conditions.
This is necessary for hard real-time systems where missing a deadline is a system failure.
NASA uses tools like aiT and Bound-T to compute WCET for C functions running on specific
processor architectures.

WCET analysis requires:
- No dynamic dispatch (virtual function calls with unpredictable targets).
- No garbage collection (GC pauses are unbounded in worst case).
- No dynamic memory allocation (allocator timing is non-deterministic).
- Bounded loop iterations (to compute maximum execution time).
- No recursion (to bound stack depth and execution time).

C satisfies all of these when written according to the Power of 10 rules. Go, Java,
Python, and even C++ (with virtual functions and exceptions) do not.

### The Real-Time Operating System: VxWorks

Most NASA flight software runs on VxWorks, a commercial real-time operating system
(RTOS) from Wind River. VxWorks provides deterministic task scheduling, priority-based
preemption, and microsecond-level timing guarantees. Its kernel is certified to
DO-178C DAL-A (the highest safety level for avionics software). VxWorks supports C and
C++ (with restrictions). It does not support Go, Python, Java, or Rust.

### Why Other Languages Don't Qualify

| Language | Disqualifying Factor | Detail |
|----------|---------------------|--------|
| **Go** | Garbage collector | Stop-the-world pauses violate WCET. Runtime is large (~5MB). No VxWorks port. |
| **Java** | JVM + GC | JVM overhead prohibitive on RAD750. GC pauses unbounded. |
| **Python** | Interpreted | 100x slower than C. GIL prevents real concurrency. Memory overhead extreme. |
| **C++** | Exceptions + RTTI + virtual dispatch | Allowed at JPL only with heavy restrictions (JPL C++ subset). Exceptions banned. RTTI banned. Most STL banned. |
| **Rust** | No VxWorks tier-1 support | No qualified compiler (Ferrocene is automotive, not DO-178C). Limited WCET tooling. No flight heritage. |
| **Ada/SPARK** | Actually qualifies | Used by ESA (European Space Agency). SPARK subset is formally verifiable. Less common at NASA due to workforce availability. |

### Where Go and Python ARE Used at NASA

Go and Python are used extensively at NASA - just not on flight hardware.

**Ground systems** (mission control software, telemetry processing, data pipelines) are
written in Python, Java, and increasingly Go. These systems run on standard Linux servers
with gigabytes of RAM where GC pauses measured in milliseconds are irrelevant.

**Science data processing** (image analysis, spectral analysis, orbital mechanics
calculations) uses Python with NumPy, SciPy, and custom Fortran/C extensions.

**DevOps and infrastructure** at NASA increasingly uses Go for CLI tools, microservices,
and container orchestration - the same domains where Go excels in industry.

The boundary is clear: anything that runs on a spacecraft processor must be C (or
restricted C++). Everything else is fair game for modern languages.

```go
package nasa

// This code would run in a NASA ground system, NOT on a spacecraft.
// Ground systems use Go for telemetry processing, monitoring, and
// mission planning support.

import (
    "context"
    "encoding/binary"
    "fmt"
    "io"
    "time"
)

// Assert checks an invariant and panics if false.
func Assert(condition bool, message string) {
    if !condition {
        panic("assertion failed: " + message)
    }
}

// CCSDSPacketHeader represents a CCSDS (Consultative Committee for
// Space Data Systems) space packet header. This is the standard
// framing format used by virtually all spacecraft.
type CCSDSPacketHeader struct {
    VersionNumber      uint8  // 3 bits
    PacketType         uint8  // 1 bit: 0=telemetry, 1=command
    SecondaryHeaderFlag uint8 // 1 bit
    APID               uint16 // 11 bits: Application Process Identifier
    SequenceFlags      uint8  // 2 bits
    SequenceCount      uint16 // 14 bits
    DataLength         uint16 // 16 bits: data length - 1
}

// TelemetryFrame represents a complete telemetry frame from a spacecraft.
type TelemetryFrame struct {
    Header    CCSDSPacketHeader
    Timestamp time.Time
    Payload   []byte
}

// MaxPayloadSize is the maximum allowed telemetry payload.
// Bounded constant - follows NASA Rule 2.
const MaxPayloadSize = 65536

// MaxFramesPerSecond bounds the processing rate.
const MaxFramesPerSecond = 10000

// TelemetryDecoder decodes CCSDS packets from a spacecraft downlink stream.
type TelemetryDecoder struct {
    source   io.Reader
    maxBytes int64
}

// NewTelemetryDecoder creates a decoder with bounded read limits.
func NewTelemetryDecoder(source io.Reader, maxBytes int64) *TelemetryDecoder {
    Assert(maxBytes > 0, "maxBytes must be positive")
    Assert(maxBytes <= 1<<30, "maxBytes must be <= 1GB")

    return &TelemetryDecoder{
        source:   source,
        maxBytes: maxBytes,
    }
}

// DecodeNext reads and decodes the next CCSDS packet.
func (d *TelemetryDecoder) DecodeNext(ctx context.Context) (*TelemetryFrame, error) {
    select {
    case <-ctx.Done():
        return nil, ctx.Err()
    default:
    }

    // Read 6-byte primary header.
    var headerBytes [6]byte
    _, err := io.ReadFull(d.source, headerBytes[:])
    if err != nil {
        return nil, fmt.Errorf("failed to read CCSDS header: %w", err)
    }

    header := parseCCSDSHeader(headerBytes)

    // Validate data length is bounded.
    payloadSize := int(header.DataLength) + 1
    if payloadSize > MaxPayloadSize {
        return nil, fmt.Errorf("payload size %d exceeds maximum %d", payloadSize, MaxPayloadSize)
    }

    // Read payload with bounded size.
    payload := make([]byte, payloadSize)
    _, err = io.ReadFull(d.source, payload)
    if err != nil {
        return nil, fmt.Errorf("failed to read payload (%d bytes): %w", payloadSize, err)
    }

    return &TelemetryFrame{
        Header:    header,
        Timestamp: time.Now().UTC(),
        Payload:   payload,
    }, nil
}

// parseCCSDSHeader extracts fields from the 6-byte CCSDS header.
func parseCCSDSHeader(b [6]byte) CCSDSPacketHeader {
    word0 := binary.BigEndian.Uint16(b[0:2])
    word1 := binary.BigEndian.Uint16(b[2:4])
    word2 := binary.BigEndian.Uint16(b[4:6])

    return CCSDSPacketHeader{
        VersionNumber:       uint8((word0 >> 13) & 0x07),
        PacketType:          uint8((word0 >> 12) & 0x01),
        SecondaryHeaderFlag: uint8((word0 >> 11) & 0x01),
        APID:                word0 & 0x07FF,
        SequenceFlags:       uint8((word1 >> 14) & 0x03),
        SequenceCount:       word1 & 0x3FFF,
        DataLength:          word2,
    }
}
```

---
