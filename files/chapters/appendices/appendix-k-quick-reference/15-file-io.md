## File I/O

Go's standard library provides multiple layers for file operations, from simple one-liners like `os.ReadFile` and `os.WriteFile` to fine-grained control with `os.Open`, `os.Create`, and `os.OpenFile`. Always close files with `defer f.Close()` immediately after opening to prevent resource leaks. For reading large files line by line, `bufio.Scanner` is the most convenient approach, while `bufio.Writer` improves write performance by batching small writes. The `filepath` package handles path manipulation in a cross-platform way, so prefer it over manual string concatenation.

```go
import (
    "os"
    "io"
    "bufio"
)

// Read entire file
data, err := os.ReadFile("file.txt")

// Write entire file
err := os.WriteFile("file.txt", data, 0644)

// Open file
f, err := os.Open("file.txt")  // Read-only
if err != nil {
    return err
}
defer f.Close()

// Open for writing
f, err := os.Create("file.txt")  // Truncate or create
f, err := os.OpenFile("file.txt", os.O_RDWR|os.O_CREATE|os.O_APPEND, 0644)

// Flags
os.O_RDONLY  // Read-only
os.O_WRONLY  // Write-only
os.O_RDWR    // Read-write
os.O_APPEND  // Append
os.O_CREATE  // Create if not exists
os.O_TRUNC   // Truncate
os.O_EXCL    // Must create (fails if exists)

// Read
buf := make([]byte, 1024)
n, err := f.Read(buf)
if err == io.EOF {
    // End of file
}

// Read all
data, err := io.ReadAll(f)

// Write
n, err := f.Write([]byte("hello"))

// Write string
n, err := f.WriteString("hello")

// Buffered reader
reader := bufio.NewReader(f)
line, err := reader.ReadString('\n')
line, err := reader.ReadBytes('\n')

// Read line by line
scanner := bufio.NewScanner(f)
for scanner.Scan() {
    line := scanner.Text()
    // Process line
}
if err := scanner.Err(); err != nil {
    return err
}

// Buffered writer
writer := bufio.NewWriter(f)
writer.WriteString("hello\n")
writer.Flush()  // Don't forget!

// Copy files
src, err := os.Open("source.txt")
if err != nil {
    return err
}
defer src.Close()

dst, err := os.Create("dest.txt")
if err != nil {
    return err
}
defer dst.Close()

_, err = io.Copy(dst, src)

// File info
info, err := os.Stat("file.txt")
info.Name()     // Base name
info.Size()     // Size in bytes
info.Mode()     // File mode
info.ModTime()  // Modification time
info.IsDir()    // Is directory

// Check if exists
if _, err := os.Stat("file.txt"); err == nil {
    // File exists
} else if os.IsNotExist(err) {
    // File doesn't exist
} else {
    // Other error
}

// Delete file
err := os.Remove("file.txt")

// Rename/move
err := os.Rename("old.txt", "new.txt")

// Create directory
err := os.Mkdir("dir", 0755)
err := os.MkdirAll("path/to/dir", 0755)  // Create all

// Remove directory
err := os.Remove("dir")      // Must be empty
err := os.RemoveAll("dir")   // Recursive

// List directory
entries, err := os.ReadDir("dir")
for _, entry := range entries {
    fmt.Println(entry.Name())
    fmt.Println(entry.IsDir())
}

// Walk directory tree
import "path/filepath"

err := filepath.Walk("root", func(path string, info os.FileInfo, err error) error {
    if err != nil {
        return err
    }
    fmt.Println(path)
    return nil
})

// Temporary files
f, err := os.CreateTemp("", "prefix-*.txt")
defer os.Remove(f.Name())

dir, err := os.MkdirTemp("", "prefix-*")
defer os.RemoveAll(dir)

// Path operations
filepath.Join("path", "to", "file.txt")
filepath.Base("path/to/file.txt")   // "file.txt"
filepath.Dir("path/to/file.txt")    // "path/to"
filepath.Ext("file.txt")            // ".txt"
filepath.Abs("file.txt")            // Absolute path

// Working directory
wd, err := os.Getwd()
err := os.Chdir("/path/to/dir")

// Environment variables
value := os.Getenv("PATH")
os.Setenv("KEY", "value")
os.Unsetenv("KEY")
environ := os.Environ()  // All env vars
```

---
