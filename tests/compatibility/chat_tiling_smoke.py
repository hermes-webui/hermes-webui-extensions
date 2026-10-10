#!/usr/bin/env python3
"""Snapshot-only acceptance against an isolated, real Core backend.

Real imported transcripts/native renderer/navigation; controlled HTTP faults and
busy metadata are boundary fixtures, not proof of a model/cancellation producer.
No actual send, approval, cancel or conversation deletion is allowed.
"""
from __future__ import annotations
import json
import os
import subprocess
import sys
import traceback
from pathlib import Path
from urllib.parse import parse_qs, urlsplit
from playwright.sync_api import sync_playwright
import browser_smoke as smoke

ROOT = Path(__file__).resolve().parents[2]
CORE = Path(os.environ['HERMES_CORE_DIR']).resolve()
EXTENSIONS = Path(os.environ.get('HERMES_EXTENSION_ROOT', str(ROOT/'extensions'))).resolve()
OUT = Path(os.environ.get('COMPATIBILITY_EVIDENCE_DIR', 'compatibility-evidence'))/'chat-tiling-snapshots'
OUT.mkdir(parents=True, exist_ok=True)
results = []
proc = log = None

def check(name, passed, evidence=None):
    results.append({'case':name,'pass':bool(passed),'evidence':evidence})
    if not passed:
        raise AssertionError(f'{name}: {evidence}')

