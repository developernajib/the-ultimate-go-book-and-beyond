## Interview Questions

### Q1: How does a stack buffer overflow lead to arbitrary code execution? Walk through the exploit step by step.

A stack frame contains, from bottom to top: local variables, saved frame pointer, saved return address, and the caller's arguments. When a function like `void f(char* input) { char buf[64]; strcpy(buf, input); }` receives input longer than 64 bytes, `strcpy` writes past the end of `buf`, overwriting the saved frame pointer and then the saved return address.

When the function executes `ret`, the CPU loads the (now attacker-controlled) value from the stack into the instruction pointer. The attacker points it to shellcode they injected into the buffer, or to a sequence of existing code gadgets (ROP, Return-Oriented Programming) that performs their desired operation.

Stack canaries detect this by placing a random value between `buf` and the return address. The function checks the canary before executing `ret`, a corrupted canary causes immediate termination. ASLR makes it harder to know the address to jump to. These are mitigations, not fixes. The fix is bounds checking: `std::string`, `std::span`, or `strlcpy` with correct size.

---

### Q2: What is tcache poisoning, and how does use-after-free enable it?

In glibc's modern allocator, freed small chunks are stored in per-thread caches (tcache) as a singly-linked list. The next pointer for each chunk is stored in the freed chunk's memory itself, the memory that was just released.

In a use-after-free, the attacker controls memory after it has been freed. If they can write to a freed tcache chunk, they can overwrite its `next` pointer with an arbitrary address. When the allocator serves the next two `malloc` calls of the same size, it walks the tcache list: the first call returns the legitimate freed chunk, the second returns the attacker-supplied address, which is now returned as a valid allocation. The attacker has achieved an arbitrary `malloc` return value, which they use to overwrite security-critical data structures: function pointers, vtables, or `__free_hook`.

Modern glibc adds tcache safe-linking (XOR of `next` with a per-thread key) to make this harder. The defense is using `unique_ptr` and `shared_ptr`, ownership is always explicit, no raw `delete` exposes freed memory to the tcache.

---

### Q3: Why is signed integer overflow undefined behavior in C++, and why does this make it dangerous in security code?

The C++ standard specifies that signed integer overflow is undefined behavior. This is not an oversight, it was a deliberate choice to allow compilers to optimize under the assumption that signed values do not overflow. If the compiler assumes `x + 1 > x` is always true (because overflow is UB), it can eliminate branches like `if (x + 1 < 0) handle_overflow();` as dead code.

This produces a specific security failure mode: the programmer writes an overflow check, the compiler removes it because it proves it's unreachable under UB assumptions, and the resulting binary has no protection against the overflow. The overflow then produces an undersized allocation, and a subsequent write overflows the heap.

The fix is to use `__builtin_add_overflow` / `__builtin_mul_overflow` (which do not invoke UB) or to check operands before the arithmetic: `if (a > INT_MAX - b) handle_overflow();`. UBSan with `-fsanitize=signed-integer-overflow` catches overflows at runtime during testing.

---

### Q4: Explain the `%n` format string attack. What does it do and why does it enable arbitrary memory writes?

`printf`'s `%n` specifier writes the number of bytes printed so far into the argument at the corresponding position in the argument list. For `printf("AAAAAA%n", &count)`, `count` receives the value 6 after the call.

When the attacker controls the format string, they control what `%n` writes and where. By padding with `%Nc` (print N characters), they control the value written. By using argument position specifiers like `%12$n`, they choose which stack slot to treat as a pointer. If the stack contains an address (which it often does, return addresses, local variables), the attacker writes arbitrary values to arbitrary addresses.

The complete write primitive: write the target address onto the stack via the buffer being formatted, use `%N$n` to write to it, pad with `%Nc` to control the value written. This produces a 4-byte write to an arbitrary address, which suffices to overwrite a function pointer or GOT entry.

The fix: always use a literal format string. `printf("%s", user_input)` is safe. `printf(user_input)` is not. `-Wformat-security` warns on non-literal format strings.

---

### Q5: Why does nonce reuse break AES-GCM, and how do you prevent it?

AES-GCM works by generating a keystream using AES-CTR and XORing it with the plaintext, then authenticating the ciphertext with GHASH using a key derived from the first keystream block (H). When you reuse the same nonce with the same key:

- The keystream is identical for both encryptions.
- XOR of the two ciphertexts equals XOR of the two plaintexts: `C1 ⊕ C2 = P1 ⊕ P2`.
- With known plaintext in one message, the attacker recovers the other.
- More critically: reusing nonce and key allows the attacker to recover the GHASH authentication key H. With H, they can forge authentication tags, meaning they can modify any ciphertext and produce a valid tag. Full nonce-reuse breaks both confidentiality and integrity.

Prevention: generate a cryptographically random 96-bit nonce for every encryption using `RAND_bytes` or `randombytes_buf`. Alternatively, use a 192-bit nonce scheme (XSalsa20 in libsodium) which is large enough that random generation has negligible collision probability. Never use a counter that resets across process restarts unless you have persistent storage to track the counter.

---

### Q6: What is the difference between partial RELRO and full RELRO, and when would you accept partial?

