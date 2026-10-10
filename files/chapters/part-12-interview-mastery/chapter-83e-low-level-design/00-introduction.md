# Chapter 83E: Low-Level Design (Object-Oriented Design) in Go


### Junior → FAANG: Introduction to Low-Level Design Interviews

Low-level design (LLD) interviews evaluate your ability to design the classes, interfaces, and interactions that implement a specific feature or system component. Unlike system design (which focuses on distributed architecture), LLD focuses on object-oriented design, SOLID principles, and the internal structure of a component. Common LLD problems: parking lot, library management system, elevator controller, LRU cache, and rate limiter. The evaluation criteria: correct identification of entities and their responsibilities, clean interface design, and a concrete implementation that is testable and extensible.

### Senior @ FAANG: LLD as a Code Design Signal at the Senior Level

At the senior level, LLD interviews evaluate architectural thinking at the class level. The bar-raiser is not checking whether you know the Visitor pattern. They are checking whether you can identify the right abstraction boundaries, design interfaces that enable independent testing, and make your implementation extensible without over-engineering. Strong senior LLD answers demonstrate SOLID principles applied organically: not by reciting the principles but by producing designs where each class has one reason to change, where extensions add new code rather than modifying existing code, and where the code can be tested with minimal mocking. The review signal that separates L5 from L6 LLD is the ability to identify which aspects of the design are likely to change and to design specifically for those extension points.
