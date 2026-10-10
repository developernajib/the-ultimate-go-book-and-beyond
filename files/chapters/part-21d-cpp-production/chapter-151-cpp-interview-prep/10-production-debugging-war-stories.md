## Production Debugging War Stories: What Senior Interviewers Probe

Senior C++ interviews at FAANG almost always include a "tell me about the hardest bug you debugged" question. The answer separates engineers who have only written code from engineers who have operated it. Below are the archetypes. Study the shape, then match it to a real incident from your own history.

### Archetype 1: The ABI silent corruption

**Symptom.** A service returns nonsense strings after a seemingly unrelated deploy. Crashes are rare. Valgrind clean. Reproduces only in prod.

**Diagnosis.** Two shared libraries in the process were compiled with different `_GLIBCXX_USE_CXX11_ABI` values. `std::string` layout differs. Strings written by one library are read as rubbish by the other. `nm -D libfoo.so | grep 'St7__cxx11'` vs the caller's mangling reveals the mismatch.

**Interview signal.** Do you reach for `nm` and `c++filt`. Do you know what libstdc++ dual ABI is. Do you know to pin the whole toolchain.

**Prevention.** One toolchain per repo. ABI diff (libabigail) in CI. Version scripts on every exported library.

### Archetype 2: The coordinated omission in p99

**Symptom.** Prometheus p99 looks flat. Users report frequent 3-second pauses. The SRE says the numbers disagree with reality.

**Diagnosis.** Naive histogram records only completed requests. During a GC pause (or a 3-second cgroup throttle event), requests stall but are not counted. After the pause, the system records hundreds of "fast" requests in one second. The average recovers, the p99 stays pristine, the users experienced 3 seconds.

**Interview signal.** Do you know the term coordinated omission. Do you know HDR histograms. Can you propose intended-rate correction.

**Prevention.** Measure both queue time and service time separately, record against intended arrival rate, alert on queue p99 rather than total.

### Archetype 3: The use-after-free that TSan found after ASan missed

**Symptom.** Crash in an allocator internal. ASan runs fail to reproduce. TSan reports a data race between a destructor and an unrelated method.

**Diagnosis.** A `std::shared_ptr<T>` was dereferenced on thread A while thread B decremented the last reference. The destruction itself is serialized correctly by shared_ptr's atomic refcount, but the non-atomic read-of-pointer-then-call on thread A observed the object after thread B had freed it. ASan sees a freed pointer only if the same allocation is reissued, which is timing-dependent. TSan catches it as a race because there is no happens-before edge between A's read and B's free.

**Interview signal.** Do you understand shared_ptr's atomic guarantee covers the control block, not the object's lifetime relative to other threads. Do you reach for `std::atomic<std::shared_ptr<T>>` (C++20) or `atomic_store`/`atomic_load` overloads.

**Prevention.** Pass shared_ptr by value across thread boundaries. Ban raw pointers as async callback data. Use sanitizer-combined CI.

### Archetype 4: The deadlock that only appears at 50 percent CPU

**Symptom.** Service is fine at 10 percent load. At 50 percent it hangs entirely. Restart recovers.

**Diagnosis.** Two mutexes acquired in opposite orders on two rarely-concurrent paths. At low load, the two paths never interleave. At higher load, interleaving is inevitable. `gdb thread apply all bt` on the hung process shows the classic waiting-for-lock-held-by-the-thread-waiting-for-my-lock.

**Interview signal.** Do you know `std::lock`, `std::scoped_lock`, or deadlock-free lock ordering. Do you know TSan's deadlock detector. Can you propose lock-free alternatives.

**Prevention.** Global lock order. Runtime lock-order verification in debug builds (absl::Mutex does this). `std::scoped_lock` for every multi-lock acquisition.

### Archetype 5: The OOM killer strike

**Symptom.** The database process vanishes. No core. No crash log. `journalctl -k` shows "Killed process 4217 (engine) total-vm:40G, anon-rss:35G".

**Diagnosis.** The kernel killed the process. No C++ crash mechanism fires for SIGKILL. The question is not why the process died (the kernel told you) but why RSS grew unbounded. Usually a cache without a size limit, or glibc malloc fragmentation pinning freed memory.

**Interview signal.** Do you read dmesg. Do you know `oom_score_adj`. Do you understand cgroup memory accounting. Do you know `MALLOC_ARENA_MAX` and jemalloc.

**Prevention.** Bounded caches. Jemalloc. Cgroup memory limits strictly below node memory. PSI-based early load shedding.

### Archetype 6: The cold-start latency spike

**Symptom.** First request after deploy takes 10x longer. Subsequent requests are fine. Alarm fires every deploy.

**Diagnosis.** Page faults on code. The binary was loaded but not resident. First executions trap into the kernel to page in `.text`. Large binaries (500MB+) with cold tcache and cold dynamic linker resolution compound the effect. Profile-guided optimization with `madvise(MADV_WILLNEED)` or a pre-warming phase fixes it.

**Interview signal.** Do you know page faults exist. Do you know `mlock`, `madvise`, and huge pages for text. Do you understand PGO and BOLT.

**Prevention.** Pre-warm with a synthetic traffic replay before admitting real traffic. mlock critical code segments. Use BOLT to pack hot functions into huge pages.

### How to tell your story in the interview

Structure: symptom, first hypothesis, why it was wrong, next hypothesis, diagnostic tool that confirmed the real cause, fix, prevention. Thirty seconds on symptom, two minutes on diagnosis (this is where seniority shows), thirty seconds on fix, thirty seconds on what you changed organizationally so it never returns. Interviewers trade notes on the diagnostic section, and that is where the signal is.
