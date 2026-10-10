## 83E.12 Problem 10: In-Memory File System (LeetCode 588)

### Requirements

1. `ls` - list directory contents or file name
2. `mkdir` - create directory path (recursive)
3. `addContentToFile` - create/append to file
4. `readContentFromFile` - read file content

### Implementation

The in-memory file system problem (LeetCode 588) requires tree-based hierarchical directory modeling with efficient path traversal and content management. The following Go implementation uses a recursive node structure that correctly handles absolute paths, directory creation, and file append semantics.

```go
package filesystem

import (
	"sort"
	"strings"
)

type FileSystem struct {
	root *fsNode
}

type fsNode struct {
	name     string
	isFile   bool
	content  strings.Builder
	children map[string]*fsNode
}

func newDirNode(name string) *fsNode {
	return &fsNode{
		name:     name,
		children: make(map[string]*fsNode),
	}
}

func newFileNode(name string) *fsNode {
	return &fsNode{
		name:     name,
		isFile:   true,
		children: make(map[string]*fsNode),
	}
}

func Constructor() FileSystem {
	return FileSystem{root: newDirNode("")}
}

// navigate traverses the path and returns the final node.
// If create is true, intermediate directories are created.
func (fs *FileSystem) navigate(path string, create bool) *fsNode {
	if path == "/" {
		return fs.root
	}

	parts := strings.Split(path, "/")
	node := fs.root

	for _, part := range parts {
		if part == "" {
			continue
		}
		child, exists := node.children[part]
		if !exists {
			if !create {
				return nil
			}
			child = newDirNode(part)
			node.children[part] = child
		}
		node = child
	}
	return node
}

func (fs *FileSystem) Ls(path string) []string {
	node := fs.navigate(path, false)
	if node == nil {
		return []string{}
	}

	if node.isFile {
		return []string{node.name}
	}

	names := make([]string, 0, len(node.children))
	for name := range node.children {
		names = append(names, name)
	}
	sort.Strings(names)
	return names
}

func (fs *FileSystem) Mkdir(path string) {
	fs.navigate(path, true)
}

func (fs *FileSystem) AddContentToFile(filePath string, content string) {
	parts := strings.Split(filePath, "/")
	fileName := parts[len(parts)-1]
	dirPath := strings.Join(parts[:len(parts)-1], "/")
	if dirPath == "" {
		dirPath = "/"
	}

	// Ensure parent directories exist
	parent := fs.navigate(dirPath, true)

	node, exists := parent.children[fileName]
	if !exists {
		node = newFileNode(fileName)
		parent.children[fileName] = node
	}
	node.isFile = true
	node.content.WriteString(content)
}

func (fs *FileSystem) ReadContentFromFile(filePath string) string {
	node := fs.navigate(filePath, false)
	if node == nil || !node.isFile {
		return ""
	}
	return node.content.String()
}
```

**Complexity:**
- All operations: O(L + K log K) where L is path length and K is number of children (for `Ls` sorting)
- Space: O(total nodes + total file content)

### SOLID Analysis

- **S:** `fsNode` represents a single file system entry. `FileSystem` provides the public API.
- **O:** Could extend with permissions, timestamps, or symlinks by adding fields or wrapping nodes.
- **D:** The `navigate` helper centralizes path traversal - changes to path parsing only affect one place.


### Junior → FAANG: In-Memory File System LLD Basics

The in-memory file system problem (LeetCode 588) requires implementing ls, mkdir, addContentToFile, and readContentFromFile operations on a virtual file system. The key insight is to model the file system as a trie: each node represents a directory or file, with a map of children (for directories) and a string content (for files). Path parsing splits the path by '/' and traverses the trie. In Go, use a struct for TrieNode with Children map[string]*TrieNode and Content string, with an IsFile bool to distinguish files from directories.

### Senior @ FAANG: File System LLD at the Senior Bar: Permissions, Concurrency, and POSIX Semantics

At the senior level, the in-memory file system discussion extends to POSIX-like semantics and production concerns. Concurrency: multiple goroutines reading from and writing to the file system simultaneously require either a global sync.RWMutex (simple, serializes all writes) or fine-grained per-node locking (complex, enables concurrent access to non-overlapping paths). Permissions: a production file system model requires per-node permissions (owner, group, other) and the ability to check access before executing operations. Symbolic links: implementing symlinks requires handling cycles in path resolution, which requires either a cycle detection step or a maximum symlink depth limit. These extensions are the senior-level discussion. A candidate who stays at the LeetCode level without probing into these concerns is signaling an absence of production engineering awareness.

---
