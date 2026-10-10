## 90J.9 Post Office Horizon: 25 Years of Injustice (1999-2024)

### The Scandal

The Post Office Horizon scandal is the most devastating software failure in history, not because of its financial
cost but because of its human cost. Between 1999 and 2024, a buggy accounting system developed by Fujitsu called
Horizon caused financial discrepancies in the accounts of Post Office branch managers (called subpostmasters)
across the United Kingdom. The Post Office, rather than investigating the software, accused the subpostmasters
of theft, fraud, and false accounting.

Over 900 subpostmasters were wrongfully prosecuted. Some were imprisoned. Others were bankrupted. Several
committed suicide. Marriages broke down. People lost their homes, their savings, and their reputations. Many
were shunned by their communities. It is the largest miscarriage of justice in British legal history.

### The Timeline

**1999: Horizon Goes Live**

The Post Office rolled out Horizon, a point-of-sale and accounting system, across approximately 11,500 branches
in the UK. The system tracked transactions, cash holdings, and stock levels at each branch. At the end of each
trading period, subpostmasters were required to "balance" their branch - the system's record of cash and stock
had to match the physical cash and stock in the branch.

From the earliest days, subpostmasters reported discrepancies. The system would show shortfalls - the system
said there should be more cash or stock than physically existed. Some shortfalls were small (tens of pounds),
others were enormous (tens of thousands of pounds).

**1999-2013: The Prosecutions**

Under UK law, the Post Office had an unusual power: it could prosecute crimes directly, without going through the
Crown Prosecution Service. When Horizon showed a shortfall at a branch, the Post Office assumed the subpostmaster
was responsible. The subpostmaster's contract required them to make good any losses, regardless of the cause.

Subpostmasters who could not explain or repay the shortfalls were accused of theft or false accounting. Many
pleaded guilty to false accounting (a lesser charge) to avoid the threat of theft charges that carried prison
sentences. Others fought the charges but were convicted because the Post Office asserted - and courts accepted  - 
that Horizon was reliable.

**The Software Bugs**

Fujitsu's Horizon system had multiple categories of bugs:

1. **Transaction duplication**: The system sometimes recorded the same transaction twice, creating phantom
   shortfalls
2. **Network connectivity issues**: When connectivity dropped during a transaction, the system could record
   a partial transaction incorrectly
3. **Remote access**: Fujitsu engineers had the ability to remotely access branch systems and make changes
   to transaction records - a capability the Post Office denied existed for years
4. **Balancing errors**: The end-of-day balancing process had bugs that could create discrepancies from
   rounding errors and timing issues
5. **Training mode bugs**: In some cases, training mode transactions leaked into live data

**2009: First Investigations**

Computer scientist Professor Charles McLachlan conducted an analysis of Horizon for a group of subpostmasters
and found evidence of bugs that could cause the discrepancies. The Post Office dismissed his findings.

**2019: The High Court Group Litigation**

In 2019, 555 subpostmasters brought a group litigation case against the Post Office in the High Court. Justice
Fraser ruled that Horizon was not "robust" and had bugs that could cause the discrepancies. He found that the
Post Office had been "obstructive" in providing evidence and had known about bugs for years.

**2020-2024: The Slow Path to Justice**

Following the High Court ruling, the Criminal Cases Review Commission began referring convictions to the Court
of Appeal. The process was painfully slow. In January 2024, an ITV drama series about the scandal brought
massive public attention, leading the UK government to pass emergency legislation (the Post Office (Horizon
System) Offences Act 2024) to quash all Horizon-related convictions en masse.

As of 2024, fewer than 100 of the 900+ wrongfully convicted subpostmasters had received compensation.
The full public inquiry, led by Sir Wyn Williams, was still ongoing.

### Root Cause Analysis

1. **Software bugs were treated as human fraud**: The organization assumed the software was correct and humans
   were dishonest
2. **No independent audit**: There was no independent verification of Horizon's accuracy
3. **Prosecution power without accountability**: The Post Office prosecuted its own workers with no oversight
4. **Remote access denied**: Fujitsu's ability to modify records was hidden from courts
5. **Institutional cover-up**: Multiple investigations were suppressed or their findings ignored
6. **No bug reporting culture**: Subpostmasters who reported bugs were told they were the only ones with
   problems - a deliberate lie
