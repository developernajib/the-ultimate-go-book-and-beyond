## 53B.4 End-to-End: Ripple Frontend with a Go Backend

This section walks through a minimal end-to-end example: a Go HTTP service that serves a list of tasks, and a Ripple SPA that fetches and renders them with fine-grained reactivity. The same patterns apply whether the backend is REST, gRPC-Web via Connect, or GraphQL.

### The Go Backend

```go
// main.go
package main

import (
    "encoding/json"
    "log"
    "net/http"
    "strconv"
    "sync"
    "time"
)

type Task struct {
    ID        string    `json:"id"`
    Title     string    `json:"title"`
    Done      bool      `json:"done"`
    CreatedAt time.Time `json:"createdAt"`
}

type TaskStore struct {
    mu    sync.RWMutex
    tasks map[string]Task
}

func (s *TaskStore) List() []Task {
    s.mu.RLock()
    defer s.mu.RUnlock()
    out := make([]Task, 0, len(s.tasks))
    for _, t := range s.tasks {
        out = append(out, t)
    }
    return out
}

func generateID() string {
    return strconv.FormatInt(time.Now().UnixNano(), 10)
}

func (s *TaskStore) Add(title string) Task {
    s.mu.Lock()
    defer s.mu.Unlock()
    id := generateID()
    task := Task{ID: id, Title: title, CreatedAt: time.Now()}
    s.tasks[id] = task
    return task
}

func main() {
    store := &TaskStore{tasks: map[string]Task{}}

    mux := http.NewServeMux()

    mux.HandleFunc("GET /api/tasks", func(w http.ResponseWriter, r *http.Request) {
        w.Header().Set("Content-Type", "application/json")
        w.Header().Set("Access-Control-Allow-Origin", "*")
        _ = json.NewEncoder(w).Encode(store.List())
    })

    mux.HandleFunc("POST /api/tasks", func(w http.ResponseWriter, r *http.Request) {
        var body struct {
            Title string `json:"title"`
        }
        if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
            http.Error(w, "bad request", http.StatusBadRequest)
            return
        }
        task := store.Add(body.Title)
        w.Header().Set("Content-Type", "application/json")
        w.Header().Set("Access-Control-Allow-Origin", "*")
        _ = json.NewEncoder(w).Encode(task)
    })

    log.Println("listening on :8080")
    log.Fatal(http.ListenAndServe(":8080", mux))
}
```

The Go side is standard: Go 1.22+ stdlib mux with method + path routing, a thread-safe in-memory store, and JSON over HTTP. Chapter 29 (Web Services) and Chapter 38 (REST Fundamentals) cover the production-grade extensions (middleware, validation, structured logging, rate limiting).

### The Ripple Frontend

```typescript
// App.ripple
import { track, effect, RippleArray } from 'ripple';

type Task = {
  id: string;
  title: string;
  done: boolean;
  createdAt: string;
};

component TaskList() {
  const tasks = new RippleArray<Task>([]);
  let &[newTitle] = track('');
  let &[loading]  = track(true);
  let &[error]    = track<string | null>(null);

  // Load tasks on mount. `effect` runs once initially and then when its
  // reactive dependencies change. With no tracked reads inside, it runs once.
  effect(async () => {
    try {
      const res = await fetch('http://localhost:8080/api/tasks');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data: Task[] = await res.json();
      tasks.splice(0, tasks.length, ...data);
    } catch (e: any) {
      error = e.message;
    } finally {
      loading = false;
    }
  });

  async function addTask() {
    if (!newTitle.trim()) return;
    const res = await fetch('http://localhost:8080/api/tasks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: newTitle }),
    });
    if (res.ok) {
      const task: Task = await res.json();
      tasks.push(task);
      newTitle = '';
    }
  }

  <div class="task-app">
    <h1>Tasks</h1>

    if (loading) {
      <div class="skeleton">Loading...</div>
    } else if (error) {
      <div class="error">{error}</div>
    } else {
      <ul>
        for (const task of tasks) {
          <li class={task.done ? 'done' : ''}>{task.title}</li>
        }
      </ul>
    }

    <form onSubmit={(e) => { e.preventDefault(); addTask(); }}>
      <input
        type="text"
        value={newTitle}
        onInput={(e) => newTitle = (e.target as HTMLInputElement).value}
        placeholder="New task..."
      />
      <button type="submit">Add</button>
    </form>
  </div>

  <style>
    .task-app { max-width: 480px; margin: 2rem auto; font-family: system-ui; }
    .skeleton { opacity: 0.5; }
    .error    { color: #c00; }
    .done     { text-decoration: line-through; opacity: 0.6; }
    input     { padding: 0.5rem; margin-right: 0.5rem; }
    button    { padding: 0.5rem 1rem; }
  </style>
}
```

