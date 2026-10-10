## CAN, I2C, SPI, UART Buses

Most of the C++ in an embedded product is not application logic. It is bus drivers. CAN frames between ECUs in a vehicle, I2C transactions to a gyroscope, SPI bursts to an external flash, UART bytes to a GPS receiver. Senior firmware engineers know these protocols cold and can write a driver for any of them in a few hours.

### CAN and CAN-FD

Controller Area Network was developed by Bosch in the 1980s for automotive use. Every modern vehicle has multiple CAN buses (powertrain, chassis, body, infotainment) plus newer CAN-FD buses with higher data rates.

A CAN frame:

- 11-bit (standard) or 29-bit (extended) identifier
- 0 to 8 bytes of data (CAN 2.0) or 0 to 64 bytes (CAN-FD)
- 15-bit CRC, ACK slot, end-of-frame marker

CAN is multi-master with arbitration. Multiple nodes try to transmit at once, the lower-numbered ID wins (lower number = higher priority). Losing nodes back off and retry after the winner finishes. The arbitration is bit-by-bit on the wire and requires no central coordinator.

A C++ CAN driver wraps the silicon controller (bxCAN on STM32F4, FDCAN on STM32H7, MCAN on NXP RT) and exposes a clean interface:

```cpp
struct CanFrame {
    std::uint32_t id;
    std::uint8_t  dlc;          // data length code
    std::uint8_t  data[8];
    bool          extended;
    bool          rtr;          // remote frame
    std::uint32_t timestamp;
};

class CanBus {
public:
    virtual bool send(const CanFrame& frame, std::uint32_t timeout_ms) = 0;
    virtual bool receive(CanFrame& frame, std::uint32_t timeout_ms) = 0;
    virtual std::uint32_t bus_off_count() const = 0;
    virtual void recover_from_bus_off() = 0;
    virtual ~CanBus() = default;
};
```

The error counters and bus-off recovery are the parts that distinguish a real driver from a tutorial. CAN has a transmit error counter (TEC) and receive error counter (REC). When TEC exceeds 255 the controller enters bus-off state and stops transmitting. The driver must detect this, log it, and either auto-recover (after a quiet period) or notify the application.

```cpp
void STM32CanBus::handle_irq() {
    if (CAN1->ESR & CAN_ESR_BOFF) {
        ++bus_off_count_;
        log_warning("CAN bus-off detected, recovering");
        // Set INRQ to enter init mode, then clear to leave
        CAN1->MCR |= CAN_MCR_INRQ;
        while (!(CAN1->MSR & CAN_MSR_INAK)) {}
        CAN1->MCR &= ~CAN_MCR_INRQ;
    }
}
```

### ISO-TP

CAN frames are limited to 8 (or 64) bytes. Larger messages use ISO 15765-2, known as ISO-TP, which fragments a multi-byte payload into a sequence of CAN frames with a small header indicating frame type and offset. ISO-TP is the transport layer for OBD-II, UDS (ISO 14229), and the diagnostic protocols used for ECU firmware update.

```cpp
class IsoTpSession {
    CanBus& bus_;
    std::uint32_t tx_id_;
    std::uint32_t rx_id_;
public:
    bool send(std::span<const std::uint8_t> payload) {
        if (payload.size() <= 7) {
            return send_single_frame(payload);
        }
        return send_multi_frame(payload);
    }
private:
    bool send_single_frame(std::span<const std::uint8_t> data) {
        CanFrame f{};
        f.id = tx_id_;
        f.dlc = data.size() + 1;
        f.data[0] = 0x00 | data.size();           // SF, length
        std::copy(data.begin(), data.end(), &f.data[1]);
        return bus_.send(f, 100);
    }
    bool send_multi_frame(std::span<const std::uint8_t> data) {
        // First Frame: type 0x10, 12 bits of length, 6 bytes of data
        CanFrame f{};
        f.id = tx_id_;
        f.dlc = 8;
        f.data[0] = 0x10 | ((data.size() >> 8) & 0x0F);
        f.data[1] = data.size() & 0xFF;
        std::copy_n(data.begin(), 6, &f.data[2]);
        if (!bus_.send(f, 100)) return false;

        // Wait for FlowControl frame from receiver
        CanFrame fc;
        if (!bus_.receive(fc, 1000)) return false;
        // ... handle block size and STmin from FC

        // Send Consecutive Frames
        std::uint8_t sn = 1;
        std::size_t offset = 6;
        while (offset < data.size()) {
            f.data[0] = 0x20 | (sn & 0x0F);
            std::size_t chunk = std::min<std::size_t>(7, data.size() - offset);
            std::copy_n(&data[offset], chunk, &f.data[1]);
            f.dlc = chunk + 1;
            if (!bus_.send(f, 100)) return false;
            offset += chunk;
            sn = (sn + 1) & 0x0F;
        }
        return true;
    }
};
```

