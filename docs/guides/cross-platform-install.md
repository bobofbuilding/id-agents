# Cross-Platform Install, Update, and Troubleshooting

This guide is for onboarding a clean macOS, Linux, or Windows WSL machine to run
ID Agents from source. It complements the shorter [Quickstart](../../QUICKSTART.md)
with host-specific setup, validation, update safety, and common failure recovery.

Use WSL2 for Windows. Native PowerShell or cmd.exe are not supported for running
the local agent manager because the project expects Unix shell behavior, POSIX
paths, and background process semantics.

## Supported Host Targets

| Host | Recommended setup |
| --- | --- |
| macOS 13+ | Terminal or iTerm2, Xcode Command Line Tools, Node.js 22+ |
| Linux | Ubuntu/Debian-like distro, build tools, Node.js 22+ |
| Windows | WSL2 with Ubuntu, repo stored under the WSL filesystem such as `~/src/id-agents` |

The package declares `node >=20`, but clean-machine onboarding should use Node.js
22+ to match the project quickstart and current development path.

## 1. Install Host Prerequisites

### macOS

```bash
xcode-select --install

# Optional if Homebrew is already your package manager.
command -v brew >/dev/null 2>&1 && brew install git jq
```

Install Node.js 22+ with your preferred version manager. `nvm` is the most
portable option across macOS, Linux, and WSL:

```bash
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
source "$HOME/.nvm/nvm.sh"
nvm install 22
nvm use 22
```

### Linux

```bash
sudo apt update
sudo apt install -y git curl ca-certificates build-essential python3 pkg-config jq lsof
```

Then install Node.js 22+:

```bash
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
source "$HOME/.nvm/nvm.sh"
nvm install 22
nvm use 22
```

### Windows WSL

Install WSL2 and an Ubuntu distribution from an elevated PowerShell:

```powershell
wsl --install -d Ubuntu
```

Open the Ubuntu shell and keep all project files inside the Linux filesystem:

```bash
mkdir -p ~/src
cd ~/src
```

Do not clone the repo under `/mnt/c/...` for day-to-day work. Cross-filesystem
watching, permissions, line endings, and native module builds are less reliable
there.

Inside WSL, install the Linux prerequisites and Node.js exactly as in the Linux
section. Install runtime CLIs inside WSL too; Windows-side CLI installs are not
visible to WSL processes unless you add fragile PATH bridging.

## 2. Install and Authenticate Agent Runtimes

At least one of Claude Code CLI or Codex CLI must be installed and authenticated
before deploying the default team. Cursor Agent CLI is optional and must be
selected explicitly in custom configs.

```bash
# Claude Code CLI
npm install -g @anthropic-ai/claude-code
claude login

# Codex CLI, optional unless this host will run Codex agents
npm install -g @openai/codex
codex login

# Cursor Agent CLI, optional
curl https://cursor.com/install -fsS | bash
cursor-agent login
```

If you use environment-variable auth instead of login files, export the variables
in the same shell or service environment that starts `id-agents`:

```bash
export ANTHROPIC_API_KEY=...
export OPENAI_API_KEY=...
export CURSOR_API_KEY=...
```

## 3. Clone and Build ID Agents

```bash
git clone https://github.com/idchain-world/id-agents.git
cd id-agents

node --version
npm --version

npm ci
npm run build
npm run ci:preflight
```

Use `npm ci` on clean machines because the repository includes
`package-lock.json`. Use `npm install` only when intentionally updating the
dependency lockfile. `npm run ci:preflight` runs the same lint, typecheck, and
test gate that pull-request CI runs; it needs neither agent-runtime credentials
nor a running manager.

By default, ID Agents uses SQLite at `~/.id-agents/id-agents.db`; no database
server is required. To use PostgreSQL or optional API keys, copy the example env
file and edit only the values you need:

```bash
cp .env.example .env
```

Common optional settings:

```env
DATABASE_URL=postgresql://user:pass@localhost:5432/id_agents
ID_CONTROL_API_KEY=your-secure-admin-key
ID_AGENT_API_KEY=your-agent-key
```

## 4. Validate the Host Before Deploying

Detect which authenticated runtimes are available:

```bash
./scripts/detect-runtimes.sh
```

The first output line determines the next action:

| Output | Meaning | Action |
| --- | --- | --- |
| `mixed` | Claude and Codex are ready | Put `researcher` on `codex`; leave `coder` on `claude-code-cli` |
| `as-is` | Claude is ready | Deploy `configs/default.yaml` unchanged |
| `all-codex` | Codex is ready | Change the default runtime to `codex` |
| `abort` | Neither Claude nor Codex is ready | Install and log in to at least one runtime |

Start the manager:

```bash
npm run id-agents
```

