# Tangleveil Playground

A compact Svelte 5 + Vite browser client for testing Tangleveil WebSocket endpoints.

The subscription builder sits above the live stream and supports:

- `/ws` multiplex stream
- `/ws/{source}` direct source stream
- `/ws/telemetry`
- repeatable `source`
- comma-separated `sources`
- `payloadTypes`
- `dedupByContent`
- `dedupWindowSecs`
- `jaq`
- `binary=1`
- browser-side decoding of the compact `CSR1` binary envelope
- optional source discovery through `GET /sources`
- optional Shiki JSON syntax highlighting, with a plain-text fallback

Shiki is initialized lazily and uses a single cached highlighter instance. Turning highlighting off avoids highlighting new messages.

## Run

```bash
npm install
npm run dev
```

## Build

```bash
npm run build
```

The static output is written to `dist/` and can be hosted on GitHub Pages or any static server.

## Notes

WebSocket connections do not use normal browser CORS checks. The optional **Load /sources** request is regular HTTP and therefore requires the playground to be served from an allowed origin, behind the same reverse proxy, or with appropriate CORS headers on Tangleveil.
