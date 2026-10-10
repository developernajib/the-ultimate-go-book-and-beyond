## systemd and Service Management

> **Senior @ FAANG**: Like it or not, systemd is the init on every Linux distro that matters in production. A C++ service that does not integrate with `sd_notify`, socket activation, the journal native protocol, and watchdog will be operationally inferior, slower starts, missed crashes, opaque logs.

### 1. The Daemon Contract

A modern systemd-supervised service does **not**:

- `fork()` to background.
- `setsid()` and reopen `/dev/null`.
- Write a PID file.
- Open `/var/log/myservice.log` directly.
- Drop privileges by hand.

Instead it:

- Runs in the **foreground** as pid 1 of the cgroup.
- Writes to **stderr**, systemd routes to journal.
- Tells systemd "I am ready" via `sd_notify`.
- Receives sockets pre-opened by systemd.
- Lets the unit file (`User=`, `CapabilityBoundingSet=`, `NoNewPrivileges=`, `ProtectSystem=`, `PrivateTmp=`, ...) handle hardening.

This is a 50% reduction in C++ boilerplate and a 100× improvement in operational behavior.

### 2. Unit File Anatomy

```ini
# /etc/systemd/system/myservice.service
[Unit]
Description=My production service
After=network-online.target
Wants=network-online.target
Requires=myservice.socket

[Service]
Type=notify
NotifyAccess=main
ExecStart=/usr/bin/myservice --config /etc/myservice/config.yaml
Restart=on-failure
RestartSec=2s

# Resource limits (cgroup v2)
MemoryHigh=1800M
MemoryMax=2G
TasksMax=2048
CPUWeight=200
IOWeight=200

# Hardening
User=myservice
Group=myservice
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
PrivateDevices=true
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true
RestrictNamespaces=true
RestrictRealtime=true
RestrictSUIDSGID=true
LockPersonality=true
MemoryDenyWriteExecute=true
SystemCallArchitectures=native
SystemCallFilter=@system-service
SystemCallFilter=~@privileged @resources

# Watchdog
WatchdogSec=30s

# Capabilities, keep only what you need
CapabilityBoundingSet=CAP_NET_BIND_SERVICE
AmbientCapabilities=CAP_NET_BIND_SERVICE

# Reload semantics
ExecReload=/bin/kill -HUP $MAINPID

# Logging
StandardOutput=journal
StandardError=journal
SyslogIdentifier=myservice

[Install]
WantedBy=multi-user.target
```

```ini
# /etc/systemd/system/myservice.socket
[Unit]
Description=My service socket

[Socket]
ListenStream=0.0.0.0:8080
ReusePort=true
Backlog=4096
NoDelay=true

[Install]
WantedBy=sockets.target
```

This unit is more secure than 95% of production C++ services and required zero code.

### 3. `sd_notify`. Telling systemd You Are Alive

Link with `libsystemd` (`pkg-config --cflags --libs libsystemd`):

```cpp
#include <systemd/sd-daemon.h>

int main() {
    init_subsystems();
    open_listeners();

    // Tell systemd: ready to serve. Type=notify makes the unit "active" only now.
    sd_notify(0, "READY=1\n"
                 "STATUS=accepting connections\n"
                 "MAINPID=" /* automatic */);

    run_event_loop();   // ... main work ...

    sd_notify(0, "STOPPING=1\nSTATUS=draining\n");
    drain();
    return 0;
}
```

State changes you should notify:

| Notify | When |
|--------|------|
| `READY=1` | Initialization complete, only now is the unit "active." |
| `RELOADING=1`, then `READY=1` | Inside `ExecReload` SIGHUP handler. Pair both. |
| `STOPPING=1` | Caught SIGTERM, beginning graceful shutdown. |
| `STATUS=...` | Free-form one-liner shown in `systemctl status`. |
| `WATCHDOG=1` | Heartbeat (see §5). |
| `WATCHDOG_USEC=us` | Override interval at runtime. |
| `MAINPID=pid` | Tell systemd a different pid is the main one (after re-exec). |
| `FDSTORE=1` | "Save these fds for me" (see §6). |
| `BARRIER=1` | Block until systemd has processed prior state. |

