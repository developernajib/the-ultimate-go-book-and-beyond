## Common Mistakes

| Mistake | Problem | Fix |
|---------|---------|-----|
| Not removing memlock limit | EPERM on map creation | Always call `rlimit.RemoveMemlock()` first |
| Using `bpf_probe_read` instead of `BPF_CORE_READ` | Breaks on different kernel versions | Use CO-RE macros for portability |
| Reading userspace memory with `bpf_probe_read_kernel` | Segfault in kernel | Use `bpf_probe_read_user` for userspace addresses |
| Ring buffer too small | Events dropped | Size at least 16MB for busy systems |
| Not calling `Close()` on links | Kernel programs persist after process exit | Always `defer link.Close()` |
| Per-CPU map without aggregation | Reads partial data | Sum all CPU values when reading per-CPU maps |
| Stack overflow in eBPF | Verifier rejection | Stack limit 512 bytes - use maps for large data |
| Missing GPL license | Cannot use GPL-only helpers | Add `char LICENSE[] SEC("license") = "GPL"` |

### Junior → FAANG: Learning from eBPF Mistakes Before They Reach Production

The most instructive way to learn eBPF is to intentionally trigger each common mistake in a development environment and read the resulting error message until it becomes recognizable. The verifier error for a missing NULL check on a map value reads something like: "invalid mem access 'map_value_or_null'" with an instruction index pointing to the dereference. After seeing this error three times in a development VM, you stop making the mistake in production.

The GPL license requirement is a frequently missed detail that causes confusing load failures. Many powerful eBPF helpers (including `bpf_probe_read_kernel`, `bpf_get_stackid`, and several networking helpers) are GPL-only and require the eBPF program to declare GPL licensing. The declaration is a single C string in the BPF object file: `char LICENSE[] SEC("license") = "GPL"`. Without it, the kernel refuses to grant access to GPL-only helpers with the error "cannot call GPL-only function from non-GPL compatible program." Checking for this before spending time debugging other potential causes is the first-job diagnostic habit.

The per-CPU map aggregation mistake is subtle because the program loads and runs correctly, but the values read from Go are wrong (typically much lower than expected because only one CPU's accumulator is returned). The fix is always to iterate over all CPU values when reading a per-CPU map and sum them. In `cilium/ebpf`, `Map.Lookup` on a per-CPU map returns a slice with one element per CPU: `var values []uint64; objs.MyMap.Lookup(key, &values); total := sum(values)`. Write a test that spawns concurrent goroutines to trigger the counted event and verifies the total count is correct: this test will catch the aggregation mistake.

Interview framing: "What eBPF mistake caused your most memorable debugging session?" A strong answer describes a specific mistake (per-CPU aggregation, missing GPL, or a verifier rejection due to a missing bounds check), explains the root cause, and describes the systematic debugging process (reading verifier logs, using `bpftool prog dump xlated` to inspect the JIT output, or adding a test harness). This shows interview-level debugging maturity.

### Senior @ FAANG: Systematic Prevention of eBPF Production Mistakes

The common mistakes table represents failure modes that a mature eBPF platform prevents through tooling rather than discipline. At the senior level, the job is to build the guardrails so that junior engineers cannot easily make these mistakes in production, not just to know what the mistakes are.

The verifier rejection class of mistakes (missing NULL checks, stack overflows, unbounded loops) is prevented by making the CI pipeline run `clang` with the BPF target and then attempting to load the resulting `.o` file against a real kernel in a VM. A program that fails to load in CI cannot be merged. This requires maintaining at least one CI kernel per supported kernel generation (5.10, 5.15, 6.1, 6.6), which adds infrastructure cost but eliminates the entire class of "verifier rejects in production" incidents.

The per-CPU aggregation mistake is prevented by code generation: the `bpf2go` generated map accessors should include a typed aggregation helper that sums across CPUs automatically. Platform teams extend the generated code with a custom template that adds this helper, eliminating the raw `Lookup` call and its aggregation boilerplate from all consumer code. This is the kind of platform leverage that an L6 engineer provides: one change that improves every team's code quality.

The GPL license and kernel version compatibility mistakes are caught by a pre-load linting step in the platform's eBPF loader. The loader inspects the ELF sections of each `.o` file before attempting to load it: if the license section is absent and the program uses any helper that requires GPL, the loader rejects it with a clear error. If the program's BTF records reference a kernel version above the node's running kernel, the loader rejects it. These checks are fast (microseconds, no kernel involvement) and prevent the confusing runtime failures from occurring.

The most serious production mistake class is not in the common mistakes table: using eBPF for logic that belongs in user space. eBPF programs are hard to debug, have limited helper sets, and are constrained by the verifier. When an engineer proposes implementing business logic in an eBPF program (complex stateful processing, string manipulation, or anything requiring heap allocation), the senior response is to redesign the architecture: the eBPF program collects and emits raw events. The user-space Go process performs the complex processing. This boundary, collect in kernel, process in user space, is the guiding principle that prevents eBPF programs from becoming unmaintainable.

---
