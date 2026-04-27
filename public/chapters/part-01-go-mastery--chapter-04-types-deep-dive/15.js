export default `## 4.10 How Computers Actually Represent and Convert Types

Chapter 4 explained Go's type system at the language level. This section goes one layer deeper and shows what the CPU is actually doing when it stores a string, a number, or converts between them. Understanding this removes a class of subtle bugs and makes you a much better debugger.

### Everything Is Bits

A computer has no concept of "a character", "a color", or "a boolean". It only stores and manipulates bits (ones and zeros). Every type you use in Go is a convention on top of a chunk of bits. The type system is the compiler's way of enforcing that you interpret those bits consistently.

\`\`\`
Memory address 0x100:  01101000  01100101  01101100  01101100  01101111
                         'h'       'e'       'l'       'l'       'o'
\`\`\`

Those five bytes are the string \`"hello"\`. The bytes \`104, 101, 108, 108, 111\` are not the characters, they are the ASCII codes *for* the characters. The characters exist only in our interpretation.

### ASCII and Unicode: Encoding Characters as Numbers

To store text, humans invented encoding tables. ASCII maps 128 characters to numbers 0–127. The digit characters are arranged consecutively starting at 48:

| Character | ASCII decimal | Binary |
|---|---|---|
| \`'0'\` | 48 | 00110000 |
| \`'1'\` | 49 | 00110001 |
| \`'2'\` | 50 | 00110010 |
| ... | ... | ... |
| \`'9'\` | 57 | 00111001 |
| \`'A'\` | 65 | 01000001 |
| \`'a'\` | 97 | 01100001 |

This design is intentional. Because digit characters are grouped and ordered, you can convert any digit character to its numeric value with one subtraction:

\`\`\`go
digitChar := byte('5')   // stored as 53
digitValue := digitChar - '0'  // 53 - 48 = 5
\`\`\`

Go strings are UTF-8 encoded, which is a superset of ASCII. For the 128 ASCII characters, UTF-8 and ASCII are identical byte-for-byte. For characters above 127 (accented letters, CJK, emoji), UTF-8 uses 2–4 bytes per character. This is why \`len("hello")\` returns 5, but \`len("héllo")\` returns 6, the \`é\` takes 2 bytes.

\`\`\`go
s := "héllo"
fmt.Println(len(s))           // 6 (bytes)
fmt.Println(len([]rune(s)))   // 5 (Unicode code points)

for i, r := range s {
    fmt.Printf("index=%d rune=%c bytes=%d\\n", i, r, utf8.RuneLen(r))
}
// index=0 rune=h bytes=1
// index=1 rune=é bytes=2
// index=3 rune=l bytes=1
// index=4 rune=l bytes=1
// index=5 rune=o bytes=1
\`\`\`

The \`range\` over a string iterates runes (Unicode code points), not bytes. The index jumps from 1 to 3 because \`é\` occupies bytes 1 and 2.

### Why \`string(5)\` Is Not \`"5"\`

This trips up many newcomers:

\`\`\`go
n := 5
s := string(n)    // s is "\\x05" (the control character with code 5), NOT "5"
fmt.Println(s)    // prints nothing visible
\`\`\`

\`string(n)\` in Go converts an integer to the UTF-8 encoding of the Unicode code point at that number. Code point 5 is a control character. To convert the number 5 to the string \`"5"\`, you use \`strconv\` or \`fmt\`:

\`\`\`go
s1 := strconv.Itoa(5)       // "5"
s2 := fmt.Sprintf("%d", 5)  // "5"
\`\`\`

The reason \`string(int)\` does not give you \`"5"\` is that converting a number to its character representation requires an algorithm, it is not a simple reinterpretation of bits.

### How \`strconv.Atoi\` Works Internally

When you call \`strconv.Atoi("4237")\`, the computer must convert the string \`"4237"\` (four bytes: 52, 50, 51, 55) into the integer 4237. The algorithm is:

\`\`\`
result = 0
for each digit character c in the string (left to right):
    digit = c - '0'
    result = result * 10 + digit
\`\`\`

Step by step for \`"4237"\`:

| Step | Character | Digit value | result |
|---|---|---|---|
| Start | | | 0 |
| 1 | \`'4'\` (52) | 52 - 48 = 4 | 0 * 10 + 4 = 4 |
| 2 | \`'2'\` (50) | 50 - 48 = 2 | 4 * 10 + 2 = 42 |
| 3 | \`'3'\` (51) | 51 - 48 = 3 | 42 * 10 + 3 = 423 |
| 4 | \`'7'\` (55) | 55 - 48 = 7 | 423 * 10 + 7 = 4237 |

This is called Horner's method. It avoids computing powers of 10 by building the result digit by digit. The same algorithm runs inside every \`strconv.Atoi\`, \`int(s)\`, \`Integer.parseInt(s)\` across languages.

You can implement it yourself in Go to understand it completely:

\`\`\`go
func parseDecimal(s string) (int64, error) {
    if len(s) == 0 {
        return 0, fmt.Errorf("empty string")
    }
    negative := false
    start := 0
    if s[0] == '-' {
        negative = true
        start = 1
    }
    var result int64
    for i := start; i < len(s); i++ {
        c := s[i]
        if c < '0' || c > '9' {
            return 0, fmt.Errorf("invalid character %q at index %d", c, i)
        }
        digit := int64(c - '0')
        result = result*10 + digit
    }
    if negative {
        return -result, nil
    }
    return result, nil
}
\`\`\`

The Go standard library's \`strconv.ParseInt\` adds range checking, base support, and bit-size limits, but the core loop is the same.

### How Numbers Are Stored: Integer Representation

An \`int64\` is 8 bytes (64 bits). The number 4237 in binary is:

\`\`\`
00000000 00000000 00000000 00000000 00000000 00000000 00010000 10001101
\`\`\`

Negative numbers use **two's complement**. To negate a number: flip all bits, then add 1. This is why \`-1\` in binary is all ones (\`11111111...\`), and why overflow wraps around cleanly. There is no separate sign bit in two's complement, the sign is encoded in the pattern.

\`\`\`go
var x int8 = 127
x++              // x is now -128 (overflow wraps around in Go)
fmt.Println(x)   // -128
\`\`\`

This wrapping is defined behavior in Go (unlike C, where signed overflow is undefined). But it is almost always a bug, the compiler does not warn about it unless you use \`go vet\` or a linter.

### How Floats Are Stored: IEEE 754

Floating-point numbers like \`float64\` use the IEEE 754 standard: 1 sign bit, 11 exponent bits, 52 mantissa bits. This representation can express very large and very small numbers, but it cannot represent most decimal fractions exactly.

\`\`\`go
fmt.Println(0.1 + 0.2)          // 0.30000000000000004
fmt.Println(0.1 + 0.2 == 0.3)   // false
\`\`\`

The number 0.1 has no exact binary fraction representation, just as 1/3 has no exact decimal representation. The CPU stores the closest representable value instead. This is why you should never compare floats with \`==\` unless you are comparing against constants that have exact representations (0, powers of 2).

\`\`\`go
const epsilon = 1e-9
func floatEqual(a, b float64) bool {
    return math.Abs(a-b) < epsilon
}
\`\`\`

For money and other exact-decimal domains, use integer arithmetic (store amounts in cents) or a \`big.Rat\`.

### Type Conversions in Go: What the CPU Does

Go requires explicit conversions between numeric types. Each conversion is a CPU instruction:

\`\`\`go
var x int32 = 1000
var y int64 = int64(x)   // zero-extend to 64 bits (cheap: 1 instruction)
var z int8  = int8(x)    // truncate to 8 bits (top 24 bits are discarded)
var f float64 = float64(x) // convert integer to floating-point (ALU conversion)
\`\`\`

Widening conversions (small to large) are free to near-free. Narrowing conversions silently truncate, they are the source of many bugs where a large number is cast to a smaller type and loses its upper bits.

\`\`\`go
var big int32 = 1000
small := int8(big)   // 1000 mod 256 = 232, but as int8 that is -24
fmt.Println(small)   // -24, not 1000
\`\`\`

\`string(int)\` is a conversion in name only, it produces the UTF-8 encoding of the Unicode code point, not a decimal string. Always use \`strconv.Itoa\` or \`fmt.Sprintf\` for number-to-string.

### The Senior Engineer's Takeaway

Every type mismatch bug, every integer overflow, every floating-point comparison that silently returns the wrong answer traces back to forgetting that the type system is a convention on top of bits. The CPU does not care what your type says, it runs the instructions you give it. The compiler enforces the type rules at compile time, but once the code runs, the CPU just moves bits around.

Understanding ASCII encoding, two's complement, IEEE 754, and how \`strconv.Atoi\` works internally means you can:
- Debug garbled text output (wrong encoding assumption)
- Track down integer overflow that only manifests under load
- Explain why floating-point comparison fails and fix it correctly
- Write \`parseDecimal\` from scratch in a coding interview without flinching

**Watch:** [HOW COMPUTERS CAST STRING TO NUMBERS](https://www.youtube.com/watch?v=m8v_SRpxyN4), covers ASCII, digit encoding, and the conversion algorithm with step-by-step animation.
`;
