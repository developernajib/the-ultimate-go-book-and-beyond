## Development Workflow, Contributing & License

### Development Tooling

Keeping a consistent code style across contributors requires automated enforcement rather than manual review comments.

```bash
# Format code and imports
make fmt

# Run static analysis linters
make lint

# Run security vulnerability audit
make security

# Execute full test suite with race detector
make test
```

### Contributing Guidelines

We welcome community contributions! To propose bug fixes, performance improvements, or new plugins:

1. **Fork the Repository**: Clone your fork locally and configure the upstream remote.
2. **Create a Feature Branch**: Use descriptive branch names (`git checkout -b feature/jwt-caching`).
3. **Write Unit Tests**: Ensure all new plugins and middleware maintain >80% test coverage.
4. **Commit with Conventions**: Write concise, conventional commit messages (`feat: add redis cluster support to rate limiter`).
5. **Open a Pull Request**: Provide a clear description of the problem solved and benchmark comparisons where applicable.

### License

GatewayGo is licensed under the permissive **MIT License**. You are free to use, modify, distribute, and embed this code in personal, open-source, and proprietary commercial applications. See the root `LICENSE` file for full legal terms.
