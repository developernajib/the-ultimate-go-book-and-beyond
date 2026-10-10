## Section 2: Memory Layout Optimization

### 2.1 Struct Field Alignment

The Go compiler inserts padding between struct fields to satisfy the alignment requirements of each field's type. Field order determines total struct size: a struct with alternating 1-byte and 8-byte fields can be nearly twice the size of the same struct with fields sorted from largest alignment to smallest. Smaller structs fit more instances per cache line, which improves iteration performance on slices of structs and reduces GC scan time for large object graphs. The rule of thumb is **order fields from largest alignment to smallest**: pointers and 8-byte primitives first, then 4-byte, 2-byte, 1-byte. The tool below analyzes struct layouts with `unsafe.Offsetof` and shows the savings from reordering. Tools like `fieldalignment` (from `golang.org/x/tools/go/analysis/passes/fieldalignment`) automate the check in CI.

```go
package memory_layout

import (
	"unsafe"
)

// AlignmentRules in Go:
// - bool, uint8, int8: 1-byte aligned
// - uint16, int16: 2-byte aligned
// - uint32, int32, float32: 4-byte aligned
// - uint64, int64, float64, pointer: 8-byte aligned
// - struct: aligned to largest field's alignment
// - array: aligned to element's alignment

// Worst-case ordering: alternating small and large fields maximize padding.
// Size on amd64: 40 bytes.
type BadOrder struct {
	Active  bool   // 1 byte
	// 7 bytes padding to align ID to 8.
	ID      uint64 // 8 bytes
	Role    uint8  // 1 byte
	// 7 bytes padding to align CreatedAt to 8.
	CreatedAt int64 // 8 bytes
	Flag    bool   // 1 byte
	// 7 bytes tail padding to make the struct size a multiple of 8.
}

// Best ordering: sort by alignment descending. Size on amd64: 24 bytes.
// 40% smaller than BadOrder. At 10M instances that is 160 MB saved.
type GoodOrder struct {
	ID        uint64 // 8 bytes
	CreatedAt int64  // 8 bytes
	Active    bool   // 1 byte
	Role      uint8  // 1 byte
	Flag      bool   // 1 byte
	// 5 bytes tail padding.
}

// Verify with unsafe.Sizeof(BadOrder{}) and unsafe.Sizeof(GoodOrder{}).
// Or run: go vet -vettool=$(which fieldalignment) ./...

// LayoutAnalysis prints struct field offsets.
func LayoutAnalysis() {
	type example struct {
		a uint8
		b uint64
		c uint8
		d uint32
	}

	// Without optimization: size = 1 + 7pad + 8 + 1 + 3pad + 4 = 24 bytes
	// With optimization (reorder): uint64, uint32, uint8, uint8 = 8+4+1+1+2pad = 16 bytes

	_ = unsafe.Sizeof(example{})
	_ = unsafe.Offsetof(example{}.b)
}

// HotColdFieldSeparation: separate frequently accessed fields from rarely-used ones.
// This improves cache utilization because the hot set fits in fewer cache lines.

// Before: all fields in one struct, even cold ones evict hot ones from cache.
type AllInOne struct {
	// Hot fields (accessed every request)
	ID        uint64
	UserID    uint64
	CreatedAt int64
	Status    uint8

	// Cold fields (accessed rarely)
	Description [512]byte // 512 bytes, eight cache lines dragged along on every touch.
	Metadata    [256]byte
	AuditLog    [128]byte
}

// After: split into hot + cold struct pair.
type HotData struct {
	ID        uint64
	UserID    uint64
	CreatedAt int64
	Status    uint8
	// 7 bytes padding
	ColdPtr   *ColdData // Cold data is loaded only when the pointer is followed.
}

type ColdData struct {
	Description [512]byte
	Metadata    [256]byte
	AuditLog    [128]byte
}

// HotData is 40 bytes on amd64, so it still fits in a single 64-byte cache line.
// The serving path touches only HotData. ColdData is pulled in on the rare
// admin and audit paths that actually need it.
```

### 2.2 Memory-Mapped Files

