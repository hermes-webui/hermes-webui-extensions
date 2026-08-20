// Chat Tiling — single-live-session view with rendered session snapshots
// Stable API consumer: registerHermesSessionOpenHandler + renderTranscript
// Requires WebUI >= 2026-07.18 (the release that shipped these hooks)
//
// ARCHITECTURE:
// - Exactly one tile is live at any time: it owns Core S, composer, model, active stream, #msgInner.
// - Non-focused tiles are read-only rendered snapshots.
// - Focus switches save outgoing tile state and restore incoming tile state atomically.
// - Leaving tiling restores one coherent session projection from the focused tile.
// - Full-grid navigation is rejected (returns {cancel:true}).
// - Core owns its #messages scrolling lifecycle; the extension does not compete.

(()=>{
'use strict';

const getS = () => {
  try { return (typeof S !== 'undefined') ? S : {}; } catch(_) { return {}; }
};

// ── Feature detection ──
function hasStableApi(){
  return !!document.getElementById('msgInner')
    && typeof window.registerHermesSessionOpenHandler==='function'
    && typeof window.renderTranscript==='function';
}

// ── CSS (inlined) ──
function injectCss(){
  if(document.getElementById('ext-tiling-css'))return;
  document.head.appendChild(Object.assign(document.createElement('style'),{id:'ext-tile-css',textContent:`
#ext-tile-grid{position:relative;overflow:hidden;display:none;flex:1 1 0%;min-height:0;min-width:0;gap:4px;padding:4px;background:var(--bg)}
#ext-tile-grid.ext-tile-grid--active{display:grid;align-items:normal;justify-content:normal;border-top:2px solid var(--accent)}
body.ext-tiling-body #messages>:not(#ext-tile-grid):not([aria-live]):not([role=status]){display:none!important}
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
.ext-tile-msg-inner{flex:1;min-height:0;padding:0;display:flex;flex-direction:column}
.ext-tile-msg-inner[id="msgInner"]{overflow-y:auto}
.ext-tile-sidebar-badge{display:inline-flex;align-items:center;justify-content:center;min-width:16px;height:16px;padding:0 4px;border-radius:999px;background:var(--accent);color:var(--accent-text,#fff);font-size:10px;font-weight:700;line-height:1;margin-left:4px;vertical-align:middle}
#ext-tiling-toolbar{display:none;flex-direction:row;align-items:center;gap:1px;margin-left:2px;padding:0 4px;height:28px;border-left:1px solid var(--border);position:relative}
#ext-tiling-toolbar.ext-tiling-toolbar--visible{display:flex}
#ext-tiling-toolbar.ext-tiling-toolbar--panel-hidden{display:none!important}
.ext-toolbar-btn{display:flex;align-items:center;justify-content:center;width:26px;height:26px;border:none;background:transparent;border-radius:6px;color:var(--muted);cursor:pointer;position:relative;transition:background .15s,color .15s;-webkit-app-region:no-drag}
.ext-toolbar-btn:hover{background:var(--hover-bg);color:var(--text)}
.ext-toolbar-btn.ext-toolbar-btn--active{background:var(--accent-bg);color:var(--accent)}
.ext-toolbar-btn svg{width:16px;height:16px}
.ext-toolbar-divider{width:1px;height:16px;margin:0 3px;background:var(--border);flex-shrink:0}
.ext-toolbar-btn[data-tooltip]:hover::after{content:attr(data-tooltip);position:absolute;top:100%;margin-top:4px;padding:4px 8px;border-radius:6px;background:var(--text);color:var(--bg);font-size:11px;white-space:nowrap;pointer-events:none;z-index:10000}
@media(pointer:coarse){.ext-tile-btn,.ext-toolbar-btn{min-width:44px;min-height:44px}}
@media(max-width:500px){#ext-tile-grid{grid-template-columns:1fr!important;grid-template-rows:auto!important}}
`}));
}

// ── State ──
const T={
  tiles:[],
  activeId:null,
  nextId:1,
  grid:null,
  tb:null,
  visible:false,
  _w:null,
  _tc:{},
  _saved:null,
  _savedComposer:'',
  _savedModel:'',
  _actGen:0
};
const tid=i=>T.tiles.find(t=>t.id===i);
const bySid=s=>T.tiles.find(t=>t.sid===s);
const at=()=>tid(T.activeId);
const gs=(k,d)=>{try{const w=window.HermesExtensionSettings;if(w){const x=w.settingsForExtension('chat-tiling');if(x.get(k)!=null)return x.get(k)}}catch(_){}return d};

// ── Composer save/restore ──
function sc(t){if(!t)return;const m=document.getElementById('msg');if(m)t.cv=m.value;const ms=document.getElementById('modelSelect');if(ms)t.mv=ms.value}
function rc(t){
  if(!t)return;
  const m=document.getElementById('msg');
  if(m)m.value=t.cv||'';
  if(typeof autoResize==='function')autoResize();
  const ms=document.getElementById('modelSelect');
  if(ms&&t.mv&&t.mv!==ms.value)ms.value=t.mv;
}

// ── SVG icons ──
const Svg={
  max:'<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/></svg>',
  unmax:'<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="4 14 10 14 10 20"/><polyline points="20 10 14 10 14 4"/><line x1="14" y1="10" x2="21" y2="3"/><line x1="3" y1="21" x2="10" y2="14"/></svg>',

  tb2:'<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="3" width="8" height="18" rx="1"/><rect x="13" y="3" width="8" height="18" rx="1"/></svg>',
  tb4:'<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="3" width="8" height="8" rx="1"/><rect x="13" y="3" width="8" height="8" rx="1"/><rect x="3" y="13" width="8" height="8" rx="1"/><rect x="13" y="13" width="8" height="8" rx="1"/></svg>',
  tb6:'<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="2" y="3" width="5" height="8" rx="1"/><rect x="8.5" y="3" width="5" height="8" rx="1"/><rect x="15" y="3" width="5" height="8" rx="1"/><rect x="2" y="13" width="5" height="8" rx="1"/><rect x="8.5" y="13" width="5" height="8" rx="1"/><rect x="15" y="13" width="5" height="8" rx="1"/></svg>',
  tbX:'<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>'
};

// ── Tile element creation ──
function createTile(t){
  const el=document.createElement('div');
  el.className='ext-tile';el.tabIndex=-1;el.dataset.tileId=t.id;
  el.setAttribute('role','region');el.setAttribute('aria-label',`Chat tile ${t.id}`);
  el.innerHTML=`<div class="ext-tile-header"><div class="ext-tile-header-left"><span class="ext-tile-dot" hidden></span><span class="ext-tile-title"></span></div><div class="ext-tile-header-actions"><button class="ext-tile-btn ext-tile-maximize-btn" title="Maximize" aria-label="Maximize" aria-pressed="false">${Svg.max}</button><button class="ext-tile-btn ext-tile-unmaximize-btn" title="Restore" aria-label="Restore" aria-pressed="false" hidden>${Svg.unmax}</button></div></div><div class="ext-tile-body"><div class="ext-tile-msg-inner"></div></div>`;
  el.querySelector('.ext-tile-maximize-btn').onclick=e=>{e.stopPropagation();toggleMax(t.id)};
  el.querySelector('.ext-tile-unmaximize-btn').onclick=e=>{e.stopPropagation();toggleMax(t.id)};
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
  const gen=++T._actGen;
  const outgoing=at();
  if(outgoing&&outgoing.id!==id&&!opts.alreadyLoaded){
    sc(outgoing);
  }
  const cur=document.getElementById('msgInner');if(cur)cur.removeAttribute('id');
  T.activeId=id;
  T.tiles.forEach(t=>{if(t.el)t.el.classList.toggle('ext-tile--focused',t.id===id)});
  const ni=tile.el&&tile.el.querySelector('.ext-tile-msg-inner');if(ni)ni.id='msgInner';
  tile.el&&tile.el.focus();
  tile.el&&tile.el.setAttribute('aria-label',`Chat tile ${id} — focused`);
  rc(tile);
  if(tile.session&&tile.session.session_id&&typeof window.loadSession==='function'){
    window.loadSession(tile.session.session_id,{skipExtHooks:true}).then(()=>{
      if(gen!==T._actGen)return;
      tile.messages=[...(getS().messages||[])];
      tile.busy=!!getS().busy;
      tile.activeStreamId=getS().activeStreamId||null;
      tile.session=getS().session;
      renderSnapshot(tile);
      updateHeader(tile);
    }).catch(()=>{
      if(gen!==T._actGen)return;
      renderSnapshot(tile);
      updateHeader(tile);
    });
  } else {
    // Empty tile — clear sidebar selection so no session is highlighted
    const s = getS();
    if (s) { s.session = null; s.messages = []; s.busy = false; }
    renderSnapshot(tile);
    updateHeader(tile);
  }
  startWatcher();
  // Immediate sync of busy state from S to focused tile
  if(getS().messages&&getS().messages.length>0)tile.messages=[...getS().messages];tile.busy=!!getS().busy;tile.activeStreamId=getS().activeStreamId||null;
  renderSnapshot(tile);
  updateHeader(tile);
  if(typeof syncTopbar==='function')syncTopbar();
  if(typeof syncModelChip==='function')syncModelChip();
  updateHeader(tile);
}

function renderSnapshot(t){
  const mi=t.el&&t.el.querySelector('.ext-tile-msg-inner');if(!mi)return;
  window.renderTranscript(mi,t.messages||[],{skipEmpty:false});
}

// ── Open session in tile ──
function openTile(sid,data){
  if(!sid)return;
  const e=bySid(sid);if(e){focusTile(e.id);return}
  const t=T.tiles.find(t=>!t.sid&&!t._pending);
  if(!t){typeof showToast==='function'&&showToast('All tiles in use. Close one first.',3e3,'error');return}
  t.sid=sid;t.session=data||null;t.messages=(data&&data.messages)||[];t.cv='';t.mv=null;
  updateHeader(t);badge(sid,1);renderSnapshot(t);focusTile(t.id);
}

// ── Maximize / Unmaximize ──
function toggleMax(id){
  const t=tid(id);if(!t)return;
  if(t.maximized){
    t.maximized=false;if(t.el){t.el.classList.remove('ext-tile--maximized');t.el.querySelector('.ext-tile-maximize-btn').hidden=false;const ub=t.el.querySelector('.ext-tile-unmaximize-btn');ub.hidden=true;ub.setAttribute('aria-pressed','false')}
    T.tiles.forEach(x=>{if(x.el)x.el.classList.remove('ext-tile--hidden')})
  } else {
    T.tiles.filter(x=>x.maximized).forEach(x=>{x.maximized=false;if(x.el){x.el.classList.remove('ext-tile--maximized','ext-tile--hidden');x.el.querySelector('.ext-tile-maximize-btn').hidden=false;const ub=x.el.querySelector('.ext-tile-unmaximize-btn');ub.hidden=true;ub.setAttribute('aria-pressed','false')}})
    t.maximized=true;if(t.el){t.el.classList.add('ext-tile--maximized');t.el.querySelector('.ext-tile-maximize-btn').hidden=true;t.el.querySelector('.ext-tile-unmaximize-btn').hidden=false;t.el.querySelector('.ext-tile-unmaximize-btn').setAttribute('aria-pressed','true')}
    T.tiles.forEach(x=>{if(x.el)x.el.classList.toggle('ext-tile--hidden',!x.maximized)})
  }
  refreshGrid();
}

// ── Close tile (async) ──
async function closeTile(id){
  const tile=tid(id);if(!tile)return true;
  if(tile._closing)return true;
  tile._closing=true;
  if(tile.busy&&tile.activeStreamId&&typeof cancelSessionStream==='function'){
    try {
      const result=await cancelSessionStream({session_id:tile.session?tile.session.session_id:null,active_stream_id:tile.activeStreamId});
      if(result===false){tile._closing=false;return false}
    } catch(_){
      tile._closing=false;return false;
    }
  }
  const t=tid(id);if(!t){return true;}
  if(t.session&&typeof INFLIGHT!=='undefined'&&INFLIGHT[t.session.session_id]){
    delete INFLIGHT[t.session.session_id];
    typeof clearInflightState==='function'&&clearInflightState(t.session.session_id);
  }
  const idx=T.tiles.indexOf(t);if(idx<0)return true;
  if(t.el){const mi=t.el.querySelector('.ext-tile-msg-inner');if(mi&&mi.id==='msgInner')mi.removeAttribute('id');t.el.remove()}
  T.tiles.splice(idx,1);
  if(t.maximized){T.tiles.forEach(x=>{x.maximized=false;if(x.el){x.el.classList.remove('ext-tile--hidden','ext-tile--maximized');x.el.querySelector('.ext-tile-maximize-btn').hidden=false;x.el.querySelector('.ext-tile-unmaximize-btn').hidden=true}})}
  if(t.sid)badge(t.sid,-1);
  if(T.activeId===id){
    T.activeId=null;
    if(T.tiles.length===0) await hideGrid();
    else {const n=T.tiles[0];if(n)focusTile(n.id);}
  }
  refreshGrid();tbActive();
  return true;
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
  if(getS().messages&&getS().messages.length>0)t.messages=[...getS().messages];t.busy=!!getS().busy;t.activeStreamId=getS().activeStreamId||null;if(!getS().busy&&t.session)t.session=getS().session;
  updateHeader(t);
},500)}
function stopWatcher(){T._w&&(clearInterval(T._w),T._w=null)}