For a headless process without the interactive prompt:

```bash
node dist/start-agent-manager.js
```

From another terminal, verify the manager API:

```bash
curl -s -X POST http://localhost:4100/remote \
  -H "Content-Type: application/json" \
  -d '{"command":"/status"}'
```

Deploy the default team after applying any runtime edit from
`detect-runtimes.sh`:

```bash
curl -s -X POST http://localhost:4100/remote \
  -H "Content-Type: application/json" \
  -d '{"command":"/deploy default"}'
```

List agents:

```bash
curl -s -X POST http://localhost:4100/remote \
  -H "Content-Type: application/json" \
  -d '{"command":"/agents"}'
```

## 5. Safe Update Procedure

Never pull over an unknown checkout silently. First inspect local state:

```bash
cd <path-to-id-agents>
git branch --show-current
git status --short
git fetch origin main
node -p "require('./package.json').version"
git show origin/main:package.json | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).version))'
```

Proceed only when the operator accepts the update and the tree is clean, or when
you have explicitly handled local changes:

```bash
git pull --ff-only origin main
npm ci
npm run build
./scripts/detect-runtimes.sh
```

For a running team, prefer `/sync` when changing config, skills, or agent
definitions without intentionally replacing active sessions. Use `/deploy` when
you intend to create or replace the team from the selected config.

```bash
curl -s -X POST http://localhost:4100/remote \
  -H "Content-Type: application/json" \
  -d '{"command":"/sync default"}'
```

## Troubleshooting

### `npm ci` fails while building native modules

`better-sqlite3` and related packages can require native build tools.

- macOS: run `xcode-select --install`, then retry `npm ci`.
- Linux or WSL: install `build-essential python3 pkg-config`, then retry
  `npm ci`.
- Confirm Node.js is 22+ with `node --version`.

### `./scripts/detect-runtimes.sh` prints `abort`

At least one default runtime is missing or unauthenticated.

```bash
command -v claude
claude login

command -v codex
codex login
```

On WSL, run these commands inside WSL. A Windows-side login does not reliably
authenticate Linux processes.

### Agents start and then show `status: error`

Check the manager terminal first. Then inspect agent logs:

```bash
ls workspace/logs
```

Common causes are missing runtime auth, a config runtime that is not installed,
or a working directory path that does not exist on this host.

### The manager cannot bind port 4100

Another manager or process is already using the default port.

```bash
lsof -i :4100
MANAGER_PORT=5000 npm run id-agents
```

When using a non-default port, set `MANAGER_URL` for tools that call the manager:

```bash
export MANAGER_URL=http://localhost:5000
```

### `/remote` returns an auth error

If `ID_CONTROL_API_KEY` is set in the manager environment, callers must send the
matching API key. Either unset it for local-only development or include the
configured header expected by your control client.

### WSL cannot find `claude`, `codex`, or `cursor-agent`

Install the CLI inside WSL and restart the shell so PATH changes load. Avoid
depending on Windows executables from WSL for managed background agents.

### Shell scripts fail with permission or line-ending errors

Run scripts from a Unix shell and keep the repo on a Unix filesystem.

```bash
chmod +x scripts/detect-runtimes.sh
git config core.autocrlf input
```

If the repo was edited from Windows tools and scripts contain CRLF line endings,
restore them from Git in WSL before continuing.

### SQLite state needs to be reset during local testing

The default database is under `~/.id-agents/`. Move the file aside instead of
deleting it until you know there is no useful local state:

```bash
mv ~/.id-agents/id-agents.db ~/.id-agents/id-agents.db.bak
```

Restart the manager after moving the database.

## Clean-Machine Validation Notes

Validated by source dry-run plus local command checks on 2026-07-14. The local
host was not a fresh clone, so the clean-machine portion was reasoned from the
checked-in source files listed below.

- `package.json` was checked for `node >=20`, build/test scripts, manager/TUI
  scripts, and the package entry points.
- `package-lock.json` is present, so the clean install path uses `npm ci`.
- `QUICKSTART.md` was checked for runtime login, manager port 4100, deployment,
  and default-team runtime detection flow.
- `.env.example` was checked to distinguish optional settings from required
  clean-machine setup; SQLite is the default with no required database server.
- `scripts/detect-runtimes.sh` was checked for the `mixed`, `as-is`,
  `all-codex`, and `abort` paths documented above.
- The guide intentionally uses WSL2 for Windows and keeps all operational
  commands inside the Linux environment to match the shell assumptions in the
  repository scripts.
- Local command checks passed with Node.js `v25.5.0` and npm `11.8.0`:
  `npm run build` completed successfully, and `./scripts/detect-runtimes.sh`
  reported `mixed` with Cursor Agent CLI also available.
