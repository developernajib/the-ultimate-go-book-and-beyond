## 85.7 Mental Models for Systems

### Useful Mental Models

Mental models compress complex system behaviors into memorable principles that guide design decisions. Six models are particularly valuable for software engineers: queuing theory explains why latency explodes as utilization approaches 100%, Amdahl's Law sets the ceiling on parallelization gains, Little's Law connects throughput to queue depth, the CAP theorem defines the consistency/availability trade-off in distributed systems, the Universal Scalability Law explains why coordination costs destroy horizontal scaling, and the Swiss Cheese Model justifies defense-in-depth security.

```
┌──────────────────────────────────────────────────────────────────┐
│                    SYSTEMS MENTAL MODELS                         │
├──────────────────────────────────────────────────────────────────┤
│                                                                  │
│  1. QUEUING THEORY                                               │
│     "Systems queue when arrival rate > service rate"             │
│     Application: Understand latency spikes under load            │
│     Key insight: At 80% utilization, queues grow rapidly         │
│                                                                  │
│  2. AMDAHL'S LAW                                                 │
│     "Speedup limited by non-parallelizable portion"              │
│     Application: Know when parallelization won't help            │
│     Key insight: 5% sequential = max 20x speedup                 │
│                                                                  │
│  3. LITTLE'S LAW                                                 │
│     L = λW (Items in system = arrival rate × time in system)     │
│     Application: Capacity planning and queue sizing              │
│     Key insight: To reduce queue, reduce latency or rate         │
│                                                                  │
│  4. CAP THEOREM                                                  │
│     "In partition, choose Consistency or Availability"           │
│     Application: Distributed database design                     │
│     Key insight: You always make this choice, explicitly or not  │
│                                                                  │
│  5. UNIVERSAL SCALABILITY LAW                                    │
│     "Coherence costs limit scalability"                          │
│     Application: Understanding why adding servers doesn't help   │
│     Key insight: Coordination has costs that grow nonlinearly    │
│                                                                  │
│  6. SWISS CHEESE MODEL                                           │
│     "Failures happen when holes align"                           │
│     Application: Defense in depth, multiple safeguards           │
│     Key insight: Single defenses always have holes               │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘
```

### Applying Queuing Theory

Little's Law (`L = λW`) is the most practically useful equation in capacity planning: the number of items in a system equals the arrival rate multiplied by the average time each item spends in the system. Combined with the M/M/1 queue model, it reveals a non-obvious truth: at 80% utilization, average queue length is already 4x the service capacity, and by 95% utilization it is 19x. This is why systems that feel fine at moderate load exhibit sudden latency explosions, you are not in a linear scaling regime, you are approaching an asymptote.

```go
package main

import "fmt"

// Little's Law: L = λ × W
// L = average items in system
// λ = average arrival rate
// W = average time in system

type QueueAnalysis struct {
    ArrivalRate      float64  // requests per second
    ServiceRate      float64  // requests we can handle per second
    Utilization      float64  // ArrivalRate / ServiceRate
}

func (q *QueueAnalysis) Calculate() {
    q.Utilization = q.ArrivalRate / q.ServiceRate

    // M/M/1 queue model (single server, random arrivals)
    if q.Utilization >= 1 {
        fmt.Println("System is overloaded, queue grows unboundedly")
        return
    }

    // Average items in queue
    Lq := (q.Utilization * q.Utilization) / (1 - q.Utilization)

    // Average wait time in queue
    Wq := Lq / q.ArrivalRate

    fmt.Printf("Utilization: %.1f%%\n", q.Utilization*100)
    fmt.Printf("Avg items queued: %.2f\n", Lq)
    fmt.Printf("Avg wait time: %.2f ms\n", Wq*1000)
}

// Example usage:
func main() {
    analysis := &QueueAnalysis{
        ArrivalRate: 800,   // 800 requests/sec
        ServiceRate: 1000,  // Can handle 1000 requests/sec
    }
    analysis.Calculate()
    // Utilization: 80%
    // Avg items queued: 3.2
    // Avg wait time: 4ms

    // At 95% utilization:
    analysis.ArrivalRate = 950
    analysis.Calculate()
    // Utilization: 95%
    // Avg items queued: 18.05
    // Avg wait time: 19ms
    // Small increase in load → Big increase in queue
}
```

### Junior → FAANG: Building Your Mental Model Library

Mental models are pre-computed reasoning patterns. The more mental models you have internalized, the faster you can reason about unfamiliar systems in an interview. The queue theory model described in this section (small load increase producing large queue growth near capacity) is one every distributed systems engineer should have internalized. Practice explaining it without looking at the code.

Other models worth internalizing before a FAANG interview: the two-generals problem and why distributed consensus is hard, the CAP theorem and its practical implications, Little's Law and its relationship to latency under load, and the fallacies of distributed computing. Each of these is a reusable reasoning frame that applies across many system design problems.

### Senior @ FAANG: Teaching Mental Models as Organizational Infrastructure

At staff level, the value of mental models extends beyond your personal reasoning to the quality of reasoning across your entire team and organization. A team that has internalized queuing theory reasoning will collectively produce better capacity planning. A team that understands the CAP theorem tradeoffs will make better database selection decisions without needing your involvement in each one.

The investment: teach mental models explicitly, not just implicitly. Write a short internal post that explains one mental model and its application to a real system your team owns. Run a systems thinking reading group that covers Donella Meadows' work. Build the queuing analysis model into your team's capacity planning template. These investments in shared reasoning infrastructure pay compounding dividends as the team makes better decisions autonomously.

---
