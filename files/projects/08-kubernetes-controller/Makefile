IMG            ?= postgres-operator:latest
CONTROLLER_GEN ?= $(shell which controller-gen 2>/dev/null || echo "controller-gen")
ENVTEST        ?= $(shell which setup-envtest 2>/dev/null || echo "setup-envtest")
ENVTEST_K8S_VERSION ?= 1.29.0
CRD_OPTIONS    ?= "crd:trivialVersions=true,preserveUnknownFields=false"

.PHONY: all build generate manifests install run run-envtest test lint \
        docker-build docker-push deploy undeploy help

all: build

## build: Compile the operator binary
build:
	go build -trimpath -o bin/manager ./cmd/main

## generate: Regenerate zz_generated.deepcopy.go
generate:
	$(CONTROLLER_GEN) object:headerFile="hack/boilerplate.go.txt" paths="./..."

## manifests: Regenerate CRD and RBAC manifests in config/
manifests:
	$(CONTROLLER_GEN) $(CRD_OPTIONS) rbac:roleName=manager-role webhook paths="./..." output:crd:artifacts:config=config/crd/bases

## install: Apply CRD to the current cluster
install: manifests
	kubectl apply -f config/crd/bases/

## uninstall: Remove CRD from the current cluster
uninstall:
	kubectl delete -f config/crd/bases/ --ignore-not-found

## run: Run the operator locally (uses ~/.kube/config)
run: manifests
	go run ./cmd/main \
		--metrics-bind-address=:8080 \
		--health-probe-bind-address=:8081 \
		--leader-elect=false

## run-envtest: Run using envtest (embedded k8s API server, no cluster needed)
run-envtest:
	KUBEBUILDER_ASSETS="$$($(ENVTEST) use $(ENVTEST_K8S_VERSION) --bin-path /tmp/envtest-bins -p path)" \
		go run ./cmd/main --leader-elect=false

## test: Run tests using envtest
test:
	KUBEBUILDER_ASSETS="$$($(ENVTEST) use $(ENVTEST_K8S_VERSION) --bin-path /tmp/envtest-bins -p path)" \
		go test -race -count=1 -timeout=300s ./...

## test-cover: Run tests with coverage report
test-cover:
	KUBEBUILDER_ASSETS="$$($(ENVTEST) use $(ENVTEST_K8S_VERSION) --bin-path /tmp/envtest-bins -p path)" \
		go test -race -coverprofile=coverage.out ./...
	go tool cover -html=coverage.out

## lint: Run go vet
lint:
	go vet ./...

## docker-build: Build the operator Docker image
docker-build:
	docker build -t $(IMG) .

## docker-push: Push the operator image to a registry
docker-push:
	docker push $(IMG)

## deploy: Deploy the operator to the current cluster
deploy: manifests docker-build docker-push
	kubectl apply -f config/rbac/
	kubectl apply -f config/manager/
	kubectl set image deployment/controller-manager manager=$(IMG) -n system

## undeploy: Remove the operator from the cluster
undeploy:
	kubectl delete -f config/manager/ --ignore-not-found
	kubectl delete -f config/rbac/   --ignore-not-found

## sample: Apply the sample PostgresCluster manifest
sample:
	kubectl apply -f config/samples/postgrescluster.yaml

## tidy: Tidy go modules
tidy:
	go mod tidy
	go mod verify

## tools: Install required tools
tools:
	go install sigs.k8s.io/controller-tools/cmd/controller-gen@latest
	go install sigs.k8s.io/controller-runtime/tools/setup-envtest@latest

## help: Show this help
help:
	@grep -E '^## ' Makefile | sed 's/## /  /'
