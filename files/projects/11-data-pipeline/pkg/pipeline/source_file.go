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
)

// FileSource reads from files
type FileSource struct {
	pattern string
	format  FileFormat
	files   []string
}

type FileFormat string

const (
	FormatText  FileFormat = "text"
	FormatJSON  FileFormat = "json"
	FormatCSV   FileFormat = "csv"
	FormatJSONL FileFormat = "jsonl"
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
		end := min(i+filesPerBundle, len(s.files))

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
