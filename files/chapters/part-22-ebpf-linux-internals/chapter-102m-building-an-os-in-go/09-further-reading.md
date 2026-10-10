## 102M.9 Further Reading and References

### The go-dav-os Ecosystem

- **Kernel repository:** [github.com/dmarro89/go-dav-os](https://github.com/dmarro89/go-dav-os)
- **Tutorial project (step-by-step):** [github.com/dmarro89/go-os-tutorial](https://github.com/dmarro89/go-os-tutorial)
- **Author:** Davide Marro, [github.com/dmarro89](https://github.com/dmarro89), [medium.com/@davideraffaele.marro](https://medium.com/@davideraffaele.marro)
- **Discussions:** [github.com/dmarro89/go-dav-os/discussions](https://github.com/dmarro89/go-dav-os/discussions)
- **Issues:** [github.com/dmarro89/go-dav-os/issues](https://github.com/dmarro89/go-dav-os/issues)

### Medium Article Series by Davide Marro

- **Part 1, The Kernel:** [levelup.gitconnected.com/create-an-operating-system-in-go-part-1-af287bfc402a](https://levelup.gitconnected.com/create-an-operating-system-in-go-part-1-af287bfc402a) (tagged `v0.1.0` in go-os-tutorial)
- **Part 2, The Shell:** [levelup.gitconnected.com/create-an-operating-system-in-go-part-2-the-shell-69891e3e0ca1](https://levelup.gitconnected.com/create-an-operating-system-in-go-part-2-the-shell-69891e3e0ca1) (branch `Part-2-Creating-a-Shell` in go-os-tutorial)

This chapter rewrote and extended both articles with additional detail on the toolchain, memory management, filesystems, and ring-3 user-space execution. The articles themselves are shorter and focused specifically on the boot sequence and the keyboard-driven shell. Read them first if you want the author's original framing.

### Classic OS Development References

- **OSDev Wiki:** [wiki.osdev.org](https://wiki.osdev.org/): the encyclopedia of bare-metal x86 development. Reference for every hardware detail mentioned in this chapter.
- **Intel Software Developer's Manual (SDM), Vol. 3:** the canonical reference for x86-64 paging, privilege rings, and syscall mechanics. Free PDF download from Intel.
- **AMD64 Architecture Programmer's Manual, Vol. 2 (System Programming):** the AMD counterpart, often clearer than Intel's SDM on long-mode specifics.
- **Multiboot2 Specification:** [gnu.org/software/grub/manual/multiboot2/multiboot.html](https://www.gnu.org/software/grub/manual/multiboot2/multiboot.html)

### Tutorials and Courses

- **MIT 6.828 / 6.S081, Operating Systems Engineering:** the xv6 operating system + lecture notes. Canonical teaching kernel in C. Several of the data structures in this chapter (page allocator, FS layer) are simpler analogues of xv6 patterns.
- **Writing an OS in Rust** by Philipp Oppermann: [os.phil-opp.com](https://os.phil-opp.com/). The closest analogue to go-dav-os but in Rust. If you decide Go is the wrong language for kernel work, start here.
- **The little book about OS development** by Erik Helin and Adam Renberg: [littleosbook.github.io](https://littleosbook.github.io/). 32-bit x86, C, short and friendly. Good for the boot mechanics.

### Comparable Hobby OSes (for reading source)

- **xv6:** [pdos.csail.mit.edu/6.828](https://pdos.csail.mit.edu/6.828/2024/xv6.html): C, multi-core teaching kernel.
- **Redox OS:** [redox-os.org](https://www.redox-os.org/): Rust, production-aspirant microkernel.
- **MOROS:** [github.com/vinc/moros](https://github.com/vinc/moros): Rust, hobbyist interactive kernel with shell and FS.
- **Theseus OS:** [theseus-os.github.io/Theseus](https://theseus-os.github.io/Theseus/): Rust, research-oriented safe-language OS.

### Tooling References

- **gccgo documentation:** [gcc.gnu.org/onlinedocs/gccgo](https://gcc.gnu.org/onlinedocs/gccgo/). The only Go compiler that supports freestanding output. The flags `-fno-go-runtime`, `-ffreestanding`, `-mno-red-zone`, `-mcmodel=kernel` are the critical ones for kernel work.
- **QEMU:** [www.qemu.org](https://www.qemu.org/). Runs the kernel image without requiring real hardware. `-cdrom`, `-drive`, `-serial stdio` are the flags you will live inside.
- **GRUB:** [gnu.org/software/grub](https://www.gnu.org/software/grub/). Multiboot2-compliant bootloader. `grub-mkrescue` produces bootable ISOs.

### Senior-Track Reading

For engineers who want to push beyond the hobbyist scope:

- **The Linux Kernel Development series by Robert Love:** dated for recent kernels but still the best introduction to real-world kernel design.
- **Understanding the Linux Kernel by Bovet and Cesati:** long, detailed, and worth the investment if you are moving into kernel-adjacent production work.
- **The Design and Implementation of the FreeBSD Operating System:** the deepest OS architecture book in print, and surprisingly readable.
- **Operating Systems: Three Easy Pieces (Remzi Arpaci-Dusseau):** free online at [pages.cs.wisc.edu/~remzi/OSTEP](https://pages.cs.wisc.edu/~remzi/OSTEP/). If you want an OS textbook that is actually fun to read, this is it.

### Cross-References in This Book

- **Chapter 5 (Pointers and Memory):** the Go-level abstractions over what this chapter implements in raw form.
- **Chapter 7 (Go Internals):** scheduler, GC, runtime. Built on top of the kernel mechanisms covered here.
- **Chapter 102K (eBPF with Go):** a much higher-level way to extend the kernel without writing one.
- **Chapter 102L (Container & Linux Internals):** how Linux carves up the kernel abstractions into containers.

### Junior → FAANG: Building a Structured Reading Program from These References

The references in this section form a reading program for kernel internals mastery. The recommended order for a junior engineer with 3-6 months to invest: (1) Read "Operating Systems: Three Easy Pieces" (free online) to build the conceptual model. (2) Follow the go-os-tutorial tagged commits to implement the concepts in Go. (3) Read the relevant chapters of "Understanding the Linux Kernel" when you encounter a Linux-specific topic (scheduling, virtual memory, filesystems). (4) Read Go's runtime source code (`runtime/proc.go`, `runtime/malloc.go`, `runtime/mmap.go`) to connect the OS concepts to Go's implementation.

The Linux kernel documentation at `kernel.org/doc/html/latest/` is underutilized by application engineers. The documentation for the memory management subsystem, the scheduler, and the network stack is written by the engineers who implemented them and contains the kind of implementation detail that no textbook provides. Start with `Documentation/admin-guide/mm/` for memory management and `Documentation/scheduler/` for the CFS scheduler. Reading one documentation file per week for six months covers the most important subsystems.

First-job reading habit: when you encounter a production incident that involves a kernel behavior you do not understand, add it to a reading list with a note about the incident context. After the incident is resolved, spend 30 minutes reading the relevant kernel documentation. This connects abstract kernel knowledge to concrete production experience, which is the fastest path to the kind of expertise that impresses bar-raiser interviewers.

### Senior @ FAANG: Maintaining Kernel Knowledge Currency at Scale

The kernel evolves faster than most application frameworks. Linux has a new release every 8-10 weeks, each with hundreds of changes. Keeping current with kernel changes relevant to your infrastructure requires a curated information diet. The LWN.net weekly newsletter (paid, but worth it) covers the most significant kernel patches with architectural context. The `LKML` (Linux Kernel Mailing List) archives are searchable for specific subsystem discussions. Brendan Gregg's blog and conference talks are the primary source for Linux performance analysis techniques applied to production systems.

The kernel version support matrix is a staff-level infrastructure concern. At FAANG, the kernel team selects a small set of LTS (Long-Term Support) kernel versions (5.10, 5.15, 6.1, 6.6) for fleet deployment. Each LTS version is supported for 6 years, but FAANG fleets typically stay on a version for 2-3 years before migrating. The migration plan must account for: new kernel features to enable (io_uring, eBPF program types, security modules), deprecated features to remove from configuration (legacy iptables replaced by nftables, old cgroup v1 configs), and regression testing across the service portfolio. Owning this migration plan is L6-level systems engineering work.

Kernel security advisories require a specific response process that differs from application CVE response. A kernel CVE may require a kernel upgrade (not just a package update) to remediate, which involves the full kernel deployment pipeline (build, integration test, canary deployment, fleet rollout) rather than a simple `apt upgrade`. Platform teams maintain a documented SLA for kernel security patches: critical CVEs (CVSS 9.0+) are remediated within 72 hours using hotpatch if available (for kernel-live-patching-supported CVEs) or a fast-track kernel upgrade. High severity CVEs are remediated within 7 days. This SLA requires the kernel deployment pipeline to be maintained in a state where it can execute a full fleet rollout in under 48 hours at any time.

---

---