try:
    proc,log,url,_ = smoke._start_server(core_dir=CORE, extension_root=EXTENSIONS,
        manifest_relative='chat-tiling/manifest.json',state_root=OUT/'state',
        log_path=OUT/'server.log', requested_port=0)
    with sync_playwright() as pw:
        browser = pw.chromium.launch(headless=True, executable_path=os.environ.get('HERMES_REVIEW_BROWSER_EXECUTABLE'))
        dangerous = []
        def trap(route):
            dangerous.append({'method':route.request.method,'path':urlsplit(route.request.url).path})
            route.fulfill(status=409,json={'error':'test trap; no action performed'})
        def context():
            ctx=browser.new_context(viewport={'width':1440,'height':950},service_workers='block',has_touch=True)
            events=smoke._install_network_guards(ctx)
            for path in ['approval/respond','chat/start','chat/cancel','session/delete']:
                ctx.route('**/api/'+path+'**',trap)
            return ctx,events
        ctx,events=context()
        sids=[]
        for name in ['A','B','C']:
            r=ctx.request.post(url+'/api/session/import',data={'title':'Snapshot '+name,
                'messages':[{'role':'user','content':'Question '+name},
                    {'role':'assistant','content':'Saved body '+name+'\n\n'+('Long saved conversation content. '*90)+'\n\n```js\nconst answer = 42;\n```'}]}).json()
            assert r.get('ok'),r
            sids.append(r['session']['session_id'])
        def seed_draft(sid,text,files=None):
            r=ctx.request.post(url+'/api/session/draft',data={'session_id':sid,'text':text,'files':files or []})
            assert r.ok,r.text()
        def persisted(sid):
            # Core persists drafts as session.composer_draft (reading `draft`
            # compared null to null). The baseline assertion below proves the key.
            r=ctx.request.get(url+'/api/session?session_id='+sid+'&messages=0&resolve_model=0')
            assert r.ok,r.text()
            return r.json()['session']['composer_draft']
        def boot():
            page=ctx.new_page();errors=[];requests=[]
            page.on('pageerror',lambda e:errors.append(str(e)))
            page.on('request',lambda r:requests.append({'method':r.method,'path':urlsplit(r.url).path,'query':parse_qs(urlsplit(r.url).query)}))
            page.goto(url,wait_until='domcontentloaded')
            page.wait_for_selector('#ext-tiling-toolbar button')
            page.wait_for_timeout(700)
            page.evaluate('sids=>window.testSids=sids',sids)
            page.evaluate('async()=>{await loadSession(testSids[0]);window.nativeTranscript=document.getElementById("msgInner");window.nativeComposer=document.getElementById("msg");window.normalLoad=window.loadSession;window.normalCalls=[];window.loadSession=(...args)=>{normalCalls.push(args);return normalLoad(...args)};}')
            return page,errors,requests
        def healthy(page,errors,events):
            smoke._assert_browser_health(case_name='snapshot-only',console_errors=[],page_errors=errors,extension_fragments=('chat-tiling',),network_events=events)
        seed_draft(sids[1],'B-original',[{'name':'B-original.txt','path':'B-original.txt'}])
        seed_draft(sids[0],'A-original')
        page,errors,requests=boot()
        page.evaluate('()=>{document.getElementById("msg").value="A-local-unsent";S.pendingFiles=[{name:"A-unsent.txt",path:"A-unsent.txt"}];window.testFiles=JSON.stringify(S.pendingFiles)}')
        baseline={sid:persisted(sid) for sid in sids}
        check('seeded drafts are real, non-empty baselines',baseline[sids[0]].get('text')=='A-original' and baseline[sids[1]].get('text')=='B-original' and [f.get('name') for f in baseline[sids[1]].get('files',[])]==['B-original.txt'],baseline)
        if os.environ.get('TILING_LEGACY_BOUNDARY_PROBE')=='1':
            page.locator('#ext-tiling-toolbar [data-layout="2"]').click()
            r=page.evaluate('()=>({composer:getComputedStyle(document.getElementById("composerWrap")).display,live:!!document.querySelector(".ext-tile--focused")})')
            check('legacy live grid fails snapshot-only composer/opaque-card boundary',r['composer']=='none' and not r['live'],r)
            raise RuntimeError('legacy unexpectedly met snapshot-only boundary')
        marker=len(requests)
        page.locator('#ext-tiling-toolbar button').click()
        page.wait_for_function('() => chatTilingState.tiles.some(t=>t.sid===testSids[0]&&!t.loading&&t.messages.length)')
        # Real sidebar gesture, not a synthetic navigation facade.
        page.locator(f'.session-item[data-sid="{sids[1]}"] .session-title').click()
        page.wait_for_function('() => chatTilingState.tiles.some(t=>t.sid===testSids[1]&&!t.loading&&t.messages.length)')
        state=page.evaluate('()=>({sid:S.session.session_id,calls:normalCalls,inputs:document.querySelectorAll("#msg").length,value:nativeComposer.value,files:JSON.stringify(S.pendingFiles),inert:document.getElementById("composerWrap").hasAttribute("inert"),hidden:getComputedStyle(document.getElementById("composerWrap")).display,body:document.querySelector("#ext-tile-grid").textContent,nativeSame:nativeTranscript===document.getElementById("msgInner"),live:!!document.querySelector(".ext-tile--focused")})')
        check('sidebar comparison uses real saved A/B history without navigation',state['sid']==sids[0] and not state['calls'] and 'Saved body A' in state['body'] and 'Saved body B' in state['body'],state)
        check('sole original composer and attachments preserved/inert',state['inputs']==1 and state['value']=='A-local-unsent' and state['files']==page.evaluate('testFiles') and state['inert'] and state['hidden']=='none' and state['nativeSame'],state)
        check('all cards are opaque snapshots; no live owner',not state['live'])
        scroll=page.evaluate('()=>chatTilingState.tiles.filter(t=>t.sid).map(t=>{const b=t.el.querySelector(".ext-tile-body");return {top:b.scrollTop,max:b.scrollHeight-b.clientHeight}})')
        check('snapshots open at the latest exchange',len(scroll)==2 and all(s['max']>0 and s['top']>=s['max']-2 for s in scroll),scroll)
        page.evaluate('()=>{chatTilingState.tiles[0].el.querySelector(".ext-tile-body").scrollTop=40}')
        page.wait_for_timeout(100)
        page.evaluate('()=>hideGridExt(false)');page.evaluate('async()=>await showGridExt(2,1)')
        check('reading position survives leaving and reopening the grid',page.evaluate('chatTilingState.tiles[0].el.querySelector(".ext-tile-body").scrollTop')==40)
        check('snapshot controls leave persisted drafts untouched',{sid:persisted(sid) for sid in sids}==baseline)
        for width,height in [(1440,950),(768,1024),(390,844)]:
            page.set_viewport_size({'width':width,'height':height})
            page.wait_for_timeout(400)  # let Core's 250ms drawer/sidebar transitions settle before capture
            for dark in [False,True]:
                page.evaluate('dark=>document.documentElement.classList.toggle("dark",dark)',dark)
                page.wait_for_timeout(100)
                native_width=page.evaluate('()=>{hideGridExt(false);return document.documentElement.scrollWidth}')
                page.evaluate('async()=>await showGridExt(2,1)')
                geometry=page.evaluate('''() => ({overflow:[...document.querySelectorAll('body *')].filter(e=>{const r=e.getBoundingClientRect();return r.width>0&&r.right>innerWidth+1}).map(e=>({tag:e.tagName,id:e.id,cls:e.className,right:e.getBoundingClientRect().right})).slice(0,12),pageWidth:document.documentElement.scrollWidth,width:innerWidth,cards:[...document.querySelectorAll('.ext-tile')].map(el=>{const r=el.getBoundingClientRect(),body=el.querySelector('.ext-tile-body'),head=el.querySelector('.ext-tile-titlebar').getBoundingClientRect();return {x:r.x,y:r.y,w:r.width,h:r.height,bg:getComputedStyle(el).backgroundColor,bodyH:body.clientHeight,bodyScroll:body.scrollHeight,overflow:getComputedStyle(body).overflowY,headW:head.width,buttons:[...el.querySelectorAll('.ext-tile-titlebar button')].map(b=>{const q=b.getBoundingClientRect();return {x:q.x,w:q.width}})}}),launcher:(()=>{const r=document.querySelector('#ext-tiling-toolbar').getBoundingClientRect();return {x:r.x,right:r.right}})()})''')
                geometry['nativePageWidth']=native_width
                cards=geometry['cards']
                ok=geometry['pageWidth']<=native_width+1 and geometry['launcher']['right']<=width+1 and all(c['x']>=-1 and c['x']+c['w']<=width+1 and c['w']>180 and c['h']>180 and c['bg'] not in ['rgba(0, 0, 0, 0)','transparent'] and c['bodyH']>80 and c['bodyScroll']>c['bodyH'] and c['overflow']=='auto' and all(b['x']>=c['x']-1 and b['x']+b['w']<=c['x']+c['w']+1 for b in c['buttons']) for c in cards)
                page.screenshot(path=str(OUT/f'diagnostic-{width}.png'))
                check(f'populated {width}px {"dark" if dark else "light"}: bounded opaque scrollable cards',ok,geometry)
                page.screenshot(path=str(OUT/f'populated-{width}-{"dark" if dark else "light"}.png'))
        # Phone flow: an empty card's Choose conversation opens Core's drawer;
        # a real touch on a row adds history, closes the drawer and never navigates.
        page.evaluate('async()=>await showGridExt(2,2)')
        page.wait_for_timeout(100)
        page.locator('.ext-tile-empty:not([hidden]) .ext-tile-choose').first.tap()
        page.wait_for_timeout(400)
        check('Choose conversation opens the phone drawer with the comparison hint',page.evaluate('!!document.querySelector(".sidebar.mobile-open")&&!!document.querySelector(".sidebar .ext-tiling-sidebar-hint")'))
        page.screenshot(path=str(OUT/'mobile-390-drawer-picking.png'))
        def tap_row(sid):
            touchrow=page.locator(f'.session-item[data-sid="{sid}"] .session-title')
            box=touchrow.bounding_box();assert box
            page.touchscreen.tap(box['x']+box['width']/2,box['y']+box['height']/2)
            page.wait_for_timeout(500)
        tap_row(sids[2])
        check('native mobile touch adds history, closes the drawer, no navigation',page.evaluate('chatTilingState.visible&&chatTilingState.tiles.some(t=>t.sid===testSids[2])&&!document.querySelector(".sidebar.mobile-open")&&normalCalls.length===0&&S.session.session_id===testSids[0]'))
        page.screenshot(path=str(OUT/'mobile-390-after-pick.png'))
        page.locator('#btnHamburger').click()
        page.wait_for_timeout(400)
        tap_row(sids[1])
        check('duplicate mobile touch reuses history, closes the drawer, no navigation',page.evaluate('chatTilingState.tiles.filter(t=>t.sid===testSids[1]).length===1&&!document.querySelector(".sidebar.mobile-open")&&normalCalls.length===0&&S.session.session_id===testSids[0]'))
        page.set_viewport_size({'width':1440,'height':950})
        b_id=page.evaluate('chatTilingState.tiles.find(t=>t.sid===testSids[1]).id')
        b=page.locator(f'.ext-tile[data-tile-id="{b_id}"]')
        b.get_by_role('button',name='Expand snapshot',exact=True).focus()
        b.get_by_role('button',name='Expand snapshot',exact=True).press('Enter')
        check('keyboard expand keeps grid and Core session',page.evaluate('chatTilingState.visible&&chatTilingState.maximizedId!==null&&normalCalls.length===0'))
        check('expanded control is announced as Restore',b.get_by_role('button',name='Restore snapshot',exact=True).get_attribute('aria-pressed')=='true')
        b.get_by_role('button',name='Restore snapshot',exact=True).press(' ')
        check('Space restores comparison without navigation',page.evaluate('chatTilingState.maximizedId===null&&normalCalls.length===0'))
        # Actual Core shortcut/card, fake approval ID; every response is trapped.
        def synthetic_approval():
            page.evaluate("()=>{stopApprovalPolling();showApprovalForSession(S.session.session_id,{approval_id:'snapshot-trap-only',tool_name:'synthetic',description:'No backend approval exists'},1)}")
        page.evaluate('()=>hideGridExt()');synthetic_approval()
        page.locator('.app-titlebar-title').evaluate('e=>{e.tabIndex=0;e.focus()}')
        page.keyboard.press('Enter');page.wait_for_timeout(200)
        check('actual Core approval shortcut trap positive control',len(dangerous)==1,dangerous)
        dangerous.clear()
        page.locator('#ext-tiling-toolbar button').click();synthetic_approval()
        # Consecutive native key presses with no refocus between them: focus must
        # stay on the owned control, never fall to <body> where Enter approves.
        b.get_by_role('button',name='Refresh history',exact=True).focus()
        page.keyboard.press('Enter');page.keyboard.press('Enter')
        page.wait_for_function('() => chatTilingState.tiles.every(t=>!t.loading)')
        page.keyboard.press('Enter')
        page.wait_for_function('() => chatTilingState.tiles.every(t=>!t.loading)')
        check('Refresh keeps keyboard focus across loading',page.evaluate('!!document.activeElement&&document.activeElement.classList.contains("ext-tile-refresh")'))
        b.get_by_role('button',name='Expand snapshot',exact=True).focus()
        for key in ['Enter','Enter',' ',' ']:page.keyboard.press(key)
        page.wait_for_timeout(200)
        check('Expand/Restore keeps keyboard focus',page.evaluate('!!document.activeElement&&document.activeElement.classList.contains("ext-tile-expand")&&chatTilingState.maximizedId===null'))
        check('pinned cards stay at their latest message after Expand/Restore',page.evaluate('(()=>{const pinned=chatTilingState.tiles.filter(t=>t.sid&&t.scroll===null);return pinned.length>0&&pinned.every(t=>{const b=t.el.querySelector(".ext-tile-body");return b.scrollTop>=b.scrollHeight-b.clientHeight-2})})()'))
        page.evaluate('()=>document.activeElement&&document.activeElement.blur()');page.keyboard.press('Enter');page.wait_for_timeout(200)
        check('owned Enter/Space produce no approvals, even with focus on <body>',not dangerous,dangerous)
        cache=page.evaluate('JSON.stringify(chatTilingState.tiles.find(t=>t.sid===testSids[1]).messages)')
        fault={'mode':'503'}
        def history_fault(route):
            q=parse_qs(urlsplit(route.request.url).query)
            if q.get('session_id')==[sids[1]] and q.get('messages')==['1']:
                if fault['mode']=='503':route.fulfill(status=503,json={'error':'controlled history fault'})
                else:route.fulfill(json={'session':{'session_id':sids[1],'messages':'malformed'}})
            else:route.continue_()
        ctx.route('**/api/session?*',history_fault)
        for mode in ['503','malformed']:
            fault['mode']=mode
            page.evaluate('async id=>await refreshTilingSnapshot(id)',b_id)
            r=page.evaluate('()=>({cache:JSON.stringify(chatTilingState.tiles.find(t=>t.sid===testSids[1]).messages),error:chatTilingState.tiles.find(t=>t.sid===testSids[1]).error,calls:normalCalls.length})')
            check(f'{mode} refresh preserves cache and does not navigate',r['cache']==cache and r['error'] and r['calls']==0,r)
        ctx.unroute('**/api/session?*',history_fault)
        # Busy metadata is read-only: no INFLIGHT patch or fake agent producer.
        def busy_history(route):
            q=parse_qs(urlsplit(route.request.url).query)
            if q.get('session_id')==[sids[1]] and q.get('messages')==['1']:
                response=route.fetch();data=response.json();data['session']['active_stream_id']='controlled-busy-metadata';route.fulfill(response=response,json=data)
            else:route.continue_()
        ctx.route('**/api/session?*',busy_history)
        page.evaluate('async id=>await refreshTilingSnapshot(id)',b_id)
        b.get_by_role('button',name='Close snapshot',exact=True).focus()
        b.get_by_role('button',name='Close snapshot',exact=True).press('Enter')
        check('busy history close is local; no send/cancel/delete/approval',not dangerous and page.evaluate('normalCalls.length===0&&!chatTilingState.tiles.some(t=>t.sid===testSids[1])'),dangerous)
        ctx.unroute('**/api/session?*',busy_history)
        awaitable = page.evaluate('async()=>{await showGridExt(2,2);await addTilingSnapshot(testSids[1]);await addTilingSnapshot(testSids[2]);await showGridExt(2,1);return {filled:chatTilingState.tiles.filter(t=>t.sid).length,count:chatTilingState.cols*chatTilingState.rows}}')
        check('shrinking refuses silent populated-card loss',awaitable=={'filled':3,'count':4},awaitable)
        held=[]
        def hold_history(route):
            q=parse_qs(urlsplit(route.request.url).query)
            if q.get('session_id')==[sids[1]] and q.get('messages')==['1']:held.append(route)
            else:route.continue_()
        ctx.route('**/api/session?*',hold_history)
        page.evaluate('()=>{window.lateRead=refreshTilingSnapshot(chatTilingState.tiles.find(t=>t.sid===testSids[1]).id)}')
        page.wait_for_timeout(100)
        assert held,'history hold not reached'
        page.evaluate('()=>closeTileExt(chatTilingState.tiles.find(t=>t.sid===testSids[1]).id)')
        held.pop().continue_();page.evaluate('async()=>await lateRead')
        ctx.unroute('**/api/session?*',hold_history)
        check('late history response cannot recreate a closed card',page.evaluate('!chatTilingState.tiles.some(t=>t.sid===testSids[1])'))
        # A held refresh abandoned by Escape cannot update retained snapshots.
        a_id=page.evaluate('chatTilingState.tiles.find(t=>t.sid===testSids[0]).id')
        old_a=page.evaluate('JSON.stringify(chatTilingState.tiles.find(t=>t.sid===testSids[0]).messages)')
        held_a=[]
        def hold_a(route):
            q=parse_qs(urlsplit(route.request.url).query)
            if q.get('session_id')==[sids[0]] and q.get('messages')==['1']:held_a.append(route)
            else:route.continue_()
        ctx.route('**/api/session?*',hold_a)
        page.evaluate('id=>{window.abandoned=refreshTilingSnapshot(id)}',a_id)
        page.wait_for_timeout(100);assert held_a
        page.evaluate('()=>hideGridExt()')
        held_a.pop().fulfill(json={'session':{'session_id':sids[0],'title':'Late replacement','messages':[{'role':'assistant','content':'Late replacement'}]}})
        page.evaluate('async()=>await abandoned')
        ctx.unroute('**/api/session?*',hold_a)
        page.evaluate('async()=>await showGridExt(2,2)')
        check('late refresh after exit cannot overwrite retained history',page.evaluate('JSON.stringify(chatTilingState.tiles.find(t=>t.sid===testSids[0]).messages)')==old_a)

        grid_only=requests[marker:]
        check('grid operations perform only GET requests',all(r['method']=='GET' for r in grid_only if r['path'] not in ['/api/approval/respond','/api/updates/check']),grid_only)
        page.locator('#ext-tile-grid').press('Escape')
        restored=page.evaluate('()=>({visible:chatTilingState.visible,same:nativeTranscript===document.getElementById("msgInner")&&nativeComposer===document.getElementById("msg"),inert:document.getElementById("composerWrap").hasAttribute("inert"),value:nativeComposer.value,files:JSON.stringify(S.pendingFiles)})')
        check('Escape restores original composer and unsent files',not restored['visible'] and restored['same'] and not restored['inert'] and restored['value']=='A-local-unsent' and restored['files']==page.evaluate('testFiles'),restored)
        check('all grid actions leave A/B persisted drafts untouched',{sid:persisted(sid) for sid in sids}==baseline)
        reads=len(requests)
        page.locator('#ext-tiling-toolbar button').click()
        page.wait_for_timeout(200)
        check('reopening keeps comparison without implicit refresh/navigation',len(requests)==reads and page.evaluate('chatTilingState.tiles.filter(t=>t.sid).length===2&&normalCalls.length===0'))
        awaitable=page.evaluate('async()=>{await addTilingSnapshot(testSids[1]);return chatTilingState.tiles.find(t=>t.sid===testSids[1]).id}')
        page.locator(f'.ext-tile[data-tile-id="{awaitable}"] .ext-tile-open').focus()
        page.locator(f'.ext-tile[data-tile-id="{awaitable}"] .ext-tile-open').press('Enter')
        page.wait_for_function('() => S.session?.session_id===testSids[1]&&document.getElementById("msgInner").textContent.includes("Saved body B")')
        r=page.evaluate('()=>({calls:normalCalls,visible:chatTilingState.visible,draft:document.getElementById("msg").value,inputs:document.querySelectorAll("#msg").length,inert:document.getElementById("composerWrap").hasAttribute("inert")})')
        check('keyboard open hands off once to real ordinary Core chat',r['calls']==[[sids[1]]] and not r['visible'] and r['draft']=='B-original' and r['inputs']==1 and not r['inert'],r)
        check('B original server draft unaffected by comparison/handoff',persisted(sids[1])==baseline[sids[1]])
        healthy(page,errors,events)
        ctx.close()
        # Native message/metadata failures are exercised without extension
        # rollback. Core's own partial owner after message failure is recorded,
        # never represented as a live pane or a successful navigation outcome.
        for phase in ['0','1']:
            ctx,events=context();page,errors,requests=boot()
            seed_draft(sids[1],'B-original',[{'name':'B-original.txt','path':'B-original.txt'}])
            before=persisted(sids[1])
            page.evaluate('async()=>{document.getElementById("msg").value="A-failure-unsent";await showGridExt(2,1);await addTilingSnapshot(testSids[1])}')
            fault_hits=[]
            def navigation_fault(route):
                q=parse_qs(urlsplit(route.request.url).query)
                if q.get('session_id')==[sids[1]] and q.get('messages')==[phase]:
                    fault_hits.append(q);route.fulfill(status=503,json={'error':'controlled normal navigation failure'})
                else:route.continue_()
            ctx.route('**/api/session?*',navigation_fault)
            page.evaluate('async()=>await focusTileExt(chatTilingState.tiles.find(t=>t.sid===testSids[1]).id)')
            page.wait_for_timeout(250)
            r=page.evaluate('()=>({calls:normalCalls,visible:chatTilingState.visible,coreSid:S.session?.session_id,draft:document.getElementById("msg").value,inputs:document.querySelectorAll("#msg").length,inert:document.getElementById("composerWrap").hasAttribute("inert"),live:!!document.querySelector(".ext-tile--focused")})')
            check(f'normal {"metadata" if phase=="0" else "messages"} failure: one handoff, no rollback or live claim',len(fault_hits)==1 and r['calls']==[[sids[1]]] and not r['visible'] and not r['inert'] and not r['live'] and r['inputs']==1,r)
            check(f'normal navigation failure {phase}: B persisted draft stays original',persisted(sids[1])==before,{'before':before,'after':persisted(sids[1])})
            page.locator('#ext-tiling-toolbar button').click();page.wait_for_timeout(200)
            check(f'reopen after failure {phase} is local and does not write B',persisted(sids[1])==before and page.evaluate('normalCalls.length===1'))
            healthy(page,errors,events);ctx.close()
        ctx,events=context();page,errors,requests=boot()
        page.evaluate('async()=>{await showGridExt(2,1);await addTilingSnapshot(testSids[1]);await loadSession(testSids[2])}')
        check('native public navigation exits comparison without veto',page.evaluate('!chatTilingState.visible&&S.session.session_id===testSids[2]'))
        page.evaluate('async()=>{await showGridExt(2,1);await newSession()}')
        page.wait_for_timeout(500)
        check('native new-session transition exits comparison without owning transaction',page.evaluate('!chatTilingState.visible&&!document.getElementById("composerWrap").hasAttribute("inert")'))
        page.evaluate('async()=>{await showGridExt(2,1);while(chatTilingState.tiles.length)closeTileExt(chatTilingState.tiles[0].id)}')
        check('closing final snapshot returns to chat without deletion/cancel',page.evaluate('!chatTilingState.visible&&document.querySelectorAll("#msg").length===1') and not dangerous,dangerous)
        healthy(page,errors,events);ctx.close()
        browser.close()
except Exception as exc:
    results.append({'case':'harness failure','pass':False,'error':str(exc)})
    traceback.print_exc()
finally:
    smoke._terminate(proc,log)
    sha=subprocess.run(['git','-c','core.fsmonitor=false','rev-parse','HEAD'],cwd=CORE,capture_output=True,text=True).stdout.strip()
    smoke._write_json(OUT/'results.json',{'core_sha':sha,'busy_scope':'controlled saved-history metadata; no actual agent/cancel producer','results':results,'passed':sum(r['pass'] for r in results),'total':len(results)})
    print(f'Chat Tiling snapshot-only: {sum(r["pass"] for r in results)}/{len(results)} passed; {OUT}')
if not results or not all(r['pass'] for r in results):sys.exit(1)
