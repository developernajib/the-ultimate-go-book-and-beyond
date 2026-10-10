## Section 6: CO-RE - Compile Once, Run Everywhere

CO-RE (Compile Once, Run Everywhere) solves the traditional eBPF portability problem where a program compiled against one kernel version would access struct fields at wrong offsets on a different kernel. It works by embedding BTF (BPF Type Format) relocation information in the compiled program. The kernel verifier then fixes up field offsets at load time based on the running kernel's own BTF data. The notes and examples below illustrate the key techniques, `BPF_CORE_READ`, `bpf_core_field_exists`, and `__builtin_preserve_access_index`, that replace direct pointer arithmetic.

```go
package core

// CO-RE allows eBPF programs to adapt to different kernel versions
// using BTF (BPF Type Format) type information.

// Key concepts:
// 1. vmlinux.h - generated from running kernel's BTF info
//    $ bpftool btf dump file /sys/kernel/btf/vmlinux format c > vmlinux.h
//
// 2. BPF_CORE_READ() - reads struct fields safely across kernel versions
//    Instead of: task->mm->exe_file->f_path.dentry->d_name.name
//    Use: BPF_CORE_READ(task, mm, exe_file, f_path.dentry, d_name.name)
//
// 3. bpf_core_field_exists() - check if a field exists at runtime
//    if (bpf_core_field_exists(task->thread_info.flags)) { ... }
//
// 4. Generated Go code includes BTF info automatically via bpf2go

// Loading with CO-RE options
/*
func loadWithCORE() error {
    spec, err := LoadExecveSpec()
    if err != nil {
        return err
    }

    // CO-RE is handled automatically by cilium/ebpf
    // when the eBPF program is compiled with clang -g
    objs := &ExecveObjects{}
    opts := &ebpf.CollectionOptions{
        Programs: ebpf.ProgramOptions{
            // LogLevel for verifier output
            LogLevel: ebpf.LogLevelInstruction,
        },
    }
    return spec.LoadAndAssign(objs, opts)
}
*/

// BTF-aware map access for struct padding differences
/*
// In eBPF C code with CO-RE:
SEC("kprobe/sys_read")
int kprobe_read(struct pt_regs *ctx) {
    struct task_struct *task = (struct task_struct *)bpf_get_current_task();

    // CO-RE: safe read even if struct layout differs between kernel versions
    pid_t pid = BPF_CORE_READ(task, pid);
    pid_t tgid = BPF_CORE_READ(task, tgid);

    // CO-RE: read nested struct member
    char *comm = BPF_CORE_READ(task, comm);

    return 0;
}
*/
```

### Junior → FAANG: Why CO-RE Is Non-Negotiable and How to Use It

The portability problem CO-RE solves is concrete and frequent. The `task_struct` in Linux 5.10 has `pid` at a different offset than in 6.1 because other fields were added or removed between versions. A non-CO-RE eBPF program compiled against 5.10 headers reads the wrong bytes when running on 6.1, producing garbage data without any error. CO-RE with `BPF_CORE_READ` embeds a relocation record that the kernel resolves at load time using the running kernel's BTF, so the same `.o` file reads the correct offset on any kernel version that has BTF metadata.

The first habit to build: never dereference kernel struct fields directly in eBPF C code. Always use `BPF_CORE_READ(task, pid)` instead of `task->pid`. The macro looks identical in the source but generates a BTF relocation record rather than a fixed offset instruction. This is the difference between code that works only on the kernel it was compiled against and code that works fleet-wide.

The `bpf_core_field_exists` macro is the CO-RE tool for handling kernel API changes. When a field was added in kernel 5.15, use `if (bpf_core_field_exists(task->field_added_in_515))` to conditionally access it, falling back to an alternative read on older kernels. Practice this pattern by writing a program that reads `task->__state` on kernels 5.14+ and `task->state` on older kernels, verifying that the conditional compiles and loads correctly on both kernel versions using a VM pair.

Interview framing: "How do you ensure an eBPF program works across kernel versions without recompilation?" The complete answer covers: compile with `clang -target bpf -g` to embed BTF, use `BPF_CORE_READ` for all kernel struct accesses, use `bpf_core_field_exists` for version-conditional logic, and ship the compiled `.o` to a loader that resolves relocations at load time. Candidates who say "compile separately for each kernel version" reveal they have not solved this problem at fleet scale.

### Senior @ FAANG: CO-RE as a Platform Engineering Requirement

CO-RE is not just a portability feature but a deployment architecture constraint that affects the entire eBPF toolchain. At the senior level, the ADR for a CO-RE pipeline must address: where is the BTF metadata for each kernel version stored, how is it distributed to hosts that need it (since not all kernels have BTF embedded via `CONFIG_DEBUG_INFO_BTF=y`), and who owns the BTF extraction process during kernel upgrades.

For kernels without embedded BTF (older 5.x kernels on some distributions), the BTF metadata must be extracted from the kernel's debug info package and distributed as a sidecar file. `bpftool btf dump` can extract BTF from a kernel with debug symbols. Platform teams maintain a BTF repository keyed by kernel version string, distributed via a package repository or object storage, and the eBPF loader daemon fetches the appropriate BTF file at startup if the kernel does not have embedded BTF. This infrastructure must be in place before CO-RE is reliable fleet-wide.

The `bpftool gen min_core_btf` command produces a minimal BTF file containing only the types referenced by a specific eBPF program, dramatically reducing the BTF distribution size from megabytes to kilobytes. Platform teams run this as part of the CI build for each eBPF program and bundle the minimal BTF with the program artifact. This reduces the startup latency of the eBPF loader (no need to parse the full kernel BTF) and the distribution footprint.

CO-RE compatibility testing is the most important CI requirement for eBPF platforms. The test matrix must include the minimum supported kernel version, the current production kernel version, and the next candidate kernel version being evaluated for upgrade. For each kernel, the CI job boots a VM (using `qemu` with KVM or a lightweight VM manager like `firecracker`), loads the eBPF program, runs a functional test that exercises all CO-RE paths including the `bpf_core_field_exists` branches, and verifies correct output. Without this matrix, CO-RE portability is an untested claim rather than a verified guarantee.

Staff-level concern: CO-RE relocations fail silently when the target kernel's BTF does not contain a type that the eBPF program references. The loader returns an error, but the error message (from `cilium/ebpf`) may be cryptic: "failed to find type X in target BTF." Platform teams document a CO-RE compatibility matrix for each eBPF program, listing the minimum kernel version for each feature it accesses, and surface this matrix in the program's metadata so that the loader can proactively reject loading on an incompatible kernel with a clear, actionable error message.

---
