export default `# Part I: Go Mastery

*"Simplicity is the ultimate sophistication."* - Leonardo da Vinci

---

Go was created at Google in 2007 by Robert Griesemer, Rob Pike, and Ken Thompson - three engineers who were frustrated with the complexity of existing systems languages and the slow build times of C++ at Google scale. The language they designed reflects a deliberate philosophy: simplicity over cleverness, composition over inheritance, and explicit behavior over magic. This philosophy is precisely why Go has become the language of choice for backend infrastructure at companies like Google, Uber, Cloudflare, Docker, and Kubernetes. Understanding Go at a deep level means understanding not just syntax, but the design decisions behind the language and how they shape the way you architect systems.

This part takes you from Go fundamentals through the language's most advanced features, building the foundation that every subsequent part of this book depends on. Whether you are coming from Python, Java, JavaScript, Rust, or C++, you will need to make fundamental mental model shifts - Go does not have classes, exceptions, or generics that work like templates. Instead, it has interfaces that enable polymorphism through behavior rather than hierarchy, error values that force explicit handling, and a type system that rewards simplicity. Engineers who try to write Java in Go or Python in Go produce code that fights the language. This part teaches you to think in Go.

The chapters progress from the "why" of Go through its type system, memory model, interfaces, internals, generics, error handling, and idiomatic composition patterns. By the end, you will have the language mastery that FAANG interviewers expect and the architectural intuition that comes from understanding how Go works under the hood - from the scheduler that manages your goroutines to the garbage collector that reclaims your memory.

**What this part covers:**
- Chapter 1: Why Go? The Industry Perspective - Go's origin story, where it excels, its design philosophy, and the companies that depend on it
- Chapter 2: Go Syntax Essentials - program structure, variables, types, functions, and core data structures
- Chapter 3: Go for Experienced Developers - mental model shifts from Python, Java, JavaScript, and other languages to Go thinking
- Chapter 4: Types Deep Dive - Go's complete type system including structs, slices, maps, and type assertions
- Chapter 5: Pointers and Memory - memory model, stack versus heap allocation, escape analysis, and pointer semantics
- Chapter 6: Interfaces - The Heart of Go - interface design, implicit satisfaction, composition, and the empty interface
- Chapter 6B: Modern Go Features - iterators, Swiss Tables, Green Tea GC, and features from Go 1.25 and 1.26
- Chapter 7: Go Internals - How Code Executes - the GMP scheduler, garbage collector, runtime internals, and execution model
- Chapter 7B: Compiler & Tooling Internals - SSA intermediate representation, Profile-Guided Optimization, build system, cgo, and DWARF debugging
- Chapter 8: Generics (Go 1.18-1.26) - type parameters, constraints, self-referential generics in 1.26, and practical generic patterns
- Chapter 9: Error Handling Mastery - error patterns, custom error types, wrapping, sentinel errors, and production error strategies
- Chapter 10: Composition & Go Idioms - embedding, functional options, builder patterns, and idiomatic Go code
- Chapter 10B: Go Modern Features - additional modern Go features and evolving language capabilities

**How to use this part:**
Read chapters 1 through 3 first for context and mental model orientation, especially if you are transitioning from another language. Chapters 4 through 6 form the core language foundation and should be read sequentially. Chapters 7 and 7B provide internals knowledge that deepens your understanding but can be revisited later. Chapter 8 on generics, chapter 9 on error handling, and chapter 10 on composition complete the language mastery curriculum. Every subsequent part of this book assumes you have absorbed the material in Part I.

**FAANG relevance:**
Go-specific coding interviews at Google, Uber, and other Go-heavy companies test your understanding of interfaces, error handling, goroutine lifecycle, and memory semantics. System design interviews expect you to reason about Go's runtime characteristics when justifying architectural choices. This part builds the language fluency that lets you write clean, idiomatic, and efficient Go code under interview pressure and in production environments where code quality is reviewed rigorously.

---`;