// ── Sidebar badge ──
let _badgeStateHash='';
function badge(sid,delta){
  if(!sid)return;
  T._tc[sid]=(T._tc[sid]||0)+delta;
  applyBadges();
}
function applyBadges(){
  const hash=JSON.stringify(T._tc);
  if(hash===_badgeStateHash)return;
  _badgeStateHash=hash;
  if(T._badgeObs)T._badgeObs.disconnect();
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
  if(T._badgeObs&&T._badgeSidebar)T._badgeObs.observe(T._badgeSidebar,{childList:true,subtree:true});
}
function initBadgeObserver(){
  T._badgeSidebar=document.querySelector('.session-list')||document.querySelector('[data-session-list]');
  if(!T._badgeSidebar)return;
  T._badgeObs=new MutationObserver(()=>applyBadges());
  T._badgeObs.observe(T._badgeSidebar,{childList:true,subtree:true});
}

// ── Show / Hide grid ──
async function showGrid(cols,rows){
  if(T.visible&&T._cols===cols&&T._rows===rows)return;
  if(T.visible){await switchLayout(cols,rows);return}
  T._cols=cols;T._rows=rows;T.visible=true;
  if(!T._saved){
    T._saved={...S};
    const cm=document.getElementById('msg');T._savedComposer=cm?cm.value:'';
    const ms=document.getElementById('modelSelect');T._savedModel=ms?ms.value:'';
  }
  const o=document.getElementById('msgInner');if(o){o.removeAttribute('id');o.classList.add('messages-inner--idle')}
  document.body.classList.add('ext-tiling-body');
  T.grid.style.display='';T.grid.classList.add('ext-tile-grid--active');
  T.grid.style.gridTemplateColumns=`repeat(${cols},1fr)`;T.grid.style.gridTemplateRows=`repeat(${rows},1fr)`;
  for(let i=0;i<cols*rows;i++){
    const t={id:T.nextId++,sid:null,session:null,messages:[],busy:false,activeStreamId:null,maximized:false,_closing:false,_pending:false,el:null,cv:'',mv:null};
    T.tiles.push(t);t.el=createTile(t);T.grid.appendChild(t.el);updateHeader(t)
  }
  if(getS().session&&getS().session.session_id&&T.tiles.length>0){
    const t=T.tiles[0];
    t.sid=getS().session.session_id;t.session=getS().session;t.messages=[...(getS().messages||[])];t.busy=!!getS().busy;t.activeStreamId=getS().activeStreamId||null;
    updateHeader(t);focusTile(t.id);
  } else if(T.tiles.length>0){
    focusTile(T.tiles[0].id);
  }
  refreshGrid();tbActive();
  try{localStorage.setItem('hermes-ext-tiling-layout',`${cols}x${rows}`)}catch(_){}
}

