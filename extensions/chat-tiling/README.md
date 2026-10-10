# Chat Tiling — snapshot-only v1

Compare saved conversation history in 2, 4 or 6 snapshot cards. There is only
one input area: Core's existing composer, shown in normal chat. Every grid cell
is a history snapshot; none is a transparent live pane.

Open the grid with the **Compare history** icon button at the right of the title
bar. Its first slot loads the current conversation's recent saved history.
While comparing, the conversation list shows a short hint and a click (or tap)
on a conversation adds it as a snapshot instead of opening it. Empty slots have
a **Choose conversation** button that reveals Core's own conversation list (the
drawer on phones, which closes again after you pick). Switch between 2, 4 and 6
slots with the segmented control. Narrow grids stack the cards in one column.
Each card has **Refresh history**, **Expand**/**Restore**, and **Close**
controls. Refresh reads saved history again; it does not subscribe to a stream.
Responses are limited to the most recent 30 visible rows. Open normal chat to
read the full conversation.

Click a card's title to leave the grid and use Core's ordinary `loadSession`
navigation. Core owns the draft, attachments, profile/model, approvals, sends
and streams. Use **Compare history** again to return to the retained snapshots,
or **Return to chat** / Escape to leave comparison without navigating.

**Close only removes a local snapshot.** It does not cancel a stream, delete a
conversation, clear a draft or change Core's active session. Closing the final
card returns to normal chat. Reducing a layout refuses to silently discard
populated cards; close them first. Failed refreshes keep the previous snapshot.

The grid temporarily hides and makes Core's transcript/composer inert while
comparison is visible; it never detaches them or creates a second composer.
Their previous accessibility attributes are restored on exit. Owned controls
stop Enter/Space propagation so grid actions cannot trigger Core's approval
shortcut. Sidebar action buttons and menus remain Core's responsibility.
Switching panels exits comparison. Native navigation is never vetoed by a
session-open hook; it exits the grid and proceeds normally. Native new/delete
transitions that bypass those hooks are observed to exit comparison, without
trying to repair, supersede or roll back Core's navigation.

## Trust and capabilities

Same-origin read-only `/api/session` requests supply snapshot history. The
extension uses Core's `renderTranscript` renderer and public `loadSession` and
session-open hook. When a saved message contains a local file or image, Core's
renderer links it through the authenticated `/api/media` route; the extension
rewrites those links to the snapshot's own session id so Core's per-session
allow-list authorizes them (declared as a `media` read).

**Choose conversation** calls Core's own `expandSidebar()` (desktop) or
`toggleMobileSidebar()` (phone), the same functions behind Core's sidebar
buttons. On desktop that writes Core's `hermes-webui-sidebar-collapsed`
preference (declared as a shared key), so a collapsed sidebar stays open
afterwards exactly as if you had opened it yourself. Snapshots also contain
Core-rendered audio players, whose speed control saves Core's
`hermes-media-playback-rate` preference (also declared) exactly as it does in
normal chat. File previews that Core loads lazily (PDF, HTML, diff, CSV,
Excalidraw) appear in snapshots as download chips, the way Core shows a file it
cannot preview. The extension writes no other storage, drafts or inflight
state; does not read `INFLIGHT`; and does not call send, approval, cancel or
delete APIs. It needs no sidecar, remote script or external service, has no
filesystem access of its own (local files are only reached through Core's media
route above), and the manifests declare no write endpoints.

`network_external` is declared `true` for one reason: snapshots are rendered by
Core's `renderTranscript`, so if a saved message contains a remote Markdown
image, the browser requests it just as Core's own transcript would when you open
that conversation. Current Core blocks remote images by default through its
`img-src` CSP (operators can allowlist hosts); older Core versions load them.
The extension itself never contacts an external origin.

Core normal navigation may still fail, including during streaming recovery.
The extension hands off once, restores normal chat and never performs a failed
load rollback or writes composer state. A resolved Core navigation promise is
not presented as a successful live snapshot. Core's own failed-navigation draft
and attachment behavior remains a Core concern; this extension does not claim
to repair it. Fitted live-pane geometry and stream-owned cancellation are not
requirements of this snapshot-only version.

## Verification

```bash
node scripts/test-chat-tiling.mjs
HERMES_CORE_DIR=/path/to/hermes-webui python tests/compatibility/chat_tiling_smoke.py
```

The browser suite uses a real isolated Core backend, real imported transcripts,
and the native renderer/navigation. It checks populated desktop, narrow/mobile,
light/dark snapshots, the sole composer and node restoration, keyboard actions,
returning to retained snapshots, independent snapshot refresh failures and late
responses, local close of busy history, persisted draft isolation, and failure
handoff without extension rollback. Approval responses and unexpected browser
egress are blocked; no actual model or cancel/delete producer is invoked.
The removed live-tile regression evidence remains in the maintenance outcome
report; it is not treated as this product's acceptance contract.

## Local testing

```bash
cd /path/to/hermes-webui
HERMES_WEBUI_EXTENSION_DIR=/path/to/hermes-webui-extensions/extensions/chat-tiling \
HERMES_WEBUI_EXTENSION_MANIFEST=manifest.json \
./start.sh
```

Requires Core's public session-open hook, transcript renderer and `loadSession`.
Feature detection leaves unsupported Core versions unchanged. No live-tile mode
or automatic stream cancellation is included in v1.
