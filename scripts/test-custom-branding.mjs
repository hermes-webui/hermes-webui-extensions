import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {JSDOM, VirtualConsole} from 'jsdom';
const source = readFileSync(process.env.BRANDING_TEST_SOURCE || new URL('../extensions/custom-branding/assets/custom-branding.js', import.meta.url), 'utf8');
const local = 'data:image/png;base64,YQ==';
const imagePath = 'branding/' + 'a'.repeat(64) + '/icon-512.png';
const effective = {active:true, name:'Team Console', icon_512:imagePath, revision:'r1'};
const state = {api_version:1, provider_available:true, can_manage:true, can_upload:true, name_supported:true,
  config:{enabled:true, instance_name:'Team Console', manages_instance_name:true, image_revision:'a'.repeat(64)}, effective};
const tick = () => new Promise(r => setTimeout(r, 30));
const copy = v => structuredClone(v);
let unhandled = 0;
process.on('unhandledRejection', error => { unhandled++; console.error('Unhandled rejection: '+error.message); });
const tests = [];
const test = (name, fn) => tests.push({name, fn});
const button = (w, text) => [...w.document.querySelectorAll('.hwx-branding-picker button')].find(b=>b.textContent===text || b.getAttribute('aria-label')===text);
const nameInput = w => w.document.querySelector('.hwx-branding-picker input[type=text]');
async function harness({bootstrap={api_version:1,effective}, value=state, status=200}={}) {
  const errors=[], requests=[];
  const vc = new VirtualConsole();
  vc.on('jsdomError', e=> {if (!e.message.includes('Not implemented: navigation')) errors.push(e.message);});
  const dom = new JSDOM('<base href="/prefix/"><link rel="icon" href="native.png"><button id="configure">Configure</button><div class="app-titlebar-icon"><svg></svg></div><div class="empty-logo"><svg></svg></div>', {url:'https://example.test/prefix/session/abc', runScripts:'outside-only', pretendToBeVisual:true, virtualConsole:vc});
  const w = dom.window;
  w.localStorage.setItem('hermes-ext-custom-branding-logo',local);
  w.localStorage.setItem('hermes-ext-custom-branding-favicon',local);
  if (bootstrap!==null) w.__HERMES_INSTANCE_BRANDING__=copy(bootstrap);
  w.__HERMES_CONFIG__={csrfToken:'test-only'};
  let configure;
  w.hermesExt={register:()=>({settings:{registerConfigure:fn=>{configure=fn;return ()=>true;}}})};
  w.confirm=()=>true;
  let reply=async()=>({status,value});
  w.fetch=async(url,options={})=>{
    requests.push({url:String(url),options});
    const result=await reply(url,options);
    return {ok:result.status===200,status:result.status,headers:{get:()=> result.etag || '"exact-etag"'},json:async()=>copy(result.value)};
  };
  w.eval(source); await tick();
  return {w,dom,errors,requests,setReply:fn=>{reply=fn;},async open(){
    const anchor=w.document.getElementById('configure'); anchor.focus();
    assert.equal(typeof configure,'function','Configure must always register');
    configure(); await tick();
  },close(){dom.window.close();}};
}
async function use(options, fn) {const h=await harness(options);try{await fn(h);assert.deepEqual(h.errors,[]);}finally{h.close();}}
test('public bootstrap, shared priority, app prefix and Configure lifecycle',()=>use({},async({w,open})=>{
  assert.equal(w.document.querySelector('.empty-logo img').src,'https://example.test/prefix/'+imagePath);
  assert.equal(w.document.querySelector('link[rel=icon]').getAttribute('href'),'native.png');
  assert.equal(w.localStorage.getItem('hermes-ext-custom-branding-favicon'),local);
  await open(); assert.ok(nameInput(w)); assert.equal(w.document.querySelectorAll('details input').length,0);
  button(w,'Close').click(); assert.equal(w.document.querySelector('.hwx-branding-picker'),null);
}));
test('shipped core: no initial probe, direct personal controls, no dead shared section',()=>use({bootstrap:null,value:null,status:404},async({w,requests,open})=>{
  assert.equal(requests.length,0); await open();
  assert.equal(requests.length,1); assert.equal(w.document.querySelectorAll('.hwx-branding-section').length,2);
  assert.equal(w.document.querySelector('details'),null);
  assert.doesNotMatch(w.document.querySelector('.hwx-branding-picker').textContent,/Shared|404|Failed to fetch|public/);
  button(w,'Remove').click(); assert.equal(w.document.querySelector('details'),null);
  assert.equal(w.localStorage.getItem('hermes-ext-custom-branding-logo'),null);
}));
for (const invalid of ['http://[','../api/status','https://evil.test/icon.png','/prefix/'+imagePath,imagePath+'?x',imagePath.replace('/icon','/../icon')]) {
  test('invalid bootstrap icon '+invalid,()=>use({bootstrap:{api_version:1,effective:{...effective,icon_512:invalid}},value:null,status:404},async({w,open})=>{
    assert.equal(w.document.querySelector('.empty-logo img').src,local);await open();
    assert.equal(nameInput(w),null);assert.ok(button(w,'Remove'));
  }));
}
for (const invalid of [[],null,{api_version:'1',effective},{api_version:1,effective:[]},{api_version:1,effective:{...effective,active:'true'}},{api_version:1,effective:{...effective,name:8}}]) {
  test('invalid bootstrap shape '+JSON.stringify(invalid),()=>use({bootstrap:invalid,status:404},async({w,open})=>{await open();assert.equal(w.document.querySelector('.empty-logo img').src,local);}));
}
const malformed=[null,[],{...state,api_version:'1'},{...state,config:[]},{...state,config:null},{...state,config:{...state.config,enabled:'true'}},{...state,config:{...state.config,instance_name:9}},{...state,config:{...state.config,manages_instance_name:1}},...['can_manage','can_upload','provider_available','name_supported'].map(k=>({...state,[k]:'true'})),{...state,effective:{...effective,icon_512:'http://['}},{...state,effective:{...effective,icon_512:'../api/status'}}];
for (const [i,value] of malformed.entries()) {
  test('GET rejects malformed state '+i+' without losing last valid projection',()=>use({},async({w,open,setReply})=>{
    await open();setReply(async()=>({status:200,value}));button(w,'Close').click();await open();
    assert.equal(w.document.querySelector('.empty-logo img').src,'https://example.test/prefix/'+imagePath);
    assert.ok(nameInput(w));assert.ok(button(w,'Retry'));
  }));
}
test('temporary error has safe Retry and retains personal controls',()=>use({bootstrap:{api_version:1,effective:{...effective,active:false}},status:503},async({w,open,setReply})=>{
  await open();assert.match(w.document.body.textContent,/Shared branding isn't available right now/);
  assert.ok(button(w,'Remove'));setReply(async()=>({status:200,value:state}));button(w,'Retry').click();await tick();assert.ok(nameInput(w));
}));
test('non-manager sees a sentence without a disabled form or clickable brand',()=>use({value:{...state,can_manage:false,can_upload:false}},async({w,open})=>{
  await open();assert.equal(nameInput(w),null);assert.match(w.document.body.textContent,/sign in as owner/);
  assert.equal(w.document.querySelector('.app-titlebar-icon').getAttribute('role'),null);
  assert.equal(w.document.querySelector('.empty-logo').getAttribute('role'),null);
}));
test('native Configure removes empty-state trigger; personal mode still works',()=>use({bootstrap:null,status:404},async({w,open})=>{
  assert.equal(w.document.querySelector('.empty-logo').getAttribute('role'),null);await open();assert.ok(button(w,'Remove'));
}));
test('Escape stops core handler, keeps Settings, restores Configure focus and draft',()=>use({},async({w,open})=>{
  await open();nameInput(w).value='Unsaved draft';nameInput(w).dispatchEvent(new w.Event('input'));
  let coreClosed=false;w.document.addEventListener('keydown',()=>{coreClosed=true;});
  w.document.activeElement.dispatchEvent(new w.KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}));
  assert.equal(coreClosed,false);assert.equal(w.document.activeElement.id,'configure');await open();assert.equal(nameInput(w).value,'Unsaved draft');
  w.document.body.dispatchEvent(new w.Event('pointerdown',{bubbles:true}));await open();assert.equal(nameInput(w).value,'Unsaved draft');
}));
test('412 preserves draft and requires explicit refresh, never replays a mutation',()=>use({},async({w,requests,open,setReply})=>{
  await open();nameInput(w).value='My draft';nameInput(w).dispatchEvent(new w.Event('input'));
  setReply(async(_url,opts)=>({status:opts.method==='POST'?412:200,value:{...state,config:{...state.config,instance_name:'Other owner'}},etag:'"new-etag"'}));
  const before=requests.length;button(w,'Save').click();await tick();
  assert.equal(nameInput(w).value,'My draft');assert.match(w.document.querySelector('.hwx-branding-save-status').textContent,/Changed elsewhere/);
  assert.equal(requests.length,before+1);assert.equal(button(w,'Save').disabled,true);
  button(w,'Refresh shared settings').click();await tick();assert.equal(nameInput(w).value,'My draft');assert.equal(button(w,'Save').disabled,false);
  button(w,'Save').click();await tick();const posts=requests.filter(r=>r.options.method==='POST');assert.equal(posts.length,2);
  assert.equal(posts[1].options.headers['If-Match'],'"new-etag"');assert.equal(JSON.parse(posts[1].options.body).instance_name,'My draft');
}));
for (const [i,value] of malformed.entries()) {
  test('POST rejects malformed canonical state '+i,()=>use({},async({w,requests,open,setReply})=>{
    await open();setReply(async()=>({status:200,value}));button(w,'Save').click();await tick();
    assert.match(w.document.querySelector('.hwx-branding-save-status').textContent,/could not be confirmed/);
    assert.equal(w.document.querySelector('.empty-logo img').src,'https://example.test/prefix/'+imagePath);
    assert.equal(requests.filter(r=>r.options.method==='POST').length,1);assert.equal(button(w,'Save').disabled,true);
  }));
}
test('Save stages image without upload then chains exact ETags and CSRF',()=>use({value:{...state,config:{...state.config,enabled:false},effective:{...effective,active:false}}},async({w,requests,open,setReply})=>{
  await open();const file=w.document.querySelector('[data-shared-image]');
  Object.defineProperty(file,'files',{value:[new w.File(['png'],'shared.png',{type:'image/png'})]});file.dispatchEvent(new w.Event('change'));await tick();
  assert.equal(requests.filter(r=>r.options.method==='POST').length,0);
  const enable=w.document.querySelector('[data-shared-enabled]');enable.checked=true;enable.dispatchEvent(new w.Event('change'));
  let count=0;setReply(async()=>({status:200,value:state,etag:'"step-'+(++count)+'"'}));
  button(w,'Save').click();await tick();const posts=requests.filter(r=>r.options.method==='POST');assert.equal(posts.length,2);
  assert.equal(posts[0].url,'https://example.test/prefix/api/instance-branding/image');assert.equal(posts[0].options.headers['If-Match'],'"exact-etag"');
  assert.equal(posts[1].options.headers['If-Match'],'"step-1"');assert.equal(posts[1].options.headers['X-Hermes-CSRF-Token'],'test-only');
  assert.deepEqual(JSON.parse(posts[1].options.body),{instance_name:'Team Console',manages_instance_name:true,enabled:true});
}));
test('missing normalizer disables upload only; missing provider still permits disable/reset',()=>use({value:{...state,can_upload:false}},async({w,open})=>{
  await open();assert.equal(button(w,'Save').disabled,false);assert.equal(w.document.querySelector('[data-shared-image]').disabled,true);
}));
test('transport errors stay private and Retry recovers',()=>use({},async({w,open,setReply})=>{
  await open();setReply(async()=>{throw new Error('Failed to fetch private transport detail');});
  button(w,'Close').click();await open();
  assert.ok(button(w,'Retry'));assert.doesNotMatch(w.document.body.textContent,/Failed to fetch|private transport/);
  setReply(async()=>({status:200,value:state}));button(w,'Retry').click();await tick();assert.equal(button(w,'Save').disabled,false);
}));
test('cancelled activation sends neither the staged image nor the patch',()=>use({value:{...state,config:{...state.config,enabled:false},effective:{...effective,active:false}}},async({w,open,requests})=>{
  await open();const enable=w.document.querySelector('[data-shared-enabled]');enable.checked=true;enable.dispatchEvent(new w.Event('change'));
  w.confirm=()=>false;button(w,'Save').click();await tick();assert.equal(requests.filter(r=>r.options.method==='POST').length,0);
}));
test('partial image success keeps draft, reports the result, never uploads it again',()=>use({},async({w,open,requests,setReply})=>{
  await open();nameInput(w).value='Retained name';nameInput(w).dispatchEvent(new w.Event('input'));
  const input=w.document.querySelector('[data-shared-image]');Object.defineProperty(input,'files',{value:[new w.File(['png'],'shared.png',{type:'image/png'})]});input.dispatchEvent(new w.Event('change'));
  setReply(async(url,opts)=>({status:opts.method==='POST'&&!String(url).endsWith('/image')?412:200,value:state,etag:'"canonical-image"'}));
  button(w,'Save').click();await tick();assert.match(w.document.querySelector('.hwx-branding-save-status').textContent,/Image saved;.*Changed elsewhere/);
  assert.equal(nameInput(w).value,'Retained name');button(w,'Refresh shared settings').click();await tick();
  button(w,'Save').click();await tick();assert.equal(requests.filter(r=>r.options.method==='POST'&&r.url.endsWith('/image')).length,1);
}));
test('provider unavailable still permits explicit disable and reset',()=>use({value:{...state,provider_available:false,can_upload:false,effective:{...effective,active:false,icon_512:null}}},async({w,open,requests})=>{
  await open();assert.equal(nameInput(w).disabled,true);assert.equal(button(w,'Disable sharing').disabled,false);
  assert.equal(button(w,'Reset shared branding…').disabled,false);button(w,'Disable sharing').click();await tick();
  assert.deepEqual(JSON.parse(requests.find(r=>r.options.method==='POST').options.body),{enabled:false});
}));
test('details stay open after personal refresh and dialog body rebuild',()=>use({},async({w,open})=>{
  await open();const details=w.document.querySelector('details');details.open=true;details.dispatchEvent(new w.Event('toggle'));
  button(w,'Save').click();await tick();assert.equal(w.document.querySelector('details').open,true);
}));
test('untouched defaults follow a fresh read; typed drafts survive it',()=>use({},async({w,open,setReply})=>{
  await open();button(w,'Close').click();setReply(async()=>({status:200,value:{...state,config:{...state.config,instance_name:'Fresh name'}}}));
  await open();assert.equal(nameInput(w).value,'Fresh name');
  nameInput(w).value='Typed';nameInput(w).dispatchEvent(new w.Event('input'));button(w,'Close').click();await open();assert.equal(nameInput(w).value,'Typed');
}));
let failures=0;
for(const {name,fn} of tests){try{await fn();console.log('PASS '+name);}catch(error){failures++;console.error('FAIL '+name+'\n'+error.stack);}}
assert.equal(unhandled,0,'No unhandled asynchronous rejection is allowed');
assert.equal(failures,0,`${failures}/${tests.length} behavioral cases failed`);
console.log(`Custom Branding: ${tests.length} behavioral cases passed`);
