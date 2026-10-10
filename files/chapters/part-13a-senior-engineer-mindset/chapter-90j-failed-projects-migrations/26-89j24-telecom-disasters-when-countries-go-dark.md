## 90J.24 Telecom Disasters: When Countries Go Dark

Telecommunications outages occupy a unique category of infrastructure failure because they affect emergency
services, financial systems, transportation, and the basic ability of citizens to communicate. Three major
telecom outages between 2022 and 2024 each knocked an entire country's worth of connectivity offline, with
consequences ranging from economic disruption to attributed deaths.

### AT&T February 2024: Configuration Error Heard Round the World

On February 22, 2024, AT&T experienced a nationwide outage that lasted approximately 12 hours, affecting an
estimated 125 million devices across the United States. Over 25,000 calls to 911 emergency services were
blocked or disrupted during the outage.

**Root Cause**: A network configuration update intended for a small number of cell towers was applied with
incorrect scope. The configuration change - modifying Quality of Service parameters - propagated to the
entire network within 3 minutes. The configuration caused a software incompatibility between AT&T's core
network nodes and the affected cell towers, resulting in the towers deregistering from the network.

**Why It Spread**: AT&T's network configuration system lacked scope guards. There was no mechanism to limit
the blast radius of a configuration change to a specific region, market, or cell tower group. The deployment
system treated "deploy to 5 towers" and "deploy to 50,000 towers" identically, with no additional
confirmation, canary phase, or rollback trigger for large-scope changes.

**Impact**: The FCC investigation found that AT&T had no automated rollback mechanism for network
configuration changes. The 12-hour recovery time was dominated by the manual process of identifying which
configuration parameters had changed, validating a correction, and pushing the fix through the same
deployment system that had caused the outage.

### Rogers Canada July 2022: A Country Disconnected for 26 Hours

On July 8, 2022, Rogers Communications experienced an outage that lasted 26 hours and affected approximately
12 million customers - roughly a third of Canada's population. The outage affected mobile, internet, and
enterprise services simultaneously. Payment processing systems across the country failed because they relied
on Rogers' network. The Toronto Transit Commission could not process fare payments. The national
Interac debit system was disrupted. Most critically, 911 emergency services in some areas were
unreachable. One death was later attributed to the inability to reach emergency services.

**Root Cause**: During a planned maintenance window, a routing filter was deleted from a core router. This
filter had controlled the propagation of routing information within Rogers' network. Without it, the router
flooded the network with a massive number of BGP route advertisements, overwhelming the routing tables of
every router in the network. Routers ran out of memory and crashed, creating a cascading failure that
took down the entire network.

**Why Recovery Took 26 Hours**: The network management systems - the tools engineers would use to diagnose
and fix the problem - ran on the same network that was down. Engineers had to physically travel to data
centers and connect to routers via console cables to begin diagnosis. The scope of the damage (every core
router had crashed or was in an unstable state) meant that the network had to be rebuilt from scratch,
starting with a small core and gradually reconnecting regions.

### Optus Australia November 2023: BGP Storm Takes Down a Nation

On November 8, 2023, Optus (Australia's second-largest telecommunications provider) experienced a catastrophic
outage lasting approximately 14 hours that affected over 10 million customers. The outage disrupted hospital
communications, public transportation, and emergency services across the country. The CEO, Kelly Bayer
Rosmarin, resigned less than two weeks later.

**Root Cause**: During a routine network upgrade, a misconfigured router sent an excessive number of BGP route
advertisements into the Optus network. The volume of routes exceeded the memory capacity of network devices
throughout the Optus backbone. As routers ran out of memory, they crashed and restarted, which generated
additional route changes that further destabilized the network.

**Why It Was Devastating**: Optus provided network connectivity for critical infrastructure including
hospitals, banks, and government agencies. Many of these institutions had no redundant connectivity provider,
having single-homed their critical systems on the Optus network. The outage exposed the fragility of national
critical infrastructure that depends on a single telecommunications provider.

### The Common Pattern

All three outages share the same fundamental failure: **configuration changes with unbounded blast radius
and no automated rollback**.

- AT&T: QoS config propagated nationwide in 3 minutes, no scope guard
- Rogers: routing filter deletion crashed every core router, no blast radius limit
- Optus: BGP route flood exceeded router memory, no route advertisement limit

In all three cases, the tools needed to fix the problem depended on the network that was broken. In all
three cases, recovery was measured in hours or days because manual intervention was required. And in all
three cases, the outage was caused by a routine maintenance operation, not an attack or unprecedented event.

**The Lesson**: Telecommunications infrastructure must be treated as critical national infrastructure with
commensurate engineering standards. Configuration changes must be scoped, canary-deployed, and automatically
rolled back on anomaly detection. Management plane access must be independent of the data plane. And any
service that provides connectivity for emergency services must have redundant network paths from independent
providers. The fact that a single configuration error can disable 911 for millions of people is not a
technical limitation - it is an engineering and regulatory failure.

---

### Junior → FAANG: Scoped Configuration Deployment and Independent Management Plane as Interview Patterns

The AT&T, Rogers, and Optus outages share a single root cause: configuration changes with no scope guard deployed to the full network in one operation. For FAANG interviews, the network configuration safety answer has three specific components. First, every configuration change must be scoped to a defined blast radius and deployed in stages, with automated health verification between stages and automatic rollback if any metric deviates. A QoS change that should affect one region must not be deployable to the entire network in a single operation, regardless of operator intent. Second, the management plane must be independent of the data plane: if the configuration change you are deploying breaks routing, you must still be able to reach the management interface to apply the rollback. For network infrastructure, this typically means a dedicated management VLAN or cellular backup that does not route through the production network. Third, every routine maintenance procedure must be tested in a staging environment before production execution. The "routine maintenance" framing that appears in every one of these incidents is a signal that the procedure had never been fully tested, because truly routine procedures have accumulated enough test runs to have well-understood failure modes.

### Senior @ FAANG: Critical Infrastructure Resilience as an Engineering Ethics Obligation

At L6, the three telecom incidents collectively establish that engineering decisions that affect emergency services carry an ethical obligation that extends beyond the typical reliability engineering calculus. When a single configuration error can disable 911 for millions of people, the engineering standards that prevent such errors are not optional optimizations, they are safety requirements with the same moral weight as safety requirements in aviation or medical devices. The staff engineer's contribution at this level is advocating for the engineering standards that match the stakes of the infrastructure. For any organization operating infrastructure that provides emergency service connectivity, three standards are non-negotiable. First, no change to routing configuration can be deployed to more than 5% of the production network without a successful staging validation and a separate approver from the change author. Second, the rollback SLA for any routing change is 60 seconds from anomaly detection, and this SLA must be verified quarterly by a controlled failure test. Third, an independent management path (physically separate from the production network) must be maintained and tested monthly by performing a management operation exclusively through the backup path. These standards are more demanding than what most network engineering teams operate under, and the demand is justified by the consequence: a neighborhood that cannot call 911 during a medical emergency because of a routing filter deletion. When the consequence of engineering failure is measured in lives rather than dollars, the engineering standards must reflect that consequence.

---
