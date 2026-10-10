## 7. Shared Libraries and Plugin Architectures

### Loading Libraries at Runtime

`dlopen` loads a shared library into the process at runtime. Combined with `dlsym`, it enables plugin architectures where functionality is discovered and loaded dynamically.

```cpp
#include <dlfcn.h>
#include <iostream>
#include <stdexcept>
#include <string>
#include <memory>

class SharedLibrary {
    void* handle_ = nullptr;

public:
    explicit SharedLibrary(const char* path, int flags = RTLD_LAZY) {
        handle_ = dlopen(path, flags);
        if (!handle_)
            throw std::runtime_error(
                std::string("dlopen: ") + dlerror());
    }

    ~SharedLibrary() {
        if (handle_) dlclose(handle_);
    }

    SharedLibrary(const SharedLibrary&) = delete;
    SharedLibrary& operator=(const SharedLibrary&) = delete;

    template <typename Func>
    Func get_symbol(const char* name) {
        dlerror();  // Clear previous errors
        void* sym = dlsym(handle_, name);
        const char* err = dlerror();
        if (err)
            throw std::runtime_error(
                std::string("dlsym: ") + err);
        return reinterpret_cast<Func>(sym);
    }
};
```

### Symbol Visibility

By default, all symbols in a shared library are exported, which slows loading and pollutes the global symbol namespace. Use visibility attributes to control what is exposed.

```cpp
// Compile with: -fvisibility=hidden

// Explicitly export only the public API
#define PLUGIN_API __attribute__((visibility("default")))

// Plugin interface -- pure virtual base class
class IPlugin {
public:
    virtual ~IPlugin() = default;
    virtual const char* name() const = 0;
    virtual void execute() = 0;
};

// Plugin implementation (in the .so file)
class MyPlugin : public IPlugin {
public:
    const char* name() const override { return "MyPlugin"; }
    void execute() override { /* Do work */ }
};

// Factory function -- the only exported symbol
extern "C" PLUGIN_API IPlugin* create_plugin() {
    return new MyPlugin();
}

extern "C" PLUGIN_API void destroy_plugin(IPlugin* p) {
    delete p;
}
```

### Plugin Manager

`PluginManager` opens each `.so` with `RTLD_NOW` (resolving all symbols immediately so missing symbols fail at load time rather than at first call), retrieves the `create_plugin` and `destroy_plugin` symbols via `dlsym`, and stores the destruction function pointer alongside the instance so cleanup is always paired with creation. The `std::unique_ptr<SharedLibrary>` ensures `dlclose` is called when the plugin is unloaded.
```cpp
class PluginManager {
    struct LoadedPlugin {
        std::unique_ptr<SharedLibrary> lib;
        IPlugin* instance = nullptr;
        void (*destroyer)(IPlugin*) = nullptr;
    };

    std::vector<LoadedPlugin> plugins_;

public:
    void load(const char* path) {
        LoadedPlugin lp;
        lp.lib = std::make_unique<SharedLibrary>(path, RTLD_NOW);

        auto creator = lp.lib->get_symbol<IPlugin*(*)()>("create_plugin");
        lp.destroyer = lp.lib->get_symbol<void(*)(IPlugin*)>("destroy_plugin");
        lp.instance = creator();

        std::cout << "Loaded plugin: " << lp.instance->name() << "\n";
        plugins_.push_back(std::move(lp));
    }

    void execute_all() {
        for (auto& lp : plugins_) {
            lp.instance->execute();
        }
    }

    ~PluginManager() {
        for (auto& lp : plugins_) {
            if (lp.destroyer && lp.instance) {
                lp.destroyer(lp.instance);
            }
        }
    }
};
```

**Key design rule:** Always use `extern "C"` for exported factory functions. C++ name mangling differs between compilers and even compiler versions. A C-linkage factory returning a pointer to a C++ interface is the standard pattern.

---
