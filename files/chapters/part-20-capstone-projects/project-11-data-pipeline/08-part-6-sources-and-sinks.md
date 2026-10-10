## Part 6: Sources and Sinks

Sources are where data enters the pipeline, and sinks are where processed data leaves. This part defines the interfaces for both, then provides concrete implementations for common systems like Kafka (for streaming) and files (for batch). The source and sink interfaces are designed to be easy to extend, so you can add connectors for databases, HTTP APIs, or any other data system.

### Source Interface

The `Source` interface defines how data is read into a pipeline. Every source has a name, a `Read` method that returns a channel of elements, a size estimate for planning, and a `Split` method that can divide the source into smaller pieces for parallel reading. We also define `BoundedSource` for finite datasets (like files) and `UnboundedSource` for continuous streams (like Kafka topics). The `SourceTransform` wraps a source so it can participate in the pipeline's transform graph.

```go
// pkg/pipeline/source.go
package pipeline

import (
    "context"
    "io"
)

// Source reads data into the pipeline
type Source interface {
    Name() string
    Read(ctx context.Context) (<-chan Element, error)
    EstimateSize() int64
    Split(desiredBundles int) ([]Source, error)
}

// BoundedSource reads a finite amount of data
type BoundedSource interface {
    Source
    IsBounded() bool
}

// UnboundedSource reads continuous data
type UnboundedSource interface {
    Source
    GetWatermarkEstimator() WatermarkEstimator
}

// SourceTransform wraps a source as a transform
type SourceTransform struct {
    BaseTransform
    source Source
    output *PCollection
}

func (t *SourceTransform) Process(ctx context.Context, in <-chan Element, out chan<- Element) error {
    elements, err := t.source.Read(ctx)
    if err != nil {
        return err
    }

    for {
        select {
        case <-ctx.Done():
            return ctx.Err()
        case elem, ok := <-elements:
            if !ok {
                return nil
            }

            select {
            case out <- elem:
            case <-ctx.Done():
                return ctx.Err()
            }
        }
    }
}
```

### Kafka Source

The `KafkaSource` reads messages from an Apache Kafka topic, which is one of the most common patterns for real-time data pipelines. It creates a Kafka consumer with a consumer group ID so that multiple pipeline instances can share the workload. Each Kafka message is converted into a pipeline `Element` with the message key, deserialized value, and event time taken from the Kafka message timestamp. Messages are committed after successful processing to ensure at-least-once delivery semantics.

```go
// pkg/pipeline/source_kafka.go
package pipeline

import (
    "context"
    "encoding/json"
    "fmt"
    "time"

    "github.com/segmentio/kafka-go"
)

// KafkaSource reads from Kafka
type KafkaSource struct {
    brokers []string
    topic   string
    groupID string
    reader  *kafka.Reader
}

func NewKafkaSource(brokers []string, topic, groupID string) *KafkaSource {
    return &KafkaSource{
        brokers: brokers,
        topic:   topic,
        groupID: groupID,
    }
}

func (s *KafkaSource) Name() string {
    return fmt.Sprintf("Kafka(%s)", s.topic)
}

func (s *KafkaSource) Read(ctx context.Context) (<-chan Element, error) {
    s.reader = kafka.NewReader(kafka.ReaderConfig{
        Brokers:  s.brokers,
        Topic:    s.topic,
        GroupID:  s.groupID,
        MinBytes: 10e3, // 10KB
        MaxBytes: 10e6, // 10MB
    })

    out := make(chan Element, 100)

    go func() {
        defer close(out)
        defer s.reader.Close()

        for {
            msg, err := s.reader.FetchMessage(ctx)
            if err != nil {
                if err == context.Canceled || err == context.DeadlineExceeded {
                    return
                }
                // Log error and continue
                continue
            }

            // Parse message
            var value any
            if err := json.Unmarshal(msg.Value, &value); err != nil {
                value = string(msg.Value)
            }

            elem := Element{
                Value:     value,
                Key:       string(msg.Key),
                Timestamp: time.Now(),
                EventTime: msg.Time,
            }

            select {
            case out <- elem:
                // Commit message
                if err := s.reader.CommitMessages(ctx, msg); err != nil {
                    // Log error
                }
            case <-ctx.Done():
                return
            }
        }
    }()

    return out, nil
}

func (s *KafkaSource) EstimateSize() int64 {
    return -1 // Unbounded
}

func (s *KafkaSource) Split(desiredBundles int) ([]Source, error) {
    // Could split by partition
    return nil, fmt.Errorf("splitting not supported for Kafka source")
}

func (s *KafkaSource) GetWatermarkEstimator() WatermarkEstimator {
    return NewBoundedOutOfOrdernessWatermark(5 * time.Second)
}
```

