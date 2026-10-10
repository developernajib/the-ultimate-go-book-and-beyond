## Exercises

Four hands-on labs. None of them require shipping production Carbon code (which is not possible in 2026). All of them give you concrete experience with the language, the design process, or the migration thinking. Treat the exercises as half-day to one-day investments.

### Exercise 1: Read a Design Document End to End

**Goal**: develop firsthand understanding of how Carbon design decisions are actually made.

**Steps**:
1. Open the `proposals` directory of the carbon-lang repository.
2. Pick a proposal that has been merged (status: accepted or shipped). Topics that are good starting points: package structure, generics, the class model, the import statement.
3. Read the proposal in full. Read the discussion thread on the corresponding pull request. Note the points of disagreement and how they were resolved.
4. Write a one-page summary: what problem the proposal addresses, what alternatives were considered, what tradeoffs were made, and what the final decision was.

**What you learn**: how language design decisions are debated, how good arguments are structured, and what kind of evidence moves a design discussion. This is a transferable skill regardless of whether Carbon succeeds.

**Time**: two to four hours, depending on the proposal's complexity.

### Exercise 2: Port a Small C++ Snippet

**Goal**: experience the friction and the cleanliness of translating real C++ code to Carbon.

**Steps**:
1. Pick a small self-contained C++ function or class from real code. Good candidates: a 30-line container class, a small graph algorithm, a parser for a simple data format. Keep it under 100 lines.
2. Write a Carbon version of the same code. Use the Carbon Explorer or your local install. The C++ snippet does not need to be one you can compile and link with Carbon, the goal is mental translation, not binary interop.
3. Note three things: what mapped cleanly (most of the basic syntax), what required a design choice (how to express references, how to express copy versus move, how to handle errors), and what does not have a Carbon equivalent (templates that rely on SFINAE, macros, exceptions).
4. Write a half-page note on what the migration would have cost if you were doing it for real.

**What you learn**: where the rough edges actually are. Reading the design documents tells you what the language wants to be. Translating real code tells you what the language is in practice.

**Time**: three to five hours.

### Exercise 3: Write a Generic Function and Break It

**Goal**: feel the difference between definition-site and instantiation-site type checking.

**Steps**:
1. In the Carbon Explorer or local install, write a generic function with a constraint. A good starting point is a function that returns the larger of two arguments, constrained on a Comparable interface.
2. Implement the constraint for one type. Verify that the function compiles and runs.
3. Add a method call inside the generic function body that is not in the constraint. For example, call SomeMethod that the constraint does not declare. Verify that the compiler rejects the function definition before any caller exists.
4. Now go to a C++ compiler and write the analogous template without a concept. Make the same mistake (call a method the type may not have). Verify that the C++ compiler accepts the template definition and only fails at instantiation.
5. Compare the error messages. Note where the error is reported, how readable it is, and how much code the error message references.

**What you learn**: the practical difference between the two type-checking models. This is the kind of hands-on comparison that gives you a real opinion about language design rather than a borrowed one.

**Time**: two to three hours.

### Exercise 4: File or Comment on an Issue

**Goal**: engage with the actual project at the level the project values.

**Steps**:
1. Read the carbon-lang repository's contributor guidelines. Note what kinds of issues and discussions are welcome.
2. Find an open issue or design discussion that you have a real opinion about, based on having read the relevant proposal. Do not pick something where you would just be agreeing with the existing direction.
3. Either file a new issue (only if it is a concrete, well-scoped issue and not a duplicate) or add a comment to an existing discussion. Keep it short, technical, specific, and respectful.
4. The comment should reference specific design document text, give a concrete example, and propose a concrete change or question. Vague opinions ("Carbon should be safer") are not useful contributions. Concrete observations ("In the proposal for X, the example on line Y produces ambiguity in case Z because of W") are useful.

**What you learn**: how to engage with a serious open-source language project at a senior level. This is a skill that transfers to every other open-source contribution you might want to make later.

**Time**: two to four hours, including the reading.

### Optional Stretch: Compare Carbon Generics with Rust Traits Hands-On

If exercises 1 through 4 leave you wanting more, write the same generic function in Carbon and in Rust, and compare:

- The syntax for the generic function and the constraint.
- The syntax for implementing the constraint for a type.
- The error messages when you violate the constraint at the definition site.
- The error messages when you call the function with an unconforming type.
- The compile time for both.

This is the kind of comparison that gives you a deep model of the design space and prepares you for any future language design conversation.

**Time**: half a day if you are familiar with Rust, longer if you are learning Rust at the same time.

### Junior at FAANG

Exercises 1 and 3 are right for you. They give you firsthand language and design exposure without requiring engineering judgment you have not built yet.

### Senior at FAANG

All four are right for you, plus the stretch. The fourth exercise in particular is what separates engineers who know about Carbon from engineers who can engage with Carbon as a real project.

---
