## 31.4 JSON Processing

### Streaming JSON

Go's `json.Decoder` reads JSON tokens incrementally from an `io.Reader`, so it can process a multi-gigabyte JSON array without loading the entire document into memory.

> **Senior track**: As of Go 1.27 the `encoding/json/v2` package is generally available, no experiment flag required. It splits concerns into `encoding/json/jsontext` (syntactic tokenizer/encoder) and `encoding/json/v2` (semantic marshal/unmarshal). The streaming story is the biggest win: `UnmarshalDecode` consumes one JSON value at a time from a `jsontext.Decoder`, and `MarshalJSONTo` / `UnmarshalJSONFrom` let custom types participate without allocating intermediate `[]byte`. Benchmarks show v1 parity on marshal and roughly 2-4x faster unmarshal. v1 stays permanently present for compatibility, so keep library APIs on v1 and reach for v2 in hot paths. For call sites that just need to skip unknown fields or treat zero values consistently, v1 + `omitzero` (added in Go 1.24) covers most cases. The first example below walks a JSON array element by element using `dec.Token()` and `dec.More()`. The second handles newline-delimited JSON (NDJSON), where each line is a separate JSON object, a format common in log pipelines and event streams.

```go
package main

import (
    "encoding/json"
    "io"
    "os"
)

// Stream JSON array
func processJSONArray(path string, process func(item json.RawMessage) error) error {
    f, err := os.Open(path)
    if err != nil {
        return err
    }
    defer f.Close()

    dec := json.NewDecoder(f)

    // Read opening bracket
    _, err = dec.Token()
    if err != nil {
        return err
    }

    // Process array elements
    for dec.More() {
        var item json.RawMessage
        if err := dec.Decode(&item); err != nil {
            return err
        }

        if err := process(item); err != nil {
            return err
        }
    }

    return nil
}

// Stream JSON objects (newline-delimited JSON)
func processNDJSON(path string, process func(item json.RawMessage) error) error {
    f, err := os.Open(path)
    if err != nil {
        return err
    }
    defer f.Close()

    dec := json.NewDecoder(f)

    for {
        var item json.RawMessage
        if err := dec.Decode(&item); err == io.EOF {
            break
        } else if err != nil {
            return err
        }

        if err := process(item); err != nil {
            return err
        }
    }

    return nil
}

// Write streaming JSON
func writeJSONStream(path string, items <-chan any) error {
    f, err := os.Create(path)
    if err != nil {
        return err
    }
    defer f.Close()

    enc := json.NewEncoder(f)
    enc.SetIndent("", "  ")

    f.WriteString("[\n")
    first := true

    for item := range items {
        if !first {
            f.WriteString(",\n")
        }
        first = false

        if err := enc.Encode(item); err != nil {
            return err
        }
    }

    f.WriteString("]\n")
    return nil
}
```

### JSON with Large Files

For large files, wrap the opened file in a `bufio.Reader` and pass that to `json.NewDecoder` rather than reading the whole file with `os.ReadFile` and calling `json.Unmarshal`. The decoder pulls bytes only as it parses, so peak memory tracks the size of the deepest single value, not the document. The pattern below parses an outer envelope as `json.RawMessage` and defers decoding of nested sections until the concrete schema is known, useful for polymorphic payloads where the discriminator lives in the metadata. Progress reporting wraps the file in the `ProgressReader` from section 31.2 before handing it to `json.NewDecoder`.

```go
package main

import (
    "encoding/json"
    "os"
)

// Partial JSON parsing for large objects
type LargeDoc struct {
    Metadata json.RawMessage `json:"metadata"`
    Data     json.RawMessage `json:"data"`
}

func processLargeJSON(path string) error {
    f, err := os.Open(path)
    if err != nil {
        return err
    }
    defer f.Close()

    var doc LargeDoc
    if err := json.NewDecoder(f).Decode(&doc); err != nil {
        return err
    }

    // Now parse only what we need
    var metadata struct {
        Version string `json:"version"`
        Count   int    `json:"count"`
    }
    if err := json.Unmarshal(doc.Metadata, &metadata); err != nil {
        return err
    }

    // Process data section separately or stream it
    return nil
}
```