`NotifyAccess=main` (default) restricts which processes can `sd_notify`. Use `NotifyAccess=all` only when forking workers must each notify.

### 4. Socket Activation

Systemd opens listening sockets and passes them to the service via fd inheritance. The service does not bind, does not handle `EADDRINUSE` on restart, and starts only on first connection if `Type=` allows.

```cpp
#include <systemd/sd-daemon.h>

int n = sd_listen_fds(/*unset_environment=*/1);
if (n <= 0) {
    // No fds passed, fall back to binding ourselves (test mode).
    return run_standalone();
}

for (int fd = SD_LISTEN_FDS_START; fd < SD_LISTEN_FDS_START + n; ++fd) {
    if (sd_is_socket_inet(fd, AF_INET, SOCK_STREAM, 1, 8080)) {
        accept_loop(fd);
    } else if (sd_is_socket_unix(fd, SOCK_STREAM, 1, "/run/myservice.sock")) {
        accept_loop_unix(fd);
    }
}
```

Benefits:

- Zero downtime restarts (sockets persist, clients see no reset, only a brief pause).
- Parallel boot, services start in parallel, blocking on first read of a peer's socket.
- No port-already-in-use races.

### 5. Watchdog

`WatchdogSec=30s` in the unit means: if the service does not call `sd_notify(0, "WATCHDOG=1")` within 30s, systemd kills (and restarts, given `Restart=`) it.

```cpp
uint64_t usec = 0;
if (sd_watchdog_enabled(0, &usec) > 0) {
    // Heartbeat at half the interval to allow for jitter.
    auto interval = std::chrono::microseconds(usec / 2);
    std::thread([interval]{
        for (;;) {
            std::this_thread::sleep_for(interval);
            sd_notify(0, "WATCHDOG=1\n");
        }
    }).detach();
}
```

For correctness, the heartbeat thread must heartbeat **only when the service is actually healthy**, drive it from your liveness probe (queue depths within bounds, reactor loop progressing, etc.), not from a `sleep` thread. A `sleep`-based heartbeat is a watchdog that lies.

### 6. fd Store. Surviving a Re-exec

A service can ask systemd to **hold** file descriptors during a restart. Useful for in-place upgrades that re-exec without losing TCP connections:

```cpp
sd_pid_notify_with_fds(0, 0, "FDSTORE=1\nFDNAME=clients\n", fds, n_fds);
```

After re-exec, `sd_listen_fds_with_names()` returns those fds. This is how you do hot upgrades: spawn new binary via `execve`, retrieve fds, drain old connections, accept new ones, without dropping a single socket.

### 7. Journal Native Protocol

`StandardError=journal` sends stderr to journal as plain text. The native protocol gives **structured fields**:

```cpp
#include <systemd/sd-journal.h>

sd_journal_send(
    "MESSAGE=request failed",
    "PRIORITY=%i", LOG_ERR,
    "REQUEST_ID=%s", req_id.c_str(),
    "USER_ID=%lu",   uid,
    "LATENCY_USEC=%lu", lat_us,
    "CODE_FILE=%s", __FILE__,
    "CODE_LINE=%i", __LINE__,
    "CODE_FUNC=%s", __func__,
    NULL);
```

Then `journalctl -u myservice REQUEST_ID=abc-123 -o json-pretty` filters efficiently. Indexed fields (uppercase, alphanumeric + underscore) are searchable in O(log n).

For hot paths, `sd_journal_sendv` with an `iovec` array avoids the variadic format pass.

### 8. Credentials (5.0+). Secrets Without Files

`LoadCredential=db_password:/etc/myservice/db.password` makes the credential available at `${CREDENTIALS_DIRECTORY}/db_password` only inside the service's mount namespace. Combine with `SetCredential=db_password:hunter2` to inject from the unit file (encrypted via `systemd-creds encrypt`).

Inside C++:

