## High-Level Design

┌────────────────────────────────────────────────────────────────┐
│ TWITTER TIMELINE │
├────────────────────────────────────────────────────────────────┤
│ │
│ ┌──────────┐ ┌──────────────┐ ┌─────────────────────┐ │
│ │ Client │───▶│ Load Balancer │───▶│ API Servers │ │
│ └──────────┘ └──────────────┘ └──────────┬──────────┘ │
│ │ │
│ ┌───────────────────────┼───────────┐ │
│ │ │ │ │
│ ▼ ▼ ▼ │
│ ┌───────────┐ ┌───────────┐ ┌──────┐│
│ │ Tweet │ │ Timeline │ │ User ││
│ │ Store │ │ Service │ │ Graph││
│ │(Cassandra)│ │ (Redis) │ │(Graph)│
│ └───────────┘ └───────────┘ └──────┘│
│ │
└────────────────────────────────────────────────────────────────┘


### Junior → FAANG: Sketching a High-Level Design

A high-level design is a communication tool first and a technical document second. In an interview, your diagram should be readable to the interviewer within 30 seconds: label every box, label every arrow with the protocol or data format, and group components logically. The common mistake at the junior level is drawing too many boxes that you cannot explain, or too few that leave obvious gaps. Start with the client, work through the entry points (DNS, CDN, load balancer), into the application layer, then the data layer, and finally the async layer if needed. Keep the initial design simple enough that you can defend every component.

### Senior @ FAANG: High-Level Design as a Negotiation Surface

At the senior level, the high-level design is the starting point for a negotiation with the interviewer about which parts of the design deserve deep exploration. Your job is to signal which components you consider interesting or risky, invite the interviewer to redirect you to their area of interest, and demonstrate that you can shift depth fluidly. Bar-raisers often let the candidate drive the deep-dive selection. An L6 candidate correctly identifies the highest-risk component (often consistency, fan-out, or latency) and proactively goes deep there without being prompted. The high-level design also communicates your mental model of the system boundary: which parts are in scope, which are out of scope, and where the external dependencies are. Staff engineers think about the high-level design in terms of team ownership: the component boundaries in the diagram often correspond to team boundaries, and designing them well means designing the API contracts between teams.
