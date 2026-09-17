// Chat Tiling — multi-session tile grid with overlay architecture
// Stable API consumer: registerHermesSessionOpenHandler + renderTranscript + loadSession
// Requires WebUI >= 2026-07.18 (the release that exposed the session-open hook)
//
// Architecture (single-live-session):
// - #messages is Core's single scroll owner — never hidden, never mutated
// - #msgInner stays in #messages always — never detached, never moved
// - Grid is an absolute overlay anchored to .messages-shell, which is the
//   non-scrolling, position:relative wrapper around #messages — so the grid
//   stays put while the transcript scrolls underneath it
// - Focused tile = transparent window showing live #msgInner beneath
// - Non-focused tiles = opaque renderTranscript snapshots covering #msgInner
// - Active tiles are normal stretching CSS grid items (NOT position:absolute)
// - focusTile() calls loadSession(tile.sid) to swap Core's session state
// - switchLayout() rearranges grid only — doesn't touch #msgInner
// - hideGrid() removes overlay — focused tile's session stays as live session

(function(){
  'use strict';

  // Bounds how long a *caller* waits for one queued transaction. The queue
  // itself is never released early — see enqueueOp() for why.
  const FOCUS_TIMEOUT_MS = 10000;
  const PRELOAD_TIMEOUT_DEFAULT_MS = 5000;
  // Toolbar layouts: 2 tiles = 2×1, 4 tiles = 2×2, 6 tiles = 3×2.
  const LAYOUTS = {2:[2,1],4:[2,2],6:[3,2]};

  const T = {
    tiles: [], activeId: null, visible: false, _cols: 0, _rows: 0,
    _saved: null, _savedComposer: '', _savedModel: '', _w: null,
    _watcherGeneration: 0, _focusGen: 0, _closing: new Set(),
    _panelObs: null, _badgeObserver: null,
    _focusOp: Promise.resolve(), _opGen: 0
  };

  // ── Operation queue ──
  // Every transaction (focus, close, layout, hide) enqueues through _focusOp so
  // two mutators never overlap. _opGen fences commits: a transaction whose
  // captured generation is stale discards its result.
  //
  // Two rules keep this deadlock-free and non-corrupting:
  //  1. A transaction calls the private `_*Impl` functions directly. It MUST
  //     NOT re-enter the queue (no nested focusTile()/hideGrid()): the child
  //     would wait on the very chain the parent is still holding and stall
  //     until FOCUS_TIMEOUT_MS fires.
  //  2. The queue advances only when the real mutator settles. A caller that
  //     exceeds FOCUS_TIMEOUT_MS gets a bounded {timedOut:true} answer, but the
  //     transaction keeps its slot until it finishes — releasing the queue
  //     while a mutator is still live would let two mutators interleave.
  function enqueueOp(fn){
    T._opGen++;
    const myOpGen=T._opGen;
    const run=T._focusOp.then(()=>fn(myOpGen));
    T._focusOp=run.then(()=>{},()=>{});
    let timerId=null;
    const deadline=new Promise((resolve)=>{
      timerId=setTimeout(()=>resolve({timedOut:true}),FOCUS_TIMEOUT_MS);
    });
    const settled=run.then((result)=>({result}),(error)=>({error}));
    return Promise.race([settled,deadline]).then((out)=>{
      if(timerId)clearTimeout(timerId);
      return out;
    });
  }

  const SVG_ICON = {
    close: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6L6 18M6 6l12 12"/></svg>',
    maximize: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><rect x="4" y="4" width="16" height="16" rx="2"/></svg>',
    minimize: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 14h6M4 14v6"/></svg>',
    twoCol: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="4" width="7" height="16" rx="1"/><rect x="14" y="4" width="7" height="16" rx="1"/></svg>',
    fourCol: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="3" width="4" height="7" rx="1"/><rect x="9" y="3" width="4" height="7" rx="1"/><rect x="14" y="3" width="4" height="7" rx="1"/><rect x="5" y="13" width="4" height="7" rx="1"/></svg>',
    sixCol: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="3" width="4" height="7" rx="1"/><rect x="9" y="3" width="4" height="7" rx="1"/><rect x="16" y="3" width="4" height="7" rx="1"/><rect x="2" y="13" width="4" height="7" rx="1"/><rect x="9" y="13" width="4" height="7" rx="1"/><rect x="16" y="13" width="4" height="7" rx="1"/></svg>'
  };

  const EXT_CSS = `
#ext-tile-grid{position:absolute;inset:0;pointer-events:none;z-index:10;display:grid;gap:0}
.ext-tile{min-width:0;min-height:0;background:var(--bg);border:1px solid var(--border);border-radius:10px;overflow:hidden;display:flex;flex-direction:column}
.ext-tile--focused{border-color:var(--accent);background:transparent;pointer-events:none}
.ext-tile--focused .ext-tile-msg-inner{display:none}
.ext-tile--focused .ext-tile-titlebar{pointer-events:auto}
.ext-tile:not(.ext-tile--focused){background:var(--bg);pointer-events:auto}
.ext-tile.ext-tile--empty{pointer-events:none}
.ext-tile.ext-tile--empty .ext-tile-titlebar{pointer-events:auto}
.ext-tile--maximized{grid-area:1/1/-1/-1!important;z-index:2}
.ext-tile--hidden{display:none}
.ext-tile-titlebar{display:flex;align-items:center;gap:6px;padding:4px 8px;border-bottom:1px solid var(--border);background:var(--bg-secondary)}
.ext-tile--focused .ext-tile-titlebar{background:transparent}
.ext-tile-title{font-size:12px;font-weight:600;color:var(--text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:none;min-width:0}
.ext-tile-btn{background:none;border:1px solid transparent;border-radius:6px;color:var(--text);cursor:pointer;padding:2px;display:flex;align-items:center;justify-content:center;line-height:1;opacity:.7;transition:opacity .15s}
.ext-tile-btn:hover{opacity:1;background:var(--bg-hover)}
.ext-tile-btn-sq{width:24px;height:24px}
.ext-tile-body{flex:1;min-height:0;overflow:auto;display:flex;flex-direction:column}
.ext-tile-msg-inner{flex:1;min-height:0;padding:0;display:flex;flex-direction:column}
.ext-tile-sidebar-badge{display:inline-flex;align-items:center;justify-content:center;min-width:16px;height:16px;padding:0 4px;border-radius:8px;font-size:10px;font-weight:700;line-height:16px;color:var(--bg);background:var(--accent)}
.ext-tile--focused .ext-tile-sidebar-badge{display:none}
#ext-tiling-toolbar{display:flex;gap:4px;align-items:center;margin-left:auto}
#ext-tiling-toolbar.ext-tiling-toolbar--hidden{display:none}
.ext-toolbar-btn{background:none;border:1px solid transparent;border-radius:6px;color:var(--text-secondary);cursor:pointer;padding:4px 8px;display:flex;align-items:center;justify-content:center;line-height:1;opacity:.7;transition:opacity .15s;font-size:12px;white-space:nowrap}
.ext-toolbar-btn:hover{opacity:1;background:var(--bg-hover)}
@media(pointer:coarse){.ext-tile-btn,.ext-toolbar-btn{min-width:44px;min-height:44px}}
  `;

  function injectCss(){
    if(document.getElementById('ext-tiling-css'))return;
    const style=document.createElement('style');
    style.id='ext-tiling-css';
    style.textContent=EXT_CSS;
    document.head.appendChild(style);
  }

  // Core declares `const S={...}` at the top level of ui.js — a lexical global,
  // NOT a property of `window`. Reading `window.S` yields undefined, which
  // silently disables state capture, the busy/stream watcher and tile seeding.
  // Read the bare binding first; fall back to window.S for embedders/tests that
  // legitimately expose it there.
  function getS(){
    try{ if(typeof S!=='undefined'&&S)return S; }catch(_){}
    return window.S||null;
  }

  function gs(key,def){
    if(window.HermesExtensionSettings&&window.HermesExtensionSettings.settingsForExtension){
      const v=window.HermesExtensionSettings.settingsForExtension('chat-tiling').get(key);
      return v===undefined?def:v;
    }
    return def;
  }

  function preloadTimeoutMs(){
    const raw=gs('preload_timeout_ms',PRELOAD_TIMEOUT_DEFAULT_MS);
    const n=typeof raw==='number'?raw:parseInt(raw,10);
    return (isFinite(n)&&n>0)?n:PRELOAD_TIMEOUT_DEFAULT_MS;
  }

  function at(){
    if(T.activeId===null)return null;
    return T.tiles.find(t=>t.id===T.activeId)||null;
  }

  function tid(id){
    return T.tiles.find(t=>t.id===id)||null;
  }

  function bySid(sid){
    return T.tiles.find(t=>t.sid===sid)||null;
  }

  function rc(tile){
    if(!tile)return;
    const composer=document.getElementById('msg');
    if(composer){
      composer.value=tile.cv||'';
      if(typeof window.autoResize==='function')window.autoResize();
    }
    const modelSelect=document.getElementById('modelSelect');
    if(modelSelect&&tile.mv)modelSelect.value=tile.mv;
  }

  function sc(tile){
    if(!tile)return;
    const composer=document.getElementById('msg');
    if(composer)tile.cv=composer.value;
    const modelSelect=document.getElementById('modelSelect');
    if(modelSelect)tile.mv=modelSelect.value;
  }

  // Core just loaded a session and owns the composer/draft for it. Adopt what is
  // live instead of letting the tile's stale default overwrite it — otherwise
  // focusing a freshly loaded tile wipes the server-restored draft.
  function seedFromLiveControls(tile){
    if(!tile)return;
    const composer=document.getElementById('msg');
    if(composer)tile.cv=composer.value;
    const modelSelect=document.getElementById('modelSelect');
    if(modelSelect)tile.mv=modelSelect.value;
  }

  function updateHeader(t){
    if(!t.el)return;
    const title=t.el.querySelector('.ext-tile-title');
    if(title){
      title.textContent=t.session?t.session.title||t.sid:'Empty tile';
      title.title=t.sid||'';
    }
  }

  function badgesEnabled(){
    return gs('show_sidebar_badges',true)!==false;
  }

  function updateBadgeCounts(){
    const rows=document.querySelectorAll('.session-item[data-sid]');
    if(!badgesEnabled()){
      rows.forEach(row=>{
        const badge=row.querySelector('.ext-tile-sidebar-badge');
        if(badge)badge.remove();
      });
      return;
    }
    rows.forEach(row=>{
      const sid=row.getAttribute('data-sid');
      const count=T.tiles.filter(t=>t.sid===sid&&t.busy).length;
      let badge=row.querySelector('.ext-tile-sidebar-badge');
      if(count>0){
        if(!badge){
          badge=document.createElement('span');
          badge.className='ext-tile-sidebar-badge';
          const titleEl=row.querySelector('.session-item-title');
          if(titleEl&&titleEl.parentNode===row){
            titleEl.parentNode.insertBefore(badge,titleEl.nextSibling);
          } else {
            row.appendChild(badge);
          }
        }
        badge.textContent=count;
      } else if(badge){
        badge.remove();
      }
    });
  }

  // ── Render snapshot into a tile's body ──
  function renderSnapshot(t){
    if(!t.el)return;
    const mi=t.el.querySelector('.ext-tile-msg-inner');
    if(!mi)return;
    if(typeof window.renderTranscript==='function'){
      window.renderTranscript(mi,t.messages||[],{skipEmpty:false});
    }
  }

  function makeTileEls(t,id){
    const el=document.createElement('div');
    el.className='ext-tile';
    el.dataset.tileId=id;
    el.setAttribute('role','region');
    el.setAttribute('tabindex','-1');
    el.innerHTML=`
      <div class="ext-tile-titlebar">
        <span class="ext-tile-title">Empty tile</span>
        <button class="ext-tile-btn ext-tile-btn-sq ext-tile-maximize-btn" aria-label="Maximize tile" title="Maximize">${SVG_ICON.maximize}</button>
        <button class="ext-tile-btn ext-tile-btn-sq ext-tile-close-btn" aria-label="Close tile" title="Close">${SVG_ICON.close}</button>
      </div>
      <div class="ext-tile-body">
        <div class="ext-tile-msg-inner"></div>
      </div>
    `;
    el.addEventListener('click',()=>{
      // Unbound tiles are not focusable: focusing one would leave Core pointed
      // at its previous session while the tile claims authority.
      if(!t.sid)return;
      focusTile(t.id);
    });
    el.querySelector('.ext-tile-close-btn').addEventListener('click',async(e)=>{
      e.stopPropagation();
      await closeTile(t.id);
    });
    el.querySelector('.ext-tile-maximize-btn').addEventListener('click',(e)=>{
      e.stopPropagation();
      toggleMax(t.id);
    });
    return el;
  }

  function applyLayout(cols,rows){
    const grid=document.getElementById('ext-tile-grid');
    if(!grid)return;
    grid.style.gridTemplateColumns=cols===1?'1fr':`repeat(${cols},1fr)`;
    grid.style.gridTemplateRows=rows===1?'1fr':`repeat(${rows},1fr)`;
    // Position tiles using grid placement. Tiles are normal in-flow grid items,
    // so they stretch to fill their cell instead of overlapping at one origin.
    T.tiles.forEach((t,i)=>{
      if(!t.el)return;
      const row=Math.floor(i/cols);
      const col=i%cols;
      t.el.style.gridArea=`${row+1}/${col+1}`;
    });
  }

  // A maximized tile hides its siblings. Whenever tile membership or maximized
  // state changes, re-derive visibility from scratch so a removed maximized
  // tile can never leave the surviving tiles stuck at display:none.
  function syncMaxVisibility(){
    const anyMax=T.tiles.some(t=>t.maximized);
    T.tiles.forEach(t=>{
      if(!t.el)return;
      if(!anyMax)t.maximized=false;
      t.el.classList.toggle('ext-tile--maximized',!!t.maximized);
      t.el.classList.toggle('ext-tile--hidden',anyMax&&!t.maximized);
    });
  }

  function refreshTileGrid(){
    const grid=document.getElementById('ext-tile-grid');
    if(!grid)return;
    Array.from(grid.children).forEach(c=>{
      if(!c.classList.contains('ext-tile'))return;
      const still=T.tiles.find(t=>t.id===parseInt(c.dataset.tileId));
      if(!still)c.remove();
    });
    T.tiles.forEach(t=>{
      if(t.el&&t.el.parentElement!==grid)grid.appendChild(t.el);
      if(t.el){
        t.el.classList.toggle('ext-tile--focused',t.id===T.activeId);
        t.el.classList.toggle('ext-tile--empty',!t.sid);
      }
    });
    syncMaxVisibility();
  }

  function buildTile(id){
    const t={id,sid:null,session:null,messages:[],busy:false,activeStreamId:null,cv:'',mv:'',el:null,_pending:false,_pendingSid:null,_pendingAt:0,maximized:false};
    t.el=makeTileEls(t,id);
    T.tiles.push(t);
    const grid=document.getElementById('ext-tile-grid');
    if(grid)grid.appendChild(t.el);
    return t;
  }

  function toggleMax(id){
    const t=tid(id);
    if(!t||!t.el)return;
    const next=!t.maximized;
    T.tiles.forEach(o=>{
      if(!o.el)return;
      o.maximized=(o.id===id)?next:false;
    });
    syncMaxVisibility();
  }

  function findEmptyTile(){
    return T.tiles.find(t=>!t.sid&&!t._pending);
  }

  function findPendingTile(sid){
    return T.tiles.find(t=>t._pendingSid===sid&&t._pending);
  }

  // Reservations whose session never arrived must not pin a slot forever.
  function reapStaleReservations(){
    const ttl=preloadTimeoutMs();
    const now=Date.now();
    T.tiles.forEach(t=>{
      if(t._pending&&t._pendingAt&&now-t._pendingAt>=ttl){
        t._pending=false;
        t._pendingSid=null;
        t._pendingAt=0;
      }
    });
  }

  function clearReservation(t){
    if(!t)return;
    t._pending=false;
    t._pendingSid=null;
    t._pendingAt=0;
  }

  function reserveTile(sid){
    let t=findPendingTile(sid);
    if(t)return t;
    t=findEmptyTile();
    if(t)return t;
    // Every remaining slot is freshly reserved (reapStaleReservations already
    // released anything past preload_timeout_ms), so take over the focused tile.
    // A sidebar click must always have a destination, otherwise Core would load
    // a session while no tile is bound to it.
    const act=at();
    if(act&&act.sid)return act;
    return null;
  }

  function bindTile(t,sid,data){
    t.sid=sid;
    t.session=data||null;
    t.messages=data&&data.messages?data.messages:[];
    t.busy=false;
    t.activeStreamId=null;
    clearReservation(t);
    updateHeader(t);
  }

  // ── Focus commit (no Core session swap) ──
  // Used once Core already holds the target session: the `loaded` hook and the
  // initial showGrid seed. Synchronous by design so a hook firing inside another
  // transaction cannot re-enter the queue.
  function _commitFocus(tile){
    if(!tile||!tile.el)return;
    T.activeId=tile.id;
    T.tiles.forEach(t=>{
      if(!t.el)return;
      const isFocused=t.id===tile.id;
      t.el.classList.toggle('ext-tile--focused',isFocused);
      if(!isFocused)renderSnapshot(t);
    });
    tile.el.setAttribute('aria-label',`Chat tile ${tile.id} — focused`);
    rc(tile);
    startWatcher();
    if(typeof window.syncTopbar==='function')window.syncTopbar();
    if(typeof window.syncModelChip==='function')window.syncModelChip();
    updateHeader(tile);
  }

  // ── Focus switching — calls loadSession() to swap Core session ──
  // Enqueued as one transaction. Only commits if still current, and only after
  // loadSession resolves.
  function focusTile(id,opts){
    opts=opts||{};
    return enqueueOp((myOpGen)=>{
      return _focusTileImpl(id,opts,myOpGen);
    });
  }

  async function _focusTileImpl(id,opts,myOpGen){
    opts=opts||{};
    const tile=tid(id);
    if(!tile)return;
    // An unbound tile has no session to hand Core. Focusing one while Core
    // holds a *different* session would leave the composer pointed at that
    // other conversation while the tile claims authority — so it is only
    // allowed when Core has no session at all (cold start), where there is
    // nothing to disagree with.
    const liveS=getS();
    const liveSid=liveS&&liveS.session?liveS.session.session_id:null;
    if(!tile.sid&&liveSid)return;
    if(T.activeId===id&&!opts.force)return;
    // Capture focus generation — bail if a newer focus supersedes us
    T._focusGen++;
    const myGen=T._focusGen;
    const outgoing=at();
    if(outgoing&&outgoing!==tile)sc(outgoing);

    // If tile has a session, swap Core's session via loadSession.
    // Skip when alreadyLoaded (Core already has this session — loaded hook).
    if(tile.sid&&!opts.alreadyLoaded&&typeof window.loadSession==='function'){
      try{
        await window.loadSession(tile.sid);
      }catch(e){
        // A newer focus may have superseded us — don't roll back over a newer winner.
        if(myGen!==T._focusGen)return;
        // Own the rollback with the same operation identity.
        T._focusGen++;
        const rbGen=T._focusGen;
        if(outgoing&&outgoing.sid){
          try{await window.loadSession(outgoing.sid);}catch(_){}
        }
        // After await, check if a newer focus superseded us
        if(rbGen!==T._focusGen)return;
        // Callers that must not proceed on a failed swap (the layout settle
        // path) opt in to seeing the rejection.
        if(opts.throwOnFailure)throw e;
        return;
      }
      // After await, check if a newer focus superseded us
      if(myGen!==T._focusGen)return;
    }

    // Commit only if this operation is still current
    if(myOpGen!==T._opGen)return;

    _commitFocus(tile);
  }

  // ── Close tile — enqueued through operation queue ──
  // The single-flight guard is taken *before* enqueue (so two rapid closes
  // collapse into one) and released by the transaction itself, not by the
  // caller-bounded promise.
  function closeTile(id){
    if(T._closing.has(id))return Promise.resolve();
    T._closing.add(id);
    return enqueueOp((myOpGen)=>_closeTileImpl(id,myOpGen));
  }

  async function _closeTileImpl(id,myOpGen){
    try{
      const tile=tid(id);
      if(!tile)return;
      const idx=T.tiles.indexOf(tile);
      if(idx<0)return;

      if(tile.busy&&tile.activeStreamId){
        let ok=false;
        try{
          // Core's cancelSessionStream(session) reads snake_case keys
          // (boot.js): session.active_stream_id / session.session_id. Passing
          // camelCase makes it return false, which leaves a streaming tile
          // permanently unclosable.
          ok=await window.cancelSessionStream({active_stream_id:tile.activeStreamId,session_id:tile.sid});
        }catch(e){
          return;
        }
        if(!ok)return; // Cancellation refused — preserve tile
      }

      // Invalidate pending focus on the removed tile
      T._focusGen++;

      // Remove from state
      const removed=T.tiles.splice(idx,1)[0];
      if(removed.el)removed.el.remove();
      if(removed.maximized)syncMaxVisibility();

      // If we were focused, move focus to a tile that actually has a session,
      // so Core's composer can never point at a different conversation than the
      // focused tile. Closing one tile is not a request to tear down the grid,
      // so if no bound tile remains the overlay stays with no active tile.
      if(T.activeId===id){
        T.activeId=null;
        const next=T.tiles.find(t=>t.sid)||null;
        if(next){
          // Same transaction — never re-enqueue (that self-deadlocks).
          await _focusTileImpl(next.id,{force:true},myOpGen);
        }else{
          stopWatcher();
        }
      }
      refreshTileGrid();
    }finally{
      T._closing.delete(id);
    }
  }

  // ── Close all — refuse if any busy (no partial cancel) ──
  function closeAll(){
    return enqueueOp((myOpGen)=>{
      const busyTiles=T.tiles.filter(t=>t.busy&&t.activeStreamId);
      if(busyTiles.length>0){
        // Refuse if any tile is busy — concurrent cancellation can partially
        // succeed, leaving some streams canceled and others not.
        return;
      }
      return _hideGridImpl(myOpGen);
    });
  }

  // ── Hide grid — enqueued through operation queue ──
  function hideGrid(){
    return enqueueOp((myOpGen)=>{
      return _hideGridImpl(myOpGen);
    });
  }

  async function _hideGridImpl(myOpGen){
    if(!T.visible)return;
    T.visible=false;
    stopWatcher();

    // Invalidate any pending focus so a late focus success/failure is a no-op
    T._focusGen++;

    // Commit only if this operation is still current
    if(myOpGen!==T._opGen)return;

    // Core already has the focused tile's session loaded (it was the last one focused).
    // No need to write tile cache over Core's current S — that would republish stale state.
    // Leave composer/model untouched — they're already canonical from the live focused tile.
    // Just remove the overlay and let Core's current S stand.

    // Remove the overlay grid
    const grid=document.getElementById('ext-tile-grid');
    if(grid)grid.remove();

    // Reset state
    T.tiles=[];
    T.activeId=null;

    T._saved=null;
    T._savedComposer='';
    T._savedModel='';
  }

  function startWatcher(){
    stopWatcher();
    T._watcherGeneration++;
    const myGen=T._watcherGeneration;
    T._w=setInterval(()=>{
      if(myGen!==T._watcherGeneration){stopWatcher();return;}
      const t=at();
      if(!t||T.activeId===null){stopWatcher();return;}
      const s=getS();
      if(!s||!s.session)return;
      // Fenced projection: only copy S state if this tile owns the session
      if(s.session.session_id!==t.sid)return;
      if(s.messages&&s.messages.length>0)t.messages=[...s.messages];
      t.busy=!!s.busy;
      t.activeStreamId=s.activeStreamId||null;
    },300);
  }

  function stopWatcher(){
    if(T._w){clearInterval(T._w);T._w=null;}
  }

  async function showGrid(cols,rows){
    if(T.visible&&T._cols===cols&&T._rows===rows)return;
    if(T.visible){await switchLayout(cols,rows);return;}
    T._cols=cols;T._rows=rows;T.visible=true;

    // Save current Core state (for rollback if needed)
    const s=getS();
    if(s){
      T._saved={
        session:s.session,
        messages:s.messages,
        busy:s.busy,
        activeStreamId:s.activeStreamId
      };
    }
    // Save current composer/model
    const composer=document.getElementById('msg');
    if(composer)T._savedComposer=composer.value;
    const modelSelect=document.getElementById('modelSelect');
    if(modelSelect)T._savedModel=modelSelect.value;

    // Create the grid as an overlay anchored to .messages-shell — the
    // position:relative, NON-scrolling wrapper around #messages. Anchoring
    // inside #messages would scroll the grid out of view with the transcript.
    const shell=document.querySelector('.messages-shell')||document.getElementById('messages');
    let grid=document.getElementById('ext-tile-grid');
    if(!grid){
      grid=document.createElement('div');
      grid.id='ext-tile-grid';
    }
    if(shell&&grid.parentElement!==shell){
      shell.appendChild(grid);
    }
    // Build tiles
    const total=cols*rows;
    for(let i=0;i<total;i++){
      buildTile(i+1);
    }
    // Place tiles only once they exist — applyLayout assigns every tile its cell.
    applyLayout(cols,rows);
    refreshTileGrid();

    // Seed tile 1 from captured live session state (Finding 1: activation seeding)
    const curS=getS();
    if(T.tiles.length>0&&curS&&curS.session){
      const t0=T.tiles[0];
      t0.sid=curS.session.session_id;
      t0.session=curS.session;
      t0.messages=curS.messages||[];
      t0.busy=!!curS.busy;
      t0.activeStreamId=curS.activeStreamId||null;
      t0.cv=T._savedComposer;
      t0.mv=T._savedModel;
      updateHeader(t0);
    }
    refreshTileGrid();

    // Focus first tile. Core already holds this session, so no swap is needed.
    if(T.tiles.length>0){
      await focusTile(T.tiles[0].id,{alreadyLoaded:true});
    }
  }

  // ── Switch layout — one transaction, never re-enters the queue ──
  // Refuses shrink if any excess tile is busy (no partial cancellation).
  // Does not remove the active tile — reorders survivors to retain it.
  function switchLayout(cols,rows){
    return enqueueOp((myOpGen)=>{
      return _switchLayoutImpl(cols,rows,myOpGen);
    });
  }

  async function _switchLayoutImpl(cols,rows,myOpGen){
    const newTotal=cols*rows;
    if(newTotal===T.tiles.length){
      // Same cardinality — just reposition existing tiles
      T._cols=cols;T._rows=rows;
      applyLayout(cols,rows);
      refreshTileGrid();
      return;
    }

    // Capture old geometry BEFORE any mutation
    const oldCols=T._cols;
    const oldRows=T._rows;
    const oldTiles=T.tiles;
    const oldActiveId=T.activeId;
    const oldActiveTile=oldActiveId?oldTiles.find(t=>t.id===oldActiveId):null;

    const removedTiles=oldTiles.slice(newTotal);
    const survivingTiles=oldTiles.slice(0,newTotal);

    // Refuse shrink if any excess tile is busy — no partial cancel.
    // Concurrent cancellation can partially succeed, leaving some streams
    // canceled and others not. User must close busy tiles first via closeTile().
    const busyRemoved=removedTiles.filter(t=>t.busy&&t.activeStreamId);
    if(busyRemoved.length>0){
      return; // Refuse — no mutation
    }

    // Don't remove the active tile — reorder survivors to retain it.
    // If active tile is among removed tiles, swap it with the last survivor.
    let actualSurviving=survivingTiles;
    let actualRemoved=removedTiles;
    const activeWasRemoved=!!(oldActiveTile&&!survivingTiles.includes(oldActiveTile));
    if(activeWasRemoved){
      const lastSurv=survivingTiles[survivingTiles.length-1];
      actualSurviving=survivingTiles.filter(t=>t.id!==lastSurv.id).concat([oldActiveTile]);
      actualRemoved=removedTiles.filter(t=>t.id!==oldActiveTile.id).concat([lastSurv]);
    }

    // Settle the successor (the retained active tile) BEFORE committing the
    // removal, so the old geometry is left intact if its session can't reload.
    // Direct _impl call — enqueueing here would deadlock on our own chain.
    if(activeWasRemoved&&oldActiveTile.sid){
      try{
        await _focusTileImpl(oldActiveTile.id,{force:true,throwOnFailure:true},myOpGen);
      }catch(e){
        return; // Successor focus failed — abort layout change
      }
      if(myOpGen!==T._opGen)return;
    }

    // Commit only if this operation is still current
    if(myOpGen!==T._opGen)return;

    // All clear — apply new geometry
    T._cols=cols;T._rows=rows;
    applyLayout(cols,rows);

    // Remove excess tiles
    let removedMaximized=false;
    for(const rt of actualRemoved){
      if(rt.maximized)removedMaximized=true;
      if(rt.el)rt.el.remove();
    }

    // Keep tiles up to new count (preserve their authority)
    T.tiles=actualSurviving;

    // Build new empty tiles for any expansion
    const maxId=oldTiles.length>0?Math.max(...oldTiles.map(t=>t.id)):0;
    for(let i=oldTiles.length;i<newTotal;i++){
      buildTile(maxId+i-oldTiles.length+1);
    }

    // Re-append to grid
    const grid=document.getElementById('ext-tile-grid');
    T.tiles.forEach(t=>{if(grid&&t.el)grid.appendChild(t.el);});
    if(removedMaximized)syncMaxVisibility();
    applyLayout(cols,rows);
    refreshTileGrid();

    // Restore activeId to the same tile object if it still exists
    if(oldActiveTile&&T.tiles.includes(oldActiveTile)){
      T.activeId=oldActiveTile.id;
    }else if(T.tiles.length>0){
      // Old active tile was removed — focus the first tile that has a session,
      // so tile authority and Core's session cannot drift apart.
      const withSession=T.tiles.find(t=>t.sid);
      if(withSession){
        await _focusTileImpl(withSession.id,{force:true},myOpGen);
      }else{
        T.activeId=null;
      }
    }
    refreshTileGrid();
  }

  // ── Session-open handler (two-phase: preload → loaded) ──
  // Returning {cancel:true} from the preload phase vetoes Core's navigation
  // (boot.js::_hermesNotifySessionOpen). The loaded phase keeps tile authority
  // and Core's session in lockstep: if no slot was reserved (auto_tile off, or
  // a reservation was reaped) the focused tile is rebound to whatever Core
  // just loaded rather than being left stale.
  function sessionOpenHandler(sid,data,opts){
    opts=opts||{};
    if(!T.visible)return {};

    if(opts.preload){
      reapStaleReservations();
      // Snapshot the outgoing draft BEFORE Core swaps sessions and resets the
      // composer — afterwards the live value belongs to the incoming session.
      const outgoing=at();
      if(outgoing&&outgoing.sid!==sid)sc(outgoing);

      if(gs('auto_tile',true)===false){
        // Auto-tiling off: allow navigation, but only if there is a focused
        // tile we can rebind to keep authority coherent.
        return at()?{}:{cancel:true};
      }
      const t=reserveTile(sid);
      if(!t)return {cancel:true}; // No destination — veto rather than split authority
      t._pending=true;
      t._pendingSid=sid;
      t._pendingAt=Date.now();
      return {destinationTileId:t.id};
    }

    if(opts.loaded){
      const auto=gs('auto_tile',true)!==false;
      const t=auto?findPendingTile(sid):null;
      if(t){
        // The reservation is the intent: this tile was chosen for this sid at
        // preload time, so it wins even if it is still bound to the session the
        // user just navigated away from.
        const isNew=!t.sid;
        bindTile(t,sid,data);
        if(isNew&&T.tiles.length>1){
          // Core already loaded this session (loaded hook) and owns the
          // composer draft for it — adopt that value instead of clobbering it
          // with the tile's empty default.
          seedFromLiveControls(t);
          _commitFocus(t);
        }
        updateBadgeCounts();
        return {};
      }
      // No reservation — rebind the focused tile so Core and the tile agree.
      const act=at();
      if(act&&act.sid!==sid){
        bindTile(act,sid,data);
        seedFromLiveControls(act);
        _commitFocus(act);
      }
      updateBadgeCounts();
      return {};
    }

    return {};
  }

  // ── Initialization ──
  function init(){
    // Feature-detect required Core APIs
    if(!document.getElementById('msgInner'))return;
    if(typeof window.registerHermesSessionOpenHandler!=='function')return;
    if(typeof window.renderTranscript!=='function')return;

    injectCss();

    // Create toolbar
    const toolbar=document.createElement('div');
    toolbar.id='ext-tiling-toolbar';
    toolbar.classList.add('ext-tiling-toolbar--hidden');
    toolbar.innerHTML=`
      <button class="ext-toolbar-btn" data-layout="2" aria-label="Split in 2" title="Split into 2 tiles">${SVG_ICON.twoCol}<span style="margin-left:4px">2</span></button>
      <button class="ext-toolbar-btn" data-layout="4" aria-label="Split in 4" title="Split into 4 tiles">${SVG_ICON.fourCol}<span style="margin-left:4px">4</span></button>
      <button class="ext-toolbar-btn" data-layout="6" aria-label="Split in 6" title="Split into 6 tiles">${SVG_ICON.sixCol}<span style="margin-left:4px">6</span></button>
      <button class="ext-toolbar-btn" data-layout="close" aria-label="Close tiling" title="Close tiling">${SVG_ICON.close}</button>
    `;
    toolbar.querySelectorAll('[data-layout]').forEach(btn=>{
      btn.addEventListener('click',async()=>{
        const layout=btn.dataset.layout;
        if(layout==='close'){
          await hideGrid();
        }else{
          const dims=LAYOUTS[parseInt(layout,10)];
          if(!dims)return;
          await showGrid(dims[0],dims[1]);
        }
      });
    });

    const titlebar=document.querySelector('.app-titlebar');
    if(titlebar){
      titlebar.appendChild(toolbar);
    }

    // Register session-open handler
    window.registerHermesSessionOpenHandler(sessionOpenHandler);
    window.handlerRegistration = sessionOpenHandler;

    // Panel gating
    initPanelGating();

    // Badge observer
    initBadgeObserver();
  }

  // Core marks the active view with a `showing-<panel>` class on <main>;
  // chat is the default and is represented by the ABSENCE of any such class
  // (panels.js: "no class means chat"). There is no `chat` class to test for.
  function isChatView(main){
    if(!main)return false;
    const cls=main.classList;
    for(let i=0;i<cls.length;i++){
      if(cls[i].indexOf('showing-')===0)return false;
    }
    return true;
  }

  function initPanelGating(){
    const tb=document.getElementById('ext-tiling-toolbar');
    if(!tb)return;
    const main=document.querySelector('main.main');
    const apply=()=>{
      tb.classList.toggle('ext-tiling-toolbar--hidden',!isChatView(main));
    };
    if(main&&typeof window.MutationObserver!=='undefined'){
      T._panelObs=new window.MutationObserver(apply);
      T._panelObs.observe(main,{attributes:true,attributeFilter:['class']});
    }
    apply();
  }

  function initBadgeObserver(){
    const sessionList=document.querySelector('.session-list');
    if(!sessionList)return;
    if(typeof MutationObserver==='undefined')return;
    T._badgeObserver=new MutationObserver((mutations)=>{
      // Bounded: disconnect, apply, reconnect
      T._badgeObserver.disconnect();
      try{
        updateBadgeCounts();
      }finally{
        T._badgeObserver.observe(sessionList,{childList:true,subtree:true});
      }
    });
    T._badgeObserver.observe(sessionList,{childList:true,subtree:true});
  }

  if(document.readyState==='loading'){
    document.addEventListener('DOMContentLoaded',init);
  }else{
    init();
  }

  // Exports for testing
  window.showGridExt=showGrid;
  window.hideGridExt=hideGrid;
  window.focusTileExt=focusTile;
  window.closeTileExt=closeTile;
  window.closeAllExt=closeAll;
  window.chatTilingState=T;
  window.updateBadgeCounts=updateBadgeCounts;
  window.isChatViewExt=isChatView;
})();
