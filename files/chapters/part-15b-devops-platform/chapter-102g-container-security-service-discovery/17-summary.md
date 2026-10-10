## 102G.15 Mid-Chapter Synthesis: Core Architecture Recap

Container security is not a layer you add after - it's woven through the entire supply chain from Dockerfile to runtime. Image scanning catches known vulnerabilities before deployment. Seccomp and AppArmor reduce the kernel attack surface. OPA/Gatekeeper enforces policy-as-code at the cluster level. And SPIFFE/SPIRE with mTLS eliminates the implicit trust that makes lateral movement possible.

Service discovery connects all these secured containers into a reliable distributed system. Whether via Consul for flexible routing, etcd for lease-based registration, or Kubernetes DNS for simplicity, the pattern is the same: services register their identity and health, consumers discover healthy instances, and the discovery layer handles the dynamic nature of containerized infrastructure.

**Key takeaways for FAANG interviews**:
1. Container security requires defense in depth: image scanning + runtime security + network policies + mTLS - no single layer is sufficient
2. Distroless images are the production standard: no shell means no interactive exploitation even after a container escape
3. SPIFFE/SPIRE is the industry standard for workload identity in cloud-native - understand SVID lifecycle and the Workload API
4. Zero-trust means every request is verified by identity, not network location - mTLS between ALL services, not just external traffic
5. Seccomp + readOnlyRootFilesystem + runAsNonRoot + drop ALL capabilities = the minimum security context for any production container


---

### Junior → FAANG: Consolidating the Chapter Into a Mental Model

The five key takeaways above are the summary you should be able to recite from memory before any interview involving container security. But recitation is not understanding. The mental model that sticks is: every security layer in this chapter addresses a specific failure mode, and understanding which failure mode each addresses is what lets you choose the right tool for the right problem.

Image scanning addresses known CVEs at build time. It does nothing for zero-days or post-deployment CVE disclosures. Seccomp addresses the kernel attack surface at runtime. It does nothing for application-layer vulnerabilities. OPA/Gatekeeper addresses policy compliance at deploy time. It does nothing for drift after deployment. mTLS addresses service-to-service authentication. It does nothing for authorization (who can call what). Each tool in the stack has a bounded scope, and knowing those boundaries is what an interviewer tests when they ask "what does X not protect against."

First-job consolidation exercise: draw the architecture diagram from section 02 from memory, label each component with the specific threat category it addresses, and note one failure mode that each component does not catch. Do this once per week until it is automatic.

### Senior @ FAANG: The Chapter as a Platform Product Roadmap

The technical content of this chapter maps directly to the stages of a container security platform maturity roadmap. A staff engineer joining a new organization would sequence these investments in roughly this order: baseline image scanning in CI (immediate impact, low operational overhead), pod security standards enforcement via OPA/Gatekeeper (automated enforcement, no ongoing developer action required), continuous scanning for running workloads (closes the post-deployment CVE gap), runtime security with Falco (detection and response capability), service discovery via Kubernetes DNS (if not already in place), and finally SPIFFE/SPIRE with mTLS (the highest operational complexity, justified only after the lower-cost controls are in place).

That sequencing is justified by: impact-to-effort ratio (image scanning catches the most CVEs per engineering-hour invested), operational maturity prerequisites (you need stable service identity before you can implement mTLS), and organizational readiness (teams need time to adapt to each security control before the next one is introduced).

The summary's statement "no single layer is sufficient" is the most important concept in this chapter for staff-level thinking. Defense in depth is not about having more tools. It is about having complementary tools with non-overlapping gaps, so that a compromise at one layer is detected or contained by the next. A staff engineer designing a security architecture is composing these layers with their gap profiles in mind, not selecting the "best" single tool. That compositional thinking, reasoning about the residual risk after each layer is applied, is what distinguishes a security architect from a security engineer.
