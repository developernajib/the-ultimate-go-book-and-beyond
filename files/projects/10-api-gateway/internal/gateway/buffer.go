// internal/gateway/buffer.go
package gateway

import (
    "bytes"
    "io"
    "net/http"
)

// BufferedRequest buffers request body for retry logic
type BufferedRequest struct {
    *http.Request
    body []byte
}

// NewBufferedRequest creates a buffered request
func NewBufferedRequest(r *http.Request) (*BufferedRequest, error) {
    var body []byte
    if r.Body != nil {
        var err error
        body, err = io.ReadAll(r.Body)
        if err != nil {
            return nil, err
        }
        r.Body.Close()
    }

    return &BufferedRequest{
        Request: r,
        body:    body,
    }, nil
}

// Reset resets the request body for retry
func (br *BufferedRequest) Reset() {
    br.Body = io.NopCloser(bytes.NewReader(br.body))
}