### Junior to FAANG: JSON habits that cost performance and safety

The examples above are pedagogically clean and have several production gaps. Walk through them.

`writeJSONStream` writes a JSON array by hand, calling `f.WriteString("[\n")` and `f.WriteString(",\n")` between items. This is correct but fragile. Mixing `f.WriteString` (no buffering, no flushing) with `enc.Encode` (buffered inside the encoder) produces unspecified interleaving when both target the same file. The fix is to wrap `f` in a single `bufio.Writer`, write everything through that, and flush at the end. Also note that `enc.Encode` appends a newline after every value, so the produced output is technically a list of JSON values with commas between them, which happens to also be valid JSON array syntax but only because of the `\n` luck. Use NDJSON (newline delimited JSON) or `jsonl` for streaming output whenever you control the consumer, because it allows line based tooling (`grep`, `jq -c`, `wc -l`) to work without parsing the whole file.

`processLargeJSON` uses `json.Decoder` on the raw `*os.File`, which issues one `read` syscall per token in worst case. Always wrap in `bufio.NewReaderSize(f, 1<<20)` first. This is a 5 to 10x speedup on typical JSON files.

Streaming through `json.RawMessage` followed by a second `json.Unmarshal` doubles the parse cost. For polymorphic payloads, the cheaper pattern is `json.Decoder.Token()` based streaming to locate the discriminator, then decode into the concrete type in one pass. The `json.RawMessage` pattern is fine for prototype code and wrong for hot paths.

Input size limits are often missing. `json.Decoder` without `io.LimitReader` will happily allocate gigabytes if handed an adversarial input. Always wrap with `io.LimitReader(f, maxSize)` for any input from an untrusted source, and set `maxSize` based on your actual business limit (typically 1 MB for API bodies, 100 MB for bulk uploads).

The `omitempty` versus `omitzero` distinction is a frequent production bug. `omitempty` skips zero values and empty collections, which means `0`, `""`, `false`, and `nil` all get dropped. For a `count` field, this silently turns legitimate zero into missing. `omitzero` (Go 1.24+) respects the `IsZero()` method on the type and allows types to declare their own zero semantics. Use `omitzero` on new code when you care about the distinction between "field is zero" and "field is absent".

For the interview frame, when asked "parse a 10 GB JSON file", the answer structure is: (1) `bufio.Reader` around the file, (2) `json.Decoder` with `UseNumber()` if numbers might exceed float64 precision, (3) `io.LimitReader` if input is untrusted, (4) stream array elements with `dec.More()` and `dec.Decode`, (5) process element by element with bounded concurrency, (6) checkpoint position for resumability via `dec.InputOffset()`. Walking this list is an L5 answer.

### Senior @ FAANG: JSON at the scale where every nanosecond and every byte matters

JSON at FAANG is a two mode problem. Mode one is external interop where JSON is mandated by protocol (REST APIs, webhook payloads, OpenAPI contracts) and you optimize within that constraint. Mode two is internal where JSON is a choice and usually the wrong one, but migration cost keeps it alive. The senior framing is different in each.

External mode optimization centers on parser selection. The stdlib `encoding/json` in Go 1.27 is correct and competitive but not fastest. For high throughput services, the landscape is:

`github.com/bytedance/sonic` uses JIT code generation and SIMD to parse JSON at 2 to 5 GB/s on AMD64. It is ByteDance's production JSON library, battle tested on TikTok scale. It supports `json.RawMessage`, custom marshalers, and drop in replacement for stdlib in most cases. The tradeoffs are longer compile times due to JIT warmup, AMD64 only until ARM64 support stabilized in 2024, and occasional edge case divergence from stdlib semantics around number precision.

`github.com/goccy/go-json` is pure Go with aggressive reflection caching and achieves roughly 2x stdlib. Lower peak throughput than sonic, but simpler ops story (no JIT, no architecture restrictions).

`github.com/valyala/fastjson` is lazy parsing, meaning it scans to find value locations but does not allocate until you read a field. For workloads where you only need 5 fields out of 100, this is 10x faster than full parse.

