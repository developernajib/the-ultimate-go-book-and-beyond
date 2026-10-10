## Exercises

### Exercise 1: Type-Safe Calculator

Write a C++ function `calculate` that is overloaded to handle `int`, `double`, and `std::string` (concatenation for strings). Use `constexpr` for common mathematical constants. The function should use brace initialization throughout to prevent narrowing.

**Starter:**

```cpp
#include <string>
#include <iostream>

constexpr double PI = /* your code */;
constexpr double E  = /* your code */;

// Overload calculate for int, double, std::string
// Each should perform addition of two values
/* your code */

int main() {
    std::cout << calculate(10, 20) << "\n";           // int: 30
    std::cout << calculate(PI, E) << "\n";             // double: 5.85987...
    std::cout << calculate("hello, ", "world") << "\n"; // string: "hello, world"
    return 0;
}
```

### Exercise 2: Reference Swapper

Implement a `swap` function using references (not pointers) that works for any type. Then implement the same using pointers. Compare both approaches. Write a main function that demonstrates both.

**Hint:** Use templates to make it generic.

### Exercise 3: Undefined Behavior Detector

Look at the following code and identify ALL instances of undefined behavior. Write a corrected version.

```cpp
#include <iostream>

int main() {
    int arr[5] = {1, 2, 3, 4, 5};
    int sum;                          // line A

    for (int i = 0; i <= 5; i++) {    // line B
        sum += arr[i];                // line C
    }

    int* p = new int(42);
    delete p;
    std::cout << *p << "\n";          // line D

    int x = 2147483647;
    x = x + 1;                       // line E
    std::cout << x << "\n";

    char* s = "hello";               // line F
    s[0] = 'H';                      // line G

    return 0;
}
```

**Answer key:**
- Line A: `sum` is uninitialized (UB when read)
- Line B: loop goes to `i == 5`, but `arr[5]` is out of bounds (UB)
- Line C: reading uninitialized `sum` and out-of-bounds access
- Line D: use-after-free (dereferencing deleted pointer)
- Line E: signed integer overflow (UB)
- Line F: string literal assigned to non-const `char*` (deprecated, potentially UB)
- Line G: modifying a string literal (UB)

### Exercise 4: Build Pipeline

Create a three-file project (`math.h`, `math.cpp`, `main.cpp`) with at least two functions. Write the header with proper include guards, implement the functions in the `.cpp` file, and compile step by step:

1. Preprocess `main.cpp` and examine the output
2. Compile each `.cpp` to object files
3. Link object files into an executable
4. Run the result

Document the commands you used at each step.

### Exercise 5: Safe Casting

Given this class hierarchy, write code that safely downcasts using `dynamic_cast` and handles failure gracefully:

```cpp
class Shape {
public:
    virtual ~Shape() = default;
    virtual double area() const = 0;
};

class Circle : public Shape {
    double radius;
public:
    Circle(double r) : radius(r) {}
    double area() const override { return 3.14159 * radius * radius; }
    double circumference() const { return 2 * 3.14159 * radius; }
};

class Rectangle : public Shape {
    double width, height;
public:
    Rectangle(double w, double h) : width(w), height(h) {}
    double area() const override { return width * height; }
    double diagonal() const { /* implement */ }
};
```

Write a function `printShapeDetails(Shape* s)` that prints the area for any shape, plus the circumference if it is a `Circle` or the diagonal if it is a `Rectangle`.

---

### Junior → FAANG: Exercises as Interview Preparation, Not Just Practice

Each exercise in this section maps directly to a category of FAANG C++ interview question. The type-safe calculator tests your understanding of type system and cast safety. The string processor tests familiarity with the standard library. The configuration parser tests namespace and compilation model awareness. The shapes hierarchy tests OOP fundamentals and virtual dispatch.

When completing each exercise, time yourself and note which parts took longest. The slow parts are your weakest areas. Bring those specific areas to a study partner or mentor for targeted review before an interview.

### Senior @ FAANG: Exercise Design as a Team Investment

At the L6 level, the exercises in this chapter are a template for the onboarding exercises you design for your team. A good onboarding exercise: covers the team's actual patterns (not textbook patterns), has a clear correct solution that serves as the reference implementation, is scoped to be completable in 2 to 4 hours by a capable engineer new to C++, and includes at least one intentional trap (a UB, a subtle copy vs. reference issue) that the solution explicitly addresses.

Design two to three exercises for your team's C++ onboarding track and have a senior C++ engineer review them before adding them to the onboarding package. Exercises that are too easy teach nothing. Exercises that are too hard demoralize new engineers and slow ramp-up. The sweet spot is exercises that are completable but require looking things up, which builds the habit of using the right references.

