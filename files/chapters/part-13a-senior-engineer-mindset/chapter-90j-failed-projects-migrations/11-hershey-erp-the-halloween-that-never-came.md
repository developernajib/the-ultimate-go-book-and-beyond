## 90J.10 Hershey ERP: The Halloween That Never Came (1999)

### The Incident

In 1999, The Hershey Company - America's largest chocolate manufacturer - attempted to simultaneously implement
three major enterprise systems: SAP R/3 (ERP), Siebel (CRM), and Manugistics (supply chain management). The
go-live date was July 1999, chosen to allow three months of stabilization before Hershey's critical shipping
season for Halloween and Christmas. The implementation was catastrophic, and Hershey could not fulfill $100
million in orders during its most important sales period.

### The Timeline

**1996-1998: The Planning Phase**

Hershey originally planned a four-year phased rollout of the three systems. Under pressure from the board to
show faster results, the timeline was compressed to 30 months, and the phased approach was replaced with a
simultaneous "big bang" go-live of all three systems.

**Early 1999: Warning Signs**

During testing, engineers reported significant issues with the integration between SAP, Siebel, and
Manugistics. The three systems used different data models, and the integration layer was not working
reliably. Order data from Siebel was not flowing correctly into SAP for fulfillment, and supply chain
signals from Manugistics were not reaching the warehouse management system.

**July 1999: Go-Live**

The three systems went live simultaneously. Problems appeared immediately:

1. **Order processing failed**: Customer orders entered in Siebel were not appearing in SAP for fulfillment
2. **Warehouse chaos**: The warehouse management system could not correctly process picking and shipping
   instructions from SAP
3. **Inventory visibility lost**: The supply chain system could not accurately track inventory across
   Hershey's distribution network
4. **Shipping delays**: Orders that were processed were shipped to wrong locations or in wrong quantities

**August-October 1999: The Disaster Season**

Hershey's peak shipping season for Halloween runs from August through mid-October. During this period:

- Orders worth approximately $100 million could not be fulfilled
- Retailers could not get Hershey products on shelves in time for Halloween
- Competitors (Mars, Nestle) captured Hershey's lost shelf space
- Hershey's Q3 revenue dropped 12% year-over-year
- Stock price fell 8% on the earnings miss

**The Aftermath**

Hershey's revenue for 1999 was approximately $150 million below projections. The CEO and CIO both departed.
It took over two years for the systems to be fully stabilized. The case became a foundational example in ERP
implementation literature of why "big bang" approaches are dangerous.

### Root Cause Analysis

1. **Big bang implementation**: Three major systems went live simultaneously
2. **Compressed timeline**: Four years compressed to 30 months
3. **Peak season go-live**: Going live months before the most critical business period
4. **Integration failures**: Three systems with different data models were not properly integrated
5. **Insufficient testing**: The integration testing was inadequate
6. **Management pressure**: Technical concerns were overridden by business timeline pressure

### Engineering Lessons

1. **Never go live with critical systems during peak season** - if you sell chocolate, do not deploy ERP in
   July.
2. **Big bang implementations multiply risk** - phase the rollout to isolate failures.
3. **Integration is the hardest part** - three systems working individually means nothing if they cannot
   communicate.
4. **Compressed timelines do not compress complexity** - the work takes as long as it takes.
5. **Listen to the engineers** - when testers report integration failures, delay the launch.
6. **Revenue timing matters** - a three-month delay in July saves $100 million in October.

---

### Junior → FAANG: ERP Timeline Risk and Integration Testing as Interview Anchors

Hershey is the interview answer to "what goes wrong when you compress an ERP project timeline?" Four years of planned implementation compressed to 30 months, with three major systems going live simultaneously, directly caused $100 million in Halloween order failures. For FAANG interviews, the Hershey incident provides two concrete lessons. First, never go live with a critical system during your peak business period: if your revenue is concentrated in a few months, the launch window must be in the lowest-risk period of the business calendar, with enough runway to stabilize before peak arrives. Second, "three systems working individually" does not mean "the integration works." Integration testing is categorically different from component testing, and a compressed timeline that cuts integration testing to meet a launch date is not a faster delivery, it is a deferred failure. Naming Hershey in an interview anchors the lesson to a real $100 million outcome and demonstrates that you understand the business consequences of technical shortcuts.

### Senior @ FAANG: ERP and Platform Migration Governance at Staff Level

At L6, the Hershey incident is a governance failure that mirrors Healthcare.gov at a smaller scale. Three systems (SAP's ERP, CRM, and supply chain modules) went live simultaneously with compressed integration testing, during peak business season, under management timeline pressure that overrode technical concerns. The staff engineer's governance contribution to any large platform migration is three-layered. First, the launch window must be defined by the business risk calendar, not the project completion date. For a business with a seasonal revenue peak, define a launch exclusion window (for Hershey, July through November) and require that any launch date falling in that window triggers an automatic delay to the next safe window. This policy must be established before the project begins and must require C-level approval to override. Second, for a multi-system implementation, define an integration readiness gate that must pass before any component goes live, even if individual components are ready. The gate measures end-to-end transaction success rates across all integrated systems under realistic load. A gate that measures individual component health but not cross-system transaction success will pass even when the integration is broken. Third, the rollback plan for an ERP go-live is inherently complex because the legacy system has been decommissioned. The staff engineer's responsibility is to advocate for a parallel-operation phase that keeps the legacy system running alongside the new system, with a defined reconciliation process, for at least 60 days after go-live. The Hershey failure would have been containable with a two-week parallel-operation phase that allowed the integration failures to be identified and fixed while the legacy system still processed orders.

---