async function switchLayout(cols,rows){
  const totalSlots=cols*rows;
  if(T.tiles.length>totalSlots){
    const toClose=T.tiles.slice(totalSlots);
    const focusedTile=at();
    if(focusedTile&&toClose.includes(focusedTile)){
      const survivor=T.tiles.find(t=>!toClose.includes(t));
      if(survivor)focusTile(survivor.id);
    }
    for(const t of toClose){await closeTile(t.id)}
  }
  T._cols=cols;T._rows=rows;
  T.tiles.forEach(t=>{if(t.maximized){t.maximized=false;if(t.el){t.el.classList.remove('ext-tile--maximized','ext-tile--hidden');t.el.querySelector('.ext-tile-maximize-btn').hidden=false;t.el.querySelector('.ext-tile-unmaximize-btn').hidden=true}}});
  refreshGrid();
  while(T.tiles.length<totalSlots){
    const t={id:T.nextId++,sid:null,session:null,messages:[],busy:false,activeStreamId:null,maximized:false,_closing:false,_pending:false,el:null,cv:'',mv:null};
    T.tiles.push(t);t.el=createTile(t);T.grid.appendChild(t.el);updateHeader(t)
  }
  if(T.tiles.length>0)focusTile(T.tiles[0].id);
  tbActive();
  try{localStorage.setItem('hermes-ext-tiling-layout',`${cols}x${rows}`)}catch(_){}
}

