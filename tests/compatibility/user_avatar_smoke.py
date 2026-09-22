#!/usr/bin/env python3
"""Real-browser visual + Configure compatibility smoke for the Custom User Avatar extension.

The user-avatar decoration cannot be approved from CSS alone: user rows are
``align-self:flex-end`` with responsive max widths and mobile
``content-visibility`` containment, so placement has to be measured in a real
engine against Core's own transcript markup. This smoke boots one independently
pinned Core checkout, seeds a populated transcript through Core's exposed
``window.renderTranscript`` renderer, and captures the review matrix at desktop
and 390px mobile viewports.

It proves, rather than illustrates:

* **disabled pixel parity** — the captured PNG with the extension loaded but off
  is byte-identical to the same page with the extension's root flag forced off;
* **geometry** — the ``::before`` avatar box and the reserved ``.msg-body``
  gutter measure exactly the configured size at Small/Medium/Large, and the
  mobile Hide/Compact rules take effect at 390px;
* **Configure lifecycle** — the panel opens as a real modal, traps Tab, closes
  on X/Escape/backdrop, and settles Core's own pending state
  (``HermesExtensionSettings._configureStateForExtension('user-avatar')``);
* **the error path** — a rejected upload reports an error and stores nothing.

Like the other entry-owned smokes it never sends a chat or contacts a provider,
the browser guard is deny-by-default for off-origin traffic, and all evidence is
written to the requested compatibility evidence directory.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import struct
import sys
import tempfile
import traceback
import urllib.parse
from pathlib import Path
from typing import Any

try:
    from browser_smoke import (
        CompatibilityFailure,
        SetupFailure,
        _assert_browser_health,
        _install_network_guards,
        _start_server,
        _terminate,
        _write_json,
    )
except ModuleNotFoundError:  # pragma: no cover - supports module execution.
    from tests.compatibility.browser_smoke import (
        CompatibilityFailure,
        SetupFailure,
        _assert_browser_health,
        _install_network_guards,
        _start_server,
        _terminate,
        _write_json,
    )


REPO_ROOT = Path(__file__).resolve().parents[2]
EXTENSION_ID = "user-avatar"
COMPAT_SESSION_ID = "user-avatar-compat"
DESKTOP_VIEWPORT = {"width": 1440, "height": 1000}
MOBILE_VIEWPORT = {"width": 390, "height": 844}
EXTENSION_RESOURCES = (
    "/extensions/user-avatar/assets/user-avatar.js",
    "/extensions/user-avatar/assets/user-avatar.css",
)
EXTENSION_VERSION = "0.2.0"
CONFIGURE_SELECTOR = f'#extensionsInstalled [data-extension-configure-id="{EXTENSION_ID}"]'
PANEL_SELECTOR = "#hwx-uav-panel"
CARD_SELECTOR = "#hwx-uav-panel .hwx-uav-card"
ROW_SELECTOR = '.msg-row[data-role="user"]'
SIZE_PX = {"small": 24, "medium": 32, "large": 44}
MOBILE_COMPACT_PX = 20
GAP_PX = {"small": 10, "medium": 10, "large": 10}
MOBILE_COMPACT_GAP_PX = 6

# A 2x2 red PNG, used as the stored avatar. Small enough to inline, real enough
# to decode and paint.
AVATAR_PNG = (
    "data:image/png;base64,"
    "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFklEQVR4nGP8z"
    "8Dwn4GBgYEJxIAxAB8mAgN0y0KLAAAAAElFTkSuQmCC"
)

# A populated, realistic transcript: several consecutive user turns, a long
# message, a fenced code block, a Markdown table, and an assistant turn between
# them so consecutive-vs-interleaved spacing is both visible.
TRANSCRIPT = [
    {"role": "user", "content": "Can you check whether the extension registry job is still green?"},
    {
        "role": "assistant",
        "content": (
            "Yes — the last run on `main` finished cleanly. All twelve registered "
            "behavior suites passed and the registry artifact was uploaded."
        ),
    },
    {"role": "user", "content": "Good. Short follow-up."},
    {"role": "user", "content": "And another one immediately after, to show consecutive turns."},
    {
        "role": "user",
        "content": (
            "Here is a deliberately long user turn so the bubble reaches its responsive "
            "maximum width and wraps across several lines. It should keep its right "
            "alignment, keep the avatar pinned to the top-left of the row, and never "
            "let the reserved gutter collapse into the text. On a narrow viewport the "
            "same message has to stay readable, which is exactly why the narrow-screen "
            "setting exists and defaults to Hide."
        ),
    },
    {
        "role": "user",
        "content": (
            "Here's the snippet I mentioned:\n\n"
            "```python\n"
            "def reserve(width: int, gap: int) -> int:\n"
            "    \"\"\"Left gutter the avatar occupies inside the row.\"\"\"\n"
            "    return width + gap\n"
            "```\n"
        ),
    },
    {
        "role": "user",
        "content": (
            "And a table:\n\n"
            "| Size | Avatar | Gutter |\n"
            "| --- | --- | --- |\n"
            "| Small | 24px | 34px |\n"
            "| Medium | 32px | 42px |\n"
            "| Large | 44px | 54px |\n"
        ),
    },
    {
        "role": "assistant",
        "content": "Noted — the reserved gutter is `--hwx-uav-size + --hwx-uav-gap`.",
    },
]

# A user turn with an attachment strip (rendered by Core as `.msg-files` ABOVE the
# bubble) plus a plain follow-up, which is the row shape the edit-mode case edits.
ATTACHMENT_FILES = ("run-1.png", "run-2.png", "run-3.png")
ATTACHMENT_TRANSCRIPT = [
    {"role": "user", "content": "Here are the three screenshots from the failing run.",
     "attachments": list(ATTACHMENT_FILES)},
    {"role": "assistant", "content": "Thanks — the second one shows the stale header."},
    {"role": "user", "content": "Can you also check this one? It is a short follow-up message."},
    {"role": "assistant", "content": "Sure."},
]


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--core-dir",
        default=os.environ.get("HERMES_CORE_DIR", ""),
        help="independent Hermes WebUI Core checkout (or HERMES_CORE_DIR)",
    )
    parser.add_argument(
        "--extension-root",
        default=os.environ.get("HERMES_EXTENSION_ROOT", str(REPO_ROOT / "extensions")),
        help="extension source root (default: this checkout's extensions/)",
    )
    parser.add_argument(
        "--evidence-dir",
        default=os.environ.get(
            "COMPATIBILITY_EVIDENCE_DIR",
            str(REPO_ROOT / ".compatibility-evidence"),
        ),
        help="directory for screenshots, server log, and result JSON",
    )
    parser.add_argument(
        "--screenshot-dir",
        default=os.environ.get("USER_AVATAR_SCREENSHOT_DIR", ""),
        help="optional directory to also receive the committed review screenshots",
    )
    parser.add_argument(
        "--port",
        type=int,
        default=int(os.environ.get("HERMES_COMPATIBILITY_PORT", "0") or "0"),
        help="optional fixed non-production port; 0 chooses a free ephemeral port",
    )
    return parser.parse_args()


def _png_dimensions(path: Path) -> dict[str, int]:
    data = path.read_bytes()
    if len(data) < 24 or data[:8] != b"\x89PNG\r\n\x1a\n":
        raise CompatibilityFailure(f"not a PNG: {path}")
    width, height = struct.unpack(">II", data[16:24])
    return {"width": int(width), "height": int(height), "bytes": len(data)}


def _digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _init_script(*, enabled: bool, size: str, mobile: str, image: bool,
                 theme: str, font_size: str, skin: str) -> str:
    """Seed the page before any Core script runs.

    Scalars go through Core's own scoped-settings record and the extension's
    documented fallback keys; the image goes into the sanctioned scoped storage
    namespace (``hermes.ext.storage.<namespace>``), which is exactly where the
    extension now reads it from.
    """
    settings = {"enabled": enabled, "size": size, "mobile": mobile}
    storage = {"image": AVATAR_PNG} if image else {}
    payload = json.dumps(
        {
            "settings": settings,
            "storage": storage,
            "theme": theme,
            "fontSize": font_size,
            "skin": skin,
            "extId": EXTENSION_ID,
        },
        separators=(",", ":"),
    )
    return f"""(() => {{
      if (window.top !== window) return;
      const seed = {payload};
      try {{
        localStorage.setItem('hermes-theme', seed.theme);
        localStorage.setItem('hermes-font-size', seed.fontSize);
        if (seed.skin) localStorage.setItem('hermes-skin', seed.skin);
        // Core namespaces scoped settings/storage by extension id.
        localStorage.setItem('hermes.ext.settings.' + seed.extId, JSON.stringify(seed.settings));
        localStorage.setItem('hermes.ext.storage.' + seed.extId, JSON.stringify(seed.storage));
        // Documented older-core fallbacks, so the seed holds either way.
        localStorage.setItem('hermes-ext-user-avatar-enabled', String(seed.settings.enabled));
        localStorage.setItem('hermes-ext-user-avatar-size', seed.settings.size);
        localStorage.setItem('hermes-ext-user-avatar-mobile', seed.settings.mobile);
      }} catch (_) {{}}
    }})();"""


def _new_page(browser: Any, viewport: dict[str, int], init_script: str) -> tuple[Any, ...]:
    context = browser.new_context(
        viewport=viewport,
        is_mobile=viewport == MOBILE_VIEWPORT,
        service_workers="block",
    )
    context.add_init_script(init_script)
    network_events = _install_network_guards(context)
    page = context.new_page()
    console_errors: list[dict[str, str]] = []
    page_errors: list[str] = []

    def on_console(message: Any) -> None:
        if message.type != "error":
            return
        location = getattr(message, "location", {}) or {}
        location_url = location.get("url", "") if isinstance(location, dict) else getattr(location, "url", "")
        console_errors.append({"text": str(message.text), "url": str(location_url)})

    page.on("console", on_console)
    page.on("pageerror", lambda error: page_errors.append(str(error)))
    return context, page, network_events, console_errors, page_errors


def _boot_page(page: Any, base_url: str) -> None:
    page.goto(f"{base_url}/", wait_until="domcontentloaded", timeout=30_000)
    try:
        page.wait_for_load_state("networkidle", timeout=8_000)
    except Exception:
        pass
    for resource in EXTENSION_RESOURCES:
        page.wait_for_function(
            "resource => performance.getEntriesByType('resource').some(entry => entry.name.includes(resource))",
            arg=resource,
            timeout=15_000,
        )
    page.locator(".messages-shell").wait_for(state="visible", timeout=15_000)
    page.wait_for_function(
        "version => window.HermesUserAvatarExtension"
        " && window.HermesUserAvatarExtension.version === version",
        arg=EXTENSION_VERSION,
        timeout=15_000,
    )


def _seed_transcript(page: Any, transcript: list[dict[str, Any]] | None = None) -> int:
    """Render a populated transcript through Core's own message pipeline.

    Seeding ``S.session``/``S.messages`` and calling Core's ``renderMessages()``
    produces the real transcript DOM — ``data-msg-idx`` rows, ``.msg-body``
    bubbles, ``.msg-foot`` and the ``.msg-actions`` hover controls — under Core's
    real stylesheet, rather than hand-built markup. Placement can only be judged
    against the genuine article.
    """
    count = page.evaluate(
        """args => {
          const messages = args.messages;
          if (typeof S === 'undefined' || typeof renderMessages !== 'function') return -1;
          S.session = {session_id: args.sid, title: 'Compatibility'};
          S.messages = messages.map((message, index) => Object.assign({}, message, {idx: index}));
          S.busy = false;
          renderMessages();
          return document.querySelectorAll('.msg-row[data-role="user"]').length;
        }""",
        {"messages": transcript if transcript is not None else TRANSCRIPT, "sid": COMPAT_SESSION_ID},
    )
    if count <= 0:
        raise CompatibilityFailure("Core's renderMessages did not produce user rows")
    # The extension marks newly created rows from a MutationObserver frame.
    page.wait_for_function(
        """selector => {
          const rows = document.querySelectorAll(selector);
          if (!rows.length) return false;
          if (!document.documentElement.hasAttribute('data-hwx-uav-on')) return true;
          return Array.from(rows).every(row => row.hasAttribute('data-hwx-uav'));
        }""",
        arg=ROW_SELECTOR,
        timeout=10_000,
    )
    return int(count)


def _apply_font_size(page: Any, size: str) -> str:
    """Apply an accessibility font size exactly as Core's own picker does."""
    return page.evaluate(
        """size => {
          if (size && size !== 'default') document.documentElement.dataset.fontSize = size;
          else delete document.documentElement.dataset.fontSize;
          return getComputedStyle(document.documentElement)
            .getPropertyValue('--message-body-font-size').trim();
        }""",
        size,
    )


