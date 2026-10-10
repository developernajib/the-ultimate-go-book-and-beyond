## Summary

eBPF transforms Go observability tooling by enabling kernel-level instrumentation:

- **eBPF programs** run sandboxed in the kernel - verified for safety, JIT-compiled for performance
- **cilium/ebpf** provides idiomatic Go bindings for loading programs, managing maps, and reading events
- **Kprobes** attach to arbitrary kernel functions. **tracepoints** provide stable, versioned hooks
- **XDP** enables line-rate packet processing directly in the NIC driver - ideal for DDoS mitigation and filtering
- **Ring buffers** provide efficient, ordered, low-overhead event delivery from kernel to userspace
- **CO-RE** with BTF makes programs portable across kernel versions without recompilation
- **Per-CPU maps** eliminate contention on hot paths - aggregate in userspace when reading
- Security monitoring with eBPF is non-intrusive and can detect syscall abuse without ptrace overhead

### Junior → FAANG: Consolidating the Chapter into Interview-Ready Knowledge

The summary bullets represent the knowledge map for this chapter. Before moving to the next chapter, verify that you can explain each bullet point from memory without looking at the text, and that you have written at least one working eBPF program that demonstrates the concept. "eBPF programs run in the kernel, are verified for safety" is passive knowledge. "I wrote a kprobe that tracks TCP send latency and verified it loads on kernel 5.15 and 6.1" is active knowledge that you can demonstrate in an interview.

The most interview-relevant takeaway from this chapter is the full eBPF development workflow: write C, compile with clang to BPF target with debug info, generate Go bindings with bpf2go, load and attach from Go, read data via maps or ring buffer, test with `prog.Test()` for XDP and with controlled subprocesses for tracing programs. Being able to walk through this workflow fluently, with the correct terminology at each step, is the signal that distinguishes candidates who have done this work from candidates who have read about it.

### Senior @ FAANG: Chapter Summary as a Platform Engineering Foundation

This chapter covers the primitives from which a production eBPF platform is built. At the senior level, the summary items are not endpoints but starting points for harder questions. CO-RE is a starting point for "how do you maintain BTF metadata for kernels that ship without it?" Per-CPU maps are a starting point for "how do you implement consistent snapshot reads of per-CPU state when the values are being concurrently updated by the kernel?" Security monitoring with LSM hooks is a starting point for "how do you test that your LSM policy does not inadvertently deny operations that your organization's security baseline requires to be allowed?"

The organizational question that this chapter raises is: who owns the eBPF platform in your company? At FAANG, this is typically a kernel or systems team that owns the loader daemon, the CI pipeline, the BTF repository, and the schema registry, while product teams own the specific programs they deploy through the platform's API. Designing this ownership boundary cleanly, with a stable platform API that isolates product teams from kernel-level details, is the L6-level systems design challenge that this chapter's material directly enables.

---

| [◀ Chapter 166: Blockchain, Cryptography, and Crypto-Trading Systems in C++](../../part-21d-cpp-production/chapter-166-blockchain-crypto-cpp/00-introduction.md) | [Chapter 102K: eBPF with Go](00-introduction.md) | [Chapter 102L: Container & Linux Internals](../chapter-102l-container-linux-internals/00-introduction.md) ▶ |
| :--- | :---: | ---: |
