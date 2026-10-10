## Table of Contents
1. [Project Overview](#project-overview)
2. [Learning Objectives](#learning-objectives)
3. [System Architecture](#system-architecture)
4. [Project Setup](#project-setup)
5. [Pipeline Definition Language](#pipeline-definition-language)
6. [Core Domain Models](#core-domain-models)
7. [Database Layer](#database-layer)
8. [Pipeline Parser](#pipeline-parser)
9. [Job Execution Engine](#job-execution-engine)
10. [Container Integration](#container-integration)
11. [Git Integration](#git-integration)
12. [Artifact Management](#artifact-management)
13. [Log Streaming](#log-streaming)
14. [Worker Management](#worker-management)
15. [API Server](#api-server)
16. [Web Dashboard](#web-dashboard)
17. [Security Considerations](#security-considerations)
18. [Testing Strategy](#testing-strategy)
19. [Deployment](#deployment)
20. [Production Checklist](#production-checklist)

---

### Junior → FAANG: Using a Table of Contents as a Learning Map

A table of contents is more than navigation. For interview preparation, it is a checklist of system components you should be able to explain from first principles. Junior engineers often skip to implementation chapters. The prerequisite gap is understanding how each section depends on the previous one: the pipeline definition language shapes the domain models, which constrain the database schema, which affects the parser design. Practice by picking any two adjacent sections and explaining the coupling between them before reading the implementation.

### Senior @ FAANG: Evaluating Architecture Through Document Structure

A staff engineer reviewing a new platform proposal looks at the table of contents first to assess whether the authors understood their own problem. Missing sections are signals: no "multi-tenancy" section means isolation was not considered, no "failure modes" section means the authors optimized for the happy path. When leading a design review, require the owning team to justify the ordering of sections. Deployment before testing is a red flag. Security appearing after implementation suggests it was bolted on after the core was built. Use the structure of this document as a template when bootstrapping a new internal platform, and treat section omissions as explicit review comments that require a written justification in the ADR.
