export default `## Section 8B: Rooted File System Access with \`os.Root\` (Go 1.24)

Go 1.24 introduced \`os.Root\` for safe, sandboxed file access that prevents path traversal attacks. This is a security-critical addition that eliminates an entire class of vulnerabilities in file-serving code.

### 8B.1 The Path Traversal Problem

Path traversal vulnerabilities arise when code constructs a filesystem path by combining a trusted base directory with untrusted user input, assuming the result stays inside that directory. An attacker can supply sequences like \`../../etc/passwd\` to walk up the directory tree and read arbitrary files the server process has access to. The naive fix of calling \`filepath.Join\` still leaves the door open because it resolves the path lexically but does not enforce that the final path remains under the intended root.

\`\`\`go
package fsaccess

import (
	"net/http"
	"os"
	"path/filepath"
)

// VULNERABLE: path traversal attack
func serveFileUnsafe(w http.ResponseWriter, userPath string) {
	// userPath = "../../etc/passwd" escapes the base directory!
	data, _ := os.ReadFile(filepath.Join("/var/www/static", userPath))
	w.Write(data)
}
\`\`\`

Manual defenses like \`filepath.Clean\` followed by prefix checking are error-prone. Edge cases around symlinks, double-encoded slashes, and platform-specific path separators have caused CVEs in production systems repeatedly.

### 8B.2 The \`os.Root\` Solution

\`os.OpenRoot\` opens a directory handle whose file operations are enforced at the OS level, meaning the kernel itself rejects any attempt to access a path outside the root rather than relying on application-level string checks. Once you have a \`Root\`, every subsequent \`Open\`, \`Create\`, or \`Stat\` call is automatically confined, symlink escapes and \`../\` traversal are blocked before any path even reaches your code. This replaces the fragile pattern of sanitizing strings manually and gives you a single, auditable point of trust for all file access.

\`\`\`go
package fsaccess

import (
	"io"
	"net/http"
	"os"
)

func serveFileSafe(w http.ResponseWriter, userPath string) {
	// os.OpenRoot creates a sandboxed root directory
	root, err := os.OpenRoot("/var/www/static")
	if err != nil {
		http.Error(w, "server error", 500)
		return
	}
	defer root.Close()

	// Open is confined to the root - traversal attempts fail safely
	f, err := root.Open(userPath)
	if err != nil {
		http.Error(w, "not found", 404)
		return
	}
	defer f.Close()

	data, _ := io.ReadAll(f)
	w.Write(data)
}
\`\`\`

### 8B.3 Key Methods

\`os.Root\` provides a familiar API that mirrors the top-level \`os\` functions, but every operation is confined to the root directory:

- \`os.OpenRoot(dir)\` - creates a \`Root\` sandboxed to \`dir\`
- \`root.Open(name)\` - opens a file within the root (no escaping)
- \`root.Create(name)\` - creates a file within the root
- \`root.Stat(name)\` - stats a file within the root
- \`root.Mkdir(name, perm)\` - creates a directory within the root

### 8B.4 Security Guarantees

The kernel-level enforcement means \`os.Root\` provides guarantees that userspace path manipulation cannot:

- Symlinks that escape the root are rejected
- \`../\` traversal beyond the root is rejected
- Works on Linux, macOS, Windows (platform-specific safety mechanisms)
- Replaces manual \`filepath.Clean\` + prefix checking which is error-prone

### 8B.5 When to Use \`os.Root\`

- File servers serving user-requested paths
- Upload handlers writing to designated directories
- Any code that combines a base directory with untrusted path input
- Container and sandbox environments where file access must be confined

If your code calls \`filepath.Join(baseDir, userInput)\` anywhere, that is a candidate for replacement with \`os.Root\`.

### Adoption Story

\`os.Root\` is a security feature, which makes the adoption decision straightforward: if you serve user-provided paths, adopt it. If you do not, skip. The migration cost is small (replace \`os.Open(filepath.Join(base, input))\` with \`root.Open(input)\`), and the security improvement is real.

Two pre-conditions:

1. **Audit every \`filepath.Join\` call.** The patterns that \`os.Root\` replaces are scattered across the codebase. The audit is the work. The replacement is mechanical.
2. **Understand symlink semantics.** \`os.Root\` rejects symlinks that escape the root. Services that deliberately traverse symlinks (some backup tools, deployment systems) will behave differently. Document.

### Code-Review Lens (Senior Track)

Three patterns to flag:

1. **\`filepath.Join(base, userInput)\` without validation.** Always a finding after Go 1.24. Replace with \`os.Root\`.
2. **Path traversal detection by string inspection.** \`if strings.Contains(path, "..")\` is a weak defence that misses symlink attacks. The kernel-enforced \`os.Root\` is strictly stronger.
3. **A rooted file-system setup at every request.** \`os.OpenRoot\` is not free. Cache the \`*os.Root\` at service startup if the base directory does not change per request.

### Migration Lens

The closest analogue is \`openat2\` on Linux (the kernel syscall \`os.Root\` uses) or the \`capsicum\`-style capability-based file access in some BSDs. Java, Python, and Node.js do not have a direct equivalent in their standard libraries. The usual recommendation is "canonicalise, check, hope nothing raced between the check and the use", which is exactly the bug class \`os.Root\` eliminates.

---
`;
