## 102M.2 Booting a Go Kernel

This section walks through the boot sequence for a Go kernel: GRUB finds your image, validates a Multiboot2 header, hands control to a 32-bit assembly entry stub, the stub switches to 64-bit long mode, and finally the CPU is running Go code. Rewritten and expanded from Davide Marro's tutorial **"Create an Operating System in Go, Part 1"** ([levelup.gitconnected.com/create-an-operating-system-in-go-part-1-af287bfc402a](https://levelup.gitconnected.com/create-an-operating-system-in-go-part-1-af287bfc402a)) with additional toolchain detail, honest annotations for 2026 Go tooling, and cross-references to the working kernel at [github.com/dmarro89/go-dav-os](https://github.com/dmarro89/go-dav-os). The tutorial's companion step-by-step reference project is [github.com/dmarro89/go-os-tutorial](https://github.com/dmarro89/go-os-tutorial), tagged at `v0.1.0` for the content in this section.

**Recommended:** clone both repositories before reading further. Boot the go-dav-os ISO in QEMU once to see what the end state looks like, then follow the tutorial code tag by tag.

### Why GRUB and Multiboot2

Writing your own bootloader is a separate hobby project. Most kernel tutorials delegate boot to **GRUB**, the standard Linux bootloader, using the **Multiboot2** specification. Multiboot2 is the contract: your kernel image includes a header in a specific format, GRUB parses the header, sets up a minimum environment, and jumps to your entry point with a known CPU state and a known set of information (memory map, command-line arguments, ELF section layout).

The alternative, writing a bootloader, means dealing with BIOS or UEFI directly, which is enough work to be its own book. Multiboot2 is the pragmatic choice for hobby kernels.

GRUB scans the first 32 KiB of your kernel image for a valid Multiboot2 header. If the header is missing or malformed, GRUB refuses to boot the image.

### The Multiboot2 Header

The header is four 32-bit words plus an optional list of tags. All bytes are little-endian. The first four words are:

| Field | Value | Meaning |
|-------|-------|---------|
| Magic | `0xE85250D6` | Multiboot2 magic number |
| Architecture | `0` | 32-bit i386 protected mode (even if your kernel is 64-bit) |
| Header length | computed | Total size of the header block |
| Checksum | computed | Value that makes the sum of all four words equal zero |

The architecture field is `0` because Multiboot2 always hands control to your kernel in 32-bit protected mode. You switch to 64-bit long mode yourself, later.

In x86 assembly:

```asm
; boot.s
.section .multiboot2
.align 8

multiboot_header_start:
    .long 0xE85250D6                                  # magic
    .long 0                                           # architecture (i386)
    .long multiboot_header_end - multiboot_header_start  # header length
    .long -(0xE85250D6 + 0 + (multiboot_header_end - multiboot_header_start))  # checksum

    # Information Request tag (type 1).
    # Ask GRUB for the memory map (6) and ELF sections (9).
    .align 8
    .word 1                     # tag type
    .word 0                     # flags
    .long 16                    # tag size
    .long 6                     # request: memory map
    .long 9                     # request: ELF sections

    # Entry Address tag (type 3). Tell GRUB where to jump after loading.
    .align 8
    .word 3
    .word 0
    .long 16
    .long _start                # entry point
    .long 0

    # End tag (type 0).
    .align 8
    .word 0
    .word 0
    .long 8
multiboot_header_end:
```

Two things are worth internalizing. First, every Multiboot2 tag is 8-byte aligned. If you forget `.align 8`, GRUB silently rejects your image. Second, the checksum is computed at assembly time using the header length, so if you add or remove tags, the checksum expression updates automatically.

### The 32-Bit Entry Stub

When GRUB transfers control to `_start`, the CPU is in 32-bit protected mode with paging disabled. You have no stack, no IDT, no GDT of your own, no long mode, and no Go runtime. Your job is to get enough of that set up that you can hand control to Go code.

```asm
.section .text
.global _start
.type _start, @function

_start:
    cli                         # disable interrupts, no IDT yet
    mov $stack_top, %esp        # set up a 16 KB bootstrap stack

    # GRUB passes the Multiboot info pointer in EBX. Save it.
    movl %ebx, multiboot_info_ptr

    call setup_long_mode        # build paging structures, switch to 64-bit
    cli

.Lhang:
    jmp .Lhang                  # should be unreachable; loop just in case
    .size _start, . - _start

.section .bootstrap_stack, "aw", @nobits
.align 16
stack_bottom:
    .skip 16384                 # 16 KB bootstrap stack
stack_top:

.section .bss
.global multiboot_info_ptr
multiboot_info_ptr: .long 0
```

The `.bootstrap_stack` section with the `@nobits` attribute tells the linker to reserve 16 KB in memory without writing zeros into the image. The stack grows downward from `stack_top`.

### Switching to 64-Bit Long Mode

The CPU transition from 32-bit protected mode to 64-bit long mode requires four things, in order:

1. **Build 4-level paging tables.** At minimum: a PML4 entry pointing to a PDPT, a PDPT entry pointing to a PD, and a few PD entries with the "2 MB huge page" flag set to identity-map the first few megabytes of physical memory.
2. **Load the PML4 physical address into CR3.**
3. **Enable PAE (bit 5 of CR4) and the Long Mode Enable bit (bit 8 of EFER MSR).**
4. **Enable paging (bit 31 of CR0), which latches the mode switch.**

After the `mov cr0` that sets PG, the CPU is in 64-bit long mode but still executing from a 32-bit code segment. A far jump to a 64-bit code segment in your GDT completes the mode switch.

The full `setup_long_mode` assembly is around 60 lines. Treat it as a recipe you copy once, understand once, and then leave alone.

### Jumping Into Go Code

After the mode switch, you are executing 64-bit code with paging on and a known stack. The final assembly step is a `call` to the Go entry point:

```asm
    # 64-bit code segment, paging enabled, ready for Go.
    call kernel_main
    cli
.Lhang64:
    hlt
    jmp .Lhang64
```

In the Go side, define the entry point with the `//go:linkname` and `//export` machinery that `gccgo` provides:

```go
// kernel.go
package kernel

import "unsafe"

//export kernel_main
func Main() {
    // At this point: 64-bit long mode, paging on, ~16KB stack.
    // No goroutines, no GC, no fmt.
    Terminal.Init()
    Terminal.WriteString("kernel booted\n")

    for {
        // hlt in a loop - real kernels install interrupts here.
    }
}
```

### The `gccgo` Toolchain

The official `go` toolchain does not support bare-metal targets. You need `gccgo` (the GCC front-end for Go) with freestanding flags. A production-grade build recipe lives in a Makefile, but the shape is:

```
gccgo -c -fno-go-runtime -ffreestanding -fno-stack-protector \
      -static-libgo -mno-red-zone -mcmodel=kernel \
      -o kernel.o kernel.go

ld -n -T link.ld -o kernel.elf boot.o long_mode.o kernel.o

grub-mkrescue -o kernel.iso iso/
```

- `-fno-go-runtime` disables linking the Go runtime.
- `-ffreestanding` tells GCC you are not running on a hosted environment.
- `-mno-red-zone` disables the x86-64 red zone (128 bytes below rsp that interrupt handlers are not allowed to clobber, which matters for kernels that handle interrupts on the same stack).
- `-mcmodel=kernel` tells the linker the kernel lives in the upper half of the virtual address space.

In practice, the go-dav-os project ships a Docker-based toolchain because getting `gccgo` + binutils + GRUB + `grub-mkrescue` versions aligned on a laptop is painful. The published `Dockerfile` is the fastest path to a working build.

### VGA Text Output: Your First `printf`

Before you have a keyboard, a disk, or interrupts, you want visual feedback that the kernel is alive. The classic approach is the VGA text buffer at physical address `0xB8000`, a 80x25 grid of 16-bit cells where each cell is `(character, attribute)`.

```go
package terminal

import "unsafe"

type cell struct {
    Char uint8
    Attr uint8
}

const (
    width  = 80
    height = 25
    vga    = 0xB8000
)

var buffer = (*[height * width]cell)(unsafe.Pointer(uintptr(vga)))

var (
    cursorRow = 0
    cursorCol = 0
    color     = uint8(0x07) // light grey on black
)

func Init() {
    for i := 0; i < width*height; i++ {
        buffer[i] = cell{' ', color}
    }
    cursorRow, cursorCol = 0, 0
}

func writeByte(b byte) {
    switch b {
    case '\n':
        cursorCol = 0
        cursorRow++
    default:
        buffer[cursorRow*width+cursorCol] = cell{b, color}
        cursorCol++
        if cursorCol >= width {
            cursorCol = 0
            cursorRow++
        }
    }
    if cursorRow >= height {
        scroll()
    }
}

func WriteString(s string) {
    for i := 0; i < len(s); i++ {
        writeByte(s[i])
    }
}

func scroll() {
    for row := 1; row < height; row++ {
        copy(buffer[(row-1)*width:row*width], buffer[row*width:(row+1)*width])
    }
    for col := 0; col < width; col++ {
        buffer[(height-1)*width+col] = cell{' ', color}
    }
    cursorRow = height - 1
}
```

This is the first Go code running on bare metal. It uses `unsafe.Pointer` to map a physical address to a Go array, reads and writes the VGA cells, handles newline and scroll, and does not require any runtime support (no GC, no goroutines, no standard library). The `copy` built-in compiles to a simple `memcpy`-style loop.

### What You Have After This Section

- GRUB boots your ISO image.
- The Multiboot2 header passes validation.
- The 32-bit entry stub sets up a stack, saves the Multiboot info pointer, and switches to 64-bit long mode.
- Go code runs in a freestanding environment and can write to the VGA text buffer.
- You can print `kernel booted` on a QEMU screen.

That is a meaningful milestone. The next section adds a keyboard and a shell so the kernel becomes interactive.

### Junior → FAANG: What the Boot Sequence Teaches About Systems Fundamentals

The boot sequence is the most concrete demonstration of the CPU's initialization state. When the CPU resets, it starts in real mode (16-bit, 1 MB address space, no memory protection), and the bootloader must walk it through protected mode (32-bit, memory segmentation) to long mode (64-bit, paging) before modern code can run. This progression is why legacy BIOS systems are limited to 640 KB of usable RAM for real-mode code, and why UEFI (which starts in 32-bit protected mode) became necessary for booting from large disks and loading large OS images.

The Multiboot2 header is the contract between GRUB and the kernel. The header declares the kernel's physical load address, the entry point offset, and any requested boot services (framebuffer configuration, memory map format). GRUB validates the header by scanning the first 8 KB of the kernel image for the magic number `0xE85250D6`. Understanding this contract demystifies why boot failures produce "invalid magic number" or "unsupported features" errors: GRUB is validating the header fields before handing control to the kernel.

The GDT (Global Descriptor Table) setup required before long mode is the historical artifact that modern OS code tries to minimize. In long mode, segmentation is mostly bypassed (all segment descriptors cover the full 64-bit address space), but the GDT must still be present and valid. Setting up the minimal GDT (null descriptor, code descriptor, data descriptor) and loading it with the `lgdt` instruction is the last required step before `jmp` to 64-bit code. This is the moment the assembly stub hands control to Go, and it is the moment where understanding the CPU's execution model becomes concrete.

Interview framing: "What happens between pressing the power button and a Go program's `main()` being called?" The answer traces: BIOS/UEFI POST and device enumeration, bootloader (GRUB/UEFI application), kernel image load and ELF entry point execution, architecture-specific initialization (GDT, IDT, paging), Go runtime initialization (`runtime.rt0_amd64` and `runtime.schedinit`), then `main.main`. Candidates who know the Go runtime initialization sequence (`schedinit` schedules the first goroutine and starts the GC) are demonstrating kernel-plus-runtime depth.

### Senior @ FAANG: Boot Sequence Knowledge Applied to Production Infrastructure

The boot sequence matters for FAANG production infrastructure in concrete ways. Secure Boot (UEFI Secure Boot with TPM attestation) is a requirement for many FAANG compute fleets: the bootloader, kernel, and initramfs must all be signed by a trusted key, and the TPM records a cryptographic measurement of each boot stage in the PCR registers. A staff engineer who understands the boot sequence can participate in the design of the attestation system: what measurements go into which PCR, how the remote attestation service verifies the boot chain, and what happens when a node's kernel is upgraded (the PCR values change, requiring re-attestation).

Measured boot and remote attestation are becoming infrastructure requirements for confidential computing (TEE-based workloads using AMD SEV-SNP or Intel TDX). In these environments, the guest VM's boot sequence is measured by the hypervisor's security processor, and the guest must prove its identity to a remote attestation service before receiving decryption keys for its workload data. The boot sequence knowledge from this chapter, specifically which code runs in what mode before the OS kernel takes control, is the foundation for understanding what the attestation service is actually measuring.

Kernel boot parameters (the `cmdline` passed by GRUB to the kernel) are a production configuration surface that staff engineers own. Parameters like `nosmt` (disable hyper-threading for Spectre mitigation), `mitigations=off` (disable Spectre/Meltdown mitigations for performance, accepted only for isolated workloads), `transparent_hugepages=never` (disable THP to avoid latency spikes from promotion operations), and `isolcpus=<cpu-list>` (reserve CPUs for DPDK or real-time workloads) are set in the kernel command line and require understanding the boot process to change correctly. ADRs for kernel parameter changes include benchmark data showing the performance impact and security review for any mitigation-disabling parameters.

---

---
