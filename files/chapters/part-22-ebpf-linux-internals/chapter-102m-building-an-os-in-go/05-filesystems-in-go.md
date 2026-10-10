## 102M.5 Filesystems: In-Memory, Then FAT16

The go-dav-os project ships two filesystem implementations: an **in-memory FS** (easy to implement, lost on reboot) and a **FAT16 driver** that persists across reboots using a disk image. Neither is covered in the Medium tutorial series. This section walks through the shape of both because they are where a hobby kernel starts feeling like a real system.

### Why Two Filesystems?

The in-memory FS is the first filesystem you implement because it sidesteps every hard problem: no block I/O, no persistence format, no alignment constraints, no FAT structure. It is purely a map from path to byte slice, plus bookkeeping for directories.

The FAT16 driver is the second because FAT16 is the simplest persistent filesystem that is a real standard. Linux mounts it, QEMU images can be formatted as FAT16, and you can write to the disk image from a host OS for debugging. FAT32 and ext2 are the natural next steps.

### The In-Memory FS

The data model is small:

```go
package memfs

type Node struct {
    Name     string
    IsDir    bool
    Data     []byte        // non-nil for files
    Children map[string]*Node  // non-nil for directories
}

var root = &Node{
    Name:     "/",
    IsDir:    true,
    Children: map[string]*Node{},
}

func Resolve(path string) (*Node, error) {
    if path == "/" {
        return root, nil
    }
    parts := splitPath(path)
    cur := root
    for _, p := range parts {
        if !cur.IsDir {
            return nil, ErrNotADirectory
        }
        n, ok := cur.Children[p]
        if !ok {
            return nil, ErrNotFound
        }
        cur = n
    }
    return cur, nil
}

func Write(path string, data []byte) error {
    dir, name := splitDirBase(path)
    d, err := Resolve(dir)
    if err != nil {
        return err
    }
    if !d.IsDir {
        return ErrNotADirectory
    }
    d.Children[name] = &Node{Name: name, Data: data}
    return nil
}

func Read(path string) ([]byte, error) {
    n, err := Resolve(path)
    if err != nil {
        return nil, err
    }
    if n.IsDir {
        return nil, ErrIsDirectory
    }
    return n.Data, nil
}
```

Four shell commands map directly onto this API: `ls`, `cat`, `write`, `rm`. The go-dav-os shell implements all four. The path parsing is where the bugs hide: trailing slashes, empty strings, absolute vs relative, `.` and `..` handling. Start without those edge cases and add them incrementally.

### Talking to the Disk: ATA PIO

Before you can implement FAT16, you need to read and write sectors on a disk. QEMU exposes a virtual IDE controller accessible through PIO (Programmed I/O) on x86. The protocol is:

1. Write LBA (Logical Block Address) to the sector number registers.
2. Write sector count to the sector count register.
3. Write a command byte (`0x20` for read, `0x30` for write).
4. Poll the status register until the Data Request bit is set.
5. For reads, read 256 16-bit words from the data register. For writes, write them.

```go
package ata

const (
    portData     uint16 = 0x1F0
    portError    uint16 = 0x1F1
    portSectors  uint16 = 0x1F2
    portLBALow   uint16 = 0x1F3
    portLBAMid   uint16 = 0x1F4
    portLBAHigh  uint16 = 0x1F5
    portDrive    uint16 = 0x1F6
    portStatus   uint16 = 0x1F7
    portCommand  uint16 = 0x1F7

    cmdReadPIO   byte = 0x20
    cmdWritePIO  byte = 0x30

    statusBSY = 1 << 7
    statusDRQ = 1 << 3
)

func waitReady() {
    for inb(portStatus)&statusBSY != 0 {
    }
}

func waitDataReady() {
    for inb(portStatus)&statusDRQ == 0 {
    }
}

func ReadSector(lba uint32, buf []byte) {
    waitReady()
    outb(portDrive, byte(0xE0|((lba>>24)&0x0F)))
    outb(portSectors, 1)
    outb(portLBALow, byte(lba))
    outb(portLBAMid, byte(lba>>8))
    outb(portLBAHigh, byte(lba>>16))
    outb(portCommand, cmdReadPIO)
    waitDataReady()
    for i := 0; i < 256; i++ {
        w := inw(portData)
        buf[i*2] = byte(w)
        buf[i*2+1] = byte(w >> 8)
    }
}
```