7. **Contract design**: Subpostmasters were contractually liable for any shortfall, removing the Post
   Office's incentive to investigate software causes

### Engineering Ethics and Accountability

The Horizon scandal raises fundamental questions for software engineers:

1. **When your software is used to make life-altering decisions about people, the burden of proof for
   correctness must be proportional to the consequences of error.**
2. **Engineers have a moral obligation to report bugs honestly**, especially when those bugs could cause
   harm to individuals.
3. **Audit trails must be immutable and independently verifiable** - the ability to silently modify
   records is incompatible with accountability.
4. **"The computer says" is never sufficient justification for punishment** - software must prove itself
   correct, not be assumed correct.

There is no Go code example for this incident because the lesson is not technical - it is ethical and
organizational. No amount of good code can fix an organization that chooses to blame its users rather than
investigate its systems. However, we can note the technical safeguards that should have existed:

- **Immutable audit logs** that Fujitsu could not modify
- **Reconciliation checks** that compared system records against independent sources
- **Anomaly detection** that would flag branches with statistically unusual shortfall patterns
- **Independent third-party audits** of the software's accuracy
- **Transparent bug tracking** visible to affected parties

### Engineering Lessons

1. **Software that affects people's liberty must be held to the highest standard of correctness** - the
   consequences of bugs in criminal justice systems are irreversible.
2. **Never assume the software is correct** - when discrepancies appear between software and reality,
   investigate the software first.
3. **Audit trails must be immutable** - if the software vendor can modify records, the records have no
   evidentiary value.
4. **Engineers have ethical obligations that transcend their employer's interests** - Fujitsu engineers
   who knew about the bugs had a moral duty to ensure that information reached the courts.
5. **Institutional incentives shape behavior** - when the organization benefits from blaming users, it
   will blame users.
6. **25 years of injustice is 25 years of missed opportunities to do the right thing**.

---

### Junior → FAANG: Software Liability and Audit Trail Integrity as Interview Ethics Topics

The Post Office Horizon scandal is the interview answer to "what are the ethical obligations of a software engineer?" Fujitsu engineers who were aware of bugs that were causing financial discrepancies in subpostmaster accounts had a moral obligation to ensure that information reached the courts where those subpostmasters were being prosecuted. The fact that it did not reach the courts for over a decade is an engineering ethics failure as much as it is a legal and organizational failure. For FAANG interviews, the Horizon scandal is the frame for answering "tell me about a time you saw something wrong and what you did about it." The engineering lesson on audit trail integrity is concrete: any financial system must produce audit logs that are immutable from the perspective of the software vendor. If Fujitsu could access and modify Horizon transaction records remotely, as the inquiry found, those records had no evidentiary value as proof of subpostmaster wrongdoing. Immutable audit logs, cryptographically signed and stored in a location that the software vendor cannot modify, are a basic design requirement for any system whose outputs might be used as evidence.

### Senior @ FAANG: Forensic Correctness and Institutional Accountability as Platform Design Principles

At L6, the Horizon scandal illustrates how organizational incentive structures can corrupt the use of software outputs. The Post Office had strong institutional incentives to believe that Horizon was correct: prosecuting subpostmasters was cheaper than admitting the software was wrong, and prosecutions were justified by pointing to the software's outputs as evidence. This created a feedback loop where every anomaly was attributed to subpostmaster misconduct rather than software error, because investigating software error would require admitting institutional liability. The staff engineer's responsibility in any system whose outputs have legal, financial, or regulatory significance is to design for what can be called forensic correctness: the outputs of the system must be verifiable by parties independent of the vendor, the system must produce a complete record of its own error states and remote access events, and the error record must be disclosed to affected parties as a contractual obligation. For a Go service that handles financial transactions, forensic correctness means: every transaction record includes a cryptographic hash of its input state, any remote access to production data is logged to an append-only audit trail that is accessible to the client organization, and all known defects affecting financial calculations are disclosed to the client within a defined timeframe. At the organizational level, the staff engineer advocates for a defect disclosure policy that treats financial calculation bugs as disclosures to affected parties, not as internal fixes. The Horizon scandal lasted 25 years because there was no such policy. The engineering community's response must be to make such policies standard, not aspirational.

---
