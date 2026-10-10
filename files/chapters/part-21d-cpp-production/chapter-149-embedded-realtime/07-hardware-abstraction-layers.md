## Hardware Abstraction Layers (HAL)

A hardware abstraction layer separates the firmware that runs the application from the code that talks to the hardware. Without it, every function that blinks an LED, sends a UART byte, or reads an ADC value is embedded with vendor-specific register accesses. When the MCU family changes, and it does, when the original part is discontinued or a cost-reduction mandate lands, every peripheral access in the codebase requires rewriting.

A well-designed HAL pays for itself the first time a project gets ported.

### HAL Design Principles

The goal is a clean interface that application code calls, with MCU-specific implementations behind it. Application code depends only on the interface. The concrete implementation can be swapped at link time without touching application code, and, critically, can be replaced with a mock during unit testing on the host PC.

```
Application code
    ↓ calls
[IUART interface] -- abstract
    ↓ implemented by
[STM32_UART] or [MockUART] -- concrete
```

**Runtime polymorphism via vtable** is the obvious C++ mechanism, but it has costs: a virtual function call is an indirect branch through a pointer, which may miss branch prediction and incur I/D cache pressure on complex Cortex-M7 systems. In a control loop ISR running every 100 μs, even a single pipeline flush matters.

**CRTP (Curiously Recurring Template Pattern)** provides compile-time polymorphism: the abstraction is resolved at compile time by the template instantiation, generating a direct call with no virtual dispatch overhead.

### CRTP-Based HAL: Zero-Overhead Polymorphism

Virtual dispatch enables runtime polymorphism: the compiler inserts an indirect call through a vtable so that the correct derived-class method is invoked regardless of the static pointer type. Understanding vtable layout and the overhead of virtual calls is important when designing hot paths in performance-sensitive code.
```cpp
// Base class: defines the interface via CRTP
template<typename Derived>
class GpioBase {
public:
    void set_high() {
        static_cast<Derived*>(this)->set_high_impl();
    }
    void set_low() {
        static_cast<Derived*>(this)->set_low_impl();
    }
    bool read() {
        return static_cast<Derived*>(this)->read_impl();
    }
    void toggle() {
        if (read()) set_low(); else set_high();
    }
};

// STM32F4 implementation: accesses hardware registers directly
class Stm32Gpio : public GpioBase<Stm32Gpio> {
    GPIO_TypeDef* port_;
    uint16_t      pin_mask_;
public:
    Stm32Gpio(GPIO_TypeDef* port, uint16_t pin)
        : port_(port), pin_mask_(1U << pin) {}

    void set_high_impl() { port_->BSRR = pin_mask_; }
    void set_low_impl()  { port_->BSRR = static_cast<uint32_t>(pin_mask_) << 16; }
    bool read_impl()     { return (port_->IDR & pin_mask_) != 0; }
};

// Host mock: no hardware, for unit tests on PC
class MockGpio : public GpioBase<MockGpio> {
    bool state_ = false;
public:
    void set_high_impl() { state_ = true; }
    void set_low_impl()  { state_ = false; }
    bool read_impl()     { return state_; }
    bool get_state()     { return state_; }  // Test inspection
};
```

When `Stm32Gpio::toggle()` is called, the compiler sees `GpioBase<Stm32Gpio>::toggle()`, which calls `set_low_impl()` on the concrete `Stm32Gpio`, resolved at compile time, inlined to a register write, no vtable lookup. Disassembly shows a direct `str` instruction to the BSRR address.

### UART HAL with Both Polymorphism Styles

Virtual dispatch enables runtime polymorphism: the compiler inserts an indirect call through a vtable so that the correct derived-class method is invoked regardless of the static pointer type. Understanding vtable layout and the overhead of virtual calls is important when designing hot paths in performance-sensitive code.
```cpp
// Runtime interface (vtable) -- for application code that handles multiple UARTs
class IUart {
public:
    virtual ~IUart() = default;
    virtual void        write(const uint8_t* data, size_t len) = 0;
    virtual size_t      read(uint8_t* buf, size_t max_len)     = 0;
    virtual bool        data_available()                       = 0;
};

// STM32 implementation
class Stm32Uart : public IUart {
    USART_TypeDef* uart_;
    // ... ring buffer for RX, DMA for TX ...
public:
    explicit Stm32Uart(USART_TypeDef* uart) : uart_(uart) {}

    void write(const uint8_t* data, size_t len) override {
        for (size_t i = 0; i < len; ++i) {
            while (!(uart_->SR & USART_SR_TXE)) {}  // Blocking poll -- only in non-real-time paths
            uart_->DR = data[i];
        }
    }

    size_t read(uint8_t* buf, size_t max_len) override {
        size_t count = 0;
        while (count < max_len && uart_read_byte(buf[count])) {
            ++count;
        }
        return count;
    }

    bool data_available() override {
        return g_rx_head != g_rx_tail;
    }
};

// Mock for host testing
class MockUart : public IUart {
    uint8_t tx_buf_[512];
    size_t  tx_len_ = 0;
    uint8_t rx_inject_[512];
    size_t  rx_len_ = 0, rx_pos_ = 0;
public:
    void write(const uint8_t* data, size_t len) override {
        if (tx_len_ + len <= sizeof(tx_buf_))
            memcpy(tx_buf_ + tx_len_, data, len), tx_len_ += len;
    }
    size_t read(uint8_t* buf, size_t max_len) override {
        size_t avail = rx_len_ - rx_pos_;
        size_t n = avail < max_len ? avail : max_len;
        memcpy(buf, rx_inject_ + rx_pos_, n);
        rx_pos_ += n;
        return n;
    }
    bool data_available() override { return rx_pos_ < rx_len_; }

    // Test helpers
    const uint8_t* sent_data() const { return tx_buf_; }
    size_t         sent_len()  const { return tx_len_; }
    void inject_rx(const uint8_t* data, size_t len) {
        memcpy(rx_inject_, data, len);
        rx_len_ = len; rx_pos_ = 0;
    }
};
```

