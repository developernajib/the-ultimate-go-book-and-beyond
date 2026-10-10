## Future and Trends

The embedded landscape in 2026 is in motion. RISC-V is taking real market share. Rust is pressuring C++ in safety-critical niches. AI-assisted code generation is changing how firmware is written. Regulatory mandates from the EU and the US are forcing security investments that many shops have postponed. Senior engineers should know the direction of each trend so they can position their teams and their codebases.

### RISC-V Momentum

RISC-V crossed the threshold from research curiosity to mainstream production in the 2022-2024 timeframe. Espressif's ESP32-C3 was the first volume RISC-V part in IoT, followed by the C6, H2, P4, and the upcoming C5. SiFive cores ship in NXP RT700 and Renesas RZ-Five. Tenstorrent uses SiFive cores in their AI accelerators. The RISC-V Foundation reported over 10 billion RISC-V cores shipped by end of 2024.

The driver is licensing economics. Arm royalties on a high-volume IoT part of \$0.50 BOM cost are a meaningful percentage of the chip price. RISC-V royalties are zero. For a vendor shipping a billion units, the savings fund a substantial silicon design team.

The drag is fragmentation. Every vendor adds custom extensions: Espressif's ESP32-P4 has Espressif-specific vector extensions, SiFive parts have SiFive intrinsics, Andes parts have Andes intrinsics. Code that targets one vendor's RISC-V does not portably target another. The RISC-V International standardization process has produced ratified vector (RVV 1.0) and bit manipulation (Zb*) extensions, but the long tail of custom extensions persists.

For a senior C++ engineer, the practical implications:

1. RISC-V toolchains (GCC, Clang) are mature. There is no compiler tooling reason to avoid RISC-V.
2. RISC-V CMSIS-NN, FreeRTOS port, and Zephyr support are all current and well-tested.
3. The application code is identical to Cortex-M. The differences are in the bootloader, the linker script, and the vendor SDK.
4. Expect to support both Cortex-M and RISC-V targets in any new product line. Vendor diversity is increasing, not decreasing.

### Rust Pressure on Embedded C++

Rust has been growing in embedded since around 2020. The momentum accelerated when:

- The Linux kernel began merging Rust drivers (kernel 6.1, December 2022)
- The Cybersecurity and Infrastructure Security Agency (CISA) recommended memory-safe languages for new code
- The EU Cyber Resilience Act began signaling that memory-unsafe code might face scrutiny
- The `embedded-hal` ecosystem matured to a usable state

Rust's strongest argument in embedded is memory safety without garbage collection. Buffer overflows, use-after-free, and data races are caught at compile time. For ASIL D code, the Rust borrow checker enforces some of the rules MISRA C++ tries to encode by convention.

The arguments against Rust in embedded:

1. **Toolchain qualification.** No qualified Rust compiler exists for safety-critical certification (ISO 26262, DO-178C). Ferrocene, the Ferrous Systems qualified Rust toolchain, was certified for ISO 26262 ASIL D in 2024 but its target list is limited and the ecosystem is much smaller than GCC's.
2. **Library ecosystem.** TFLite Micro, CMSIS-NN, AUTOSAR Adaptive runtimes, vendor HALs are C++. Calling C++ from Rust is possible but adds friction.
3. **Talent pool.** There are 10x more embedded C++ engineers than embedded Rust engineers in 2026, and hiring matters for shipping.
4. **AUTOSAR Adaptive mandates C++14 minimum.** Until AUTOSAR formally accepts Rust, automotive HPC code is C++.

The pragmatic 2026 stance: greenfield projects with no certification constraints can pick Rust. Existing codebases, AUTOSAR programs, and certified products stay on C++. Long-running brownfield projects often adopt Rust for new modules while keeping legacy modules in C++. Apple, Microsoft, Google, and Meta all use this hybrid pattern internally.

For a senior embedded engineer, the right move is to know both. The technical concepts (RAII vs ownership, virtual dispatch vs traits, templates vs generics) translate directly. A C++ engineer who can read Rust code and contribute to a Rust module is more valuable than one who cannot.

### AI-Assisted Code Generation