```cpp
const char* dir = std::getenv("CREDENTIALS_DIRECTORY");
if (!dir) abort();   // unit must set LoadCredential=
auto path = std::filesystem::path(dir) / "db_password";
auto pw = read_file(path);
```

This replaces world-readable config files and is the modern pattern for shipping secrets.

### 9. Production-Shape C++ Service Skeleton

```cpp
// service.cpp, integrates Type=notify, watchdog, signalfd, journal.
#include <systemd/sd-daemon.h>
#include <systemd/sd-journal.h>
#include <signal.h>
#include <sys/signalfd.h>
#include <sys/epoll.h>
#include <unistd.h>
#include <atomic>
#include <thread>
#include <chrono>

std::atomic<bool> g_healthy{true};
std::atomic<bool> g_shutdown{false};

static void heartbeat() {
    uint64_t us = 0;
    if (sd_watchdog_enabled(0, &us) <= 0) return;
    auto half = std::chrono::microseconds(us / 2);
    while (!g_shutdown.load()) {
        if (g_healthy.load()) sd_notify(0, "WATCHDOG=1");
        std::this_thread::sleep_for(half);
    }
}

int main() {
    // Block all signals - deliver via signalfd.
    sigset_t mask; sigemptyset(&mask);
    sigaddset(&mask, SIGTERM); sigaddset(&mask, SIGHUP);
    pthread_sigmask(SIG_BLOCK, &mask, nullptr);
    int sfd = signalfd(-1, &mask, SFD_CLOEXEC|SFD_NONBLOCK);

    // Inherit listening sockets.
    int n = sd_listen_fds(1);
    sd_journal_send("MESSAGE=service starting",
                    "PRIORITY=%i", LOG_INFO,
                    "INHERITED_FDS=%i", n,
                    NULL);

    // Init subsystems...
    init();

    // Notify ready and start heartbeat.
    sd_notify(0, "READY=1\nSTATUS=accepting requests\n");
    std::thread hb(heartbeat);

    // Main loop pseudo:
    int epfd = epoll_create1(EPOLL_CLOEXEC);
    /* add sfd, listen fds, etc. */
    while (!g_shutdown.load()) {
        epoll_event ev[16];
        int k = epoll_wait(epfd, ev, 16, 1000);
        for (int i = 0; i < k; ++i) {
            if (ev[i].data.fd == sfd) {
                signalfd_siginfo si;
                while (read(sfd, &si, sizeof si) == sizeof si) {
                    if (si.ssi_signo == SIGTERM) {
                        sd_notify(0, "STOPPING=1\nSTATUS=draining\n");
                        g_shutdown = true;
                    } else if (si.ssi_signo == SIGHUP) {
                        sd_notify(0, "RELOADING=1\nSTATUS=reloading\n");
                        reload_config();
                        sd_notify(0, "READY=1\nSTATUS=accepting requests\n");
                    }
                }
            } else {
                handle_io(ev[i]);
            }
        }
    }

    drain();
    hb.join();
    return 0;
}
```

This is ~80 lines and integrates every systemd primitive a senior engineer is expected to know.

### 10. Junior → FAANG Cheatsheet

| Junior | FAANG-grade |
|--------|-------------|
| `Type=forking` + PID file | `Type=notify` + `sd_notify`. |
| Bind in C++ on startup | Socket activation via `sd_listen_fds`. |
| Crash silently | Watchdog driven by liveness probe. |
| Plain text logs | `sd_journal_send` with structured fields. |
| Config files for secrets | `LoadCredential=` + `${CREDENTIALS_DIRECTORY}`. |
| Drop priv by hand | `User=`, `CapabilityBoundingSet=`, `AmbientCapabilities=`. |
| `chroot` in C++ | `ProtectSystem=strict`, `PrivateTmp=true`, `RestrictNamespaces=true`. |
| Restart loop in code | `Restart=on-failure`, `RestartSec=`, exponential `RestartSteps=`. |

When the on-call SRE pages you, the unit file is the artifact they read first. Make it good.
