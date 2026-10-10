## Device Drivers from a Userspace Perspective

> **Senior @ FAANG**: You will rarely write a kernel driver. You will frequently **avoid** writing one by using UIO, VFIO, SPDK, DPDK, or a well-designed `ioctl` interface. The systems engineer's job is to know when each is appropriate and how to interact with them safely from C++.

### 1. Character vs Block vs Network. The Three Driver Worlds

| Class | Looks like | Examples | I/O model |
|-------|-----------|----------|-----------|
| Character | A byte stream / `ioctl` target | `/dev/null`, `/dev/random`, GPU control nodes, `/dev/uinput` | `read/write/ioctl/mmap` |
| Block | Fixed-size blocks, request queue | `/dev/sda`, `/dev/nvme0n1`, `/dev/loop0` | `read/write/io_uring/AIO`, accessed via FS or directly |
| Network | Frames via socket layer | `eth0`, `ens5`, `tun0` | `socket/sendmsg/recvmsg`, no `/dev/` node |

Every device exposes a `(major, minor)` pair. `/dev` is populated by `udev`/`devtmpfs`. `mknod` creates a node with explicit numbers, useful inside containers without devtmpfs.

### 2. `ioctl`. The Devil's Door

`ioctl(fd, request, arg)` is how userspace asks a driver for anything beyond byte-stream semantics.

```cpp
#include <linux/fs.h>
#include <linux/blkpg.h>
unsigned long sectors;
ioctl(blockfd, BLKGETSIZE64, &sectors);   // device size in bytes
ioctl(blockfd, BLKDISCARD, &range);        // TRIM
ioctl(blockfd, BLKZEROOUT, &range);        // hardware zero-fill
ioctl(blockfd, FICLONE, src_fd);           // reflink (xfs/btrfs)
```

`request` is a **magic number** with structure:

```
bits  31-30  29-16  15-8  7-0
      DIR    SIZE   TYPE  NR
```

Encoded by `_IO`, `_IOR`, `_IOW`, `_IOWR` macros. Each subsystem owns a TYPE letter (`B` for block, `K` for kvm, etc.). Designing a new `ioctl` means picking an unused TYPE, defining `struct`s with **explicit-sized integers** (`__u32`, `__u64`, never `int`/`long`, since 32/64-bit ABIs differ), and providing a fixed-layout struct with version/size fields:

```c
struct mydriver_cmd_v1 {
    __u32 size;       // sizeof this struct, for forward compat
    __u32 flags;
    __u64 buf_addr;
    __u64 buf_len;
    __u64 reserved[4]; // zero-initialize, kernel checks
};
#define MYDRIVER_DO_THING _IOWR('Q', 1, struct mydriver_cmd_v1)
```

Lessons from real kernel ABIs:

- **`size` field first**: kernel reads `size`, validates `<=` its known size, copies that much. New fields can be appended, old kernels truncate safely.
- **Reserved fields must be zero**: kernel `EINVAL`s nonzero reserved bytes, so future versions can repurpose them.
- **No pointers to userspace structs without explicit length**, every length goes in the struct.
- **`copy_from_user` once**, never multiple round trips.

### 3. UIO. Userspace I/O Drivers

UIO (`drivers/uio/`) is a thin kernel shim that exposes a hardware device's MMIO regions and interrupt line to userspace via `/dev/uioN`. The "real" driver is in C++ in your application.

```cpp
int fd = open("/dev/uio0", O_RDWR);
// MMIO region 0 (BAR0):
size_t map_size = 0x1000;
void* regs = mmap(nullptr, map_size, PROT_READ|PROT_WRITE, MAP_SHARED, fd, 0);

// Wait for interrupt: read 4 bytes -> count of interrupts since last read
uint32_t count;
read(fd, &count, sizeof count);  // blocks until next IRQ

// Acknowledge interrupt: write 1 to enable next:
uint32_t one = 1;
write(fd, &one, sizeof one);
```

UIO is the path for prototyping FPGA boards, custom NICs, and embedded devices without writing a kernel module. Limitations:

- No DMA helpers, you bring your own contiguous memory (often via hugetlbfs or `vfio` for IOMMU mapping).
- No interrupt coalescing, no NAPI, every IRQ is a context switch and a `read()`.
- Single-process: `/dev/uioN` is exclusive-open.

### 4. VFIO. The Modern Way to Pass Hardware to Userspace

VFIO (`Documentation/driver-api/vfio.rst`) is the IOMMU-backed successor to UIO and `pci-stub`. It is what KVM uses to hand a PCIe device to a VM, and what DPDK / SPDK use for NIC and NVMe userspace drivers.

The model:

1. Bind the device to `vfio-pci`:
   ```bash
   echo "vfio-pci" > /sys/bus/pci/devices/0000:01:00.0/driver_override
   echo "0000:01:00.0" > /sys/bus/pci/drivers_probe
   ```
2. Open the **container** (`/dev/vfio/vfio`), the **group** (`/dev/vfio/<gid>`), then the **device** within the group.
3. Map DMA memory through the IOMMU: `VFIO_IOMMU_MAP_DMA`. The IOMMU isolates this device, it can DMA only to mapped regions.
4. Read PCI config space, BAR regions, MSI/MSI-X via VFIO ioctls.

Key advantages over UIO:

- IOMMU isolation: a buggy userspace driver cannot DMA to arbitrary RAM.
- MSI/MSI-X support, the right interrupt model for modern PCIe.
- Multi-device groups for SR-IOV.

### 5. SPDK. NVMe Without the Kernel

SPDK (Storage Performance Development Kit) is the BSD-licensed C/C++ framework Intel and the storage industry use to drive NVMe SSDs from userspace. The numbers:

