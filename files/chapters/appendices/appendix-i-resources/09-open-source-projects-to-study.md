## Open Source Projects to Study

Studying production codebases is one of the best ways to learn idiomatic Go and real-world patterns. Here are carefully selected projects that exemplify Go best practices.

### Go Standard Library

**URL**: https://github.com/golang/go
**Location**: `src/` directory
**Level**: Beginner to Advanced

**Why Study**: The ultimate reference for idiomatic Go. Written by the language designers.

**Packages to Study First**:

1. **net/http**: Web server and client
 - Clean API design
 - Interface usage
 - Concurrency patterns
 - Testing strategies

2. **encoding/json**: JSON encoding/decoding
 - Reflection usage
 - Error handling
 - Performance optimization

3. **context**: Context propagation
 - Interface design
 - Cancellation patterns
 - Best practices

4. **io**: I/O primitives
 - Small, composable interfaces
 - Reader/Writer patterns
 - Interface composition

5. **testing**: Testing framework
 - Table-driven tests
 - Benchmarking
 - Example tests

6. **sync**: Synchronization primitives
 - Mutex implementation
 - WaitGroup patterns
 - Once, Pool, Map

**Study Approach**:
1. Pick a package you use regularly
2. Read the package documentation
3. Study the source code
4. Read the tests to understand usage
5. Implement your own simplified version

**Key Learnings**:
- Simple, clear naming
- Small interfaces
- Thorough testing
- Thorough documentation
- Performance considerations

### Docker / Moby

**URL**: https://github.com/moby/moby
**Size**: Large
**Domain**: Container runtime and engine
**Level**: Advanced

**Why Study**: Real-world production system powering millions of containers.

**Key Learnings**:
- Large-scale Go project structure
- Plugin architecture
- API design (REST API)
- Client-server patterns
- Error handling at scale
- Networking code
- Integration testing

**Focus Areas**:
- `api/`: REST API implementation
- `client/`: Go client library
- `daemon/`: Core daemon logic
- `pkg/`: Reusable packages

**Challenges**: Large codebase, complex domain knowledge required.

**Study Tip**: Start with the client library (`client/`), then daemon internals.

### Kubernetes

**URL**: https://github.com/kubernetes/kubernetes
**Size**: Very Large
**Domain**: Container orchestration
**Level**: Advanced

**Why Study**: The most influential Go project. Powers production infrastructure globally.

**Key Learnings**:
- Microservices architecture in Go
- API machinery and code generation
- Controller pattern
- Reconciliation loops
- Testing massive systems
- CLI design (kubectl)
- Custom resource definitions

**Focus Areas**:
- `pkg/`: Core packages
- `cmd/`: Binary entrypoints (kubelet, kubectl, etc.)
- `staging/src/k8s.io/`: Reusable libraries
- `api/`: API definitions

**Reusable Libraries**:
- `client-go`: Kubernetes client
- `apimachinery`: API machinery
- `cli-runtime`: CLI framework

**Study Tip**: Start with client-go and a simple controller, not the full system.

**Resources**:
- Kubernetes development guide
- Controller pattern documentation
- Sample controllers repository

### Prometheus

**URL**: https://github.com/prometheus/prometheus
**Size**: Large
**Domain**: Monitoring and alerting
**Level**: Intermediate to Advanced

**Why Study**: Production-grade monitoring system with excellent Go code quality.

**Key Learnings**:
- Time-series database implementation
- Query language design (PromQL)
- HTTP API patterns
- Configuration management
- Storage optimization
- Exporters and scraping

**Focus Areas**:
- `promql/`: Query language implementation
- `storage/`: Time-series storage
- `scrape/`: Metrics collection
- `web/`: HTTP API

**Related Projects**:
- `prometheus/client_golang`: Go client library (study this first)
- Various exporters (simpler starting point)

### CockroachDB

**URL**: https://github.com/cockroachdb/cockroach
**Size**: Very Large
**Domain**: Distributed SQL database
**Level**: Advanced

**Why Study**: Distributed systems implementation in Go at scale.

**Key Learnings**:
- Distributed consensus (Raft)
- SQL implementation
- Distributed transactions
- Network protocol design
- Performance optimization
- Testing distributed systems

**Focus Areas**:
- `pkg/kv/`: Key-value layer
- `pkg/sql/`: SQL layer
- `pkg/roachpb/`: Protocol buffers
- `pkg/rpc/`: RPC implementation

**Warning**: Very complex. Focus on specific subsystems.

### Hugo

**URL**: https://github.com/gohugoio/hugo
**Size**: Large
**Domain**: Static site generator
**Level**: Intermediate

**Why Study**: Well-structured CLI application with clear architecture.

**Key Learnings**:
- CLI application structure
- File processing and templating
- Configuration management
- Concurrent file processing
- Plugin architecture
- Fast builds (performance focus)

**Focus Areas**:
- `commands/`: CLI commands (Cobra usage)
- `hugolib/`: Core Hugo library
- `tpl/`: Template functions
- `resources/`: Resource transformation

