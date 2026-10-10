## FPGA Integration

When software on a CPU cannot meet latency requirements, the next step is FPGAs. A field-programmable gate array is not a processor running code, it is a reconfigurable array of logic gates and memory that you wire together to implement a specific function. Where a CPU executes instructions sequentially (even with instruction-level parallelism), an FPGA executes all its logic simultaneously in a fully pipelined manner. The result is deterministic, pipeline-latency processing of 100-500 ns regardless of input complexity.

### Why FPGAs in HFT

Consider what happens when a market data packet arrives at a CPU-based HFT system:

1. Packet arrives at NIC (hardware timestamp recorded).
2. DPDK poll mode driver reads the packet from NIC descriptor ring (~50 ns).
3. CPU parses Ethernet/IP/UDP headers (~20 ns).
4. CPU decodes exchange protocol (FIX, ITCH, PITCH) (~100-500 ns).
5. CPU updates order book (~50 ns).
6. CPU evaluates trading signal (~100-500 ns).
7. CPU constructs and sends order (~100 ns).

Total: 400-1,200 ns in a well-tuned software system.

With an FPGA handling steps 3-6, the FPGA receives the raw packet from the NIC optical port and produces an order decision in a single pipeline pass of 100-300 ns. The entire protocol decode, order book update, and signal evaluation happen in parallel hardware logic, not sequential instructions.

### FPGA Roles in the HFT Stack

**Market data parsing**: Exchange protocols like NASDAQ ITCH 5.0 have fixed-format binary messages. An FPGA can decode the entire message in a single clock cycle (4-8 ns at 250 MHz) and output a parsed struct directly into a register or BRAM.

**Order routing**: Once the FPGA computes a trading decision, it can construct and transmit the order packet directly from the FPGA's network port, bypassing the CPU entirely. Firms using this architecture achieve wire-to-wire latency (market data in → order out) of 150-400 ns.

**Pre-trade risk**: Position limits, order rate limits, and notional size checks can be implemented as combinational logic in the FPGA. A risk check that takes 200 ns in C++ takes 4 ns in FPGA logic.

### FPGA Hardware Connection to CPU

FPGAs communicate with the host CPU via PCIe. The FPGA appears as a PCIe endpoint. The CPU accesses it through BAR (Base Address Register) regions mapped into physical memory.

There are two communication patterns:

**MMIO (Memory-Mapped I/O)**: CPU writes to a BAR register to send commands. FPGA writes to a BAR register to signal completion. Low-bandwidth, very low latency for small messages.

**DMA (Direct Memory Access)**: FPGA reads or writes to host physical memory without CPU involvement. High bandwidth for bulk data transfer. Requires physically contiguous memory (use hugepages or CMA).

