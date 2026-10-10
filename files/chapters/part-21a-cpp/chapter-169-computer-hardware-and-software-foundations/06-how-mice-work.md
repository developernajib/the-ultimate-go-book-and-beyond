## 06. How Mice Work

A computer mouse is a deceptively complex piece of hardware. Moving it a few centimeters triggers
a chain of events that spans optics, digital signal processing, USB protocols, kernel drivers, and
display servers, all within a millisecond. Understanding that chain is good grounding for any
engineer working close to hardware or writing systems code.

### The Ball Mouse (Historical Context)

Before optical sensors, mice used a rubber ball. Rolling the ball against a surface turned two
perpendicular rollers. Each roller was connected to an encoder wheel, a disc with slots around
the rim. An LED and photodetector pair sat on each side of the wheel. As the wheel turned, the
slots interrupted the light beam, producing pulses. Counting pulses gave horizontal and vertical
displacement.

Ball mice had obvious problems. Dirt accumulated on the ball and rollers, causing the reading to
drift or stick. Cleaning was a routine task for 1990s office workers. The ball also had weight
and inertia, limiting how fast the encoder could respond. By the late 1990s, optical sensors were
cheap enough to replace the mechanical system entirely.

### The Optical Sensor

A modern optical mouse has no moving parts except its buttons and scroll wheel. At the bottom sits
an Image Acquisition System (IAS) composed of three components: an illumination source (IR LED or
laser), a lens pair, and a CMOS image pixel array.

The LED illuminates the surface at a shallow angle, almost parallel to the desk. This grazing
illumination turns the microscopic texture of the surface into a pattern of highlights and
shadows, similar to how a low-angle sunset makes grass blades cast long shadows. The mouse is not
capturing the color of the mouse pad. It is capturing the surface's topography as a height map.

The reflected light passes through a second lens and a small aperture, then hits the image sensor.
A typical sensor is 40x40 pixels, sampling an area roughly 1.2mm x 1.2mm. That is a tiny window,
about 1/200th the area of a penny. The small window does not matter because the sensor takes up to
17,000 frames per second. In one tenth of a second of mouse movement, the sensor captures around
1,700 frames.

### Motion Detection: Cross-Correlation

Each pixel in the sensor outputs a value from 0 to 4095 representing light intensity. The sensor
does not store these frames. Instead, the on-chip Digital Signal Processor (DSP) compares each
new frame against the previous one using an algorithm called cross-correlation.

Cross-correlation works by sliding one image over another and finding the offset where the two
images best overlap, meaning where their pixel-by-pixel difference is smallest. If the minimum
difference occurs when the new frame is shifted 3 pixels right and 1 pixel down relative to the
old frame, then the mouse moved right and slightly down between those two captures.

The DSP runs this algorithm 17 times per millisecond, accumulating the dx/dy values. After one
millisecond it sums all 17 measurements, producing a cumulative displacement vector for that
millisecond. This is what gets sent to the host computer.

### DPI: Dots Per Inch

DPI measures how many cursor units the OS receives for each inch of physical mouse movement. A
sensor with 40x40 pixels over a 1.2mm area has a native resolution of roughly 850 DPI. Moving
the mouse one inch produces about 850 position units.

To reach higher DPI values, the sensor uses interpolation. The DSP subdivides each physical pixel
into subpixels using bilinear or bicubic interpolation. Bilinear interpolation draws straight
lines between neighboring pixel values and reads off intermediate values at sub-pixel positions.
Bicubic uses polynomial curves, producing smoother estimates.

If each pixel is divided into a 5x5 grid of subpixels, the effective resolution jumps from 850
to roughly 4,250 DPI. At 30 subdivisions per pixel, you reach around 25,500 DPI. When you change
DPI in your mouse's software, you are changing the subdivision count in this interpolation step.

For practical use:
- **800-1600 DPI**: Most office and general use. Cursor travels a moderate distance per inch.
- **3200-6400 DPI**: Common for FPS gaming on large monitors. Small hand movements produce large cursor movements.
- **12000+ DPI**: Niche. At very high DPI on a 1080p monitor, a single pixel of cursor movement maps to sub-millimeter hand motion, which most users find unusable without scaling.

Higher DPI is not always better. It amplifies sensor noise and hand tremor. Many competitive
gamers run medium DPI and compensate with sensitivity settings in the game.

### Polling Rate: How Often the Mouse Reports

The polling rate determines how frequently the mouse sends a report to the host system.

| Rate | Interval | Typical Use |
|---------|----------|-------------------|
| 125 Hz | 8ms | Budget mice |
| 500 Hz | 2ms | Mid-range |
| 1000 Hz | 1ms | Gaming standard |
| 8000 Hz | 0.125ms | High-end gaming |

