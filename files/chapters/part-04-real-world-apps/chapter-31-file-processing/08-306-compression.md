## 31.6 Compression

### Gzip Compression

The compressor wraps the destination `io.Writer` with `gzip.NewWriter`, so data written to the gzip writer is compressed on the fly and flushed to the underlying destination without buffering the entire compressed output in memory.

> **Senior track**: For production throughput, replace `compress/gzip` with `github.com/klauspost/compress/gzip`, a drop-in API-compatible package that is roughly 2x faster on decode and 30-50% faster on encode thanks to assembly-optimized DEFLATE. For new formats, `github.com/klauspost/compress/zstd` gives much better ratio/speed tradeoff than gzip and is standard in modern pipelines (Kafka, Zstandard HTTP, Parquet, container images). The stdlib has no `compress/zstd`, so the klauspost module is the canonical choice. At the edge of the stack, `io.Copy` between a gzip/zstd reader and a sink lets the runtime hand off large copies via `WriteTo`/`ReadFrom` fast paths, avoid inserting an unnecessary `bufio.Writer` between them, it usually hurts. `gzip.Writer.Close()` must be called explicitly (not just deferred on the outer file) to flush the gzip footer. Omitting it produces a truncated archive that decompressors reject. For parallel compression of large files, the file is split into fixed-size chunks processed concurrently by a worker pool, with the compressed chunks written to the output in order using a sequencing channel.

```go
package main

import (
    "compress/gzip"
    "io"
    "os"
)

// Compress file
func gzipCompress(src, dst string) error {
    srcFile, err := os.Open(src)
    if err != nil {
        return err
    }
    defer srcFile.Close()

    dstFile, err := os.Create(dst)
    if err != nil {
        return err
    }
    defer dstFile.Close()

    gw := gzip.NewWriter(dstFile)
    defer gw.Close()

    _, err = io.Copy(gw, srcFile)
    return err
}

// Decompress file
func gzipDecompress(src, dst string) error {
    srcFile, err := os.Open(src)
    if err != nil {
        return err
    }
    defer srcFile.Close()

    gr, err := gzip.NewReader(srcFile)
    if err != nil {
        return err
    }
    defer gr.Close()

    dstFile, err := os.Create(dst)
    if err != nil {
        return err
    }
    defer dstFile.Close()

    _, err = io.Copy(dstFile, gr)
    return err
}

// Read compressed file directly
func readGzipFile(path string) ([]byte, error) {
    f, err := os.Open(path)
    if err != nil {
        return nil, err
    }
    defer f.Close()

    gr, err := gzip.NewReader(f)
    if err != nil {
        return nil, err
    }
    defer gr.Close()

    return io.ReadAll(gr)
}
```

### Zip Archives

The `archive/zip` package reads and writes ZIP archives. Creating a ZIP iterates over source files, adds each one through `zip.Writer.CreateHeader`, and copies the file contents into the archive entry. Extraction uses `zip.OpenReader` to iterate the central directory and write each entry to disk. The extraction code below includes a path traversal check, without it, a malicious archive could write files outside the destination directory.