def _measure(page: Any) -> dict[str, Any]:
    """Measure the real painted geometry of the decoration."""
    return page.evaluate(
        """selector => {
          const row = document.querySelector(selector);
          if (!row) return {found: false};
          const before = getComputedStyle(row, '::before');
          const body = row.querySelector('.msg-body');
          const rowBox = row.getBoundingClientRect();
          const bodyBox = body ? body.getBoundingClientRect() : null;
          const shell = document.querySelector('.messages-inner');
          const shellBox = shell ? shell.getBoundingClientRect() : null;
          return {
            found: true,
            marked: row.hasAttribute('data-hwx-uav'),
            rootFlag: document.documentElement.hasAttribute('data-hwx-uav-on'),
            beforeContent: before.content,
            beforeDisplay: before.display,
            beforeWidth: parseFloat(before.width) || 0,
            beforeHeight: parseFloat(before.height) || 0,
            beforeImage: before.backgroundImage,
            bodyMarginLeft: body ? parseFloat(getComputedStyle(body).marginLeft) || 0 : null,
            childClasses: Array.from(row.children).map(el => el.className),
            injectedDescendants: row.querySelectorAll('[data-hwx-uav], [class*="hwx-uav"]').length,
            hasHoverActions: !!row.querySelector('.msg-actions'),
            rowRight: Math.round(rowBox.right),
            bodyRight: bodyBox ? Math.round(bodyBox.right) : null,
            shellRight: shellBox ? Math.round(shellBox.right) : null,
            alignSelf: getComputedStyle(row).alignSelf,
          };
        }""",
        ROW_SELECTOR,
    )