- Kernel NVMe: ~500k IOPS per core at 4 KiB random read, with measurable jitter.
- SPDK polling driver: 5-10 M IOPS per core, sub-µs jitter.

How: NVMe submission queues are MMIO doorbells + DMA-mapped queue rings. SPDK `mmap`s the BAR via VFIO, allocates queue memory in hugetlbfs (DMA-coherent), polls completion queues from a dedicated thread. No syscalls in the hot path.

Sketch of a C++ application using SPDK:

```cpp
spdk_env_opts_init(&opts);
opts.name = "my_app";
spdk_env_init(&opts);

// Probe NVMe:
spdk_nvme_probe(nullptr, &cb_ctx, probe_cb, attach_cb, nullptr);

// In attach_cb you get an spdk_nvme_ctrlr* - allocate an I/O qpair:
auto* qp = spdk_nvme_ctrlr_alloc_io_qpair(ctrlr, nullptr, 0);

// Submit a 4 KiB read to LBA 0, completion via callback:
char* buf = (char*)spdk_dma_zmalloc(4096, 0x1000, nullptr);
spdk_nvme_ns_cmd_read(ns, qp, buf, 0, 1, on_complete, nullptr, 0);

// Drive the qpair from your event loop:
while (running) spdk_nvme_qpair_process_completions(qp, 0);
```

When to use it:

- You need >1 M IOPS or <10 µs p99 against NVMe.
- You can dedicate cores (poll mode burns 100% CPU per polling thread).

When **not** to use it:

- The disk is shared with a filesystem the OS uses. SPDK takes the device exclusively.

### 6. DPDK. Same Story, NICs

DPDK does for NICs what SPDK does for NVMe: VFIO + hugetlbfs + poll-mode drivers. Used by Open vSwitch fast-path, FD.io VPP, MoonGen. C++ binding: `librte_*` is C, but with care it integrates cleanly. Performance: 100 Gbps line-rate forwarding from userspace on commodity hardware.

### 7. Designing a Driver from a Userspace API

When somebody asks you to "expose this hardware to userspace," the decision tree:

1. **Does it have a stable interface in the kernel already?** Use it via `/dev/` + `ioctl`. Stop.
2. **Is it a NIC?** Bind to `vfio-pci`, use DPDK or write directly to MMIO/BAR.
3. **Is it an NVMe SSD?** SPDK.
4. **Custom FPGA / accelerator?** UIO for prototyping, VFIO for production.
5. **Genuinely new device with policy in the kernel?** Now you write a kernel module, with a tiny `ioctl` ABI as in §2. Keep policy in userspace.

The principle: **mechanism in the kernel, policy in userspace.** Junior engineers write huge kernel drivers, senior engineers write 200-line UIO/VFIO shims and 5,000-line C++ drivers.

### 8. Interacting With `/dev` Nodes Safely

```cpp
int fd = open("/dev/nvme0n1", O_RDWR | O_DIRECT | O_CLOEXEC);
struct stat st; fstat(fd, &st);
if (!S_ISBLK(st.st_mode)) abort();    // refuse anything that is not a block device

struct nvme_passthru_cmd cmd{};       // /usr/include/linux/nvme_ioctl.h
cmd.opcode  = nvme_admin_identify;
cmd.nsid    = 0;
cmd.addr    = (__u64)(uintptr_t)buf;
cmd.data_len = 4096;
cmd.cdw10   = 1;                      // CNS=1: identify controller
ioctl(fd, NVME_IOCTL_ADMIN_CMD, &cmd);
```

NVMe pass-through `ioctl` is a clean example of a well-designed kernel ABI: stable struct, explicit lengths, command opcodes match the NVMe spec. You can implement vendor-specific commands without recompiling the kernel.

### 9. uinput. Userspace as the Driver

`/dev/uinput` lets a userspace program **act as** an input device, synthesize keyboard/mouse/touchscreen events that the rest of the system sees as real hardware.

```cpp
int fd = open("/dev/uinput", O_WRONLY | O_NONBLOCK);
ioctl(fd, UI_SET_EVBIT, EV_KEY);
ioctl(fd, UI_SET_KEYBIT, KEY_A);

struct uinput_setup us{};
strcpy(us.name, "synth-kbd");
us.id.bustype = BUS_USB;
us.id.vendor  = 0x1234; us.id.product = 0x5678;
ioctl(fd, UI_DEV_SETUP, &us);
ioctl(fd, UI_DEV_CREATE, 0);

struct input_event ev{ .type = EV_KEY, .code = KEY_A, .value = 1 };
write(fd, &ev, sizeof ev);
ev.type = EV_SYN; ev.code = SYN_REPORT; ev.value = 0;
write(fd, &ev, sizeof ev);
```

Used by remote-desktop servers, accessibility tools, automation harnesses. Counterpart for GPUs is `DRM_IOCTL_*` over `/dev/dri/card0`.

### 10. Junior → FAANG Cheatsheet

| Junior | FAANG-grade |
|--------|-------------|
| Write a kernel module for everything | UIO/VFIO + C++ driver in userspace whenever possible. |
| `ioctl` with raw integers | Versioned struct, `__u32 size` first, reserved fields zero. |
| 32-bit `int` in `ioctl` struct | Explicit-sized `__u32`/`__u64`, survives 32/64-bit. |
| Use kernel NVMe at >500 KIOPS | SPDK with VFIO, pin polling cores. |
| Block on `read(uio_fd)` for IRQ | OK for low-rate, for high-rate, poll MMIO and disable IRQ. |
| `mknod` blindly | Verify with `S_ISBLK`/`S_ISCHR` before using. |
| Trust device hot-add | Use udev rules + `/sys` watches, never hardcode `/dev/sdX`. |

You will not write a driver on a regular Tuesday. But the day you have to, knowing the userspace path saves you weeks of kernel debugging.
