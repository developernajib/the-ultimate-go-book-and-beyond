## Acknowledgments - Inspired by Kong and Envoy
- Built with Go and love
```

### .gitignore

A well-structured `.gitignore` prevents compiled artifacts, test binaries, coverage reports, and IDE-specific metadata from polluting the repository. Keeping `vendor/` excluded is especially important for Go modules projects where dependencies are fetched reproducibly via `go mod download`. Secrets-containing config files are commented out as a reminder to add them explicitly if the project adopts a secrets-in-config pattern.

```

```gitignore
# Binaries
bin/
*.exe
*.dll
*.so
*.dylib # Test binary, built with `go test -c`
*.test # Output of the go coverage tool
*.out
coverage.html # Go workspace file
go.work # IDE
.vscode/
.idea/
*.swp
*.swo
*~ # OS
.DS_Store
Thumbs.db # Logs
*.log # Dependencies
vendor/ # Temporary files
tmp/
temp/ # Configuration (if contains secrets)
# configs/*.yaml
```

### CI/CD Pipeline (.github/workflows/ci.yml)

The pipeline runs four jobs in a dependency graph: `test` and `lint` execute in parallel on every push and pull request, while `build` and `docker` only run after both pass, enforcing a quality gate before any artifact is produced. The `docker` job additionally gates the registry push behind a branch check so only commits merged to `main` produce a tagged image, preventing feature-branch noise from polluting the production image stream.

```yaml
name: CI on: push: branches: [ main, develop ] pull_request: branches: [ main, develop ] jobs: test: name: Test runs-on: ubuntu-latest steps: - name: Set up Go uses: actions/setup-go@v5 with: go-version: '1.27' - name: Check out code uses: actions/checkout@v4 - name: Get dependencies run: go mod download - name: Run tests run: go test -v -race -coverprofile=coverage.out ./... - name: Upload coverage uses: codecov/codecov-action@v4 with: file: ./coverage.out lint: name: Lint runs-on: ubuntu-latest steps: - name: Check out code uses: actions/checkout@v4 - name: Run golangci-lint uses: golangci/golangci-lint-action@v4 with: version: latest build: name: Build runs-on: ubuntu-latest needs: [test, lint] steps: - name: Set up Go uses: actions/setup-go@v5 with: go-version: '1.27' - name: Check out code uses: actions/checkout@v4 - name: Build run: go build -v ./cmd/gateway docker: name: Docker Build runs-on: ubuntu-latest needs: [test, lint] steps: - name: Check out code uses: actions/checkout@v4 - name: Build Docker image run: docker build -t gatewaygo:${{ github.sha }} . - name: Push to registry (on main) if: github.ref == 'refs/heads/main' run: | echo ${{ secrets.DOCKER_PASSWORD }} | docker login -u ${{ secrets.DOCKER_USERNAME }} --password-stdin docker tag gatewaygo:${{ github.sha }} gatewaygo:latest docker push gatewaygo:latest
```
