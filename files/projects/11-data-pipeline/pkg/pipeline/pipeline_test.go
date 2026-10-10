package pipeline_test

import (
	"context"
	"os"
	"path/filepath"
	"testing"

	"github.com/example/data-pipeline/pkg/pipeline"
)

type memorySource struct {
	items []string
}

func (s *memorySource) Name() string { return "MemorySource" }
func (s *memorySource) EstimateSize() int64 { return int64(len(s.items)) }
func (s *memorySource) Split(n int) ([]pipeline.Source, error) { return []pipeline.Source{s}, nil }
func (s *memorySource) Read(ctx context.Context) (<-chan pipeline.Element, error) {
	ch := make(chan pipeline.Element, len(s.items))
	go func() {
		defer close(ch)
		for _, item := range s.items {
			select {
			case <-ctx.Done():
				return
			case ch <- pipeline.NewElement(item):
			}
		}
	}()
	return ch, nil
}

func TestPipelineExecution(t *testing.T) {
	ctx := context.Background()
	p := pipeline.NewPipeline("TestPipeline", pipeline.PipelineOptions{
		Parallelism: 2,
	})

	tmpDir := t.TempDir()
	outFile := filepath.Join(tmpDir, "sub", "out.txt")

	source := &memorySource{
		items: []string{"apple", "banana", "cherry", "avocado"},
	}

	p.ReadFrom(source).
		Filter(func(e pipeline.Element) (bool, error) {
			str := e.Value.(string)
			return str[0] == 'a', nil
		}).
		Map(func(e pipeline.Element) (pipeline.Element, error) {
			str := e.Value.(string)
			e.Value = "fruit: " + str
			return e, nil
		}).
		WriteTo(pipeline.NewFileSink(outFile, pipeline.FormatText))

	if err := p.Run(ctx); err != nil {
		t.Fatalf("Pipeline run failed: %v", err)
	}

	content, err := os.ReadFile(outFile)
	if err != nil {
		t.Fatalf("Failed to read output file: %v", err)
	}

	text := string(content)
	if text != "fruit: apple\nfruit: avocado\n" && text != "fruit: avocado\nfruit: apple\n" {
		t.Errorf("Unexpected output: %s", text)
	}
}

func TestGroupByKeyAndCombine(t *testing.T) {
	ctx := context.Background()
	p := pipeline.NewPipeline("TestGroupCombine", pipeline.PipelineOptions{
		Parallelism: 2,
	})

	tmpDir := t.TempDir()
	outFile := filepath.Join(tmpDir, "sub", "results.jsonl")

	source := &memorySource{
		items: []string{"go", "rust", "go", "go", "rust"},
	}

	p.ReadFrom(source).
		Map(func(e pipeline.Element) (pipeline.Element, error) {
			word := e.Value.(string)
			e.Key = word
			e.Value = int64(1)
			return e, nil
		}).
		GroupByKey().
		CombinePerKey(pipeline.SumInt64{}).
		Map(func(e pipeline.Element) (pipeline.Element, error) {
			e.Value = map[string]any{
				"word":  e.Key,
				"count": e.Value,
			}
			return e, nil
		}).
		WriteTo(pipeline.NewFileSink(outFile, pipeline.FormatJSONL))

	if err := p.Run(ctx); err != nil {
		t.Fatalf("Pipeline run failed: %v", err)
	}

	content, err := os.ReadFile(outFile)
	if err != nil {
		t.Fatalf("Failed to read output file: %v", err)
	}

	if len(content) == 0 {
		t.Errorf("Output file is empty")
	}
}
