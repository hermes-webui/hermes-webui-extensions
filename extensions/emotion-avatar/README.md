# Emotion Bridge

Detects emotional context from agent state, LLM responses, and FAC voice interaction, then emits expression signals for any avatar renderer to consume.

**Does not render anything. Does not depend on any specific avatar extension.**

## Architecture

```
┌──────────────────────────────────────────────────────────────────┐
│                      EMOTION BRIDGE                              │
│                                                                  │
│  Source 1: Agent State              Source 2: LLM Response       │
│  ┌───────────────────────┐         ┌──────────────────────────┐  │
│  │ S.busy / speechSynth  │         │ Agent messages scanned   │  │
│  │ → thinking / speaking │         │ for [happy] [thinking]   │  │
│  └───────────┬───────────┘         │ tags via DOM observer    │  │
│              │                      └──────────┬───────────────┘  │
│              │                                 │                  │
│  Source 3: FAC Voice                  Source 4: External         │
│  ┌───────────────────────┐           ┌──────────────────────────┐│
│  │ hermes:fac:emotion    │           │ __emotionBridge.emit()   ││
│  │ custom event from FAC  │           │ hermes:avatar:emotion    ││
│  │ S2S emotion detection │           │ other extensions         ││
│  └───────────┬───────────┘           └──────────┬───────────────┘│
│              │                                  │                │
│              └──────────────┬───────────────────┘                │
│                             ▼                                    │
│                    ┌─────────────────┐                           │
│                    │  emit(expr, src)│                           │
│                    ├─────────────────┤                           │
│                    │ window.__avatar │ ← polling consumers       │
│                    │ Expression state│                           │
│                    │                 │                           │
│                    │ 'hermes:avatar: │ ← event-driven consumers  │
│                    │ expression' evt │                           │
│                    └────────┬────────┘                           │
│                             │                                    │
└─────────────────────────────┼────────────────────────────────────┘
                              │
            ┌─────────────────┼─────────────────┐
            ▼                 ▼                   ▼
   assistant-avatar    VRM 3D avatar      any custom renderer
   (reads state or     (listens to        (listens to
    listens to event)   event)             event)
```

## No Dependencies

The bridge is **renderer-agnostic**. It has zero hard dependencies on other extensions. Any avatar extension can consume its signals:

### Event-driven (recommended)

```javascript
window.addEventListener('hermes:avatar:expression', function(e) {
  var expr = e.detail.expression; // 'happy', 'thinking', 'speaking', etc.
  var source = e.detail.source;   // 'agent', 'llm-tag', 'fac', 'external'
});
```

### Polling

```javascript
if (window.__avatarExpression !== lastExpression) {
  lastExpression = window.__avatarExpression;
}
```

## Integration

### With FAC (Fun-Audio-Chat)

FAC's S2S pipeline detects emotion from voice. The FAC plugin should dispatch:

```javascript
window.dispatchEvent(new CustomEvent('hermes:fac:emotion', {
  detail: { emotion: 'happy', confidence: 0.92 }
}));
```

The bridge listens and relays it as `hermes:avatar:expression` with `source: 'fac'`.

### With LLM Responses

Your agent prompt can include:
> End each response with an emotion tag: [happy], [thinking], [surprised], [confused], [excited]

The bridge scans the most recent message for `[tag]` patterns and re-emits them.

### With Other Extensions

```javascript
// Direct API
window.__emotionBridge.emit('happy', 'my-extension');

// Or custom event
window.dispatchEvent(new CustomEvent('hermes:avatar:emotion', {
  detail: { expression: 'surprised', source: 'my-extension' }
}));
```

## Expression Signals

| Signal | Source | When |
|---|---|---|
| `thinking` | agent | Agent is processing a response |
| `speaking` | agent | TTS is playing audio |
| `idle` | agent | Nothing happening |
| `happy` | llm-tag / fac | LLM tag or FAC detects happy voice |
| `surprised` | llm-tag / fac | Surprise emotion detected |
| `confused` | llm-tag | LLM expresses uncertainty |

These are suggestions — the bridge forwards whatever signals it receives without validation.

## API Reference

```javascript
window.__emotionBridge.status()     // 'connected'|'stopped'|'disabled'
window.__emotionBridge.enabled()    // true|false
window.__emotionBridge.current()    // 'happy'|'thinking'|null etc.
window.__emotionBridge.emit('happy', 'my-source')  // Emit directly
window.__emotionBridge.enable()                     // Start bridging
window.__emotionBridge.disable()                    // Stop
```

## Roadmap

- [ ] FAC S2S plugin integration (hermes:fac:emotion event emitter)
- [ ] Webcam emotion mirroring via face-api.js (MIT)
- [ ] Configurable expression priority (agent state > LLM tags)
- [ ] Expression debouncing / minimum hold time

## License

MIT