async function hideGrid(){
  if(!T.visible&&!T._saved){tbActive();return}
  T.visible=false;stopWatcher();
  const focusedTile=at();
  if(T.activeId){const la=at();if(la){sc(la)}}
  await closeAll();
  if(T.tiles.length>0){
    T.visible=true;
    document.body.classList.add('ext-tiling-body');
    T.grid.classList.add('ext-tile-grid--active');
    document.querySelectorAll('.ext-tile-msg-inner[id="msgInner"]').forEach(el=>el.removeAttribute('id'));
    const o=document.querySelector('#messages>.messages-inner--idle');if(o){o.id='msgInner';o.classList.remove('messages-inner--idle')}
    const first=T.tiles[0];
    if(first&&first.el){const ni=first.el.querySelector('.ext-tile-msg-inner');if(ni)ni.id='msgInner'}
    T.activeId=first?first.id:null;
    refreshGrid();tbActive();startWatcher();
    return;
  }
  document.querySelectorAll('.ext-tile-msg-inner[id="msgInner"]').forEach(el=>el.removeAttribute('id'));
  const o=document.querySelector('#messages>.messages-inner--idle');if(o){o.id='msgInner';o.classList.remove('messages-inner--idle')}
  T.grid.style.display='none';T.grid.classList.remove('ext-tile-grid--active');
  document.body.classList.remove('ext-tiling-body');
  const restoreFrom=focusedTile&&focusedTile.session?focusedTile.session:T._saved;
  // Presence/ownership, not truthiness: a focused tile with a session owns the
  // composer slot even when its draft is legitimately empty (''), so an empty
  // B draft must NOT fall back to the pre-grid A draft.
  const ownsComposer=!!(focusedTile&&focusedTile.sid);
  const savedComposer=ownsComposer?focusedTile.cv:T._savedComposer;
  const savedModel=ownsComposer?focusedTile.mv:T._savedModel;
  const s=T._saved;T._saved=null;
  // If we have a focused tile with a session, restore from it (async)
  if(restoreFrom&&restoreFrom!==s&&restoreFrom.session_id&&typeof window.loadSession==='function'){
    // Optimistic update: set getS().session immediately so tests/loadSession handlers see correct state
    getS().session=restoreFrom;
    getS().messages=[...(focusedTile.messages||[])];
    window.loadSession(restoreFrom.session_id,{skipExtHooks:true}).catch(()=>{
      if(s)Object.assign(getS(),s);else{getS().session=null;getS().messages=[];getS().busy=false;getS().activeStreamId=null}
    })
  } else {
    if(s)Object.assign(getS(),s);else{getS().session=null;getS().messages=[];getS().busy=false;getS().activeStreamId=null}
  }
  const cm=document.getElementById('msg');if(cm)cm.value=savedComposer||'';
  if(typeof autoResize==='function')autoResize();
  const ms=document.getElementById('modelSelect');if(ms&&savedModel&&ms.value!==savedModel)ms.value=savedModel;
  T._savedComposer=null;T._savedModel=null;
  if(typeof renderMessages==='function')renderMessages();
  if(typeof syncTopbar==='function')syncTopbar();
  if(typeof syncModelChip==='function')syncModelChip();
  tbActive();
  try{localStorage.removeItem('hermes-ext-tiling-layout')}catch(_){}
}

