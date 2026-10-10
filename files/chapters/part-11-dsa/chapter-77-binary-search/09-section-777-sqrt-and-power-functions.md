## 77.7 Sqrt and Power Functions

Integer square root and fast exponentiation are textbook examples of binary search and bit manipulation applied to mathematical computation. `MySqrt` treats the answer space `[1, x/2]` as a sorted sequence and binary-searches for the largest integer whose square does not exceed `x`, returning `right` (not `left`) because when the loop ends `right` holds the floor value. `MyPow` uses binary exponentiation. It squares `x` on every iteration and multiplies it into `result` only when the corresponding bit of `n` is set, reducing O(n) multiplications to O(log n).

```go
// MySqrt computes the integer square root, that is floor(sqrt(x)).
// Precondition: x >= 0. The guard below returns x unchanged for x < 2,
// which is right for 0 and 1 and meaningless for negatives.
// LeetCode 69: Sqrt(x)
// Time: O(log x), Space: O(1)
func MySqrt(x int) int {
    if x < 2 {
        return x
    }

    left, right := 1, x/2

    for left <= right {
        mid := left + (right-left)/2
        square := mid * mid

        if square == x {
            return mid
        } else if square < x {
            left = mid + 1
        } else {
            right = mid - 1
        }
    }

    return right
}

// IsPerfectSquare reports whether num is a perfect square
// LeetCode 367: Valid Perfect Square
func IsPerfectSquare(num int) bool {
    if num < 0 {
        return false // no negative number is a square
    }
    if num < 2 {
        return true // 0 and 1 are squares of themselves
    }

    left, right := 1, num/2

    for left <= right {
        mid := left + (right-left)/2
        square := mid * mid

        if square == num {
            return true
        } else if square < num {
            left = mid + 1
        } else {
            right = mid - 1
        }
    }

    return false
}

// MyPow implements pow(x, n)
// LeetCode 50: Pow(x, n)
// Time: O(log n), Space: O(1)
func MyPow(x float64, n int) float64 {
    if n < 0 {
        x = 1 / x
        n = -n
    }

    result := 1.0
    for n > 0 {
        if n&1 == 1 {
            result *= x
        }
        x *= x
        n >>= 1
    }

    return result
}
```

### Junior -> FAANG: Sqrt and Pow as Template Applications

`MySqrt` is a direct application of the lower-bound template on the answer space [1, x/2]. The key choice is to return `right` rather than `left` after the loop: when the loop exits, `left` is the first value whose square exceeds `x` and `right` is the last value whose square does not exceed `x`. The floor of sqrt(x) is `right`.

`MyPow` uses binary exponentiation, which is distinct from binary search but shares the "halve the problem each step" structure. The bit-by-bit loop `if n&1 == 1 { result *= x }; x *= x; n >>= 1` is the standard implementation. Trace through it for `x=3.0, n=5` (binary 101): iteration 1, bit=1, result=3.0, x=9.0, n=2 - iteration 2, bit=0, result=3.0, x=81.0, n=1 - iteration 3, bit=1, result=243.0, x=6561.0, n=0. Return 243.0 = 3^5. Correct.

The negative exponent case `n < 0` is handled by inverting x and negating n before the loop. Make sure you address this in an interview: "I handle negative exponents by taking the reciprocal first, then applying binary exponentiation."

There is one lurking edge case in `n = -n` worth knowing, because it is a favorite follow-up. If `n` is the most negative value of its type, negating it overflows, since two's complement has no positive counterpart for it. This is a live bug in languages where the exponent is a 32-bit `int`, and LeetCode's constraints for this problem sit exactly in `int32` range to bait it. Go's `int` is 64-bit on 64-bit platforms, so an `int32`-range exponent negates without trouble, and only `math.MinInt64` itself would wrap. Say this out loud if asked. Knowing why the bug exists elsewhere, and why it does not bite here, reads better than either ignoring it or reciting it as a danger that does not apply.

### Senior @ FAANG: Numerical Correctness in Production

`MySqrt` uses integer arithmetic throughout, so it has no floating-point error at all. That is what makes it appropriate wherever an exact integer result is part of a contract, such as computing the side of the largest square that fits in n pixels.

It is worth being precise about the alternative rather than repeating folklore, because the truth here is sharper than the usual warning. `math.Sqrt` is not sloppy at all: IEEE-754 requires square root to be correctly rounded, so it returns the representable value nearest the true root. The trap is that correct rounding is exactly what breaks the floor.

Take `x = k*k - 1` for `k = 67108865`. The true root is a hair below `k`, closer to `k` than to any other representable double, so `math.Sqrt` correctly rounds it up to precisely `k`. Truncating gives `k`, while the true floor is `k - 1`. The function did its job perfectly and the answer is still wrong by one. This happens well below 2^53, so "stay under 2^53 and floats are fine" is not a rule you can lean on. Above 2^53 there is a second, independent problem: `float64` can no longer represent every integer, so `float64(x)` loses information before `Sqrt` is ever called.

The practical rule: if you need an exact `floor(sqrt(x))`, either use the integer search above, or use `math.Sqrt` as a fast first guess and then correct it with a comparison or two (`for r*r > x { r-- }`, `for (r+1)*(r+1) <= x { r++ }`). What you must not do is truncate a float root and call it exact.

`MyPow` operates on `float64`, whose largest finite value is just under 2^1024. So `MyPow(2, 1023)` is finite, roughly 8.99e307, while `MyPow(2, 1024)` overflows to `+Inf`. The threshold is where the result leaves the representable range, and it moves with the base. Note also that binary exponentiation multiplies rounded intermediates together, so its result may differ in the last bits from a correctly rounded `math.Pow`. For modular exponentiation in cryptographic code, do not use either: use `math/big.Int.Exp`, which takes a modulus and keeps everything exact.

One senior-level review note. When `MyPow` is called repeatedly with a fixed base and varying exponents, the squarings `x, x^2, x^4, x^8, ...` are recomputed every call and can be hoisted into a table the loop indexes by bit position. That is a real saving for repeated same-base exponentiation. Do not confuse it with polynomial evaluation, which is a different problem: evaluating a polynomial at a point wants Horner's method, which needs no power table and no exponentiation at all.
