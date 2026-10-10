// internal/plugin/chain_test.go
package plugin

import (
    "context"
    "net/http"
    "net/http/httptest"
    "testing"
)

type mockPlugin struct {
    name     string
    priority int
    called   *bool
}

func (p *mockPlugin) Name() string {
    return p.name
}

func (p *mockPlugin) Priority() int {
    return p.priority
}

func (p *mockPlugin) Init(config map[string]any) error {
    return nil
}

func (p *mockPlugin) ProcessRequest(ctx context.Context, req *http.Request) (*http.Request, error) {
    *p.called = true
    return req, nil
}

func (p *mockPlugin) ProcessResponse(ctx context.Context, resp *http.Response) (*http.Response, error) {
    return resp, nil
}

func TestPluginChain(t *testing.T) {
    called1, called2, called3 := false, false, false

    plugins := []Plugin{
        &mockPlugin{name: "plugin2", priority: 200, called: &called2},
        &mockPlugin{name: "plugin1", priority: 100, called: &called1},
        &mockPlugin{name: "plugin3", priority: 300, called: &called3},
    }

    chain := NewChain(plugins)

    req := httptest.NewRequest("GET", "http://example.com", nil)
    ctx := context.Background()

    _, result := chain.ProcessRequest(ctx, req)
    if result.Error != nil {
        t.Fatal(result.Error)
    }

    // All plugins should be called
    if !called1 || !called2 || !called3 {
        t.Error("Not all plugins were called")
    }

    // Verify order by priority
    chainPlugins := chain.Plugins()
    if len(chainPlugins) != 3 {
        t.Fatalf("Expected 3 plugins, got %d", len(chainPlugins))
    }

    if chainPlugins[0].Priority() != 100 {
        t.Error("Plugins not sorted by priority")
    }
}