**Best For**: Learning CLI application design and file processing.

### Caddy

**URL**: https://github.com/caddyserver/caddy
**Size**: Medium
**Domain**: Web server with automatic HTTPS
**Level**: Intermediate

**Why Study**: Clean, modern web server implementation.

**Key Learnings**:
- HTTP server implementation
- TLS/HTTPS automation (ACME)
- Plugin architecture
- Configuration (Caddyfile)
- Reverse proxy implementation
- Middleware patterns

**Focus Areas**:
- `modules/`: Modular architecture
- `caddyhttp/`: HTTP server
- `caddyconfig/`: Configuration loading

**Best For**: Learning web server internals and plugin systems.

### Terraform

**URL**: https://github.com/hashicorp/terraform
**Size**: Very Large
**Domain**: Infrastructure as code
**Level**: Advanced

**Why Study**: Complex CLI application with plugin system.

**Key Learnings**:
- Plugin architecture (HashiCorp plugin system)
- Graph algorithms (dependency graphs)
- State management
- Provider pattern
- CLI design at scale

**Related Projects**:
- `terraform-plugin-sdk`: Plugin development (start here)
- Various providers (simpler than core)

### Consul

**URL**: https://github.com/hashicorp/consul
**Size**: Large
**Domain**: Service mesh and service discovery
**Level**: Advanced

**Key Learnings**:
- Distributed consensus (Raft)
- Service discovery patterns
- gRPC usage
- Health checking
- Key-value store implementation

### Vault

**URL**: https://github.com/hashicorp/vault
**Size**: Large
**Domain**: Secrets management
**Level**: Advanced

**Key Learnings**:
- Security patterns
- Plugin architecture
- Encryption and key management
- HTTP API design
- Audit logging

### etcd

**URL**: https://github.com/etcd-io/etcd
**Size**: Large
**Domain**: Distributed key-value store
**Level**: Advanced

**Why Study**: Foundation of Kubernetes. Excellent distributed systems code.

**Key Learnings**:
- Raft consensus implementation
- gRPC server/client
- Distributed systems patterns
- Write-ahead logging
- Client library design

**Focus Areas**:
- `client/v3/`: Client library
- `server/`: Server implementation
- `raft/`: Raft implementation

### Gin Web Framework

**URL**: https://github.com/gin-gonic/gin
**Size**: Medium
**Domain**: Web framework
**Level**: Intermediate

**Why Study**: Popular, performant web framework with clean code.

**Key Learnings**:
- Router implementation
- Middleware patterns
- Context usage
- Request/response handling
- JSON rendering
- Performance optimization

**Best For**: Learning web framework design and HTTP patterns.

### gRPC-Go

**URL**: https://github.com/grpc/grpc-go
**Size**: Large
**Domain**: RPC framework
**Level**: Intermediate to Advanced

**Key Learnings**:
- RPC patterns in Go
- Protocol buffers integration
- Streaming RPCs
- Interceptors (middleware)
- Load balancing
- Connection management

### Cobra (CLI Framework)

**URL**: https://github.com/spf13/cobra
**Size**: Medium
**Domain**: CLI framework
**Level**: Intermediate

**Why Study**: The de facto standard for CLI applications in Go.

**Key Learnings**:
- Command pattern implementation
- Flag parsing
- Subcommand structure
- Help generation
- Shell completion

**Used By**: kubectl, Hugo, GitHub CLI, and hundreds of others.

### Additional Notable Projects

#### Minio

**URL**: https://github.com/minio/minio
**Domain**: Object storage (S3-compatible)
**Key Learnings**: Distributed storage, S3 API implementation

#### Gitea

**URL**: https://github.com/go-gitea/gitea
**Domain**: Git service (like GitHub)
**Key Learnings**: Web application structure, Git integration

#### Traefik

**URL**: https://github.com/traefik/traefik
**Domain**: Reverse proxy and load balancer
**Key Learnings**: Proxy implementation, dynamic configuration

#### Benthos

**URL**: https://github.com/benthosdev/benthos
**Domain**: Stream processing
**Key Learnings**: Data pipeline patterns, plugin architecture

#### Packer

**URL**: https://github.com/hashicorp/packer
**Domain**: Image building automation
**Key Learnings**: Builder pattern, plugin system

### How to Study Open Source Projects

1. **Start Small**: Don't try to understand everything at once
2. **Read Tests**: Tests show how the code is meant to be used
3. **Use Debugger**: Step through code to understand flow
4. **Contribute**: Fix a bug or add a feature to truly understand
5. **Read Issues/PRs**: See how maintainers think about design
6. **Fork and Modify**: Make changes to learn internals

**Suggested Progression**:
1. Study standard library packages
2. Small focused projects (Cobra, Gin)
3. Medium applications (Hugo, Caddy)
4. Large systems (Docker, Kubernetes) - specific components only

---
