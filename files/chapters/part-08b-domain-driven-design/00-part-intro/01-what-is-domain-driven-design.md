## What Is Domain-Driven Design?


---

> "The heart of software is its ability to solve domain-related problems for its users. All other features, vital as they may be, support this basic purpose."
>
> - Eric Evans, *Domain-Driven Design: Tackling Complexity in the Heart of Software*

---



Every non-trivial software system has a domain - the subject area, the business problem, the real-world concern that the software exists to address. An e-commerce platform's domain is buying and selling goods. A banking system's domain is managing money and accounts. A logistics platform's domain is moving packages from origin to destination. The domain is not the technology. It is not the database schema. It is not the HTTP routes. It is the core reason the software exists.

Domain-Driven Design (DDD) is a software development philosophy and a collection of concrete patterns, coined by Eric Evans in his landmark 2003 book, that places the domain and its logic at the very center of all design decisions. DDD says: before you think about tables, before you think about microservices, before you think about caching - deeply understand the problem you are solving, and let that understanding drive every architectural and implementation decision.

This is a deceptively simple idea. Most teams believe they are already doing this. They are not. Most teams build CRUD applications dressed up as domain models. They create `UserService` with `CreateUser`, `UpdateUser`, `DeleteUser` methods that do nothing but shuffle data between an HTTP layer and a database. The domain - the actual business rules, the invariants, the language of the experts who live in the domain every day - is absent. It exists nowhere in the code. It exists only in the heads of the business people, growing further and further divorced from the software that is supposed to implement it.

DDD closes that gap.

---
