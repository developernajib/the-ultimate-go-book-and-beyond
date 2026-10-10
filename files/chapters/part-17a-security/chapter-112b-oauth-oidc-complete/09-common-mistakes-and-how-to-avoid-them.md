## 112B.8 Common Mistakes and How to Avoid Them

| Mistake | Problem | Solution |
|---------|---------|----------|
| Using implicit flow | Access tokens leaked in URL fragment | Use authorization code + PKCE for all public clients |
| Not validating `state` parameter | CSRF attacks on OAuth callback | Always generate and verify `state` against session storage |
| Accepting `plain` code challenge method | Intercepted challenge equals the verifier, defeating PKCE | Require S256 only, reject plain |
| Storing tokens in localStorage | XSS can steal tokens | Use httpOnly cookies or memory for SPA token storage |
| Not rotating refresh tokens | Leaked refresh token provides indefinite access | Implement refresh token rotation with family invalidation |
| Not validating `aud` claim | Token accepted by wrong service | Always validate audience matches your service identifier |
| Trusting the JWT `alg` header | Algorithm confusion: attacker signs an HS256 token using your RSA public key as the secret | Pin accepted algorithms with `jwt.WithValidMethods` |
| Reusing authorization codes | Authorization code replay attacks | Codes must be single-use, delete immediately on exchange |
| Missing `exp` validation | Expired tokens accepted | Always validate token expiration with clock skew tolerance |
| Not implementing token revocation | No way to log out server-side | Implement RFC 7009 revocation endpoint |

---
