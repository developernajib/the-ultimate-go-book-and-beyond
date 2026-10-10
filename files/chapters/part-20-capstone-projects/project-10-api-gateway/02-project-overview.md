## Project Overview

An API gateway is the single entry point for all client requests in a microservices architecture. It handles routing, authentication, rate limiting, load balancing, and much more. In this project, we'll build **GatewayGo** - a production-ready API gateway similar to Kong or Envoy, but written entirely in Go.

### What We're Building

**GatewayGo** is a high-performance API gateway with:

- **Dynamic Routing**: Path-based, host-based, and header-based routing
- **Plugin Architecture**: Extensible middleware system
- **Load Balancing**: Multiple algorithms with health checking
- **Authentication**: JWT, API Key, OAuth2, mTLS
- **Rate Limiting**: Token bucket, sliding window, distributed limiting
- **Security**: TLS termination, IP filtering, WAF capabilities
- **Observability**: Structured logging, metrics, distributed tracing
- **Admin API**: RESTful API for runtime configuration
- **Hot Reload**: Zero-downtime configuration updates
- **Protocol Support**: HTTP/1.1, HTTP/2, WebSocket, gRPC

### Architecture Overview

GatewayGo is structured around a linear plugin chain where each incoming request passes through a sequence of composable middleware handlers before being forwarded to an upstream. Plugins are invoked in a deterministic order, authentication is always evaluated before rate limiting, and rate limiting before transformation, so a rejected request never consumes unnecessary downstream resources. The load balancer sits below the plugin chain and selects a concrete upstream target using the configured algorithm (round-robin, least-connections, or weighted random), then reverses-proxies the mutated request and streams the response back to the caller.

```
┌─────────────────────────────────────────────────────────────┐
│                         API Gateway                         │
│  ┌───────────────────────────────────────────────────────┐  │
│  │              Request Pipeline                         │  │
│  │ ┌─────────┐   ┌─────────┐   ┌─────────┐   ┌─────────┐ │  │
│  │ │  Auth   │ → │  Rate   │ → │Transform│ → │  Route  │ │  │
│  │ │ Plugin  │   │  Limit  │   │ Plugin  │   │         │ │  │
│  │ └─────────┘   └─────────┘   └─────────┘   └─────────┘ │  │
│  └───────────────────────────────────────────────────────┘  │
│  ┌───────────────────────────────────────────────────────┐  │
│  │              Load Balancer                            │  │
│  │  ┌──────────┐  ┌──────────┐  ┌──────────┐             │  │
│  │  │Upstream 1│  │Upstream 2│  │Upstream 3│             │  │
│  │  └──────────┘  └──────────┘  └──────────┘             │  │
│  └───────────────────────────────────────────────────────┘  │
│  ┌───────────────────────────────────────────────────────┐  │
│  │         Configuration Manager (Hot Reload)            │  │
│  └───────────────────────────────────────────────────────┘  │
│  ┌───────────────────────────────────────────────────────┐  │
│  │              Admin API (Port 9090)                    │  │
│  └───────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────┘
```

### Real-World Use Cases
1. **Microservices Architecture**: Single entry point for all services
2. **API Versioning**: Route `/v1/*` to old services, `/v2/*` to new ones
3. **Multi-Tenant SaaS**: Route by tenant ID or subdomain
4. **Legacy Migration**: Gradually migrate from monolith to microservices
5. **Security Layer**: Centralized authentication and authorization
6. **Rate Limiting**: Protect backend services from abuse
7. **Protocol Translation**: HTTP to gRPC, REST to GraphQL
