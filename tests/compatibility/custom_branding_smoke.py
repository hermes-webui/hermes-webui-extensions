#!/usr/bin/env python3
"""Packaged Custom Branding through real Settings on shipped and proposed v1 cores.

Uses disposable state, real HTTP/auth/ETags and Chromium/Firefox. External
requests are blocked; no chat is sent. Screenshots prove page/viewport behavior,
not physical phones, installed PWA launcher refresh or OS notifications.
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import io
import json
import subprocess
import sys
import tempfile
from contextlib import contextmanager
from pathlib import Path

import browser_smoke as harness
from PIL import Image
from playwright.sync_api import sync_playwright

PASSWORD = "disposable-browser-test"


def configure(page):
    page.wait_for_function("()=>!!window.HermesCustomBrandingExtension")
    page.locator('button[data-panel="settings"]').first.click()
    page.locator('#settingsMenu button[data-settings-section="extensions"]').click()
    page.locator('button[data-extensions-tab="installed"]').click()
    trigger = page.locator(
        '#extensionsInstalled [data-extension-configure-id="custom-branding"]'
    )
    trigger.click()
    page.locator(".hwx-branding-picker").wait_for()
    return trigger


def visible_bounds(page):
    assert page.locator(".hwx-branding-picker").evaluate("""e => {
      const r=e.getBoundingClientRect();
      return r.left>=0 && r.top>=0 && r.right<=innerWidth && r.bottom<=innerHeight;
    }""")


def shot(page, evidence, label, width):
    page.set_viewport_size({"width": width, "height": 900 if width == 1440 else 664})
    page.evaluate("new Promise(resolve=>requestAnimationFrame(resolve))")
    if "-before-" not in label:
        visible_bounds(page)
    page.screenshot(path=str(evidence / f"{label}-{width}.png"), animations="disabled")


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--core-dir", required=True, type=Path)
    p.add_argument("--legacy-core-dir", required=True, type=Path)
    p.add_argument("--artifact", required=True, type=Path)
    p.add_argument("--before-artifact", type=Path)
    p.add_argument("--evidence-dir", required=True, type=Path)
    args = p.parse_args()
    evidence = args.evidence_dir.resolve()
    evidence.mkdir(parents=True, exist_ok=True)
    stream = io.BytesIO()
    Image.new("RGBA", (512, 512), (34, 120, 190, 255)).save(stream, "PNG")
    image = stream.getvalue()
    results = {
        "status": "failed",
        "engines": [],
        "checks": [],
        "cache": "Fresh contexts, service workers blocked, browser HTTP cache disabled by request routing",
        "artifact_sha256": hashlib.sha256(args.artifact.read_bytes()).hexdigest(),
        "core_sha": subprocess.check_output(
            ["git", "rev-parse", "HEAD"], cwd=args.core_dir, text=True
        ).strip(),
        "legacy_core_sha": subprocess.check_output(
            ["git", "rev-parse", "HEAD"], cwd=args.legacy_core_dir, text=True
        ).strip(),
    }
    original = harness._sanitized_environment

    @contextmanager
    def server(core, artifact, state, label, authenticated=True):
        def environment(**kwargs):
            env = original(**kwargs)
            if authenticated:
                env["HERMES_WEBUI_PASSWORD"] = PASSWORD
            env.pop("HERMES_WEBUI_EXTENSION_MANIFEST", None)
            # The real installer checks hash, extracts and tracks the generated zip.
            installer = """import hashlib,sys