### File Source

The `FileSource` reads data from local files and supports multiple formats: plain text (one element per line), JSON arrays, JSON Lines (one JSON object per line), and CSV with headers. It uses a glob pattern to match multiple files, so you can process an entire directory with a single source like `"data/*.csv"`. The source can also be split into smaller bundles for parallel reading, where each bundle handles a subset of the matched files.

```go
// pkg/pipeline/source_file.go
package pipeline

import (
    "bufio"
    "context"
    "encoding/csv"
    "encoding/json"
    "fmt"
    "io"
    "os"
    "path/filepath"
    "strings"
)

// FileSource reads from files
type FileSource struct {
    pattern string
    format  FileFormat
    files   []string
}

type FileFormat string

const (
    FormatText    FileFormat = "text"
    FormatJSON    FileFormat = "json"
    FormatCSV     FileFormat = "csv"
    FormatJSONL   FileFormat = "jsonl"
)

func NewFileSource(pattern string, format FileFormat) (*FileSource, error) {
    files, err := filepath.Glob(pattern)
    if err != nil {
        return nil, err
    }

    return &FileSource{
        pattern: pattern,
        format:  format,
        files:   files,
    }, nil
}

func (s *FileSource) Name() string {
    return fmt.Sprintf("File(%s)", s.pattern)
}

func (s *FileSource) Read(ctx context.Context) (<-chan Element, error) {
    out := make(chan Element, 100)

    go func() {
        defer close(out)

        for _, filePath := range s.files {
            if err := s.readFile(ctx, filePath, out); err != nil {
                // Log error and continue
                continue
            }

            select {
            case <-ctx.Done():
                return
            default:
            }
        }
    }()

    return out, nil
}

func (s *FileSource) readFile(ctx context.Context, filePath string, out chan<- Element) error {
    file, err := os.Open(filePath)
    if err != nil {
        return err
    }
    defer file.Close()

    switch s.format {
    case FormatText:
        return s.readText(ctx, file, out)
    case FormatJSON:
        return s.readJSON(ctx, file, out)
    case FormatJSONL:
        return s.readJSONL(ctx, file, out)
    case FormatCSV:
        return s.readCSV(ctx, file, out)
    default:
        return fmt.Errorf("unsupported format: %s", s.format)
    }
}

func (s *FileSource) readText(ctx context.Context, r io.Reader, out chan<- Element) error {
    scanner := bufio.NewScanner(r)

    for scanner.Scan() {
        select {
        case <-ctx.Done():
            return ctx.Err()
        case out <- NewElement(scanner.Text()):
        }
    }

    return scanner.Err()
}

func (s *FileSource) readJSON(ctx context.Context, r io.Reader, out chan<- Element) error {
    var data []any

    if err := json.NewDecoder(r).Decode(&data); err != nil {
        return err
    }

    for _, item := range data {
        select {
        case <-ctx.Done():
            return ctx.Err()
        case out <- NewElement(item):
        }
    }

    return nil
}

func (s *FileSource) readJSONL(ctx context.Context, r io.Reader, out chan<- Element) error {
    scanner := bufio.NewScanner(r)

    for scanner.Scan() {
        var data any
        if err := json.Unmarshal(scanner.Bytes(), &data); err != nil {
            continue // Skip malformed lines
        }

        select {
        case <-ctx.Done():
            return ctx.Err()
        case out <- NewElement(data):
        }
    }

    return scanner.Err()
}

func (s *FileSource) readCSV(ctx context.Context, r io.Reader, out chan<- Element) error {
    reader := csv.NewReader(r)

    // Read header
    header, err := reader.Read()
    if err != nil {
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

        // Convert to map
        data := make(map[string]string)
        for i, value := range record {
            if i < len(header) {
                data[header[i]] = value
            }
        }

        select {
        case <-ctx.Done():
            return ctx.Err()
        case out <- NewElement(data):
        }
    }

    return nil
}

func (s *FileSource) EstimateSize() int64 {
    var total int64
    for _, filePath := range s.files {
        if info, err := os.Stat(filePath); err == nil {
            total += info.Size()
        }
    }
    return total
}

func (s *FileSource) Split(desiredBundles int) ([]Source, error) {
    if len(s.files) <= desiredBundles {
        // One source per file
        sources := make([]Source, len(s.files))
        for i, file := range s.files {
            sources[i] = &FileSource{
                pattern: file,
                format:  s.format,
                files:   []string{file},
            }
        }
        return sources, nil
    }

    // Split files into bundles
    filesPerBundle := (len(s.files) + desiredBundles - 1) / desiredBundles
    sources := make([]Source, 0, desiredBundles)

    for i := 0; i < len(s.files); i += filesPerBundle {
        end := i + filesPerBundle
        if end > len(s.files) {
            end = len(s.files)
        }

        sources = append(sources, &FileSource{
            pattern: s.pattern,
            format:  s.format,
            files:   s.files[i:end],
        })
    }

    return sources, nil
}

func (s *FileSource) IsBounded() bool {
    return true
}
```