def _assert_geometry(measured: dict[str, Any], *, label: str, expected_px: int,
                     expected_gap: int, image: bool, visible: bool = True) -> None:
    if not measured.get("found"):
        raise CompatibilityFailure(f"{label}: no user row found")
    if measured.get("injectedDescendants"):
        raise CompatibilityFailure(
            f"{label}: the extension injected {measured.get('injectedDescendants')} node(s) into a user row; "
            "decoration must stay attribute + pseudo-element only "
            f"(children: {measured.get('childClasses')})"
        )
    if not visible:
        if measured.get("beforeDisplay") != "none":
            raise CompatibilityFailure(f"{label}: the avatar must be hidden, got display={measured.get('beforeDisplay')}")
        if measured.get("bodyMarginLeft"):
            raise CompatibilityFailure(
                f"{label}: the reserved gutter must collapse when hidden, got {measured.get('bodyMarginLeft')}px"
            )
        return
    if round(measured.get("beforeWidth", 0)) != expected_px or round(measured.get("beforeHeight", 0)) != expected_px:
        raise CompatibilityFailure(
            f"{label}: avatar box measured "
            f"{measured.get('beforeWidth')}x{measured.get('beforeHeight')}, expected {expected_px}px square"
        )
    if round(measured.get("bodyMarginLeft") or 0) != expected_px + expected_gap:
        raise CompatibilityFailure(
            f"{label}: reserved gutter measured {measured.get('bodyMarginLeft')}px, "
            f"expected {expected_px + expected_gap}px"
        )
    has_image = "data:image" in str(measured.get("beforeImage", ""))
    if image and not has_image:
        raise CompatibilityFailure(f"{label}: the stored image is not painted (background-image={measured.get('beforeImage')})")
    if not image and has_image:
        raise CompatibilityFailure(f"{label}: an image is painted when none is stored")


def _shot(page: Any, path: Path) -> dict[str, Any]:
    path.parent.mkdir(parents=True, exist_ok=True)
    page.screenshot(path=str(path), full_page=False)
    return {"path": path.name, **_png_dimensions(path), "sha256": _digest(path)}


def _parity_shot(page: Any, path: Path) -> dict[str, Any]:
    """Capture just the transcript for the pixel-parity comparison.

    The extension only ever touches ``.messages-shell``. Chromium's own
    text antialiasing in unrelated chrome (the conversation filter box) varies
    by a single channel step between independent boots, so a whole-viewport
    byte comparison would be measuring browser noise rather than this
    extension. The transcript region is bit-exact run to run, which is both the
    deterministic comparison and the one that carries the claim.
    """
    path.parent.mkdir(parents=True, exist_ok=True)
    page.locator(".messages-shell").screenshot(path=str(path))
    return {"path": path.name, **_png_dimensions(path), "sha256": _digest(path)}


def _open_configure(page: Any) -> Any:
    button = page.locator(CONFIGURE_SELECTOR)
    if not (button.count() and button.is_visible()):
        settings_button = page.locator('button[data-panel="settings"]').first
        if not settings_button.is_visible():
            menu = page.locator("#btnHamburger")
            menu.wait_for(state="visible", timeout=5_000)
            menu.click()
            page.locator(".sidebar.mobile-open").wait_for(state="visible", timeout=5_000)
            settings_button = page.locator('.sidebar.mobile-open button[data-panel="settings"]').first
        settings_button.click()
        page.locator("#panelSettings").wait_for(state="visible", timeout=10_000)
        page.locator('#settingsMenu button[data-settings-section="extensions"]').click()
        page.locator("#settingsPaneExtensions").wait_for(state="visible", timeout=10_000)
        page.locator('button[data-extensions-tab="installed"]').click()
        page.locator("#extensionsInstalled .extension-installed-list").wait_for(state="visible", timeout=10_000)
        button.wait_for(state="visible", timeout=15_000)
    button.click()
    page.locator(CARD_SELECTOR).wait_for(state="visible", timeout=10_000)
    return button


