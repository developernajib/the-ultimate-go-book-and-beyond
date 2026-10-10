## 159.15 Sandboxing and Security Model

A browser executes attacker-controlled code from arbitrary websites and parses attacker-controlled data in dozens of formats. The sandboxing model is the assumption that there will always be exploitable bugs in V8, in Skia, in PDFium, in any image decoder, and the architecture must contain a successful exploit so the attacker cannot escalate to user data or persistence. Every privileged resource is separated from the renderer by a process boundary and a tightly-restricted IPC interface.

### The Sandbox Model in One Diagram

```
+--------------------------------------------------+
| Browser process (privileged)                     |
|  - Filesystem, network, OS APIs                  |
|  - Mojo broker                                   |
|  - Holds capabilities, hands narrow ones out     |
+--------------------------------------------------+
            ^                  ^
            | Mojo IPC         | Mojo IPC
            | (validated)      | (validated)
            v                  v
+----------------------+ +----------------------+
| Renderer (sandboxed) | | GPU (semi-sandboxed) |
|  - V8, Blink         | |  - Skia GPU, ANGLE   |
|  - No filesystem     | |  - GPU driver access |
|  - No network        | |  - Limited FS        |
|  - Tiny syscall set  | |                      |
+----------------------+ +----------------------+
```

### Linux: seccomp-bpf

On Linux the renderer sandbox is layered:

1. **Setuid sandbox / namespace sandbox.** Drops the renderer into a new PID namespace, network namespace, mount namespace. Removes filesystem visibility and network capability at the kernel level.
2. **seccomp-bpf.** A BPF program filters syscalls. The renderer's policy whitelists ~60 syscalls (read, write, mmap, futex, clock_gettime, the things glibc and tcmalloc need). Anything else returns EPERM or kills the process.

```cpp
// sandbox/linux/seccomp-bpf-helpers/baseline_policy.cc, conceptually:
ResultExpr BaselinePolicy::EvaluateSyscall(int sysno) const {
  switch (sysno) {
    case __NR_read: case __NR_write:
    case __NR_mmap: case __NR_munmap:
    case __NR_futex:
    case __NR_clock_gettime:
    case __NR_brk:
    case __NR_exit: case __NR_exit_group:
    // ... a few dozen more ...
      return Allow();
    case __NR_open: case __NR_openat:
      return CrashSIGSYS();  // Renderer cannot open files.
    default:
      return CrashSIGSYS();
  }
}
```

If V8 has a JIT bug that lets the attacker call into arbitrary kernel syscalls, the seccomp filter prevents the obvious next steps (open a file, fork a process, ptrace another process). Sandbox escape now requires a kernel bug that is reachable through one of the whitelisted syscalls.

### Windows: AppContainer

On Windows the renderer runs as a low-integrity process inside an AppContainer. AppContainer is the Windows sandboxing primitive that:

- Runs with a restricted token (no privileges, restricted SIDs).
- Can only read/write files explicitly granted via capability SIDs.
- Cannot access most named-pipe / RPC endpoints.
- Cannot inject into other processes.

The renderer uses a Mojo IPC pipe back to the browser for any privileged operation. The browser process has the unrestricted token.

Win32k lockdown blocks the win32k.sys syscalls (which historically have been the most common Windows kernel attack surface). Renderers cannot create windows or call GDI, the browser process draws on their behalf via the compositor.

### macOS: Seatbelt

On macOS the sandbox is a Seatbelt profile (sandbox-exec). The profile denies most of the filesystem (allowing only specific directories), denies network, restricts Mach lookups, and so on. The seatbelt profile is in `sandbox/mac/`.

Helper processes use the SetUID-helper pattern: a privileged process spawns and re-execs the renderer binary inside the sandbox profile. Once inside, the renderer cannot escape the profile even by exec or process injection.

### Android: SELinux + isolated_process

Android renderers run as `isolated_process="true"` services. Each isolated process gets a unique random UID, a tight SELinux domain (`isolated_app`), no networking, and no filesystem access except a private app data dir. This is enforced by the Android framework, not by Chromium itself.

### What the Renderer Still Can Do

The constraint set is:

- Read and write its own anonymous memory.
- Communicate over the Mojo pipes the browser handed it.
- Make a small set of "neutral" syscalls.

What the renderer cannot do without IPC:

- Open files.
- Connect to a TCP/UDP socket.
- Talk to GPU hardware.
- Use the audio device.
- See other processes.

