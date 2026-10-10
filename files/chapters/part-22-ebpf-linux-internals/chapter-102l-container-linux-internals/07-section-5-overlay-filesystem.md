## Section 5: Overlay Filesystem

The overlay filesystem stacks a read-only lower layer (the container image) and a writable upper layer

### Junior → FAANG: Overlay Filesystems and Container Image Layers

The overlay filesystem model is the concrete implementation of container image layering. Each `RUN` instruction in a Dockerfile creates a new layer as a tar archive of the filesystem diff. When a container is started, overlayfs mounts all image layers as read-only lower directories and adds a single writable upper directory. Writes inside the container (including writes that modify files from the lower layers, via copy-on-write) go to the upper directory. When the container exits and the upper directory is discarded, the image layers are unchanged and can be shared across new containers.

The practical consequence of copy-on-write is that modifying a large file from the image inside a container is expensive: overlayfs copies the entire file from the lower layer to the upper layer before the write, even if you are modifying only one byte. A first-job habit: never use container storage for large, frequently modified files. Database files, large logs, and machine learning model files should be on volume mounts (either host-path volumes or PersistentVolumes in Kubernetes), not in the container's writable layer. Writing to the container layer causes I/O amplification via copy-on-write and fills up the container's disk budget.

The `workdir` directory in the overlayfs mount options is an implementation requirement: overlayfs uses it for atomic copy-up operations. The workdir must be on the same filesystem as the upper directory (both are typically under `/var/lib/containerd/` or `/var/lib/docker/`). When this filesystem fills up, all container writes fail with `ENOSPC`, which is a common production incident cause that manifests as containers crashing with mysterious write errors. Monitoring the available space on the container storage filesystem and alerting at 80% capacity is the preventive measure.

Interview framing: "How does running 10 containers from the same image affect disk usage?" The answer: disk usage is approximately one copy of the image layers (shared as read-only lower layers) plus the writable upper layer for each container. If the image is 500 MB and each container writes 10 MB, total disk usage is roughly 500 MB (shared) + 100 MB (10 containers x 10 MB upper layers). Without overlayfs, each container would need its own full 500 MB copy.

### Senior @ FAANG: Overlay Filesystem Performance and Security at Production Scale

Overlay filesystem performance degrades with deeply layered images. Each file lookup traverses the layer stack: overlayfs checks the upper directory, then each lower directory in order from top to bottom. An image with 50 layers that does not find a file in the upper layer or any lower layer performs 51 inode lookups before returning `ENOENT`. Large base images with many layers increase container startup time (image pull, layer extraction) and add latency to the first file access after startup. Platform teams enforce image layer count limits (typically 10-15 layers) via admission controllers or build system policies, and require engineers to use multi-stage builds to consolidate layers.

The security boundary between the container's writable layer and the host's lower layers is maintained by the Linux DAC (Discretionary Access Control) on the overlayfs directories. If the host's container storage directory (`/var/lib/containerd/`) is readable by the container process (e.g., via a misconfigured volume mount), the container can read other containers' upper layers, including their secrets and runtime state. Platform teams apply strict DAC on the container storage directory and audit volume mount configurations via admission controllers that reject pods that mount `/var/lib/containerd` or any of its subdirectories.

Image layer deduplication across the fleet requires a content-addressable store keyed by layer SHA256 digest. containerd's content store provides this: a layer tar archive is identified by its digest and stored once regardless of how many images reference it. At FAANG scale (thousands of nodes, hundreds of distinct base images), layer deduplication reduces total storage from O(nodes * image_size) to O(unique_layers * layer_size). Platform teams track the layer deduplication ratio as a capacity efficiency metric and create alerts when the ratio degrades (which indicates that image builds are creating many unique layers instead of reusing shared base layers).

Overlay filesystem and SELinux or AppArmor interaction requires explicit configuration. When SELinux is enforcing, each container's filesystem must have the correct SELinux label (`container_file_t`) applied to its upper layer, or the container's processes (labeled `container_t`) cannot write to their own filesystem. containerd handles this automatically, but when engineers create overlay mounts manually (as in this chapter's examples), they must apply the correct labels using `chcon -Rt container_file_t <upper-dir>`. Omitting this step is a common mistake when building custom container tooling that causes failures only on SELinux-enabled systems.

--- so that writes inside the container are captured in the upper layer without modifying the shared image. Multiple container instances can share the same lower layer while having independent upper layers, which is how Docker and containerd efficiently run dozens of containers from the same image. The Go code below calls the `mount` syscall directly with `overlayfs` as the filesystem type and constructs the required `lowerdir:upperdir:workdir` option string.

```go
package overlay

import (
	"fmt"
	"os"
	"path/filepath"
	"syscall"
)

// OverlayMount mounts an overlay filesystem
// lowerDir: read-only base layer(s)  (colon-separated for multiple layers)
// upperDir: writable layer for changes
// workDir:  required by overlayfs (must be on same fs as upper)
// mergedDir: the merged view
type OverlayMount struct {
	LowerDir  string
	UpperDir  string
	WorkDir   string
	MergedDir string
}

// Mount creates the overlay filesystem
func (o *OverlayMount) Mount() error {
	// Create required directories
	for _, dir := range []string{o.UpperDir, o.WorkDir, o.MergedDir} {
		if err := os.MkdirAll(dir, 0755); err != nil {
			return fmt.Errorf("create dir %s: %w", dir, err)
		}
	}

	// overlayfs mount options
	opts := fmt.Sprintf("lowerdir=%s,upperdir=%s,workdir=%s",
		o.LowerDir, o.UpperDir, o.WorkDir)

	if err := syscall.Mount("overlay", o.MergedDir, "overlay", 0, opts); err != nil {
		return fmt.Errorf("mount overlay: %w", err)
	}

	return nil
}

// Unmount removes the overlay filesystem mount
func (o *OverlayMount) Unmount() error {
	return syscall.Unmount(o.MergedDir, 0)
}

// GetChangedFiles returns files that have been modified (in upperDir)
func (o *OverlayMount) GetChangedFiles() ([]string, error) {
	var changed []string

	err := filepath.Walk(o.UpperDir, func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return err
		}
		// Strip the upperDir prefix to get relative path
		rel, _ := filepath.Rel(o.UpperDir, path)
		if rel != "." {
			changed = append(changed, "/"+rel)
		}
		return nil
	})

	return changed, err
}
```

---