def _assert_core_pending(page: Any, *, expected: bool, label: str) -> None:
    try:
        page.wait_for_function(
            """args => {
              const state = window.HermesExtensionSettings
                && window.HermesExtensionSettings._configureStateForExtension(args.id);
              return !!state && state.pending === args.expected;
            }""",
            arg={"id": EXTENSION_ID, "expected": expected},
            timeout=10_000,
        )
    except Exception as exc:
        raise CompatibilityFailure(
            f"{label}: Core Configure pending state never became {expected} "
            "— the handler did not own its settlement"
        ) from exc


def _exercise_configure(page: Any, evidence_dir: Path, prefix: str,
                        reject_file: Path) -> dict[str, Any]:
    """Drive the Configure modal through Core, including the keyboard and error states."""
    results: dict[str, Any] = {}

    # 1. Open: Core goes pending, the modal has dialog semantics, first control focused.
    _open_configure(page)
    _assert_core_pending(page, expected=True, label="configure-open")
    semantics = page.evaluate(
        """selector => {
          const card = document.querySelector(selector);
          if (!card) return null;
          const controls = Array.from(card.querySelectorAll('button, select, input:not([type=\\"file\\"])'));
          return {
            role: card.getAttribute('role'),
            ariaModal: card.getAttribute('aria-modal'),
            ariaLabel: card.getAttribute('aria-label'),
            controlCount: controls.length,
            focusedIndex: controls.indexOf(document.activeElement),
            fileInputInTrap: controls.some(el => el.type === 'file'),
          };
        }""",
        CARD_SELECTOR,
    )
    if not semantics or semantics.get("role") != "dialog" or semantics.get("ariaModal") != "true":
        raise CompatibilityFailure(f"Configure modal lacks dialog semantics: {semantics}")
    if semantics.get("focusedIndex") != 0:
        raise CompatibilityFailure(
            f"Configure did not focus its first control (index={semantics.get('focusedIndex')})"
        )
    if semantics.get("fileInputInTrap"):
        raise CompatibilityFailure("the hidden file picker must be excluded from the focus trap")
    results["semantics"] = semantics
    results["open_screenshot"] = _shot(page, evidence_dir / f"{prefix}.png")

    # 2. Keyboard: Tab from the last control wraps back to the first (trap holds).
    focused_last = page.evaluate(
        """selector => {
          const card = document.querySelector(selector);
          const controls = Array.from(card.querySelectorAll('button, select, input:not([type=\\"file\\"])'));
          const last = controls[controls.length - 1];
          last.focus();
          return controls.indexOf(document.activeElement);
        }""",
        CARD_SELECTOR,
    )
    page.keyboard.press("Tab")
    wrapped = page.evaluate(
        """selector => {
          const card = document.querySelector(selector);
          const controls = Array.from(card.querySelectorAll('button, select, input:not([type=\\"file\\"])'));
          return controls.indexOf(document.activeElement);
        }""",
        CARD_SELECTOR,
    )
    if wrapped != 0:
        raise CompatibilityFailure(
            f"Tab from the last control ({focused_last}) did not wrap to the first (got {wrapped})"
        )
    page.keyboard.press("Shift+Tab")
    results["keyboard"] = {"lastIndex": focused_last, "afterTab": wrapped}
    results["keyboard_screenshot"] = _shot(page, evidence_dir / f"{prefix}-keyboard.png")
    _assert_core_pending(page, expected=True, label="configure-keyboard")

    # 3. Error path: a rejected upload reports the real reason and stores nothing.
    before = page.evaluate("() => window.HermesUserAvatarExtension.getImage()")
    page.locator(f"{CARD_SELECTOR} .hwx-uav-file").set_input_files(str(reject_file))
    page.wait_for_function(
        """selector => {
          const status = document.querySelector(selector + ' .hwx-uav-status');
          return !!status && /PNG, JPEG, or WebP/.test(status.textContent || '');
        }""",
        arg=CARD_SELECTOR,
        timeout=10_000,
    )
    after = page.evaluate("() => window.HermesUserAvatarExtension.getImage()")
    if after != before:
        raise CompatibilityFailure("a rejected upload changed the stored image")
    results["error_state"] = {
        "status": page.locator(f"{CARD_SELECTOR} .hwx-uav-status").inner_text(),
        "image_unchanged": True,
    }
    results["error_screenshot"] = _shot(page, evidence_dir / f"{prefix}-error.png")
    _assert_core_pending(page, expected=True, label="configure-error")

    # 4. Escape closes and settles exactly once.
    page.keyboard.press("Escape")
    page.locator(PANEL_SELECTOR).wait_for(state="detached", timeout=5_000)
    _assert_core_pending(page, expected=False, label="configure-escape")
    results["escape_closed"] = True

    # 5. Re-open, then close via the backdrop; Core settles again.
    _open_configure(page)
    _assert_core_pending(page, expected=True, label="configure-reopen")
    box = page.locator(PANEL_SELECTOR).bounding_box()
    # The overlay must paint above everything Core shows, including the fixed
    # full-viewport Settings drawer on phones: the topmost element at both the
    # backdrop click point and the card centre must belong to the modal.
    stacking = page.evaluate(
        """args => {
          const panel = document.querySelector(args.panel);
          const card = document.querySelector(args.card).getBoundingClientRect();
          const probe = (x, y) => { const el = document.elementFromPoint(x, y);
            return !!el && (el === panel || panel.contains(el)); };
          return {backdrop: probe(args.x, args.y),
                  card: probe(card.left + card.width / 2, card.top + card.height / 2)};
        }""",
        {"panel": PANEL_SELECTOR, "card": CARD_SELECTOR, "x": box["x"] + 6, "y": box["y"] + 6},
    )
    if not (stacking["backdrop"] and stacking["card"]):
        raise CompatibilityFailure(f"the Configure modal is painted beneath Core UI: {stacking}")
    results["stacking"] = stacking
    page.mouse.click(box["x"] + 6, box["y"] + 6)
    page.locator(PANEL_SELECTOR).wait_for(state="detached", timeout=5_000)
    _assert_core_pending(page, expected=False, label="configure-backdrop")
    results["backdrop_closed"] = True

    # 6. And once more via the X button.
    _open_configure(page)
    page.locator(f"{CARD_SELECTOR} .hwx-uav-x").click()
    page.locator(PANEL_SELECTOR).wait_for(state="detached", timeout=5_000)
    _assert_core_pending(page, expected=False, label="configure-x")
    results["x_closed"] = True

    # 7. Core renders the same scoped settings again as the inline form in this
    #    extension's row, and its Save writes every field from that form. A size
    #    chosen in Configure must survive a later inline Save, not be reverted by
    #    a stale form value.
    inline = f'[data-extension-id="{EXTENSION_ID}"] [data-extension-setting-input="size"]'
    read_size = (f"() => window.HermesExtensionSettings.settingsForExtension('{EXTENSION_ID}').get('size')")
    if not page.locator(inline).count():
        raise CompatibilityFailure("Core did not render this extension's inline settings form")
    start = page.evaluate(read_size)
    target = "large" if start != "large" else "small"
    _open_configure(page)
    page.locator(f"{CARD_SELECTOR} select").first.select_option(target)
    page.keyboard.press("Escape")
    page.locator(PANEL_SELECTOR).wait_for(state="detached", timeout=5_000)
    # Core renders one form copy per surface (Installed + Diagnostics); each has
    # its own Save, so every copy must now show the Configure choice.
    form_values = page.eval_on_selector_all(inline, "els => els.map(el => el.value)")
    page.locator(f'#extensionsInstalled [data-extension-settings-save="{EXTENSION_ID}"]').click()
    after_save = page.evaluate(read_size)
    if any(v != target for v in form_values) or after_save != target:
        raise CompatibilityFailure(
            f"inline Save reverted a Configure choice: picked {target!r}, inline forms "
            f"showed {form_values!r}, size after Save {after_save!r}"
        )
    results["inline_form_sync"] = {"picked": target, "forms": form_values, "after_save": after_save}
    return results


