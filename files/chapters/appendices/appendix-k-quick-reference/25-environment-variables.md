## Environment Variables

Environment variables are the standard way to configure Go applications, especially in cloud and container deployments. The `os` package provides `Getenv`, `Setenv`, and `LookupEnv` for reading and writing them. Use `LookupEnv` instead of `Getenv` when you need to distinguish between an unset variable and one set to an empty string. For applications that use `.env` files during local development, the popular `godotenv` third-party package can load them automatically at startup.

```go
import "os"

// Get
value := os.Getenv("PATH")
value := os.Getenv("MY_VAR")  // Returns "" if not set

// Check if set
value, exists := os.LookupEnv("MY_VAR")
if exists {
    // Use value
}

// Set (only affects current process)
os.Setenv("MY_VAR", "value")

// Unset
os.Unsetenv("MY_VAR")

// Get all
environ := os.Environ()  // []string{"KEY=value", ...}

// Parse environment variable
for _, env := range os.Environ() {
    parts := strings.SplitN(env, "=", 2)
    key := parts[0]
    value := parts[1]
}

// Expand variables in string
s := os.Expand("$HOME/file.txt", os.Getenv)

// Common variables
home := os.Getenv("HOME")        // Unix
userprofile := os.Getenv("USERPROFILE")  // Windows
path := os.Getenv("PATH")

// Go-specific
gopath := os.Getenv("GOPATH")
goroot := os.Getenv("GOROOT")

// Load from .env file (not stdlib, use github.com/joho/godotenv)
import "github.com/joho/godotenv"

err := godotenv.Load()
if err != nil {
    log.Fatal("Error loading .env file")
}

value := os.Getenv("MY_VAR")

// Default value pattern
func getEnv(key, defaultValue string) string {
    if value, exists := os.LookupEnv(key); exists {
        return value
    }
    return defaultValue
}

timeout := getEnv("TIMEOUT", "30s")
```

---
