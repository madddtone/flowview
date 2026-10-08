# flowview

A tiny, self-contained **local web viewer** for [Flow Tracker](https://github.com/madddtone/flow-tracker)
graphs. It serves a folder of compiled `flow.json` files plus an embedded
single-page frontend — no repo, no `flowc`, no build step, no dependencies.

Use it to hand someone your flows: send them the `flowview` binary and a folder
of JSON, they run one command, and it opens in their browser.

## Install

`flowview` is a single self-contained binary — no runtime, no dependencies.

### Option A — download a release (no toolchain)

Grab the build for your OS/arch from the
[Releases page](https://github.com/madddtone/flowview/releases):

| OS | Asset |
|----|-------|
| Linux | `flowview_linux_amd64` (or `..._arm64`) |
| macOS | `flowview_darwin_amd64` (Intel) / `flowview_darwin_arm64` (Apple Silicon) |
| Windows | `flowview_windows_amd64.exe` |

Install it on your PATH:

```sh
# macOS / Linux
chmod +x flowview_linux_amd64
mkdir -p ~/.local/bin
mv flowview_linux_amd64 ~/.local/bin/flowview
# ~/.local/bin is on PATH on Omarchy/Arch; otherwise add it to your shell rc
```

```powershell
# Windows (PowerShell)
mkdir $HOME\bin -Force
move flowview_windows_amd64.exe $HOME\bin\flowview.exe
# then add %USERPROFILE%\bin to PATH, or run it from that folder
```

### Option B — build from source (Go 1.21+)

```sh
go install github.com/madddtone/flowview/cmd/flowview@latest

# from a clone, installs to ~/.local/bin/flowview
make install
```

### Verify

```sh
flowview version   # -> flowview 0.1.0
flowview list      # lists the flows it can find
```

## Use

```sh
# View the flowc central store (default when it exists):
flowview

# View any folder of flow JSON (flow.json + subflow .json + optional .md):
flowview ~/Downloads/my-flows

# Options
flowview <dir> --port 8787 --host 127.0.0.1 --open=false
```

The browser opens automatically. Deep links:

- `?p=<jsonPath|id>` — open a specific flow
- `&node=<id>` — pre-select a node

```sh
flowview list [dir]              # list the flows found in a folder/store
```

## Sharing a flow with someone

```sh
# On your machine (Omarchy, where the flowc store lives):
flowview pack my-flow -o ~/send/my-flow

# Send ~/send/my-flow to your friend. On their machine, install flowview once
# (see Install above — just the release binary), then:
flowview ~/send/my-flow
```

`pack` copies the project's `flow.json`, every subflow JSON, and the `.md`
sources into a portable folder with a relative `index.json`. The friend needs
only the `flowview` binary for their OS — no Go, Python, Node, or `flowc`.

## What it reads

`flowview` accepts either:

- a **flowc central store** — `index.json` + `projects/<id>/flow.json`
  (`~/.local/share/flow-tracker`), or
- **any folder** containing flow JSON — each `*.json` that has `nodes` and
  `edges` is treated as a flow.

Paths are resolved **relative to the served folder**, and absolute paths in
`index.json` / `subflowJson` are ignored — so a folder copied to another
machine just works. Subflows (`flow: ./x.md`) are loaded from the sibling
`x.json`.

## Features

- Deterministic layered render straight from the compiled `flow.json` `rect`s.
- **Table nodes** (`type: table`) render a header + columns with PK/FK badges —
  the first 5 key columns on the node, all of them in the inspector.
- Click a node to trace its routes; `d` widens to the full downstream subgraph;
  upstream nodes stay faintly lit.
- Inspector popup with all attributes and the prose sections
  (Logic, Requirements, Prerequisites, Inputs, Outputs, Failure Modes, Notes).
- Subflow drill-in (double-click / Enter / inspector button) with a breadcrumb.
- Zoom (scroll), pan (drag background), node drag, `f` fit, `r` reset layout.
- Search (`/`), project picker (`p`), light/dark theme.

| Key / input | Action |
|---|---|
| click node | select + trace its routes |
| double-click / Enter on a subflow node | drill into it |
| backspace / esc | go back up a subflow, then clear/close |
| ← ↑ → ↓ | step along routes |
| `d` | toggle next-steps vs full downstream |
| scroll / drag bg / drag node | zoom / pan / move a node |
| `f` `r` `0` | fit / reset layout / reset zoom |
| `/` `p` | find node / project picker |
| `q` | close the window |

## Develop

```sh
make build     # -> bin/flowview
make test
make vet
```

The frontend lives in `internal/web/` and is embedded with `go:embed` at build
time. `internal/web/model.js` is a browser-safe copy of the Omarchy plugin's
`FlowModel.js` — keep the two in sync.

## License

MIT
