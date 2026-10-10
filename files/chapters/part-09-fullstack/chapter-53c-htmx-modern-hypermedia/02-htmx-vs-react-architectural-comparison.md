## 53C.2 htmx vs React: Why Hypermedia Often Beats SPAs

The decision between htmx and React is an architectural choice between two distinct design philosophies: **Hypermedia-Driven Applications (HDA)** and **Single-Page Applications (SPA)**.

For over ten years, the software industry defaulted to building SPAs for almost every web project. This created widespread architectural over-engineering. Understanding why hypermedia outclasses SPAs for data-driven systems requires examining how both approaches handle state, network efficiency, tooling, and team structure.

---

### Core Architectural Comparison

```
+---------------------------------------------------------------------------------+
| React Single-Page Application (SPA)                                             |
|                                                                                 |
| [ Browser ]                                  [ Go Backend ]                     |
|  - Redux / Zustand State Store                - Domain Logic                    |
|  - React Query Network Cache                  - SQL Database                    |
|  - Client-side Routing Engine                                                   |
|  - Virtual DOM Reconciliation                                                   |
|             |                                       ^                           |
|             | JSON Payload (data only)              |                           |
|             +---------------------------------------+                           |
+---------------------------------------------------------------------------------+
| Result: Two independent state machines. High risk of state synchronization bug. |
+---------------------------------------------------------------------------------+

+---------------------------------------------------------------------------------+
| htmx Hypermedia-Driven Application (HDA)                                        |
|                                                                                 |
| [ Browser ]                                  [ Go Backend ]                     |
|  - Native Browser DOM (14 KB htmx)            - Domain Logic                    |
|  - Zero client state store                    - HTML Template Rendering         |
|  - Standard browser URL navigation            - SQL Database                    |
|             |                                       ^                           |
|             | HTML Fragment (data + presentation)   |                           |
|             +---------------------------------------+                           |
+---------------------------------------------------------------------------------+
| Result: One state machine on the server. Zero client state synchronization bugs.|
+---------------------------------------------------------------------------------+
```

---

### 1. The State Synchronization Problem

In a React application, application state lives in two locations simultaneously: in the database on your server, and in JavaScript memory inside the user's browser.

To keep these two locations in sync, React codebases introduce layers of plumbing:

- State management libraries (Redux Toolkit, Zustand, Recoil).
- Cache invalidation and deduplication tools (TanStack React Query, SWR).
- Client-side schema validators (Zod, Yup) to verify JSON responses.
- Optimistic UI update handlers that guess what the server will do and roll back state on network failures.

Despite this machinery, bugs emerge constantly. A user opens two browser tabs, updates a resource in tab A, and views stale data in tab B. A network failure drops an update, leaving the client UI displaying data that does not exist in the database.

htmx eliminates client-side state synchronization. The server is the single source of truth. When the user initiates an action, the server executes the business logic, updates the database, renders an HTML fragment reflecting the new state, and returns it. The browser swaps the new fragment into the page. There is no client-side state store to invalidate, sync, or serialize.

---

### 2. Network Payload and Device Performance

A minimal React application starts with React and ReactDOM, which consume roughly 45 KB of compressed JavaScript before adding application logic. When you add a router, state manager, data-fetching library, and a component design system (such as Material UI or Ant Design), client bundles routinely exceed 300 KB to 2 MB of minified JavaScript.

```
Initial Page Load Pipeline Comparison:

React (SPA):
1. Download index.html (1 KB)
2. Download JS Bundle (400 KB - 1.5 MB)
3. Parse and compile JavaScript (CPU intensive)
4. Execute JS and mount root component
5. Hydrate DOM nodes
6. Fire API requests for initial JSON data
7. Parse JSON and render components
--> First Contentful Paint: 1.8s - 4.5s on mobile hardware

htmx (Hypermedia):
1. Download index.html with server-rendered content (15 KB)
2. Download htmx script (14 KB, non-blocking)
3. Browser renders HTML natively
--> First Contentful Paint: 200ms - 400ms on all hardware
```

On desktop developer workstations with high-speed fiber internet, SPA bundle sizes seem manageable. On mobile devices with constrained CPUs and fluctuating cellular networks, the difference is stark. In htmx, the browser displays content immediately because the initial response contains rendered HTML. The browser parser processes HTML incrementally using native C++ routines, bypassing the heavy JavaScript compilation and hydration phases that stall low-power mobile devices.

