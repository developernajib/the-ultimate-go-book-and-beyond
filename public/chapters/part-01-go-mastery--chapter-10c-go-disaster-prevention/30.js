export default `## 10C.29 Trim Function Misuse

This is a consistently misunderstood function in Go's standard library. \`strings.Trim\` does not remove a prefix or suffix string, it removes individual **characters** from a cutset.

### The Disaster

\`strings.Trim\` removes any leading or trailing character that belongs to the cutset, treating the second argument as a set of individual runes, not a substring. Passing \`"error:"\` as the cutset removes any combination of \`e\`, \`r\`, \`o\`, \`:\` characters from the edges, which can strip valid characters from the result.

\`\`\`go
package main

import (
    "fmt"
    "strings"
)

func main() {
    // WRONG: Developer thinks Trim removes the string "Hello" as a prefix
    result := strings.Trim("Hello, World!", "Hello")
    fmt.Println(result) // ", World!"  ← Looks correct... but only by coincidence!

    // The REAL behavior: Trim removes any CHARACTER found in "Hello" (H, e, l, o)
    // from BOTH ends of the string. It happened to work because the leading chars
    // are H, e, l, l, o and the trailing char '!' is not in the cutset.

    // Where it goes WRONG:
    result2 := strings.Trim("Hello-Hello World Hello-Hello", "Hello")
    fmt.Println(result2) // "- World " - removed H,e,l,o from BOTH ends, char by char!

    // Another surprising example:
    result3 := strings.Trim("Helicopter", "Hello")
    fmt.Println(result3) // "icopt" - removed H, e, l from the left; e, r survived on right
    // Wait - 'r' is not in "Hello", so right-trimming stopped at 'r'.
    // Actually: "Helicopter" → trim left removes H,e,l → "icopter"
    //                        → trim right removes nothing ('r' not in set) → "icopter"
    fmt.Println(strings.Trim("Helicopter", "Hello")) // "icopter"

    // What the developer ACTUALLY wanted:
    prefix := strings.TrimPrefix("Hello, World!", "Hello")
    fmt.Println(prefix) // ", World!" - removes the exact prefix string "Hello"

    suffix := strings.TrimSuffix("data.json.bak", ".bak")
    fmt.Println(suffix) // "data.json" - removes the exact suffix string ".bak"
}
\`\`\`

### Why It's Dangerous

- \`strings.Trim(s, cutset)\` treats \`cutset\` as a **set of individual characters**, not a substring
- It removes characters from **both ends** of the string, not just one end
- It often appears to work correctly in simple cases, hiding the bug until edge cases surface
- The same trap applies to \`strings.TrimLeft\` and \`strings.TrimRight\` - they also use character sets

### The Fix: Use the Right Function

The \`strings\` package provides distinct functions for character-set trimming and substring removal. The table below clarifies which function to use for each case.

\`\`\`go
package main

import (
    "fmt"
    "strings"
)

func main() {
    path := "///api/v1/users///"

    // strings.Trim - removes individual CHARACTERS from both ends
    fmt.Println(strings.Trim(path, "/"))       // "api/v1/users" - removes all '/' chars from ends

    // strings.TrimPrefix - removes an exact PREFIX string (once)
    fmt.Println(strings.TrimPrefix(path, "/")) // "//api/v1/users///" - removes only one leading "/"

    // strings.TrimSuffix - removes an exact SUFFIX string (once)
    fmt.Println(strings.TrimSuffix(path, "/")) // "///api/v1/users//" - removes only one trailing "/"

    // strings.TrimLeft - removes individual CHARACTERS from the LEFT only
    fmt.Println(strings.TrimLeft(path, "/"))   // "api/v1/users///" - removes all '/' from left

    // strings.TrimRight - removes individual CHARACTERS from the RIGHT only
    fmt.Println(strings.TrimRight(path, "/"))  // "///api/v1/users" - removes all '/' from right

    // Summary:
    // ┌──────────────────────┬────────────────────────────────────────────┐
    // │ Function             │ What it does                               │
    // ├──────────────────────┼────────────────────────────────────────────┤
    // │ Trim(s, cutset)      │ Remove chars in cutset from BOTH ends     │
    // │ TrimLeft(s, cutset)  │ Remove chars in cutset from LEFT end      │
    // │ TrimRight(s, cutset) │ Remove chars in cutset from RIGHT end     │
    // │ TrimPrefix(s, prefix)│ Remove exact prefix string (once)         │
    // │ TrimSuffix(s, suffix)│ Remove exact suffix string (once)         │
    // │ TrimSpace(s)         │ Remove whitespace from both ends          │
    // └──────────────────────┴────────────────────────────────────────────┘
}
\`\`\`

**The Rule:** If you want to remove a specific prefix or suffix string, use \`TrimPrefix\`/\`TrimSuffix\`. Only use \`Trim\`/\`TrimLeft\`/\`TrimRight\` when you genuinely want to strip individual characters from a set.

---
`;
