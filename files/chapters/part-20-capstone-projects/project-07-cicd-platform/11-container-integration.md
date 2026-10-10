## Container Integration

Many CI/CD jobs need more than just a build container. They often require service containers like databases, Redis instances, or message queues to run integration tests against. This section covers how to programmatically create and manage these service containers using the Docker API. The platform creates an isolated Docker network for each job, starts the required service containers, waits for them to become healthy, and then tears everything down after the job completes.

### Service Container Management

Service containers (databases, message queues) need to be managed alongside job containers.

Create `internal/executor/services.go`:

```go
package executor

import (
	"context"
	"fmt"
	"time"

	"github.com/docker/docker/api/types/container"
	"github.com/docker/docker/api/types/network"
	"github.com/docker/go-connections/nat"
	"github.com/google/uuid"
	"github.com/rs/zerolog/log"
	"github.com/yourusername/cicd-platform/internal/parser"
)

// ServiceManager manages service containers
type ServiceManager struct {
	executor *DockerExecutor
}

// NewServiceManager creates a new service manager
func NewServiceManager(executor *DockerExecutor) *ServiceManager {
	return &ServiceManager{executor: executor}
}

// ServiceContext holds information about running services
type ServiceContext struct {
	NetworkID   string
	ContainerIDs []string
	Aliases      map[string]string // Service name -> container IP
}

// StartServices starts all service containers for a job
func (sm *ServiceManager) StartServices(
	ctx context.Context,
	services []parser.ServiceConfig,
	jobRunID uuid.UUID,
) (*ServiceContext, error) {
	if len(services) == 0 {
		return &ServiceContext{}, nil
	}

	// Create a dedicated network for this job
	networkName := fmt.Sprintf("job-%s", jobRunID.String())
	networkResp, err := sm.executor.client.NetworkCreate(ctx, networkName, network.CreateOptions{
		Driver:     "bridge",
		Attachable: true,
	})
	if err != nil {
		return nil, fmt.Errorf("create network: %w", err)
	}

	svcCtx := &ServiceContext{
		NetworkID:    networkResp.ID,
		ContainerIDs: make([]string, 0, len(services)),
		Aliases:      make(map[string]string),
	}

	// Start each service container
	for _, svc := range services {
		containerID, err := sm.startServiceContainer(ctx, svc, networkResp.ID, jobRunID)
		if err != nil {
			// Cleanup on failure
			sm.StopServices(ctx, svcCtx)
			return nil, fmt.Errorf("start service %s: %w", svc.Name, err)
		}

		svcCtx.ContainerIDs = append(svcCtx.ContainerIDs, containerID)
		svcCtx.Aliases[svc.Name] = svc.Name // Use service name as hostname

		log.Info().
			Str("service", svc.Name).
			Str("image", svc.Image).
			Str("container_id", containerID).
			Msg("Service container started")
	}

	// Wait for services to be healthy
	if err := sm.waitForServices(ctx, svcCtx.ContainerIDs); err != nil {
		sm.StopServices(ctx, svcCtx)
		return nil, fmt.Errorf("wait for services: %w", err)
	}

	return svcCtx, nil
}

// startServiceContainer starts a single service container
func (sm *ServiceManager) startServiceContainer(
	ctx context.Context,
	svc parser.ServiceConfig,
	networkID string,
	jobRunID uuid.UUID,
) (string, error) {
	// Pull image
	if err := sm.executor.pullImage(ctx, svc.Image); err != nil {
		return "", fmt.Errorf("pull image: %w", err)
	}

	// Prepare environment
	env := make([]string, 0, len(svc.Env))
	for k, v := range svc.Env {
		env = append(env, fmt.Sprintf("%s=%s", k, v))
	}

	// Prepare port bindings
	exposedPorts := nat.PortSet{}
	portBindings := nat.PortMap{}

	for _, portStr := range svc.Ports {
		port, err := nat.NewPort("tcp", portStr)
		if err != nil {
			log.Warn().Err(err).Str("port", portStr).Msg("Invalid port")
			continue
		}
		exposedPorts[port] = struct{}{}
		portBindings[port] = []nat.PortBinding{{HostIP: "0.0.0.0"}}
	}

	// Container configuration
	config := &container.Config{
		Image:        svc.Image,
		Env:          env,
		ExposedPorts: exposedPorts,
		Hostname:     svc.Name,
	}

	// Host configuration
	hostConfig := &container.HostConfig{
		PortBindings: portBindings,
		Resources: container.Resources{
			Memory:   1 * 1024 * 1024 * 1024, // 1GB
			NanoCPUs: 1 * 1000000000,         // 1 CPU
		},
	}

	// Network configuration
	networkConfig := &network.NetworkingConfig{
		EndpointsConfig: map[string]*network.EndpointSettings{
			networkID: {
				Aliases: []string{svc.Name},
			},
		},
	}

	// Create container
	containerName := fmt.Sprintf("svc-%s-%s", svc.Name, jobRunID.String())
	resp, err := sm.executor.client.ContainerCreate(
		ctx,
		config,
		hostConfig,
		networkConfig,
		nil,
		containerName,
	)
	if err != nil {
		return "", fmt.Errorf("create container: %w", err)
	}

	// Start container
	if err := sm.executor.client.ContainerStart(ctx, resp.ID, container.StartOptions{}); err != nil {
		return "", fmt.Errorf("start container: %w", err)
	}

	return resp.ID, nil
}

// waitForServices waits for service containers to be healthy
func (sm *ServiceManager) waitForServices(ctx context.Context, containerIDs []string) error {
	timeout := 60 * time.Second
	deadline := time.Now().Add(timeout)

	for _, containerID := range containerIDs {
		for time.Now().Before(deadline) {
			inspect, err := sm.executor.client.ContainerInspect(ctx, containerID)
			if err != nil {
				return fmt.Errorf("inspect container: %w", err)
			}

			// If container has health check, wait for it
			if inspect.State.Health != nil {
				if inspect.State.Health.Status == "healthy" {
					break
				}
			} else {
				// No health check - just verify it's running
				if inspect.State.Running {
					break
				}
			}

			time.Sleep(1 * time.Second)
		}

		// Final check
		inspect, err := sm.executor.client.ContainerInspect(ctx, containerID)
		if err != nil {
			return fmt.Errorf("inspect container: %w", err)
		}

		if !inspect.State.Running {
			return fmt.Errorf("service container %s not running", containerID)
		}
	}

	return nil
}

// StopServices stops and removes all service containers
func (sm *ServiceManager) StopServices(ctx context.Context, svcCtx *ServiceContext) error {
	// Stop all containers
	for _, containerID := range svcCtx.ContainerIDs {
		timeout := 10 * time.Second
		if err := sm.executor.client.ContainerStop(ctx, containerID, container.StopOptions{Timeout: &timeout}); err != nil {
			log.Warn().Err(err).Str("container_id", containerID).Msg("Failed to stop service container")
		}

		// Remove container
		if err := sm.executor.client.ContainerRemove(ctx, containerID, container.RemoveOptions{Force: true}); err != nil {
			log.Warn().Err(err).Str("container_id", containerID).Msg("Failed to remove service container")
		}
	}

	// Remove network
	if svcCtx.NetworkID != "" {
		if err := sm.executor.client.NetworkRemove(ctx, svcCtx.NetworkID); err != nil {
			log.Warn().Err(err).Str("network_id", svcCtx.NetworkID).Msg("Failed to remove network")
		}
	}

	return nil
}
```

---
