## 01. How CPUs Work: From Transistors to Instructions

### The Transistor as a Switch

A CPU is built from transistors. A modern CPU has tens of billions of them. Each transistor is an electronic switch with three terminals: a collector, an emitter, and a base. When you apply voltage to the base, current flows from collector to emitter. Remove the voltage and the switch opens. That is the entire mechanism. One transistor, one switch.

The switch has two states: on and off. This maps directly to binary: 1 and 0. Everything a CPU does, arithmetic, comparison, memory access, control flow, ultimately comes down to combinations of switches being on or off.

---

### Logic Gates

When you wire transistors together in specific arrangements, they implement logical operations. These arrangements are called logic gates.

**NOT gate (inverter):** One transistor. Input 1 produces output 0. Input 0 produces output 1.

**AND gate:** Two transistors in series. Output is 1 only when both inputs are 1. Otherwise 0.

**OR gate:** Two transistors in parallel. Output is 1 when either input is 1.

**XOR gate (exclusive OR):** Output is 1 when inputs differ. This is the gate that makes addition possible.

Truth tables for reference:

```
AND         OR          XOR
A B | out   A B | out   A B | out
0 0 |  0    0 0 |  0    0 0 |  0
0 1 |  0    0 1 |  1    0 1 |  1
1 0 |  0    1 0 |  1    1 0 |  1
1 1 |  1    1 1 |  1    1 1 |  0
```

These gates are the atomic operations from which all CPU logic is built. You cannot go lower than this without talking about physics.

---

### Adding Numbers with Gates

Binary addition follows simple rules. For two one-bit numbers A and B:

- The sum bit is `A XOR B`
- The carry bit is `A AND B`

For example: `1 + 1 = 10` in binary (decimal 2). XOR gives 0 for the sum bit, AND gives 1 for the carry.

This two-gate combination is called a half adder. Chain eight of them together with logic to propagate carries, and you have an 8-bit adder that can add two numbers up to 255. Chain enough bits and you can add any integers the CPU supports.

The Arithmetic Logic Unit (ALU) is the part of the CPU that contains these adders along with circuits for subtraction, bitwise AND/OR/XOR, comparison, and shifting. The ALU takes two inputs, an operation code (opcode), and produces a result and a set of flag bits.

---

### Flag Bits

The ALU sets flag bits after every operation:

- **Zero flag:** Result was zero
- **Overflow flag:** Result exceeded the register size
- **Negative flag:** Result was negative (for signed arithmetic)

These flags drive conditional execution. After a comparison instruction, the CPU checks flags to decide whether to jump or continue. This is how `if` statements and loops work at the hardware level.

---

### Registers

A register is a small, extremely fast storage location inside the CPU. Registers are built from flip-flops (covered in the clock signal section). Each flip-flop holds one bit. A 64-bit register contains 64 flip-flops.

CPU operations work primarily on registers, not on memory. To add two numbers, the CPU loads them from memory into registers, performs the addition in the ALU, and writes the result back to memory or keeps it in a register for subsequent operations.

Common registers:
- **General purpose registers:** Hold operands and results (x86-64 has 16: rax, rbx, rcx, rdx, rsi, rdi, r8-r15)
- **Program Counter (PC) / Instruction Pointer (IP):** Holds the address of the next instruction to execute
- **Stack Pointer (SP):** Holds the address of the top of the call stack
- **Flags register:** Holds the result flags from the last ALU operation

---

### The Fetch-Decode-Execute Cycle

The CPU runs one loop continuously:

1. **Fetch:** Read the instruction at the address stored in the program counter. Load it into the instruction register.
2. **Decode:** Parse the instruction to determine what operation to perform and on which operands.
3. **Execute:** Pass operands to the ALU or memory system and perform the operation.
4. **Increment:** Add the instruction size to the program counter to point at the next instruction. (Jump instructions overwrite the PC instead.)

This cycle repeats billions of times per second on a modern CPU. The clock signal controls the timing. Each rising edge of the clock triggers the next step in the cycle. A CPU running at 3 GHz completes 3 billion clock cycles per second.

At each step, the binary decoder built from logic gates routes signals to the correct hardware based on the opcode bits in the instruction.

---

### Instructions Are Just Numbers

An instruction is a fixed-width binary number stored in memory. The CPU interprets this number as an operation. For example, on x86-64, the MOV instruction (move data from one place to another) has a specific binary encoding. The ADD instruction has a different one.

Different CPUs interpret the same binary numbers differently. This is why programs compiled for x86 do not run on ARM. The instruction set architecture (ISA) defines which bit patterns mean which operations. This is the subject of the next section.

---

### A Complete Example

Here is what happens when you write `a + b` in C and the compiler emits this for x86-64:

```asm
mov eax, [a]      ; load value of 'a' into register eax
add eax, [b]      ; add value of 'b' to eax; result in eax
mov [result], eax ; store result back to memory
```

Each line is one instruction. Each instruction goes through fetch-decode-execute. The `add` instruction causes the ALU to perform binary addition using the adder circuits built from XOR and AND gates, which are built from transistors.

From source code to transistors: `a + b` → assembly instruction → binary opcode → decoder routes signal → ALU XOR/AND gates → result in register → stored back to memory.

---

### What This Means for Programmers

Understanding the fetch-decode-execute cycle explains several practical things:

- **Why integer overflow wraps:** The adder has a fixed number of bits. When the result exceeds that, the high bit carries out but there is nowhere to store it. The zero flag stays clear and no exception fires unless you check the overflow flag explicitly.

- **Why bitwise operations are cheap:** AND, OR, XOR map directly to a single pass through gates in the ALU. No iteration, no looping.

- **Why branches can be expensive:** Modern CPUs predict which branch will be taken and pre-fetch instructions speculatively. A mispredicted branch means discarding the speculatively executed work and starting over. This is branch misprediction penalty.

- **Why cache misses hurt:** The fetch step reads from memory. Main memory is hundreds of cycles away. Cache is a few cycles. When the instruction or data is not in cache, the CPU stalls waiting for the memory access.

---

**Watch:** [How Do Transistors Run Code?](https://www.youtube.com/watch?v=HjneAhCy2N4)

**Watch:** [How Computer Processors Run Conditions and Loops](https://www.youtube.com/watch?v=Ui6QyzcD3_E)