---

### 3. Toolchain and Infrastructure Overhead

Building a production React application requires a complex frontend build infrastructure:

- Node.js runtime and package managers (npm, pnpm, yarn).
- Module bundlers and compilers (Vite, Webpack, Turbopack, esbuild, Babel, SWC).
- Transpilation configuration files (`tsconfig.json`, `vite.config.ts`, `postcss.config.js`).
- Continuous vulnerability remediation: automated scanners regularly flag critical CVEs in deeply nested transitive npm dependencies.

For a Go backend team, this toolchain represents substantial operational friction. You must maintain two independent build steps in CI/CD pipelines, configure Docker multi-stage builds with Node.js base images, and coordinate frontend and backend version releases.

With htmx, the build step is optional. You can include htmx via a single `<script>` tag or vendor the 14 KB minified file into your Go binary using `go:embed`. Your entire application compiles down to a single, statically linked Go binary that contains your handlers, templates, and frontend hypermedia runtime.

---

### 4. Codebase Size and Velocity

Teams that migrate data-driven applications from React to Go plus htmx consistently report a 40 percent to 60 percent reduction in overall codebase size.

Where does the deleted code go?

1. **Elimination of JSON Data Transfer Objects:** You no longer need separate Go API response structs, TypeScript response interfaces, and mapping functions to convert between them.
2. **Elimination of API Client Boilerplate:** You do not write fetch wrappers, Axios interceptors, or query hook factories.
3. **Elimination of Form State Handlers:** You avoid writing `onChange` listeners, controlled input wrappers, and client form validation state machines. Standard HTML form fields submit their values directly.

A smaller codebase contains fewer locations for defects to hide. A Go backend engineer can implement a feature in one place: define the domain logic, write the SQL query, and render the HTML fragment using `html/template`.

---

### Architectural Comparison Matrix

| Evaluation Dimension             | htmx (Hypermedia-Driven)            | React (Single-Page App)                       |
| :------------------------------- | :---------------------------------- | :-------------------------------------------- |
| **Architectural Model**          | Hypermedia (HATEOAS)                | Client-side Component Tree                    |
| **Primary Data Wire Format**     | HTML fragments                      | JSON objects                                  |
| **Application State Location**   | Exclusively on server               | Duplicated on client and server               |
| **Client Library Size**          | ~14 KB (zero dependencies)          | 45 KB - 2 MB+ (hundreds of npm packages)      |
| **Build Pipeline Requirement**   | None (optional CSS minification)    | Mandatory (Vite, Webpack, Node.js)            |
| **First Contentful Paint (FCP)** | Instant (server-rendered)           | Delayed by JS download and hydration          |
| **SEO Support**                  | Native out of the box               | Requires Next.js, Remix, or complex SSR       |
| **Codebase Size for CRUD**       | Minimal (40-60% fewer lines)        | High (requires client state plumbing)         |
| **Team Cognitive Load**          | Low (Go skills transfer directly)   | High (dual stack: Go + TypeScript)            |
| **Offline Capability**           | Poor (requires server connectivity) | Excellent (can run offline via ServiceWorker) |

---

### Honest Technical Boundaries: When React Remains the Right Choice

Hypermedia is well suited for data-driven business software, but it is not appropriate for every problem. Senior engineers must recognize when an SPA is genuinely required.

React remains the proper architectural choice for:

1. **High-Frequency Local Canvas Manipulation:** Graphic design applications like Figma, image editors, and 3D modeling tools that execute 60 frames-per-second transformations directly in WebGL or HTML5 canvas.
2. **Offline-First Systems:** Applications that must operate without an active internet connection (such as field medical tablets, flight inspection apps, or remote warehousing scanners) and sync records when connectivity returns.
3. **Complex Local Spreadsheets:** Data grids with hundreds of interconnected formulas where updating cell A1 recalculates thousands of cells locally in memory without round-tripping to the server.
4. **Cross-Platform Native Code Sharing:** Organizations that share component state logic between web applications and iOS/Android clients via React Native.

If your application consists of forms, data tables, search filters, administrative dashboards, user management panels, or e-commerce workflows, you do not need an SPA. htmx delivers a simpler, faster, and more maintainable system.
