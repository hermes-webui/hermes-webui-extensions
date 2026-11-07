#!/usr/bin/env python3
"""Shared branding browser smoke against an explicitly selected API-v1 core.

Uses a packaged extension, disposable server state, native test authentication,
and two clean browser engines. Optional image/name arguments stay in evidence;
no input assets or state are copied into the contribution.
"""
from __future__ import annotations

import argparse
import hashlib
import io
import json
from pathlib import Path
import tempfile
import subprocess
import sys
import zipfile

import browser_smoke as harness
from playwright.sync_api import sync_playwright
from PIL import Image


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--core-dir', required=True, type=Path)
    parser.add_argument('--artifact', required=True, type=Path)
    parser.add_argument('--evidence-dir', required=True, type=Path)
    parser.add_argument('--image', type=Path)
    parser.add_argument('--name', default='Team Console')
    args = parser.parse_args()
    evidence = args.evidence_dir.resolve()
    evidence.mkdir(parents=True, exist_ok=True)
    artifact = args.artifact.resolve()
    if args.image:
        image = args.image.read_bytes()
    else:
        stream = io.BytesIO()
        Image.new('RGBA', (512, 512), (34, 120, 190, 255)).save(stream, 'PNG')
        image = stream.getvalue()
    results = {'artifact_sha256': hashlib.sha256(artifact.read_bytes()).hexdigest(), 'engines': [], 'status':'failed'}
    original_environment = harness._sanitized_environment

    def test_environment(**kwargs):
        env = original_environment(**kwargs)
        env['HERMES_WEBUI_PASSWORD'] = 'disposable-browser-test'
        env.pop('HERMES_WEBUI_EXTENSION_MANIFEST', None)
        # Exercise core's real hash verifier, extractor, install tracking and loader.
        # Only the HTTPS transport is replaced with the locally generated zip.
        installer = """
import hashlib, sys
from pathlib import Path
from api import extensions
payload = Path(sys.argv[1]).read_bytes()
extensions._safe_download = lambda *_args: payload
extensions.install_extension('custom-branding',
    'https://hermes-webui.github.io/hermes-webui-extensions/artifacts/test.zip',
    hashlib.sha256(payload).hexdigest())
"""
        subprocess.run([sys.executable, '-c', installer, str(artifact)],
                       cwd=args.core_dir.resolve(), env=env, check=True, capture_output=True)
        return env

    harness._sanitized_environment = test_environment
    proc = log = None
    with tempfile.TemporaryDirectory(prefix='branding-smoke-') as temporary:
        root = Path(temporary)
        installed = root / 'installed'
        with zipfile.ZipFile(artifact) as archive:
            for entry in archive.namelist():
                target = (installed / entry).resolve()
                assert target.is_relative_to(installed.resolve())
            archive.extractall(installed)
        extension = installed / 'custom-branding'
        runtime = json.loads((extension / 'manifest.json').read_text())
        assert runtime['extensions'][0]['instance_branding_api'] == 1
        results['runtime_handshake'] = 1
        results['installation'] = 'core installer with local zip transport; real hash/extraction/tracking/loader'
        try:
            proc, log, url, _ = harness._start_server(
                core_dir=args.core_dir.resolve(), extension_root=installed,
                manifest_relative='manifest.json', state_root=root / 'state',
                log_path=evidence / 'server.log', requested_port=0)
            with sync_playwright() as playwright:
                browsers = []
                contexts = []
                try:
                    for engine in ('chromium', 'firefox'):
                        browser = getattr(playwright, engine).launch()
                        browsers.append(browser)
                        context = browser.new_context(service_workers='block')
                        harness._install_network_guards(context)
                        response = context.request.post(url + '/api/auth/login', data={'password':'disposable-browser-test'})
                        assert response.ok
                        contexts.append(context)
                        results['engines'].append({'name': engine, 'version': browser.version})
                    owner = contexts[0].new_page()
                    owner.goto(url, wait_until='domcontentloaded')
                    owner.wait_for_function('window.HermesCustomBrandingExtension?.version === "0.2.0"')
                    initial_manifest = contexts[0].request.get(url+'/manifest.json').json()
                    for width, label in ((1440, 'desktop'), (390, 'narrow')):
                        owner.set_viewport_size({'width':width, 'height':900})
                        if width == 390:
                            owner.evaluate('window.dismissMobileSidebar?.()')
                        owner.screenshot(path=str(evidence / f'before-{label}.png'), animations='disabled')
                    # Drive the actual registered Configure hook through Settings.
                    # Reuse navigation only; the selector itself belongs to this entry.
                    owner.set_viewport_size({'width':1440, 'height':900})
                    owner.locator('button[data-panel="settings"]').first.click()
                    owner.locator('#settingsMenu button[data-settings-section="extensions"]').click()
                    owner.locator('button[data-extensions-tab="installed"]').click()
                    owner.locator('#extensionsInstalled [data-extension-configure-id="custom-branding"]').click()
                    owner.locator('.hwx-branding-picker input[type=file]').first.wait_for()
                    owner.once('dialog', lambda dialog: dialog.accept())
                    with owner.expect_navigation(wait_until='domcontentloaded'):
                        owner.locator('.hwx-branding-picker input[type=file]').first.set_input_files(
                            {'name':'instance.png', 'mimeType':'image/png', 'buffer':image})
                    owner.evaluate('window.HermesCustomBrandingExtension.open()')
                    name_input = owner.locator('.hwx-branding-picker input[type=text]')
                    name_input.wait_for()
                    name_input.fill(args.name)
                    owner.locator('.hwx-branding-picker input[type=checkbox]').check()
                    with owner.expect_navigation(wait_until='domcontentloaded'):
                        owner.get_by_role('button', name='Save name and ownership', exact=True).click()
                    owner.evaluate('window.HermesCustomBrandingExtension.open()')
                    with owner.expect_navigation(wait_until='domcontentloaded'):
                        owner.get_by_role('button', name='Enable sharing', exact=True).click()
                    for index, context in enumerate(contexts):
                        page = context.new_page()
                        page.goto(url, wait_until='domcontentloaded')
                        page.wait_for_function('window.__HERMES_INSTANCE_BRANDING__?.effective?.active === true')
                        assert page.evaluate('window.__HERMES_INSTANCE_BRANDING__.effective.name') == args.name
                        assert page.evaluate('localStorage.getItem("hermes-ext-custom-branding-logo")') is None
                        page.locator('.empty-logo img.hwx-branding-logo-img').wait_for()
                        assert page.locator('link[data-instance-branding="1"]').count() >= 1
                        manifest_response = context.request.get(page.locator('link[rel=manifest]').evaluate('(e)=>e.href'))
                        assert 'application/manifest+json' in manifest_response.headers['content-type']
                        manifest = manifest_response.json()
                        effective = page.evaluate('window.__HERMES_INSTANCE_BRANDING__.effective')
                        for key in ('favicon_32', 'icon_192', 'icon_512', 'apple_touch_icon', 'favicon_ico'):
                            asset = context.request.get(url + '/' + effective[key])
                            assert asset.ok and asset.headers['x-content-type-options'] == 'nosniff'
                            assert asset.headers['content-type'].startswith('image/')
                        assert manifest['name'] == manifest['short_name'] == args.name
                        for key in ('id', 'scope', 'start_url'):
                            assert manifest.get(key) == initial_manifest.get(key)
                        for icon in manifest['icons']:
                            assert icon['purpose'] == 'any'
                        for width, label in ((1440, 'desktop'), (390, 'narrow')):
                            page.set_viewport_size({'width':width, 'height':900})
                            if width == 390:
                                page.evaluate('window.dismissMobileSidebar?.()')
                            page.screenshot(path=str(evidence / f'after-{index}-{label}.png'), animations='disabled')
                        # Shared active identity must win over old personal values.
                        page.evaluate('localStorage.setItem("hermes-ext-custom-branding-logo", "data:image/png;base64,YQ=="); window.HermesCustomBrandingExtension.refresh()')
                        assert '/branding/' in page.locator('.empty-logo img').get_attribute('src')
                        page.evaluate('localStorage.removeItem("hermes-ext-custom-branding-logo")')
                        if index == 0:
                            page.evaluate('window.HermesCustomBrandingExtension.open()')
                            page.get_by_role('button',name='Close',exact=True).wait_for()
                            assert page.locator('.hwx-branding-picker').evaluate('(e)=>e.getBoundingClientRect().right <= innerWidth')
                            page.screenshot(path=str(evidence / 'configure-narrow.png'), animations='disabled')
                    owner.reload(wait_until='domcontentloaded')
                    def toggle_provider(enabled):
                        status = owner.evaluate("""async enabled => {
                          const r = await fetch(new URL('api/extensions/toggle', document.baseURI), {
                            method:'POST', headers:{'Content-Type':'application/json'},
                            body:JSON.stringify({id:'custom-branding',enabled})}); return r.status;
                        }""", enabled)
                        assert status == 200
                        owner.reload(wait_until='domcontentloaded')
                    toggle_provider(False)
                    assert not owner.evaluate('window.__HERMES_INSTANCE_BRANDING__.effective.active')
                    toggle_provider(True)
                    assert owner.evaluate('window.__HERMES_INSTANCE_BRANDING__.effective.active')
                    # Downgrade handshake simulation: the real installed manifest
                    # loses v1, exactly as an older provider would. No core edits.
                    runtime_entry = runtime['extensions'][0]
                    del runtime_entry['instance_branding_api']
                    (extension / 'manifest.json').write_text(json.dumps(runtime))
                    owner.reload(wait_until='domcontentloaded')
                    assert not owner.evaluate('window.__HERMES_INSTANCE_BRANDING__.effective.active')
                    runtime_entry['instance_branding_api'] = 1
                    (extension / 'manifest.json').write_text(json.dumps(runtime))
                    owner.reload(wait_until='domcontentloaded')
                    assert owner.evaluate('window.__HERMES_INSTANCE_BRANDING__.effective.active')
                    owner.evaluate('window.HermesCustomBrandingExtension.open()')
                    with owner.expect_navigation(wait_until='domcontentloaded'):
                        owner.get_by_role('button',name='Disable sharing',exact=True).click()
                    assert not owner.evaluate('window.__HERMES_INSTANCE_BRANDING__.effective.active')
                    owner.evaluate('window.HermesCustomBrandingExtension.open()')
                    owner.once('dialog',lambda dialog:dialog.accept())
                    with owner.expect_navigation(wait_until='domcontentloaded'):
                        owner.get_by_role('button',name='Restore Hermes / reset shared identity',exact=True).click()
                    assert not owner.evaluate('window.__HERMES_INSTANCE_BRANDING__.effective.name')
                    results['checks'] = ['packaged runtime handshake', 'native login and Configure', 'real upload/name/enable', 'two clean engines', 'shared DOM logos and initial metadata', 'manifest identity preserved', 'personal priority', 'desktop/narrow captures', 'provider disable/reactivation and missing-v1 fallback', 'disable and reset']
                    results['status'] = 'passed'
                finally:
                    for context in contexts:
                        context.close()
                    for browser in browsers:
                        browser.close()
        finally:
            harness._terminate(proc, log)
            harness._sanitized_environment = original_environment
            (evidence / 'result.json').write_text(json.dumps(results, indent=2)+'\n')
    print(json.dumps(results, indent=2))


if __name__ == '__main__':
    main()