A production kernel uses DMA for disk I/O. PIO is slow because the CPU copies every word. For a hobby kernel, PIO is fine: you can boot, format a disk, write a file, reboot, and read it back. That feels like magic the first time.

### FAT16 in 200 Lines

FAT16 is a tiny filesystem by modern standards. The on-disk layout is:

| Region | Sectors |
|--------|---------|
| Boot sector | 1 |
| FAT 1 | ~32-64 (depends on partition size) |
| FAT 2 (backup) | same |
| Root directory | 32 (for fixed 512 entries) |
| Data area | remainder |

The **boot sector** contains a BPB (BIOS Parameter Block) that tells you bytes-per-sector, sectors-per-cluster, reserved sectors, and a few other constants.

The **FAT** is an array of 16-bit cluster pointers. Cluster N points to cluster M, which points to cluster L, and so on until you hit 0xFFFF (end of file). This is just a linked list through a shared table.

The **root directory** is a fixed array of 32-byte entries, each describing one file or subdirectory with its starting cluster and size.

Key operations:

```go
package fat16

type BPB struct {
    BytesPerSector    uint16
    SectorsPerCluster uint8
    ReservedSectors   uint16
    NumberOfFATs      uint8
    RootEntries       uint16
    TotalSectors16    uint16
    Media             uint8
    SectorsPerFAT     uint16
    // ...more fields
}

type DirEntry struct {
    Name       [11]byte  // 8.3 format
    Attr       uint8
    Reserved   [10]byte
    Time       uint16
    Date       uint16
    FirstCluster uint16
    Size       uint32
}

// ReadFile walks the FAT starting from rootCluster and reads size bytes.
func ReadFile(bpb *BPB, startCluster uint16, size uint32) []byte {
    out := make([]byte, 0, size)
    cluster := startCluster
    bytesPerCluster := uint32(bpb.BytesPerSector) * uint32(bpb.SectorsPerCluster)
    for cluster < 0xFFF8 && uint32(len(out)) < size {
        buf := make([]byte, bytesPerCluster)
        readCluster(bpb, cluster, buf)
        out = append(out, buf...)
        cluster = nextCluster(bpb, cluster)
    }
    return out[:size]
}
```

