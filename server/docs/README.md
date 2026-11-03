# Documentation

Builds the **API reference for the bundled `session.js` client library**

## Building

```bash
cd docs
npm install     # jsdoc + jsdoc-baseline (devDependencies only)
npm run docs    # generates api/ (deleted and rewritten on every run)
```

The output lands in `api/`.

## Reading / serving

Open `api/index.html` directly in a browser, or serve it:

```bash
npm run serve   # http-server on http://localhost:3002
```
