## 83E.1 Overview

Low-Level Design (LLD), also called Object-Oriented Design (OOD), is a staple of FAANG interviews. The interviewer gives you a real-world system - a parking lot, an elevator, a library - and asks you to design its classes, relationships, and APIs.

Go does not have traditional OOP (no classes, no inheritance). But Go's combination of **interfaces**, **structs**, and **composition** maps cleanly onto OOD concepts - often producing cleaner designs than class hierarchies.

This chapter covers 10 classic LLD problems, each with:
- Requirements gathering
- API design
- Go structs and interfaces
- Full working implementation
- SOLID principles analysis


### Junior → FAANG: LLD Interview Fundamentals

LLD interview success requires fluency with object-oriented design patterns and their Go equivalents. Go does not have classes or inheritance, but it has interfaces and composition, which enable the same design goals. Key patterns to know: Strategy (encapsulate algorithms behind an interface), Factory (decouple object creation from usage), Observer (event notification without tight coupling), Command (encapsulate actions as objects for undo/redo or queuing), and Decorator (add behavior to an existing type without modifying it). Practice implementing each pattern in Go before the interview.

### Senior @ FAANG: LLD as a Platform Thinking Exercise at the Senior Level

Senior engineers approach LLD problems with platform thinking: not just 'how do I implement this feature' but 'how do I design this so it can be maintained, tested, and extended by other engineers on my team who do not have my context'. The SOLID principles are a codification of this thinking. The most important principle for senior LLD at FAANG is the Open-Closed Principle: the design should be open for extension (adding new behavior requires adding new code) and closed for modification (adding new behavior should not require changing existing code that already works). Violating this principle creates fragile designs where every new requirement breaks existing tests. Senior candidates should proactively identify the extension points in their LLD design and explain why those specific points are extensible.

---
