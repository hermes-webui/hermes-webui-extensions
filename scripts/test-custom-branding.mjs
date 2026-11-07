import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {JSDOM, VirtualConsole} from 'jsdom';
const source = readFileSync(new URL('../extensions/custom-branding/assets/custom-branding.js', import.meta.url), 'utf8');
const local = 'data:image/png;base64,YQ==';
const effective = {active: true, name: 'Team Console', icon_512: 'branding/' + 'a'.repeat(64) + '/icon-512.png', revision: 'r1'};
const state = {api_version: 1, provider_available: true, can_manage: true, can_upload: true, name_supported: true,
  config: {enabled: true, instance_name: 'Team Console', manages_instance_name: true}, effective};
const tick = () => new Promise(r => setTimeout(r, 20));
async function harness(value = state, status = 200) {
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', error => { if (!error.message.includes('Not implemented: navigation')) throw error; });
  const dom = new JSDOM('<base href="/prefix/"><link rel="icon" href="shared.png" data-instance-branding="1"><div class="app-titlebar-icon"><svg></svg></div><div class="empty-logo"><svg></svg></div>', {url:'https://example.test/prefix/session/abc', runScripts:'outside-only', pretendToBeVisual:true, virtualConsole});
  const w = dom.window;
  w.localStorage.setItem('hermes-ext-custom-branding-logo', local);
  w.localStorage.setItem('hermes-ext-custom-branding-favicon', local);
  w.__HERMES_INSTANCE_BRANDING__ = {api_version:1,effective};
  w.__HERMES_CONFIG__ = {csrfToken:'test-only'};
  let configure;
  const requests = [];
  w.hermesExt = {register: id => {assert.equal(id,'custom-branding'); return {settings:{registerConfigure: fn => {configure = fn;}}};}};
  w.confirm = () => true;
  w.fetch = async (url, options) => {
    requests.push({url:String(url),options});
    return {ok:status===200,status,headers:{get:()=> '"exact-etag"'},json:async()=>structuredClone(value)};
  };
  w.eval(source);
  await tick();
  return {w, dom, requests, configure:()=>configure()};
}
function button(w, label) { return [...w.document.querySelectorAll('button')].find(b=>b.textContent===label); }
{
  const {w,dom,requests,configure} = await harness();
  assert.equal(w.document.querySelector('.empty-logo img').src,'https://example.test/prefix/'+effective.icon_512);
  assert.equal(w.document.querySelector('link[rel=icon]').getAttribute('href'),'shared.png');
  assert.equal(w.localStorage.getItem('hermes-ext-custom-branding-favicon'),local);
  let closed = false;
  const pending = configure().then(()=>{closed=true;}); await tick();
  assert.ok(w.document.querySelector('input[type=text]'));
  assert.equal(w.document.querySelectorAll('details input').length,0);
  button(w,'Close').click(); await pending; assert.ok(closed);
  w.HermesCustomBrandingExtension.open(); await tick();
  button(w,'Save name and ownership').click(); await tick();
  const post = requests.find(r=>r.options.method==='POST');
  assert.equal(post.url,'https://example.test/prefix/api/instance-branding');
  assert.equal(post.options.headers['If-Match'],'"exact-etag"');
  assert.equal(post.options.headers['X-Hermes-CSRF-Token'],'test-only');
  assert.deepEqual(JSON.parse(post.options.body),{instance_name:'Team Console',manages_instance_name:true});
  dom.window.close();
}
{
  const {w,dom} = await harness({...state,effective:{active:false}});
  assert.equal(w.document.querySelector('.empty-logo img').src,local);
  assert.equal(w.document.querySelector('link[rel=icon]').href,local);
  dom.window.close();
}
{
  const {w,dom} = await harness({...state,can_manage:false,can_upload:false});
  w.HermesCustomBrandingExtension.open(); await tick();
  assert.equal(button(w,'Save name and ownership').disabled,true);
  assert.equal(w.document.querySelector('input[type=file]').disabled,true);
  dom.window.close();
}
{
  const {w,dom,requests} = await harness();
  w.HermesCustomBrandingExtension.open(); await tick();
  w.fetch = async (url,options) => {
    requests.push({url:String(url),options});
    return {ok:options.method!=='POST',status:options.method==='POST'?412:200, headers:{get:()=> '"new-etag"'},json:async()=>state};
  };
  button(w,'Save name and ownership').click(); await tick();
  assert.match(w.document.getElementById('hwxBrandingStatus').textContent,/Changed elsewhere/);
  assert.equal(requests.filter(r=>r.options.method==='POST').length,1);
  button(w,'Save name and ownership').click(); await tick();
  assert.equal(requests.filter(r=>r.options.method==='POST')[1].options.headers['If-Match'],'"new-etag"');
  dom.window.close();
}
{
  const {w,dom} = await harness(null,404);
  // A failed API probe must never override an active initial shared projection.
  assert.notEqual(w.document.querySelector('.empty-logo img').src,local);
  w.HermesCustomBrandingExtension.open(); await tick();
  assert.match(w.document.body.textContent,/Shared API unavailable/);
  assert.equal(button(w,'Enable sharing'),undefined);
  dom.window.close();
}
{
  // Legacy shell without initial shared metadata keeps personal branding.
  const old = new JSDOM('<div class="empty-logo"><svg></svg></div>', {url:'https://example.test/',runScripts:'outside-only',pretendToBeVisual:true});
  old.window.localStorage.setItem('hermes-ext-custom-branding-logo',local);
  old.window.fetch = async () => ({ok:false,status:404});
  old.window.eval(source); await tick();
  assert.equal(old.window.document.querySelector('.empty-logo img').src,local);
  old.window.close();
}
{
  const {w,dom} = await harness({...state,can_upload:false});
  w.HermesCustomBrandingExtension.open(); await tick();
  assert.equal(button(w,'Save name and ownership').disabled,false);
  assert.equal(w.document.querySelector('input[type=file]').disabled,true);
  assert.match(w.document.body.textContent,/optional image dependency/);
  dom.window.close();
}
{
  const {w,dom} = await harness({...state,provider_available:false,effective:{active:false}});
  w.HermesCustomBrandingExtension.open(); await tick();
  assert.equal(button(w,'Save name and ownership').disabled,true);
  assert.equal(button(w,'Disable sharing').disabled,false);
  assert.equal(button(w,'Restore Hermes / reset shared identity').disabled,false);
  dom.window.close();
}
console.log('Custom Branding: shared priority, prefix/session URL, Configure lifecycle, exact ETag/CSRF, authority, legacy/failure and conflict passed');