### What to Notice

**No state manager.** Redux, Zustand, and Pinia do not appear. `RippleArray` is the state primitive for the task list. `track` is the state primitive for scalar values. In a bigger app you would split these into module-level stores, but the authoring pattern stays the same.

**No `useEffect` dependency array.** The `effect` call subscribes to whatever reactive values it reads. An empty-deps equivalent is just an `effect` that does not read any tracker.

**No virtual DOM.** When `tasks` changes, only the list's DOM children update. When `newTitle` changes, only the input's value updates. The rest of the component stays put.

**Native `if` / `for`.** The compiler turns these into reactive subscriptions automatically. No special `<Show>` or `v-if` directive.

**Form handling.** The `onSubmit` / `onInput` handlers read like vanilla JavaScript. `e.target as HTMLInputElement` is the only TypeScript dance, and it is the same in React.

### Adding Type-Safe Fetch

For a larger app, hand-rolled `fetch` calls become a maintenance tax. Two 2026-grade options:

**Option A, share types via OpenAPI.** Your Go service publishes an OpenAPI 3.1 spec (Chapter 41 covers `ogen-go/ogen`). On the frontend, run `openapi-typescript` to generate TypeScript types, then wrap `fetch` in a typed client. This gives end-to-end type safety with almost zero runtime cost.

**Option B, share types via Connect (gRPC-Web).** Your Go service defines protobuf schemas, generates both the server stubs and the TypeScript client, and Connect handles the transport. Chapter 42C (Beyond REST with gRPC) covers the Go side. On the frontend, `@bufbuild/connect-web` slots into a Ripple component the same way `fetch` does. This gives stronger contract enforcement and cheaper streaming.

For most startups in 2026, Option A is lighter. For organizations with three or more services and a platform team, Option B is worth the ceremony.

### Server-Sent Events and WebSockets

Real-time updates integrate naturally with reactive collections. An SSE stream from the Go backend can push new tasks into the `RippleArray` as they arrive:

```typescript
effect(() => {
  const es = new EventSource('http://localhost:8080/api/tasks/stream');
  es.onmessage = (e) => {
    const task: Task = JSON.parse(e.data);
    tasks.push(task);
  };
  return () => es.close(); // cleanup
});
```

Because `tasks` is a `RippleArray`, any template that renders it updates automatically when the stream pushes. No manual state sync, no `setTasks(prev => [...prev, task])`. Chapter 29 (Web Services) and Chapter 53 (Frontend Integration Fundamentals) cover the Go-side SSE implementation.

### Deployment

Ripple apps build to static assets (HTML, JS, CSS). Serve them from Cloudflare Pages, S3 + CloudFront, Vercel, or your own Go binary using `http.FileServer`. For the "single binary" deployment story Go engineers love, embed the built Ripple assets into the Go binary using `//go:embed` and serve them from a dedicated route.

```go
//go:embed dist/*
var distFS embed.FS

func main() {
    mux := http.NewServeMux()
    // API routes...
    mux.HandleFunc("GET /api/tasks", ...)

    // Static assets
    dist, _ := fs.Sub(distFS, "dist")
    mux.Handle("/", http.FileServer(http.FS(dist)))

    log.Fatal(http.ListenAndServe(":8080", mux))
}
```

One binary, one deploy, frontend and backend version-locked together. This is the full-stack pattern this book recommends for small teams, and it composes cleanly with Ripple.

### Junior → FAANG: Reading End-to-End Examples Correctly

End-to-end examples in technical books are scaffolding, not blueprints. The Go backend in this section is intentionally minimal: no input validation, no authentication, no rate limiting, no pagination, no structured logging, and an in-memory store that resets on restart. Every one of those omissions is intentional to keep the example readable. Your first job-instinct should be to identify the omissions and know which chapters fill them in.

