# Chapter 129: Templates and Generic Programming

> Templates are the most far-reaching feature in C++. They are also the most misunderstood. (If in doubt, the thousand pages of Vandevoorde, Josuttis, and Gregor's *C++ Templates: The Complete Guide* exist for a reason.)

Go introduced generics in version 1.18 with a deliberately simple design: type parameters constrained by interface-based type sets. C++ has had templates since 1991, and over three decades they have evolved into a Turing-complete compile-time metaprogramming system. If Go generics are a sharp kitchen knife, C++ templates are a Swiss Army chainsaw. This chapter takes you from the first template declaration through advanced metaprogramming techniques, comparing every concept back to Go so you understand the tradeoffs each language makes.

By the end of this chapter you will be able to write function and class templates, specialize them for particular types, use SFINAE and concepts to constrain template parameters, build variadic templates that accept any number of arguments, implement the CRTP for zero-cost static polymorphism, and reason clearly about when compile-time polymorphism beats runtime polymorphism. You will also understand, at a deep level, why C++ templates and Go generics made fundamentally different design choices.

---

### Junior → FAANG: Templates as a Code Reading Skill Before a Code Writing Skill

Most Go engineers will read C++ template code before they write it. The primary skill to develop first is reading: when you see `template<typename T>`, identify what T is constrained to be by looking at how it is used. When you see SFINAE with `std::enable_if`, identify what it is excluding. When you see CRTP (`class Derived : public Base<Derived>`), recognize the static polymorphism pattern.

Writing templates comes after reading fluency. Start with simple function templates, move to class templates, then to specialization. Do not attempt variadic templates or CRTP until you are comfortable with the basics. Rushing to advanced templates before mastering basics produces code that compiles but does not do what you intended.

Interview entry point: "what is the difference between a function template and a function overload?" The answer: a template generates code for each type it is instantiated with (monomorphization), while an overload is a separately declared function. Templates add compile-time flexibility. Overloads add explicit per-type behavior. C++ generics use monomorphization, like Rust generics. Go generics use a hybrid (monomorphization for some types, dictionary dispatch for others).

### Senior @ FAANG: Template Discipline, Compile Time Governance, and Template Debt

At the staff level, templates are a compile-time performance risk. Each template instantiation generates code, and the compiler must compile each instantiation separately. A type with 50 template instantiations compiles 50 times as much code as a non-template type with the same behavior.

**Template instantiation audit.** When build times grow in a codebase, one of the first investigations is a template instantiation audit: which templates are instantiated the most, and can any of their instantiations be replaced by a common non-template implementation? Tools: `clang -ftime-report` to see compilation time per TU, `bloaty` to see code size per template instantiation. Common findings: a heavily-templated serialization library with 200+ instantiations that could be replaced by a virtual dispatch or a type-erased variant.

**Explicit instantiation declarations.** For templates that are instantiated in many translation units, explicit instantiation (`extern template class Foo<int>;` in the header, `template class Foo<int>;` in one .cpp) prevents the compiler from re-generating the code in every TU. This is a standard technique for reducing compile time in large codebases with widely-used templates. A staff engineer identifies the top 10 templates by instantiation count and applies explicit instantiation declarations.

**Concepts as the template complexity ceiling.** C++20 concepts replace SFINAE with readable, diagnosticable constraints. A staff engineer's policy: no new SFINAE in new code. Use concepts instead. Existing SFINAE is migrated incrementally, starting with the most widely-used templates (which have the most impactful error message improvements). The migration to concepts also improves compile times because the compiler can short-circuit template deduction earlier when a concept constraint is violated.

