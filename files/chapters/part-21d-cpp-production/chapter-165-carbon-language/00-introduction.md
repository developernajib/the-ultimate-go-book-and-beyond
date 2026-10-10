# Chapter 165: Carbon, Google's Experimental C++ Successor

> "If you could rebuild C++ today, knowing what we know now, you would not get C++.", Chandler Carruth, Carbon design talk, CppNorth 2022

Carbon is Google's open-source experimental programming language designed as a successor for C++ in codebases where C++ cannot reasonably be replaced by Rust. It was first announced publicly in July 2022 by Chandler Carruth at CppNorth, and it has been in active design and prototype implementation since. Carbon is not a finished language, it is not production-ready, and the team behind it has been explicit that anyone hoping to ship Carbon code in 2026 is reading the wrong project. What Carbon is, instead, is a serious attempt to answer a question the C++ committee has been unable to answer: how do you migrate billions of lines of legacy C++ to a safer, modern language without rewriting everything from scratch.

> **Important caveat**: Carbon is in active design and pre-1.0. The specifics in this chapter reflect the project's stated direction as of early 2026 and should be cross-checked against the carbon-lang repository (`github.com/carbon-language/carbon-lang`) before relying on any concrete API, syntax detail, or feature claim. Where this chapter describes syntax, treat it as illustrative of design intent rather than a commit-locked specification. The Carbon team has been clear that the language design is still moving and breaking changes are expected throughout the alpha phase.

## Why Google Built Carbon

Google has one of the largest C++ codebases on the planet. Internal estimates put it in the billions of lines, spread across services, build infrastructure, machine learning systems, browsers (Chromium), and operating systems (Fuchsia, ChromeOS). For a decade, Google has been one of the loudest voices on the C++ standards committee, pushing for safer defaults, modules, contracts, and a path to memory safety. Many of those efforts have stalled or shipped in forms the Google team considers inadequate.

Rust was the obvious alternative. Google has been adopting Rust aggressively in Android, in Fuchsia, and in some Chromium subsystems. But Rust has a problem that becomes painful at Google's scale: C++ interop. To call C++ from Rust, you typically use `cxx`, `bindgen`, or hand-written FFI shims. Templates do not survive the boundary. Inheritance does not survive the boundary. RAII semantics get translated awkwardly. For a codebase where every Rust file would touch C++ on its first day, the friction is enormous.

Carbon's central design bet is this: instead of building a safe language with painful C++ interop, build a language whose interop with C++ is as cheap as calling another C++ translation unit, then evolve toward safety over time. That is a different bet than Rust. It assumes that the cost of incompatible interop is higher than the cost of accepting some unsafety in the early years.

## Positioning vs Rust

Rust and Carbon are not direct competitors. They occupy adjacent slots:

- **Rust** is the right answer when you can write new code in a new language and you want memory safety from day one. Android's Rust adoption, Linux kernel modules, new networking services, all sit here.
- **Carbon** is targeted at the case where you cannot rewrite. You have a 30-million-line C++ codebase, you want to migrate file by file, and every file you migrate must call into and be called from the C++ that has not been migrated yet, with zero translation overhead and full template visibility.

If you have a greenfield project, the Carbon team itself recommends Rust. If you have a C++ codebase you cannot abandon, Carbon is the bet.

## Official Status

As of early 2026, Carbon is in what the project describes as the **0.x experimental** phase. The toolchain (an LLVM-based compiler) has reached an early milestone where simple programs compile and run, but the language is far from feature-complete. Generics, the class model, the memory and ownership story, and the C++ interop layer are all in various stages of design and partial implementation. The project's own documentation states that it should not be used for production work, and contributors describe the timeline to a usable 1.0 in years, not months.

This chapter is therefore not a tutorial in the way the Go or Rust chapters in this book are tutorials. It is a design tour. You will not finish this chapter ready to ship a Carbon binary. You will finish it understanding what Carbon is trying to do, why, and how that compares to the alternatives.

## What This Chapter Covers

The chapter walks through Carbon's design goals, its interop model with C++, its syntax direction, its approach to generics versus templates, its planned ownership story, and its current status. It closes with honest takes on when Carbon might matter to you, when it will not, and how to evaluate Google's track record on language launches.

## Junior at FAANG

You will not write Carbon at work in 2026. You may, however, see Carbon mentioned in design docs, internal mailing lists, or staff engineer talks. Knowing what it is and is not protects you from forming a strong opinion based on a tweet. Read this chapter as a literacy exercise.

## Senior at FAANG

Senior and staff engineers at companies with large C++ codebases should have a real model of Carbon's bet, because that bet informs language strategy decisions you may have to weigh in on: do we invest in Rust interop tooling, do we wait for Carbon, do we double down on modern C++. The answer for most teams is "Rust now, watch Carbon", and you should be able to defend that answer with technical specifics rather than vibes.

---
