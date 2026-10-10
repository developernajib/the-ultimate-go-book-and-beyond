## Development Tools and IDEs

### GoLand (JetBrains)

**URL**: https://www.jetbrains.com/go/
**Platform**: Windows, macOS, Linux
**Cost**: Paid (free for students/open source)
**Level**: All levels

**Why Use**: The most full-featured Go IDE. Excellent refactoring, debugging, and code intelligence.

**Key Features**:
- **Intelligent Code Completion**: Context-aware suggestions
- **Advanced Refactoring**: Rename, extract, inline, move
- **Debugger**: Powerful debugging with breakpoints, watches, stepping
- **Testing**: Integrated test runner with coverage visualization
- **Code Navigation**: Jump to definition, find usages, type hierarchy
- **Database Tools**: SQL support and database integration
- **Git Integration**: Built-in VCS support
- **Docker and Kubernetes**: Container and orchestration support
- **Profiling**: CPU and memory profiling integration
- **Code Generation**: Generate tests, interfaces, constructors

**Strengths**:
- First-rate refactoring
- Excellent debugger
- Full-featured IDE
- Great for large codebases
- Team-friendly with shared settings

**Weaknesses**:
- Resource-intensive (requires good hardware)
- Paid license (though affordable)
- Can be overwhelming for beginners

**Best For**: Professional development, large projects, teams.

**Tips**:
- Learn keyboard shortcuts (⌘+Click for jump to definition, etc.)
- Use "Refactor This" (⌃T) to discover refactoring options
- Enable "Optimize Imports on the fly"
- Use scratch files for quick experiments

### Visual Studio Code

**URL**: https://code.visualstudio.com
**Platform**: Windows, macOS, Linux
**Cost**: Free and open source
**Level**: All levels

**Why Use**: Lightweight, highly customizable, excellent Go extension, free.

**Essential Extension**:
- **Go** by Go Team at Google (official extension)
 - Install: Search "Go" in VS Code extensions

**Key Features** (with Go extension):
- **IntelliSense**: Code completion and parameter hints
- **Code Navigation**: Jump to definition, find references
- **Debugging**: Integrated Delve debugger
- **Testing**: Run and debug tests inline
- **Code Lens**: Show references, test status inline
- **Formatting**: Auto-format on save with gofmt/goimports
- **Linting**: Integration with various linters
- **Refactoring**: Rename, extract variable/function
- **Import Management**: Auto-import packages

**Recommended Settings** (settings.json):
```json
{
  "go.useLanguageServer": true,
  "go.lintOnSave": "workspace",
  "go.formatTool": "goimports",
  "go.testOnSave": false,
  "editor.formatOnSave": true,
  "go.coverOnSave": false,
  "go.toolsManagement.autoUpdate": true,
  "gopls": {
    "ui.semanticTokens": true,
    "ui.codelenses": {
      "test": true,
      "generate": true,
      "gc_details": false
    }
  }
}
```

**Recommended Additional Extensions**:
- **Go Test Explorer**: Visual test runner
- **Go Nightly**: Latest Go extension features
- **Error Lens**: Inline error highlighting
- **GitLens**: Enhanced Git integration
- **Rest Client**: Test HTTP APIs
- **TODO Highlight**: Track TODOs in code

**Strengths**:
- Free and open source
- Lightweight and fast
- Excellent extension ecosystem
- Regular updates
- Great community support
- Integrated terminal

**Weaknesses**:
- Refactoring not as powerful as GoLand
- Requires extension setup
- Performance can degrade with very large projects

**Best For**: Individual developers, lightweight projects, budget-conscious teams.

**Tips**:
- Install all recommended Go tools when prompted
- Use ⌘+Shift+P (Ctrl+Shift+P) for command palette
- Learn multi-cursor editing for productivity
- Use workspace settings for project-specific configuration

### Vim / Neovim

**URL**: https://www.vim.org / https://neovim.io
**Platform**: All (terminal-based)
**Cost**: Free and open source
**Level**: Intermediate to Advanced (steep learning curve)

**Why Use**: Extremely fast, customizable, available everywhere, powerful once mastered.

**Essential Plugins for Go**:

1. **vim-go** (classic Vim)
 - URL: https://github.com/fatih/vim-go
 - Full Go support
 - Syntax highlighting, completion, formatting
 - Built-in tools integration

2. **nvim-lspconfig** + **gopls** (Neovim)
 - Modern LSP-based Go support
 - Better performance and features
 - Consistent with other language servers

**Recommended Plugin Manager**:
- **vim-plug**: https://github.com/junegunn/vim-plug
- **packer.nvim**: https://github.com/wbthomason/packer.nvim (Neovim)

**Minimal vim-go Configuration**:
```vim
" .vimrc or init.vim
call plug#begin('~/.vim/plugged')
Plug 'fatih/vim-go', { 'do': ':GoUpdateBinaries' }
Plug 'neoclide/coc.nvim', {'branch': 'release'}
call plug#end()

" vim-go settings
let g:go_fmt_command = "goimports"
let g:go_auto_type_info = 1
let g:go_def_mode='gopls'
let g:go_info_mode='gopls'
let g:go_highlight_functions = 1
let g:go_highlight_methods = 1
let g:go_highlight_fields = 1
let g:go_highlight_types = 1

" Shortcuts
autocmd FileType go nmap <leader>b  <Plug>(go-build)
autocmd FileType go nmap <leader>r  <Plug>(go-run)
autocmd FileType go nmap <leader>t  <Plug>(go-test)
```

