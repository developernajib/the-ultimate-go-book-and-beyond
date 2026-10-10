## Hypervisor and OS Verification

The most ambitious targets for formal verification are operating systems and hypervisors. The reasons are clear: kernel bugs are catastrophic (privilege escalation, data corruption affecting every process), the code is small relative to applications (tens of thousands of lines), and the threat model is well-defined (untrusted user code on the same machine).

Five projects worth knowing: seL4, CertiKOS, Komodo, Verve, and parts of Hyper-V. Plus the MILS architectural pattern that frames why these efforts matter.

### seL4 recap

Covered in detail in chapter 07. Here, the key facts in operational terms:

- 10000 lines of C, ARM/x86/RISC-V supported.
- Verified down to binary in Isabelle/HOL.
- Open source (GPL-licensed kernel, BSD-licensed userspace tools).
- Used in DARPA HACMS Boeing Unmanned Little Bird, Apple's Secure Enclave (claimed but not officially confirmed), HENSOLDT Cyber TRENTOS for European defense.
- Maintained by Proofcraft and the seL4 Foundation.

### CertiKOS

CertiKOS (Yale, Zhong Shao, 2010s onwards) is a verified concurrent OS kernel in Coq. Where seL4 chose a single-CPU-core kernel and verified that, CertiKOS tackles **concurrency** directly: the kernel runs on multiple cores simultaneously, and the proof addresses interleaved execution.

Key technical contributions:

1. **Compositional verification**. The kernel is decomposed into layers, each layer is verified against a more abstract spec, layers compose.
2. **Concurrent linking**. Modules verified independently combine into a verified whole, even with concurrent execution.
3. **Verified context switching**. The hardest lemma in concurrent OS verification.

CertiKOS was used in the DeepSpec project to demonstrate end-to-end verified system stacks. Less production deployment than seL4, but technically more ambitious in handling concurrency from the start.

### Komodo

Komodo (Microsoft Research, 2017) is a verified enclave for ARM TrustZone. The setup: a trusted secure-world OS that runs **enclaves**, isolated execution environments analogous to Intel SGX enclaves. Komodo verifies:

- Secret-keeping (enclave memory not leaked to the rest of the system).
- Memory protection between enclaves.
- Correct context switching.
- Constant-time secret operations.

Verified in Dafny. Roughly 4500 lines of Komodo, with proofs in Dafny consuming SMT solvers. Demonstrated on a Raspberry Pi 2 with TrustZone. Production transfer was limited but the design influenced subsequent enclave work.

### Verve

Verve (Microsoft Research, 2010) was an earlier verified OS effort, written in Spec# and verifying a small kernel with a verified garbage collector. Predates seL4's binary verification but established many of the architectural patterns. Discontinued as a project but the lessons informed later work.

### Hyper-V verified components

Microsoft Hyper-V is not fully verified. Specific components are:

- **HACL\*** ships in the Hyper-V trusted boot path for cryptographic primitives.
- Some boot-time verification of measured boot sequences.
- The Hyper-V security boundary has received extensive auditing (Bug bounty up to \$250000 for VM escape).

The Hyper-V model is a useful counterpoint to seL4: a production hypervisor at scale (Azure runs on top), with selective verification of hot paths and aggressive auditing of the rest. This mirrors the BoringSSL pattern at OS scale.

### MILS architecture

MILS stands for **Multiple Independent Levels of Security** or **Safety**. It is the architectural pattern that frames why a small verified kernel buys you a lot of assurance.

The idea: separate the system into compartments with strict information-flow policies, run each compartment as a process or VM, let the verified kernel enforce the boundaries. The kernel is the **TCB**. Untrusted compartments can be huge and bug-ridden as long as the TCB enforces isolation.

```
+----------------+   +-----------------+   +--------------+
| Crypto module  |   | Network stack   |   | Display      |
| (verified)     |   | (audited Linux) |   | (untrusted)  |
+----------------+   +-----------------+   +--------------+
            |              |                  |
            +--------------+------------------+
                           |
                +-----------------------+
                | seL4 microkernel      |
                | (formally verified)   |
                +-----------------------+
                           |
                +-----------------------+
                | Hardware              |
                +-----------------------+
```

A MILS system relies on:

