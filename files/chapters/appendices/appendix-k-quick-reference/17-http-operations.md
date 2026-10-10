## HTTP Operations

Go's `net/http` package provides both an HTTP client and a full HTTP server in the standard library, with no external frameworks needed. For client requests, always set a timeout on `http.Client` and always close the response body with `defer resp.Body.Close()`. On the server side, handlers are functions that accept an `http.ResponseWriter` and an `*http.Request`, and you can compose middleware by wrapping handlers. For production servers, configure read/write timeouts and implement graceful shutdown to avoid dropping in-flight requests.

```go
import "net/http"

// Simple GET request
resp, err := http.Get("https://api.example.com/data")
if err != nil {
    return err
}
defer resp.Body.Close()

body, err := io.ReadAll(resp.Body)

// Check status
if resp.StatusCode != http.StatusOK {
    return fmt.Errorf("bad status: %d", resp.StatusCode)
}

// Custom request
req, err := http.NewRequest("POST", url, bytes.NewBuffer(jsonData))
if err != nil {
    return err
}

req.Header.Set("Content-Type", "application/json")
req.Header.Set("Authorization", "Bearer "+token)

client := &http.Client{
    Timeout: 10 * time.Second,
}

resp, err := client.Do(req)
if err != nil {
    return err
}
defer resp.Body.Close()

// With context
ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
defer cancel()

req, err := http.NewRequestWithContext(ctx, "GET", url, nil)
resp, err := client.Do(req)

// Form POST
data := url.Values{}
data.Set("name", "Alice")
data.Set("age", "30")

resp, err := http.PostForm(url, data)

// Multipart form (file upload)
var b bytes.Buffer
w := multipart.NewWriter(&b)

fw, err := w.CreateFormFile("file", "filename.txt")
io.Copy(fw, fileReader)

w.WriteField("name", "Alice")
w.Close()

req, err := http.NewRequest("POST", url, &b)
req.Header.Set("Content-Type", w.FormDataContentType())

// HTTP server
func handler(w http.ResponseWriter, r *http.Request) {
    // Read request
    body, err := io.ReadAll(r.Body)
    defer r.Body.Close()

    // Query parameters
    name := r.URL.Query().Get("name")

    // Form values
    r.ParseForm()
    value := r.FormValue("key")

    // Headers
    auth := r.Header.Get("Authorization")

    // Write response
    w.Header().Set("Content-Type", "application/json")
    w.WriteHeader(http.StatusOK)
    w.Write([]byte(`{"status":"ok"}`))

    // Or
    json.NewEncoder(w).Encode(data)
}

http.HandleFunc("/", handler)
http.ListenAndServe(":8080", nil)

// Custom server
server := &http.Server{
    Addr:         ":8080",
    Handler:      mux,
    ReadTimeout:  10 * time.Second,
    WriteTimeout: 10 * time.Second,
    IdleTimeout:  60 * time.Second,
}

server.ListenAndServe()

// Graceful shutdown
ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
defer cancel()
server.Shutdown(ctx)

// Middleware
func loggingMiddleware(next http.Handler) http.Handler {
    return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        log.Printf("%s %s", r.Method, r.URL.Path)
        next.ServeHTTP(w, r)
    })
}

http.Handle("/", loggingMiddleware(handler))

// ServeMux
mux := http.NewServeMux()
mux.HandleFunc("/", homeHandler)
mux.HandleFunc("/api/users", usersHandler)

// File server
fs := http.FileServer(http.Dir("./static"))
http.Handle("/static/", http.StripPrefix("/static/", fs))

// Redirect
http.Redirect(w, r, "/new-path", http.StatusMovedPermanently)

// Cookies
cookie := &http.Cookie{
    Name:     "session",
    Value:    "abc123",
    Path:     "/",
    MaxAge:   3600,
    HttpOnly: true,
    Secure:   true,
    SameSite: http.SameSiteStrictMode,
}
http.SetCookie(w, cookie)

cookie, err := r.Cookie("session")

// Status codes
http.StatusOK                  // 200
http.StatusCreated             // 201
http.StatusNoContent           // 204
http.StatusMovedPermanently    // 301
http.StatusFound               // 302
http.StatusBadRequest          // 400
http.StatusUnauthorized        // 401
http.StatusForbidden           // 403
http.StatusNotFound            // 404
http.StatusInternalServerError // 500

// Custom client
client := &http.Client{
    Timeout: 10 * time.Second,
    Transport: &http.Transport{
        MaxIdleConns:       10,
        IdleConnTimeout:    30 * time.Second,
        DisableCompression: false,
    },
}

// Don't follow redirects
client.CheckRedirect = func(req *http.Request, via []*http.Request) error {
    return http.ErrUseLastResponse
}
```

---