Every web platform API that needs more than memory uses Mojo to ask the browser or another service.

### The Trust Boundary in Mojo

The Mojo interface between renderer and browser is the highest-value attack surface in Chromium. A compromised renderer can send arbitrarily malformed messages on its pipes. The browser's Mojo handlers must:

- Validate every input. Bounds, types, enum ranges, URL formats, origin tags.
- Apply the renderer's origin to every action. A renderer hosting `evil.com` cannot ask the browser to read a cookie for `bank.com`.
- Treat handles received from renderers as untrusted: a file handle the renderer claims is its own may have been forged.

CVE-2022-XXXX-style writeups for Chromium often describe a sequence: renderer compromise via a V8 bug -> send a malformed Mojo message -> browser-side handler trusts a field it should not -> arbitrary file read or arbitrary file write.

### V8 Sandbox

The V8 Sandbox (`v8::Sandbox`) is a defense-in-depth mechanism inside V8 itself. It assumes V8 has memory-safety bugs and constrains the damage:

- All V8 heap pointers are 32-bit offsets into a 4 GB cage.
- A corrupted V8 pointer can only reach addresses inside the cage, not arbitrary memory in the renderer.
- External pointers (to non-V8 memory) go through a sandboxed pointer table indexed by a token, with bounds-checked access.
- Trusted objects (ones whose integrity is required for V8's own correctness, like Code objects and FunctionTemplates) live in a separate "trusted space" outside the sandbox so an attacker cannot forge them.

The V8 Sandbox shipped as a runtime option in 2024 and is being expanded across releases.

### Exploit Mitigations

Beyond the sandbox, Chromium uses every available exploit mitigation:

- **ASLR.** Randomize address layout. Standard.
- **Stack cookies.** Detect stack buffer overflows.
- **CFI (Control Flow Integrity).** Compiler-emitted checks that indirect calls go to valid targets. Implemented via Clang's CFI.
- **Windows CFG (Control Flow Guard).** Windows equivalent.
- **MTE (Memory Tagging Extension).** ARMv8.5 hardware feature where pointer top bits encode a 4-bit tag, checked against the allocation's tag on every access. Catches use-after-free and out-of-bounds. Pixel 8 and later phones run Chrome with MTE in stack mode.
- **PAC (Pointer Authentication).** ARMv8.3 feature: code pointers are signed with a process key, verified before indirect call. Prevents ROP.
- **Stack scanning suppression.** Hardens GC stack scans against object forgery.
- **ScopedAllowBlocking** and similar runtime checks catch policy violations in debug.

### Site Isolation as a Defense-in-Depth

Site Isolation (covered in the multi-process architecture section) addresses a different threat model: Spectre-class side channels that read memory across origins within a single process. By running each origin in its own renderer, an attacker cannot mount a Spectre attack against another origin's memory because that memory is not in the address space.

Site Isolation also mitigates renderer compromises: even if `evil.com`'s renderer is fully owned, it cannot read `bank.com`'s memory because they are different processes.

### The Broker Pattern

Some operations are too platform-specific or too privilege-requiring to expose through general Mojo interfaces. Instead, Chromium uses a broker process or a broker thread in the browser. Examples:

- Sandboxed file dialog: renderer asks for a file picker, browser shows the dialog, returns a file handle. The renderer cannot enumerate files itself.
- DRM Content Decryption Module: runs in its own utility process with a tighter sandbox than the renderer.
- Sandboxed font loading on Windows: the renderer cannot read font files, a broker reads them and returns parsed glyph data.

### Vulnerability Lifecycle

Chromium's security team runs an aggressive bug bounty (highest payouts in the industry). Reported vulnerabilities are triaged, fixed, and shipped, often within days. The metric tracked publicly is "patch-gap": the time between a fix landing in the source tree and Chrome stable shipping it. Modern process targets a patch-gap measured in single-digit days.

### Senior Interview Material

- "Why does Chromium use multi-process sandboxing instead of a single-process model with capabilities?"
- "Walk through a renderer compromise to user-data exfiltration. Where does the architecture stop the chain?"
- "What is the V8 Sandbox, and what threat does it model?"
- "Compare seccomp-bpf and AppContainer. What does each protect against?"
- "Why is the GPU process not as tightly sandboxed as the renderer?"

The next section moves to extension architecture, which has its own sandboxing story.

---
