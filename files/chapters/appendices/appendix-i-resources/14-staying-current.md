## Staying Current

Go evolves rapidly. Here's how to stay up-to-date:

### Release Notes

**URL**: https://go.dev/doc/devel/release
Read release notes for each Go version to understand new features and changes.

### Go Proposals

**URL**: https://github.com/golang/proposal
Follow accepted proposals to know what's coming.

### Weekly Routine

1. **Read Golang Weekly** newsletter (Thursday)
2. **Check r/golang** for community discussions
3. **Browse Go Blog** for new official posts
4. **Listen to Go Time** podcast (weekly)

### Monthly Routine

1. **Review new packages** on pkg.go.dev
2. **Watch recent GopherCon talks**
3. **Read high-quality blog posts** from influential authors
4. **Update dependencies** and check for security advisories

### Yearly Routine

1. **Attend or watch GopherCon** talks
2. **Review the year in Go** (usually blogged)
3. **Reassess tools and workflows**
4. **Update learning resources** (new books, courses)

### Security Updates

**govulncheck**: `go install golang.org/x/vuln/cmd/govulncheck@latest`

Run regularly to check for known vulnerabilities:
```bash
govulncheck ./...
```

### Experiment with Beta Features

When new Go versions enter beta, try them:
```bash
# Install beta
go install golang.org/dl/go1.XX@latest
go1.XX download

# Use beta version
go1.XX version
```

---
