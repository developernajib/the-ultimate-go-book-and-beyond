## 107.12 Key Takeaways

1. **Defense in Depth**: Security requires multiple layers. Don't rely on a single control.

2. **Never Trust Input**: Validate and sanitize all data from users, databases, and external APIs.

3. **Use Go's Built-in Security**: `html/template` auto-escapes, `database/sql` prevents injection when used correctly, `crypto/rand` provides secure randomness.

4. **Parameterized Queries Always**: SQL injection is still the #1 database vulnerability. Never concatenate SQL strings.

5. **Secure Headers Matter**: Proper HTTP headers provide significant protection against XSS, clickjacking, and other attacks.

6. **Rate Limiting is Essential**: Protect your APIs from abuse and DoS attacks with proper rate limiting.

7. **Constant-Time Comparisons**: Use `subtle.ConstantTimeCompare()` for sensitive comparisons to prevent timing attacks.

8. **Security is a Process**: Regular security audits, dependency updates, and code reviews are critical.

9. **OWASP Top 10 Knowledge**: Understanding common vulnerabilities helps you avoid them in your code.

10. **Production Mindset**: Write code assuming it will be attacked. Because it will be.

### Junior → FAANG: Internalizing the Production Mindset Early

The production mindset (write code assuming it will be attacked) sounds obvious but requires deliberate practice to internalize. Juniors who do not yet have this mindset write security controls as an afterthought and miss them under deadline pressure.

**Gap to close:** For every feature you build, spend five minutes doing a mini threat model: who is the attacker, what do they want, how could they abuse this endpoint? If you find an answer, implement the control before shipping. This five-minute habit prevents the majority of common vulnerabilities.

**Interview framing:** When asked "how do you approach building a new feature securely?", describe the mini threat model process. Name STRIDE or OWASP as your framework. Showing a structured process is more impressive than listing specific controls.

### Senior @ FAANG: Scaling the Production Mindset Across Teams

At senior level, the production mindset must be instilled at an organizational level, not just held individually. Engineers who have not internalized it need structures that compensate for the gap.

**Security champion program:** Designate one security champion per team. Champions receive additional security training, participate in organization-wide security reviews, and serve as the first escalation point for security questions on their team. This distributes security expertise without requiring every engineer to be a security expert. Champions also carry the production mindset and model it for their teammates.

**Threat modeling as a process:** For every significant new feature, require a lightweight threat model before implementation begins. The threat model is a one-page document: what does the feature do, who interacts with it, what are the trust boundaries, and what are the potential abuse cases. Review it in a design review meeting with at least one security-aware engineer. This process makes the production mindset a structured input to every design decision rather than an individual character trait.

**Measuring the mindset:** Track security findings by team and by engineer over time. Teams with a strong production mindset produce fewer findings in pen tests and security reviews. When a team has a high finding rate, the response is not blame: it is coaching, additional security champion support, and tooling improvements. The metric drives investment, not punishment.

---
