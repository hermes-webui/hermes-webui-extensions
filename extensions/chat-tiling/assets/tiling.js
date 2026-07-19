// Chat Tiling — multi-session tile grid for Hermes WebUI
// Stable API consumer: registerHermesSessionOpenHandler + renderTranscript
// Requires WebUI >= 2026-07.18 (the release that shipped these hooks)

(()=>{
'use strict';

// ── Feature detection (Breakage #7) ──
// All three must exist before we inject any UI. If msgInner isn't in the DOM
// yet, defer to DOMContentLoaded and re-check.
function hasStableApi(){
  return !!document.getElementById('msgInner')
    && typeof window.registerHermesSessionOpenHandler==='function'
    && typeof window.renderTranscript==='function';
}

// ── CSS (inlined) ──
function injectCss(){
  if(document.getElementById('ext-tiling-css'))return;
  document.head.appendChild(Object.assign(document.createElement('style'),{id:'ext-tiling-css',textContent:`
#ext-tile-grid{position:relative;overflow:hidden;display:none;flex:1 1 0%;min-height:0;min-width:0;gap:4px;padding:4px;background:var(--bg)}
#ext-tile-grid.ext-tile-grid--active{display:grid;align-items:normal;justify-content:normal;border-top:2px solid var(--accent)}
body.ext-tiling-body #messages>:not(#ext-tile-grid){display:none!important}
body.ext-tiling-body #messages{overflow:hidden}
.ext-tile{display:flex;flex-direction:column;min-width:0;min-height:0;background:var(--bg);border:1px solid var(--border);border-radius:10px;overflow:hidden}
.ext-tile--hidden{display:none!important}
.ext-tile--focused{border-color:var(--accent);box-shadow:0 0 0 1px var(--accent-bg-strong)}
.ext-tile--maximized{border-radius:0;border:none;grid-column:1/-1;grid-row:1/-1;z-index:1}
.ext-tile-header{display:flex;align-items:center;justify-content:space-between;padding:4px 8px;gap:6px;flex-shrink:0;min-height:32px;background:var(--sidebar);color:var(--text);border-bottom:1px solid var(--border)}
.ext-tile-header-left{display:flex;align-items:center;gap:6px;min-width:0;flex:1}
.ext-tile-dot{width:7px;height:7px;border-radius:999px;background:var(--accent);box-shadow:0 0 0 2px var(--accent-bg);flex-shrink:0}
.ext-tile-dot[hidden]{display:none}
.ext-tile-title{font-size:12px;font-weight:600;color:var(--text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:none;min-width:0}
.ext-tile-header-actions{display:flex;align-items:center;gap:2px;flex-shrink:0}
.ext-tile-btn{width:22px;height:22px;display:inline-flex;align-items:center;justify-content:center;border:none;background:transparent;border-radius:5px;color:var(--muted);cursor:pointer;transition:background .15s,color .15s}
.ext-tile-btn[hidden]{display:none!important}
.ext-tile-btn:hover{background:var(--hover-bg);color:var(--text)}
.ext-tile-body{flex:1;min-height:0;overflow:hidden;display:flex;flex-direction:column}
.ext-tile-msg-inner{flex:1;min-height:0;overflow-y:auto;padding:0;scroll-behavior:smooth;display:flex;flex-direction:column}
.ext-tile-sidebar-badge{display:inline-flex;align-items:center;justify-content:center;min-width:16px;height:16px;padding:0 4px;border-radius:999px;background:var(--accent);color:#fff;font-size:10px;font-weight:700;line-height:1;margin-left:4px;vertical-align:middle}
#ext-tiling-toolbar{display:none;flex-direction:row;align-items:center;gap:1px;margin-left:2px;padding:0 4px;height:28px;border-left:1px solid var(--border);position:relative}
#ext-tiling-toolbar.ext-tiling-toolbar--visible{display:flex}
.ext-toolbar-btn{display:flex;align-items:center;justify-content:center;width:26px;height:26px;border:none;background:transparent;border-radius:6px;color:var(--muted);cursor:pointer;position:relative;transition:background .15s,color .15s;-webkit-app-region:no-drag}
.ext-toolbar-btn:hover{background:var(--hover-bg);color:var(--text)}
.ext-toolbar-btn.ext-toolbar-btn--active{background:var(--accent-bg);color:var(--accent)}
.ext-toolbar-btn svg{width:16px;height:16px}
.ext-toolbar-divider{width:1px;height:16px;margin:0 3px;background:var(--border);flex-shrink:0}
.ext-toolbar-btn[data-tooltip]:hover::after{content:attr(data-tooltip);position:absolute;top:100%;margin-top:4px;padding:4px 8px;border-radius:6px;background:var(--text);color:var(--bg);font-size:11px;white-space:nowrap;pointer-events:none;z-index:10000}
`}));
}

// ── State ──
const T={tiles:[],activeId:null,nextId:1,grid:null,tb:null,visible:false,_w:null,_tc:{},_saved:null,pendingTile:null,pendingTimer:null};
const tid=i=>T.tiles.find(t=>t.id===i),bySid=s=>T.tiles.find(t=>t.sid===s),at=()=>tid(T.activeId);
const gs=(k,d)=>{try{const w=window.HermesExtensionSettings;if(w){const x=w.settingsForExtension('chat-tiling');return x.get(k)!=null?x.get(k):d}}catch(_){}return d};

// ── Composer save/restore ──
function sc(t){if(!t)return;const m=document.getElementById('msg');if(m)t.cv=m.value;const ms=document.getElementById('modelSelect');if(ms)t.mv=ms.value}
function rc(t){
  if(!t)return;
  const m=document.getElementById('msg');
  // Breakage #6: always clear composer, even when empty
  if(m)m.value=t.cv||'';
  // Breakage #6: use real resize path instead of nonexistent triggerMsgh
  if(typeof autoResize==='function')autoResize();
  const ms=document.getElementById('modelSelect');
  if(ms&&t.mv&&t.mv!==ms.value){ms.value=t.mv;typeof _onModelSelectChange==='function'&&_onModelSelectChange()}
}

// ── SVG icons ──
const Svg={
max:'<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/></svg>',
unmax:'<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="4 14 10 14 10 20"/><polyline points="20 10 14 10 14 4"/><line x1="14" y1="10" x2="21" y2="3"/><line x1="3" y1="21" x2="10" y2="14"/></svg>',
close:'<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>',
tb2:'<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="3" width="8" height="18" rx="1"/><rect x="13" y="3" width="8" height="18" rx="1"/></svg>',
tb4:'<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="3" width="8" height="8" rx="1"/><rect x="13" y="3" width="8" height="8" rx="1"/><rect x="3" y="13" width="8" height="8" rx="1"/><rect x="13" y="13" width="8" height="8" rx="1"/></svg>',
tb6:'<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="2" y="3" width="5" height="8" rx="1"/><rect x="8.5" y="3" width="5" height="8" rx="1"/><rect x="15" y="3" width="5" height="8" rx="1"/><rect x="2" y="13" width="5" height="8" rx="1"/><rect x="8.5" y="13" width="5" height="8" rx="1"/><rect x="15" y="13" width="5" height="8" rx="1"/></svg>',
tbX:'<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>'
};

// ── Tile element creation ──
function createTile(t){
  const el=document.createElement('div');
  el.className='ext-tile';el.dataset.tileId=t.id;
  el.innerHTML=`<div class="ext-tile-header"><div class="ext-tile-header-left"><span class="ext-tile-dot" hidden></span><span class="ext-tile-title"></span></div><div class="ext-tile-header-actions"><button class="ext-tile-btn ext-tile-maximize-btn" title="Maximize" aria-label="Maximize">${Svg.max}</button><button class="ext-tile-btn ext-tile-unmaximize-btn" title="Restore" aria-label="Restore" hidden>${Svg.unmax}</button><button class="ext-tile-btn ext-tile-close-btn" title="Close" aria-label="Close">${Svg.close}</button></div></div><div class="ext-tile-body"><div class="ext-tile-msg-inner"></div></div>`;
  el.querySelector('.ext-tile-maximize-btn').onclick=e=>{e.stopPropagation();toggleMax(t.id)};
  el.querySelector('.ext-tile-unmaximize-btn').onclick=e=>{e.stopPropagation();toggleMax(t.id)};
  el.querySelector('.ext-tile-close-btn').onclick=e=>{e.stopPropagation();closeTile(t.id)};
  el.querySelector('.ext-tile-body').onclick=()=>focusTile(t.id);
  el.querySelector('.ext-tile-header').onclick=e=>{if(!e.target.closest('.ext-tile-btn'))focusTile(t.id)};
  return el;
}

function updateHeader(t){
  const el=t.el||T.grid&&T.grid.querySelector(`.ext-tile[data-tile-id="${t.id}"]`);
  if(!el)return;
  const title=t.session?(t.session.display_title||t.session._state_db_title||t.session.title||'New Chat'):'';
  el.querySelector('.ext-tile-title').textContent=title||'Empty tile';
  el.querySelector('.ext-tile-dot').hidden=!t.busy;
}

// ── Focus switching ──
function focusTile(id,opts){
  opts=opts||{};
  const tile=tid(id);if(!tile)return;
  // Save outgoing tile state
  if(T.activeId&&T.activeId!==id){const o=at();if(o){sc(o);if(typeof S!=='undefined'){o.messages=[...(S.messages||[])];o.busy=!!S.busy;o.activeStreamId=S.activeStreamId||null;o.session=S.session}}}
  // Swap msgInner ID
  const cur=document.getElementById('msgInner');if(cur)cur.removeAttribute('id');
  T.activeId=id;
  T.tiles.forEach(t=>{if(t.el)t.el.classList.toggle('ext-tile--focused',t.id===id)});
  const ni=tile.el&&tile.el.querySelector('.ext-tile-msg-inner');if(ni)ni.id='msgInner';
  // Restore incoming tile
  if(!opts.alreadyLoaded){
    // Breakage #3: use loadSession for full hydration instead of manual S.* swap
    if(tile.sid&&typeof window.loadSession==='function'){
      window.loadSession(tile.sid,{skipExtHooks:true}).then(()=>{
        if(typeof S!=='undefined'){tile.messages=[...(S.messages||[])];tile.busy=!!S.busy;tile.activeStreamId=S.activeStreamId||null;tile.session=S.session}
        renderMsgs(tile);updateHeader(tile);
      }).catch(()=>{restoreFromTile(tile)});
    } else {
      restoreFromTile(tile);
    }
  }
  rc(tile);
  if(typeof syncTopbar==='function')syncTopbar();
  if(typeof syncModelChip==='function')syncModelChip();
  updateHeader(tile);startWatcher();
}

// Breakage #3 fallback: manual S.* swap when loadSession is unavailable
function restoreFromTile(tile){
  if(typeof S!=='undefined'){S.session=tile.session;S.messages=[...(tile.messages||[])];S.busy=!!tile.busy;S.activeStreamId=tile.activeStreamId||null}
  if(typeof renderMessages==='function')renderMessages();
}

// ── Open session in tile ──
function openTile(sid,data){
  if(!sid)return;const e=bySid(sid);if(e){focusTile(e.id);return}
  const t=T.tiles.find(t=>!t.sid);if(!t){typeof showToast==='function'&&showToast('All tiles in use. Close one first.',3e3,'error');return}
  t.sid=sid;t.session=data||null;t.messages=(data&&data.messages)||[];t.cv='';t.mv=null;
  updateHeader(t);badge(sid,1);renderMsgs(t);focusTile(t.id);
  if(!t.messages.length&&sid){(async()=>{try{const f=await window.api(`/api/session?session_id=${encodeURIComponent(sid)}&resolve_model=0`);if(f&&f.messages){t.messages=f.messages||[];t.session=f;if(T.activeId===t.id&&typeof S!=='undefined'){S.messages=t.messages;S.session=t.session}renderMsgs(t);updateHeader(t)}}catch(_){}})()}
}

// ── Render messages ──
function renderMsgs(t){
  const mi=t.el&&t.el.querySelector('.ext-tile-msg-inner');if(!mi)return;
  window.renderTranscript(mi,t.messages||[],{skipEmpty:false});
  mi.scrollTop!==undefined&&(mi.scrollTop=mi.scrollHeight);
}

// ── Maximize / Unmaximize ──
function toggleMax(id){
  const t=tid(id);if(!t)return;
  if(t.maximized){
    t.maximized=false;if(t.el){t.el.classList.remove('ext-tile--maximized');t.el.querySelector('.ext-tile-maximize-btn').hidden=false;t.el.querySelector('.ext-tile-unmaximize-btn').hidden=true}
    T.tiles.forEach(x=>{if(x.el)x.el.classList.remove('ext-tile--hidden')})
  } else {
    T.tiles.filter(x=>x.maximized).forEach(x=>{x.maximized=false;if(x.el){x.el.classList.remove('ext-tile--maximized','ext-tile--hidden');x.el.querySelector('.ext-tile-maximize-btn').hidden=false;x.el.querySelector('.ext-tile-unmaximize-btn').hidden=true}})
    t.maximized=true;if(t.el){t.el.classList.add('ext-tile--maximized');t.el.querySelector('.ext-tile-maximize-btn').hidden=true;t.el.querySelector('.ext-tile-unmaximize-btn').hidden=false}
    T.tiles.forEach(x=>{if(x.el)x.el.classList.toggle('ext-tile--hidden',!x.maximized)})
  }
  refreshGrid();
}

// ── Close tile ──
function closeTile(id){
  const idx=T.tiles.findIndex(t=>t.id===id);if(idx<0)return;
  const t=T.tiles[idx];
  if(t.busy&&t.activeStreamId&&typeof cancelSessionStream==='function')cancelSessionStream(t.session);
  if(t.session&&typeof INFLIGHT!=='undefined'&&INFLIGHT[t.session.session_id]){delete INFLIGHT[t.session.session_id];typeof clearInflightState==='function'&&clearInflightState(t.session.session_id)}
  if(t.el){const mi=t.el.querySelector('.ext-tile-msg-inner');if(mi&&mi.id==='msgInner')mi.removeAttribute('id');t.el.remove()}
  T.tiles.splice(idx,1);
  if(t.maximized){T.tiles.forEach(x=>{x.maximized=false;if(x.el){x.el.classList.remove('ext-tile--hidden','ext-tile--maximized');x.el.querySelector('.ext-tile-maximize-btn').hidden=false;x.el.querySelector('.ext-tile-unmaximize-btn').hidden=true}})}
  if(t.sid)badge(t.sid,-1);
  if(T.activeId===id){T.activeId=null;const n=T.tiles[0];if(n)focusTile(n.id);else hideGrid()}
  refreshGrid();tbActive();
}

// ── Grid ──
function refreshGrid(){
  if(!T.grid)return;
  T.grid.classList.toggle('ext-tile-grid--empty',T.tiles.length===0);
  if(T._cols&&T._rows){T.grid.style.gridTemplateColumns=`repeat(${T._cols},1fr)`;T.grid.style.gridTemplateRows=`repeat(${T._rows},1fr)`}
}

// ── Busy watcher ──
function startWatcher(){stopWatcher();T._w=setInterval(()=>{
  const t=at();if(!t||T.activeId===null){stopWatcher();return}
  if(typeof S!=='undefined'){if(S.messages&&S.messages.length>0)t.messages=[...S.messages];t.busy=!!S.busy;t.activeStreamId=S.activeStreamId||null;if(!S.busy&&t.session)t.session=S.session}
  updateHeader(t);
},500)}
function stopWatcher(){T._w&&(clearInterval(T._w),T._w=null)}

// ── Sidebar badge ──
function badge(sid,delta){
  if(!sid)return;
  T._tc[sid]=(T._tc[sid]||0)+delta;
  applyBadges();
}

function applyBadges(){
  // Breakage #4: use [data-sid] selector (core sidebar rows are .session-item[data-sid])
  document.querySelectorAll('.ext-tile-sidebar-badge').forEach(b=>b.remove());
  Object.entries(T._tc).forEach(([sid,count])=>{
    if(count<=0)return;
    if(!gs('show_sidebar_badges',true))return;
    const safeId=(typeof CSS!=='undefined'&&CSS.escape)?CSS.escape(sid):sid.replace(/[^a-zA-Z0-9_-]/g,'');
    const row=document.querySelector(`.session-item[data-sid="${safeId}"]`);
    if(!row)return;
    const b=document.createElement('span');
    b.className='ext-tile-sidebar-badge';
    b.textContent=count>9?'9+':String(count);
    (row.querySelector('.session-row-right')||row.querySelector('.session-meta')||row).appendChild(b);
  });
}

// Breakage #4: reapply badges after core rebuilds the sidebar
function initBadgeObserver(){
  const sidebar=document.querySelector('.session-list')||document.querySelector('[data-session-list]');
  if(!sidebar)return;
  const obs=new MutationObserver(()=>applyBadges());
  obs.observe(sidebar,{childList:true,subtree:true});
}

// ── Show / Hide grid ──
function showGrid(cols,rows){
  if(T.visible&&T._cols===cols&&T._rows===rows)return;
  if(T.visible)closeAll();
  T._cols=cols;T._rows=rows;T.visible=true;
  if(typeof S!=='undefined'&&!T._saved){T._saved={session:S.session,messages:[...(S.messages||[])],busy:!!S.busy,activeStreamId:S.activeStreamId||null}}
  const o=document.getElementById('msgInner');if(o){o.removeAttribute('id');o.classList.add('messages-inner--idle')}
  document.body.classList.add('ext-tiling-body');
  T.grid.style.display='';T.grid.classList.add('ext-tile-grid--active');
  T.grid.style.gridTemplateColumns=`repeat(${cols},1fr)`;T.grid.style.gridTemplateRows=`repeat(${rows},1fr)`;
  closeAll();
  for(let i=0;i<cols*rows;i++){
    const t={id:T.nextId++,sid:null,session:null,messages:[],busy:false,activeStreamId:null,maximized:false,el:null,cv:'',mv:null};
    T.tiles.push(t);t.el=createTile(t);T.grid.appendChild(t.el);updateHeader(t)
  }
  refreshGrid();T.tiles.length>0&&focusTile(T.tiles[0].id);
  tbActive();try{localStorage.setItem('hermes-ext-tiling-layout',`${cols}x${rows}`)}catch(_){}
}

function hideGrid(){
  if(!T.visible&&!T._saved){tbActive();return}
  T.visible=false;stopWatcher();
  document.querySelectorAll('.ext-tile-msg-inner[id="msgInner"]').forEach(el=>el.removeAttribute('id'));
  const o=document.querySelector('#messages>.messages-inner--idle');if(o){o.id='msgInner';o.classList.remove('messages-inner--idle')}
  document.body.classList.remove('ext-tiling-body');
  closeAll();
  T.grid.style.display='none';T.grid.classList.remove('ext-tile-grid--active');
  // Breakage #5: don't force emptyState display; call core renderMessages() after restoring S
  if(typeof S!=='undefined'){const s=T._saved;T._saved=null;S.session=s?s.session:null;S.messages=s?[...s.messages]:[];S.busy=s?!!s.busy:false;S.activeStreamId=s?s.activeStreamId||null:null}
  if(typeof renderMessages==='function')renderMessages();
  if(typeof syncTopbar==='function')syncTopbar();tbActive();
  try{localStorage.removeItem('hermes-ext-tiling-layout')}catch(_){}
}

function closeAll(){
  [...T.tiles].forEach(t=>{if(t.el){const mi=t.el.querySelector('.ext-tile-msg-inner');if(mi&&mi.id==='msgInner')mi.removeAttribute('id');t.el.remove()}});
  T.tiles=[];T.activeId=null;T._tc={};document.querySelectorAll('.ext-tile-sidebar-badge').forEach(b=>b.remove())
}

function initCapture(){
  // Breakage #2: handle {preload:true} phase to snapshot outgoing tile and
  // bind destination BEFORE core loads the new session.
  window.registerHermesSessionOpenHandler(function(sid,data,opts){
    if(!T.visible)return {};
    if(opts&&opts.preload&&sid){
      // Breakage #8: respect auto_tile setting
      if(!gs('auto_tile',true))return {};
      const t=T.tiles.find(t=>!t.sid);
      if(t&&!T.tiles.some(x=>x.sid===sid)){
        // Snapshot outgoing tile before core swaps S
        if(T.activeId){const o=at();if(o){sc(o);if(typeof S!=='undefined'){o.messages=[...(S.messages||[])];o.busy=!!S.busy;o.activeStreamId=S.activeStreamId||null;o.session=S.session}}}
        T.pendingTile=t;
        // Safety: clear pending if loaded never fires
        clearTimeout(T.pendingTimer);
        T.pendingTimer=setTimeout(()=>{T.pendingTile=null},5000);
      }
    }
    if(opts&&opts.loaded&&sid){
      const t=T.pendingTile||T.tiles.find(t=>!t.sid);
      T.pendingTile=null;clearTimeout(T.pendingTimer);
      if(t&&data){
        if(T.tiles.some(x=>x.sid===sid&&x!==t))return {};
        // Breakage #1: unwrap session/messages from handler data
        t.sid=sid;t.session=data.session||data;t.messages=(data.session?data.session.messages:data.messages)||[];t.cv='';t.mv=null;
        updateHeader(t);badge(sid,1);renderMsgs(t);
        focusTile(t.id,{alreadyLoaded:true});
        // Breakage #1: unwrap f.session.messages from /api/session response
        if(!t.messages.length&&sid){(async()=>{try{const f=await window.api(`/api/session?session_id=${encodeURIComponent(sid)}&resolve_model=0`);if(f){const msgs=(f.session&&f.session.messages)||f.messages||[];t.messages=msgs;t.session=f.session||f;if(T.activeId===t.id&&typeof S!=='undefined'){S.messages=t.messages;S.session=t.session}renderMsgs(t);updateHeader(t)}}catch(_){}})()}
      }
    }
    return {};
  });
}

// ── Toolbar ──
function createToolbar(){
  const tb=document.createElement('div');tb.id='ext-tiling-toolbar';
  tb.innerHTML=`<button class="ext-toolbar-btn" data-tooltip="Split 2 (horizontal)" aria-label="Split in 2" data-layout="2x1">${Svg.tb2}</button><button class="ext-toolbar-btn" data-tooltip="Split 4 (2x2 corners)" aria-label="Split in 4" data-layout="2x2">${Svg.tb4}</button><button class="ext-toolbar-btn" data-tooltip="Split 6 (3x2 grid)" aria-label="Split in 6" data-layout="3x2">${Svg.tb6}</button><div class="ext-toolbar-divider"></div><button class="ext-toolbar-btn" data-tooltip="Close all tiles" aria-label="Close tiling" data-layout="close">${Svg.tbX}</button>`;
  const titlebar=document.querySelector('header.app-titlebar');if(titlebar)titlebar.appendChild(tb);else document.body.appendChild(tb);
  tb.querySelectorAll('.ext-toolbar-btn').forEach(btn=>{btn.addEventListener('click',e=>{
    e.stopPropagation();const l=btn.dataset.layout;if(l==='close'){hideGrid();return}
    const[c,r]=l.split('x').map(Number);
    if(T.visible&&T._cols===c&&T._rows===r)hideGrid();else showGrid(c,r)
  })});
  T.tb=tb;
}

function tbActive(){
  if(!T.tb)return;T.tb.classList.toggle('ext-tiling-toolbar--visible',true);
  T.tb.querySelectorAll('.ext-toolbar-btn').forEach(btn=>{if(btn.dataset.layout==='close')return;const[c,r]=btn.dataset.layout.split('x').map(Number);btn.classList.toggle('ext-toolbar-btn--active',T.visible&&T._cols===c&&T._rows===r)})
}

// ── Keyboard ──
function initKeyboard(){
  document.addEventListener('keydown',e=>{
    if((e.ctrlKey||e.metaKey)&&e.altKey&&!e.repeat){const m={1:[1,1],2:[2,1],4:[2,2],6:[3,2]};if(m[e.key]){e.preventDefault();const[c,r]=m[e.key];if(T.visible)hideGrid();else showGrid(c,r)}}
  })
}

// ── Compatibility exports ──
window.openTileForSessionExt=openTile;window.focusTileExt=focusTile;window.closeTileExt=closeTile;window.maximizeTileExt=toggleMax;window.unmaximizeTileExt=toggleMax;

// ── Init ──
function init(){
  if(!hasStableApi()){
    // Breakage #7: quietly no-op if stable API unavailable
    console.debug('[chat-tiling] stable API unavailable, skipping init');
    return;
  }
  injectCss();
  T.grid=document.createElement('div');T.grid.id='ext-tile-grid';T.grid.className='ext-tile-grid';T.grid.style.display='none';
  const mi=document.getElementById('msgInner');if(mi&&mi.parentNode)mi.parentNode.appendChild(T.grid);
  createToolbar();tbActive();initCapture();initKeyboard();initBadgeObserver();
  // Breakage #8: use default_layout setting for initial restore
  try{const s=localStorage.getItem('hermes-ext-tiling-layout');if(s){const[c,r]=s.split('x').map(Number);if(c&&r&&c*r<=6)setTimeout(()=>showGrid(c,r),500)}else{const defLayout=gs('default_layout','4');const layoutMap={'2':[2,1],'4':[2,2],'6':[3,2]};const lr=layoutMap[defLayout];if(lr)setTimeout(()=>showGrid(lr[0],lr[1]),500)}}catch(_){}
}
document.readyState==='loading'?document.addEventListener('DOMContentLoaded',init):init();
})();
