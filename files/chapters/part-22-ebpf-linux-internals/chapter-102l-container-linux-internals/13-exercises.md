## Exercises

1. **Process Isolation**: Write a Go program that runs `/bin/sh` in new PID, UTS, and MNT namespaces with a custom hostname and verify isolation from the host.

2. **Memory Limit**: Create a cgroup with 256MB memory limit and run a program that allocates memory - verify it gets OOM-killed when exceeding the limit.

3. **Overlay Container**: Build a container using an Ubuntu rootfs image, overlay filesystem, and a simple shell command - track which files were modified in the upper dir.

4. **Network Namespace**: Create a network namespace with a veth pair, assign IPs, and verify connectivity with ping between host and namespace.

5. **Minimal Runtime**: Build a complete minimal container runtime that can run a single command with PID/MNT/NET namespace isolation, cgroup memory limits, and overlay filesystem.

### Junior → FAANG: Exercise Completion Criteria for Genuine Understanding

Each exercise in this chapter has a completion criterion that goes beyond "the program runs." For Process Isolation: verify that `ps aux` inside the new PID namespace shows only the shell process (not the host's full process list), and that `hostname` inside shows the custom hostname, not the host's. For Resource Limits: verify that a process inside the cgroup that allocates more than the limit is OOM-killed by the kernel (observe the OOM kill event in `dmesg`), not just fails to allocate. For Container Networking: verify that the container namespace can `ping` the host and that the host can `ping` the container IP, and that traffic can be captured with `tcpdump` on the host-side veth.

The Minimal Runtime exercise is the capstone and should be attempted last, after completing the others. A runtime is not complete until it passes a test: run a container that writes to its overlay filesystem, verify the write appears in the upper layer, exit the container, and verify the lower layer is unchanged. This test proves that the overlay mount is correct and that isolation is working. Add a Go integration test that runs this sequence automatically: it exercises namespace creation, overlay mount, cgroup setup, and process exec in one test function.

Document your runtime's limitations honestly: what does it not handle that runc handles? Likely: no support for multiple processes in the container, no OCI lifecycle hooks, no rootfs preparation from an OCI image (you probably start from a pre-extracted directory). Understanding your runtime's limitations is as valuable as implementing what works.

### Senior @ FAANG: Exercise Extensions for Platform-Level Engineering

The exercises as written produce tools that demonstrate understanding. At the senior level, each exercise should be extended into a reusable library or service that other engineers could use. The Process Isolation exercise becomes a namespace management library with a typed API, proper error handling for every kernel call, and integration tests that verify isolation properties. The Resource Limits exercise becomes a cgroup management service with a gRPC API for creating, updating, and monitoring cgroups, backed by the cgroup v2 filesystem and emitting metrics to the monitoring system.

The Minimal Runtime exercise at the senior level includes OCI spec compliance: the runtime reads `config.json`, creates the namespaces and mounts specified in the spec, applies the capabilities and seccomp profile, and implements the OCI lifecycle (create, start, kill, delete) with state persistence. Adding OCI compliance makes the runtime usable with containerd via the OCI runtime shim interface, which is the integration point that allows custom runtimes to be used in Kubernetes clusters. Building an OCI-compliant custom runtime that integrates with containerd is a resume-level project that demonstrates deep container platform knowledge.

---

---
