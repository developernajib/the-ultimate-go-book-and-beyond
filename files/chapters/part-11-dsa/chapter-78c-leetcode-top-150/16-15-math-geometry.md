## 78C.15 Math / Geometry

These problems require mathematical reasoning or matrix manipulation rather than standard data structures.

---
### LC 48 - Rotate Image 🟡

**Key Insight**: Transpose the matrix (swap rows and columns), then reverse each row. Together those two steps rotate 90 degrees clockwise.

```go
func rotate(matrix [][]int) {
    n := len(matrix)

    // Transpose
    for i := 0; i < n; i++ {
        for j := i + 1; j < n; j++ {
            matrix[i][j], matrix[j][i] = matrix[j][i], matrix[i][j]
        }
    }

    // Reverse each row
    for i := 0; i < n; i++ {
        for l, r := 0, n-1; l < r; l, r = l+1, r-1 {
            matrix[i][l], matrix[i][r] = matrix[i][r], matrix[i][l]
        }
    }
}
```
**Time**: O(n²).
**Space**: O(1).

---
### LC 54 - Spiral Matrix 🟡

**Key Insight**: Maintain four boundaries (top, bottom, left, right) and spiral inward, shrinking the boundaries after each traversal.

```go
func spiralOrder(matrix [][]int) []int {
    if len(matrix) == 0 {
        return nil
    }

    var result []int
    top, bottom := 0, len(matrix)-1
    left, right := 0, len(matrix[0])-1

    for top <= bottom && left <= right {
        for c := left; c <= right; c++ {
            result = append(result, matrix[top][c])
        }
        top++
        for r := top; r <= bottom; r++ {
            result = append(result, matrix[r][right])
        }
        right--
        if top <= bottom {
            for c := right; c >= left; c-- {
                result = append(result, matrix[bottom][c])
            }
            bottom--
        }
        if left <= right {
            for r := bottom; r >= top; r-- {
                result = append(result, matrix[r][left])
            }
            left++
        }
    }
    return result
}
```
**Time**: O(m × n).
**Space**: O(1), ignoring the output.

---
### LC 73 - Set Matrix Zeroes 🟡

**Key Insight**: Use the first row and first column as markers. Track whether they themselves need to be zeroed with separate flags.

```go
func setZeroes(matrix [][]int) {
    rows, cols := len(matrix), len(matrix[0])
    firstRowZero, firstColZero := false, false

    for c := 0; c < cols; c++ {
        if matrix[0][c] == 0 {
            firstRowZero = true
            break
        }
    }
    for r := 0; r < rows; r++ {
        if matrix[r][0] == 0 {
            firstColZero = true
            break
        }
    }

    // Mark zeros in first row/col
    for r := 1; r < rows; r++ {
        for c := 1; c < cols; c++ {
            if matrix[r][c] == 0 {
                matrix[r][0] = 0
                matrix[0][c] = 0
            }
        }
    }

    // Zero out cells based on markers
    for r := 1; r < rows; r++ {
        for c := 1; c < cols; c++ {
            if matrix[r][0] == 0 || matrix[0][c] == 0 {
                matrix[r][c] = 0
            }
        }
    }

    if firstRowZero {
        for c := 0; c < cols; c++ {
            matrix[0][c] = 0
        }
    }
    if firstColZero {
        for r := 0; r < rows; r++ {
            matrix[r][0] = 0
        }
    }
}
```
**Time**: O(m × n).
**Space**: O(1).

---
### LC 7 - Reverse Integer 🟡

**Key Insight**: Pop digits from the end and push to the result. Check for overflow before multiplying by 10.

```go
func reverse(x int) int {
    result := 0
    for x != 0 {
        digit := x % 10
        x /= 10

        if result > (1<<31-1)/10 || result < -(1<<31)/10 {
            return 0
        }
        result = result*10 + digit
    }
    return result
}
```

The `1<<31` bounds here come from the problem statement, which defines the input and output as a signed 32-bit integer. They are not a Go limit: `int` is 64 bits on LeetCode's platform, which is exactly why `result*10 + digit` can be computed and range-checked without wrapping. Do not copy this pattern into code where the real bound is `int`, since there `math.MaxInt` is the correct constant.