Partial RELRO (`-Wl,-z,relro`) makes the first portion of the GOT (the non-PLT section, `.got`) read-only after dynamic linking. The `.got.plt` section, which contains the lazily-resolved function addresses, remains writable. A GOT overwrite attack targeting a lazy-resolution slot is still possible.

Full RELRO (`-Wl,-z,relro -Wl,-z,now`) adds `-z,now`, which forces the dynamic linker to resolve all symbols at process startup before making the GOT read-only. The entire GOT becomes non-writable. GOT overwrite attacks are completely prevented.

The cost: `-z,now` resolves all symbols eagerly, increasing startup time by the number of dynamic symbol resolutions times the dynamic linker overhead per symbol. For binaries with hundreds of dynamic symbols, this can add 5-20ms to startup. For daemons that start once and run for hours, this is irrelevant. For CLI tools with tight startup latency requirements, measure first. The security benefit almost always justifies the cost, accept partial RELRO only when startup latency is a documented, measured requirement.

---

### Q7: How does CFI prevent vtable hijacking, and what are its limitations?

A vtable hijacking attack works by overwriting the vtable pointer in a C++ object (via buffer overflow, use-after-free, or type confusion) with a pointer to a fake vtable containing attacker-controlled function pointers. When the program calls a virtual method, the CPU follows the fake vtable pointer and executes the attacker's code.

CFI prevents this by inserting a check before every indirect call (including virtual dispatch): the target address must be in the set of valid call targets for that call site. For virtual calls, the valid targets are all implementations of the specific virtual method in the class hierarchy, computed statically at compile time using LTO. A fake vtable pointing to `system()` fails this check because `system` is not a valid implementation of, say, `BaseClass::process()`.

Limitations:
- CFI validates the function signature and class hierarchy, not the specific object. An attacker with a legitimate object of the correct type can still redirect a call to any valid override of that virtual method.
- COOP (Counterfeit Object-Oriented Programming) attacks chain together legitimate virtual dispatch calls in a Turing-complete computation, all calls pass CFI checks individually.
- CFI requires LTO and `-fvisibility=hidden`, which increases build time and can conflict with plugin architectures that rely on symbol visibility.
- CFI does not protect non-indirect calls or memory corruption that does not involve function pointers.

Despite its limitations, CFI substantially raises the complexity of exploitation, defeating it requires assembling a sophisticated COOP payload, which is significantly harder than a direct vtable overwrite.

---

### Q8: What are the main supply chain attack vectors for C++ projects, and which defense addresses each?

**Compromised upstream source**: attacker modifies source code in a public repository (GitHub). Defense: hash pinning in vcpkg portfiles, Bazel `sha256=`, Conan lock files. Any modification changes the hash and fails the build.

**Malicious package registration**: attacker publishes a package with a name similar to a legitimate one ("typosquatting"). Defense: private registries (vcpkg custom registries, Conan Artifactory) that whitelist approved packages. Only packages in the private registry can be used.

**Compromised maintainer**: legitimate maintainer's credentials are taken over, or a new maintainer is socially engineered into the role (the `xz-utils` pattern). Defense: SBOM tracking (you know what you're using), vulnerability scanning (new CVEs trigger alerts), pin to a specific commit or version (new releases don't automatically become your dependency).

**Mirror substitution**: the download URL for an archive is changed to serve a different file. Defense: hash verification, the archive hash is stored in the portfile/WORKSPACE, not derived from the URL. A different file with the same URL fails the hash check.

**Build tool compromise**: the compiler, linker, or build system is compromised. Defense: reproducible builds with `diffoscope` verification against a known-good reference build. Code signing of release binaries.

**Transitive dependency**: a dependency of a dependency is compromised. Defense: full transitive lock files (Conan lock, vcpkg baseline), SBOM generation for all transitive deps, osv-scanner scanning the full dependency graph.

---

### Q9: A security auditor says your C++ service "lacks exploit mitigations." What specific questions do you ask, and what build changes do you make?

First, establish which mitigations are missing. Ask the auditor to run `checksec --file=./service` and share the output. The relevant fields are: RELRO (Full vs Partial vs None), Stack Canary (found vs not found), NX (enabled vs disabled), PIE (enabled vs not), FORTIFY (enabled vs not), and CFI if they inspect runtime instrumentation.

Then audit the CMakeLists.txt. Common omissions:

- No `-fstack-protector-strong` → add to `target_compile_options`
- No `-fpie -fPIE -pie` → add compile and link options. Verify with `readelf -h | grep DYN`
- No `-D_FORTIFY_SOURCE=2` → add to `target_compile_options` with `-O2` (required for FORTIFY to activate)
- Partial RELRO (no `-Wl,-z,now`) → add to `target_link_options`
- No CFI → add LTO + `-fsanitize=cfi-vcall,cfi-icall` + `-fvisibility=hidden`. Rebuild entirely

Then verify at the build artifact level: `checksec --file=./service` should report Full RELRO, stack canary found, NX enabled, PIE enabled, FORTIFY enabled. Add a CI step that fails if any of these are not present in Release builds. Hardening should be mandatory, not advisory.

---
