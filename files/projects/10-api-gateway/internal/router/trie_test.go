// internal/router/trie_test.go
package router

import (
    "testing"
)

func TestTrie(t *testing.T) {
    trie := NewTrie()

    // Test routes
    routes := map[string]*Route{
        "/api/users":        {ID: "route1"},
        "/api/users/:id":    {ID: "route2"},
        "/api/posts/*":      {ID: "route3"},
        "/api/v1/products":  {ID: "route4"},
    }

    // Insert routes
    for path, route := range routes {
        trie.Insert(path, route)
    }

    // Test exact match
    route, params := trie.Search("/api/users")
    if route == nil || route.ID != "route1" {
        t.Errorf("Expected route1, got %v", route)
    }

    // Test parameter match
    route, params = trie.Search("/api/users/123")
    if route == nil || route.ID != "route2" {
        t.Errorf("Expected route2, got %v", route)
    }
    if params["id"] != "123" {
        t.Errorf("Expected param id=123, got %v", params)
    }

    // Test wildcard match
    route, params = trie.Search("/api/posts/anything/here")
    if route == nil || route.ID != "route3" {
        t.Errorf("Expected route3, got %v", route)
    }

    // Test no match
    route, params = trie.Search("/api/nonexistent")
    if route != nil {
        t.Errorf("Expected no match, got %v", route)
    }

    // Test delete
    deleted := trie.Delete("/api/users/:id")
    if !deleted {
        t.Error("Expected successful deletion")
    }

    route, params = trie.Search("/api/users/123")
    if route != nil {
        t.Error("Expected no match after deletion")
    }
}
