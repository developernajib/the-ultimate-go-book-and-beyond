// pkg/pipeline/sink_file.go
package pipeline

import (
    "bufio"
    "context"
    "encoding/csv"
    "encoding/json"
    "fmt"
    "os"
    "path/filepath"
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
    if dir := filepath.Dir(s.path); dir != "" && dir != "." {
        if err := os.MkdirAll(dir, 0755); err != nil {
            return err
        }
    }

    file, err := os.Create(s.path)
    if err != nil {
        return err
    }
    s.file = file
    s.writer = bufio.NewWriter(file)
    defer s.Close()

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

            var data map[string]any
            if m, ok := elem.Value.(map[string]any); ok {
                data = m
            } else if wv, ok := elem.Value.(WindowedValue); ok {
                if m, ok := wv.Value.(map[string]any); ok {
                    data = m
                }
            }
            if data == nil {
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
