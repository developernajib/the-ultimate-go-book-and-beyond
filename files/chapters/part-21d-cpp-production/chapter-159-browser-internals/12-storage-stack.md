## 159.12 Storage Stack

Browsers expose half a dozen storage APIs to web pages. Behind those APIs is an opinionated C++ stack with origin partitioning, quota management, and a LevelDB-shaped persistence layer for most of it. The code lives across `content/browser/`, `services/storage/`, `third_party/blink/renderer/modules/`, and `components/services/storage/`.

### Storage APIs

The web platform surface, ordered roughly by capability:

- **Cookies.** Old, small, sent on every request. Synchronous. Origin-cookied.
- **localStorage / sessionStorage.** Key-value strings. Synchronous from JS. Per origin.
- **IndexedDB.** Indexed object store. Async. Per origin. Most capacity.
- **Cache Storage.** HTTP request/response pairs. Async. Per origin. Used by Service Workers.
- **File System Access.** OPFS (origin-private filesystem) or user-granted handles into real disk.
- **WebSQL.** Removed in Chrome 119 (Nov 2023). Was SQLite-backed.
- **Storage Buckets.** Modern abstraction (2023+) that lets a site create multiple named, individually evictable storage areas.

### Origin Partitioning

All storage is keyed by origin (and increasingly by storage key, which is origin plus top-level site for partitioning). Storage from `evil.com` cannot read storage from `bank.com`. This is enforced at every API entry point in the browser process.

In response to cross-site tracking via storage, modern Chromium partitions storage by `(top-level site, embedded origin)` for many APIs. A widget from `widget.com` embedded on `news.com` and on `shop.com` sees two separate Cache Storage instances.

### LevelDB Underneath

Most of the storage stack persists to LevelDB, Google's log-structured merge-tree key-value library:

- Cookies have a SQLite store but the Network State store uses LevelDB for some metadata.
- IndexedDB serializes object stores into LevelDB key-value pairs.
- Cache Storage serializes Cache entries into LevelDB.
- Service Worker registrations live in LevelDB.

Chromium vendors LevelDB in `third_party/leveldatabase/`. Each origin gets its own LevelDB instance under `~/.config/google-chrome/Default/IndexedDB/<origin>/`, which means hundreds of LevelDB instances per profile on a heavy-storage user.

### IndexedDB

The most powerful storage API. Async, transactional, indexed.

```js
const req = indexedDB.open('myDB', 1);
req.onupgradeneeded = (e) => {
  const db = e.target.result;
  const store = db.createObjectStore('users', { keyPath: 'id' });
  store.createIndex('byEmail', 'email', { unique: true });
};
```

Implementation:

- IDBFactory in Blink creates connections.
- Mojo IPC into the storage service.
- Storage service holds the per-origin LevelDB instance.
- Each transaction acquires a lock on its scope (object stores listed at transaction creation).
- Versioned transactions for `onupgradeneeded` are exclusive.

Blink Mojo interface:

```mojom
// third_party/blink/public/mojom/indexeddb/indexeddb.mojom
interface IDBFactory {
  Open(string name,
       int64 version,
       pending_associated_remote<IDBTransactionClient> txn,
       pending_associated_remote<IDBDatabaseCallbacks> db_callbacks)
      => (IDBOpenResult result);
};
```

IndexedDB performance is dominated by the LevelDB layer: writes are sequential to a write-ahead log, then compacted into SST files in the background. Queries against an index use a separate sorted key range in LevelDB.

A common foot gun: long-running read transactions hold a LevelDB snapshot, which prevents WAL checkpointing. Writers pile up, and disk usage grows until the read transaction ends.

### Cache Storage

The storage backing Service Workers' offline mode. API is `caches.open(name).then(c => c.put(req, res))`. Each Cache is essentially a map from `Request` (URL + method + headers) to `Response`.

Backed by:

- LevelDB for the index (request key to body locator).
- Side files for the response bodies (one file per cached response).
- Origin-partitioned just like IndexedDB.

Quota management is shared with IndexedDB and other storage. Eviction under pressure is per-origin, LRU.

### Service Workers

A Service Worker is a worker-thread JS context registered for a scope (URL prefix). It intercepts `fetch` events for navigations and subresources within that scope, allowing offline operation, custom routing, and push notifications.

Architecture:

- Registration metadata lives in a per-profile LevelDB (`Service Worker/Database/`).
- The script is stored in Cache Storage (separately from author Caches).
- A live Service Worker runs in a dedicated thread inside the renderer of its origin (or a separate renderer for cross-origin), with its own V8 isolate.
- The worker is started on demand: a navigation hits the scope, the browser starts the worker, the worker handles the fetch event, the browser may stop the worker again.

```cpp
// content/browser/service_worker/ contains:
class ServiceWorkerContextCore;       // Per-profile registry.
class ServiceWorkerRegistration;      // One per (origin, scope).
class ServiceWorkerVersion;           // One per script version.
class ServiceWorkerProcessManager;    // Where to host the worker.
```

Lifecycle phases for a Service Worker version: `kInstalling`, `kInstalled`, `kActivating`, `kActivated`, `kRedundant`. Transitions involve script comparison, claim of clients, and fetch handler installation. Spec compliance here is subtle and the test suite is enormous.

### Quota and Eviction

Each origin has a quota: a fraction of the disk's free space, capped. Storage estimates are exposed through `navigator.storage.estimate()`. When global storage exceeds a threshold, the browser evicts least-recently-used origins, dropping their storage entirely.

`StorageQuota` is the central authority, in `storage/browser/quota/`. Storage clients (IndexedDB, Cache Storage, file system, etc.) call into the quota manager before accepting writes that would exceed the budget.

### Storage Buckets

Storage Buckets (shipped 2023) let a site partition its own storage into multiple named buckets:

```js
const bucket = await navigator.storageBuckets.open('drafts');
const draftIDB = await bucket.indexedDB.open('drafts');
```

Each bucket has its own quota fraction, its own eviction unit, and its own persistence policy (`persisted: true` to opt out of automatic eviction). The motivation: a webmail app wants its drafts to survive eviction even if the cache of received messages does not. Without buckets, the whole origin is evicted as one unit.

### Storage Service Process

The `services/storage/` Mojo service hosts:

- Quota database.
- Storage Buckets manager.
- Sandboxed file system access.
- Some of the cookie store (transitional).

Renderers talk to the storage service through Mojo. Disk access happens in the storage service, not in the renderer. This is a security boundary: a compromised renderer cannot directly corrupt the LevelDB files.

### Cookies

Cookies are a separate stack, predating most of the above. Implemented in `net::CookieStore`, with a SQLite-backed default implementation. Cookie attributes that matter:

- `Secure`: HTTPS only.
- `HttpOnly`: not exposed to JS.
- `SameSite`: `Strict`, `Lax` (default), or `None` (requires `Secure`).
- `Partitioned` (CHIPS): bound to top-level site context, mitigates cross-site tracking.
- `Path`, `Domain`, `Max-Age` / `Expires`.

Modern Chromium has been steadily tightening cookie policy: third-party cookies are being phased out, with `Partitioned` cookies as the migration path for legitimate cross-site widgets.

### File System Access

`window.showOpenFilePicker()` returns a `FileSystemFileHandle` rooted in real user filesystem (with explicit user permission). OPFS (`navigator.storage.getDirectory()`) returns an origin-private virtual filesystem backed by a sandboxed area on disk.

OPFS is fast: it bypasses some of the IndexedDB ceremony for raw byte access. Used by SQLite-on-the-web (`sql.js-httpvfs`, `wa-sqlite`, `cr-sqlite`) and by Photoshop on the web.

### Performance Numbers

- IDB write transaction with one put: 1 to 5 ms typical (LevelDB sync write).
- IDB read from index: under 1 ms cached, 5 to 20 ms cold disk.
- localStorage `setItem`: synchronous, blocks main thread, single-digit ms small data, much worse if storage is large.
- Cache Storage `put` of a 100 KB response: 5 to 15 ms.
- Service Worker startup (cold): 20 to 100 ms.

### Senior Interview Material

- "Walk me through what happens when JS calls `caches.open('v1').then(c => c.put(req, res))`. List threads and processes."
- "Why does Chromium use LevelDB for IndexedDB and Cache Storage rather than SQLite?"
- "What is storage partitioning, and what attack does it defend against?"
- "Explain Service Worker startup. What state has to be hydrated, and what does the Cold Start Optimizer do?"
- "What problem do Storage Buckets solve that origin-level quota does not?"

The next section moves to real-time media: WebRTC.

---