```cpp
#include <sys/mman.h>
#include <sys/types.h>
#include <sys/stat.h>
#include <fcntl.h>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <stdexcept>

// FPGA BAR0 register layout (vendor-specific - this is illustrative)
struct FPGARegisters {
    volatile uint64_t status;         // 0x00: FPGA status and capabilities
    volatile uint64_t command;        // 0x08: command register
    volatile uint64_t dma_src_addr;   // 0x10: DMA source (host physical addr)
    volatile uint64_t dma_dst_addr;   // 0x18: DMA destination (FPGA BRAM addr)
    volatile uint32_t dma_length;     // 0x20: DMA transfer length in bytes
    volatile uint32_t dma_control;    // 0x24: DMA start/status flags
    volatile uint64_t order_result;   // 0x28: Output order from FPGA signal engine
    volatile uint64_t latency_cycles; // 0x30: FPGA-measured processing latency
};

static constexpr uint64_t CMD_PROCESS_MARKET_DATA  = 0x01;
static constexpr uint64_t CMD_RESET                = 0x02;
static constexpr uint32_t DMA_START                = 0x01;
static constexpr uint32_t DMA_DONE                 = 0x02;

class FPGAInterface {
    int            fd_{-1};
    FPGARegisters* regs_{nullptr};
    size_t         bar_size_{0};

    // Host-side DMA buffer: hugepage-backed, pinned
    void*    dma_buf_{nullptr};
    uint64_t dma_phys_addr_{0};
    size_t   dma_buf_size_{0};

public:
    explicit FPGAInterface(const char* pcie_resource_path, size_t bar_size)
        : bar_size_(bar_size)
    {
        // Open PCIe BAR resource file (e.g., /sys/bus/pci/devices/0000:04:00.0/resource0)
        fd_ = open(pcie_resource_path, O_RDWR | O_SYNC);
        if (fd_ < 0) throw std::runtime_error("Cannot open FPGA PCIe resource");

        regs_ = static_cast<FPGARegisters*>(
            mmap(nullptr, bar_size_, PROT_READ | PROT_WRITE, MAP_SHARED, fd_, 0)
        );
        if (regs_ == MAP_FAILED) throw std::runtime_error("Cannot mmap FPGA BAR");

        allocate_dma_buffer(4096 * 1024);  // 4 MB DMA buffer
    }

    ~FPGAInterface() {
        if (regs_)    munmap(regs_, bar_size_);
        if (fd_ >= 0) close(fd_);
        if (dma_buf_) munmap(dma_buf_, dma_buf_size_);
    }

    // Write market data into DMA buffer, trigger FPGA processing.
    // The FPGA will read the market data packet via DMA, decode it,
    // evaluate the trading signal, and write an order decision back
    // to the order_result register.
    uint64_t process_market_data(const void* packet, uint32_t len) {
        // Copy packet into DMA buffer (host side)
        std::memcpy(dma_buf_, packet, len);

        // Set up DMA transfer: FPGA reads from host DMA buffer
        regs_->dma_src_addr  = dma_phys_addr_;
        regs_->dma_dst_addr  = 0;   // FPGA internal BRAM offset 0
        regs_->dma_length    = len;
        regs_->dma_control   = DMA_START;

        // Trigger processing command
        regs_->command = CMD_PROCESS_MARKET_DATA;

        // Poll for completion -- in a real system the FPGA raises an
        // interrupt or writes to an atomic flag. Polling is faster for
        // < 1 μs operations but burns CPU. For HFT: poll.
        while (!(regs_->dma_control & DMA_DONE)) {
            __builtin_ia32_pause();  // PAUSE instruction: reduce power, hint spin
        }

        return regs_->order_result;
    }

    uint64_t last_fpga_latency_cycles() const {
        return regs_->latency_cycles;
    }

private:
    void allocate_dma_buffer(size_t size) {
        dma_buf_size_ = size;

        // Allocate hugepage-backed memory for DMA
        dma_buf_ = mmap(
            nullptr, size,
            PROT_READ | PROT_WRITE,
            MAP_PRIVATE | MAP_ANONYMOUS | MAP_HUGETLB,
            -1, 0
        );
        if (dma_buf_ == MAP_FAILED) {
            throw std::runtime_error("Cannot allocate DMA hugepage buffer");
        }

        // Lock pages to prevent swapping
        if (mlock(dma_buf_, size) < 0) {
            throw std::runtime_error("mlock failed -- run as root or set RLIMIT_MEMLOCK");
        }

        // Get physical address via /proc/self/pagemap
        dma_phys_addr_ = virt_to_phys(dma_buf_);
    }

    uint64_t virt_to_phys(void* vaddr) {
        int pagemap_fd = open("/proc/self/pagemap", O_RDONLY);
        if (pagemap_fd < 0) return 0;

        uint64_t virt_page = reinterpret_cast<uint64_t>(vaddr) / 4096;
        uint64_t entry = 0;
        pread(pagemap_fd, &entry, 8, virt_page * 8);
        close(pagemap_fd);

        if (!(entry & (1ULL << 63))) return 0;  // Page not present
        uint64_t phys_page = entry & ((1ULL << 55) - 1);
        return phys_page * 4096;
    }
};
```

### OpenCL for FPGA (Intel/Xilinx)

For FPGAs that support OpenCL (Intel Arria/Stratix, Xilinx Alveo), you can program the FPGA using a higher-level C-based kernel language and interface from C++ via the OpenCL runtime:

```cpp
#include <CL/cl.hpp>
#include <vector>
#include <string>

// Load and run an FPGA market data decoder kernel via OpenCL
class FPGAOpenCLDecoder {
    cl::Platform  platform_;
    cl::Device    device_;
    cl::Context   context_;
    cl::Program   program_;
    cl::Kernel    kernel_;
    cl::CommandQueue queue_;

public:
    FPGAOpenCLDecoder() {
        // Find FPGA platform
        std::vector<cl::Platform> platforms;
        cl::Platform::get(&platforms);
        platform_ = platforms[0];  // Select Xilinx or Intel FPGA platform

        std::vector<cl::Device> devices;
        platform_.getDevices(CL_DEVICE_TYPE_ACCELERATOR, &devices);
        device_ = devices[0];

        context_ = cl::Context(device_);
        queue_   = cl::CommandQueue(context_, device_);

        // Load pre-compiled FPGA binary (.xclbin for Xilinx, .aocx for Intel)
        auto binary = load_binary("market_data_decoder.xclbin");
        cl::Program::Binaries binaries{{binary.data(), binary.size()}};
        program_ = cl::Program(context_, {device_}, binaries);
        kernel_  = cl::Kernel(program_, "decode_itch_message");
    }

    // Execute FPGA kernel: decode one ITCH message
    void decode(const uint8_t* msg, uint16_t len, DecodedOrder& out) {
        cl::Buffer in_buf(context_, CL_MEM_READ_ONLY  | CL_MEM_COPY_HOST_PTR,
                          len, const_cast<uint8_t*>(msg));
        cl::Buffer out_buf(context_, CL_MEM_WRITE_ONLY, sizeof(DecodedOrder));

        kernel_.setArg(0, in_buf);
        kernel_.setArg(1, out_buf);
        kernel_.setArg(2, static_cast<uint32_t>(len));

        queue_.enqueueNDRangeKernel(kernel_, cl::NullRange, cl::NDRange(1));
        queue_.enqueueReadBuffer(out_buf, CL_TRUE, 0, sizeof(DecodedOrder), &out);
    }

private:
    std::vector<unsigned char> load_binary(const std::string& path);
};
```

### HLS: Write C++, Get FPGA Gates

High-Level Synthesis (HLS) tools, Xilinx Vitis HLS (formerly Vivado HLS) and Intel HLS Compiler, take C++ code annotated with pragmas and synthesize it into FPGA logic. This lets C++ engineers contribute to FPGA development without learning VHDL or Verilog:

```cpp
// This C++ function will be synthesized to FPGA hardware by Xilinx Vitis HLS.
// The #pragma directives control pipeline depth and memory allocation.
#pragma HLS PIPELINE II=1   // Initiation interval: accept new input every cycle

struct ITCHAddOrder {
    uint16_t stock_locate;
    uint64_t order_ref;
    char     side;       // 'B' or 'S'
    uint32_t shares;
    int32_t  price;      // Price in 1/10000 USD
};

// Synthesized function: parses raw bytes into ITCHAddOrder in one pipeline stage
void parse_add_order(
    const ap_uint<8>* raw,      // Input: raw packet bytes (HLS stream)
    ITCHAddOrder*     out,      // Output: parsed message
    ap_uint<1>*       valid     // Output: 1 if successfully parsed
) {
    #pragma HLS INTERFACE ap_fifo port=raw
    #pragma HLS INTERFACE ap_vld  port=out

    if (raw[0] != 'A') { *valid = 0; return; }  // Not an Add Order message

    out->stock_locate = (raw[1] << 8) | raw[2];
    // ... (big-endian field extraction synthesized to bit-select logic)
    out->shares = (raw[19] << 24) | (raw[20] << 16) | (raw[21] << 8) | raw[22];
    out->price  = (raw[32] << 24) | (raw[33] << 16) | (raw[34] << 8) | raw[35];
    out->side   = raw[18];
    *valid = 1;
}
```

### Who Uses FPGAs

Jump Trading, Citadel Securities, Virtu Financial, IMC, and Optiver all use FPGAs in their latency-critical paths. The specific implementations are trade secrets, but the general architecture is: FPGA receives raw optical signal from the exchange's multicast feed, decodes the protocol in hardware, updates an in-FPGA order book (BRAM-based), evaluates a pre-programmed signal, and transmits an order, all in < 500 ns from the first byte of the market data packet arriving at the FPGA's network port.

### Go Comparison

Go has no FPGA integration story. The PCIe BAR mmap, DMA buffer management, and hardware interrupt handling shown above all require direct OS interfaces that Go cannot access without CGo. More fundamentally, the design of FPGA code, pipelined, bit-width-specific, cycle-accurate, is incompatible with Go's memory-safe, garbage-collected runtime. FPGA development belongs to C++ (and VHDL/Verilog for the FPGA fabric itself).

---