Before using this pattern in production, go through this checklist.

Input validation: the `POST /api/tasks` handler decodes a JSON body and calls `store.Add(body.Title)` without validating that `body.Title` is non-empty, not a script injection, and within a reasonable length. Chapter 38 and Chapter 29 cover the validation middleware that belongs here.

CORS: `Access-Control-Allow-Origin: *` is acceptable for a local development example and a security liability in production. Production CORS policy requires an explicit allowlist of origins. Chapter 53 covers the correct CORS middleware setup.

Authentication: there is no auth on either endpoint. Chapter 53 also covers JWT validation and session-cookie patterns for full-stack Go apps.

Persistence: `TaskStore` uses an in-memory map. A server restart loses all tasks. The production version connects to a database. Chapter 22 (SQL and Databases) covers the Go side.

For FAANG interviews, you will often be asked to build a small end-to-end system in 45 minutes. The ability to build a correct minimal version (like this example) and then accurately enumerate the production gaps is exactly what interviewers are looking for. "Here is the core, and here are the five things I would add before shipping" is a senior answer delivered at junior speed.

The Ripple frontend has one common beginner mistake: the `effect` that loads tasks runs once because it reads no tracked values inside. If you added `let &[userId] = track('abc')` and read `userId` inside the `effect`, the effect would re-run every time `userId` changed, re-fetching tasks for the new user. That is powerful and also easy to trigger accidentally. Know the rule: an `effect` re-runs whenever a tracked value it read during its last execution changes.

### Senior @ FAANG: Full-Stack Contract, Type Safety, and Deployment Architecture

The Go backend and Ripple frontend in this example share a `Task` type that is defined twice: once as a Go struct with JSON tags, and once as a TypeScript type. That duplication is the primary maintenance risk in any REST-based full-stack system. When the Go struct gains a field, the TypeScript type must be updated in sync. In a small project with one team, that sync is informal and usually works. In a platform with multiple teams, it is a contract violation waiting to happen.

The two options (OpenAPI with `openapi-typescript`, or Connect with generated TypeScript clients) are the correct solutions. The architectural decision between them is not primarily technical. It is organizational. OpenAPI is the lower-ceremony choice for teams that already own an API gateway or publish their specs to a developer portal. Connect (gRPC-Web) is the right choice for platforms that have adopted protobuf as the cross-service contract language, because the TypeScript client is generated from the same `.proto` file that generates the Go server stub. That single source of truth eliminates the sync problem structurally, not just by process.

The `//go:embed` single-binary deployment pattern is worth a senior-level analysis because it has non-obvious operational tradeoffs. The advantage is atomic deployment: frontend and backend are always the same version, and you cannot have a mismatched deploy. The disadvantage is that the frontend build must complete before the Go binary is built, which adds the Ripple/Vite build step to your Go CI pipeline. For teams that previously had independent frontend and backend deploys, this introduces a coupling that may slow down hotfixes. If a CSS bug needs a fix, you must now wait for the full Go build rather than deploying a static asset update. Whether that trade is worth it depends on your release cadence and your infrastructure: single-binary deployment is excellent for containerized microservices where the container is the deployment unit, and less excellent for CDN-heavy architectures where static assets are served separately.

The SSE real-time pattern is correct but omits a critical production concern: connection management at scale. An SSE connection is a long-lived HTTP connection. Go's `net/http` handles this with goroutines, one per connection. At 10,000 concurrent users, you have 10,000 goroutines blocked on the channel write in the SSE handler. That is manageable in Go (goroutines are cheap). The harder problem is the broker pattern: the Go handler must know which connections to notify when a new task arrives. Chapter 29 covers the hub/spoke broadcaster pattern that solves this correctly. Without it, the naive SSE implementation either notifies nobody or broadcasts to every connection regardless of who should receive the event.

Deployment architecture recommendation for a FAANG-level interview: describe the single-binary pattern as appropriate for "one product team, one service, internal tooling or early-stage startup." Describe the separate-deploy pattern (CDN for static assets, separate API service) as appropriate for "consumer-scale products where static assets must be served from edge nodes close to users, and where frontend and backend teams have independent release cadences." Being able to name the decision criteria, not just the two options, is the L6 signal.

---
