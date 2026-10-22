# btop

A [btop](https://github.com/aristocratos/btop)-style system monitor as its own
Hermes WebUI page. It adds a monitor icon to the nav rail (and the phone nav).
Clicking it opens a full-width page beside Chat, Insights and Logs.

It is for people who self-host Hermes and want to see, without opening a
terminal, what the box is doing and how much of it Hermes itself is using.

## What it shows

| Box | Contents |
|---|---|
| **1 cpu** | Dotted (or area) usage graph, total meter, per-core meters with mini-graphs and temperatures, load average, user/sys/iowait/steal split, task counts, uptime |
| **2 mem** | Used / available / cached / free / swap meters and a usage graph |
| **3 net** | Download and upload graphs for one interface (‹ › switches interface), current rate in bits, peak, totals |
| **4 disks** | Each real filesystem: used/total, read/write rate, busy %, I/O sparklines. A mount whose `statvfs` hangs (dead NFS/CIFS/FUSE) is marked *not responding* with its last known numbers |
| **5 hermes** | Hermes processes grouped as `agent`, `webui`, `cron`, `mcp`, `swe-pilot`, `browser`, `coding-cli`, `btop`. Children inherit their parent's group. Tap a group to filter the process table |
| **6 proc** | Sortable process table with CPU sparklines, filter, tree view (collapsible), and a detail pane (cwd, exe, fds, I/O, context switches, children) with TERM / INT / HUP / KILL / STOP / CONT, each needing a confirm tap |

**Filter syntax:** space-separated terms are ANDed. A term matches name,
command, pid, user or group. `g:webui` matches one group, `g:*` matches any
Hermes group, and `!term` negates a term.

**Keys** (while the page is open):
- `1`–`6` toggle boxes.
- `f` or `/` filters; `t` toggles tree view.
- `c` `m` `p` `n` sort by cpu / mem / pid / name; `r` reverses the sort.
- `↑` `↓` select a process; `Esc` closes the detail pane or clears the filter; `space` pauses.

Shortcuts never run while you type in a field or while focus is in other
WebUI UI. On a focused button or link, `space`, `Enter` and the arrow keys keep
their normal meaning, so `space` on a focused *confirm KILL?* activates it
rather than pausing.

**Settings** (Settings → Extensions → btop):
- Refresh interval (250–10000 ms, default 1000).
- Graph style: dots or area.
- Process CPU% per core instead of as a share of all cores.

Box visibility, sort, tree mode, filter and interface are remembered under
the extension-owned storage key `prefs` (`hermesExt` storage). Nothing else is
written to browser storage.

**Theming:** the page uses Core tokens only, so it follows the active skin and
light/dark theme. Text drawn in a role colour (box titles, the sorted header,
hot CPU values, tags) is adjusted at runtime to at least 5:1 contrast against
the actual background, so it stays readable in every skin. Below 860 px the
page stacks into one column; below 640 px the command column and sparklines
are hidden. On touch screens, buttons, chips and signal buttons are at least
44 px.

## Install

1. **Install the extension.** Open **Settings → Extensions → Gallery**, find
   **btop** and click **Install**. That places the entry in
   `~/.hermes/webui/extensions/btop/`. For a manual install, follow the
   generic steps in Hermes WebUI's `docs/EXTENSIONS.md`, and point the unit's
   `WorkingDirectory` below at your copy of `btop/sidecar`.
2. **Start the sidecar** as the same user that runs Hermes WebUI. The token
   file WebUI writes is that user's and is mode 0600:
   ```bash
   mkdir -p ~/.config/systemd/user
   cp ~/.hermes/webui/extensions/btop/sidecar/hermes-btop-sidecar.service ~/.config/systemd/user/
   systemctl --user daemon-reload
   systemctl --user enable --now hermes-btop-sidecar
   systemctl --user status hermes-btop-sidecar      # should be active (running)
   loginctl enable-linger "$USER"                   # optional: run without a login session
   ```
   Without systemd:
   `cd ~/.hermes/webui/extensions/btop/sidecar && python3 -S sidecar.py`
3. **Approve the proxy.** Open **Settings → Extensions → Diagnostics →
   Loopback sidecars** and click **Approve proxy consent** on the **btop** row.
   WebUI authentication must be on; Core refuses token-v1 proxying without it.
4. **Open the page.** Reload the WebUI tab and click the monitor icon in the
   rail.

If something is wrong, the page shows the proxy's or sidecar's own error
message together with the next step: approve consent, turn on auth, start the
sidecar, and so on.

## Disable / uninstall

- **Disable:** toggle btop off in Settings → Extensions → Installed, then
  reload. The sidecar can keep running; nothing calls it.
- **Uninstall:** remove btop in Settings → Extensions, then remove the sidecar:
  ```bash
  systemctl --user disable --now hermes-btop-sidecar
  rm ~/.config/systemd/user/hermes-btop-sidecar.service
  systemctl --user daemon-reload
  ```
- **Browser state:** the `prefs` key lives in the extension's own storage
  namespace. Clear it from the extension's settings card.

## Sidecar

- **Listener:** `127.0.0.1:17797` only. Built on the canonical scaffold
  (`sidecar_base.py`, `sidecar.py`). Stdlib only, run with `python3 -S`.
- **Auth:** `proxy_auth: token-v1`. Every route except `GET /health` requires
  the token WebUI injects through its proxy (`/api/extensions/btop/sidecar/...`).
- **Sampling:** a sampler thread reads `/proc` and `/sys` every second and
  keeps 600 samples (10 min) of history. Only that thread touches process
  state. A request that finds sampling idle wakes it and waits for one fresh
  sample. Per-process sampling pauses when no page has polled for 30 s.
- **Disk stats:** `statvfs` runs on a separate worker, with a 1.5 s timeout per
  mount. Nothing blocks before the server starts, so `/health` answers
  immediately even when a mount is hung.
- **Response size:** each snapshot's JSON is capped at 448 KiB, under Core's
  512 KiB proxy limit. Over the cap, the oldest history samples are dropped
  first, then the quietest process rows. The response carries
  `truncated: {history, procs, budget}`, and the page shows how many processes
  were sent. Snapshots are gzip-compressed when the browser accepts it. The
  page fetches only the history delta since its last sequence number, and
  skips process data when no box that needs it is visible.
- **Routes:**
  - `GET /api/snapshot?since=&boot=&procs=0|1`
  - `GET /api/proc/{pid}`, including `start`, the process start time
    (`/proc/<pid>/stat` field 22)
  - `POST /api/proc/{pid}/signal {"signal": "TERM", "start": <ticks>}`
- **Signals:**
  - Only TERM, INT, HUP, KILL, STOP and CONT are accepted. The sidecar refuses
    pid ≤ 1 and its own pid.
  - The signal goes to the exact process you confirmed. The page sends the
    start time it showed, and the sidecar opens a pidfd (`os.pidfd_open`),
    checks the start time, and signals through the pidfd
    (`signal.pidfd_send_signal`).
  - A recycled PID gets **409** and no signal; an exited process gets 404.
    Without pidfd support (Linux < 5.3) the route returns 501 instead of
    falling back to a racy `kill()`.
  - `BTOP_SIGNALS=0` turns signals off and hides the buttons.
- **Files read:**
  - Per process: `/proc/<pid>/{stat,status,io,cmdline}`. `/proc/<pid>/fd` is
    counted, and `cwd` / `exe` are read as links.
  - System-wide: `/proc/{stat,meminfo,net/dev,diskstats,loadavg,uptime,cpuinfo,self/mounts}`
    and `/sys/class/hwmon/*` (temperatures).
  - `statvfs` on each real filesystem mount.
  - Host facts: `/etc/os-release`, `/run/systemd/container`, `/.dockerenv`
    (existence only), and `/etc/passwd` through `getpwuid` (uid → user name).
  - WebUI's token file, `<state>/sidecar-auth/btop.token`.
  - It never reads other processes' `environ`, and it writes nothing.

## Trust model and permissions

Like every extension, the page script runs with your WebUI session's authority.
It talks only to the same-origin sidecar proxy and makes no external network
calls.

The sidecar exposes host-wide process information to anyone who can use your
WebUI. That includes command lines and working directories of every user's
processes, including root's when the sidecar runs as root.

**Command-line masking is best-effort:** a pattern list, not a guarantee.
Before a command line leaves the sidecar, at most 16 KiB of it is read. It is
split into argv elements, and any element longer than 1024 characters is
replaced by its length without being scanned. Every pattern has bounded
repeats, so cost is linear in that capped size. Then, per element:
- **Secret flags:** `--password X`, `--token=X`, `--key X`, `--private-key=X`,
  `--pat X`, `--api-key`, `--secret`, `--auth` and similar names mask their
  value, or the whole next element. A multi-word value is one element, so it
  is fully masked.
- **Program forms:** `mysql -pX` (and the MariaDB tools), `curl`/`wget`
  `-u user:X` and `--user user:X`, `redis-cli -a X`, and `sshpass -p X`.
- **Secret-named variables:** `NAME=value` when the name contains PASSWORD,
  TOKEN, SECRET, API_KEY, KEY, PAT and so on.
- **Inside any element:**
  - URL credentials (`scheme://user:X@`)
  - `Bearer` / `Basic` / `Token` values
  - secret-named headers (`Authorization: …`, `X-Api-Key: …`)
  - secret-named query parameters (`?token=…`)
  - `sk-`, `ghp_`, `github_pat_`, `glpat-`, `xox*-`, `AKIA` / `ASIA`,
    `AIza`, `hf_`, `npm_` and JWT shapes.

Secrets passed as plain positional arguments to unknown programs
(`htpasswd -b file user PASS`) are not recognised.

Signals act with the sidecar's privileges. Run it as the WebUI user, or set
`BTOP_SIGNALS=0` if that's too much.

The extension owns its DOM:
- It adds a rail button, a mobile nav button, a sidebar
  `.panel-view[data-panel-token="btop"]` and `#mainBtop` inside `<main>`.
- Opening the page first runs Core's own `switchPanel('chat')`. That stops
  Logs auto-refresh, closes the Kanban stream, honours the unsaved-Settings
  guard and keeps `_currentPanel` truthful. The btop view is then overlaid on
  top.
- It wraps `window.switchPanel` and `window.newSession` so leaving the page
  restores Core's views.
- It wraps `window.syncAppTitlebar` so Core's chat-title refreshes don't
  overwrite the page title.

## WebUI surfaces used

- Manifest bundle, extension-owned `settings_schema` and storage, and
  `hermesExt.register`.
- Token-v1 sidecar proxy.
- DOM: `.rail`, `.rail-spacer`, `.sidebar-nav`, `main.main`, `#mainChat`,
  `#appTitlebarTitle`, `#appTitlebarSub`, and the `showing-x-<token>` +
  `data-panel-token` convention that Core's mobile sidebar sync recognises.
- Core page globals, when present: `switchPanel`, `syncAppTitlebar`,
  `newSession`, `_currentPanel`, `_isDesktopWidth`, `_isSidebarCollapsed`,
  `expandSidebar`, `toggleSidebar`, `closeMobileSidebar`, `showToast`,
  `switchSettingsSection`.

A WebUI refactor of the rail, `switchPanel` or the main-view classes may need
an update here.

## Known limitations

- **Linux only.** The sidecar reads procfs. Signals need pidfd (Linux 5.3+,
  Python 3.9+).
- **Containers.** Inside LXC with lxcfs, CPU/memory/load reflect the
  container, but temperatures and disk devices come from the host.
- **Disk I/O** is matched by block device name. Filesystems on loop or
  overlay devices may show no rate.
- **Process CPU%** is computed between the sidecar's 1 s samples. Very short
  processes may not appear.
- **Busy hosts.** On hosts with very many processes, cores or interfaces, the
  size cap trims the quietest process rows. Tree view then shows fewer
  ancestors. History keeps the 16 busiest interfaces.
- **Hermes groups** are pattern-based (command-line regexes), so renamed or
  wrapped launchers may land in no group.

## Compatibility and verification

- **Tested against:**
  - Hermes WebUI v0.52.458 (`fd0141fa`), with the extension-facing code
    re-checked against `master` (`ca8f81e`, 2026-10-21): proxy size cap,
    header pass-through, `switchPanel`, `syncAppTitlebar`, `showToast`.
  - Debian 13 LXC, Python 3.13 for the sidecar.
  - Chromium at 1440×900 and at 390×844 (mobile + touch emulation), light and
    dark.
- **Requires:** manifest bundles, `settings_schema`, `hermesExt.register`, and
  the token-v1 sidecar proxy.
- **Tests:**
  - `scripts/test-btop-core.mjs`:
    - formatting, history merge, sort, filter grammar, process tree
    - colour parsing, contrast and the text-safe adjustment across every Core
      skin's tokens
    - the keyboard-shortcut guard
  - `scripts/test-btop-collector.py`:
    - procfs parsers and CPU math
    - per-argv masking, including the long-argument timing bounds
    - Hermes grouping
    - the 448 KiB budget on synthetic procfs: 64 cores / 4 interfaces / 600
      processes, 32 / 40 / 500 and 8 / 60 / 300
    - a disk worker with a hung `statvfs`
    - start-time-pinned signals on a real child process, including the 409
      path