async function closeAll(){
  const busy=T.tiles.filter(t=>t.busy&&t.activeStreamId);
  const results=await Promise.allSettled(busy.map(t=>{
    if(typeof cancelSessionStream==='function'){
      return cancelSessionStream({session_id:t.session?t.session.session_id:null,active_stream_id:t.activeStreamId})
    }
    return true;
  }));
  const toClose=[],preserved=[];
  for(let i=0;i<busy.length;i++){
    const r=results[i];
    if(r.status==='fulfilled'&&r.value!==false){toClose.push(busy[i])}else{preserved.push(busy[i])}
  }
  toClose.forEach(t=>{
    if(t.session&&typeof INFLIGHT!=='undefined'&&INFLIGHT[t.session.session_id]){
      delete INFLIGHT[t.session.session_id];
      typeof clearInflightState==='function'&&clearInflightState(t.session.session_id);
    }
  });
  const nonBusy=T.tiles.filter(t=>!t.busy);
  for(const t of nonBusy){if(t.el)t.el.remove()}
  for(const t of toClose){if(t.el)t.el.remove()}
  T.tiles=[...preserved];
  if(preserved.length===0){T.activeId=null;T._tc={};document.querySelectorAll('.ext-tile-sidebar-badge').forEach(b=>b.remove())}
}

