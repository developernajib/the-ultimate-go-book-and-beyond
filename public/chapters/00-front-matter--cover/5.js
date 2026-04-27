export default `## How This Book Is Organized

This book is organized by **topic**, not strictly by chapter number. Some sub-chapters (like Chapter 18B, 18C, 18D) appear in a different part than their parent chapter (Chapter 18). This is intentional: sub-chapters are placed in the **thematic section** where they belong, so you can explore a topic end-to-end without jumping between parts.

For example, Chapter 18 (Testing in Go) lives in Part III: Production Ready, but Chapters 18B through 18D (advanced testing topics) are grouped in Part III-C: Testing at Scale. Similarly, Chapter 52 (Microservices) is in Part VIII, while 52F through 52I (Kafka, RabbitMQ, NATS) are in Part VIII-C: Message Queues. This way, if you are deep-diving into message queues or advanced testing, everything you need is in one place.

## How to Read This Book

Read linearly from Part 1 onward. The book is designed as a continuous progression for beginner and junior engineers who want to grow into confident, well-rounded software engineers.

**Optional and senior-only tracks** appear at the end of the book. These include AI/ML, Blockchain, eBPF and Linux Internals, Advanced C++ Concurrency, Advanced C++ Performance, Advanced C++ Production, and Computer Hardware and Architecture Foundations. Junior readers can treat these as:
- Revision material when returning to topics
- A path to switch fields later in your career
- Deeper exploration once core parts are mastered

Part XVIII is organized into four natural groups. Chapters 123-125 cover C++ fundamentals (mental model shifts from Go, modern C++17/20/23, memory management). Chapters 126-128 cover C++ concurrency and systems (std::thread, lock-free programming, OS interfaces). Chapters 129-131 cover C++ performance engineering (cache optimization, template metaprogramming, profiling). Chapters 132-134 cover C++ in production (build systems, testing, Abseil and Folly patterns). Each group can be read on its own. The Computer Hardware and Architecture Foundations track (Part XXIII, chapters 167-169) is an optional deep-dive that teaches how computers work from transistors to the OS scheduler, and is especially valuable before any performance profiling work or interview where you need to reason about cache misses, memory ordering, or scheduler mechanics.

### If You're Already a Senior or Staff Engineer

You have two ways to use this book.

**As a reference.** Jump to the topic on your desk. The table of contents is dense on purpose: sub-parts like Part V-B (database ecosystem), Part VIII-C (message queues), Part X-D (multi-region and disaster recovery), and Part XVI-B (observability extended) let you load the full context of one subject without skimming unrelated chapters. Each chapter ends with a Q&A section to check your understanding, plus 2-3 follow-up questions that double as self-checks before interviews or design reviews.

**As a revision loop.** Developers forget things quickly, especially the pieces they only touch during an incident. Read one sub-part per week, run the exercises and senior-track callouts, and rotate through the book over a quarter. The goal is not to read it linearly but to keep the fundamentals sharp while operating at scale.

**Where to go first at senior level.** Part III-B (million-RPS patterns), Part III-C (testing at scale, including testing in production), Part X-B (20 real system designs), Part VIII-B (domain-driven design), Part XIII (senior mindset and architecture patterns), and Part XIV-B (migration and modernization) are the densest senior-value sections. Optional parts (AI/ML, eBPF, C++ advanced, Computer Hardware and Architecture Foundations) are worth the detour if they intersect with your fleet. The hardware track (chapters 167, 168, 169) is especially useful before performance profiling work or before any interview where you need to explain cache misses, memory ordering, or scheduler mechanics from first principles.

---
`;