At 125 Hz, the mouse reports every 8ms. If you make a fast flick in 20ms, you get only two or
three position updates. At 1000 Hz, you get 20 updates for the same movement. The cursor path is
smoother and input latency is lower.

The sensor itself may run at 17,000 frames per second internally, but the USB reports are batched
by the SoC (System on a Chip) on the mouse's PCB and sent at the polling rate.

### USB HID Protocol

USB mice enumerate as Human Interface Devices (HID). The mouse describes its report format in a
HID descriptor. A basic mouse report is 4 bytes:

```
Byte 0: Button state (bit 0 = left, bit 1 = right, bit 2 = middle, etc.)
Byte 1: X displacement (signed int8, range -127 to 127)
Byte 2: Y displacement (signed int8, range -127 to 127)
Byte 3: Scroll wheel delta (signed int8)
```

The host's USB HID driver reads this report on each polling interval and translates it into OS
input events. The OS accumulates the X and Y deltas, applies any acceleration curve, and updates
the cursor position.

High-DPI mice with large dx/dy values can overflow a signed byte quickly. Gaming mice typically
extend the report format with 16-bit fields for X and Y in their proprietary HID descriptor to
accommodate large displacement values at high DPI.

### The Linux Input Subsystem

On Linux, USB input devices are handled by the `usbhid` kernel module. It translates HID reports
into `input_event` structs and writes them to a device file under `/dev/input/`. A mouse
typically appears as `/dev/input/event2` or similar.

An `input_event` is defined in `<linux/input.h>`:

```c
struct input_event {
    struct timeval time;
    __u16 type;   // EV_REL for relative movement, EV_KEY for buttons
    __u16 code;   // REL_X, REL_Y, BTN_LEFT, etc.
    __s32 value;  // displacement amount or button state
};
```

For a mouse move to the right, the kernel writes two events: one with `type=EV_REL, code=REL_X,
value=5` and one with `type=EV_SYN, code=SYN_REPORT, value=0`. The SYN_REPORT signals the end
of a frame, so the consumer can process all events for that polling interval together.

X11 and Wayland both read from the evdev interface. X11 uses the `evdev` input driver (part of
`xf86-input-evdev`). Wayland compositors use `libinput`, which reads evdev events and applies
pointer acceleration and device configuration. Either way, the event eventually reaches the
application's event loop as a mouse-move event with screen coordinates.

### Reading Mouse Events in Go

Reading raw evdev events from `/dev/input/eventN` can be done directly using standard Go library
components (`os` and `encoding/binary`):

```go
package main

import (
	"encoding/binary"
	"fmt"
	"os"
)

// inputEvent mirrors struct input_event from linux/input.h.
// Sec and Usec are the timestamp - Type, Code, Value are the event fields.
type inputEvent struct {
	Sec   int64
	Usec  int64
	Type  uint16
	Code  uint16
	Value int32
}

const (
	evRel = 0x02
	relX  = 0x00
	relY  = 0x01
)

func main() {
	f, err := os.Open("/dev/input/event2") // adjust device path
	if err != nil {
		fmt.Println("open:", err, "(run as root or add user to 'input' group)")
		return
	}
	defer f.Close()

	var ev inputEvent
	for {
		if err := binary.Read(f, binary.LittleEndian, &ev); err != nil {
			fmt.Println("read:", err)
			return
		}
		if ev.Type == evRel {
			switch ev.Code {
			case relX:
				fmt.Printf("X delta: %d\n", ev.Value)
			case relY:
				fmt.Printf("Y delta: %d\n", ev.Value)
			}
		}
	}
}
```

This reads raw displacement values as the kernel evdev interface reports them, before any
acceleration or scaling is applied. This is the same level at which tools like `libinput debug-events`
work.

### The Full Pipeline

```
Hand moves mouse
  → IR LED illuminates surface texture
  → CMOS sensor captures frames at up to 17,000 fps
  → DSP runs cross-correlation on consecutive frames
  → dx/dy accumulated over 1ms window
  → SoC packages 4-byte HID report
  → USB cable/Bluetooth sends report at polling rate (125-8000 Hz)
  → Host USB HID driver receives report
  → Kernel evdev writes EV_REL events to /dev/input/eventN
  → libinput or X11 evdev driver reads events
  → Display server applies acceleration, updates cursor position
  → Application receives mouse-move event with screen coordinates
```

Every layer in this pipeline is visible and inspectable. The optics are physical. The HID report
format is in the USB specification. The evdev interface is documented in the Linux kernel source.
The Wayland protocol is open. There is nothing magical happening, it is engineering at every step.

---

Watch the original video: https://www.youtube.com/watch?v=SAaESb4wTCM