```go
package main

import (
    "archive/zip"
    "fmt"
    "io"
    "os"
    "path/filepath"
    "strings"
)

// Create zip archive
func createZip(archivePath string, files []string) error {
    archive, err := os.Create(archivePath)
    if err != nil {
        return err
    }
    defer archive.Close()

    zipWriter := zip.NewWriter(archive)
    defer zipWriter.Close()

    for _, file := range files {
        if err := addToZip(zipWriter, file); err != nil {
            return err
        }
    }

    return nil
}

func addToZip(zw *zip.Writer, path string) error {
    f, err := os.Open(path)
    if err != nil {
        return err
    }
    defer f.Close()

    info, err := f.Stat()
    if err != nil {
        return err
    }

    header, err := zip.FileInfoHeader(info)
    if err != nil {
        return err
    }
    header.Name = filepath.Base(path)
    header.Method = zip.Deflate

    writer, err := zw.CreateHeader(header)
    if err != nil {
        return err
    }

    _, err = io.Copy(writer, f)
    return err
}

// Extract zip archive
func extractZip(archivePath, destDir string) error {
    r, err := zip.OpenReader(archivePath)
    if err != nil {
        return err
    }
    defer r.Close()

    for _, f := range r.File {
        path := filepath.Join(destDir, f.Name)

        // Prevent path traversal
        if !strings.HasPrefix(path, filepath.Clean(destDir)+string(os.PathSeparator)) {
            return fmt.Errorf("invalid file path: %s", f.Name)
        }

        if f.FileInfo().IsDir() {
            os.MkdirAll(path, os.ModePerm)
            continue
        }

        if err := extractFile(f, path); err != nil {
            return err
        }
    }

    return nil
}

func extractFile(f *zip.File, destPath string) error {
    os.MkdirAll(filepath.Dir(destPath), os.ModePerm)

    destFile, err := os.OpenFile(destPath, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, f.Mode())
    if err != nil {
        return err
    }
    defer destFile.Close()

    srcFile, err := f.Open()
    if err != nil {
        return err
    }
    defer srcFile.Close()

    _, err = io.Copy(destFile, srcFile)
    return err
}
```

### Junior → FAANG: Prerequisites and Interview Framing

Compression is one of those topics where the stdlib API hides a mountain of detail. To reason about it productively, internalize three facts. First, compression trades CPU for bytes, and the exchange rate depends on your data. English text compresses roughly 3x to 5x with gzip. Already-compressed data (JPEGs, MP4, zstd streams) compresses near 1x and wastes CPU. JSON logs compress 10x to 20x because they are full of repeated field names. Second, compression is streaming, not a transform. You feed bytes into a writer, it emits fewer bytes, and closing the writer flushes a final block with a footer. Forgetting to close is the most common junior bug and produces a file that looks fine until a downstream tool rejects it with "unexpected EOF." Third, decompression is untrusted input. A 1 KB zip bomb can expand to 4 GB. Always use `io.LimitReader` on the decompressed side in any code that handles user uploads.

A worked example for a first-job context. You are asked to compress hourly log files before uploading to S3. The naive approach is `io.Copy(gzipWriter, logFile)` and done. The production approach adds: buffered output with a 64 KB `bufio.Writer` on the underlying file to amortize syscalls, an explicit `gw.Close()` before `dstFile.Close()` so the gzip trailer is flushed before the file handle goes away, a size check that skips compression if the source is under a few KB (the gzip header overhead exceeds the savings), and a content-type check that skips compression if the file is already a binary blob like `.parquet` or `.zst`. These four additions separate a hobby script from code that ships.

Interview framing for compression usually goes one of two ways. The algorithmic version asks you to explain DEFLATE (LZ77 back-references plus Huffman coding) or compare run-length encoding to dictionary coding. The systems version asks when you would pick gzip versus zstd versus lz4. The correct answer to the latter is always "it depends on the workload," followed by a concrete breakdown: lz4 for in-memory caches and RPC where decode latency dominates, zstd level 3 for general-purpose storage, zstd level 19 with a trained dictionary for cold archival of homogeneous data, gzip only for compatibility with legacy systems that cannot decode zstd. Candidates who name a single "best" compressor fail the signal.

### Senior @ FAANG: Compression Economics, Dictionary Training, and Workload-Specific Codec Selection

At senior level, compression is an economics problem disguised as an engineering problem. The question is never "does this compress," it is "what does a one percent improvement in ratio cost in CPU-seconds, and does that exchange rate beat the S3 bill or the network egress bill at our volume." At Uber or Netflix scale, a two percent ratio improvement on a petabyte-per-day log pipeline is hundreds of thousands of dollars a year, which justifies a full-time engineer on codec tuning.

Workload-specific codec selection breaks down along three axes: access pattern, data homogeneity, and latency budget. For write-once-read-many analytical data (Parquet columnar files sitting in S3 waiting for Presto queries), zstd at level 3 to 9 is the sweet spot, and the columnar layout already does most of the work by grouping similar values together. For write-many-read-rarely archival (compliance logs, old metrics), zstd at level 19 with dictionary training on a representative sample squeezes out an extra 15 to 30 percent over stock zstd. For log ingest pipelines where you are compressing in a hot ingestion path, lz4 or zstd level 1 keeps the producer from backpressuring, and you recompress at rest in a background tier. For OLTP backups, zstd level 3 with a dictionary trained on your schema's typical row content is the default because restore time matters more than write throughput.

