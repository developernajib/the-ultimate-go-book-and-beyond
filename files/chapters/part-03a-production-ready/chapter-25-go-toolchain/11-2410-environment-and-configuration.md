## 25.10 Environment and Configuration

### Go Environment Variables

`go env -w` persists changes to a per-user environment file (`$GOENV`, typically `~/.config/go/env`) rather than requiring shell profile edits, making settings survive across shells and CI runners without extra setup. This is particularly important for `GOPRIVATE`, which tells both the module proxy and the checksum database to skip verification for matching module paths, without it, private module fetches fail with authentication errors or leak module names to the public sumdb.

```bash
# View all Go environment
go env

# View specific variable
go env GOPATH
go env GOMODCACHE

# Set environment variable
go env -w GOPRIVATE=github.com/mycompany/*
go env -w GOFLAGS="-mod=readonly"

# Unset
go env -u GOFLAGS
```

### Important Variables

| Variable | Description |
|----------|-------------|
| GOPATH | Workspace directory |
| GOMODCACHE | Module cache location |
| GOPRIVATE | Private module patterns |
| GOPROXY | Module proxy URL |
| GOSUMDB | Checksum database |
| GOFLAGS | Default flags for go commands |
| CGO_ENABLED | Enable/disable cgo |
| GOMAXPROCS | Maximum CPUs to use |

### Module Proxy Configuration

`GOPROXY` accepts a fallback chain, and the separator you use between entries changes its meaning. A comma advances to the next entry **only** on a 404 or 410, meaning "this proxy does not have the module". A pipe advances on **any** error, including a timeout, a 500, or a TLS failure. Setting `direct` as the final fallback means that if the proxies cannot find a module (common for newly published or internal modules), Go fetches directly from version control rather than failing.

That distinction has real consequences. `https://internal-proxy,direct` fails closed: if your proxy is down, the build stops rather than quietly reaching out to the internet. `https://internal-proxy|direct` fails open: a flaky proxy silently redirects fetches to public VCS, which can bypass the caching, auditing, and CVE-scanning choke point you built the proxy for in the first place. Prefer the comma unless you have thought about that trade and want it.

`GONOSUMDB` sits alongside `GOPRIVATE` and `GONOPROXY` as the granular form: it suppresses checksum-database verification for matching patterns without also disabling proxy lookups, which matters when you want proxy caching for private modules but cannot publish their hashes to the public transparency log. `GOPRIVATE` is the convenience knob that sets sensible defaults for both `GONOPROXY` and `GONOSUMDB` at once, and it is what most teams should reach for first.

```bash
# Use default proxy
export GOPROXY=https://proxy.golang.org,direct

# Use multiple proxies. Comma: fall through only when a proxy reports the
# module is absent (404/410).
export GOPROXY=https://goproxy.cn,https://proxy.golang.org,direct

# Pipe: fall through on ANY error, including timeouts and 5xx. Convenient,
# but it means an unhealthy internal proxy silently sends fetches direct.
export GOPROXY=https://internal-proxy|direct

# Direct only (no proxy)
export GOPROXY=direct

# Never fall back: fail if the proxy does not have it
export GOPROXY=https://internal-proxy

# Disable checksum database for private modules
export GONOSUMDB=github.com/mycompany/*

# Usually simpler: one knob that defaults both GONOPROXY and GONOSUMDB
export GOPRIVATE=github.com/mycompany/*
```

### Staff Lens: Shared Build Environment

Engineers and CI should use the same GOFLAGS, GOPROXY, GOMODCACHE configuration. Without this, reproducibility differs by environment. Document the standard, and ensure CI and onboarding use it.

---
