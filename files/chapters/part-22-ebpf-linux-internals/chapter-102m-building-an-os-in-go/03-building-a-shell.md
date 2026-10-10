## 102M.3 Building an Interactive Shell

An OS that only prints a string on boot feels magical for about thirty seconds. Then you want to type something and see the kernel react. This section walks through reading keystrokes from a PS/2 keyboard, mapping scancodes to characters, and building a one-line shell.

Rewritten and expanded from Davide Marro's tutorial **"Create an Operating System in Go, Part 2: The Shell"** ([levelup.gitconnected.com/create-an-operating-system-in-go-part-2-the-shell-69891e3e0ca1](https://levelup.gitconnected.com/create-an-operating-system-in-go-part-2-the-shell-69891e3e0ca1)) with honest annotations and production notes. The complete working code, with substantially more features than this walkthrough, lives in the companion project: **[github.com/dmarro89/go-dav-os](https://github.com/dmarro89/go-dav-os)**. The tutorial's incremental reference project at the `Part-2-Creating-a-Shell` branch is [github.com/dmarro89/go-os-tutorial](https://github.com/dmarro89/go-os-tutorial/tree/Part-2-Creating-a-Shell).

Clone both repositories, `docker run` the toolchain, boot the kernel in QEMU, and read the source alongside this section. Nothing in this chapter will stick without touching the real code.

### Two Ways to Read the Keyboard: Polling vs Interrupts

A production kernel handles the keyboard through **interrupts**: the keyboard controller raises IRQ 1 whenever a key is pressed or released, the CPU stops whatever it was doing, the IDT dispatches to the keyboard handler, the handler reads the scancode, pushes it into a buffer, and the main loop wakes up to process it. This is efficient because the CPU spends its time idle (in `hlt`) when there is no work.

A hobby kernel with no IDT yet handles the keyboard through **polling**: the shell loop sits in a tight `for` loop reading the keyboard status register, and only when the "output buffer full" bit is set does it read the actual scancode. The CPU is constantly busy during polling, which is inefficient, but the code is 20 lines instead of 200, and you can move to the interrupt model once everything else works.

**Start with polling, upgrade to interrupts later.** That is the pattern go-dav-os follows, and it is the right pedagogical order.

### The PS/2 Keyboard Ports

On x86, the PS/2 keyboard controller exposes two I/O ports:

| Port | Purpose |
|------|---------|
| `0x60` | Data register: read scancodes, write commands |
| `0x64` | Status / command register: read controller status, write controller commands |

The status register returns a bitfield. The bit that matters for polling is **bit 0**, the "output buffer full" flag. When bit 0 is 1, there is a scancode waiting in the data register.

### Assembly Helpers: `inb` and `outb`

Go cannot read or write I/O ports directly. There is no I/O port instruction in the Go language. You write the helpers in assembly:

```asm
# keyboard_asm.s (adapted from go-os-tutorial and go-dav-os)
.global github_com_example_kernel_keyboard.inb
.type   github_com_example_kernel_keyboard.inb, @function

github_com_example_kernel_keyboard.inb:
    movw %di, %dx          # port number (arg0) into DX
    xor  %eax, %eax        # clear EAX
    inb  %dx, %al          # read byte from port DX into AL
    ret

.global github_com_example_kernel_keyboard.outb
.type   github_com_example_kernel_keyboard.outb, @function

github_com_example_kernel_keyboard.outb:
    movw %di, %dx          # port number (arg0) into DX
    movb %sil, %al         # value (arg1) into AL
    outb %al, %dx          # write AL to port DX
    ret
```

The symbol name uses `gccgo`'s name mangling convention: `<import_path>.<function>`. You can look at the name mangling go-dav-os uses in its `keyboard/keyboard.s` file.

On the Go side, declare the externs and use them:

```go
package keyboard

// Implemented in keyboard_asm.s.
func inb(port uint16) byte
func outb(port uint16, value byte)

const (
    portData          uint16 = 0x60
    portStatus        uint16 = 0x64
    statusOutputBuffer uint8 = 1 // bit 0 of status = output buffer full
)

func readScancode() byte {
    for {
        if inb(portStatus)&statusOutputBuffer != 0 {
            return inb(portData)
        }
    }
}
```

This function blocks (spin-waits) until the keyboard has data to return. It is correct but wasteful, which is fine for a hobby shell.

### From Scancode to Character

The scancode is not the character you pressed. It is a hardware-level code that identifies a key position on the keyboard. Pressing `A` on a US QWERTY keyboard yields scancode `0x1E`. Pressing `A` on an Italian AZERTY keyboard yields the same `0x1E`, but the rune that key should produce depends on layout.

For a shell, you need a **layout table** mapping scancode to rune. The go-dav-os project ships an Italian layout table because the author is Italian. Adding a US layout table is a one-file contribution, and the project welcomes it.

```go
package keyboard

type Layout map[byte]rune

var LayoutUS = Layout{
    0x02: '1', 0x03: '2', 0x04: '3', 0x05: '4',
    0x06: '5', 0x07: '6', 0x08: '7', 0x09: '8',
    0x0A: '9', 0x0B: '0',
    0x10: 'q', 0x11: 'w', 0x12: 'e', 0x13: 'r',
    0x14: 't', 0x15: 'y', 0x16: 'u', 0x17: 'i',
    0x18: 'o', 0x19: 'p',
    0x1E: 'a', 0x1F: 's', 0x20: 'd', 0x21: 'f',
    0x22: 'g', 0x23: 'h', 0x24: 'j', 0x25: 'k',
    0x26: 'l',
    0x2C: 'z', 0x2D: 'x', 0x2E: 'c', 0x2F: 'v',
    0x30: 'b', 0x31: 'n', 0x32: 'm',
    0x39: ' ',
    0x1C: '\n',
    0x0E: '\b',
}

func ReadKey(layout Layout) rune {
    for {
        sc := readScancode()
        // High bit set means key release. Ignore.
        if sc&0x80 != 0 {
            continue
        }
        if r, ok := layout[sc]; ok && r != 0 {
            return r
        }
    }
}
```

Two subtle points. First, every keypress actually produces two scancodes: one for the press (high bit clear) and one for the release (high bit set, `scancode | 0x80`). You almost always want to ignore releases in a line-editor shell. Second, unmapped scancodes (Shift, Ctrl, arrow keys, function keys) get silently skipped. Handling Shift state and modifier combinations is a few hundred more lines and is the natural next step once the basic shell works.

### A Line Reader

A shell reads until the user presses Enter, with basic backspace handling:

```go
package shell

import (
    "example/kernel/keyboard"
    "example/kernel/terminal"
)

const lineBufSize = 128

func ReadLine() string {
    var buf [lineBufSize]byte
    pos := 0

    for {
        r := keyboard.ReadKey(keyboard.LayoutUS)
        switch r {
        case '\n':
            terminal.WriteString("\n")
            return string(buf[:pos])
        case '\b':
            if pos > 0 {
                pos--
                terminal.Backspace()
            }
        default:
            if pos < lineBufSize-1 && r < 127 {
                buf[pos] = byte(r)
                pos++
                terminal.WriteRune(r)
            }
        }
    }
}
```

The `terminal.Backspace()` helper moves the cursor back one column and writes a space to erase the previous character. `WriteRune` is a single-byte writer (the shell only handles 7-bit ASCII in this minimal form, UTF-8 support is a separate exercise).

### Dispatching Commands

The shell loop reads a line, splits on whitespace, and dispatches:

```go
package shell

import "example/kernel/terminal"

type command struct {
    name string
    help string
    run  func(args []string)
}

var commands = []command{
    {"help",  "List commands",         cmdHelp},
    {"echo",  "Print arguments",       cmdEcho},
    {"clear", "Clear the screen",      cmdClear},
    {"uname", "Print kernel version",  cmdUname},
    // ls, cat, write, rm, fatinit, fatread, fatformat, run ... as implemented in go-dav-os
}

func Run() {
    for {
        terminal.WriteString("kernel> ")
        line := ReadLine()
        args := tokenize(line)
        if len(args) == 0 {
            continue
        }
        dispatch(args)
    }
}

func dispatch(args []string) {
    for _, c := range commands {
        if c.name == args[0] {
            c.run(args[1:])
            return
        }
    }
    terminal.WriteString("unknown command: " + args[0] + "\n")
}
```

The go-dav-os project extends this pattern significantly. Its debug shell supports `ls`, `cat`, `write`, `rm` for the in-memory filesystem, plus `fatformat`, `fatinit`, `fatread` for the FAT16 driver on disk, and even `run hello` to execute a small assembly program in ring 3 through a syscall. Reading that dispatch table is the fastest way to understand what a Go kernel can realistically do.

### Upgrading to Interrupts

Once your shell works with polling, the upgrade path is:

1. **Set up a GDT and IDT.** Global Descriptor Table for segment selectors, Interrupt Descriptor Table for interrupt handlers.
2. **Remap the PIC.** The 8259 PIC by default raises hardware interrupts at vectors 0x08-0x0F, which collide with CPU exceptions. Remap to 0x20-0x2F.
3. **Install an IRQ 1 handler** that reads the scancode and pushes it into a ring buffer.
4. **Send EOI (End of Interrupt)** to the PIC at the end of the handler.
5. **Enable interrupts (`sti`) and replace `ReadKey`** with a read from the ring buffer that sleeps (via `hlt`) when empty.

The go-dav-os project has done all of this. Its `interrupts/` package is a well-organized reference for hobby-kernel interrupt handling. If you want to understand how the IDT is built in Go, the `interrupts/idt.go` file is the canonical example.

**Recommendation:** fork [github.com/dmarro89/go-dav-os](https://github.com/dmarro89/go-dav-os) and rebuild the shell incrementally. Start from the polling version in this chapter, then follow the commit history in the project to see how polling became interrupt-driven, how the PIT got wired in, and how the IDT entries were structured. The commit-by-commit evolution is more valuable than any static tutorial.

### What You Have After This Section

- The kernel reads keyboard input.
- The shell accepts typed commands, handles backspace, and dispatches to named handlers.
- You understand polling, scancode-to-character mapping, and the shape of the line reader.
- You know the upgrade path to interrupt-driven keyboard handling.

Next section: memory management. Without a page frame allocator, every data structure is a fixed-size array in `.bss`. With one, you have real heap allocation and you can build data structures that grow.

### Junior → FAANG: I/O Fundamentals from Hardware to Application

The PS/2 keyboard interrupt handler is the simplest possible example of hardware I/O and interrupt handling. The CPU receives an IRQ (interrupt request) on IRQ1, saves its registers on the kernel stack, and jumps to the interrupt handler registered in the IDT. The handler reads the scancode from port `0x60` (I/O port read via the `in` instruction), translates it to a character, and returns. This sequence, hardware event, interrupt, handler, data read from port, is the same sequence used by every device driver for every input device, from keyboards to NVMe SSDs (which use MSI interrupts rather than legacy IRQs, but the handler registration and invocation pattern is identical).

The shell dispatch loop demonstrates event-driven programming at the kernel level: poll for input, parse a command, dispatch to a handler function. This is the same pattern as a Go HTTP server's request loop, but without any runtime, scheduler, or OS support. Building it at this level makes the abstraction layers in Go's `net/http` package visible: each layer (OS select/epoll, Go runtime's netpoller, net.Listener, http.Server) adds a level of abstraction over the raw hardware interrupt.

Understanding device I/O at this level is increasingly relevant for eBPF work. eBPF programs attached to hardware devices (via XDP for NICs, or via `bpf_prog_type_xdp` for software interfaces) run at a point in the hardware-to-application data path that is analogous to the interrupt handler level in the toy OS. The packet data is raw hardware bytes, the helper functions are the "drivers," and the return codes are the "interrupt return codes." This conceptual bridge makes eBPF network programming more intuitive.

### Senior @ FAANG: Device Driver Architecture and I/O Performance at Scale

The interrupt-driven I/O model demonstrated in the shell section is the foundation for understanding why modern high-performance I/O systems (DPDK, io_uring, RDMA) move away from interrupts. Each interrupt causes a context switch from user mode to kernel mode, a register save, a cache-disturbing handler execution, and a return. For a keyboard (tens of interrupts per second), this cost is negligible. For a 100 Gbps NIC (millions of packets per second), each interrupt costs more CPU time than processing the packet itself.

The solution is polling: DPDK's PMD (Poll Mode Driver) and io_uring's submission/completion ring both eliminate interrupts by having user-space code poll a ring buffer that the hardware fills without interrupting the CPU. The kernel-level equivalent is NAPI (New API) in Linux: the NIC generates one interrupt to signal "data is ready," then the driver disables further interrupts and polls the NIC's receive queue in a loop (the NAPI poll function) until the queue is empty. This is the performance architecture that enables 100 Gbps line-rate networking on commodity hardware.

For staff engineers designing I/O-intensive infrastructure, the interrupt vs. polling tradeoff is a recurring ADR topic. Polling is optimal under high load (always data to process, interrupt coalescing not needed), but wastes CPU when traffic is low (spinning on an empty queue). Adaptive algorithms (interrupt when below threshold, polling when above) are implemented by both Linux's NAPI (via `ethtool -C eth0 adaptive-rx on`) and io_uring (via `IORING_SETUP_SQPOLL`). Understanding these mechanisms requires the hardware-level I/O model that the shell section makes concrete.

---

---