The corresponding shell commands in go-dav-os are `fatformat` (lay down a fresh FAT16 on the disk), `fatinit` (mount the filesystem, parse the BPB), and `fatread` (read a file by name). The code in [go-dav-os/filesystem/fat16/](https://github.com/dmarro89/go-dav-os) is more complete than this walkthrough and is the canonical reference.

### Writing a FAT16 File

Writing is harder than reading because you need to:

1. Find a free cluster chain long enough to hold the file.
2. Write the data sectors.
3. Update the FAT entries to link the clusters.
4. Write (or update) the directory entry with the starting cluster and size.
5. Flush both FAT copies (FAT1 and FAT2 should stay in sync).

Each of those steps is an opportunity for corruption if the kernel crashes mid-write. Real filesystems use journals or transactions to recover. FAT16 has none of that, which is why a yanked USB stick formatted FAT16 often comes back corrupt. Real-world FAT16 assumes a clean shutdown.

For a hobby kernel in QEMU, you either call shutdown explicitly (a special QEMU hypercall) or accept that an unclean shutdown can corrupt the disk image. Shut down cleanly and you will be fine.

### Going Further

The go-dav-os roadmap and issue tracker outline several follow-up filesystem projects:

- FAT32 support (larger volumes, long file names)
- ext2 read-only (Linux-compatible, useful for dual-boot experiments)
- A log-structured filesystem (simpler crash safety)
- A VFS layer that lets the shell talk to any filesystem through a common interface

All of these are active-contribution-welcome items in the repository. If you want to ship something tangible in a hobby-OS space, picking one and sending a PR is the most valuable use of your time.

### Pitfalls Worth Naming

- **Sector size confusion.** Most x86 disks use 512-byte sectors, but some use 4096. The BPB says which.
- **Endianness.** FAT16 stores little-endian 16-bit and 32-bit values. Go on x86-64 is already little-endian, so direct struct reads work, but do not assume this for exports.
- **8.3 filename padding.** FAT16 directory entries pad short names with spaces (0x20), not nulls. Trim with care.
- **Case sensitivity.** FAT16 stores uppercase names only (VFAT LFN extensions add case, but those are optional). A shell that echoes lowercase filenames is technically wrong.
- **Cluster numbering starts at 2.** Clusters 0 and 1 are reserved. A bug that starts counting at 0 will silently corrupt everything.

### What You Have After This Section

- The kernel can talk to a virtual IDE disk via ATA PIO.
- You can format and read a FAT16 partition.
- Shell commands `ls`, `cat`, `write`, `rm`, `fatformat`, `fatinit`, `fatread` all work.
- Data persists across `qemu-system-x86_64` restarts.

At this point, the kernel is interactive, has working memory management, and has a real filesystem. The next question, for an ambitious hobbyist, is: can we run user programs?

### Junior → FAANG: Filesystems as the Bridge from Kernel to Application

The VFS (Virtual Filesystem Switch) layer, which the in-memory FS and FAT16 driver demonstrate in miniature, is the abstraction that makes all file operations in Linux uniform. Whether you call `open("/dev/urandom")`, `open("/proc/self/status")`, or `open("/home/user/file.txt")`, the kernel dispatches to the same `file_operations` function table registered by the appropriate filesystem driver. Go's `os.Open` ultimately calls `openat(2)`, which traverses the VFS layer to the correct filesystem driver without the application knowing which driver is involved.

The inode concept from the in-memory FS implementation is the foundation for understanding why some file operations are expensive and others are cheap. Renaming a file within the same filesystem is an O(1) inode operation (update the directory entry's inode pointer). Renaming a file across filesystems requires a copy (because inodes are local to a filesystem). This is why `os.Rename` fails with `EXDEV` ("invalid cross-device link") when crossing filesystem boundaries, and why `docker cp` copies file data rather than renaming. Understanding the inode model explains these behaviors without needing to read the `rename(2)` man page every time.

FAT16's cluster chain model (a linked list of fixed-size disk chunks) is the simplest possible persistent filesystem and is an excellent exercise precisely because of its limitations. FAT16 has no journaling (a crash during a write can corrupt the filesystem), no access control (no permissions, no owner), and poor fragmentation behavior over time. These limitations explain why modern filesystems (ext4, XFS, APFS, ZFS) were designed to replace it, and understanding what they replace helps you understand why the features they add (journaling, b-tree directory structures, checksums, snapshots) exist.

### Senior @ FAANG: Filesystem Selection and I/O Architecture for Production Systems

At FAANG, filesystem selection is a capacity engineering decision with long-term performance implications. XFS is the default filesystem for most FAANG Linux fleets because of its performance characteristics: O(1) allocation with the B+ tree extent-based allocator, scalable multi-threaded I/O, and predictable behavior under concurrent write workloads. ext4 is simpler (better for debugging and development) but has a smaller maximum file size (16 TB vs. XFS's 8 EiB) and worse performance for directory-heavy workloads (more than 10,000 files per directory degrades due to HTree limitations).

ZFS and Btrfs are considered for specific use cases. ZFS's copy-on-write and snapshot capabilities make it attractive for backup systems and development environments where rollback to a known state is valuable. Btrfs's subvolume and snapshot model is the basis for containerd's Btrfs storage driver, which creates container overlay filesystems as Btrfs subvolumes rather than overlayfs mounts. The tradeoff is kernel mainline support (overlayfs is in mainline, XFS is in mainline, Btrfs is in mainline but has historically had stability issues for specific workloads) and operational familiarity (fewer FAANG engineers have deep XFS expertise than ext4).

io_uring is the most significant Linux I/O architecture change since `epoll`. It replaces the `read`/`write` syscall model with a shared memory ring buffer between user space and kernel space, reducing per-operation overhead from two context switches (submit + completion) to zero (the kernel processes submissions from the ring buffer asynchronously). Go's standard library does not use io_uring yet (as of Go 1.23), but the next major I/O-intensive Go library (database drivers, object storage clients) will. Staff engineers who understand io_uring's submission/completion queue model can evaluate when io_uring adoption provides measurable benefit versus when the existing `net.Conn` and `os.File` abstractions are sufficient.

---

---
