## Summary

Building an operating system kernel in Go is a niche hobby, not a production path, and this chapter was honest about that from the first page. What it offered instead is a guided tour of every layer between the reset vector and the Go `main` function, using Davide Marro's [go-dav-os](https://github.com/dmarro89/go-dav-os) as a concrete reference you can clone, boot, and read.

Core architectural concepts covered:

- **The boot sequence** (GRUB, Multiboot2, 32-bit entry stub, the jump to 64-bit long mode, paging, VGA text output).
- **Interactive I/O** (PS/2 keyboard polling, scancode-to-rune mapping, a minimal line reader, command dispatch).
- **Memory management** (Multiboot2 memory map parsing, bitmap page frame allocator, 4-level paging, a simple heap).
- **Filesystems** (in-memory FS for simplicity, FAT16 for persistence, ATA PIO for disk access).
- **User space** (GDT layout for ring 3, the `iretq` transition, `syscall`/`sysret`, a minimal dispatcher).
- **The go-dav-os architecture** and what is missing from it (multi-core, networking, a real scheduler, an ELF loader).
- **Interview questions** that use this knowledge to signal seniority in systems-engineering contexts.

The chapter was deliberately longer and more detailed than either the two Medium articles or the go-dav-os README. The articles covered the boot and shell steps. The README describes the current state of the codebase. This chapter connected them with everything between (memory management, filesystems, user-space transitions, pitfalls, architectural trade-offs, and cross-references to classic OS literature).

### One-sentence takeaway

**You probably will not ship a Go kernel, but reading and contributing to one is the fastest way to internalize what is actually happening below every `go build`, and [github.com/dmarro89/go-dav-os](https://github.com/dmarro89/go-dav-os) is the project to start with.**

### What to do next

1. Clone [go-dav-os](https://github.com/dmarro89/go-dav-os), build the Docker toolchain, and boot the ISO in QEMU.
2. Read the source file-by-file alongside Sections 102M.2 through 102M.7 of this chapter.
3. Pick one "what it does not do yet" item from Section 102M.7 and open a PR.
4. Write up what you learned, either as a blog post or as an internal tech talk. Few engineers at any FAANG-equivalent company have built or contributed to a kernel, and that rarity is an asset in interviews and in promotion packets.

### Acknowledgment

This chapter is a derivative extension of Davide Marro's "Create an Operating System in Go" series on Level Up Coding. The companion project [go-os-tutorial](https://github.com/dmarro89/go-os-tutorial) makes the article content concrete with tagged releases per article. Both resources are worth your time, and any improvements you make in the go-dav-os space should be attributed to and coordinated with the project's author and community.

### Junior → FAANG: Consolidating OS Kernel Knowledge into Interview Readiness

The chapter's summary is the kernel of knowledge you carry to interviews. The specific actionable item: for each bullet in the "working mental model" list, be able to give a 60-second explanation that starts with the hardware mechanism, names the Linux kernel data structure or subsystem that implements it, and then connects it to a Go runtime or standard library behavior. The PID namespace bullet connects to `clone(2)` with `CLONE_NEWPID`, the kernel's `pid_namespace` struct, and Go's `exec.Cmd.SysProcAttr.Cloneflags`. The page table bullet connects to the x86-64 4-level hierarchy, the kernel's `mm_struct` and `pgd_t`, and Go's `mmap` calls for heap arenas.

The "niche hobby, not a production path" framing is honest and important. Do not overstate OS kernel development experience in your resume or interview. Do state: "I studied kernel internals by building a toy OS in Go and reading the go-dav-os source code, which gave me a hardware-level mental model that I apply when debugging production Go services and container infrastructure." This framing is accurate, specific, and more impressive than "I wrote an OS" because it connects the hobby to its professional value.

### Senior @ FAANG: OS Kernel Knowledge as a Force Multiplier for Platform Engineering

At the staff level, the mental model built by this chapter is a force multiplier. When your organization's kernel team proposes enabling a new kernel feature (io_uring, eBPF LSM, cgroup v2 full unified hierarchy), your OS internals knowledge allows you to evaluate the proposal's security, performance, and compatibility implications without relying entirely on the kernel team's assessment. You can read the kernel changelogs, identify the edge cases, and ask the right questions in the architecture review.

The mental model also enables better eBPF design. Every eBPF program runs in the kernel context described in this chapter: after the syscall boundary, in the kernel's address space, with access to kernel data structures via CO-RE helpers. Understanding where each eBPF hook point fits in the call chain (before or after the VFS layer for `file_open`, before or after the network stack for XDP) requires the kernel knowledge that this chapter builds. Without it, eBPF programs are written by trial and error. With it, they are designed with a clear understanding of what data is available at each hook point and what the performance implications of each attachment are.

The summary's attribution to Davide Marro's work reflects a broader principle for staff engineers: source your technical knowledge, give credit for reference implementations you study, and build on the work of the open-source community rather than reinventing it. The engineers who build the most impactful platform infrastructure at FAANG are the ones who identify the best existing tools and projects, understand their implementations deeply, adapt them to organizational requirements, and contribute improvements back to the community. This cycle of consume, understand, adapt, contribute is the professional version of the study-and-extend habit that this chapter's exercises encourage.

---

This chapter concludes Part XXII (eBPF & Linux Internals). For additional cross-cutting deep dives, cheat sheets, and question banks, continue to the Appendices.

---

| [◀ Chapter 102L: Container & Linux Internals](../chapter-102l-container-linux-internals/00-introduction.md) | [Chapter 102M: Building an OS in Go](00-introduction.md) | [Appendices: Reference & Cheat Sheets](../../appendices/00-part-intro.md) ▶ |
| :--- | :---: | ---: |