Memory-mapped files expose file contents as a `[]byte` slice backed by the OS virtual memory system, allowing random access to terabyte-scale files without reading them into process memory first. The OS page cache handles demand paging transparently, and `madvise` hints (`MADV_SEQUENTIAL`, `MADV_WILLNEED`, `MADV_DONTNEED`) allow the application to communicate its access pattern so the kernel can optimize prefetching and eviction. The implementation below wraps `mmap`/`munmap` in a typed `MMapFile` struct and handles the unsafe-pointer gymnastics required to work with mapped memory in Go.

```go
package mmap

import (
	"fmt"
	"os"
	"syscall"
	"unsafe"
)

// MMapFile provides zero-copy file access using memory mapping.
// File contents are mapped directly into process address space.
// No read() syscall and no kernel buffer copy: the OS page cache is the data.
//
// Use cases:
// - Reading large files (databases, indexes, model weights)
// - Shared memory between processes
// - Zero-copy log file processing
type MMapFile struct {
	data []byte
	file *os.File
}

// Open memory-maps the file at path for reading.
func Open(path string) (*MMapFile, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, fmt.Errorf("open: %w", err)
	}

	stat, err := f.Stat()
	if err != nil {
		f.Close()
		return nil, fmt.Errorf("stat: %w", err)
	}

	size := int(stat.Size())
	if size == 0 {
		f.Close()
		return &MMapFile{data: nil, file: f}, nil
	}

	// Map file into virtual address space.
	data, err := syscall.Mmap(
		int(f.Fd()),
		0,    // offset
		size, // length
		syscall.PROT_READ, // Read-only
		syscall.MAP_SHARED, // Changes (if any) visible to other processes.
	)
	if err != nil {
		f.Close()
		return nil, fmt.Errorf("mmap: %w", err)
	}

	// Hint to the OS that access is sequential so it prefetches pages ahead.
	syscall.Madvise(data, syscall.MADV_SEQUENTIAL)

	return &MMapFile{data: data, file: f}, nil
}

// OpenWrite memory-maps the file for read-write access.
func OpenWrite(path string, size int) (*MMapFile, error) {
	f, err := os.OpenFile(path, os.O_RDWR|os.O_CREATE, 0644)
	if err != nil {
		return nil, err
	}

	// Extend file to required size.
	if err := f.Truncate(int64(size)); err != nil {
		f.Close()
		return nil, err
	}

	data, err := syscall.Mmap(
		int(f.Fd()),
		0,
		size,
		syscall.PROT_READ|syscall.PROT_WRITE,
		syscall.MAP_SHARED,
	)
	if err != nil {
		f.Close()
		return nil, fmt.Errorf("mmap write: %w", err)
	}

	return &MMapFile{data: data, file: f}, nil
}

// Bytes returns the raw bytes of the mapped file.
func (m *MMapFile) Bytes() []byte { return m.data }

// Size returns the size of the mapped region.
func (m *MMapFile) Size() int { return len(m.data) }

// ReadUint64 reads a uint64 at byte offset offset without any allocation.
func (m *MMapFile) ReadUint64(offset int) uint64 {
	return *(*uint64)(unsafe.Pointer(&m.data[offset]))
}

// ReadString returns a string slice (zero-copy) at offset with length n.
// The string shares the mmap'd memory and is only valid until Close().
func (m *MMapFile) ReadString(offset, length int) string {
	return unsafe.String(unsafe.SliceData(m.data[offset:]), length)
}

// advise applies a madvise hint to the pages covering [offset, offset+length).
// madvise(2) requires a page-aligned start address, so round the offset down to
// the enclosing page boundary. Skipping this step makes the call fail with
// EINVAL, silently, for every offset that is not a multiple of the page size.
func (m *MMapFile) advise(offset, length, advice int) error {
	if offset < 0 || offset >= len(m.data) {
		return syscall.EINVAL
	}
	if length <= 0 || offset+length > len(m.data) {
		length = len(m.data) - offset
	}
	pageSize := os.Getpagesize()
	start := offset &^ (pageSize - 1)
	end := offset + length
	return syscall.Madvise(m.data[start:end], advice)
}

// Prefetch hints to the OS that these pages should be loaded (async, non-blocking).
func (m *MMapFile) Prefetch(offset, length int) error {
	return m.advise(offset, length, syscall.MADV_WILLNEED)
}

// Release hints to the OS that these pages are no longer needed and may be
// evicted. For this read-only file mapping the pages are simply dropped and
// re-read from the file on the next fault. MADV_DONTNEED on a private anonymous
// mapping destroys the data instead, so do not copy this call into that context.
func (m *MMapFile) Release(offset, length int) error {
	return m.advise(offset, length, syscall.MADV_DONTNEED)
}

// Flush writes dirty pages to the underlying file.
// Only needed for MAP_SHARED writes.
func (m *MMapFile) Flush() error {
	_, _, errno := syscall.Syscall(
		syscall.SYS_MSYNC,
		uintptr(unsafe.Pointer(&m.data[0])),
		uintptr(len(m.data)),
		syscall.MS_SYNC,
	)
	if errno != 0 {
		return errno
	}
	return nil
}

// Close unmaps the file and closes the file descriptor.
func (m *MMapFile) Close() error {
	if m.data != nil {
		if err := syscall.Munmap(m.data); err != nil {
			return err
		}
		m.data = nil
	}
	return m.file.Close()
}

// MMapIndex is a memory-mapped sorted integer index for fast binary search.
// Used in databases for primary key lookups without loading the full table.
type MMapIndex struct {
	mmap    *MMapFile
	count   int
	keySize int // bytes per key
}

func OpenMMapIndex(path string) (*MMapIndex, error) {
	mmap, err := Open(path)
	if err != nil {
		return nil, err
	}
	const keySize = 8 // int64 keys
	return &MMapIndex{
		mmap:    mmap,
		count:   mmap.Size() / keySize,
		keySize: keySize,
	}, nil
}

// BinarySearch finds the position of target in the sorted mmap'd index.
// Zero allocation: it reads directly from mapped memory.
func (idx *MMapIndex) BinarySearch(target int64) int {
	lo, hi := 0, idx.count-1
	for lo <= hi {
		mid := (lo + hi) / 2
		key := int64(idx.mmap.ReadUint64(mid * idx.keySize))
		switch {
		case key == target:
			return mid
		case key < target:
			lo = mid + 1
		default:
			hi = mid - 1
		}
	}
	return -1 // Not found.
}

func (idx *MMapIndex) Close() error {
	return idx.mmap.Close()
}
```