### SPI Flash Driver Using HAL Interface

A complete driver that reads from an SPI NOR flash, fully testable on PC with a mock SPI.

```cpp
// ISpi interface (CRTP version for embedded, vtable version for tests)
class ISpi {
public:
    virtual ~ISpi() = default;
    virtual void transfer(const uint8_t* tx, uint8_t* rx, size_t len) = 0;
    virtual void cs_assert()   = 0;
    virtual void cs_deassert() = 0;
};

class SpiFlashDriver {
    ISpi& spi_;

    static constexpr uint8_t CMD_READ       = 0x03;
    static constexpr uint8_t CMD_READ_STATUS = 0x05;
    static constexpr uint8_t CMD_WRITE_ENABLE = 0x06;

public:
    explicit SpiFlashDriver(ISpi& spi) : spi_(spi) {}

    bool read(uint32_t addr, uint8_t* out, size_t len) {
        uint8_t cmd[4] = {
            CMD_READ,
            static_cast<uint8_t>(addr >> 16),
            static_cast<uint8_t>(addr >>  8),
            static_cast<uint8_t>(addr >>  0),
        };
        spi_.cs_assert();
        spi_.transfer(cmd, nullptr, 4);
        spi_.transfer(nullptr, out, len);
        spi_.cs_deassert();
        return true;
    }

    uint8_t read_status() {
        uint8_t cmd  = CMD_READ_STATUS;
        uint8_t stat = 0;
        spi_.cs_assert();
        spi_.transfer(&cmd, nullptr, 1);
        spi_.transfer(nullptr, &stat, 1);
        spi_.cs_deassert();
        return stat;
    }
};
```

Unit test (runs on PC, no MCU needed):

```cpp
// test_spi_flash.cpp -- compiled and run on host
#include <cassert>
#include <cstring>

class MockSpi : public ISpi {
public:
    uint8_t  rx_inject[512]{};
    uint8_t  tx_captured[512]{};
    size_t   tx_pos = 0;
    bool     cs_state = false;

    void transfer(const uint8_t* tx, uint8_t* rx, size_t len) override {
        if (tx) memcpy(tx_captured + tx_pos, tx, len);
        tx_pos += len;
        if (rx) memcpy(rx, rx_inject, len);
    }
    void cs_assert()   override { cs_state = true;  }
    void cs_deassert() override { cs_state = false; }
};

void test_spi_flash_read() {
    MockSpi  mock;
    uint8_t  expected[4] = {0xDE, 0xAD, 0xBE, 0xEF};
    memcpy(mock.rx_inject, expected, 4);

    SpiFlashDriver driver(mock);
    uint8_t result[4]{};
    driver.read(0x001000, result, 4);

    // Verify command bytes sent
    assert(mock.tx_captured[0] == 0x03);  // READ command
    assert(mock.tx_captured[1] == 0x00);  // addr[23:16]
    assert(mock.tx_captured[2] == 0x10);  // addr[15:8]
    assert(mock.tx_captured[3] == 0x00);  // addr[7:0]
}
```

This driver tests on a developer's laptop with no hardware, and the same source file links against the real STM32 SPI implementation for production. The HAL interface is the only change between builds.

### STM32 HAL vs LL vs Raw Registers

ST Microelectronics provides three levels of driver abstraction for their STM32 family:

| Level | Description | Pros | Cons |
|---|---|---|---|
| **STM32 HAL** | High-level, portable across STM32 families | Easy, well-documented, CubeMX generated | Overhead (state machines, error checks), non-deterministic timing in some cases |
| **STM32 LL (Low Level)** | Thin wrappers around register writes | Minimal overhead, deterministic, readable | More verbose, still not zero-cost |
| **Raw CMSIS registers** | Direct `USART1->CR1 \|= ...` | Maximum control, zero overhead | MCU-family-specific, tedious |

For ASIL-B and above automotive applications, HAL functions whose internal behavior is non-deterministic (e.g., `HAL_UART_Transmit` with timeout polling) are replaced with LL or raw register access in WCET-sensitive paths.

### Go Comparison

Go's `io.Reader` and `io.Writer` interfaces serve the same purpose as embedded HAL interfaces. A `bufio.Reader` wraps any `io.Reader` without knowing whether it is a file, a network connection, or a test stub. Go engineers naturally write code against interfaces. Embedded C++ with CRTP or vtable-based HALs teaches exactly the same discipline. The key difference is that in Go, the interface dispatch is always virtual (a two-word fat pointer), while CRTP in C++ achieves the same abstraction with zero runtime cost. Go programmers moving to C++ for embedded work should recognize the pattern immediately and appreciate that the compiler can do what Go's runtime does dynamically.

---
