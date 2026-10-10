## Hot-Patching and Live Update in Embedded and Long-Running Systems

A system that runs for years between reboots cannot afford to restart for every bug fix. Kernels do it with kpatch/livepatch, user-space processes do it with shared-library replacement, and embedded systems do it with dual-bank firmware. The common discipline is: define a safe point, swap code at that point, verify, and keep the old code in memory until the new code is proven.

### Shared-library live reload in user space

The simplest technique is `dlopen`/`dlclose` of a plugin library. The main process holds a stable interface, all business logic lives in the plugin, and the plugin is swapped under a reader-writer lock.

```cpp
struct PluginAPI {
    void (*handle_request)(const Request*, Response*);
    void (*shutdown)();
    uint32_t version;
};

class HotLoader {
    std::shared_mutex mu_;
    void* handle_ = nullptr;
    const PluginAPI* api_ = nullptr;

public:
    bool Swap(const std::string& path) {
        void* h = dlopen(path.c_str(), RTLD_NOW | RTLD_LOCAL);
        if (!h) { LOG(ERROR) << dlerror(); return false; }
        auto* new_api = static_cast<const PluginAPI*>(dlsym(h, "kPluginAPI"));
        if (!new_api || new_api->version != PLUGIN_ABI_VERSION) {
            dlclose(h); return false;
        }

        void* old_h; const PluginAPI* old_api;
        {
            std::unique_lock lock(mu_);
            old_h = handle_; old_api = api_;
            handle_ = h;     api_ = new_api;
        }
        if (old_api) old_api->shutdown();
        if (old_h)   dlclose(old_h);
        return true;
    }

    void Dispatch(const Request* req, Response* rsp) {
        std::shared_lock lock(mu_);
        api_->handle_request(req, rsp);
    }
};
```

The reader lock serializes against swap but allows unbounded concurrent dispatch. The old handle is closed only after the shutdown hook drains in-flight work. If the plugin keeps pointers to its own `.rodata`, closing early corrupts live requests.

### ABI discipline for hot-reloadable plugins

The plugin API struct is the ABI contract. Rules:

- Never reorder fields.
- Never change a function signature, add a new function pointer at the end.
- Bump `version` on every add.
- Never expose C++ types across the boundary, only POD with explicit sizes.

An ABI break requires a cold restart. That is acceptable quarterly, not daily.

### Dual-bank firmware for embedded

An MCU-class device with 512KB of flash typically splits flash into two application banks plus a bootloader. The current bank runs, the next bank receives the OTA update, and the bootloader picks the newer valid bank on reset. The validation is a CRC plus a "successfully booted" flag written after a supervised uptime.

```
+----------------+ 0x00000  Bootloader (48 KB, read-only)
+----------------+ 0x0C000  Metadata page (version, CRC, boot count)
+----------------+ 0x0D000  Bank A application (224 KB)
+----------------+ 0x45000  Bank B application (224 KB)
```

The bootloader reads metadata, picks the bank with the higher version whose CRC verifies, jumps to its reset vector. If the app faults before posting the "healthy" flag within N seconds, the bootloader falls back to the other bank on next reset. This is the anti-brick guarantee: a bad update cannot permanently disable the device.

### Live patching within one bank

For fine-grained patches (a single function), Linux kernel livepatch and some real-time systems use a trampoline patched at function entry. The first 5 bytes of the function are atomically replaced with a jump to the new implementation. Safety requires:

- A consistency model. Kpatch uses "consistency at rest": no task's stack may contain a frame from the old version before the switch. Check stacks of all tasks, wait until clean, then flip.
- Atomic instruction replacement. On x86 5-byte jumps are tricky because the 5 bytes may cross an instruction boundary. The safe recipe is: write `int 3` (1 byte) first, then the 4-byte target, then atomically overwrite the `int 3` with `jmp`. Any core that hits the breakpoint is redirected by a trap handler.
- Per-function patches are expensive to audit. Most real systems patch at entire function granularity only.

### CRIU checkpoint/restore

For long-running user-space processes, CRIU dumps the full process state to disk and restores into a new binary. Useful for draining a node for maintenance, less useful for patching because the restored process still runs the old code. CRIU plus a handoff to a restarted sibling via socket passing is how some telecom stacks achieve five-nines availability.

### Safe points and state migration

Every hot-patch mechanism requires a safe point: a moment when no thread is executing old code that will be invalid after the swap. Strategies:

- Quiesce: stop admitting new work, drain in-flight, swap, resume.
- Versioned state: old and new code both understand the shared state format.
- Handoff: new code reads state from a snapshot produced by the old code at swap time.

Quiesce is simplest but adds a latency blip. Versioned state is highest availability but requires forward-compatible data layouts, which loops back to the ABI discipline above.

### Observability for patches

Every patch application is a security-sensitive event. Log version, SHA of the new library, actor, success/failure, and in-flight request count at swap. Emit a metric `patch_applied_total` with labels for version, and alert on unexpected downgrades. A patch mechanism without audit logs is a backdoor waiting to be used.

### Failure modes to plan for

- Plugin `dlopen` succeeds but `dlsym` returns a symbol from a stale version in memory. Use `RTLD_DEEPBIND` carefully, or avoid by renaming the exported symbol per version (`kPluginAPI_v7`).
- The new plugin's static initializers throw. `dlopen` returns non-null but the process is now in an undefined state. Wrap the whole swap in a subprocess-preflight that loads the plugin, calls a self-test, and reports success before the parent swaps.
- TLS variables in the plugin point into memory that `dlclose` unmaps. Either forbid TLS in plugins or use `RTLD_NODELETE` to keep the library mapped after close.
