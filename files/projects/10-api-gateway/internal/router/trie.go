// internal/router/trie.go
package router

import (
    "strings"
)

// TrieNode represents a node in the routing trie
type TrieNode struct {
    children    map[string]*TrieNode
    wildcardChild *TrieNode
    route       *Route
    isWildcard  bool
    param       string // parameter name for :param patterns
}

// Trie implements a prefix tree for route matching
type Trie struct {
    root *TrieNode
}

// NewTrie creates a new routing trie
func NewTrie() *Trie {
    return &Trie{
        root: &TrieNode{
            children: make(map[string]*TrieNode),
        },
    }
}

// Insert adds a route to the trie
func (t *Trie) Insert(path string, route *Route) {
    parts := splitPath(path)
    node := t.root

    for _, part := range parts {
        if part == "" {
            continue
        }

        // Handle wildcard: /api/*/users
        if part == "*" {
            if node.wildcardChild == nil {
                node.wildcardChild = &TrieNode{
                    children:   make(map[string]*TrieNode),
                    isWildcard: true,
                }
            }
            node = node.wildcardChild
            continue
        }

        // Handle parameter: /api/:id/users
        if strings.HasPrefix(part, ":") {
            paramName := part[1:]
            if node.wildcardChild == nil {
                node.wildcardChild = &TrieNode{
                    children:   make(map[string]*TrieNode),
                    isWildcard: true,
                    param:      paramName,
                }
            }
            node = node.wildcardChild
            continue
        }

        // Regular path segment
        if node.children[part] == nil {
            node.children[part] = &TrieNode{
                children: make(map[string]*TrieNode),
            }
        }
        node = node.children[part]
    }

    node.route = route
}

// Search finds a route matching the path
func (t *Trie) Search(path string) (*Route, map[string]string) {
    parts := splitPath(path)
    params := make(map[string]string)

    route := t.searchNode(t.root, parts, 0, params)
    if route == nil {
        return nil, nil
    }

    return route, params
}

func (t *Trie) searchNode(node *TrieNode, parts []string, index int, params map[string]string) *Route {
    // Reached end of path
    if index == len(parts) {
        return node.route
    }

    part := parts[index]
    if part == "" {
        return t.searchNode(node, parts, index+1, params)
    }

    // Try exact match first
    if child, exists := node.children[part]; exists {
        if route := t.searchNode(child, parts, index+1, params); route != nil {
            return route
        }
    }

    // Try wildcard/parameter match
    if node.wildcardChild != nil {
        if node.wildcardChild.param != "" {
            params[node.wildcardChild.param] = part
        }
        if route := t.searchNode(node.wildcardChild, parts, index+1, params); route != nil {
            return route
        }
        if node.wildcardChild.param != "" {
            delete(params, node.wildcardChild.param)
        }
        // A bare * that carries a route is a catch-all: it matches this
        // segment and everything after it (e.g. /api/posts/* matches
        // /api/posts/anything/here).
        if node.wildcardChild.param == "" && node.wildcardChild.route != nil {
            return node.wildcardChild.route
        }
    }

    return nil
}

// Delete removes a route from the trie
func (t *Trie) Delete(path string) bool {
    parts := splitPath(path)
    return t.deleteNode(t.root, parts, 0)
}

func (t *Trie) deleteNode(node *TrieNode, parts []string, index int) bool {
    if index == len(parts) {
        if node.route != nil {
            node.route = nil
            return true
        }
        return false
    }

    part := parts[index]
    if part == "" {
        return t.deleteNode(node, parts, index+1)
    }

    if part == "*" || strings.HasPrefix(part, ":") {
        if node.wildcardChild != nil {
            if t.deleteNode(node.wildcardChild, parts, index+1) {
                // Clean up empty nodes
                if len(node.wildcardChild.children) == 0 && node.wildcardChild.route == nil {
                    node.wildcardChild = nil
                }
                return true
            }
        }
        return false
    }

    if child, exists := node.children[part]; exists {
        if t.deleteNode(child, parts, index+1) {
            // Clean up empty nodes
            if len(child.children) == 0 && child.route == nil {
                delete(node.children, part)
            }
            return true
        }
    }

    return false
}

func splitPath(path string) []string {
    path = strings.Trim(path, "/")
    if path == "" {
        return []string{}
    }
    return strings.Split(path, "/")
}
