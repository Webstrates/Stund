# AGENTS.md

Webstrates + Codestrates + Fragment Filesystem Sync — Agents Documentation — V2.3


## Fragment Filesystem Sync

This folder contains synchronized fragments from a codestrate as plain files. Code cannot be executed locally and there is no build step — editing files here syncs changes back to the live webstrate.

### When Edits Are Applied

- Edits sync only while a browser tab is synchronizing (about once per second); edits made while no tab is synchronizing are overwritten when it starts
- If a file and its fragment both change in the same tick, the disk wins
- Hidden files and folders (starting with `.`) are ignored

### Fragment Files and Folders

Files correspond to `<code-fragment>` elements in the DOM. The file extension is derived from the fragment's `data-type`: `.js`, `.jsx`, `.slop`, `.ts`, `.py`, `.rb`, `.lua`, `.html`, `.md`, `.tex`, `.svg`, `.json`, `.css`, `.scss`. Fragments of any other type use `.txt`.

Folders correspond to `<code-folder>` elements, and folders ending in `.wpm` correspond to `<wpm-package>` elements. The folder structure on disk mirrors the DOM hierarchy of fragments and folders in the webstrate.

The file- and foldername comes from the `name=""` attribute on the element. Folder names keep their dots; only the `.wpm` suffix of package folders is removed from the element name.

### Inline Scripts

Inline `<script>` elements inside a `<code-folder>` or `<wpm-package>` (e.g., WPM bootstrap or descriptor scripts) are also synchronized as files:

- The filename comes from the `name` attribute, then the `id` prefixed with `#` (e.g., `#FragmentFilesystemSync.js`, `#descriptor-script.json`), and otherwise `script`
- Editing a script file updates the DOM but does not execute the script again; the change takes effect on the next page reload
- Deleting a script file removes the script from the DOM
- Do not rename script files: files created on disk always become `<code-fragment>` elements, so a renamed script becomes a fragment and loses its script attributes

### Control Files

Fragment Filesystem Sync stores its control files in the `.ffs` folder in the workspace root. This folder is reserved and does not represent a folder in the codestrate DOM.

The `.ffs/ffs.attributes.json` file contains a nested JSON tree mirroring the filesystem hierarchy. Each entry can have an `_attributes` key with the DOM attributes of that fragment, script or folder. All attributes are synchronized except `name` and attributes starting with `transient-`; common ones are `auto`, `data-type`, `class` and `id`.

- Read this file to understand which CSS classes and IDs are assigned to each fragment
- Edit, add or remove attribute keys inside an existing `_attributes` object and they will be synced to the DOM on the next tick
- Do not add or remove file/folder entries in this JSON — Fragment Filesystem Sync owns the tree structure
- `name` and `transient-*` attributes are ignored here; rename the file to change `name`
- The `.ffs/ffs.meta` file contains internal synchronization state and must never be edited manually

The `.ffs/ffs.dom-order.json` file contains arrays describing the DOM order of synchronized fragments and folders under each filesystem directory path.

- Reorder existing generated array entries to change DOM sibling order; do not invent paths or entry names
- Changing an array moves the corresponding elements in the live DOM on the next sync tick
- Wait for a newly created or renamed file/folder to appear after a sync tick before changing its order
- JSON property order in `.ffs/ffs.attributes.json` does not control DOM order

The `.ffs/wpm.bootconfig.json` file contains the exact text of the WPM boot configuration from `head script[type="text/json+bootconfig"]`.

- Changes are synchronized in both directions without JSON validation or reformatting
- If both disk and DOM change between ticks, the disk content wins
- Deleting the file regenerates it from the DOM
- Changing it affects WPM on the next page boot; it does not reload packages in the current session

### Creating, Renaming, and Deleting Files

Files and folders can be created, renamed, and deleted on disk, and the changes will sync to the DOM:

- **Renaming** is a delete + create. Attributes are carried over when the renamed fragment is matched by its (nonempty) contents; they are lost if it is empty or was edited in the same tick. Rename without editing, then check `.ffs/ffs.attributes.json` and re-add any missing attributes
- **Creating** a new file or folder will initially have no attributes — wait approximately one sync tick for its entry to appear in `.ffs/ffs.attributes.json`, then add or modify only the required keys inside its generated `_attributes` object
- **Ordering** a new or renamed file/folder requires waiting for it to appear in `.ffs/ffs.dom-order.json`, then moving its existing array entry
- Never create the file/folder entry in `.ffs/ffs.attributes.json` manually; Fragment Filesystem Sync owns the tree structure
- CSS and SCSS fragments need `auto: ""` to be active, and importable JavaScript or JSX fragments need the appropriate `class` or `id`


## Development

- You should only edit files in the `Code` folder unless the user asks for other changes explicitely
- `.ffs/ffs.attributes.json` and `.ffs/ffs.dom-order.json` are the permitted exceptions when a Code change requires assigning attributes or changing DOM order; only edit generated attribute keys/values or reorder generated array entries
- Refrain from making edits to files by deleting and recreating them, as this removes attributes from fragments and reorders fragments in the DOM

### Importing and Exporting

- Imports between fragments use DOM query selectors under the hood, not the filesystem path
- **Exporting** a value from a fragment:
    - Use standard ES module `export` syntax.
    - The fragment must have an `id` or `class` attribute set in `.ffs/ffs.attributes.json` that the importer can reference
- **Importing** from another fragment:
    - Use `import MyComponent from '#PackageId .fragmentClass';` — where `PackageId` is the `id` of the `.wpm` folder and `fragmentClass` is the `class` on the fragment file
    - A fragment with its own `id` can also be imported directly, e.g. `import { MainAgent } from '#main-agent-slop';`
    - The `.default` portion of a selector refers to the fragment's CSS class, not to a JavaScript default export
    - Match the import syntax to the fragment's actual ES module export: use `import { MyComponent } from '#MyPackage .default';` for a named export
    - Do **not** use relative imports like `import MyComponent from '../MyComponent';`
    - Do **not** use filesystem folder paths like `import MyComponent from '#Code/MyComponent';`
- CSS and SCSS files cannot export and import values

### WPM Descriptors and Assets

- List every package dependency and asset in the package's `descriptor.json`
- Shared repository packages must declare their own transitive package dependencies rather than relying on the consuming app to install them
- Assets are not fragment files and may not appear in the synchronized package folder; after an asset has been added to the WPM package, list its filename in `assets` and reference it with a package-relative URL such as `example.svg`

### Code Style

- Use 4 spaces for indentation
- Use single quotes for strings
- Use semicolons at the end of statements
- Use camelCase for variable and function names
- Use PascalCase for React component names
- Use descriptive names for variables and functions
- Add a newline at the end of files
- Titles on, e.g., buttons should be in Title Case, e.g., "Submit Query"
- Use material icons over emojis by giving an element the "material-icons" class
- Do not use BEM class naming (e.g. `block__element--modifier`); use SCSS nesting instead


## Platform Documentation

- Webstrates: https://www.webstrates.net/
    - Webstrates API: https://webstrates.github.io/userguide/api.html
- Codestrates: https://codestrates.projects.cavi.au.dk/
    - Codestrates API: https://codestrates.projects.cavi.au.dk/api/codestrates/
    - Cauldron API: https://codestrates.projects.cavi.au.dk/api/cauldron/
    - Webstrates Package Manager (WPM): https://codestrates.projects.cavi.au.dk/api/wpm/
- cQuery: https://codestrates.projects.cavi.au.dk/api/cquery/cQuery.html

### Webstrates API

Collaborative web document editing platform with real-time synchronization capabilities:
- **Events**: Subscribe to document loading, element changes, and user interactions
- **Data Management**: Transient data (temporary), cookies (persistent across devices), and oplog (operation history)
- **Collaboration**: Asset management with versioning, client monitoring, signaling between users
- **Advanced Features**: Performance optimization, protected mode, permissions/access control, invite keys, version control and restoration

### Codestrates API

Built on Webstrates, enables persistent DOM changes with multi-language fragment support:
- **Editors**: Multiple editor types (AceEditor, CodemirrorEditor, MonacoEditor) with common methods like getValue(), setValue(), insertText(), deleteText()
- **Fragments**: Support for various languages (HTML, CSS, JavaScript, Python, etc.) with text insertion/deletion handlers
- **Event System**: Editor events for blur, focus, and selection changes
- **Programming Languages**: Multi-language fragment execution and management