### Sink Interface

The `Sink` interface is the mirror of `Source`: it defines how processed data leaves the pipeline. A sink receives a channel of elements and writes them to an external system. The `SinkTransform` wraps a sink so it can be placed at the end of the pipeline's transform graph. Every sink must also implement a `Close` method to flush buffers and release resources when the pipeline finishes.

```go
// pkg/pipeline/sink.go
package pipeline

import "context"

// Sink writes data from the pipeline
type Sink interface {
    Name() string
    Write(ctx context.Context, elements <-chan Element) error
    Close() error
}

// SinkTransform wraps a sink as a transform
type SinkTransform struct {
    BaseTransform
    sink Sink
}

func (t *SinkTransform) Process(ctx context.Context, in <-chan Element, out chan<- Element) error {
    defer t.sink.Close()
    return t.sink.Write(ctx, in)
}
```

### Kafka Sink

The `KafkaSink` writes pipeline output back to a Kafka topic. Each element is serialized to JSON and sent as a Kafka message, with the element's key used as the message key for partitioning. This means elements with the same key will land in the same Kafka partition, preserving ordering for downstream consumers. The sink uses a least-bytes balancer to distribute messages evenly across partitions when no key is present.

```go
// pkg/pipeline/sink_kafka.go
package pipeline

import (
    "context"
    "encoding/json"
    "fmt"

    "github.com/segmentio/kafka-go"
)

// KafkaSink writes to Kafka
type KafkaSink struct {
    brokers []string
    topic   string
    writer  *kafka.Writer
}

func NewKafkaSink(brokers []string, topic string) *KafkaSink {
    return &KafkaSink{
        brokers: brokers,
        topic:   topic,
    }
}

func (s *KafkaSink) Name() string {
    return fmt.Sprintf("Kafka(%s)", s.topic)
}

func (s *KafkaSink) Write(ctx context.Context, elements <-chan Element) error {
    s.writer = &kafka.Writer{
        Addr:     kafka.TCP(s.brokers...),
        Topic:    s.topic,
        Balancer: &kafka.LeastBytes{},
    }

    for {
        select {
        case <-ctx.Done():
            return ctx.Err()
        case elem, ok := <-elements:
            if !ok {
                return nil
            }

            value, err := json.Marshal(elem.Value)
            if err != nil {
                return err
            }

            var key []byte
            if elem.Key != nil {
                key = []byte(fmt.Sprintf("%v", elem.Key))
            }

            msg := kafka.Message{
                Key:   key,
                Value: value,
                Time:  elem.EventTime,
            }

            if err := s.writer.WriteMessages(ctx, msg); err != nil {
                return err
            }
        }
    }
}

func (s *KafkaSink) Close() error {
    if s.writer != nil {
        return s.writer.Close()
    }
    return nil
}
```