`github.com/minio/simdjson-go` is a Go port of the C++ simdjson library, achieving multiple GB/s on AVX2. It produces a parsed tree that you query, not direct struct decode. Best for analytics workloads where you run many queries per document.

Picking between them is an SLO question, not a taste question. Measure parse latency at p99 on your real workload, compare to your SLO budget, and choose. Most services do not need anything faster than stdlib. The ones that do are typically ingress proxies, log aggregators, and real time feature stores.

`encoding/json/v2` is the stdlib answer, GA in Go 1.27 with no experiment flag. The design split into `jsontext` (syntactic) and `json/v2` (semantic) is deliberately parallel to Rust's `serde_json` plus `serde`. Key wins are 2 to 4x faster unmarshal, first class streaming via `UnmarshalDecode`, and a clean error model that reports the exact JSON path of decoding failures. The migration cost is moderate because v2 is not bit for bit compatible with v1 around edge cases (duplicate keys, null to empty string, number precision). v1 stays permanently present for compatibility. Senior policy is to stay on v1 for library APIs, adopt v2 in hot paths, and migrate where the benchmark justifies it.

JSON DoS attacks are a class, not a bug. The canonical attacks are:

Deep nesting, for example `[[[[[...]]]]]` with 10000 brackets, causes recursive parsers to blow the stack or allocate recursion depth memory. Stdlib `json.Decoder` has no nesting limit by default. `json/v2` added `jsontext.Decoder` with a configurable `MaxDepth`. Mitigation in v1 is to preprocess with a token counter that rejects beyond a depth threshold, or to wrap with a custom reader that counts open brackets.

Huge strings, for example one string field of 1 GB, cause memory exhaustion on unmarshal. Mitigation is `io.LimitReader` and per field size limits during validation.

Hash collision attacks on map keys are a lower severity issue in Go because `map[string]` uses a randomized hash, but worst case performance on large maps is still O(n) and can be weaponized against services that build maps from untrusted JSON. Mitigation is bounded map size during validation.

Duplicate keys are allowed by JSON spec but most consumers expect last wins. Stdlib v1 takes last wins. v2 has a configurable behavior (error, first wins, last wins). For security sensitive use cases like JWT claims, duplicate key handling differences across libraries have been exploited for parser confusion attacks. If you parse JSON security tokens, pin the library and the parsing options, and document the expectation.

For petabyte scale JSON (Kafka event streams, webhook replay logs, audit trails), the correct storage is not JSON. You ingest JSON, validate against schema, convert to Parquet with ZSTD compression, and retain Parquet. JSON on disk at scale costs 5 to 10x Parquet in storage and 50 to 100x in query time. The conversion pipeline is often the first thing a new data platform team builds.

Schema evolution for JSON is weaker than Avro or Protobuf because JSON has no schema. The common pattern is JSON Schema (draft 2020-12) in a registry, with CI enforcement of evolution rules. Forward compatibility in JSON is naturally strong because unknown fields are ignored by default, backward compatibility requires discipline because removing a required field breaks old producers. At LinkedIn and Confluent, JSON Schema evolution is enforced via the Schema Registry's compatibility mode. Internally, Protobuf or Avro is preferred for new pipelines because the schema is part of the wire format and evolution rules are enforced mechanically.

Canonical JSON for signatures is a subtle topic. If you sign a JSON document, you must define a canonical serialization. Otherwise different serializers produce different byte sequences for the same document (key order, number formatting, whitespace) and signatures fail to verify. RFC 8785 (JSON Canonicalization Scheme) is the standard, and `github.com/cyberphone/json-canonicalization` implements it in Go. Homegrown canonicalization has shipped CVEs. Use the standard.

For custom marshalers in hot paths, prefer `MarshalJSON` over reflection based tag driven marshaling, because reflection costs 200 to 500 ns per call and custom marshalers can be 10x faster. Code generation via `ffjson` or `easyjson` was the Go 1.x answer, and in Go 1.27 the combination of v2 streaming APIs plus generics based helpers has reduced the need for code generation. Benchmark your workload before committing to code gen because maintenance cost is real.

---