### 2.3 Zero-Copy I/O

Zero-copy I/O transfers data between file descriptors or between a file and a network socket without copying it through user-space buffers, reducing both CPU usage and memory bandwidth consumption on the I/O path. The `sendfile` syscall (or `io.Copy` on an `*os.File` and `net.Conn`, which the runtime dispatches to `sendfile` automatically on Linux) achieves this for file-to-socket transfers. The code below shows where Go's standard library performs zero-copy automatically, where it doesn't, and how to use `syscall.Sendfile` directly for cases the standard library misses.

```go
package zerocopy

import (
	"io"
	"net"
	"os"
	"syscall"
	"unsafe"
)

// SendFile uses sendfile(2) to send a file to a network socket
// without copying data through user space.
// Data path: file → kernel page cache → NIC DMA (no user space copy).
// The win is CPU and memory bandwidth, not magic: the payload never crosses the
// user/kernel boundary. How much it buys depends entirely on payload size and on
// how much of the request was already spent elsewhere, so measure it on your own
// workload before quoting a number.
//
// In production you rarely write this yourself. On Linux, io.Copy(tcpConn, file)
// already dispatches to sendfile(2) inside the net package, and that path also
// drives the runtime poller correctly on a partial send. The explicit version
// below is here to show the syscall, and it inherits the usual caveat: the socket
// fd is non-blocking, so a single sendfile call can return short or EAGAIN.
func SendFile(conn net.Conn, file *os.File) (int64, error) {
	tcpConn, ok := conn.(*net.TCPConn)
	if !ok {
		// Fallback to copy for non-TCP connections.
		return io.Copy(conn, file)
	}

	rawConn, err := tcpConn.SyscallConn()
	if err != nil {
		return 0, err
	}

	stat, err := file.Stat()
	if err != nil {
		return 0, err
	}

	size := stat.Size()
	var sent int // syscall.Sendfile reports an int, not an int64.
	var sendErr error

	if ctlErr := rawConn.Control(func(fd uintptr) {
		// sendfile(out_fd, in_fd, offset, count)
		sent, sendErr = syscall.Sendfile(int(fd), int(file.Fd()), nil, int(size))
	}); ctlErr != nil {
		return 0, ctlErr
	}
	return int64(sent), sendErr
}

// The splice(2) flags are not exported by the syscall package. They live in
// golang.org/x/sys/unix as unix.SPLICE_F_MOVE and friends. Declared here to keep
// this snippet dependency-free.
const (
	spliceMove     = 0x1 // SPLICE_F_MOVE
	spliceNonblock = 0x2 // SPLICE_F_NONBLOCK
)

// Splice transfers data between two file descriptors without user-space copying.
// Useful for proxy servers: read from upstream socket → write to downstream socket.
// Data path: kernel socket buffer → kernel pipe → kernel socket buffer.
func Splice(dst, src *net.TCPConn, size int) (int64, error) {
	// Create an in-kernel pipe for splice.
	var pipeFDs [2]int
	if err := syscall.Pipe2(pipeFDs[:], syscall.O_CLOEXEC); err != nil {
		return 0, err
	}
	defer syscall.Close(pipeFDs[0])
	defer syscall.Close(pipeFDs[1])

	srcRaw, err := src.SyscallConn()
	if err != nil {
		return 0, err
	}
	dstRaw, err := dst.SyscallConn()
	if err != nil {
		return 0, err
	}

	var total int64
	const chunk = int64(65536) // 64KB splice buffer.

	for total < int64(size) {
		remaining := int64(size) - total
		want := chunk
		if remaining < want {
			want = remaining
		}

		// Note the two error variables per step. Control returns its own error
		// (the fd could not be acquired), and the closure produces the splice
		// error. Assigning both to a single `err` lets Control's nil return
		// overwrite a real syscall failure, which is how these loops end up
		// silently reporting success on a broken connection.
		var moved int64
		var spliceErr error
		if ctlErr := srcRaw.Control(func(fd uintptr) {
			// Splice from socket to pipe (non-blocking).
			moved, spliceErr = syscall.Splice(int(fd), nil, pipeFDs[1], nil, int(want),
				spliceMove|spliceNonblock)
		}); ctlErr != nil {
			return total, ctlErr
		}
		if spliceErr != nil {
			return total, spliceErr
		}
		if moved == 0 {
			return total, nil // Source is at EOF.
		}

		// Drain the pipe fully. splice() into the socket may move less than what
		// the pipe holds, and anything left behind is lost data, not a slow path.
		for moved > 0 {
			var wrote int64
			if ctlErr := dstRaw.Control(func(fd uintptr) {
				wrote, spliceErr = syscall.Splice(pipeFDs[0], nil, int(fd), nil, int(moved),
					spliceMove)
			}); ctlErr != nil {
				return total, ctlErr
			}
			if spliceErr != nil {
				return total, spliceErr
			}
			if wrote == 0 {
				return total, io.ErrShortWrite
			}
			moved -= wrote
			total += wrote
		}
	}
	return total, nil
}

// ScatterGatherIO reads into multiple buffers with a single syscall.
// Reduces syscall overhead for protocol parsing (header + body split).
type ScatterGatherReader struct {
	conn net.Conn
}

func NewScatterGatherReader(conn net.Conn) *ScatterGatherReader {
	return &ScatterGatherReader{conn: conn}
}

// ReadVec reads data into multiple non-contiguous buffers using readv(2).
// Equivalent to multiple Read() calls but with a single syscall.
func (r *ScatterGatherReader) ReadVec(buffers [][]byte) (int64, error) {
	rawConn, err := r.conn.(*net.TCPConn).SyscallConn()
	if err != nil {
		return 0, err
	}

	// Build iovec array from buffer list.
	iovecs := make([]syscall.Iovec, len(buffers))
	for i, buf := range buffers {
		if len(buf) > 0 {
			iovecs[i].Base = &buf[0]
			iovecs[i].SetLen(len(buf))
		}
	}

	var totalRead int64
	var readErr error

	err = rawConn.Read(func(fd uintptr) bool {
		n, _, errno := syscall.Syscall(
			syscall.SYS_READV,
			fd,
			uintptr(unsafe.Pointer(&iovecs[0])),
			uintptr(len(iovecs)),
		)
		if errno != 0 {
			if errno == syscall.EAGAIN {
				return false // Not ready, retry.
			}
			readErr = errno
			return true
		}
		totalRead = int64(n)
		return true
	})

	if err != nil {
		return 0, err
	}
	return totalRead, readErr
}

// BatchWriter wraps a net.Conn and coalesces queued buffers into a single
// writev(2) syscall. There is no need to reach for syscall here: net.Buffers
// is exactly this feature, and its WriteTo uses writev on a TCP connection
// (falling back to sequential writes on transports that cannot do better).
type BatchWriter struct {
	conn    net.Conn
	pending net.Buffers
}

func NewBatchWriter(conn net.Conn) *BatchWriter {
	return &BatchWriter{conn: conn}
}

// Add queues a buffer. The bytes are not copied, only the slice header is
// retained, so the caller must not reuse buf until after Flush returns.
func (w *BatchWriter) Add(buf []byte) {
	w.pending = append(w.pending, buf)
}

// Flush writes all pending buffers, ideally with one writev syscall.
// WriteTo consumes w.pending as it drains, so reset it afterwards.
func (w *BatchWriter) Flush() error {
	if len(w.pending) == 0 {
		return nil
	}
	_, err := w.pending.WriteTo(w.conn)
	w.pending = w.pending[:0]
	return err
}
```