Tools like GitHub Copilot, Claude Code, and Cursor have changed the day-to-day of writing firmware. As of 2026 they are competent at:

- Writing peripheral drivers given a register map
- Generating CRC tables and lookup tables
- Translating an algorithm description into C++
- Writing unit tests against a function specification
- Refactoring boilerplate

They are still weak at:

- Reasoning about hardware timing and bus protocols correctly
- Understanding non-obvious memory ordering requirements
- Producing code that meets MISRA without significant cleanup
- Handling the long tail of vendor-specific bootloader and clock-tree configuration

The senior engineer's role is shifting. Instead of typing out a UART driver, the senior reviews an AI-generated UART driver against the silicon errata, the safety standard, and the project's coding rules. Productivity for routine code goes up. Productivity for novel or critical code goes up only modestly.

The implications for hiring:

1. Junior engineers using AI tools produce more code, but the quality variance is higher. The senior bottleneck for code review is more important than ever.
2. Knowledge of fundamentals (silicon, protocols, the C++ memory model) is the differentiator. The AI can write the syntax, but only an engineer who understands the bus arbitration knows when the AI's CAN driver will fail.
3. Domain depth matters more than breadth. A senior who knows automotive ECU bring-up cold is harder to replace with AI than a generalist who can write any kind of firmware acceptably.

### EU Cyber Resilience Act

The EU Cyber Resilience Act (CRA) was adopted in December 2024 and applies to "products with digital elements" placed on the EU market. The compliance deadline is late 2027. The headline requirements:

1. **Security by design.** Products must be designed and developed with security in mind, including secure boot, signed updates, and minimization of attack surface.
2. **Vulnerability handling.** Manufacturers must have a process for receiving, processing, and disclosing vulnerabilities. They must publish a Software Bill of Materials (SBOM).
3. **Update support.** Security updates must be provided for the product's expected lifetime, generally at least 5 years.
4. **Conformity assessment.** Critical products require third-party assessment.

The practical impact for embedded teams:

- Secure boot is no longer optional even for low-cost IoT products
- Signed firmware updates are no longer optional
- The shipping firmware must include a vulnerability disclosure mechanism
- The team must commit to a multi-year security maintenance budget

Many products that ship today (cheap connected sensors, Bluetooth gadgets, smart home accessories) do not meet these requirements. They will not be compliant when CRA enforcement begins. The 2026-2027 window is when teams scramble to add the missing infrastructure.

### FCC Cyber Trust Mark

The US analog is the FCC Cyber Trust Mark, a voluntary certification program launched in 2024. Products carrying the mark must meet baseline cybersecurity criteria including default unique passwords, automated updates, and vulnerability response.

The mark is voluntary, but major retailers (Amazon, Target, Best Buy) have signaled they will prefer or require the mark for IoT products on their shelves. The market pressure functions like a soft regulation.

### What All This Means for Senior Embedded C++

Five years from now (2031), the senior embedded C++ engineer's day looks like:

- Cortex-M and RISC-V parts are equally common. Code is mostly portable across both with vendor SDK shims.
- Rust modules coexist with C++ modules in many codebases. Inter-language boundaries are well-tooled.
- AI tools have absorbed the routine work. The senior reviews more, types less, debugs harder problems.
- Every connected product has signed updates, secure boot, and a published SBOM. The firmware build pipeline is more complex than the application code.
- AUTOSAR Adaptive and ISO 26262 are unchanged but more strictly enforced. ASIL D programs use formal methods (Astrée, Frama-C) routinely.
- TinyML on Cortex-M55 / M85 / RISC-V vector parts has expanded to handle audio, gesture, low-resolution vision in volume. The model deployment toolchain is mature.

The fundamentals of this chapter remain. C++ on bare metal, RAII for hardware, RTOS scheduling, MISRA discipline, register abstraction, secure boot, formal verification. These are the durable skills. The tooling around them changes every few years, the technical core does not.

If you are early in your embedded career, learn the fundamentals first. The frameworks, languages, and certifications shift. Knowing what an interrupt latency is, why priority inheritance matters, how a vtable is laid out, and what memory barriers do, those will still matter in 2040.

---
