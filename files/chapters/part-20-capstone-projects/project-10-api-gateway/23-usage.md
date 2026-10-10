## Usage

### Basic Proxying

All client traffic enters through port `8080`, where the gateway performs tenant resolution, JWT validation, rate-limit checks, and upstream routing before forwarding the request. The health endpoint on port `9090` is intentionally separated from the data plane so that load balancers and orchestrators can probe liveness without touching the proxy logic or generating spurious access-log noise.

```bash
# Send request through gateway
curl http://localhost:8080/api/users

# Check gateway health
curl http://localhost:9090/health
```

### Admin API

The admin API exposes the gateway's control plane at runtime, allowing routes to be added, modified, or removed without a restart. This hot-reload capability is critical in multi-tenant deployments where new tenants or upstream services must be onboarded instantly. Internally, route changes are applied atomically to the in-memory routing table using a read-write mutex so in-flight requests on existing routes complete without interruption.

```bash
# List routes
curl http://localhost:9090/routes

# Create route
curl -X POST http://localhost:9090/routes \
  -H "Content-Type: application/json" \
  -d '{
    "id": "new-route",
    "paths": ["/new"],
    "upstream_id": "backend"
  }'

# Delete route
curl -X DELETE http://localhost:9090/routes/new-route
```

### Plugins Configure plugins in YAML:

```yaml
routes:
  - id: protected-route
    paths: ["/api/*"]
    upstream_id: backend
    plugins:
      - name: jwt_auth
        enabled: true
        config:
          secret: "your-secret"
      - name: rate_limit
        enabled: true
        config:
          requests_per_second: 100
```