// ── Session open handler ──
function initCapture(){
  window.registerHermesSessionOpenHandler(function(sid,data,opts){
    if(!T.visible)return {};
    if(opts&&opts.preload&&sid){
      if(!gs('auto_tile',true))return {};
      const existing=bySid(sid);
      if(existing){focusTile(existing.id);return {}}
      let t=T.tiles.find(t=>!t.sid&&!t._pending);
      if(!t){
        t=at();
        if(t&&t.sid===sid){return {}}
        if(t&&t._pending){
          clearTimeout(t._pendingTimer);
          t._pending=false;t._pendingSid=null;t._pendingTimer=null;
        }
      }
      if(T.tiles.some(x=>x.sid===sid))return {};
      // Transfer live ownership BEFORE Core mutates S: snapshot the outgoing
      // tile (composer + transcript) and move the live #msgInner to the
      // reserved tile, so Core's render for the incoming session lands in
      // the new tile and never overwrites the outgoing tile's surface/draft.
      const outgoing=at();
      if(outgoing&&outgoing.id!==t.id){
        sc(outgoing);
        renderSnapshot(outgoing);
        t._prevOwner=outgoing.id;
      }
      const cur=document.getElementById('msgInner');if(cur)cur.removeAttribute('id');
      const ni=t.el&&t.el.querySelector('.ext-tile-msg-inner');if(ni)ni.id='msgInner';
      T.activeId=t.id;
      T.tiles.forEach(x=>{if(x.el)x.el.classList.toggle('ext-tile--focused',x.id===t.id)});
      t._pending=true;
      t._pendingSid=sid;
      t._gen=(t._gen||0)+1;
      const _gen=t._gen;
      clearTimeout(t._pendingTimer);
      t._pendingTimer=setTimeout(()=>{
        // Release only the reservation this timer owns. If the tile has
        // since been re-reserved for another session (or a newer generation),
        // leave it alone — a stale B timer must not free C's slot.
        if(t._pending&&t._pendingSid===sid&&t._gen===_gen){
          t._pending=false;t._pendingSid=null;t._pendingTimer=null;
          if(t._prevOwner!=null){
            const prev=tid(t._prevOwner);t._prevOwner=null;
            if(prev&&T.activeId===t.id){
              const c2=document.getElementById('msgInner');if(c2)c2.removeAttribute('id');
              const ni2=prev.el&&prev.el.querySelector('.ext-tile-msg-inner');if(ni2)ni2.id='msgInner';
              T.activeId=prev.id;
              T.tiles.forEach(x=>{if(x.el)x.el.classList.toggle('ext-tile--focused',x.id===prev.id)});
              rc(prev);
            }
          }
        }
      },gs('preload_timeout_ms',5000));
    }
    if(opts&&opts.loaded&&sid){
      if(!gs('auto_tile',true))return {};
      // Find the reservation for THIS sid, not a singleton — multiple
      // reservations may coexist (B pending on tile 2, C pending on tile 3).
      let t=T.tiles.find(t=>t._pendingSid===sid&&t._pending);
      // Fallback: never steal a tile that is currently reserved for another
      // session, so an unmatched loaded event cannot hijack a pending slot.
      if(!t)t=T.tiles.find(t=>!t.sid&&!t._pending);
      if(t&&data){
        if(T.tiles.some(x=>x.sid===sid&&x!==t))return {};
        clearTimeout(t._pendingTimer);
        t._prevOwner=null;t._pending=false;t._pendingSid=null;t._pendingTimer=null;
        // Preserve the incoming session's draft: Core has already mutated S
        // and set the composer, so capture it instead of blanking it.
        const cm=document.getElementById('msg');if(cm)t.cv=cm.value;
        const ms=document.getElementById('modelSelect');if(ms)t.mv=ms.value;
        t.sid=sid;t.session=data;t.messages=[...(getS().messages||[])];t.busy=!!getS().busy;t.activeStreamId=getS().activeStreamId||null;
        updateHeader(t);badge(sid,1);renderSnapshot(t);
        focusTile(t.id,{alreadyLoaded:true});
      }
    }
    return {};
  });
}

