<script>
  import HighlightedJson from './HighlightedJson.svelte';

  const DEFAULT_BASE_URL = 'wss://tangleveil.meshcore.ninja';
  const MAX_RENDERED_MESSAGES = 500;

  let baseUrl = $state(DEFAULT_BASE_URL);
  let endpoint = $state('multiplex');
  let directSource = $state('');

  // /ws query parameters
  let repeatedSources = $state('');
  let sourcesCsv = $state('');
  let payloadTypes = $state('');
  let dedupByContent = $state(false);
  let dedupWindowSecs = $state(300);
  let jaq = $state('');
  let binary = $state(false);

  let socket = $state(null);
  let status = $state('idle');
  let error = $state('');
  let messages = $state([]);
  let paused = $state(false);
  let prettyJson = $state(true);
  let shikiHighlight = $state(true);
  let autoScroll = $state(true);
  let maxMessages = $state(100);
  let totalMessages = $state(0);
  let totalBytes = $state(0);
  let connectedAt = $state(null);
  let sourceOptions = $state([]);
  let sourcesStatus = $state('');
  let outputElement = $state(null);

  const isOpen = $derived(status === 'open');
  const isConnecting = $derived(status === 'connecting');
  const multiplexEnabled = $derived(endpoint === 'multiplex');
  const jaqOverridesBinary = $derived(Boolean(jaq.trim()) && binary);

  const urlState = $derived.by(() => {
    try {
      return { url: buildGeneratedUrl(), error: '' };
    } catch (cause) {
      return {
        url: '',
        error: cause instanceof Error ? cause.message : String(cause),
      };
    }
  });
  const generatedUrl = $derived(urlState.url);
  const generatedUrlError = $derived(urlState.error);

  function buildGeneratedUrl() {
    const url = normalizeWebSocketBase(baseUrl);

    if (endpoint === 'source') {
      url.pathname = `/ws/${encodeURIComponent(directSource.trim())}`;
      url.search = '';
      return url.toString();
    }

    if (endpoint === 'telemetry') {
      url.pathname = '/ws/telemetry';
      url.search = '';
      return url.toString();
    }

    url.pathname = '/ws';
    url.search = '';

    for (const source of splitValues(repeatedSources)) {
      url.searchParams.append('source', source);
    }

    if (sourcesCsv.trim()) {
      url.searchParams.set('sources', normalizeCsv(sourcesCsv));
    }

    if (payloadTypes.trim()) {
      url.searchParams.set('payloadTypes', normalizeCsv(payloadTypes));
    }

    if (dedupByContent) {
      url.searchParams.set('dedupByContent', '1');
      if (Number.isFinite(Number(dedupWindowSecs)) && Number(dedupWindowSecs) > 0) {
        url.searchParams.set('dedupWindowSecs', String(Math.trunc(Number(dedupWindowSecs))));
      }
    }

    if (jaq.trim()) {
      url.searchParams.set('jaq', jaq.trim());
    }

    if (binary) {
      url.searchParams.set('binary', '1');
    }

    return url.toString();
  }

  function normalizeWebSocketBase(value) {
    const raw = value.trim() || DEFAULT_BASE_URL;
    const withProtocol = /^[a-z]+:\/\//i.test(raw) ? raw : `wss://${raw}`;
    const url = new URL(withProtocol);

    if (url.protocol === 'http:') url.protocol = 'ws:';
    if (url.protocol === 'https:') url.protocol = 'wss:';
    if (!['ws:', 'wss:'].includes(url.protocol)) {
      throw new Error('Base URL must use ws://, wss://, http://, or https://');
    }

    return url;
  }

  function httpBase(value) {
    const url = normalizeWebSocketBase(value);
    url.protocol = url.protocol === 'wss:' ? 'https:' : 'http:';
    url.pathname = '';
    url.search = '';
    url.hash = '';
    return url;
  }

  function splitValues(value) {
    return value
      .split(/[\n,]/)
      .map((item) => item.trim())
      .filter(Boolean);
  }

  function normalizeCsv(value) {
    return splitValues(value).join(',');
  }

  function connect() {
    error = '';

    if (generatedUrlError) {
      error = generatedUrlError;
      return;
    }

    if (endpoint === 'source' && !directSource.trim()) {
      error = 'Choose or enter a source id for /ws/{source}.';
      return;
    }

    disconnect();
    status = 'connecting';

    let ws;
    try {
      ws = new WebSocket(generatedUrl);
    } catch (cause) {
      status = 'error';
      error = cause instanceof Error ? cause.message : String(cause);
      return;
    }

    ws.binaryType = 'arraybuffer';
    socket = ws;

    ws.addEventListener('open', () => {
      if (socket !== ws) return;
      status = 'open';
      connectedAt = Date.now();
      addSystemMessage('Connected', generatedUrl);
    });

    ws.addEventListener('message', async (event) => {
      if (socket !== ws) return;

      try {
        const item = await decodeMessage(event.data);
        totalMessages += 1;
        totalBytes += item.bytes;

        if (!paused) {
          messages = [item, ...messages].slice(0, Math.min(maxMessages, MAX_RENDERED_MESSAGES));
          if (autoScroll) {
            requestAnimationFrame(() => outputElement?.scrollTo({ top: 0, behavior: 'smooth' }));
          }
        }
      } catch (cause) {
        addSystemMessage('Decode error', cause instanceof Error ? cause.message : String(cause), 'error');
      }
    });

    ws.addEventListener('error', () => {
      if (socket !== ws) return;
      status = 'error';
      error = 'WebSocket error. The server may be unreachable or may have rejected the handshake.';
    });

    ws.addEventListener('close', (event) => {
      if (socket !== ws) return;
      socket = null;
      status = 'closed';
      const details = [event.code, event.reason || 'no reason'].join(' · ');
      addSystemMessage('Disconnected', details, event.wasClean ? 'system' : 'error');
    });
  }

  function disconnect() {
    if (socket) {
      const current = socket;
      socket = null;
      current.close(1000, 'Closed from playground');
    }
    if (status === 'open' || status === 'connecting') status = 'closed';
  }

  async function decodeMessage(data) {
    const receivedAt = Date.now();

    if (typeof data === 'string') {
      const bytes = new TextEncoder().encode(data).byteLength;
      try {
        const value = JSON.parse(data);
        return { id: crypto.randomUUID(), receivedAt, kind: 'json', value, raw: data, bytes };
      } catch {
        return { id: crypto.randomUUID(), receivedAt, kind: 'text', value: data, raw: data, bytes };
      }
    }

    const buffer = data instanceof Blob ? await data.arrayBuffer() : data;
    const bytes = buffer.byteLength;

    try {
      const value = decodeRelayFrame(buffer);
      return { id: crypto.randomUUID(), receivedAt, kind: 'csr1', value, raw: null, bytes };
    } catch {
      return {
        id: crypto.randomUUID(),
        receivedAt,
        kind: 'binary',
        value: toHexPreview(new Uint8Array(buffer)),
        raw: null,
        bytes,
      };
    }
  }

  function decodeRelayFrame(arrayBuffer) {
    const bytes = new Uint8Array(arrayBuffer);
    const view = new DataView(arrayBuffer);
    const decoder = new TextDecoder();

    if (bytes.length < 27 || decoder.decode(bytes.subarray(0, 4)) !== 'CSR1') {
      throw new Error('Not a CSR1 frame');
    }

    const kind = view.getUint8(4);
    const sourceLength = view.getUint16(5, false);
    const sequence = view.getBigUint64(7, false);
    const receivedAtMs = view.getBigUint64(15, false);
    const payloadLength = view.getUint32(23, false);
    const sourceStart = 27;
    const payloadStart = sourceStart + sourceLength;

    if (payloadStart + payloadLength !== bytes.length) {
      throw new Error('Invalid CSR1 frame length');
    }

    const source = decoder.decode(bytes.subarray(sourceStart, payloadStart));
    const payloadBytes = bytes.subarray(payloadStart);
    let payload;

    if (kind === 1) {
      const text = decoder.decode(payloadBytes);
      try {
        payload = JSON.parse(text);
      } catch {
        payload = text;
      }
    } else {
      payload = {
        byteLength: payloadBytes.byteLength,
        hex: toHexPreview(payloadBytes),
      };
    }

    return {
      source,
      sequence: sequence.toString(),
      receivedAtMs: receivedAtMs.toString(),
      receivedAt: new Date(Number(receivedAtMs)).toISOString(),
      kind,
      payload,
    };
  }

  function toHexPreview(bytes, limit = 256) {
    const shown = bytes.subarray(0, limit);
    const hex = Array.from(shown, (byte) => byte.toString(16).padStart(2, '0')).join(' ');
    return bytes.length > limit ? `${hex} … (+${bytes.length - limit} bytes)` : hex;
  }

  function addSystemMessage(title, value, kind = 'system') {
    if (paused) return;
    messages = [
      {
        id: crypto.randomUUID(),
        receivedAt: Date.now(),
        kind,
        value: { title, value },
        raw: null,
        bytes: 0,
      },
      ...messages,
    ].slice(0, Math.min(maxMessages, MAX_RENDERED_MESSAGES));
  }

  function clearMessages() {
    messages = [];
    totalMessages = 0;
    totalBytes = 0;
    connectedAt = isOpen ? Date.now() : null;
  }

  function formatValue(item) {
    if (item.kind === 'text' || item.kind === 'binary') return String(item.value);
    return prettyJson ? JSON.stringify(item.value, null, 2) : JSON.stringify(item.value);
  }

  function isJsonItem(item) {
    return !['text', 'binary'].includes(item.kind);
  }

  function formatBytes(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KiB`;
    return `${(bytes / 1024 ** 2).toFixed(2)} MiB`;
  }

  async function copyUrl() {
    if (generatedUrlError) {
      error = generatedUrlError;
      return;
    }

    try {
      await navigator.clipboard.writeText(generatedUrl);
      addSystemMessage('Copied URL', generatedUrl);
    } catch {
      error = 'Could not copy to clipboard.';
    }
  }

  async function loadSources() {
    sourcesStatus = 'Loading…';
    sourceOptions = [];

    try {
      const url = httpBase(baseUrl);
      url.pathname = '/sources';
      const response = await fetch(url);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json();
      sourceOptions = Array.isArray(data) ? data : [];
      sourcesStatus = `${sourceOptions.length} source${sourceOptions.length === 1 ? '' : 's'} loaded`;
    } catch (cause) {
      sourcesStatus = `Could not load /sources: ${cause instanceof Error ? cause.message : String(cause)}`;
    }
  }

  function applyPreset(name) {
    endpoint = 'multiplex';
    repeatedSources = '';
    sourcesCsv = '';
    payloadTypes = '';
    dedupByContent = false;
    dedupWindowSecs = 300;
    jaq = '';
    binary = false;

    if (name === 'adverts') {
      payloadTypes = 'ADVERT';
      dedupByContent = true;
    } else if (name === 'compact') {
      jaq = '{ source: .source, sequence: .sequence, type: .payload.data.decoded.header.payloadTypeName, hash: .payload.data.hash }';
    } else if (name === 'binary') {
      binary = true;
    }
  }
</script>

<svelte:head>
  <title>Tangleveil Playground</title>
</svelte:head>

<main>
  <header class="page-header">
    <div>
      <p class="eyebrow">WebSocket client</p>
      <h1>Tangleveil Playground</h1>
      <p class="lede">Compose a subscription at the top, then inspect its live JSON or CSR1 stream below.</p>
    </div>
    <div class:online={isOpen} class="status-pill">
      <span class="status-dot"></span>
      {status}
    </div>
  </header>

  <section class="panel query-panel">
    <div class="query-panel-header">
      <div>
        <p class="eyebrow">Subscription builder</p>
        <h2>Endpoint & query parameters</h2>
      </div>
      <div class="presets" aria-label="Query presets">
        <button class="chip" onclick={() => applyPreset('adverts')}>Unique adverts</button>
        <button class="chip" onclick={() => applyPreset('compact')}>Compact jaq</button>
        <button class="chip" onclick={() => applyPreset('binary')}>Binary</button>
      </div>
    </div>

    <div class="connection-strip">
      <label class="server-field">
        <span>Server</span>
        <input bind:value={baseUrl} placeholder="wss://tangleveil.example" spellcheck="false" />
      </label>

      <fieldset class="segmented endpoint-select">
        <legend>Endpoint</legend>
        <label><input type="radio" bind:group={endpoint} value="multiplex" /> /ws</label>
        <label><input type="radio" bind:group={endpoint} value="source" /> /ws/:source</label>
        <label><input type="radio" bind:group={endpoint} value="telemetry" /> telemetry</label>
      </fieldset>

      {#if endpoint === 'source'}
        <label class="direct-source-field">
          <span>Source id</span>
          <input bind:value={directSource} list="source-list" placeholder="prague" spellcheck="false" />
        </label>
      {/if}

      <div class="connection-actions">
        <button class="secondary" onclick={loadSources}>Load /sources</button>
        <button class="primary" onclick={connect} disabled={isConnecting || isOpen || Boolean(generatedUrlError)}>
          {isConnecting ? 'Connecting…' : 'Connect'}
        </button>
        <button class="secondary icon-action" onclick={disconnect} disabled={!isConnecting && !isOpen}>Disconnect</button>
      </div>
    </div>

    <datalist id="source-list">
      {#each sourceOptions as source}
        <option value={source.id}>{source.state ?? ''}</option>
      {/each}
    </datalist>

    {#if endpoint === 'multiplex'}
      <div class="query-grid">
        <label class="jaq-field">
          <span><code>jaq</code> <small>optional transformation / filter</small></span>
          <textarea
            bind:value={jaq}
            rows="7"
            placeholder={'select(.payload.data.decoded.header.payloadTypeName == "ADVERT")'}
            spellcheck="false"
          ></textarea>
          <small>No output drops the frame; every output becomes a separate JSON message.</small>
        </label>

        <div class="parameter-fields">
          <label>
            <span><code>source</code> <small>repeatable</small></span>
            <textarea bind:value={repeatedSources} rows="2" placeholder={'prague\nbrno'}></textarea>
            <small>One id per line or comma-separated.</small>
          </label>

          <label>
            <span><code>sources</code> <small>CSV</small></span>
            <input bind:value={sourcesCsv} placeholder="prague,brno" spellcheck="false" />
          </label>

          <label>
            <span><code>payloadTypes</code> <small>CSV</small></span>
            <input bind:value={payloadTypes} placeholder="ADVERT,REQ" spellcheck="false" />
          </label>
        </div>
      </div>

      <div class="query-options">
        <label class="check">
          <input type="checkbox" bind:checked={dedupByContent} />
          <span><code>dedupByContent</code></span>
        </label>
        <label class="option-number">
          <span><code>dedupWindowSecs</code></span>
          <input type="number" min="1" step="1" bind:value={dedupWindowSecs} disabled={!dedupByContent} />
        </label>
        <label class="check">
          <input type="checkbox" bind:checked={binary} />
          <span><code>binary=1</code> / CSR1</span>
        </label>
        {#if jaqOverridesBinary}
          <p class="inline-warning">jaq emits JSON, so it overrides <code>binary=1</code>.</p>
        {/if}
      </div>
    {:else if endpoint === 'telemetry'}
      <p class="endpoint-note">Telemetry has no query parameters. Connect to receive aggregate source statistics.</p>
    {:else}
      <p class="endpoint-note">The direct source endpoint forwards one source without multiplex query parameters.</p>
    {/if}

    <div class="url-row">
      <div class="url-box">
        <span class="url-label">Generated URL</span>
        <code>{generatedUrl || 'Invalid WebSocket URL'}</code>
      </div>
      <button class="secondary" onclick={copyUrl}>Copy URL</button>
    </div>

    {#if sourcesStatus}
      <p class="hint status-message">{sourcesStatus}</p>
    {/if}
    {#if generatedUrlError}
      <p class="error">{generatedUrlError}</p>
    {/if}
    {#if error}
      <p class="error">{error}</p>
    {/if}
  </section>

  <section class="panel output-panel">
    <div class="output-header">
      <div>
        <p class="eyebrow">Live stream</p>
        <h2>Messages</h2>
      </div>
      <div class="stats">
        <span><strong>{totalMessages}</strong> frames</span>
        <span><strong>{formatBytes(totalBytes)}</strong></span>
        {#if connectedAt}
          <span>since {new Date(connectedAt).toLocaleTimeString()}</span>
        {/if}
      </div>
    </div>

    <div class="toolbar">
      <label class="check"><input type="checkbox" bind:checked={paused} /> Pause rendering</label>
      <label class="check"><input type="checkbox" bind:checked={prettyJson} /> Pretty JSON</label>
      <label class="check"><input type="checkbox" bind:checked={shikiHighlight} /> Shiki highlighting</label>
      <label class="check"><input type="checkbox" bind:checked={autoScroll} /> Follow latest</label>
      <label class="limit">
        Keep
        <input type="number" min="1" max={MAX_RENDERED_MESSAGES} bind:value={maxMessages} />
      </label>
      <button class="secondary small" onclick={clearMessages}>Clear</button>
    </div>

    <div class="messages" bind:this={outputElement}>
      {#if messages.length === 0}
        <div class="empty">
          <p>No messages yet.</p>
          <span>Configure the subscription above and connect.</span>
        </div>
      {:else}
        {#each messages as item (item.id)}
          <article class:error-message={item.kind === 'error'} class="message">
            <div class="message-meta">
              <span class="kind">{item.kind}</span>
              <time>{new Date(item.receivedAt).toLocaleTimeString()}</time>
              {#if item.bytes}<span>{formatBytes(item.bytes)}</span>{/if}
            </div>
            <HighlightedJson
              code={formatValue(item)}
              enabled={shikiHighlight && isJsonItem(item)}
            />
          </article>
        {/each}
      {/if}
    </div>
  </section>
</main>
