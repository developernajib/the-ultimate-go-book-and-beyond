## 09. Linux Processes: fork, exec, and Why Linux Is Weird About It

Windows and Linux both let you launch programs. The mechanics underneath could not be more different. Windows has a single syscall, `CreateProcess`, that takes the path to an executable and starts running it. Linux has two separate syscalls, `fork` and `exec`, and combining them is the only way to run a new program. This split design is called the Unix process model, and understanding it explains a lot about how shells, servers, and Go's `os/exec` work.

### Programs vs. Processes (Quick Recap)

A program is a file on disk. A process is a running instance of a program, with its own virtual address space, file descriptors, open network connections, signal handlers, and kernel bookkeeping. One program can become many processes (multiple `go run` invocations of the same binary). One process can replace itself with a different program entirely (that is exec).

### fork(): Cloning an Existing Process

`fork()` takes zero arguments. When a process calls it, the Linux kernel creates a near-perfect copy of the calling process. The child gets:

- A copy of the parent's virtual address space (all stack frames, heap data, global variables)
- Copies of all open file descriptors
- The same program counter value, so both parent and child resume execution right after the `fork()` call
- A copied signal mask and signal handlers

The only thing that differs is the return value of `fork()`: the parent gets the child's PID, the child gets 0. This is how a process knows which role it is playing.

```c
pid_t pid = fork();

if (pid == 0) {
    // child process: fork() returned 0
    printf("I am the child, my PID is %d\n", getpid());
} else {
    // parent process: fork() returned the child's PID
    printf("I spawned a child with PID %d\n", pid);
    wait(NULL); // wait for child to finish
}
```

#### Copy-on-Write (CoW)

Copying gigabytes of memory on every `fork()` would be catastrophically slow. Linux does not actually copy the memory pages immediately. Instead it marks all pages in both parent and child as read-only and shares the physical pages. The kernel only makes a real copy of a page when either process tries to write to it. This is **copy-on-write**.

For programs that immediately call `exec()` after `fork()` (which is the common case), the entire address space is discarded without ever being written. The CoW copy never happens. Cost is near zero.

### exec(): Replacing the Running Program

`exec()` (in practice one of the `execve`, `execvp`, `execl` family) does not create a new process. It replaces the calling process's program. The OS:

1. Locates the executable file on disk
2. Resets the process address space: clears stack, heap, text segment
3. Loads the new executable's code and data sections into memory
4. Resets the instruction pointer to the new program's entry point
5. Returns control to the new program

The process's PID stays the same. File descriptors remain open unless marked close-on-exec. The process continues running but is now executing a completely different program.

```c
// child process after fork()
char *args[] = { "/bin/ls", "-la", NULL };
execvp("/bin/ls", args);
// if exec succeeds, this line is never reached
// if exec fails, execution continues here
perror("execvp failed");
exit(1);
```

### The fork+exec Pattern

The standard Unix way to start a new program is to `fork()` first, then call `exec()` in the child. The parent waits for the child to finish using `wait()` or `waitpid()`.

```
Parent ─── fork() ──► Child
                       │
                       exec("/bin/ls")
                       │
                       ls runs, exits
                       │
Parent ◄── SIGCHLD ────┘
wait() returns
```

This two-step design seems redundant compared to `CreateProcess`, but the gap between `fork()` and `exec()` is actually useful. In that gap, the child can:
- Close file descriptors it does not want the new program to inherit
- Redirect stdin/stdout/stderr to pipes or files
- Set environment variables
- Change the working directory
- Lower privileges before running an untrusted binary

A shell does all of this every time it runs a command.

### Zombie Processes

When a child process exits, it does not immediately disappear. The kernel keeps a small record of the exit status so the parent can read it with `wait()`. Until the parent calls `wait()`, the child is a **zombie process**: dead but not yet cleaned up. It consumes almost no resources (no memory, no CPU), just a row in the process table.

If the parent never calls `wait()`, zombies accumulate. If the parent itself exits, the zombies are **reparented** to PID 1 (the init process or systemd), which calls `wait()` in a loop to reap them.

PID 1 is the first process started by the kernel at boot. Everything else is a descendant of PID 1 through a chain of `fork()` calls.

### Go's os/exec

Go wraps fork+exec in the `os/exec` package. The API hides the raw syscalls but follows the same model.

```go
package main

import (
    "fmt"
    "os/exec"
)

func main() {
    // Runs "ls -la" in a child process
    cmd := exec.Command("ls", "-la")
    output, err := cmd.Output()
    if err != nil {
        panic(err)
    }
    fmt.Println(string(output))
}
```

Internally, on Linux, `cmd.Run()` calls `fork()` followed by `exec()` in the child. Go uses `syscall.ForkExec` which is a combined operation using `clone` + `execve` to avoid issues with multithreaded programs and fork safety.

#### Fork Safety in Multithreaded Programs

`fork()` in a multithreaded process is dangerous. Only the thread that called `fork()` is duplicated in the child. Other threads simply vanish from the child's perspective. Any mutex held by a vanished thread is now permanently locked in the child. This is why `exec()` should follow `fork()` as quickly as possible, and why Go's `exec.Command` uses `clone` flags carefully to get a clean child state.

### Controlling Stdin, Stdout, and Stderr

One of the most practical uses of the fork+exec gap is pipe setup. Before calling exec, the child can replace its file descriptors. This is how `cmd | cmd2` works in a shell: a pipe is created, the first child's stdout is redirected to the pipe's write end, the second child's stdin is redirected to the pipe's read end, then both children exec their programs.

```go
cmd := exec.Command("grep", "ERROR")
cmd.Stdin = os.Stdin
cmd.Stdout = os.Stdout
cmd.Stderr = os.Stderr
cmd.Run()
```

### Why Not Just Use CreateProcess?

The fork+exec model appears wasteful: clone, then throw the clone away. The advantage is composability. Because you have full control of the child process state in the gap between fork and exec, you can build arbitrarily complex launch configurations in pure user space. Shells, container runtimes, and test harnesses all depend on this.

Windows achieves similar results through a more complex `CreateProcess` API with dozens of flags and inheritance rules, or through newer APIs like process attribute lists. For systems programming on Linux, fork+exec is the model you need to understand.

### Summary

| Concept | Detail |
|---|---|
| `fork()` | Clones the calling process, returns twice |
| Copy-on-write | Pages are only copied when written, not on fork |
| `exec()` | Replaces the running program, PID stays the same |
| Zombie process | Child that exited but parent has not called `wait()` yet |
| PID 1 | Ancestor of all processes, reaps orphaned zombies |
| Go `os/exec` | Uses `clone` + `execve` under the hood |

**Watch:** [The Weird Way Linux Creates Processes](https://www.youtube.com/watch?v=SwIPOf2YAgI)

**Watch:** [A PROGRAM is not a PROCESS](https://www.youtube.com/watch?v=7ge7u5VUSbE)