- The verified kernel's correctness.
- The hardware's correctness (CPU, MMU, IOMMU).
- The configuration of the kernel's policy.

Bugs in the network stack or display driver cannot affect the crypto module because the kernel does not let them. This is the security claim Boeing's HACMS demonstrated: the red team had access to the network stack, and could not reach the flight control.

### What gets verified vs audited

Realistic stratification for a security-critical system in 2026:

| Layer | Approach | Why |
| --- | --- | --- |
| Microkernel | Full formal verification | Small TCB, catastrophic bug cost, mature tooling |
| Crypto primitives | Full formal verification (HACL\*) | Specifiable, hot path, side channels |
| Boot loader | Verification + auditing | Small, but UEFI complexity makes full proof costly |
| Drivers | Auditing + fuzzing | Diverse, large attack surface, less critical with MILS |
| Userspace | Sanitisers + fuzzing + code review | Volume too large, mitigations work |
| Network protocols (design) | TLA+ at design time | Catches design bugs cheaply |
| Network protocols (impl) | EverParse or hand-audited | Parsers are bug-prone |

The pattern: full proof for the small, hot, critical components, aggressive testing for the volume.

### Practical implications for C++ engineers

If you are writing C++ that runs alongside a verified OS or hypervisor, three implications:

1. **Your C++ code is in the untrusted compartment**. Your bugs cannot escape the compartment's boundary. This is liberating for many bug classes (memory safety inside the compartment is your problem, not the system's) but unforgiving for security-critical bugs (a key leak in your compartment leaks the key, the kernel cannot help).
2. **API boundaries between compartments are the sensitive code**. The IPC layer that marshals messages across the kernel boundary is where parsing and validation happen, and where verification effort should concentrate.
3. **C++ in the trusted compartment is rare**. Most verified microkernel ecosystems use C or Rust for trusted components. C++ is typical for application-level compartments where its libraries and ergonomics are valued and its safety gaps are mitigated by isolation.

### Hardware verification

Verified OS kernels assume the hardware behaves as the ISA says. This assumption has frayed in the last decade:

- Spectre, Meltdown (2018) showed microarchitectural state leaks against the ISA's promised abstraction.
- Rowhammer attacks demonstrate physical-layer effects.
- Supply-chain attacks (compromised firmware) can subvert any software-level verification.

Responses:

- **CHERI** (Cambridge): capability-based hardware that enforces memory safety in hardware. Morello prototype (Arm) demonstrates feasibility on real silicon. Linux and FreeBSD ports exist.
- **Verified processor cores**. Sail (Cambridge) formalizes ARM, RISC-V, x86 ISAs. Verified cores like Kami and Riscv-spec connect ISA to RTL.
- **Verified silicon at small scale** is feasible, at large scale (modern x86) remains research.

For the C++ engineer this is mostly background. The relevant takeaway: verified OS plus verified compiler plus verified application is still bounded above by the hardware's correctness and resistance to side-channel attack.

### Cost in person-years

Public estimates:

- seL4 first version: 25 person-years.
- seL4 binary refinement: roughly 5 additional person-years.
- CertiKOS: comparable scale.
- HACL\* + EverCrypt: tens of person-years across a decade.
- CompCert: roughly 30 person-years over 15 years.

These costs are recoverable in regulated industries (aerospace, defense) where the alternative is recurring certification effort with conventional code. They are not recoverable for typical commercial software.

### When verified kernels become economical

Three scenarios:

1. **High recurring certification cost**. If your product re-certifies annually for DO-178C or IEC 61508, a verified kernel amortises across years.
2. **Catastrophic bug cost**. Pacemakers, infusion pumps, autonomous vehicles. Medical and safety regulators increasingly accept formal verification evidence.
3. **High-value isolation target**. Cryptographic enclaves, cloud isolation between tenants. The cost of a failure (regulatory fines, reputational damage) justifies investment.

For most other C++ work, verified kernels are over-investment. The right move is to use one as a substrate (seL4, an L4 variant, Hyper-V) and build untrusted C++ on top, using the isolation rather than re-verifying everything.

> **Senior at FAANG.** Treat verified kernels as a platform decision, not a project. The decision to build on seL4 or its kin shapes how you design every other component for the next decade. Make the call deliberately, with clear assurance goals, not because formal methods sound impressive in a design doc.