OBD-II and UDS sit on top of ISO-TP. OBD-II is the standardized diagnostic protocol mandated for emissions readiness. UDS (Unified Diagnostic Services, ISO 14229) is the broader diagnostic protocol used for ECU programming, sensor calibration, and security access. A scan tool plugs into the OBD-II port, talks ISO-TP over CAN, and sends UDS service requests to each ECU.

### I2C and SMBus

I2C is a 2-wire master-slave protocol with 7-bit addressing. SMBus is a stricter variant used in PCs and some industrial systems. The wire-level protocol is identical for I2C and SMBus. SMBus adds timeout, packet error checking, and stricter timing.

A common gotcha: address conflicts. Many sensor parts have a fixed 7-bit address (e.g. BME280 at 0x76 or 0x77). Two parts at the same address on the same bus do not work. The fix is either an address-select pin on one part, a separate bus, or an I2C multiplexer (TCA9548A or similar).

A C++ I2C transaction with timeout and clock stretching support:

```cpp
class I2cBus {
public:
    enum class Result { Ok, Nack, Timeout, ArbitrationLost, ClockStretchTimeout };

    Result write(std::uint8_t addr, std::span<const std::uint8_t> data, std::uint32_t timeout_ms) {
        regs_->CR2 = (addr << 1) | (data.size() << 16) | I2C_CR2_START;
        for (auto b : data) {
            if (!wait_txis(timeout_ms)) return Result::Timeout;
            if (regs_->ISR & I2C_ISR_NACKF) return Result::Nack;
            regs_->TXDR = b;
        }
        if (!wait_complete(timeout_ms)) return Result::Timeout;
        regs_->CR2 |= I2C_CR2_STOP;
        return Result::Ok;
    }

    Result read(std::uint8_t addr, std::span<std::uint8_t> data, std::uint32_t timeout_ms) {
        regs_->CR2 = (addr << 1) | I2C_CR2_RD_WRN | (data.size() << 16) | I2C_CR2_START;
        for (auto& b : data) {
            if (!wait_rxne(timeout_ms)) return Result::Timeout;
            b = regs_->RXDR;
        }
        regs_->CR2 |= I2C_CR2_STOP;
        return Result::Ok;
    }

private:
    I2C_TypeDef* regs_;
    bool wait_txis(std::uint32_t to_ms) { /* ... */ return true; }
    bool wait_rxne(std::uint32_t to_ms) { /* ... */ return true; }
    bool wait_complete(std::uint32_t to_ms) { /* ... */ return true; }
};
```

Clock stretching: a slow slave can hold SCL low to delay the master. The master must wait. Some controllers have a clock stretch timeout that times out the transaction if a slave holds SCL too long. Sensors with internal ADCs (BME280) commonly stretch the clock during conversion.

### SPI

SPI is a synchronous master-slave protocol with separate clock, data-in, data-out, and chip-select lines. It is fast (typical bus rates 10-50 MHz, peak 100+ MHz) but uses more pins than I2C. There is no addressing, the master selects a slave by asserting CS.

The classic embedded use case is bursting data to a display, reading a flash chip, or talking to a sensor that has more registers than I2C bandwidth supports.