### Cauldron API

Browser-based IDE for editing Webstrates directly in the browser:
- **Core Classes**: Cauldron (open/close/createComponent), CauldronEditor (editing), CauldronInspector (content binding), CauldronSettings (configuration)
- **Events**: Initialization, open/close, and fragment editor events
- **Features**: Direct web editing without developer tools, component management, settings configuration
- **Status**: No stable release yet, extensible IDE-like tool for web document manipulation

### WPM (Webstrates Package Manager) v2 API

Comprehensive package management system for web-based applications:
- **Core Classes**: WPMv2 (primary package management), WPMInterface (package events and interactions)
- **Repository Management**: Register/unregister repositories, package discovery and installation
- **Dependencies**: Dependency resolution, package metadata management, external requirements
- **Key Methods**: registerRepository(), installWPMInto(), getCurrentlyInstalledPackages(), requireAll()

<!-- End Base AGENTS.md File -->



# Stund

## Design

Use the [Material Design](https://m2.material.io/design/color/the-color-system.html#tools-for-picking-colors) colors:

```yaml
material_design_colors:
  red: { "50": "#FFEBEE", "100": "#FFCDD2", "200": "#EF9A9A", "300": "#E57373", "400": "#EF5350", "500": "#F44336", "600": "#E53935", "700": "#D32F2F", "800": "#C62828", "900": "#B71C1C", "A100": "#FF8A80", "A200": "#FF5252", "A400": "#FF1744", "A700": "#D50000" }
  pink: { "50": "#FCE4EC", "100": "#F8BBD0", "200": "#F48FB1", "300": "#F06292", "400": "#EC407A", "500": "#E91E63", "600": "#D81B60", "700": "#C2185B", "800": "#AD1457", "900": "#880E4F", "A100": "#FF80AB", "A200": "#FF4081", "A400": "#F50057", "A700": "#C51162" }
  purple: { "50": "#F3E5F5", "100": "#E1BEE7", "200": "#CE93D8", "300": "#BA68C8", "400": "#AB47BC", "500": "#9C27B0", "600": "#8E24AA", "700": "#7B1FA2", "800": "#6A1B9A", "900": "#4A148C", "A100": "#EA80FC", "A200": "#E040FB", "A400": "#D500F9", "A700": "#AA00FF" }
  deep_purple: { "50": "#EDE7F6", "100": "#D1C4E9", "200": "#B39DDB", "300": "#9575CD", "400": "#7E57C2", "500": "#673AB7", "600": "#5E35B1", "700": "#512DA8", "800": "#4527A0", "900": "#311B92", "A100": "#B388FF", "A200": "#7C4DFF", "A400": "#651FFF", "A700": "#6200EA" }
  indigo: { "50": "#E8EAF6", "100": "#C5CAE9", "200": "#9FA8DA", "300": "#7986CB", "400": "#5C6BC0", "500": "#3F51B5", "600": "#3949AB", "700": "#303F9F", "800": "#283593", "900": "#1A237E", "A100": "#8C9EFF", "A200": "#536DFE", "A400": "#3D5AFE", "A700": "#304FFE" }
  blue: { "50": "#E3F2FD", "100": "#BBDEFB", "200": "#90CAF9", "300": "#64B5F6", "400": "#42A5F5", "500": "#2196F3", "600": "#1E88E5", "700": "#1976D2", "800": "#1565C0", "900": "#0D47A1", "A100": "#82B1FF", "A200": "#448AFF", "A400": "#2979FF", "A700": "#2962FF" }
  light_blue: { "50": "#E1F5FE", "100": "#B3E5FC", "200": "#81D4FA", "300": "#4FC3F7", "400": "#29B6F6", "500": "#03A9F4", "600": "#039BE5", "700": "#0288D1", "800": "#0277BD", "900": "#01579B", "A100": "#80D8FF", "A200": "#40C4FF", "A400": "#00B0FF", "A700": "#0091EA" }
  cyan: { "50": "#E0F7FA", "100": "#B2EBF2", "200": "#80DEEA", "300": "#4DD0E1", "400": "#26C6DA", "500": "#00BCD4", "600": "#00ACC1", "700": "#0097A7", "800": "#00838F", "900": "#006064", "A100": "#84FFFF", "A200": "#18FFFF", "A400": "#00E5FF", "A700": "#00B8D4" }
  teal: { "50": "#E0F2F1", "100": "#B2DFDB", "200": "#80CBC4", "300": "#4DB6AC", "400": "#26A69A", "500": "#009688", "600": "#00897B", "700": "#00796B", "800": "#00695C", "900": "#004D40", "A100": "#A7FFEB", "A200": "#64FFDA", "A400": "#1DE9B6", "A700": "#00BFA5" }
  green: { "50": "#E8F5E9", "100": "#C8E6C9", "200": "#A5D6A7", "300": "#81C784", "400": "#66BB6A", "500": "#4CAF50", "600": "#43A047", "700": "#388E3C", "800": "#2E7D32", "900": "#1B5E20", "A100": "#B9F6CA", "A200": "#69F0AE", "A400": "#00E676", "A700": "#00C853" }
  light_green: { "50": "#F1F8E9", "100": "#DCEDC8", "200": "#C5E1A5", "300": "#AED581", "400": "#9CCC65", "500": "#8BC34A", "600": "#7CB342", "700": "#689F38", "800": "#558B2F", "900": "#33691E", "A100": "#CCFF90", "A200": "#B2FF59", "A400": "#76FF03", "A700": "#64DD17" }
  lime: { "50": "#F9FBE7", "100": "#F0F4C3", "200": "#E6EE9C", "300": "#DCE775", "400": "#D4E157", "500": "#CDDC39", "600": "#C0CA33", "700": "#AFB42B", "800": "#9E9D24", "900": "#827717", "A100": "#F4FF81", "A200": "#EEFF41", "A400": "#C6FF00", "A700": "#AEEA00" }
  yellow: { "50": "#FFFDE7", "100": "#FFF9C4", "200": "#FFF59D", "300": "#FFF176", "400": "#FFEE58", "500": "#FFEB3B", "600": "#FDD835", "700": "#FBC02D", "800": "#F9A825", "900": "#F57F17", "A100": "#FFFF8D", "A200": "#FFFF00", "A400": "#FFEA00", "A700": "#FFD600" }
  amber: { "50": "#FFF8E1", "100": "#FFECB3", "200": "#FFE082", "300": "#FFD54F", "400": "#FFCA28", "500": "#FFC107", "600": "#FFB300", "700": "#FFA000", "800": "#FF8F00", "900": "#FF6F00", "A100": "#FFE57F", "A200": "#FFD740", "A400": "#FFC400", "A700": "#FFAB00" }
  orange: { "50": "#FFF3E0", "100": "#FFE0B2", "200": "#FFCC80", "300": "#FFB74D", "400": "#FFA726", "500": "#FF9800", "600": "#FB8C00", "700": "#F57C00", "800": "#EF6C00", "900": "#E65100", "A100": "#FFD180", "A200": "#FFAB40", "A400": "#FF9100", "A700": "#FF6D00" }
  deep_orange: { "50": "#FBE9E7", "100": "#FFCCBC", "200": "#FFAB91", "300": "#FF8A65", "400": "#FF7043", "500": "#FF5722", "600": "#F4511E", "700": "#E64A19", "800": "#D84315", "900": "#BF360C", "A100": "#FF9E80", "A200": "#FF6E40", "A400": "#FF3D00", "A700": "#DD2C00" }
  brown: { "50": "#EFEBE9", "100": "#D7CCC8", "200": "#BCAAA4", "300": "#A1887F", "400": "#8D6E63", "500": "#795548", "600": "#6D4C41", "700": "#5D4037", "800": "#4E342E", "900": "#3E2723" }
  grey: { "50": "#FAFAFA", "100": "#F5F5F5", "200": "#EEEEEE", "300": "#E0E0E0", "400": "#BDBDBD", "500": "#9E9E9E", "600": "#757575", "700": "#616161", "800": "#424242", "900": "#212121" }
  blue_grey: { "50": "#ECEFF1", "100": "#CFD8DC", "200": "#B0BEC5", "300": "#90A4AE", "400": "#78909C", "500": "#607D8B", "600": "#546E7A", "700": "#455A64", "800": "#37474F", "900": "#263238" }
```


## Project-Specific Quick Reference

### Active Runtime Anchors

- App root is rendered into transient `#app-root` by `Code/Core/Core.wpm/React Reloader.jsx`
- Main agent currently used by the sidebar is `#main-agent-slop` (`Main Agent.slop`)
- Main canvas persistence node is `<tldraw-document>` (hidden in CSS, synced via `DOM Sync.jsx`)
- Shared DOM store parent is `#meta-elements`; DOM stores created by widgets live in `#widget-stores`
- Local widget fragments live in `#widget-fragments`
- Local processor fragments live in `#processor-fragments`

### Dynamic Fragment Registration Classes

Live-queried — adding a fragment with the class is enough:

- `.dynamic-canvas-component` -> mounted inside `<Tldraw>`
- `.dynamic-gui-component` -> mounted as global app UI
- `.dynamic-button-bar-component` -> mounted in button bar

Statically imported — a new fragment also needs an import in the listed file:

- `.dynamic-shape-component` -> tldraw shape utils, imported in `App.jsx`
- `.dynamic-tool-component` -> tldraw tools, imported in `App.jsx`
- `.dynamic-context-menu-component` -> context menu entries, imported in `Editor Changes.jsx`

### Important Cross-Component Events

- AI sidebar orchestration:
  - `ai-sidebar-create-chat`
  - `ai-sidebar-update-active-chat`
- AI chat history recording:
  - `ai-chat-entry-finalized`
  - `ai-chat-step-added`
- Streaming:
  - `local-stream-added-${streamKey}` / `local-stream-removed-${streamKey}`
  - `stream-added-${streamKey}` / `stream-removed-${streamKey}`

### Important Persisted Keys

- AI sidebar:
  - `ai-sidebar-shared-tabs`
  - `ai-sidebar-active-users`
  - `ai-sidebar-minimized` (cookie)
  - `ai-sidebar-width` (cookie)
- AI chat DOM store namespace is `ai-chat` with per-chat keys:
  - `chat-entries-${chatId}`
  - `chat-processing-${chatId}`
  - `chat-input-${chatId}`
  - `chat-toolgroups-${chatId}`
- Session history:
  - `history-session-id`
  - `history-session-auto-join`
  - `history-session-joined` (transient)
  - `history-model-server` (history server override; empty means the code default)
  - recorder toggles (cookies): `stateRecorderActive`, `interactionRecorderActive`, `streamRecorderActive`, `chatRecorderActive`
- Stream managers:
  - `client-streams-${streamKey}`
  - `client-names-${streamKey}`
  - actual `MediaStream` objects are kept in `window.clientStreams` under `${streamKey}${clientId}`

### Repository Defaults and Cookie Keys

- Widget repository default: `stund-widget-repository`
  - `widget-repository-urls`
  - `widget-repository-selected`
- Processor repository default: `stund-processor-repository`
  - `processor-repository-urls`
  - `processor-repository-selected`

### Model Roles Used in `ai-models` Cookie

- `main-agent`
- `search-expert`
- `canvas-expert`
- `canvas-expert-image-generation`
- `history-model-expert`
- `widget-expert`
- `processor-expert`
- `widget-completion`
- `widget-image-generation`
- `widget-speech-to-text`
- `widget-text-to-speech`
- `speak-prompt-transcription`

The active connector and its base URLs are stored in the `ai-connector` and `ai-connector-base-urls` cookies.


## Additional Documentation

- **Architecture**: `ARCHITECTURE.md` — runtime composition, subsystems, persisted state and data flows
- **Core Helpers**: `Code/Core/CoreHelpers.wpm/README.md` — documentation for the global events system, persisted state hooks, and dynamic components
- **Fragment Filesystem Sync**: `Codestrates/FragmentFilesystemSync.wpm/README.md` — full synchronization rules
