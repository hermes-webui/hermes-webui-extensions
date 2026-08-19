(() => {
  'use strict';

  const EXTENSION_ID = 'capability-probe';
  const SESSION_ID = 'capability-session';
  const STREAM_ID = 'capability-stream';
  const EXPECTED_CONFIGURE_FAILURE = 'capability-probe intentional Configure failure';
  const events = [];
  const configureProbe = {
    api_function: false,
    registered: false,
    duplicate_rejected: false,
    invocations: 0,
    pending_before_handler: false,
  };
  let configureUnregister = null;
  let configureResolver = null;

  const storageKeys = () => Array.from(
    { length: window.localStorage.length },
    (_, index) => window.localStorage.key(index),
  ).sort();

  const register = window.hermesExt && typeof window.hermesExt.register === 'function'
    ? window.hermesExt.register.bind(window.hermesExt)
    : null;
  const beforeUnknown = storageKeys();
  const unknown = register ? register('untrusted-capability-probe') : undefined;
  const afterUnknown = storageKeys();
  const extension = register ? register(EXTENSION_ID) : null;
  const settingsRuntime = window.HermesExtensionSettings;

  if (extension && extension.settings) {
    const registerConfigure = extension.settings.registerConfigure;
    configureProbe.api_function = typeof registerConfigure === 'function';
    if (configureProbe.api_function) {
      configureUnregister = registerConfigure(({ opener }) => {
        configureProbe.invocations += 1;
        configureProbe.pending_before_handler = Boolean(
          settingsRuntime
          && settingsRuntime._configureStateForExtension
          && settingsRuntime._configureStateForExtension(EXTENSION_ID).pending,
        );
        configureProbe.opener_connected = Boolean(opener && opener.isConnected);
        if (configureProbe.invocations === 1) {
          return new Promise(resolve => {
            configureResolver = resolve;
          });
        }
        throw new Error(EXPECTED_CONFIGURE_FAILURE);
      });
      configureProbe.registered = typeof configureUnregister === 'function';
      configureProbe.duplicate_rejected = registerConfigure(() => {}) === null;
    }
  }

  const probe = {
    ready: false,
    registration: {
      id: extension && extension.id,
      handle_fields: extension ? Object.keys(extension).sort() : [],
      handle_frozen: Boolean(extension && Object.isFrozen(extension)),
      events_frozen: Boolean(extension && Object.isFrozen(extension.events)),
      same_handle: Boolean(extension && register(`  ${EXTENSION_ID}  `) === extension),
      unknown_is_null: unknown === null,
      unknown_storage_unchanged: JSON.stringify(beforeUnknown) === JSON.stringify(afterUnknown),
    },
    events,
    configure: configureProbe,
  };
  window.HermesCapabilityBaselineProbe = probe;

  probe.resolveConfigure = () => {
    if (typeof configureResolver !== 'function') return false;
    const resolve = configureResolver;
    configureResolver = null;
    resolve();
    return true;
  };

  probe.finishConfigureRegistration = () => {
    const first = typeof configureUnregister === 'function'
      ? configureUnregister()
      : null;
    const second = typeof configureUnregister === 'function'
      ? configureUnregister()
      : null;
    return {
      api_function: configureProbe.api_function,
      registered: configureProbe.registered,
      duplicate_rejected: configureProbe.duplicate_rejected,
      unregister_idempotent: first === true && second === false,
    };
  };

  if (!extension) {
    probe.error = register
      ? 'trusted capability probe did not register'
      : 'hermesExt.register is unavailable';
    probe.ready = true;
    return;
  }

  const record = event => {
    const lastMessage = Array.isArray(S.messages) ? S.messages.at(-1) : null;
    events.push({
      type: event.type,
      session_id: event.sessionId,
      stream_id: event.streamId,
      status: event.status || null,
      active_stream_id: S.activeStreamId || null,
      busy: Boolean(S.busy),
      last_content: lastMessage && lastMessage.content || null,
    });
  };
  extension.events.on('turn:start', record);
  extension.events.on('turn:complete', record);

  class MockEventSource {
    static OPEN = 1;
    static instances = [];

    constructor(url) {
      this.url = String(url);
      this.readyState = MockEventSource.OPEN;
      this.listeners = new Map();
      MockEventSource.instances.push(this);
    }

    addEventListener(name, listener) {
      const listeners = this.listeners.get(name) || [];
      listeners.push(listener);
      this.listeners.set(name, listeners);
    }

    removeEventListener(name, listener) {
      this.listeners.set(
        name,
        (this.listeners.get(name) || []).filter(candidate => candidate !== listener),
      );
    }

    close() {
      this.readyState = 2;
    }

    async emit(name, payload) {
      const event = { type: name, data: JSON.stringify(payload), lastEventId: '' };
      for (const listener of this.listeners.get(name) || []) {
        await listener(event);
      }
    }
  }

  probe.runCompleteLifecycle = async () => {
    events.splice(0, events.length);
    const NativeEventSource = window.EventSource;
    window.EventSource = MockEventSource;
    try {
      S.session = {
        session_id: SESSION_ID,
        messages: [{ role: 'user', content: 'question' }],
      };
      S.messages = [{ role: 'user', content: 'question' }];
      S.toolCalls = [];
      S.activeStreamId = STREAM_ID;
      S.busy = true;

      attachLiveStream(SESSION_ID, STREAM_ID, []);
      const source = MockEventSource.instances.at(-1);
      if (!source) throw new Error('Core did not create the live EventSource');
      await source.emit('done', {
        status: 'completed',
        stream_id: STREAM_ID,
        session: {
          session_id: SESSION_ID,
          messages: [{ role: 'assistant', content: 'settled-done' }],
          tool_calls: [],
        },
      });
      await new Promise(resolve => window.setTimeout(resolve, 0));

      const duplicateAccepted = window.HermesExtensionSettings._dispatchTurnLifecycle(
        'turn:complete',
        {
          sessionId: SESSION_ID,
          streamId: STREAM_ID,
          status: 'late-duplicate',
        },
      );
      return {
        registration: probe.registration,
        events: events.map(event => ({ ...event })),
        duplicate_terminal_accepted: duplicateAccepted,
      };
    } finally {
      window.EventSource = NativeEventSource;
    }
  };

  probe.ready = true;
})();
