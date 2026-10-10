## 105B.12 Common Mistakes

**Mistake 1: Alerting on every metric**

Every system metric can be made into an alert. This is almost always wrong. The question is not "can I alert on this?" but "what action does the on-call engineer take when this fires?" If the answer is "check if it correlates with errors," do not alert on it. Alert on the errors directly.

---

**Mistake 2: Threshold alerts without burn rate context**

An alert for "error rate > 1%" without burn rate context is noisy and misleading. A 1% error rate for 1 minute during a deployment is very different from a 1% error rate for 6 hours. Use multi-burn-rate alerting.

---

**Mistake 3: Runbooks without copy-paste commands**

A runbook that says "query the database to identify slow transactions" is not a runbook. It is a vague suggestion. Every diagnosis step must include the exact command. On-call engineers are running these at 2 AM. Cognitive load is high. Commands must be copy-pasteable.

---

**Mistake 4: Blameful postmortems**

If a postmortem's action item is "Engineer X needs to be more careful," the postmortem has failed. The systemic question is: why was the system or process designed in a way that allowed Engineer X's mistake to reach production? The postmortem is a design review, not a performance review.

---

**Mistake 5: Postmortem action items without owners or due dates**

Action items that say "the team should improve testing" are theater. Every action item needs: a named owner, a due date, and a ticket in the project management system. Without these, the action item does not exist.

---

**Mistake 6: Debug endpoints on public ports**

`/debug/pprof` exposes CPU profiles, memory contents, and goroutine stacks, extremely sensitive information. It must be on an internal-only port (e.g., :6060) not accessible from the public internet. This is a security vulnerability, not just an inconvenience.

---

**Mistake 7: Not preserving diagnostic artifacts before restarting**

When a Go service is in a bad state, the goroutine dump, heap profile, and recent logs are invaluable for postmortem analysis. Engineers who restart the service before capturing these artifacts destroy the primary evidence. Always capture first, remediate second.

---

**Mistake 8: SLO set too high without engineering investment**

Setting a 99.99% SLO (52.6 minutes/year downtime) without the engineering infrastructure to support it is common and harmful. The SLO creates pressure to overreact to every incident, freeze deployments, and burn out engineers. Set the SLO you can actually achieve with your current architecture, then raise it as you invest in reliability.

---

**Mistake 9: Missing graceful shutdown**

```go
// Bad: process exits immediately on SIGTERM, killing in-flight requests
func serveWithoutGracefulShutdown(handler http.Handler) {
	http.ListenAndServe(":8080", handler)
}

// Good: graceful shutdown drains in-flight requests before exiting
func serveWithGracefulShutdown(handler http.Handler) {
	srv := &http.Server{Addr: ":8080", Handler: handler}

	go func() {
		if err := srv.ListenAndServe(); err != http.ErrServerClosed {
			log.Fatal(err)
		}
	}()

	quit := make(chan os.Signal, 1)
	signal.Notify(quit, syscall.SIGTERM, syscall.SIGINT)
	<-quit

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	if err := srv.Shutdown(ctx); err != nil {
		log.Printf("graceful shutdown failed: %v", err)
	}
}
```

Missing graceful shutdown causes dropped requests on every deployment. This consumes error budget unnecessarily and creates noisy alerts.

---

**Mistake 10: Not practicing incident response before a real incident**

Teams that have never run a game day (simulated incident) are unprepared for real incidents. The first time you should exercise the runbook is not during a 3 AM production outage. Schedule quarterly game days. Break things intentionally. Practice the IC role. Practice writing incident updates. Practice using PagerDuty. The investment pays back immediately in the next real incident.

### Junior → FAANG: Avoiding the Top Three Mistakes Early in Your Career

Of the ten mistakes listed above, three are especially common for engineers early in their on-call experience:

**Mistake 1 (alerting on every metric).** This is the most common and most correctable. Before your first rotation, audit every alert you own and ask: "Does this alert fire only when users are experiencing a problem?" If not, it should not be critical.

**Mistake 3 (runbooks without copy-paste commands).** Every alert you add must have a runbook with exact commands. This is a discipline that must be built before your first rotation, not after.

**Mistake 10 (no game day).** If your team has never run a game day, propose one. A 2-hour game day exercise using an existing runbook is low-risk and high-value. It reveals gaps in the runbook, gives everyone practice with the incident management tool, and builds team confidence before a real incident.

### Senior @ FAANG: Mistake Prevention Through Platform Design

At L6, each mistake in this list represents a gap in platform design or process enforcement. "Alerting on causes" is prevented by a platform standard that requires symptom-based alerts. "No runbook" is prevented by a CI gate that blocks alert rules without a `runbook_url` annotation. "No game day" is prevented by a quarterly engineering calendar that blocks time for reliability exercises.

The senior insight is that common mistakes are not made by bad engineers: they are made by engineers in environments that do not prevent them. The platform team's job is to design an environment where the right thing is the easy thing, and the common mistakes are mechanically blocked before they reach production.

---
