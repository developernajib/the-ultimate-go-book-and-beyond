export default `## 7D.4 go tool compile -S: Reading Compiler Output

The \`-S\` flag on \`go tool compile\` emits the assembly that the Go compiler produces for your source file, letting you inspect exactly what machine instructions your Go code becomes. Passing \`-N\` disables optimizations and \`-l\` disables inlining so that the output maps more directly to the original source, making it easier to correlate Go statements with specific assembly instructions. This output is the primary tool for diagnosing performance issues, verifying that bounds checks have been eliminated, and confirming that hot paths use the CPU instructions you expect.

\`\`\`bash
# Generate assembly for a specific function
go tool compile -S -N -l myfile.go 2>&1 | grep -A 20 '"".MyFunc'
# -N: disable optimizations (easier to read)
# -l: disable inlining

# More readable with objdump on a built binary
go build -o myapp ./...
go tool objdump -s 'main\\.MyFunc' myapp
\`\`\`

A common use of compiler output inspection is checking whether a bounds check has been eliminated. The compiler inserts a bounds check before every slice index to prevent out-of-bounds memory access, and the generated assembly reveals whether that check survives optimization:

\`\`\`go
package main

func BoundsCheck(s []int, i int) int {
    return s[i] // compiler inserts bounds check here
}

// Assembly shows the bounds check:
// CMPQ CX, DX     // compare i with len
// JCC  runtime.panicIndex  // jump if out of bounds
// This is what "bounds check elimination" (BCE) removes when safe
\`\`\`

### Disabling Bounds Check (for expert use only)

The Go compiler automatically inserts a bounds check before every slice index operation to prevent out-of-bounds memory access, but it is also smart enough to eliminate those checks when it can statically prove the index is safe. Giving the compiler enough information, such as an explicit length guard before a loop, allows bounds check elimination (BCE) to fire, removing the extra comparison and branch from the hot path. The compiler directives shown below are low-level tools that bypass normal safety mechanisms. They should only be used in performance-critical inner loops after profiling confirms the overhead is significant.

\`\`\`go
// //go:nosplit tells assembler: don't grow stack (for tiny functions)
// //go:noescape tells compiler: pointer args don't escape to heap
// //go:noinline forces a function to never be inlined

//go:noinline
func BoundsCheckEliminated(s []int) int {
    if len(s) == 0 {
        return 0
    }
    // After the len check, compiler may eliminate bounds checks inside
    // because it knows len(s) > 0
    sum := 0
    for i := range s {
        sum += s[i] // bounds check likely eliminated by compiler
    }
    return sum
}
\`\`\`

### Reading Assembly Pays Back in Diagnosis

For a senior engineer, \`go tool compile -S\` output is a diagnostic lens. Three cases where it pays back:

1. **Function refuses to inline.** The asm shows the call site. \`-gcflags="-m=2"\` tells you why.
2. **Bounds checks in a hot loop.** The asm shows the CMPQ and JA instructions. Restructure to eliminate them.
3. **Unexpected allocation.** The asm shows CALL to \`runtime.newobject\` or similar. Trace back to the Go source.

Learning to read assembly output is a one-afternoon investment that pays back for the career.

---
`;
