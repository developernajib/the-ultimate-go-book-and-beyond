// internal/plugins/transform/transform.go
package transform

import (
	"context"
	"net/http"
	"regexp"

	"github.com/example/api-gateway/internal/plugin"
)

// TransformPlugin transforms requests and responses
type TransformPlugin struct {
    addHeaders     map[string]string
    removeHeaders  []string
    replaceHeaders map[string]string
    addQuery       map[string]string
    removeQuery    []string
    pathRewrite    map[string]string // regex -> replacement
}

func NewTransformPlugin() plugin.Plugin {
    return &TransformPlugin{
        addHeaders:     make(map[string]string),
        replaceHeaders: make(map[string]string),
        addQuery:       make(map[string]string),
        pathRewrite:    make(map[string]string),
    }
}

func (p *TransformPlugin) Name() string {
    return "transform"
}

func (p *TransformPlugin) Priority() int {
    return 300
}

func (p *TransformPlugin) Init(config map[string]any) error {
    if add, ok := config["add_headers"].(map[string]any); ok {
        for k, v := range add {
            p.addHeaders[k] = v.(string)
        }
    }

    if remove, ok := config["remove_headers"].([]any); ok {
        for _, h := range remove {
            p.removeHeaders = append(p.removeHeaders, h.(string))
        }
    }

    if replace, ok := config["replace_headers"].(map[string]any); ok {
        for k, v := range replace {
            p.replaceHeaders[k] = v.(string)
        }
    }

    if add, ok := config["add_query"].(map[string]any); ok {
        for k, v := range add {
            p.addQuery[k] = v.(string)
        }
    }

    if remove, ok := config["remove_query"].([]any); ok {
        for _, q := range remove {
            p.removeQuery = append(p.removeQuery, q.(string))
        }
    }

    if rewrite, ok := config["path_rewrite"].(map[string]any); ok {
        for k, v := range rewrite {
            p.pathRewrite[k] = v.(string)
        }
    }

    return nil
}

func (p *TransformPlugin) ProcessRequest(ctx context.Context, req *http.Request) (*http.Request, error) {
    // Transform headers
    for key, value := range p.addHeaders {
        req.Header.Add(key, value)
    }

    for _, key := range p.removeHeaders {
        req.Header.Del(key)
    }

    for key, value := range p.replaceHeaders {
        req.Header.Set(key, value)
    }

    // Transform query parameters
    query := req.URL.Query()

    for key, value := range p.addQuery {
        query.Add(key, value)
    }

    for _, key := range p.removeQuery {
        query.Del(key)
    }

    req.URL.RawQuery = query.Encode()

    // Transform path
    for pattern, replacement := range p.pathRewrite {
        re := regexp.MustCompile(pattern)
        newPath := re.ReplaceAllString(req.URL.Path, replacement)
        if newPath != req.URL.Path {
            req.URL.Path = newPath
            break
        }
    }

    return req, nil
}

func (p *TransformPlugin) ProcessResponse(ctx context.Context, resp *http.Response) (*http.Response, error) {
    // Transform response headers
    for key, value := range p.addHeaders {
        resp.Header.Add(key, value)
    }

    for _, key := range p.removeHeaders {
        resp.Header.Del(key)
    }

    return resp, nil
}

func init() {
    plugin.Register("transform", NewTransformPlugin)
}