### File Sink

The `FileSink` writes pipeline output to local files in various formats. For text format, it writes one value per line. For JSON, it collects all elements and writes them as a single JSON array. For JSON Lines, each element is written as a separate JSON object on its own line. For CSV, it automatically extracts column headers from the first record's map keys and writes subsequent rows in the same column order. A buffered writer is used for efficient I/O.

```go
// pkg/pipeline/sink_file.go
package pipeline

import (
    "bufio"
    "context"
    "encoding/csv"
    "encoding/json"
    "fmt"
    "os"
)

// FileSink writes to files
type FileSink struct {
    path   string
    format FileFormat
    file   *os.File
    writer *bufio.Writer
}

func NewFileSink(path string, format FileFormat) *FileSink {
    return &FileSink{
        path:   path,
        format: format,
    }
}

func (s *FileSink) Name() string {
    return fmt.Sprintf("File(%s)", s.path)
}

func (s *FileSink) Write(ctx context.Context, elements <-chan Element) error {
    file, err := os.Create(s.path)
    if err != nil {
        return err
    }
    s.file = file
    s.writer = bufio.NewWriter(file)

    switch s.format {
    case FormatText:
        return s.writeText(ctx, elements)
    case FormatJSON:
        return s.writeJSON(ctx, elements)
    case FormatJSONL:
        return s.writeJSONL(ctx, elements)
    case FormatCSV:
        return s.writeCSV(ctx, elements)
    default:
        return fmt.Errorf("unsupported format: %s", s.format)
    }
}

func (s *FileSink) writeText(ctx context.Context, elements <-chan Element) error {
    for {
        select {
        case <-ctx.Done():
            return ctx.Err()
        case elem, ok := <-elements:
            if !ok {
                return s.writer.Flush()
            }

            if _, err := fmt.Fprintln(s.writer, elem.Value); err != nil {
                return err
            }
        }
    }
}

func (s *FileSink) writeJSON(ctx context.Context, elements <-chan Element) error {
    var values []any

    for {
        select {
        case <-ctx.Done():
            return ctx.Err()
        case elem, ok := <-elements:
            if !ok {
                // Write all values as JSON array
                encoder := json.NewEncoder(s.writer)
                encoder.SetIndent("", "  ")
                if err := encoder.Encode(values); err != nil {
                    return err
                }
                return s.writer.Flush()
            }

            values = append(values, elem.Value)
        }
    }
}

func (s *FileSink) writeJSONL(ctx context.Context, elements <-chan Element) error {
    encoder := json.NewEncoder(s.writer)

    for {
        select {
        case <-ctx.Done():
            return ctx.Err()
        case elem, ok := <-elements:
            if !ok {
                return s.writer.Flush()
            }

            if err := encoder.Encode(elem.Value); err != nil {
                return err
            }
        }
    }
}

func (s *FileSink) writeCSV(ctx context.Context, elements <-chan Element) error {
    writer := csv.NewWriter(s.writer)
    defer writer.Flush()

    var header []string
    headerWritten := false

    for {
        select {
        case <-ctx.Done():
            return ctx.Err()
        case elem, ok := <-elements:
            if !ok {
                return writer.Error()
            }

            data, ok := elem.Value.(map[string]any)
            if !ok {
                continue
            }

            // Write header on first row
            if !headerWritten {
                for key := range data {
                    header = append(header, key)
                }
                if err := writer.Write(header); err != nil {
                    return err
                }
                headerWritten = true
            }

            // Write row
            row := make([]string, len(header))
            for i, key := range header {
                row[i] = fmt.Sprintf("%v", data[key])
            }

            if err := writer.Write(row); err != nil {
                return err
            }
        }
    }
}

func (s *FileSink) Close() error {
    if s.writer != nil {
        s.writer.Flush()
    }
    if s.file != nil {
        return s.file.Close()
    }
    return nil
}
```
