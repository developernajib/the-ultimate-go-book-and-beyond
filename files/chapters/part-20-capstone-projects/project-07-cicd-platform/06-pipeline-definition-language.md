## Pipeline Definition Language

### YAML Syntax

Our CI/CD platform uses a declarative YAML syntax inspired by GitHub Actions and GitLab CI.

#### Basic Example
A minimal pipeline file defines when the pipeline triggers, what jobs to run, and what steps each job executes:

```yaml
# .pipeline.yaml
name: Go Application CI

on:
  push:
    branches: [main, develop]
  pull_request:
    branches: [main]

env:
  GO_VERSION: "1.26"
  CGO_ENABLED: "0"

stages:
  - name: build
    jobs:
      - name: compile
        image: golang:1.27.1-alpine
        steps:
          - run: go mod download
          - run: go build -v ./...
        artifacts:
          paths:
            - bin/*

  - name: test
    jobs:
      - name: unit-tests
        image: golang:1.27.1-alpine
        steps:
          - run: go test -v -race -coverprofile=coverage.out ./...
        artifacts:
          paths:
            - coverage.out

      - name: integration-tests
        image: golang:1.27.1-alpine
        depends_on:
          - postgres
          - redis
        services:
          - name: postgres
            image: postgres:18-alpine
            env:
              POSTGRES_PASSWORD: test
          - name: redis
            image: redis:8-alpine
        steps:
          - run: go test -v -tags=integration ./...

  - name: lint
    jobs:
      - name: golangci-lint
        image: golangci/golangci-lint:v2.12.2
        steps:
          - run: golangci-lint run ./...

  - name: deploy
    condition: branch == 'main' && event == 'push'
    jobs:
      - name: deploy-staging
        image: alpine:latest
        steps:
          - run: echo "Deploying to staging..."
```

#### Advanced Features

Advanced features like message threading, reactions, and read receipts extend the base protocol with additional message types and server-side state tracking. Each feature is implemented as an incremental addition to the existing handler and storage interfaces rather than a structural refactor.

```yaml
# .pipeline.yaml (advanced)
name: Microservices Deploy

variables:
  DOCKER_REGISTRY: registry.example.com
  APP_VERSION: ${CI_COMMIT_SHA:0:8}

cache:
  paths:
    - .go/pkg/mod
    - node_modules/
  key: ${CI_COMMIT_REF_SLUG}

stages:
  - name: build
    parallel: 3  # Run up to 3 jobs in parallel
    jobs:
      - name: build-api
        image: golang:1.27.1
        cache:
          paths: [.go/pkg/mod]
        env:
          GOCACHE: ${CI_PROJECT_DIR}/.go/cache
        before_script:
          - export PATH=$PATH:/usr/local/go/bin
        steps:
          - run: go mod download
          - run: go build -o bin/api ./cmd/api
        artifacts:
          paths: [bin/api]
          expire_in: 1h

      - name: build-worker
        image: golang:1.27.1
        steps:
          - run: go build -o bin/worker ./cmd/worker
        artifacts:
          paths: [bin/worker]

      - name: build-frontend
        image: node:24-alpine
        steps:
          - run: npm ci
          - run: npm run build
        artifacts:
          paths: [dist/]

  - name: docker
    jobs:
      - name: docker-build
        image: docker:24-dind
        services:
          - name: docker-dind
            image: docker:24-dind
            privileged: true
        env:
          DOCKER_HOST: tcp://docker-dind:2375
        steps:
          - run: |
              docker build -t ${DOCKER_REGISTRY}/api:${APP_VERSION} .
              docker push ${DOCKER_REGISTRY}/api:${APP_VERSION}

  - name: deploy
    condition: branch == 'main'
    jobs:
      - name: deploy-k8s
        image: bitnami/kubectl:latest
        secrets:
          - KUBECONFIG
        steps:
          - run: |
              kubectl set image deployment/api api=${DOCKER_REGISTRY}/api:${APP_VERSION}
              kubectl rollout status deployment/api

matrix:
  include:
    - GO_VERSION: "1.25"
      OS: linux
    - GO_VERSION: "1.26"
      OS: linux
    - GO_VERSION: "1.26"
      OS: darwin
```

### Pipeline Configuration Schema The complete pipeline structure supports:

```yaml
name: string              # Pipeline name (required)
description: string       # Pipeline description

on:                       # Trigger conditions
  push:
    branches: [string]
    tags: [string]
  pull_request:
    branches: [string]
  schedule:
    - cron: string
  workflow_dispatch:      # Manual trigger

env:                      # Global environment variables
  KEY: value

variables:                # Variables with interpolation
  VAR: ${EXPRESSION}

cache:                    # Global cache config
  paths: [string]
  key: string

stages:                   # Execution stages
  - name: string
    condition: expression # Stage-level condition
    parallel: int         # Max parallel jobs
    jobs:
      - name: string
        image: string
        depends_on: [string]
        condition: expression
        timeout: duration
        retry:
          max: int
          backoff: duration
        env:
          KEY: value
        secrets: [string]
        services: [...]
        cache: {...}
        before_script: [string]
        steps: [...]
        after_script: [string]
        artifacts: {...}

matrix:                   # Matrix builds
  include:
    - VAR1: value
      VAR2: value

notifications:            # Success/failure notifications
  email: [string]
  slack: string
  webhook: string
```

---
