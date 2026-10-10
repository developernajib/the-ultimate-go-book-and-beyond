## Register Abstractions

The most common bug in embedded firmware is writing the wrong bit to the wrong register. The hardware accepts the write silently and the system misbehaves later, often in an interrupt handler that runs before the symptom is observed. C compilers cannot help because every register is the same `volatile uint32_t*` to them. C++ can help because the type system can encode every register, every field, and every legal value, so the wrong write becomes a compilation error.

### The C Baseline

The CMSIS-Core headers from Arm describe peripherals as C structs. A typical USART definition looks like:

```c
typedef struct {
    volatile uint32_t CR1;
    volatile uint32_t CR2;
    volatile uint32_t CR3;
    volatile uint32_t BRR;
    // ...
} USART_TypeDef;

#define USART2 ((USART_TypeDef*)0x40004400)
#define USART_CR1_UE   (1u << 0)
#define USART_CR1_RE   (1u << 2)
#define USART_CR1_TE   (1u << 3)
```

Application code:

```c
USART2->CR1 |= USART_CR1_UE | USART_CR1_RE | USART_CR1_TE;
```

This works. It is also the source of every "I wrote to the wrong peripheral" bug. The struct is a `USART_TypeDef`, but nothing prevents you from `((USART_TypeDef*)SPI1)->CR1 = ...`. The `|=` is read-modify-write, which on registers with self-clearing bits causes silent corruption. Reserved bits are not protected.

### The C++ Improvement

The first level of C++ improvement is wrapping each peripheral in a class with named methods:

```cpp
class Usart {
    USART_TypeDef* const regs_;
public:
    explicit Usart(USART_TypeDef* r) : regs_(r) {}

    void enable() noexcept {
        regs_->CR1 |= (1u << 0);
    }
    void enable_tx() noexcept { regs_->CR1 |= (1u << 3); }
    void enable_rx() noexcept { regs_->CR1 |= (1u << 2); }
    void set_baud(std::uint32_t pclk, std::uint32_t baud) noexcept {
        regs_->BRR = (pclk + baud / 2) / baud;
    }
    void write(std::uint8_t b) noexcept {
        while (!(regs_->ISR & (1u << 7))) {}
        regs_->TDR = b;
    }
};

Usart debug{USART2};
debug.set_baud(84'000'000, 115200);
debug.enable_tx();
debug.enable();
```

This is clearer but the magic numbers are still in the implementation. The next level encodes the bits as types.

### Type-Safe Register Access With Templates

The Kvasir, CMSIS-RTOS2, and Embo libraries take type-safe registers further. The idea is that each register is a distinct type, each field is a distinct type, and each legal value is a distinct type. The compiler then refuses to combine them incorrectly.

```cpp
template <std::uintptr_t Addr, typename T = std::uint32_t>
struct Mmio {
    static T read() noexcept {
        return *reinterpret_cast<volatile T*>(Addr);
    }
    static void write(T v) noexcept {
        *reinterpret_cast<volatile T*>(Addr) = v;
    }
    static void modify(T mask, T value) noexcept {
        T tmp = read();
        tmp = (tmp & ~mask) | (value & mask);
        write(tmp);
    }
};

template <std::uintptr_t Addr, std::uint32_t Pos, std::uint32_t Width = 1>
struct Field {
    static constexpr std::uint32_t mask = ((1u << Width) - 1) << Pos;
    using Reg = Mmio<Addr>;
    static void set(std::uint32_t value) noexcept {
        Reg::modify(mask, (value << Pos) & mask);
    }
    static std::uint32_t get() noexcept {
        return (Reg::read() & mask) >> Pos;
    }
};

namespace usart2 {
    constexpr std::uintptr_t base = 0x40004400;
    using CR1 = Mmio<base + 0x00>;
    using BRR = Mmio<base + 0x0C>;
    using ISR = Mmio<base + 0x1C>;
    using TDR = Mmio<base + 0x28>;

    using UE = Field<base + 0x00, 0>;
    using RE = Field<base + 0x00, 2>;
    using TE = Field<base + 0x00, 3>;
}

void uart_init(std::uint32_t pclk, std::uint32_t baud) {
    usart2::BRR::write((pclk + baud/2) / baud);
    usart2::TE::set(1);
    usart2::RE::set(1);
    usart2::UE::set(1);
}
```

Every field is a distinct type. Writing `usart2::UE::set(2)` is undefined for a 1-bit field. Writing `usart2::TE::set(1)` to a register that does not exist is a compilation error. The generated code is identical to the C version because every operation collapses to a constant offset and a load-store pair.

### Volatile Semantics

The `volatile` keyword tells the compiler that loads and stores to a location have observable side effects beyond reading or writing the value. It must not optimize them away, must not reorder them with respect to each other, and must not coalesce them.

What `volatile` does NOT do:

1. It does not provide multi-threaded synchronization. Two threads accessing the same `volatile` variable still race. Use `std::atomic` for that.
2. It does not insert memory barriers. The compiler does not reorder volatile accesses, but the CPU might. On Cortex-M0/M3/M4 the architecture happens to be strongly ordered for device memory regions, but on Cortex-M7 with caches and store buffers, you need explicit barriers.

```cpp
template <std::uintptr_t Addr>
inline void write_with_barrier(std::uint32_t value) noexcept {
    *reinterpret_cast<volatile std::uint32_t*>(Addr) = value;
    asm volatile("dsb" ::: "memory");
}
```

The `dsb` (data synchronization barrier) ensures all prior memory accesses complete before any subsequent instructions execute. Required after enabling a peripheral if the next instruction depends on it being on. Required before triggering a DMA if the buffer must be coherent.

### Memory Barriers in C++

The C++ standard library provides `std::atomic_thread_fence(std::memory_order_seq_cst)` which the compiler lowers to `dsb` on Cortex-M. For embedded code this is portable across compilers, unlike the inline assembly version.

```cpp
void start_dma_transfer(std::span<const std::uint8_t> buf) {
    DMA1_Stream6->M0AR = reinterpret_cast<std::uintptr_t>(buf.data());
    DMA1_Stream6->NDTR = buf.size();
    std::atomic_thread_fence(std::memory_order_release);
    DMA1_Stream6->CR |= DMA_SxCR_EN;
}
```

The fence ensures the DMA controller sees the address and count writes before the enable bit, regardless of the store buffer behavior on the CPU.

### Write-Only Registers

A common register category is "write 1 to clear" or "write only." Reading them returns zero or garbage. The naive `|=` pattern is wrong for these registers because it reads first.

```cpp
// WRONG: reads garbage, writes back garbage with one bit set
NVIC->ICPR[0] |= (1u << irq);

// RIGHT: write the bit pattern only
NVIC->ICPR[0] = (1u << irq);
```

Encoding this in the type system prevents the bug:

```cpp
template <std::uintptr_t Addr, typename T = std::uint32_t>
struct WriteOnlyReg {
    static void write(T v) noexcept {
        *reinterpret_cast<volatile T*>(Addr) = v;
    }
    // no read(), no modify(): the type prohibits the bug
};
```

### Generated Headers

The CMSIS SVD (System View Description) files from each silicon vendor describe every peripheral's registers, fields, and reset values in XML. Tools like `svd2rust` (for Rust) and `cmsis_svd` plus custom generators produce C++ headers from SVD. Major shops generate their own, the result is a header per peripheral with type-safe field accessors and no possibility of typing the wrong address.

A small example of generated output:

```cpp
namespace stm32::gpioa {
    constexpr std::uintptr_t base = 0x40020000;
    struct MODER {
        static constexpr std::uintptr_t addr = base + 0x00;
        static constexpr std::uint32_t reset = 0xA8000000;
        template <int Pin> using Mode = Field<addr, Pin*2, 2>;
    };
    struct ODR {
        static constexpr std::uintptr_t addr = base + 0x14;
        template <int Pin> using Bit = Field<addr, Pin>;
    };
}

void blink_pa5() {
    using namespace stm32::gpioa;
    MODER::Mode<5>::set(0b01);   // output
    ODR::Bit<5>::set(1);
}
```

The `Pin` template parameter is a compile-time constant. The compiler folds the entire chain into two store instructions. The C version that does the same thing is `GPIOA->MODER = (GPIOA->MODER & ~(0b11 << 10)) | (0b01 << 10); GPIOA->ODR |= (1u << 5);`, with a higher chance of typing 11 instead of 10.

### RAII for Peripherals

The RAII pattern wraps the lifecycle of a peripheral in an object's lifetime. Acquiring the peripheral configures it. Releasing it returns it to a known state. The destructor cannot be skipped, even on early return or exception (in builds where exceptions are enabled).

```cpp
class SpiTransaction {
    SpiBus& bus_;
public:
    explicit SpiTransaction(SpiBus& bus, GpioPin cs) : bus_(bus) {
        bus_.lock();
        cs.set_low();
    }
    ~SpiTransaction() {
        bus_.cs_pin().set_high();
        bus_.unlock();
    }
    SpiTransaction(const SpiTransaction&) = delete;
    SpiTransaction& operator=(const SpiTransaction&) = delete;

    std::uint8_t transfer(std::uint8_t b) { return bus_.transfer(b); }
};

void read_sensor() {
    SpiTransaction tx{spi1, sensor_cs};
    tx.transfer(0x80);   // read register
    auto value = tx.transfer(0x00);
    // CS released, lock released, regardless of how the function exits
}
```

This is one of the highest-use patterns in embedded C++. Every shared peripheral, every DMA channel, every critical section, every interrupt mask state should be wrapped this way.

---