from pathlib import Path
from api import extensions
payload=Path(sys.argv[1]).read_bytes()
extensions._safe_download=lambda *_args:payload
extensions.install_extension('custom-branding','https://hermes-webui.github.io/hermes-webui-extensions/artifacts/test.zip',hashlib.sha256(payload).hexdigest())
"""
            result = subprocess.run(
                [sys.executable, "-c", installer, str(artifact.resolve())],
                cwd=core,
                env=env,
                capture_output=True,
                check=False,
                text=True,
            )
            if result.returncode:
                raise RuntimeError(result.stderr)
            # Keep screenshots comparable and suppress unrelated setup prompts.
            settings = Path(env["HERMES_WEBUI_STATE_DIR"]) / "settings.json"
            value = json.loads(settings.read_text()) if settings.exists() else {}
            value.update(language="en", theme="dark")
            settings.write_text(json.dumps(value))
            return env

        (state / "extension-root").mkdir(parents=True, exist_ok=True)
        harness._sanitized_environment = environment
        proc = log = None
        try:
            proc, log, url, _ = harness._start_server(
                core_dir=core.resolve(),
                extension_root=state / "extension-root",
                manifest_relative="manifest.json",
                state_root=state,
                log_path=evidence / (label + ".log"),
                requested_port=0,
            )
            yield url
        finally:
            harness._terminate(proc, log)
            harness._sanitized_environment = original

    def context(browser, url, auth=True):
        c = browser.new_context(
            service_workers="block",
            locale="en-US",
            viewport={"width": 1440, "height": 900},
        )
        harness._install_network_guards(c)
        c.add_init_script(
            "localStorage.setItem('hermes-lang','en'); localStorage.setItem('hermes-theme','dark');"
        )
        if auth:
            assert c.request.post(
                url + "/api/auth/login", data={"password": PASSWORD}
            ).ok
        return c

    def api(c, url, patch=None):
        get = c.request.get(url + "/api/instance-branding")
        assert get.ok
        if patch is None:
            return get.json()
        r = c.request.post(
            url + "/api/instance-branding",
            headers={"If-Match": get.headers["etag"]},
            data=patch,
        )
        assert r.ok, (r.status, r.text())
        return r.json()

    try:
        with (
            tempfile.TemporaryDirectory(prefix="branding-review-") as temporary,
            sync_playwright() as pw,
        ):
            root = Path(temporary)
            for engine in ("chromium", "firefox"):
                browser = getattr(pw, engine).launch()
                results["engines"].append({"name": engine, "version": browser.version})
                try:
                    # Before/after use identical core, theme, language, image and viewports.
                    artifacts = [("after", args.artifact)]
                    if args.before_artifact and engine == "chromium":
                        artifacts.insert(0, ("before", args.before_artifact))
                    for label, artifact in artifacts:
                        with server(
                            args.legacy_core_dir,
                            artifact,
                            root / f"{engine}-{label}-legacy",
                            f"{engine}-{label}-legacy",
                        ) as url:
                            c = context(browser, url)
                            c.add_init_script(
                                "localStorage.setItem('hermes-ext-custom-branding-logo', "
                                + json.dumps(
                                    "data:image/png;base64,"
                                    + base64.b64encode(image).decode()
                                )
                                + ");"
                            )
                            page = c.new_page()
                            requests = []
                            page.on(
                                "request",
                                lambda r, events=requests: events.append(r.url),
                            )
                            page.goto(url, wait_until="domcontentloaded")
                            page.wait_for_function(
                                "()=>!!window.HermesCustomBrandingExtension"
                            )
                            if label == "after":
                                assert not any(
                                    "/api/instance-branding" in u for u in requests
                                )
                            configure(page)
                            if label == "after":
                                page.get_by_role(
                                    "button", name="Upload…", exact=True
                                ).first.wait_for()
                                assert (
                                    page.locator(
                                        ".hwx-branding-picker input[type=text]"
                                    ).count()
                                    == 0
                                )
                                assert (
                                    "Shared"
                                    not in page.locator(
                                        ".hwx-branding-picker"
                                    ).inner_text()
                                )
                                page.locator(
                                    ".hwx-branding-picker input[type=file]"
                                ).first.set_input_files(
                                    {
                                        "name": "personal.png",
                                        "mimeType": "image/png",
                                        "buffer": image,
                                    }
                                )
                                page.locator(
                                    ".hwx-branding-preview-logo img"
                                ).wait_for()
                                assert page.locator("details").count() == 0
                                assert page.locator(
                                    ".hwx-branding-preview-logo img"
                                ).is_visible()
                            for width in (1440, 390):
                                page.locator('.hwx-branding-picker').get_by_role(
                                    "button", name="Close", exact=True
                                ).click()
                                page.set_viewport_size(
                                    {
                                        "width": width,
                                        "height": 900 if width == 1440 else 664,
                                    }
                                )
                                with page.expect_response(
                                    lambda r: "/api/instance-branding" in r.url
                                ):
                                    page.locator(
                                        '[data-extension-configure-id="custom-branding"]'
                                    ).click()
                                shot(page, evidence, f"{engine}-{label}-legacy", width)
                            if label == "after":
                                trigger = page.locator(
                                    '[data-extension-configure-id="custom-branding"]'
                                )
                                page.keyboard.press("Escape")
                                assert page.locator(".hwx-branding-picker").count() == 0
                                assert page.locator("#extensionsInstalled").is_visible()
                                assert trigger.evaluate("e=>e===document.activeElement")
                                results["checks"].append(
                                    engine
                                    + ": shipped core real Configure, personal upload preview, no load probe, Escape/focus"
                                )
                            c.close()
                    # Real proposed API, manager, two HTTP mutations in one Save.
                    state_root = root / (engine + "-v1")
                    with server(
                        args.core_dir, args.artifact, state_root, engine + "-v1"
                    ) as url:
                        c = context(browser, url)
                        page = c.new_page()
                        page.goto(url, wait_until="domcontentloaded")
                        configure(page)
                        initial_manifest = c.request.get(url + "/manifest.json").json()
                        page.locator("#hwxSharedName").fill("Team Console")
                        page.get_by_label("Remove this name").check()
                        page.locator("[data-shared-image]").set_input_files(
                            {
                                "name": "instance.png",
                                "mimeType": "image/png",
                                "buffer": image,
                            }
                        )
                        page.locator("[data-shared-enabled]").check()
                        page.once("dialog", lambda dialog: dialog.accept())
                        with page.expect_navigation(wait_until="domcontentloaded"):
                            page.get_by_role("button", name="Save", exact=True).click()
                        assert api(c, url)["effective"]["active"]
                        # A fresh context proves actual initial shared identity, not DOM-only replacement.
                        fresh = context(browser, url)
                        check = fresh.new_page()
                        check.goto(url, wait_until="domcontentloaded")
                        assert (
                            check.evaluate(
                                "window.__HERMES_INSTANCE_BRANDING__.effective.name"
                            )
                            == "Team Console"
                        )
                        assert "/branding/" in check.locator(
                            ".empty-logo img"
                        ).get_attribute("src")
                        manifest = fresh.request.get(url + "/manifest.json").json()
                        assert manifest["name"] == "Team Console"
                        assert manifest["short_name"] == "Team Console"
                        for key in ("id", "scope", "start_url"):
                            assert manifest.get(key) == initial_manifest.get(key)
                        assert [s["url"] for s in manifest["shortcuts"]] == [
                            s["url"] for s in initial_manifest["shortcuts"]
                        ]
                        for icon in manifest["icons"]:
                            assert icon["purpose"] == "any"
                        effective = check.evaluate(
                            "window.__HERMES_INSTANCE_BRANDING__.effective"
                        )
                        for key in (
                            "favicon_32",
                            "icon_192",
                            "icon_512",
                            "apple_touch_icon",
                            "favicon_ico",
                        ):
                            asset = fresh.request.get(url + "/" + effective[key])
                            assert asset.ok
                            assert asset.headers["content-type"].startswith("image/")
                            assert asset.headers["x-content-type-options"] == "nosniff"
                        check.evaluate(
                            'window.HermesCustomBrandingExtension.setLogo("data:image/png;base64,YQ=="); window.HermesCustomBrandingExtension.setFavicon("data:image/png;base64,YQ==")'
                        )
                        assert "/branding/" in check.locator(
                            ".empty-logo img"
                        ).get_attribute("src")
                        assert (
                            check.locator("link[data-hwx-branding-favicon]").count()
                            == 0
                        )
                        check.evaluate(
                            "window.HermesCustomBrandingExtension.clearLogo();window.HermesCustomBrandingExtension.clearFavicon()"
                        )
                        assert (
                            check.evaluate(
                                'localStorage.getItem("hermes-ext-custom-branding-logo")'
                            )
                            is None
                        )
                        fresh.close()
                        configure(page)
                        for width in (1440, 390):
                            shot(page, evidence, engine + "-after-manager", width)
                        page.locator(".hwx-branding-picker summary").click()
                        visible_bounds(page)
                        assert page.locator(".hwx-branding-picker details").evaluate(
                            "e=>e.open"
                        )
                        page.locator(".hwx-branding-picker summary").click()
                        visible_bounds(page)
                        assert page.locator(".hwx-branding-picker button").evaluate_all(
                            "es=>es.every(e=>e.getBoundingClientRect().height>=44)"
                        )
                        # Keep name draft across Escape, reopen via the real Configure button.
                        page.locator("#hwxSharedName").fill("Unsaved draft")
                        page.keyboard.press("Escape")
                        page.locator(
                            '[data-extension-configure-id="custom-branding"]'
                        ).click()
                        assert (
                            page.locator("#hwxSharedName").input_value()
                            == "Unsaved draft"
                        )
                        # An actual other-client write changes the server ETag while this draft is open.
                        api(c, url, {"instance_name": "Other owner"})
                        page.get_by_role("button", name="Save", exact=True).click()
                        page.locator(".hwx-branding-save-status").filter(
                            has_text="Changed elsewhere"
                        ).wait_for()
                        assert (
                            page.locator("#hwxSharedName").input_value()
                            == "Unsaved draft"
                        )
                        for width in (1440, 390):
                            shot(page, evidence, engine + "-after-conflict", width)
                        page.get_by_role(
                            "button", name="Refresh shared settings", exact=True
                        ).click()
                        page.wait_for_function(
                            '()=>!document.querySelector("#hwxSharedName").disabled'
                        )
                        assert (
                            page.locator("#hwxSharedName").input_value()
                            == "Unsaved draft"
                        )
                        assert api(c, url)["config"]["instance_name"] == "Other owner"
                        page.locator("#hwxSharedName").fill("Team Console")
                        with page.expect_navigation(wait_until="domcontentloaded"):
                            page.get_by_role("button", name="Save", exact=True).click()
                        # Real provider toggle and native fallback remain covered.
                        assert c.request.post(
                            url + "/api/extensions/toggle",
                            data={"id": "custom-branding", "enabled": False},
                        ).ok
                        assert not api(c, url)["effective"]["active"]
                        assert c.request.post(
                            url + "/api/extensions/toggle",
                            data={"id": "custom-branding", "enabled": True},
                        ).ok
                        assert api(c, url)["effective"]["active"]
                        results["checks"].append(
                            engine
                            + ": real image/name/enable Save, fresh shared shell/manifest, real 412 draft/refresh, bounds/touch, provider toggle"
                        )
                        c.close()
                    # Same real persisted shared state, authentication disabled: no manager authority.
                    with server(
                        args.core_dir,
                        args.artifact,
                        state_root,
                        engine + "-non-manager",
                        authenticated=False,
                    ) as url:
                        c = context(browser, url, False)
                        page = c.new_page()
                        page.goto(url, wait_until="domcontentloaded")
                        configure(page)
                        assert api(c, url)["can_manage"] is False
                        assert page.locator("#hwxSharedName").count() == 0
                        assert (
                            "sign in as owner"
                            in page.locator(".hwx-branding-picker").inner_text()
                        )
                        assert (
                            page.locator(
                                ".app-titlebar-icon[role=button],.empty-logo[role=button]"
                            ).count()
                            == 0
                        )
                        for width in (1440, 390):
                            shot(page, evidence, engine + "-after-non-manager", width)
                        results["checks"].append(
                            engine
                            + ": real non-manager shared projection without form/brand triggers"
                        )
                        c.close()
                    with server(
                        args.core_dir, args.artifact, state_root, engine + "-reset"
                    ) as url:
                        c = context(browser, url)
                        page = c.new_page()
                        page.goto(url, wait_until="domcontentloaded")
                        configure(page)
                        page.locator("[data-shared-enabled]").uncheck()
                        with page.expect_navigation(wait_until="domcontentloaded"):
                            page.get_by_role("button", name="Save", exact=True).click()
                        assert not api(c, url)["effective"]["active"]
                        configure(page)
                        page.once("dialog", lambda dialog: dialog.accept())
                        with page.expect_navigation(wait_until="domcontentloaded"):
                            page.get_by_role(
                                "button", name="Reset shared branding…", exact=True
                            ).click()
                        assert not api(c, url)["effective"]["name"]
                        results["checks"].append(
                            engine
                            + ": manifest identity/asset MIME/personal priority, disable/reset"
                        )
                        c.close()
                finally:
                    browser.close()
            results["status"] = "passed"
    finally:
        harness._sanitized_environment = original
        (evidence / "result.json").write_text(json.dumps(results, indent=2) + "\n")
    print(json.dumps(results, indent=2))


if __name__ == "__main__":
    main()