// ── Toolbar ──
function createToolbar(){
  const tb=document.createElement('div');tb.id='ext-tiling-toolbar';
  tb.innerHTML=`<button class="ext-toolbar-btn" data-tooltip="Split 2 (horizontal)" aria-label="Split in 2" data-layout="2x1">${Svg.tb2}</button><button class="ext-toolbar-btn" data-tooltip="Split 4 (2x2 corners)" aria-label="Split in 4" data-layout="2x2">${Svg.tb4}</button><button class="ext-toolbar-btn" data-tooltip="Split 6 (3x2 grid)" aria-label="Split in 6" data-layout="3x2">${Svg.tb6}</button><div class="ext-toolbar-divider"></div><button class="ext-toolbar-btn" data-tooltip="Close all tiles" aria-label="Close tiling" data-layout="close">${Svg.tbX}</button>`;
  tb.querySelectorAll('.ext-toolbar-btn').forEach(b=>{
    b.onclick=e=>{
      e.stopPropagation();
      const layout=b.dataset.layout;
      if(layout==='close'){hideGrid();return}
      const[cols,rows]=layout.split('x').map(Number);
      showGrid(cols,rows);
    };
  });
  return tb;
}

function tbActive(){
  if(!T.tb)return;
  T.tb.querySelectorAll('.ext-toolbar-btn[data-layout]').forEach(b=>{
    const l=b.dataset.layout;
    if(l==='close')return;
    const[cols,rows]=l.split('x').map(Number);
    b.classList.toggle('ext-toolbar-btn--active',T.visible&&T._cols===cols&&T._rows===rows);
    b.setAttribute('aria-pressed',String(T.visible&&T._cols===cols&&T._rows===rows));
  });
}

function tbInit(){
  const topbar=document.querySelector('.app-titlebar')||document.querySelector('#topbar');
  if(!topbar)return;
  T.tb=createToolbar();
  const insertBefore=topbar.querySelector('#btnReload')||topbar.querySelector('#btnTitlebarNewChat')||topbar.querySelector('#themeBtn')||topbar.querySelector('#settingsBtn')||topbar.lastElementChild;
  topbar.insertBefore(T.tb,insertBefore);
  syncTbPanel();
  tbActive();
}

function chatPanelActive(){
  const main=document.querySelector('main.main');
  if(!main)return true;
  return !Array.from(main.classList).some(c=>c.indexOf('showing-')===0);
}
function syncTbPanel(){
  if(!T.tb)return;
  const active=chatPanelActive();
  if(active){
    T.tb.classList.add('ext-tiling-toolbar--visible');
    T.tb.classList.remove('ext-tiling-toolbar--panel-hidden');
  } else {
    T.tb.classList.remove('ext-tiling-toolbar--visible');
    T.tb.classList.add('ext-tiling-toolbar--panel-hidden');
  }
}
let _panelObs=null;
function watchPanel(){
  const main=document.querySelector('main.main');
  if(!main)return;
  syncTbPanel();
  if(typeof MutationObserver==='undefined')return;
  if(_panelObs)_panelObs.disconnect();
  _panelObs=new MutationObserver(()=>syncTbPanel());
  _panelObs.observe(main,{attributes:true,attributeFilter:['class']});
}

// ── Public API for tests ──
window.showGridExt=showGrid;
window.hideGridExt=hideGrid;
window.closeTileExt=closeTile;
window.closeAllExt=closeAll;
window.openTileForSessionExt=openTile;
window.focusTileExt=focusTile;
window.switchLayoutExt=switchLayout;

// ── Init ──
function init(){
  if(T._inited)return;
  T._inited=true;
  if(!hasStableApi())return;
  injectCss();
  T.grid=document.createElement('div');
  T.grid.id='ext-tile-grid';
  const messages=document.querySelector('#messages');
  if(!messages)return;
  messages.appendChild(T.grid);
  tbInit();
  initCapture();
  initBadgeObserver();
  watchPanel();
}

if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',init);
else init();

})();