```cpp
class SpiMaster {
public:
    void transfer(std::span<const std::uint8_t> tx, std::span<std::uint8_t> rx) {
        for (std::size_t i = 0; i < tx.size(); ++i) {
            while (!(regs_->SR & SPI_SR_TXE)) {}
            regs_->DR = tx[i];
            while (!(regs_->SR & SPI_SR_RXNE)) {}
            std::uint8_t b = regs_->DR;
            if (i < rx.size()) rx[i] = b;
        }
    }

    // DMA-driven double-buffered transfer for high throughput
    void transfer_dma(std::span<const std::uint8_t> tx) {
        DMA1_Stream4->M0AR = reinterpret_cast<std::uintptr_t>(tx.data());
        DMA1_Stream4->NDTR = tx.size();
        std::atomic_thread_fence(std::memory_order_release);
        DMA1_Stream4->CR |= DMA_SxCR_EN;
        regs_->CR2 |= SPI_CR2_TXDMAEN;
    }

private:
    SPI_TypeDef* regs_;
};
```

Double-buffered DMA for an SD card driver or a TFT display: the DMA controller alternates between two buffers, while one is being transferred, the application fills the other. This sustains 50 MB/s SPI throughput with negligible CPU overhead.

### UART with DMA Ring Buffer

A UART receiving at 115200 baud delivers a byte every 87 microseconds. Polling is fine. At 3 megabits, bytes arrive every 3 microseconds and the CPU cannot keep up. The standard solution is DMA with a circular buffer.

```cpp
class UartRingBuffer {
    static constexpr std::size_t kSize = 1024;
    alignas(4) std::uint8_t buffer_[kSize];
    std::size_t read_idx_ = 0;
    USART_TypeDef* regs_;
    DMA_Stream_TypeDef* dma_;
public:
    void start() {
        dma_->M0AR = reinterpret_cast<std::uintptr_t>(buffer_);
        dma_->NDTR = kSize;
        dma_->CR |= DMA_SxCR_CIRC | DMA_SxCR_EN;
        regs_->CR3 |= USART_CR3_DMAR;
    }

    std::size_t available() const {
        std::size_t write_idx = kSize - dma_->NDTR;
        if (write_idx >= read_idx_) return write_idx - read_idx_;
        return kSize - read_idx_ + write_idx;
    }

    std::size_t read(std::span<std::uint8_t> dst) {
        std::size_t avail = available();
        std::size_t n = std::min(dst.size(), avail);
        for (std::size_t i = 0; i < n; ++i) {
            dst[i] = buffer_[read_idx_];
            read_idx_ = (read_idx_ + 1) % kSize;
        }
        return n;
    }
};
```

The DMA controller writes incoming bytes to the buffer in circular mode without CPU involvement. The application periodically polls `available()` to find new data, which it copies out. The position is computed from the DMA controller's NDTR register, which decrements as bytes are transferred. When NDTR reaches zero, the DMA wraps to the start of the buffer.

The two pitfalls are buffer overrun (application reads slower than data arrives, the DMA wraps around and overwrites unread data) and missed framing errors (a single bit error mid-stream throws the parser off). Robust designs include sequence numbers or framing escape characters in the protocol so that the parser can resync.

### Error Counters and Retry Logic

Every bus driver should expose error counters. Application code uses them for health monitoring:

```cpp
struct BusStats {
    std::uint32_t tx_count;
    std::uint32_t rx_count;
    std::uint32_t tx_errors;
    std::uint32_t rx_errors;
    std::uint32_t timeouts;
    std::uint32_t bus_off;
};
```

A retry policy in C++:

```cpp
template <typename Op>
auto retry(Op&& op, int max_attempts, std::uint32_t base_delay_ms) {
    for (int attempt = 0; attempt < max_attempts; ++attempt) {
        auto result = op();
        if (result == Result::Ok) return result;
        // Exponential backoff with jitter
        std::uint32_t delay = base_delay_ms << attempt;
        delay += rand() % (delay / 4 + 1);
        vTaskDelay(pdMS_TO_TICKS(delay));
    }
    return Result::Timeout;
}

auto result = retry([&]{ return sensor.read_register(REG_TEMP); }, 3, 10);
```

Three retries with exponential backoff handle transient bus issues without cascading failure. After three failures, the driver reports the error to the application, which decides whether to mark the device offline, switch to a backup sensor, or trigger a higher-level recovery.

---
