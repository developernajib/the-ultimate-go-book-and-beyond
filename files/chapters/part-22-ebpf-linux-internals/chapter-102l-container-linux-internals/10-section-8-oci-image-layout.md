## Section 8: OCI Image Layout

The OCI (Open Container Initiative) image specification defines a content-addressable directory layout

### Junior → FAANG: OCI Images as Content-Addressable Archives

The OCI image layout is simpler than it appears. An OCI image on disk is a directory containing: an `oci-layout` file with a version string, a `blobs/sha256/` directory where every artifact is stored by its SHA256 hash, and an `index.json` file that points to the image manifest by digest. The manifest lists the config blob (which contains the image's environment variables, entrypoint, and labels) and the layer blobs (each a gzipped tar archive of filesystem changes). Any Go program that can read JSON and extract tar archives can consume an OCI image without Docker.

Understanding the content-addressable structure is prerequisite for understanding image security. Every blob is identified by its SHA256 digest: if you have the digest, you can verify the blob's integrity by computing the digest yourself and comparing. This is the basis for image signing: a signature is a blob in the OCI store that contains a cryptographic signature over the manifest digest. Tools like `cosign` from Sigstore implement this model. Verifying that the manifest digest in `index.json` matches the pulled manifest, and that the layer digests in the manifest match the pulled layer tarballs, is the integrity check that prevents a MITM from serving a modified image.

First-job habit: use `crane`, `skopeo`, or `oci-image-tool` to inspect OCI image layouts without running them. `crane manifest <image>` prints the manifest JSON. `crane config <image>` prints the config JSON. `skopeo inspect docker://<image>` shows layers and digests. These tools are essential for debugging image pull failures, diagnosing "image is too large" problems (by seeing which layer contains the large files), and verifying image signatures.

Interview framing: "How would you detect if a container image was tampered with after being pushed to a registry?" The answer: compare the manifest digest returned by the registry against the expected digest from the image signing system. If `cosign verify <image>` passes (signature validates against the manifest digest), the image is authentic. If the digest does not match a known-good signed digest, the image was modified after signing.

### Senior @ FAANG: OCI Image Supply Chain Security and Registry Architecture

Supply chain security for OCI images at FAANG requires governance across four stages: build, push, store, and deploy. At build time, images must be built from pinned base image digests (not mutable tags like `ubuntu:latest`) and must include SBOM (Software Bill of Materials) attestations. At push time, the image must be signed with a key from the organization's PKI. At store time, the registry must enforce digest immutability (once a digest is pushed, its content cannot be overwritten). At deploy time, the Kubernetes admission controller must verify the signature and SBOM before allowing the image to run.

The OCI distribution spec (the registry API) is the third OCI specification alongside the image spec and runtime spec. Understanding the distribution spec enables building custom registry middleware: a proxy that adds signature verification on pull, a caching layer that reduces registry traffic by serving blobs from local storage, or an audit logger that records every pull with the requesting pod's identity. Platform teams build registry middleware rather than modifying the runtime because it enforces policy at the one choke point (the pull path) that all workloads pass through.

Image layer optimization is a platform engineering concern at FAANG because image pull time directly affects pod startup time. The largest contribution to pull time is layer transfer, not layer extraction. Platform teams enforce a maximum image size (typically 500 MB compressed) and a maximum layer count (typically 15 layers). The enforcement mechanism is a registry webhook that rejects pushes exceeding the limits, coupled with build tooling guidance (multi-stage builds, distroless base images, `docker build --squash` for single-layer images where appropriate). The result is measurable: reducing average image size from 1 GB to 300 MB at a 10,000-node fleet cuts cold start time from 30 seconds to 8 seconds for cache-miss pod startups.

The content-addressable layer sharing model creates a shared fate risk: if a widely-used base layer (such as the Ubuntu 20.04 base layer used by 80% of images in the organization) has a CVE, every image that includes it is affected simultaneously. The remediation process (rebuild all images with the patched base layer) requires a fleet-wide image rebuild pipeline that can process thousands of images in hours, not weeks. Platform teams maintain this pipeline and measure its throughput as a key security metric: "mean time to patched image" is the indicator that determines how long the organization is exposed to a known CVE in a base layer.

--- where each layer is a gzipped tar archive identified by its SHA-256 digest, and a manifest JSON file lists the layers in stack order. Understanding this layout allows Go tools to pull, inspect, build, and push container images without Docker, just HTTP calls to a registry API and filesystem operations to expand layers. The implementation below parses an OCI image directory, reads the manifest and config, and expands the layer tarballs to construct a root filesystem.

```go
package oci

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
)

// OCIImageLayout represents an OCI image on disk
// Structure:
//   image/
//     oci-layout          - {"imageLayoutVersion": "1.0.0"}
//     index.json          - image index (manifests)
//     blobs/
//       sha256/
//         <hash>          - config JSON or layer tarball

type ImageLayout struct {
	Root string
}

type ImageIndex struct {
	SchemaVersion int             `json:"schemaVersion"`
	Manifests     []ManifestDesc  `json:"manifests"`
}

type ManifestDesc struct {
	MediaType string            `json:"mediaType"`
	Digest    string            `json:"digest"`
	Size      int64             `json:"size"`
	Platform  *Platform         `json:"platform,omitempty"`
	Annotations map[string]string `json:"annotations,omitempty"`
}

type Platform struct {
	OS           string `json:"os"`
	Architecture string `json:"architecture"`
}

type ImageManifest struct {
	SchemaVersion int           `json:"schemaVersion"`
	MediaType     string        `json:"mediaType"`
	Config        ManifestDesc  `json:"config"`
	Layers        []ManifestDesc `json:"layers"`
}

type ImageConfig struct {
	Architecture string       `json:"architecture"`
	OS           string       `json:"os"`
	Config       ContainerConfig `json:"config"`
	RootFS       RootFS       `json:"rootfs"`
}

type ContainerConfig struct {
	User       string            `json:"User"`
	Env        []string          `json:"Env"`
	Cmd        []string          `json:"Cmd"`
	Entrypoint []string          `json:"Entrypoint"`
	WorkingDir string            `json:"WorkingDir"`
	Labels     map[string]string `json:"Labels"`
}

type RootFS struct {
	Type    string   `json:"type"`
	DiffIDs []string `json:"diff_ids"`
}

// Open opens an OCI image layout
func Open(root string) (*ImageLayout, error) {
	// Verify it's a valid OCI layout
	layoutFile := filepath.Join(root, "oci-layout")
	data, err := os.ReadFile(layoutFile)
	if err != nil {
		return nil, fmt.Errorf("not an OCI layout: %w", err)
	}

	var layout struct {
		ImageLayoutVersion string `json:"imageLayoutVersion"`
	}
	if err := json.Unmarshal(data, &layout); err != nil {
		return nil, err
	}

	if layout.ImageLayoutVersion != "1.0.0" {
		return nil, fmt.Errorf("unsupported OCI layout version: %s", layout.ImageLayoutVersion)
	}

	return &ImageLayout{Root: root}, nil
}

// Index returns the image index
func (l *ImageLayout) Index() (*ImageIndex, error) {
	data, err := os.ReadFile(filepath.Join(l.Root, "index.json"))
	if err != nil {
		return nil, err
	}

	var index ImageIndex
	return &index, json.Unmarshal(data, &index)
}

// BlobPath returns the filesystem path to a blob by digest
func (l *ImageLayout) BlobPath(digest string) string {
	// digest format: "sha256:abc123..."
	if len(digest) > 7 && digest[:7] == "sha256:" {
		return filepath.Join(l.Root, "blobs", "sha256", digest[7:])
	}
	return filepath.Join(l.Root, "blobs", digest)
}

// ReadBlob reads a blob by digest
func (l *ImageLayout) ReadBlob(digest string) ([]byte, error) {
	return os.ReadFile(l.BlobPath(digest))
}

// ListLayers returns the layer digests for an image (in order)
func (l *ImageLayout) ListLayers(manifestDigest string) ([]string, error) {
	data, err := l.ReadBlob(manifestDigest)
	if err != nil {
		return nil, err
	}

	var manifest ImageManifest
	if err := json.Unmarshal(data, &manifest); err != nil {
		return nil, err
	}

	layers := make([]string, len(manifest.Layers))
	for i, layer := range manifest.Layers {
		layers[i] = layer.Digest
	}
	return layers, nil
}
```

---
