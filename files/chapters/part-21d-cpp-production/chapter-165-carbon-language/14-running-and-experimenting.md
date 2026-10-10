## Running and Experimenting

This section is the closest thing in this chapter to a tutorial. The goal is to get you to a point where you can run a small Carbon program and see something happen. Specifics will drift, the carbon-lang README is authoritative.

### Easiest Path: Carbon Explorer

The Carbon Explorer is a browser-based playground. You write Carbon code in a text area, the compiler runs in WebAssembly in your browser, and the output shows below. No install required.

To use it:

1. Open the carbon-lang project's website (linked from the GitHub repository's README).
2. Find the "try it" or "playground" link.
3. Paste in a small program.
4. Click run.

This is the right starting point for everyone. You learn what compiles and what does not without committing to a local install.

A starter program (illustrative syntax):

```carbon
package HelloWorld;

fn Main() -> i32 {
  Print("Hello, Carbon");
  return 0;
}
```

Whether the exact entry point spelling is `Main`, the exact print function spelling, and the exact module declaration look like the above depends on the current state of the language. Use the Explorer's example programs as your reference.

### Local Install

For more serious experimentation you need a local toolchain. The current install path, as documented by the project, is approximately:

1. Install Bazel at the supported version. Check the carbon-lang README for the exact version pin.
2. Install Clang and LLVM at compatible versions.
3. Clone the repository:
   ```
   git clone https://github.com/carbon-language/carbon-lang
   cd carbon-lang
   ```
4. Build the toolchain through Bazel:
   ```
   bazel build //toolchain
   ```
5. Run the resulting binary against a Carbon source file:
   ```
   ./bazel-bin/toolchain/carbon compile your-file.carbon
   ```

The exact target names and command-line flags change. Read the README of whatever commit you check out.

Be prepared for build failures, slow first-time builds (LLVM is large), and rough edges. You are using an alpha toolchain.

### A Small Generic Function

Once you have a working setup, write a small generic function as your first real exercise. Something like a generic max function or a generic accumulator. The illustrative shape:

```carbon
package Demo;

interface Comparable {
  fn Less[self: Self](other: Self) -> bool;
}

fn Max[T:! Comparable](a: T, b: T) -> T {
  if (a.Less(b)) { return b; }
  return a;
}

impl i32 as Comparable {
  fn Less[self: i32](other: i32) -> bool {
    return self < other;
  }
}

fn Main() -> i32 {
  let bigger: i32 = Max(3, 7);
  Print(bigger);
  return 0;
}
```

Goals when you write something like this:

- Get the program to compile and run.
- Read the error messages when it does not compile and notice whether they are pointed at the right line.
- Try to break the constraint check intentionally (call a method on `T` that is not in `Comparable`) and verify that the compiler catches it at the function definition rather than at the call site.

That last test is the demonstration of what definition-site generic checking actually feels like. If the project has implemented it correctly, you should see the error on the definition of `Max`, not on `Main`.

### Reading the Design Documents

Beyond running code, the more valuable activity in 2026 is reading the design documents. The carbon-lang repository has a `proposals` directory where each design decision is a markdown document with a structured discussion. Pick one, read it, and follow the discussion thread.

Start with whichever proposal is closest to a feature you care about: classes, generics, interfaces, error handling. Each proposal is structured with a problem statement, a proposed solution, alternatives considered, and the discussion that led to the merged version. This is one of the better ways to understand how a language design decision is actually made, regardless of whether Carbon itself succeeds.

### Filing an Issue Worth Filing

The carbon-lang repository accepts issues. The issues that are useful are not "Carbon should look like Rust" or "Carbon should be safer". The useful issues are concrete:

- A specific syntax case that does not parse and you think should.
- A specific design decision in a proposal that you think has a flaw and you can describe with examples.
- A specific behavior in the Explorer that contradicts the documented behavior.
- A specific interop case (a particular C++ pattern) that you have tried and that does not work.

Filing a useful issue requires that you have read enough of the project to know what is in scope. This is the skill the project values, more than enthusiasm.

### What You Will Not Be Able to Do

To set expectations: do not expect to write a non-trivial program in Carbon as of early 2026. Do not expect to find libraries to depend on. Do not expect editor support beyond syntax highlighting. Do not expect debugger integration. Do not expect to ship anything.

Treat the experiment as exploration of a design, not as building software.

### Junior at FAANG

You should run hello-world in the Carbon Explorer and write one small generic function. That is a half-hour exercise and gives you enough firsthand experience to talk about the language honestly.

### Senior at FAANG

You should additionally read at least two design proposals from the carbon-lang repository in full, including the discussion thread, and form an opinion about whether the design decision was made well. This takes a couple of hours and gives you the kind of grounded view that lets you contribute to internal language strategy discussions.

---