Zstd dictionary training is the single most effective compression technique most teams have never tried. Run `zstd --train samples/* -o mydict` against a few hundred megabytes of representative payloads, ship the dictionary with your decoder, and reference it on both ends. For small records (under a few KB) this typically doubles the compression ratio because the dictionary preloads the LZ window with your domain's common byte sequences. The klauspost/compress/zstd package supports dictionaries via `zstd.WithEncoderDict` and `zstd.WithDecoderDicts`. This matters most for columnar storage of structured records (Parquet page compression, BigTable SSTables, Cassandra with LZ4-or-zstd per-block compression), for RPC payload compression with known schema, and for Kafka message compression when messages share a schema registry entry. The operational cost is that you must version the dictionary and ship it alongside compressed data, typically by embedding a dictionary ID in the message header.

Brotli is the right choice for web assets served over HTTPS. It beats gzip by 15 to 25 percent on HTML, CSS, and JavaScript thanks to a built-in static dictionary of web-common strings. Modern browsers negotiate `Accept-Encoding: br` and Cloudflare, Fastly, and Akamai all serve brotli by default at edge. For your own Go services that serve browser clients, `github.com/andybalholm/brotli` is the canonical Go implementation. Do not use brotli for non-web binary data: its static dictionary is web-specific and hurts ratio on, say, protobuf streams, where zstd wins.

The zip bomb and decompression attack surface is a recurring CVE class. For any code that accepts compressed input from untrusted users, enforce three limits: wrap the decompressed stream in `io.LimitReader(r, maxSize)` where maxSize is a generous but finite bound, track the ratio between compressed input and decompressed output bytes and abort if it exceeds a threshold like 100x, and bound total wall time on decompression so an adversarial crafted file cannot DoS a worker by consuming CPU. For ZIP specifically the additional attack is zip-slip, where a crafted entry name like `../../../etc/passwd` escapes the extraction directory. The defense is the `filepath.Join` plus `strings.HasPrefix` check shown above, but the better defense in 2026 is `filepath.IsLocal` (Go 1.20+) which rejects any path that escapes or is absolute. Combine both for defense in depth. Also validate that the entry's declared uncompressed size and the actual stream length match, otherwise a malicious archive can lie in the central directory and smuggle extra bytes.

Parallel compression at large scale uses either pigz-style block parallelism (split input into fixed chunks, compress each chunk independently, concatenate) or pzstd-style frame parallelism (each frame is a valid zstd stream). Go implementations: `github.com/klauspost/pgzip` for gzip, and zstd's native multithreaded encoder via `zstd.WithEncoderConcurrency(n)`. For the decode side, zstd frames can be decoded in parallel only if the producer wrote them as independent frames, which is a producer-side choice you need to make explicitly. The subtle pitfall is that parallel gzip output is still a valid gzip stream (gzip supports concatenation), so consumers do not need to know you used pigz, but parallel zstd requires the frame-per-chunk layout that not every decoder handles.

Memory budgets matter at FAANG scale because you run thousands of goroutines each with their own compressor state. A zstd encoder at level 19 with a 128 MB window holds that window in memory per instance. Pool them with `sync.Pool` using `zstd.NewWriter(nil, opts...)` and `encoder.Reset(w)` between uses. The same pattern applies to gzip writers. Skipping the pool and allocating fresh compressors in a request handler is a memory bug you will only find under load.

Checksum-on-compress is the correct default. zstd includes an optional 32-bit xxhash of the uncompressed content in the frame footer, enabled by `zstd.WithEncoderCRC(true)`. Always turn this on for storage. Combined with the per-record CRC from your binary format, you get corruption detection at two layers, which catches the real-world case where the compressed stream is intact but the underlying storage silently bit-flipped a decompressed page.

---