**Strengths**:
- Extremely fast
- Works over SSH
- Highly customizable
- Powerful editing with modal interface
- Available on all systems

**Weaknesses**:
- Steep learning curve
- Requires significant configuration
- Plugin ecosystem can be complex
- Debugging is less visual

**Best For**: Experienced Vim users, remote development, terminal enthusiasts.

### Emacs

**URL**: https://www.gnu.org/software/emacs/
**Cost**: Free and open source
**Level**: Intermediate to Advanced

**Why Use**: Extremely customizable, powerful extension system.

**Essential Packages**:
- **go-mode**: Syntax highlighting and basic Go support
- **lsp-mode** + **gopls**: LSP integration
- **company-go**: Code completion (older approach)
- **flycheck**: On-the-fly syntax checking

**Best For**: Emacs users, developers who want extreme customization.

### Sublime Text

**URL**: https://www.sublimetext.com
**Cost**: Paid (with unlimited free trial)
**Platform**: Windows, macOS, Linux

**Why Use**: Fast, lightweight, good plugin ecosystem.

**Essential Packages**:
- **LSP**: Language Server Protocol support
- **GoSublime**: Go-specific features

**Best For**: Developers wanting lightweight editor with good Go support.

### Command-Line Tools

#### gopls (Go Language Server)

**URL**: https://github.com/golang/tools/tree/master/gopls
**Install**: `go install golang.org/x/tools/gopls@latest`

**What It Is**: Official Go language server implementing LSP (Language Server Protocol).

**Why It Matters**: Powers IDE features (completion, navigation, refactoring) across all editors.

**Used By**: VS Code Go extension, GoLand, Vim/Neovim, Emacs, Sublime Text, and more.

#### gofmt / goimports

**Built-in**: gofmt comes with Go
**goimports**: `go install golang.org/x/tools/cmd/goimports@latest`

**What They Do**:
- **gofmt**: Format Go code according to standard style
- **goimports**: gofmt + automatic import management

**Why Use**: Consistent code formatting across all Go projects. No style debates.

**Usage**:
```bash
# Format a file
gofmt -w file.go

# Format with import management
goimports -w file.go

# Format entire directory
gofmt -w .
goimports -w .
```

**Editor Integration**: Most editors auto-format on save.

#### golangci-lint

**URL**: https://golangci-lint.run
**Install**: See website for installation instructions

**What It Is**: Fast Go meta-linter that aggregates multiple linters into one tool.

**Why Use**: Catch bugs, enforce best practices, ensure code quality.

**Linters Included**: (40+ linters)
- govet: Go's built-in vet tool
- errcheck: Check error handling
- staticcheck: Static analysis
- gosimple: Simplification suggestions
- ineffassign: Detect ineffectual assignments
- unused: Find unused code
- And many more...

**Usage**:
```bash
# Run with default configuration
golangci-lint run

# Run specific linters
golangci-lint run --enable=govet,errcheck

# Run with config file
golangci-lint run -c .golangci.yml
```

**Configuration** (.golangci.yml):
```yaml
linters:
  enable:
    - govet
    - errcheck
    - staticcheck
    - gosimple
    - ineffassign
    - unused
    - gofmt
    - goimports

linters-settings:
  govet:
    check-shadowing: true
  errcheck:
    check-blank: true

run:
  timeout: 5m
```

**CI Integration**: Use in GitHub Actions, GitLab CI, etc.

#### Delve (dlv)

**URL**: https://github.com/go-delve/delve
**Install**: `go install github.com/go-delve/delve/cmd/dlv@latest`

**What It Is**: Debugger for Go programs.

**Why Use**: Debug Go programs from command line or integrated in IDEs.

**Usage**:
```bash
# Debug a program
dlv debug main.go

# Debug a test
dlv test

# Attach to running process
dlv attach <pid>

# Remote debugging
dlv debug --headless --listen=:2345 --api-version=2
```

**Commands** (in dlv):
- `break main.go:10`: Set breakpoint
- `continue`: Continue execution
- `next`: Step over
- `step`: Step into
- `print var`: Print variable
- `stack`: Show stack trace

**IDE Integration**: GoLand and VS Code use Delve for debugging.

#### go-mod-upgrade

**URL**: https://github.com/oligot/go-mod-upgrade
**Install**: `go install github.com/oligot/go-mod-upgrade@latest`

**What It Does**: Interactive tool to upgrade Go module dependencies.

**Usage**:
```bash
# Check and upgrade dependencies
go-mod-upgrade

# Follow prompts to upgrade modules
```

#### goimports-reviser

**URL**: https://github.com/incu6us/goimports-reviser
**Install**: `go install github.com/incu6us/goimports-reviser/v3@latest`

**What It Does**: Format imports into groups (stdlib, external, local).

**Usage**:
```bash
goimports-reviser -rm-unused -set-alias -format ./...
```

### Online IDEs

#### GitHub Codespaces

**URL**: https://github.com/features/codespaces
**Cost**: Free tier available, then paid

**What It Is**: Cloud-based VS Code environment.

**Why Use**: Development in the cloud, consistent environments, no local setup.

#### Gitpod

**URL**: https://www.gitpod.io
**Cost**: Free tier available

**What It Is**: Cloud development environment.

**Why Use**: Quick project setup, reproducible dev environments.

#### Replit

**URL**: https://replit.com
**Cost**: Free tier available

**What It Is**: Online IDE with collaborative features.

**Best For**: Learning, quick experiments, collaborative coding.

---
