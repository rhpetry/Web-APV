# Web APV

Web APV is now a browser-only TypeScript application. It no longer depends on FastAPI, Python, or a server-side RDF runtime.

The application uses:

- `oxigraph` WebAssembly bindings to parse, inspect, and query local RDF graphs directly in the browser
- a dedicated Web Worker to run APV constraint discovery and validation without freezing the UI
- direct browser `fetch` calls for remote SPARQL endpoints when the endpoint allows CORS

## What changed

- The old backend and embedded Python APV runtime were removed.
- APV constraint discovery and validation logic were ported to TypeScript.
- Evaluation progress now lives entirely in browser state and exposes real iteration counts:
  `completed / remaining / total`
- The UI is a Vite + React SPA.

## Project structure

```text
src/
  App.tsx
  constants.ts
  types.ts
  lib/
    apv.ts
    workerProtocol.ts
  workers/
    evaluator.worker.ts
index.html
package.json
vite.config.ts
```

## Run locally

```bash
npm install
npm run dev
```

Then open the local Vite URL shown in the terminal.

## Build

```bash
npm run build
```

## Browser runtime behavior

- Local ontology files are parsed and evaluated entirely in the browser.
- Remote SPARQL endpoints are queried directly from the browser, so they must allow CORS.
- Protected endpoints can use a bearer token or a browser-reachable Keycloak token endpoint.
- APV constraint discovery runs first, then the validation checks execute in the browser worker.

## Current limits

- The browser refactor preserves APV evaluation behavior, progress tracking, local file parsing, and direct remote SPARQL querying.
- Local graph execution now runs through an in-memory Oxigraph store inside the worker, so persistence across reloads is still not built in.
