## Production Go Implementation: Document Export Service

Users frequently need to download their documents as PDF, DOCX, or plain text files. The export service handles this by first converting the internal document representation to HTML (a universal intermediate format), then using specialized tools like headless Chrome for PDF rendering or Pandoc for DOCX conversion. Since export is a CPU-intensive operation that can take several seconds, it runs asynchronously via a job queue so it does not block the real-time editing path.

```go
package export

import (
	"context"
	"fmt"
	"html"
	"os"
	"os/exec"
	"strings"
	"time"
)

// ExportService handles document conversion to PDF, DOCX, etc.
type ExportService struct {
	docStore  DocumentStore
	s3Client  S3Client
	jobQueue  JobQueue
}

type ExportRequest struct {
	DocID    string `json:"doc_id"`
	UserID   string `json:"user_id"`
	Format   string `json:"format"` // "pdf", "docx", "txt", "html"
	Revision int    `json:"revision,omitempty"` // 0 = latest
}

type ExportResult struct {
	DownloadURL string    `json:"download_url"`
	Format      string    `json:"format"`
	SizeBytes   int64     `json:"size_bytes"`
	ExpiresAt   time.Time `json:"expires_at"`
}

// Export converts a document to the requested format
func (s *ExportService) Export(ctx context.Context, req ExportRequest) (*ExportResult, error) {
	// Load document content
	content, revision, err := s.docStore.LoadContent(ctx, req.DocID, req.Revision)
	if err != nil {
		return nil, fmt.Errorf("load document: %w", err)
	}

	// Convert content to HTML first (intermediate format)
	html := convertToHTML(content)

	var outputPath string
	var mimeType string

	switch req.Format {
	case "pdf":
		// Use headless Chrome for high-fidelity PDF rendering
		outputPath, err = s.renderPDF(ctx, html)
		mimeType = "application/pdf"
	case "docx":
		// Use pandoc for DOCX conversion
		outputPath, err = s.convertWithPandoc(ctx, html, "docx")
		mimeType = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
	case "txt":
		outputPath, err = s.extractPlainText(ctx, content)
		mimeType = "text/plain"
	case "html":
		outputPath, err = s.writeHTML(ctx, html)
		mimeType = "text/html"
	default:
		return nil, fmt.Errorf("unsupported format: %s", req.Format)
	}

	if err != nil {
		return nil, fmt.Errorf("convert to %s: %w", req.Format, err)
	}

	// Upload to S3
	s3Key := fmt.Sprintf("exports/%s/%s/rev_%d.%s", req.DocID, req.UserID, revision, req.Format)
	size, err := s.s3Client.Upload(ctx, s3Key, outputPath, mimeType)
	if err != nil {
		return nil, fmt.Errorf("upload export: %w", err)
	}

	// Generate presigned download URL (expires in 1 hour)
	downloadURL, err := s.s3Client.PresignGet(ctx, s3Key, 1*time.Hour)
	if err != nil {
		return nil, fmt.Errorf("presign export: %w", err)
	}

	return &ExportResult{
		DownloadURL: downloadURL,
		Format:      req.Format,
		SizeBytes:   size,
		ExpiresAt:   time.Now().Add(1 * time.Hour),
	}, nil
}

// EnqueueExport queues an export job so heavy conversions never run on
// the request path. Workers pick jobs up and call Export.
func (s *ExportService) EnqueueExport(ctx context.Context, req ExportRequest) (string, error) {
	return s.jobQueue.Enqueue(ctx, "export", req)
}

func (s *ExportService) renderPDF(ctx context.Context, htmlDoc string) (string, error) {
	// Use headless Chrome via CDP
	// In production: use chromedp or a containerized Chrome instance
	return "", nil
}

func (s *ExportService) convertWithPandoc(ctx context.Context, htmlDoc, format string) (string, error) {
	outputPath := fmt.Sprintf("/tmp/export_%d.%s", time.Now().UnixNano(), format)
	cmd := exec.CommandContext(ctx, "pandoc", "-f", "html", "-t", format, "-o", outputPath)
	cmd.Stdin = strings.NewReader(htmlDoc)
	if err := cmd.Run(); err != nil {
		return "", err
	}
	return outputPath, nil
}

func (s *ExportService) extractPlainText(ctx context.Context, content string) (string, error) {
	outputPath := fmt.Sprintf("/tmp/export_%d.txt", time.Now().UnixNano())
	return outputPath, os.WriteFile(outputPath, []byte(content), 0o600)
}

func (s *ExportService) writeHTML(ctx context.Context, htmlDoc string) (string, error) {
	outputPath := fmt.Sprintf("/tmp/export_%d.html", time.Now().UnixNano())
	return outputPath, os.WriteFile(outputPath, []byte(htmlDoc), 0o600)
}

func convertToHTML(content string) string {
	// Escape user content: exported HTML must never execute
	// document text as markup
	return "<html><body>" + html.EscapeString(content) + "</body></html>"
}
```

---