### 2.4 Junior → FAANG: the struct-alignment ritual

Every new struct you introduce in a hot path should get a thirty-second layout check. Run `go vet -vettool=$(which fieldalignment) ./...` or install `github.com/dkorunic/betteralign`. Both tools print the current size, the optimal size, and the reordering needed to shrink it. If your struct is allocated millions of times, this ritual saves real RSS. More importantly, doing it for every struct builds the intuition that lets you spot poorly-aligned structs in code review without running the tool at all. Engineers who habitually look at struct layout tend to write more compact code from the start, and the compounding effect on a codebase over years is measurable. This is exactly the kind of small habit that separates engineers who own their performance from engineers who react to it when it breaks.

### 2.5 Senior @ FAANG: when mmap is a trap

Memory-mapped files look attractive (zero copy, OS page cache, huge files with small RSS), but they come with operational complexity that rarely shows up in tutorials. Three traps to know about. First, a page fault on mmap'd memory stalls the goroutine and can trigger a thread creation in the Go runtime if many goroutines fault simultaneously, producing surprising thread-count spikes. For an unbacked region (swap, dead NFS mount), the fault can hang indefinitely. Second, the OS page cache is shared across all processes on the host. An mmap'd multi-gigabyte file evicts everyone else's cached pages, which looks fine in isolation but causes mysterious performance degradation for neighboring services on the same host. Third, mmap'd memory does not respect `GOMEMLIMIT` and does not appear in Go heap profiles, so an mmap-heavy service can OOM-kill with a 50 MB Go heap profile that looks healthy. The staff-engineer decision: use mmap when the file is read-mostly, the working set is known, and the deployment is dedicated (no noisy-neighbor concerns). Avoid it when any of those assumptions fails. Write the reasoning down in an ADR so the next engineer does not discover these traps in production.

### 2.6 Hot/cold split as a first-class design pattern

The hot/cold split shown in section 2.1 (`HotData` + `*ColdData`) is not just a micro-optimization. It is a design pattern that deserves explicit consideration every time a struct grows beyond 64 bytes or crosses 128 bytes. The rule of thumb: if more than 90 percent of accesses touch less than 25 percent of the fields, split. Concrete examples: an HTTP request struct where most handlers only read method, path, and a few headers (hot), but some handlers read the full header map and body (cold). A user record where authorization reads role and expiry (hot), but account-settings pages read the full profile (cold). A cache entry where serving reads value and TTL (hot), but eviction metadata reads last-access time and hit count (cold). Engineers who internalize this pattern produce data structures that stay cache-friendly as they evolve. Engineers who do not accumulate "god structs" that eventually need expensive rescues.

---
