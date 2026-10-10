## 90J.13 BGP Disasters: Rogers, Optus, and Meta (2021-2023)

### The Pattern

Border Gateway Protocol (BGP) is the routing protocol that holds the internet together. It is how networks
(Autonomous Systems) announce which IP address ranges they control and how traffic should be routed between
them. BGP has almost no built-in security - it trusts announcements from peers. A single misconfiguration can
take down entire countries. Between 2021 and 2023, three major BGP-related disasters demonstrated this fragility.

### Rogers Communications (July 8, 2022)

**What Happened**: Rogers, Canada's largest telecommunications company, experienced a complete network outage
lasting approximately 19 hours. The outage affected 12.2 million wireless subscribers, 4 million broadband
customers, and disrupted 911 emergency services, payment processing, and banking across Canada.

**Root Cause**: During a scheduled maintenance window, a code update to Rogers' core network routers
contained a configuration error that caused all routing information to be deleted from the routers.
Without routing tables, the routers could not forward any traffic. The error propagated to the entire
Rogers network within minutes.

**Impact**: The outage affected approximately 25% of Canada's internet traffic. Interac (Canada's debit
card network) went down, meaning millions of people could not make electronic payments. Emergency 911
services were disrupted in multiple provinces. The Canadian Radio-television and Telecommunications
Commission (CRTC) launched an investigation.

**Financial Impact**: Estimated at over $100 million in lost revenue and credits to customers, plus
the CRTC investigated and required Rogers to submit remediation plans.

### Optus (November 8, 2023)

**What Happened**: Optus, Australia's second-largest telecommunications company, experienced a nationwide
outage lasting approximately 14 hours. The outage affected over 10 million customers and disrupted
hospitals, transport systems, and payment networks across Australia.

**Root Cause**: A routine software upgrade at an international peering exchange propagated unexpected
BGP routing changes into the Optus core network. The Optus routers did not have proper BGP route
filtering in place, and the unexpected routing updates caused the core routers to become overwhelmed
and crash.

**Impact**: Hospitals lost the ability to communicate. Public transport systems were disrupted. Triple
Zero (Australia's 911 equivalent) was impacted. The Australian government launched a Senate inquiry.

### Meta (October 4, 2021)

**What Happened**: Facebook, Instagram, WhatsApp, and all Meta services went completely offline for
approximately six hours. With over 3.5 billion users across its platforms, this was one of the largest
outages in internet history by number of affected users.

**Root Cause**: During routine maintenance, a command intended to assess the capacity of Meta's backbone
network accidentally disconnected all Meta data centers from the internet by withdrawing all BGP route
announcements. Without BGP routes, Meta's IP addresses became unreachable from anywhere on the internet.

**The Recovery Problem**: Meta's recovery was dramatically complicated by several factors:
1. **DNS failure**: Meta's authoritative DNS servers ran within the same infrastructure, so once BGP
   routes were withdrawn, the DNS servers became unreachable. This meant meta.com, facebook.com, and
   instagram.com could not be resolved.
2. **Physical access**: The out-of-band management network that engineers used to access equipment also
   depended on the internal network. Engineers had to physically go to data centers.
3. **Badge access**: Some data center badge readers depended on internal network services that were down.
   Engineers reportedly had to break open doors.
4. **Tool dependency**: All of Meta's internal tools (communication, ticketing, documentation) ran on
   the same infrastructure that was down.

**Financial Impact**: Meta's stock dropped approximately 5%, losing approximately $47 billion in
market capitalization. Mark Zuckerberg personally lost approximately $6 billion.

### Common Root Causes Across All Three Incidents

1. **Configuration errors during maintenance**: All three incidents started with routine operations
2. **Insufficient BGP filtering**: Route announcements were not properly validated before propagation
3. **Circular dependencies**: Recovery tools depended on the systems that failed
4. **No out-of-band management**: When the primary network went down, the management network went with it
5. **Global blast radius**: A single error affected the entire network

### Engineering Lessons

1. **BGP changes must be validated before deployment** - use route policy simulators and canary announcements.
2. **Out-of-band management must be truly independent** - if it shares any infrastructure with production,
   it is not out-of-band.
3. **Recovery tools must not depend on the system they recover** - this is the Meta lesson that everyone
   should internalize.
4. **Telecommunications is critical infrastructure** - outages that affect 911/emergency services are
   qualitatively different from outages that affect social media.
5. **BGP needs security** - RPKI (Resource Public Key Infrastructure) can prevent route hijacking and
   should be deployed universally.
6. **Test your maintenance procedures in staging** - every one of these incidents started with "routine"
   maintenance.

---

### Junior → FAANG: BGP Safety and Configuration Change Canaries as Interview Topics

The BGP disasters at Rogers, Optus, and Meta share a single root cause: configuration changes with unbounded blast radius and no automated rollback. For FAANG interviews, the BGP incident pattern provides the answer to "how do you make infrastructure changes safely?" Every configuration change must be deployed in stages: apply to one router, verify for five minutes, then proceed to the next. The stage duration must be long enough to detect the failure mode (BGP reconvergence can take minutes), and the rollback must be automatic if any health metric deviates beyond a threshold. The second interview point is out-of-band management: Meta's engineers could not push the rollback because their management network used the same BGP infrastructure that had failed. Management plane access must be physically independent of the data plane. For critical infrastructure changes, maintain a separate cellular or leased-line path to the management interface that does not route through the production network.

### Senior @ FAANG: Network Configuration Governance as a Safety-Critical Engineering Practice

At L6, the three BGP incidents collectively establish that network configuration management must be treated as a safety-critical engineering practice, with the same rigor applied to safety-critical software. The governance framework has four components. First, every BGP configuration change must pass through a route policy simulator that verifies the change against a model of the network topology before deployment. The simulator must be able to predict the propagation path of every route advertisement change and identify any advertisement that would exceed a defined route count threshold at any router in the network. Second, configuration deployment must use a canary architecture: deploy to one edge router, verify route table stability and traffic distribution for a minimum hold period, then proceed in fixed-size batches with automatic rollback on any anomaly. The hold period must be calibrated to the BGP reconvergence time of the network, not a fixed constant. Third, all configuration management tools must enforce scope limits: a single change deployment cannot affect more than a defined percentage of the network's routing capacity. The Rogers incident involved a filter deletion that crashed every core router simultaneously. A blast radius limit of 10% of core routers per deployment batch would have converted a nationwide outage into a localized incident. Fourth, for any network infrastructure that provides connectivity to emergency services (911, hospital networks, critical infrastructure), maintain a physically separate emergency management path using a different carrier or technology (satellite, cellular, fiber from a different provider) that provides access to the management interface even when the primary network has failed. This is not a performance requirement. It is a public safety obligation.

---
