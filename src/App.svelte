<script>
  import HighlightedJson from './HighlightedJson.svelte';

  const DEFAULT_BASE_URL = 'wss://tangleveil.meshcore.ninja';
  const TANGLEVEIL_SITE_URL = 'https://tangleveil.meshcore.ninja';
  const BUILDER_WIDTH_KEY = 'tangleveil-playground.builder-width';
  const MIN_BUILDER_WIDTH = 280;
  const DEFAULT_BUILDER_WIDTH = 400;
  const MAX_BUILDER_WIDTH = 760;
  const MAX_RENDERED_MESSAGES = 500;
  const THROUGHPUT_WINDOW_MS = 5000;
  const THROUGHPUT_STALE_MS = 2000;

  const PAYLOAD_TYPE_COLORS = [
    '#75d695',
    '#8eb4ea',
    '#e0c468',
    '#f4b27a',
    '#c9a0ff',
    '#7fd4c4',
    '#f0a3aa',
    '#dbc681',
    '#9fd9b4',
    '#9cc3ff',
    '#ffb4a2',
    '#b8f0cb',
  ];

  const COMPACT_KIND_COLORS = {
    system: '#8f97a3',
    error: '#f0a3aa',
    text: '#aec5e8',
    binary: '#dbc681',
    csr1: '#9cc3ff',
    json: '#8f97a3',
  };

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
  let compactView = $state(false);
  let shikiHighlight = $state(true);
  let autoScroll = $state(true);
  let maxMessages = $state(100);
  let totalMessages = $state(0);
  let totalBytes = $state(0);
  let connectedAt = $state(null);
  let connectedUrl = $state('');
  let connectedParams = $state(null);
  let lastMessageAt = $state(null);
  let throughputSamples = $state([]);
  let throughputTick = $state(0);
  let sourceOptions = $state([]);
  let sourcesStatus = $state('');
  let outputElement = $state(null);
  let copiedMessageId = $state(null);
  let copiedMessageTimer;
  let builderWidth = $state(readBuilderWidth());
  let isResizingColumns = $state(false);

  function readBuilderWidth() {
    if (typeof window === 'undefined') return DEFAULT_BUILDER_WIDTH;

    const stored = Number(localStorage.getItem(BUILDER_WIDTH_KEY));
    if (!Number.isFinite(stored)) return DEFAULT_BUILDER_WIDTH;
    return Math.min(MAX_BUILDER_WIDTH, Math.max(MIN_BUILDER_WIDTH, stored));
  }

  function maxBuilderWidth() {
    if (typeof window === 'undefined') return MAX_BUILDER_WIDTH;
    return Math.max(MIN_BUILDER_WIDTH, window.innerWidth - 360);
  }

  function onColumnResizerPointerDown(event) {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = builderWidth;
    isResizingColumns = true;

    function onMove(moveEvent) {
      builderWidth = Math.min(
        maxBuilderWidth(),
        Math.max(MIN_BUILDER_WIDTH, startWidth + (moveEvent.clientX - startX)),
      );
    }

    function onUp() {
      isResizingColumns = false;
      localStorage.setItem(BUILDER_WIDTH_KEY, String(Math.round(builderWidth)));
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
    }

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
  }

  $effect(() => {
    if (typeof document === 'undefined') return;
    document.body.classList.toggle('is-resizing-columns', isResizingColumns);
    return () => document.body.classList.remove('is-resizing-columns');
  });

  const isOpen = $derived(status === 'open');
  const isConnecting = $derived(status === 'connecting');
  const isLive = $derived(isOpen || isConnecting);
  const multiplexEnabled = $derived(endpoint === 'multiplex');
  const jaqOverridesBinary = $derived(Boolean(jaq.trim()) && binary);
  const statusLabel = $derived(
    status === 'open'
      ? 'Live'
      : status === 'connecting'
        ? 'Connecting'
        : status === 'closed'
          ? 'Disconnected'
          : status === 'error'
            ? 'Error'
            : 'Idle',
  );

  const throughput = $derived.by(() => {
    if (!isOpen) {
      return { packetsPerSec: 0, bytesPerSec: 0, bitsPerSec: 0 };
    }

    throughputTick;
    const now = Date.now();

    if (lastMessageAt && now - lastMessageAt > THROUGHPUT_STALE_MS) {
      return { packetsPerSec: 0, bytesPerSec: 0, bitsPerSec: 0 };
    }

    const samples = throughputSamples.filter((sample) => now - sample.at <= THROUGHPUT_WINDOW_MS);
    if (samples.length === 0) {
      return { packetsPerSec: 0, bytesPerSec: 0, bitsPerSec: 0 };
    }

    const spanSec = Math.max((now - samples[0].at) / 1000, 0.001);
    const bytes = samples.reduce((sum, sample) => sum + sample.bytes, 0);
    const bytesPerSec = bytes / spanSec;
    return {
      packetsPerSec: samples.length / spanSec,
      bytesPerSec,
      bitsPerSec: bytesPerSec * 8,
    };
  });

  $effect(() => {
    if (!isOpen) return;

    const id = setInterval(() => {
      throughputTick += 1;
      const now = Date.now();
      throughputSamples = throughputSamples.filter((sample) => now - sample.at <= THROUGHPUT_WINDOW_MS);
    }, 1000);

    return () => clearInterval(id);
  });

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

  const activeParamChips = $derived.by(() => {
    if (endpoint !== 'multiplex') return [];

    const chips = [];
    const sources = splitValues(repeatedSources);

    if (sources.length) {
      chips.push({ key: 'source', preview: sources.join(', ') });
    }
    if (sourcesCsv.trim()) {
      chips.push({ key: 'sources', preview: normalizeCsv(sourcesCsv) });
    }
    if (payloadTypes.trim()) {
      chips.push({ key: 'payloadTypes', preview: normalizeCsv(payloadTypes) });
    }
    if (dedupByContent) {
      chips.push({ key: 'dedupByContent', preview: '1' });
      if (Number.isFinite(Number(dedupWindowSecs)) && Number(dedupWindowSecs) > 0) {
        chips.push({ key: 'dedupWindowSecs', preview: String(Math.trunc(Number(dedupWindowSecs))) });
      }
    }
    if (jaq.trim()) {
      chips.push({ key: 'jaq', preview: truncatePreview(jaq.trim(), 52) });
    }
    if (binary) {
      chips.push({ key: 'binary', preview: '1', overridden: Boolean(jaq.trim()) });
    }

    return chips;
  });

  function paramEnabled(name) {
    switch (name) {
      case 'jaq':
        return Boolean(jaq.trim());
      case 'repeatedSources':
        return splitValues(repeatedSources).length > 0;
      case 'sourcesCsv':
        return Boolean(sourcesCsv.trim());
      case 'payloadTypes':
        return Boolean(payloadTypes.trim());
      case 'dedupByContent':
        return dedupByContent;
      case 'dedupWindowSecs':
        return dedupByContent;
      case 'binary':
        return binary;
      case 'directSource':
        return Boolean(directSource.trim());
      default:
        return false;
    }
  }

  function truncatePreview(value, max = 48) {
    return value.length > max ? `${value.slice(0, max)}…` : value;
  }

  function recordThroughput(bytes) {
    const now = Date.now();
    throughputSamples = [
      ...throughputSamples.filter((sample) => now - sample.at <= THROUGHPUT_WINDOW_MS),
      { at: now, bytes },
    ];
  }

  function resetThroughput() {
    throughputSamples = [];
    throughputTick += 1;
  }

  function formatRate(value) {
    if (value <= 0) return '0';
    if (value < 10) return value.toFixed(1);
    if (value < 1000) return value.toFixed(1);
    return Math.round(value).toLocaleString();
  }

  async function measureMessageBytes(data) {
    if (typeof data === 'string') {
      return new TextEncoder().encode(data).byteLength;
    }
    if (data instanceof Blob) {
      return (await data.arrayBuffer()).byteLength;
    }
    if (data instanceof ArrayBuffer) {
      return data.byteLength;
    }
    if (ArrayBuffer.isView(data)) {
      return data.byteLength;
    }
    return 0;
  }

  function formatMbit(bytesPerSec) {
    if (bytesPerSec <= 0) return '0';

    const mbitPerSec = (bytesPerSec * 8) / 1_000_000;
    if (mbitPerSec >= 100) return String(Math.round(mbitPerSec));
    if (mbitPerSec >= 10) return mbitPerSec.toFixed(1);

    for (let decimals = 1; decimals <= 6; decimals++) {
      const formatted = mbitPerSec.toFixed(decimals);
      if (!/^0\.0+$/.test(formatted)) return formatted;
    }

    return mbitPerSec.toFixed(6);
  }

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

  function serializeShareParams() {
    const params = new URLSearchParams();

    if (baseUrl.trim() && baseUrl.trim() !== DEFAULT_BASE_URL) {
      params.set('server', baseUrl.trim());
    }

    if (endpoint !== 'multiplex') {
      params.set('endpoint', endpoint);
    }

    if (endpoint === 'source' && directSource.trim()) {
      params.set('directSource', directSource.trim());
    }

    if (endpoint === 'multiplex') {
      for (const source of splitValues(repeatedSources)) {
        params.append('source', source);
      }

      if (sourcesCsv.trim()) params.set('sources', sourcesCsv.trim());
      if (payloadTypes.trim()) params.set('payloadTypes', payloadTypes.trim());

      if (dedupByContent) {
        params.set('dedupByContent', '1');
        if (Number(dedupWindowSecs) !== 300) {
          params.set('dedupWindowSecs', String(Math.trunc(Number(dedupWindowSecs))));
        }
      }

      if (jaq.trim()) params.set('jaq', jaq.trim());
      if (binary) params.set('binary', '1');
    }

    return params;
  }

  function applyShareParams(params) {
    const server = params.get('server');
    if (server) baseUrl = server;

    const ep = params.get('endpoint');
    if (ep === 'multiplex' || ep === 'source' || ep === 'telemetry') {
      endpoint = ep;
    }

    if (params.has('directSource')) {
      directSource = params.get('directSource') ?? '';
    }

    if (params.has('source')) {
      repeatedSources = params.getAll('source').join('\n');
    }

    if (params.has('sources')) {
      sourcesCsv = params.get('sources') ?? '';
    }

    if (params.has('payloadTypes')) {
      payloadTypes = params.get('payloadTypes') ?? '';
    }

    if (params.has('dedupByContent')) {
      dedupByContent = params.get('dedupByContent') === '1';
    }

    if (params.has('dedupWindowSecs')) {
      const windowSecs = Number(params.get('dedupWindowSecs'));
      if (Number.isFinite(windowSecs) && windowSecs > 0) {
        dedupWindowSecs = windowSecs;
      }
    }

    if (params.has('jaq')) {
      jaq = params.get('jaq') ?? '';
    }

    if (params.has('binary')) {
      binary = params.get('binary') === '1';
    }
  }

  function buildShareUrl() {
    const params = serializeShareParams();
    const url = new URL(window.location.href);
    url.search = params.toString();
    url.hash = '';
    return url.toString();
  }

  function syncShareUrl() {
    const params = serializeShareParams();
    const url = new URL(window.location.href);
    url.search = params.toString();
    url.hash = '';
    history.replaceState(history.state, '', url);
  }

  if (typeof window !== 'undefined') {
    const initialShareParams = new URLSearchParams(window.location.search);
    if ([...initialShareParams.keys()].length > 0) {
      applyShareParams(initialShareParams);
    }
  }

  $effect(() => {
    baseUrl;
    endpoint;
    directSource;
    repeatedSources;
    sourcesCsv;
    payloadTypes;
    dedupByContent;
    dedupWindowSecs;
    jaq;
    binary;

    if (typeof window === 'undefined') return;
    syncShareUrl();
  });

  function snapshotParams() {
    return {
      baseUrl,
      endpoint,
      directSource,
      repeatedSources,
      sourcesCsv,
      payloadTypes,
      dedupByContent,
      dedupWindowSecs: Number(dedupWindowSecs),
      jaq,
      binary,
    };
  }

  function fieldStale(name) {
    if (!isOpen || !connectedParams) return false;
    const current = snapshotParams()[name];
    const previous = connectedParams[name];
    if (name === 'dedupWindowSecs') {
      return Number(current) !== Number(previous);
    }
    return current !== previous;
  }

  function reconnectIfLive() {
    if (isOpen) connect();
  }

  function reconnectFromField() {
    connect();
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
    lastMessageAt = null;
    resetThroughput();

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
      connectedUrl = generatedUrl;
      connectedParams = snapshotParams();
      addSystemMessage('Connected', generatedUrl);
    });

    ws.addEventListener('message', async (event) => {
      if (socket !== ws) return;

      try {
        const wireBytes = await measureMessageBytes(event.data);
        const item = await decodeMessage(event.data);
        totalMessages += 1;
        totalBytes += wireBytes;
        lastMessageAt = Date.now();
        recordThroughput(wireBytes);

        if (!paused) {
          messages = [item, ...messages].slice(0, Math.min(maxMessages, MAX_RENDERED_MESSAGES));
          if (autoScroll) {
            requestAnimationFrame(() => {
              if (outputElement) outputElement.scrollTop = 0;
            });
          }
        }
      } catch (cause) {
        addSystemMessage('Decode error', cause instanceof Error ? cause.message : String(cause), 'error');
      }
    });

    ws.addEventListener('error', () => {
      if (socket !== ws) return;
      status = 'error';
      resetThroughput();
      error = 'WebSocket error. The server may be unreachable or may have rejected the handshake.';
    });

    ws.addEventListener('close', (event) => {
      if (socket !== ws) return;
      socket = null;
      status = 'closed';
      connectedUrl = '';
      connectedParams = null;
      resetThroughput();
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
    connectedUrl = '';
    connectedParams = null;
    resetThroughput();
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
    resetThroughput();
  }

  function formatValue(item) {
    if (item.kind === 'text' || item.kind === 'binary') return String(item.value);
    return prettyJson ? JSON.stringify(item.value, null, 2) : JSON.stringify(item.value);
  }

  async function copyMessage(item) {
    try {
      await navigator.clipboard.writeText(formatValue(item));
      copiedMessageId = item.id;
      clearTimeout(copiedMessageTimer);
      copiedMessageTimer = setTimeout(() => {
        if (copiedMessageId === item.id) copiedMessageId = null;
      }, 1200);
    } catch {
      error = 'Could not copy message to clipboard.';
    }
  }

  function pickPath(value, path) {
    let current = value;
    for (const key of path) {
      if (current == null || typeof current !== 'object') return undefined;
      current = current[key];
    }
    return current;
  }

  function inlineValue(value, max = 96) {
    if (value == null) return '';
    if (typeof value === 'string') return truncatePreview(value, max);
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
    return truncatePreview(JSON.stringify(value), max);
  }

  function extractPayloadTypeFromValue(value) {
    if (!value || typeof value !== 'object') return null;

    const type =
      pickPath(value, ['payload', 'data', 'decoded', 'header', 'payloadTypeName']) ??
      pickPath(value, ['payload', 'data', 'decoded', 'header', 'payloadType']) ??
      value.type ??
      value.payloadType;

    return type == null ? null : String(type);
  }

  function payloadTypeColor(type) {
    let hash = 0;
    for (let i = 0; i < type.length; i += 1) {
      hash = (hash * 33 + type.charCodeAt(i)) >>> 0;
    }
    return PAYLOAD_TYPE_COLORS[hash % PAYLOAD_TYPE_COLORS.length];
  }

  function compactLineColor(item, payloadType) {
    if (payloadType) return payloadTypeColor(payloadType);
    return COMPACT_KIND_COLORS[item.kind] ?? '#8f97a3';
  }

  function summarizeJson(value) {
    const payloadType = extractPayloadTypeFromValue(value);
    const parts = [];

    if (value.source) parts.push(`source=${value.source}`);
    if (value.sequence != null) parts.push(`seq=${value.sequence}`);

    const hash = pickPath(value, ['payload', 'data', 'hash']) ?? value.hash;
    if (hash) parts.push(`hash=${truncatePreview(String(hash), 18)}`);

    return {
      payloadType,
      body: parts.length > 0 ? parts.join(' ') : inlineValue(value, 140),
    };
  }

  function summarizeCsr1(value) {
    const payloadType =
      value.payload && typeof value.payload === 'object'
        ? extractPayloadTypeFromValue(value.payload)
        : null;
    const parts = [`source=${value.source}`, `seq=${value.sequence}`];

    if (typeof value.payload === 'string') {
      parts.push(`payload=${inlineValue(value.payload, 72)}`);
    } else if (value.payload && typeof value.payload === 'object') {
      if (value.payload.byteLength != null) parts.push(`bytes=${value.payload.byteLength}`);
      if (value.payload.hex) parts.push(`hex=${truncatePreview(value.payload.hex, 48)}`);
      else parts.push(`payload=${inlineValue(value.payload, 72)}`);
    }

    return { payloadType, body: parts.join(' ') };
  }

  function compactLineTime(receivedAt) {
    return new Date(receivedAt).toLocaleTimeString('en-US', {
      hour12: false,
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      fractionalSecondDigits: 3,
    });
  }

  function compactLineParts(item) {
    const time = compactLineTime(item.receivedAt);

    if (item.kind === 'system' || item.kind === 'error') {
      const { title, value } = item.value;
      return {
        time,
        kind: item.kind,
        payloadType: null,
        meta: null,
        body: `${title}: ${value}`,
      };
    }

    if (item.kind === 'text') {
      return {
        time,
        kind: 'text',
        payloadType: null,
        meta: null,
        body: String(item.value),
      };
    }

    if (item.kind === 'binary') {
      return {
        time,
        kind: 'binary',
        payloadType: null,
        meta: formatBytes(item.bytes),
        body: truncatePreview(String(item.value), 96),
      };
    }

    if (item.kind === 'csr1') {
      const { payloadType, body } = summarizeCsr1(item.value);
      return {
        time,
        kind: 'csr1',
        payloadType,
        meta: item.bytes ? formatBytes(item.bytes) : null,
        body,
      };
    }

    const { payloadType, body } = summarizeJson(item.value);
    return {
      time,
      kind: 'json',
      payloadType,
      meta: item.bytes ? formatBytes(item.bytes) : null,
      body,
    };
  }

  function isJsonItem(item) {
    return !compactView && !['text', 'binary'].includes(item.kind);
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

  async function copyShareLink() {
    try {
      const shareUrl = buildShareUrl();
      await navigator.clipboard.writeText(shareUrl);
      addSystemMessage('Copied share link', shareUrl);
    } catch {
      error = 'Could not copy share link to clipboard.';
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

    if (isOpen) connect();
  }
</script>

<svelte:head>
  <title>Tangleveil Playground</title>
</svelte:head>

<main>
  <header class="page-header">
    <div>
      <p class="eyebrow">
        WebSocket client ·
        <a class="header-link" href={TANGLEVEIL_SITE_URL} target="_blank" rel="noopener noreferrer">
          tangleveil.meshcore.ninja
        </a>
      </p>
      <h1>Tangleveil Playground</h1>
      <p class="lede">Compose a subscription on the left, then inspect the live JSON or CSR1 stream on the right.</p>
    </div>
    <div class:live={isOpen} class:connecting={isConnecting} class="status-pill">
      <span class="status-dot"></span>
      <span class="status-label">{statusLabel}</span>
      {#if isOpen}
        <span class="status-detail">{formatRate(throughput.packetsPerSec)} pkt/s</span>
        <span class="status-detail">{formatMbit(throughput.bytesPerSec)} Mbit/s</span>
      {/if}
    </div>
  </header>

  <div class="app-columns" style:--builder-width="{builderWidth}px">
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

    <div class="connection-block">
      <label class="server-field">
        <span class="field-label-row">
          <span>Server</span>
          {#if fieldStale('baseUrl')}
            <button type="button" class="field-reload" onclick={reconnectFromField} title="Reconnect with updated server">
              ↻ Reconnect
            </button>
          {/if}
        </span>
        <input bind:value={baseUrl} placeholder="wss://tangleveil.example" spellcheck="false" />
      </label>

      <div class="connection-strip">
        <fieldset class="segmented endpoint-select">
          <legend>Endpoint</legend>
          <label><input type="radio" bind:group={endpoint} value="multiplex" onchange={reconnectIfLive} /> /ws</label>
          <label><input type="radio" bind:group={endpoint} value="source" onchange={reconnectIfLive} /> /ws/:source</label>
          <label><input type="radio" bind:group={endpoint} value="telemetry" onchange={reconnectIfLive} /> telemetry</label>
        </fieldset>

        {#if endpoint === 'source'}
          <label class="direct-source-field" class:param-active={paramEnabled('directSource')}>
            <span class="field-label-row">
              <span>
                Source id
                <span class="param-state" class:on={paramEnabled('directSource')}>
                  {paramEnabled('directSource') ? 'On' : 'Off'}
                </span>
              </span>
              {#if fieldStale('directSource')}
                <button type="button" class="field-reload" onclick={reconnectFromField} title="Reconnect with updated source">
                  ↻ Reconnect
                </button>
              {/if}
            </span>
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
    </div>

    <datalist id="source-list">
      {#each sourceOptions as source}
        <option value={source.id}>{source.state ?? ''}</option>
      {/each}
    </datalist>

    {#if endpoint === 'multiplex'}
      <div class="active-params" aria-label="Active query parameters">
        <span class="active-params-label">Active</span>
        {#if activeParamChips.length === 0}
          <span class="active-params-empty">No filters — all multiplex traffic</span>
        {:else}
          {#each activeParamChips as chip}
            <span class="param-chip" class:overridden={chip.overridden}>
              <code>{chip.key}</code>
              <span>{chip.preview}</span>
              {#if chip.overridden}
                <em>ignored</em>
              {/if}
            </span>
          {/each}
        {/if}
      </div>

      <div class="query-grid">
        <label class="jaq-field" class:param-active={paramEnabled('jaq')}>
          <span class="field-label-row">
            <span>
              <code>jaq</code>
              <span class="param-state" class:on={paramEnabled('jaq')}>{paramEnabled('jaq') ? 'On' : 'Off'}</span>
              <small>optional transformation / filter</small>
            </span>
            {#if fieldStale('jaq')}
              <button type="button" class="field-reload" onclick={reconnectFromField} title="Reconnect with updated jaq">
                ↻ Reconnect
              </button>
            {/if}
          </span>
          <textarea
            bind:value={jaq}
            rows="4"
            placeholder={'select(.payload.data.decoded.header.payloadTypeName == "ADVERT")'}
            spellcheck="false"
          ></textarea>
          <small>
            Uses <a class="inline-link" href="https://cht.sh/jq" target="_blank" rel="noopener noreferrer">jq syntax</a>.
            No output drops the frame; every output becomes a separate JSON message.
          </small>
        </label>

        <div class="parameter-fields">
          <label class:param-active={paramEnabled('repeatedSources')}>
            <span class="field-label-row">
              <span>
                <code>source</code>
                <span class="param-state" class:on={paramEnabled('repeatedSources')}>
                  {paramEnabled('repeatedSources') ? 'On' : 'Off'}
                </span>
                <small>repeatable</small>
              </span>
              {#if fieldStale('repeatedSources')}
                <button type="button" class="field-reload" onclick={reconnectFromField} title="Reconnect with updated sources">
                  ↻ Reconnect
                </button>
              {/if}
            </span>
            <textarea bind:value={repeatedSources} rows="2" placeholder={'prague\nbrno'}></textarea>
            <small>One id per line or comma-separated.</small>
          </label>

          <label class:param-active={paramEnabled('sourcesCsv')}>
            <span class="field-label-row">
              <span>
                <code>sources</code>
                <span class="param-state" class:on={paramEnabled('sourcesCsv')}>
                  {paramEnabled('sourcesCsv') ? 'On' : 'Off'}
                </span>
                <small>CSV</small>
              </span>
              {#if fieldStale('sourcesCsv')}
                <button type="button" class="field-reload" onclick={reconnectFromField} title="Reconnect with updated sources CSV">
                  ↻ Reconnect
                </button>
              {/if}
            </span>
            <input bind:value={sourcesCsv} placeholder="prague,brno" spellcheck="false" />
          </label>

          <label class:param-active={paramEnabled('payloadTypes')}>
            <span class="field-label-row">
              <span>
                <code>payloadTypes</code>
                <span class="param-state" class:on={paramEnabled('payloadTypes')}>
                  {paramEnabled('payloadTypes') ? 'On' : 'Off'}
                </span>
                <small>CSV</small>
              </span>
              {#if fieldStale('payloadTypes')}
                <button type="button" class="field-reload" onclick={reconnectFromField} title="Reconnect with updated payload types">
                  ↻ Reconnect
                </button>
              {/if}
            </span>
            <input bind:value={payloadTypes} placeholder="ADVERT,REQ" spellcheck="false" />
          </label>
        </div>
      </div>

      <div class="query-options">
        <label class="check" class:param-active={paramEnabled('dedupByContent')}>
          <input type="checkbox" bind:checked={dedupByContent} onchange={reconnectIfLive} />
          <span>
            <code>dedupByContent</code>
            <span class="param-state" class:on={paramEnabled('dedupByContent')}>
              {paramEnabled('dedupByContent') ? 'On' : 'Off'}
            </span>
          </span>
        </label>
        <label class="option-number" class:param-active={paramEnabled('dedupWindowSecs')}>
          <span class="field-label-row">
            <span>
              <code>dedupWindowSecs</code>
              <span class="param-state" class:on={paramEnabled('dedupWindowSecs')}>
                {paramEnabled('dedupWindowSecs') ? 'On' : 'Off'}
              </span>
            </span>
            {#if fieldStale('dedupWindowSecs')}
              <button type="button" class="field-reload" onclick={reconnectFromField} title="Reconnect with updated dedup window">
                ↻ Reconnect
              </button>
            {/if}
          </span>
          <input type="number" min="1" step="1" bind:value={dedupWindowSecs} disabled={!dedupByContent} />
        </label>
        <label
          class="check"
          class:param-active={paramEnabled('binary') && !jaqOverridesBinary}
          class:param-overridden={jaqOverridesBinary}
        >
          <input type="checkbox" bind:checked={binary} onchange={reconnectIfLive} />
          <span>
            <code>binary=1</code> / CSR1
            <span
              class="param-state"
              class:on={paramEnabled('binary') && !jaqOverridesBinary}
              class:overridden={jaqOverridesBinary}
            >
              {jaqOverridesBinary ? 'Ignored' : paramEnabled('binary') ? 'On' : 'Off'}
            </span>
          </span>
        </label>
        {#if jaqOverridesBinary}
          <p class="inline-warning">jaq emits JSON, so it overrides <code>binary=1</code>.</p>
        {/if}
      </div>
    {:else if endpoint === 'telemetry'}
      <div class="active-params" aria-label="Active endpoint">
        <span class="active-params-label">Active</span>
        <span class="param-chip path"><code>/ws/telemetry</code></span>
        <span class="active-params-empty">No query parameters</span>
      </div>
      <p class="endpoint-note">Telemetry has no query parameters. Connect to receive aggregate source statistics.</p>
    {:else}
      <div class="active-params" aria-label="Active endpoint">
        <span class="active-params-label">Active</span>
        {#if paramEnabled('directSource')}
          <span class="param-chip path"><code>/ws/{directSource.trim()}</code></span>
        {:else}
          <span class="active-params-empty">Enter a source id above</span>
        {/if}
      </div>
      <p class="endpoint-note">The direct source endpoint forwards one source without multiplex query parameters.</p>
    {/if}

    <div class="url-row">
      <div class="url-box">
        <span class="url-label">Generated URL</span>
        <code>{generatedUrl || 'Invalid WebSocket URL'}</code>
      </div>
      <div class="url-actions">
        <button class="secondary" onclick={copyUrl}>Copy URL</button>
        <button class="secondary" onclick={copyShareLink}>Copy share link</button>
      </div>
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

  <div
    class="column-resizer"
    class:dragging={isResizingColumns}
    role="separator"
    aria-orientation="vertical"
    aria-label="Resize subscription builder"
    aria-valuemin={MIN_BUILDER_WIDTH}
    aria-valuemax={MAX_BUILDER_WIDTH}
    aria-valuenow={Math.round(builderWidth)}
    onpointerdown={onColumnResizerPointerDown}
  ></div>

  <section class:live={isOpen} class:connecting={isConnecting} class="panel output-panel">
    {#if isLive}
      <div class="live-banner" role="status" aria-live="polite">
        <span class="live-banner-pulse"></span>
        <strong>{isOpen ? 'Stream live' : 'Connecting stream…'}</strong>
        {#if isOpen}
          <span class="live-banner-detail">
            Receiving on <code>{connectedUrl || generatedUrl}</code>
          </span>
          {#if lastMessageAt}
            <span class="live-banner-detail">Last frame {new Date(lastMessageAt).toLocaleTimeString()}</span>
            <span class="live-banner-detail throughput-detail">
              <strong>{formatRate(throughput.packetsPerSec)}</strong> pkt/s ·
              <strong>{formatMbit(throughput.bytesPerSec)}</strong> Mbit/s
            </span>
          {:else}
            <span class="live-banner-detail">Waiting for first frame…</span>
          {/if}
        {/if}
      </div>
    {/if}

    <div class="output-header">
      <div>
        <p class="eyebrow">Live stream</p>
        <h2>Messages</h2>
      </div>
      <div class="stats">
        {#if isOpen}
          <span class="live-chip"><span class="live-chip-dot"></span> Live</span>
        {/if}
        <span><strong>{totalMessages}</strong> frames</span>
        <span><strong>{formatBytes(totalBytes)}</strong></span>
        {#if isOpen}
          <span class="stat-throughput"><strong>{formatRate(throughput.packetsPerSec)}</strong> pkt/s</span>
          <span class="stat-throughput"><strong>{formatMbit(throughput.bytesPerSec)}</strong> Mbit/s</span>
        {/if}
        {#if connectedAt}
          <span>since {new Date(connectedAt).toLocaleTimeString()}</span>
        {/if}
      </div>
    </div>

    <div class="toolbar">
      <label class="check"><input type="checkbox" bind:checked={paused} /> Pause rendering</label>
      <label class="check"><input type="checkbox" bind:checked={compactView} /> Compact lines</label>
      <label class="check"><input type="checkbox" bind:checked={prettyJson} disabled={compactView} /> Pretty JSON</label>
      <label class="check"><input type="checkbox" bind:checked={shikiHighlight} disabled={compactView} /> Shiki highlighting</label>
      <label class="check"><input type="checkbox" bind:checked={autoScroll} /> Follow latest</label>
      <label class="limit">
        Keep
        <input type="number" min="1" max={MAX_RENDERED_MESSAGES} bind:value={maxMessages} />
      </label>
      <button class="secondary small" onclick={clearMessages}>Clear</button>
    </div>

    <div class:compact={compactView} class="messages" bind:this={outputElement}>
      {#if messages.length === 0}
        <div class="empty">
          <p>{isOpen ? 'Connected — waiting for frames…' : 'No messages yet.'}</p>
          <span>{isOpen ? 'The stream is live. Messages will appear here as they arrive.' : 'Configure the subscription above and connect.'}</span>
        </div>
      {:else}
        {#each messages as item (item.id)}
          <article class:error-message={item.kind === 'error'} class:compact={compactView} class="message">
            {#if compactView}
              {@const parts = compactLineParts(item)}
              {@const lineColor = compactLineColor(item, parts.payloadType)}
              <div class="compact-message-row">
                <pre class="message-line" style:--payload-color={lineColor}>
                  <span class="line-muted">{parts.time}</span>
                  <span class="line-kind">{parts.kind}</span>
                  {#if parts.payloadType}
                    <span class="line-payload-type">{parts.payloadType}</span>
                  {/if}
                  {#if parts.meta}
                    <span class="line-muted">{parts.meta}</span>
                  {/if}
                  <span class="line-body">{parts.body}</span>
                </pre>
                <button
                  type="button"
                  class="message-copy"
                  class:copied={copiedMessageId === item.id}
                  onclick={() => copyMessage(item)}
                  title="Copy record"
                >
                  {copiedMessageId === item.id ? 'Copied' : 'Copy'}
                </button>
              </div>
            {:else}
              <div class="message-meta">
                <div class="message-meta-main">
                  <span class="kind">{item.kind}</span>
                  <time>{new Date(item.receivedAt).toLocaleTimeString()}</time>
                  {#if item.bytes}<span>{formatBytes(item.bytes)}</span>{/if}
                </div>
                <button
                  type="button"
                  class="message-copy"
                  class:copied={copiedMessageId === item.id}
                  onclick={() => copyMessage(item)}
                  title="Copy JSON record"
                >
                  {copiedMessageId === item.id ? 'Copied' : 'Copy'}
                </button>
              </div>
              <HighlightedJson
                code={formatValue(item)}
                enabled={shikiHighlight && isJsonItem(item)}
              />
            {/if}
          </article>
        {/each}
      {/if}
    </div>
  </section>
  </div>
</main>