def _run_case(*, browser: Any, base_url: str, evidence_dir: Path, viewport: dict[str, int],
              name: str, enabled: bool, size: str, mobile: str, image: bool,
              theme: str = "dark", font_size: str = "default", skin: str = "",
              hover: bool = False, configure: Path | None = None) -> dict[str, Any]:
    init_script = _init_script(
        enabled=enabled, size=size, mobile=mobile, image=image,
        theme=theme, font_size=font_size, skin=skin,
    )
    context, page, network_events, console_errors, page_errors = _new_page(browser, viewport, init_script)
    case: dict[str, Any] = {"viewport": dict(viewport), "settings": {
        "enabled": enabled, "size": size, "mobile": mobile, "image": image,
        "theme": theme, "font_size": font_size, "skin": skin or "default",
    }}
    try:
        _boot_page(page, base_url)
        if font_size != "default":
            # Core's appearance load overwrites the seeded key, so apply the size
            # after boot through the same code path Core's picker uses.
            case["message_font_size"] = _apply_font_size(page, font_size)
            if not case["message_font_size"]:
                raise CompatibilityFailure(f"{name}: font size {font_size} did not take effect")
        case["user_rows"] = _seed_transcript(page)
        if hover:
            row = page.locator(ROW_SELECTOR).nth(2)
            row.hover()
            page.wait_for_function(
                """selector => {
                  const row = document.querySelectorAll(selector)[2];
                  const actions = row && row.querySelector('.msg-actions');
                  return !!actions && parseFloat(getComputedStyle(actions).opacity) > 0.9;
                }""",
                arg=ROW_SELECTOR,
                timeout=5_000,
            )
            case["hover_actions_visible"] = True
        measured = _measure(page)
        case["measured"] = measured
        narrow = viewport == MOBILE_VIEWPORT
        if not enabled:
            if measured.get("rootFlag"):
                raise CompatibilityFailure(f"{name}: the root flag is set while disabled")
            if measured.get("beforeContent") not in ("none", "normal", ""):
                raise CompatibilityFailure(f"{name}: a ::before box exists while disabled")
        elif narrow and mobile == "hide":
            _assert_geometry(measured, label=name, expected_px=0, expected_gap=0,
                             image=image, visible=False)
        elif narrow and mobile == "compact":
            _assert_geometry(measured, label=name, expected_px=MOBILE_COMPACT_PX,
                             expected_gap=MOBILE_COMPACT_GAP_PX, image=image)
        else:
            _assert_geometry(measured, label=name, expected_px=SIZE_PX[size],
                             expected_gap=GAP_PX[size], image=image)
        base_name = f"{name}-base" if configure is not None else name
        case["screenshot"] = _shot(page, evidence_dir / f"{base_name}.png")
        case["publish_screenshot"] = configure is None
        case["transcript"] = _parity_shot(page, evidence_dir / f"{name}-transcript.png")
        if configure is not None:
            case["configure"] = _exercise_configure(page, evidence_dir, name, configure)
        _assert_browser_health(
            case_name=f"user-avatar-{name}",
            console_errors=console_errors,
            page_errors=page_errors,
            extension_fragments=EXTENSION_RESOURCES,
            network_events=network_events,
        )
        case["status"] = "passed"
        case["unexpected_http"] = network_events.get("unexpected_http", [])
        case["unexpected_websockets"] = network_events.get("unexpected_websockets", [])
        return case
    except Exception:
        try:
            _shot(page, evidence_dir / f"{name}-failure.png")
        except Exception:
            pass
        raise
    finally:
        try:
            context.close()
        except Exception:
            pass
        _write_json(evidence_dir / f"{name}-network.json", network_events)


