## 04. How Keyboards Work

### What Happens When You Press a Key

Pressing a single key on a keyboard triggers a chain of events that ends with a byte appearing in your Go program's input buffer. Understanding that chain lets you debug input handling issues, understand terminal behavior, and reason about why raw terminal mode, `bufio`, and `os.Stdin` behave the way they do.

---

### Key Switch Types

#### Membrane Keyboards

A cheap membrane keyboard has three plastic sheets inside. The top and bottom sheets have conductive traces printed on them, arranged in a grid. The middle sheet is a spacer with holes. Under each key is a rubber dome.

When you press a key, the dome collapses, pushing a conductive dot from the top sheet down through the hole in the middle sheet to make contact with the bottom sheet. This closes a circuit at a specific row/column intersection.

The keyboard's microcontroller monitors these intersections. When a circuit closes, it knows which key was pressed.

#### Mechanical Keyboards

A mechanical keyboard replaces the rubber dome with a physical switch mechanism. Inside each switch:

- A spring pushes the slider back up when released.
- A shaped slider pushes a metal contact leaf aside during actuation.
- When the slider passes an inflection point, the leaf snaps back, making contact with a second leaf.
- That snap produces the click sound.

The stem and slider are separate parts. The stem (attached to the keycap) travels a small distance before engaging the slider. Once the slider is engaged, it actuates quickly, giving a tactile bump. This is what makes mechanical keyboards feel different from membrane keyboards: you get a distinct tactile and audible signal at the actuation point.

Switch types vary in actuation force, travel distance, and whether they produce a click. Common families: Cherry MX (and clones), Alps, and Topre.

#### Scissor Switches (Laptop Keyboards)

Laptop keyboards use a scissor mechanism: two intersecting plastic brackets that collapse like scissors when pressed, with a rubber dome providing the return force. This allows a very low profile (2-3mm travel) while maintaining stability across the keycap.

---

### The Keyboard Matrix

A keyboard with 111 keys does not use 111 separate input lines. That would require too many pins on the microcontroller. Instead, the keys are arranged in a matrix: rows and columns of conductors, with each key at an intersection.

An 11-column by 12-row matrix can detect up to 132 keys. The microcontroller:

1. Drives one column at a time high (or cycles through them with brief OFF pulses).
2. Reads all row lines simultaneously.
3. A row that reads high indicates a key at that row/column intersection is pressed.

A full scan of 11 columns takes about 11 × 65 microseconds = about 715 microseconds. The keyboard polls at roughly 4ms intervals. This scanning rate determines the keyboard's polling frequency.

**The debounce problem.** Mechanical contacts do not close cleanly. They bounce: the contact makes and breaks multiple times in the first 1-5 milliseconds after a key press or release. Without debouncing, the microcontroller would detect a single keypress as multiple keypresses.

Solutions:
- **Hardware debounce:** a small capacitor across the contact smooths out bouncing.
- **Software debounce:** the microcontroller ignores rapid state changes within a window (typically 5-20ms after first detection). It only reports a keypress when the state is stable across multiple consecutive scans.

---

### Scancode vs Keycode

The keyboard controller converts the row/column position to a **scancode**, a number specific to that physical key position. Scancodes are defined by the hardware protocol, not by the character on the keycap.

The operating system receives the scancode and maps it to a **keycode**, a platform-specific integer that identifies the logical key. The keycode for the "A" key is the same whether the keyboard layout is QWERTY, Dvorak, or Colemak, because it represents the physical key, not the character it produces.

The OS then applies the **keyboard layout mapping** to translate keycode + modifier state (Shift, Ctrl, Alt, AltGr) into the actual character (Unicode code point). This is why you can switch keyboard layouts in software without changing the hardware.

---

### USB HID Protocol

Modern keyboards connect via USB using the Human Interface Device (HID) class. The keyboard does not stream raw matrix data. Instead:

1. The keyboard's microcontroller assembles a **HID report**: a small packet (typically 8 bytes) containing the current state of modifier keys (Shift, Ctrl, Alt, Meta) and up to 6 currently-pressed regular keycodes.
2. The keyboard sends this report to the host at its polling rate (typically 125Hz for standard keyboards, 1000Hz for gaming keyboards).
3. The USB host controller receives the report and passes it to the HID driver in the OS kernel.