**Time**: O(log x).
**Space**: O(1).

---
### LC 50 - Pow(x, n) 🟡

**Key Insight**: Binary exponentiation. Read `n` in binary: square the base at every bit position and multiply it into the result only where the bit is set. That turns n multiplications into log n.

```go
func myPow(x float64, n int) float64 {
    if n < 0 {
        x = 1 / x
        n = -n // safe: n is a 64-bit int, so negating math.MinInt32 does not overflow
    }

    result := 1.0
    for n > 0 {
        if n&1 == 1 {
            result *= x // this bit of the exponent is set
        }
        x *= x  // x now represents the next power of two
        n >>= 1
    }
    return result
}
```

The negative exponent is where this problem bites. LeetCode's constraint allows `n` down to -2³¹, and in a language where `n` is a 32-bit int, `n = -n` on the minimum value overflows back to itself and the loop never terminates. The standard defence is to widen to a 64-bit type before negating. Go gives this for free, since `int` is 64 bits on every platform LeetCode runs, but say so out loud in the interview: the interviewer is watching for whether you noticed the trap at all, and the answer "Go's int is 64-bit so the negation is safe here" is the one that scores.

`x = 1/x` up front rather than dividing at the end keeps the loop to one code path. The iterative form is also preferable to the recursive `myPow(x, n/2)` version, since it needs no stack and has no base case to fumble.

**Time**: O(log n) - one iteration per bit of the exponent.
**Space**: O(1) - iterative, so no recursion stack.

---
### LC 43 - Multiply Strings 🟡

**Key Insight**: Simulate grade-school multiplication. Multiply digit by digit and accumulate into a result array indexed by i+j and i+j+1.

```go
func multiply(num1 string, num2 string) string {
    m, n := len(num1), len(num2)
    pos := make([]int, m+n)

    for i := m - 1; i >= 0; i-- {
        for j := n - 1; j >= 0; j-- {
            mul := int(num1[i]-'0') * int(num2[j]-'0')
            p1, p2 := i+j, i+j+1
            sum := mul + pos[p2]
            pos[p2] = sum % 10
            pos[p1] += sum / 10
        }
    }

    var sb strings.Builder
    for _, d := range pos {
        if sb.Len() == 0 && d == 0 {
            continue
        }
        sb.WriteByte(byte(d) + '0')
    }
    if sb.Len() == 0 {
        return "0"
    }
    return sb.String()
}
```
**Time**: O(m × n).
**Space**: O(m + n).

---

### Junior → FAANG: Math and Geometry as Pattern Recognition

Math and geometry problems in interviews test whether you can identify a non-obvious structural invariant. Rotate Image relies on "transpose then reverse" being equivalent to 90-degree clockwise rotation, which is not immediately obvious. Spiral Matrix relies on maintaining four shrinking boundary pointers. Set Matrix Zeroes relies on using the matrix itself as the marker array to achieve O(1) space. When you encounter a problem in this category, draw a small example first and look for the invariant manually before trying to code. Interviewers in this category are testing spatial reasoning and mathematical insight, not just coding speed.

### Senior @ FAANG: Mathematical Reasoning in Distributed System Correctness

At the senior level, mathematical reasoning extends beyond matrix manipulation. Consistent hashing uses modular arithmetic and virtual nodes to distribute load across a ring, and the correctness proof is a mathematical invariant about key assignment under node addition and removal. Cryptographic protocols rely on modular exponentiation and the discrete logarithm problem. Vector clock algorithms for distributed causality tracking use coordinate-wise comparison. The bar-raiser question for a staff-level candidate is not "implement Rotate Image" but "prove that your consistent hashing ring maintains a maximum load imbalance of O(log n / n) per node with O(log n) virtual nodes per physical node." Owning a distributed key-value store at FAANG means owning the mathematical correctness arguments for its partitioning, replication, and failure recovery schemes, and being able to communicate those arguments to a mixed audience of engineers and product partners in a design review. The interview-level math problems are the foundation. The production concern is being able to scale that mathematical reasoning to system invariants.
