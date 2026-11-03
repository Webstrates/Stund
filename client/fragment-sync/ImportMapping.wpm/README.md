# Import Mapping

This package includes the import mapping for Stund. It uses [esm.sh](https://esm.sh) as its package repository. Package versions are pinned to avoid breaking changes from implicit upgrades.

The mapping lives in the package's `<script type="importmap">`, synchronized to disk as `Importmap.json`. Edit it there directly. On MyWebstrates, `Update Import Mapping.js` copies it into `webstrate.importMap`.

`lz-string` uses JSPM's ESM build to avoid an AMD loader conflict with Codestrates' RequireJS loader. The esm.sh build registers with AMD when `define.amd` is present, leaving its module export empty and breaking tldraw copy and paste. The tldraw URL must keep `lz-string` in its `external` list so this import mapping is used. Reload the page after changing the mapping to replace already loaded modules.