def _measure_collisions(page: Any) -> list[dict[str, Any]]:
    """Per user row: the painted avatar box and its overlap with every sibling
    Core renders in that row (attachment strip, bubble, edit textarea + bar)."""
    return page.evaluate(
        """selector => Array.from(document.querySelectorAll(selector)).map((row, i) => {
          const b = getComputedStyle(row, '::before');
          const rb = row.getBoundingClientRect();
          const l = rb.left + (parseFloat(b.left) || 0), t = rb.top + (parseFloat(b.top) || 0);
          const w = parseFloat(b.width) || 0, h = parseFloat(b.height) || 0;
          const av = {l, t, r: l + w, b: t + h};
          const hit = (el) => {
            if (!el) return null;
            const e = el.getBoundingClientRect();
            const x = Math.max(0, Math.min(av.r, e.right) - Math.max(av.l, e.left));
            const y = Math.max(0, Math.min(av.b, e.bottom) - Math.max(av.t, e.top));
            return {overlap: Math.round(x * y), left: Math.round(e.left), top: Math.round(e.top)};
          };
          return {
            i, editing: row.dataset.editing || null, display: b.display,
            avatar: {left: Math.round(l), top: Math.round(t), right: Math.round(av.r), size: w},
            files: hit(row.querySelector('.msg-files')),
            firstThumb: hit(row.querySelector('.msg-files > *')),
            body: hit(row.querySelector('.msg-body')),
            editArea: hit(row.querySelector('.msg-edit-area')),
            editBar: hit(row.querySelector('.msg-edit-bar')),
          };
        })""",
        ROW_SELECTOR,
    )


def _assert_no_collisions(rows: list[dict[str, Any]], *, label: str) -> None:
    for row in rows:
        if row["display"] == "none":
            continue
        for part in ("files", "firstThumb", "body", "editArea", "editBar"):
            box = row.get(part)
            if box and box["overlap"]:
                raise CompatibilityFailure(
                    f"{label}: the avatar on user row {row['i']} overlaps its {part} "
                    f"by {box['overlap']}px² (avatar {row['avatar']}, {part} {box})"
                )


def _attachment_png(seed: int, width: int = 240, height: int = 180) -> bytes:
    """A small, visibly distinct 'screenshot' PNG (stdlib only) for attachment thumbnails."""
    import zlib
    rows = []
    for y in range(height):
        row = bytearray([0])
        for x in range(width):
            bar = y < 22                                  # a title bar strip
            r = 40 + (x * 90 // width) + seed * 40
            g = 60 + (y * 80 // height)
            b = 120 + seed * 35
            if bar:
                r, g, b = 28, 30, 44
            elif (y - 40) % 26 < 10 and 16 < x < width - 16 - seed * 30:
                r, g, b = r + 60, g + 60, b + 60           # 'text' lines
            row += bytes((min(r, 255), min(g, 255), min(b, 255)))
        rows.append(bytes(row))
    def chunk(kind: bytes, data: bytes) -> bytes:
        return (struct.pack(">I", len(data)) + kind + data
                + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF))
    return (b"\x89PNG\r\n\x1a\n"
            + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(b"".join(rows), 9))
            + chunk(b"IEND", b""))


def _run_layout_case(*, browser: Any, base_url: str, evidence_dir: Path,
                     viewport: dict[str, int], name: str, mobile: str) -> dict[str, Any]:
    """Attachment strip + edit mode, the two row shapes the main matrix never renders."""
    init_script = _init_script(enabled=True, size="medium", mobile=mobile, image=True,
                               theme="dark", font_size="default", skin="")
    context, page, network_events, console_errors, page_errors = _new_page(browser, viewport, init_script)
    case: dict[str, Any] = {"viewport": dict(viewport), "settings": {"mobile": mobile}}
    try:
        _boot_page(page, base_url)
        # Core renders attachments as `api/file/raw?session_id=…&path=…`, which only
        # resolves for a persisted session. The synthetic compatibility session has
        # none, so answer exactly those requests with a real PNG; the thumbnails then
        # decode and lay out at their true size.
        pngs = {name: _attachment_png(i) for i, name in enumerate(ATTACHMENT_FILES)}
        base = urllib.parse.urlsplit(base_url)
        served: list[str] = []

        def _is_attachment(url: str) -> bool:
            # Exact match only: same origin as the Core under test, Core's own
            # /api/file/raw route, the seeded session, and one of our filenames.
            # Anything else falls through to the server and the network guard.
            u = urllib.parse.urlsplit(url)
            if (u.scheme, u.netloc) != (base.scheme, base.netloc) or u.path != "/api/file/raw":
                return False
            q = urllib.parse.parse_qs(u.query, keep_blank_values=True)
            return (q.get("session_id") == [COMPAT_SESSION_ID]
                    and len(q.get("path", [])) == 1 and q["path"][0] in pngs)

        def _fulfill(route: Any) -> None:
            name = urllib.parse.parse_qs(urllib.parse.urlsplit(route.request.url).query)["path"][0]
            served.append(name)
            route.fulfill(status=200, content_type="image/png", body=pngs[name])

        page.route(_is_attachment, _fulfill)
        case["user_rows"] = _seed_transcript(page, ATTACHMENT_TRANSCRIPT)
        page.wait_for_function(
            """() => { const t = document.querySelectorAll('.msg-files img');
                       return t.length >= 3 && Array.from(t).every(img => img.complete && img.naturalWidth > 0); }""",
            timeout=10_000,
        )
        if sorted(served) != sorted(ATTACHMENT_FILES):
            raise CompatibilityFailure(
                f"{name}: Core did not request each attachment exactly once through "
                f"/api/file/raw for the seeded session (served {served!r})"
            )
        case["attachment_requests"] = sorted(served)
        # Frame the attachment turn (Core scrolls a fresh transcript to the bottom).
        page.evaluate(
            """selector => { const row = document.querySelector(selector);
                             row.scrollIntoView({block: 'start'}); window.scrollBy(0, -8); }""",
            ROW_SELECTOR,
        )
        page.wait_for_timeout(150)
        plain = _measure_collisions(page)
        if not (plain[0].get("files") and plain[0]["display"] != "none"):
            raise CompatibilityFailure(f"{name}: the attachment row did not render a decorated strip")
        _assert_no_collisions(plain, label=f"{name}-attachments")
        # The strip must start at the same reserved gutter as the bubble below it.
        if plain[0]["files"]["left"] != plain[0]["body"]["left"]:
            raise CompatibilityFailure(
                f"{name}: attachment strip starts at x={plain[0]['files']['left']} but its "
                f"bubble at x={plain[0]['body']['left']}; both must share the reserved gutter"
            )
        case["attachments"] = plain
        case["attachments_screenshot"] = _shot(page, evidence_dir / f"{name}-attachments.png")

        # Enter edit mode on the plain follow-up through Core's own editMessage().
        page.evaluate(
            """selector => { const row = document.querySelectorAll(selector)[1];
                             editMessage(row.querySelector('.msg-body')); }""",
            ROW_SELECTOR,
        )
        page.wait_for_selector(f"{ROW_SELECTOR}[data-editing='1'] .msg-edit-area", timeout=5_000)
        editing = _measure_collisions(page)
        edited = editing[1]
        if edited["editing"] != "1" or edited["display"] != "none":
            raise CompatibilityFailure(
                f"{name}: the avatar must be hidden while its row is being edited "
                f"(editing={edited['editing']}, display={edited['display']})"
            )
        if editing[0]["display"] == "none":
            raise CompatibilityFailure(f"{name}: editing one row hid the avatar on another")
        _assert_no_collisions(editing, label=f"{name}-edit")
        case["edit"] = editing
        case["edit_screenshot"] = _shot(page, evidence_dir / f"{name}-edit.png")

        # Cancelling restores the decoration.
        page.locator(f"{ROW_SELECTOR}[data-editing='1'] .msg-edit-cancel").click()
        page.wait_for_function(
            "selector => !document.querySelector(selector + '[data-editing]')",
            arg=ROW_SELECTOR, timeout=5_000,
        )
        restored = _measure_collisions(page)
        if restored[1]["display"] == "none":
            raise CompatibilityFailure(f"{name}: the avatar did not return after cancelling the edit")
        _assert_no_collisions(restored, label=f"{name}-after-cancel")
        _assert_browser_health(
            case_name=f"user-avatar-{name}",
            console_errors=console_errors,
            page_errors=page_errors,
            extension_fragments=EXTENSION_RESOURCES,
            network_events=network_events,
        )
        case["status"] = "passed"
        return case
    except Exception:
        try:
            _shot(page, evidence_dir / f"{name}-failure.png")
        except Exception:
            pass
        raise
    finally:
        try:
            context.close()
        except Exception:
            pass
        _write_json(evidence_dir / f"{name}-network.json", network_events)