The HID report format for a standard keyboard:

```
Byte 0: Modifier keys bitmask (Ctrl, Shift, Alt, Meta, Right variants)
Byte 1: Reserved (0x00)
Bytes 2-7: Up to 6 simultaneous non-modifier keycodes (6KRO: 6-key rollover)
```

Higher-end keyboards use N-key rollover (NKRO) with a different report format that allows any number of simultaneous keypresses.

---

### From USB Packet to Your Go Program

After the HID report arrives at the kernel:

1. The kernel's HID driver decodes the report and generates input events.
2. On Linux, these events go to the input subsystem (`/dev/input/eventX`).
3. The terminal emulator (or the kernel's TTY layer for a physical terminal) reads input events and performs the layout mapping.
4. The result is a sequence of bytes representing the character, written to the master side of a pseudoterminal (PTY).
5. Your process reads from the slave side via its file descriptor for `stdin` (fd 0).

In Go, reading from standard input:

```go
reader := bufio.NewReader(os.Stdin)
ch, _, err := reader.ReadRune()
```

`os.Stdin` is an `*os.File` wrapping file descriptor 0. `bufio.NewReader` adds a read buffer (default 4096 bytes). `ReadRune` reads one UTF-8 encoded code point from that buffer, refilling from the OS when empty.

In the default (cooked) terminal mode, the kernel line discipline buffers input and only delivers it to your program when the user presses Enter. In raw mode (used by terminal applications like `vim`, `less`, and interactive shells), every keypress is delivered immediately.

---

### Connecting to Go: Raw Mode and Byte Reading

To read individual keypresses in Go without waiting for Enter:

```go
package main

import (
    "fmt"
    "os"

    "golang.org/x/term"
)

func main() {
    oldState, err := term.MakeRaw(int(os.Stdin.Fd()))
    if err != nil {
        panic(err)
    }
    defer term.Restore(int(os.Stdin.Fd()), oldState)

    buf := make([]byte, 1)
    for {
        n, err := os.Stdin.Read(buf)
        if err != nil || n == 0 {
            break
        }
        b := buf[0]
        if b == 3 { // Ctrl-C
            break
        }
        fmt.Printf("Got byte: 0x%02x (%d)\n", b, b)
    }
}
```

`term.MakeRaw` calls `tcsetattr` to disable the kernel's line discipline buffering. Each call to `os.Stdin.Read` then returns as soon as one or more bytes are available from the TTY. The byte you receive is the result of the full pipeline: switch closure, matrix scan, USB HID report, kernel HID driver, TTY layer, layout mapping.

Pressing the "A" key on a QWERTY keyboard in raw mode with no modifiers gives you byte `0x61` (97, ASCII 'a'). Pressing Shift-A gives you `0x41` (65, ASCII 'A'). Pressing an arrow key gives you a three-byte sequence: `0x1b 0x5b 0x41` (ESC [ A), which is an ANSI escape code.

This is why terminal UI code (like the `tcell` library or `charmbracelet/bubbletea`) reads bytes and then interprets multi-byte sequences to distinguish arrow keys from literal ESC followed by '[' followed by 'A'.

---

### Summary of the Full Pipeline

```
Key physical press
  → rubber dome or mechanical switch closes circuit
  → keyboard matrix scan detects row/column
  → debounce filter removes bounce
  → USB HID report assembled (scancode → keycode)
  → USB packet sent at polling interval (1-8ms)
  → kernel HID driver receives report
  → input event generated
  → TTY/terminal applies layout mapping
  → bytes written to PTY master
  → bytes available on PTY slave (your process's stdin)
  → Go Read() call returns bytes
  → bufio / ReadRune / ReadByte decodes to rune or byte
```

End-to-end latency from key press to your program receiving the byte is typically 2-15ms, depending on keyboard polling rate, OS scheduler, and whether your read is blocked or spinning.

**Watch:** [How do Computer Keyboards Work?](https://www.youtube.com/watch?v=h-NM1xSSzHQ)