def _assert_pixel_parity(evidence_dir: Path, disabled: str, stock: str) -> dict[str, Any]:
    """Disabled must be byte-identical to a page where the extension never decorates."""
    a = evidence_dir / f"{disabled}-transcript.png"
    b = evidence_dir / f"{stock}-transcript.png"
    da, db = _digest(a), _digest(b)
    if da != db:
        raise CompatibilityFailure(
            f"disabled pixel parity failed: the transcript with the extension loaded but off "
            f"({a.name} {da[:12]}) is not identical to the undecorated transcript "
            f"({b.name} {db[:12]})"
        )
    return {
        "disabled": a.name,
        "stock": b.name,
        "sha256": da,
        "identical": True,
        "region": ".messages-shell",
    }


def main() -> int:
    args = _parse_args()
    evidence_dir = Path(args.evidence_dir).expanduser().resolve()
    evidence_dir.mkdir(parents=True, exist_ok=True)
    results: dict[str, Any] = {"status": "running", "track": "user-avatar-visual", "cases": {}}
    results_path = evidence_dir / "user-avatar-results.json"
    proc = None
    log_file = None
    try:
        core_dir = Path(args.core_dir).expanduser().resolve()
        extension_root = Path(args.extension_root).expanduser().resolve()
        if not core_dir.is_dir():
            raise SetupFailure("HERMES_CORE_DIR/--core-dir must point to an independent Hermes WebUI checkout")
        source_dir = extension_root / EXTENSION_ID
        if not source_dir.is_dir():
            raise SetupFailure(f"Custom User Avatar extension directory not found: {source_dir}")
        try:
            from playwright.sync_api import sync_playwright
        except ImportError as exc:
            raise SetupFailure("Playwright is required; install tests/compatibility/requirements.txt") from exc

        with tempfile.TemporaryDirectory(prefix="hermes-user-avatar-compat-") as temp:
            temp_root = Path(temp)
            bundle_root = temp_root / "user-avatar-bundle"
            shutil.copytree(source_dir, bundle_root / EXTENSION_ID)
            reject_file = temp_root / "not-an-avatar.gif"
            reject_file.write_bytes(b"GIF89a\x01\x00\x01\x00\x00\xff\x00,\x00\x00\x00\x00\x01\x00\x01\x00\x00\x02\x00;")
            state_root = temp_root / "state"
            proc, log_file, base_url, port = _start_server(
                core_dir=core_dir,
                extension_root=bundle_root,
                manifest_relative=f"{EXTENSION_ID}/manifest.json",
                state_root=state_root,
                log_path=temp_root / "user-avatar-server.log",
                requested_port=args.port,
            )
            try:
                with sync_playwright() as playwright:
                    browser = playwright.chromium.launch(
                        headless=True,
                        args=["--no-sandbox", "--disable-dev-shm-usage"],
                    )
                    try:
                        matrix = [
                            # Disabled parity: extension loaded but off, and the
                            # same page with no stored image at all.
                            dict(name="desktop-disabled", viewport=DESKTOP_VIEWPORT,
                                 enabled=False, size="medium", mobile="hide", image=True),
                            dict(name="desktop-stock", viewport=DESKTOP_VIEWPORT,
                                 enabled=False, size="medium", mobile="hide", image=False),
                            # Sizes.
                            dict(name="desktop-small", viewport=DESKTOP_VIEWPORT,
                                 enabled=True, size="small", mobile="hide", image=True),
                            dict(name="desktop-medium", viewport=DESKTOP_VIEWPORT,
                                 enabled=True, size="medium", mobile="hide", image=True),
                            dict(name="desktop-large", viewport=DESKTOP_VIEWPORT,
                                 enabled=True, size="large", mobile="hide", image=True),
                            # Enabled with no image yet -> neutral placeholder.
                            dict(name="desktop-placeholder", viewport=DESKTOP_VIEWPORT,
                                 enabled=True, size="medium", mobile="hide", image=False),
                            # Light theme and an accessibility font size.
                            dict(name="desktop-light", viewport=DESKTOP_VIEWPORT,
                                 enabled=True, size="medium", mobile="hide", image=True,
                                 theme="light"),
                            dict(name="desktop-large-font", viewport=DESKTOP_VIEWPORT,
                                 enabled=True, size="medium", mobile="hide", image=True,
                                 font_size="large"),
                            # Hover actions over a decorated row.
                            dict(name="desktop-hover", viewport=DESKTOP_VIEWPORT,
                                 enabled=True, size="medium", mobile="hide", image=True,
                                 hover=True),
                            # Configure focus / keyboard / error states.
                            dict(name="desktop-configure", viewport=DESKTOP_VIEWPORT,
                                 enabled=True, size="medium", mobile="hide", image=True,
                                 configure=reject_file),
                            # Mobile.
                            dict(name="mobile-disabled", viewport=MOBILE_VIEWPORT,
                                 enabled=False, size="medium", mobile="hide", image=True),
                            dict(name="mobile-stock", viewport=MOBILE_VIEWPORT,
                                 enabled=False, size="medium", mobile="hide", image=False),
                            dict(name="mobile-hide", viewport=MOBILE_VIEWPORT,
                                 enabled=True, size="medium", mobile="hide", image=True),
                            dict(name="mobile-compact", viewport=MOBILE_VIEWPORT,
                                 enabled=True, size="medium", mobile="compact", image=True),
                            dict(name="mobile-compact-light", viewport=MOBILE_VIEWPORT,
                                 enabled=True, size="medium", mobile="compact", image=True,
                                 theme="light"),
                            dict(name="mobile-configure", viewport=MOBILE_VIEWPORT,
                                 enabled=True, size="medium", mobile="compact", image=True,
                                 configure=reject_file),
                        ]
                        for spec in matrix:
                            name = spec.pop("name")
                            results["cases"][name] = _run_case(
                                browser=browser, base_url=base_url,
                                evidence_dir=evidence_dir, name=name, **spec,
                            )
                        for name, viewport, mobile in (
                            ("desktop-layout", DESKTOP_VIEWPORT, "hide"),
                            ("mobile-layout", MOBILE_VIEWPORT, "compact"),
                        ):
                            results["cases"][name] = _run_layout_case(
                                browser=browser, base_url=base_url, evidence_dir=evidence_dir,
                                viewport=viewport, name=name, mobile=mobile,
                            )
                        results["pixel_parity"] = {
                            "desktop": _assert_pixel_parity(evidence_dir, "desktop-disabled", "desktop-stock"),
                            "mobile": _assert_pixel_parity(evidence_dir, "mobile-disabled", "mobile-stock"),
                        }
                    finally:
                        browser.close()
            finally:
                _terminate(proc, log_file)
                proc = None
                log_file = None
                if (temp_root / "user-avatar-server.log").is_file():
                    shutil.copyfile(temp_root / "user-avatar-server.log",
                                    evidence_dir / "user-avatar-server.log")
            results["port"] = port

        if args.screenshot_dir:
            target = Path(args.screenshot_dir).expanduser().resolve()
            target.mkdir(parents=True, exist_ok=True)
            copied = []
            for case_name, case in results["cases"].items():
                if case_name.endswith("-stock"):
                    continue
                shot = case.get("screenshot")
                if shot and case.get("publish_screenshot"):
                    shutil.copyfile(evidence_dir / shot["path"], target / shot["path"])
                    copied.append(shot["path"])
                for key in ("open_screenshot", "keyboard_screenshot", "error_screenshot"):
                    extra = (case.get("configure") or {}).get(key)
                    if extra:
                        shutil.copyfile(evidence_dir / extra["path"], target / extra["path"])
                        copied.append(extra["path"])
                for key in ("attachments_screenshot", "edit_screenshot"):
                    extra = case.get(key)
                    if extra:
                        shutil.copyfile(evidence_dir / extra["path"], target / extra["path"])
                        copied.append(extra["path"])
            results["published_screenshots"] = sorted(copied)

        results["status"] = "passed"
        _write_json(results_path, results)
        print("USER AVATAR VISUAL COMPATIBILITY PASSED")
        print(f"cases={len(results['cases'])} evidence={evidence_dir}")
        return 0
    except SetupFailure as exc:
        results["status"] = "setup_failure"
        results["error"] = str(exc)
        _write_json(results_path, results)
        print(f"SETUP FAILURE: {exc}", file=sys.stderr)
        return 2
    except CompatibilityFailure as exc:
        results["status"] = "failed"
        results["error"] = str(exc)
        results["traceback"] = traceback.format_exc()
        _write_json(results_path, results)
        print(f"USER AVATAR VISUAL COMPATIBILITY FAILED: {exc}", file=sys.stderr)
        print(f"evidence={evidence_dir}", file=sys.stderr)
        return 1
    except Exception as exc:
        results["status"] = "harness_error"
        results["error"] = f"{type(exc).__name__}: {exc}"
        results["traceback"] = traceback.format_exc()
        _write_json(results_path, results)
        print(f"HARNESS ERROR: {type(exc).__name__}: {exc}", file=sys.stderr)
        print(f"evidence={evidence_dir}", file=sys.stderr)
        return 2
    finally:
        _terminate(proc, log_file)


if __name__ == "__main__":
    sys.exit(main())
