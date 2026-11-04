# Documentation

## Software Stack

The Stund web client is built using the following technologies:

### Webstrates Stack

| Technology                                                  | Description                                           |
| ----------------------------------------------------------- | ----------------------------------------------------- |
| **[Webstrates](https://www.webstrates.net/)**               | Data synchronization and persistence substrate.       |
| **[Codestrates](https://codestrates.projects.cavi.au.dk/)** | Code authoring and execution development environment. |

### Application Stack

| Technology                            | Description                   |
| ------------------------------------- | ----------------------------- |
| **[esm.sh](https://esm.sh/)**         | A CDN for serving ES modules. |
| **[React](https://react.dev/)**       | View and state management.    |
| **[tldraw](https://www.tldraw.dev/)** | 2D canvas rendering engine.   |


## Code Architecture

Stund has no build step: its code lives as code fragments inside the webstrate, grouped into WPM ([Webstrates Package Manager](https://codestrates.projects.cavi.au.dk/api/wpm/)) packages, and is composed at runtime in the browser. The code can be edited in Cauldron, the IDE of Codestrates, or as plain files in the [`fragment-sync`](../fragment-sync) folder, whose folders mirror the package structure:

| Folder                                                                 | Contents                                                                                            |
| ---------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| [`Core`](../fragment-sync/Core)                                       | Entry point with hot reload, the root app with the tldraw canvas, shared state helpers, and fonts. |
| [`Helpers`](../fragment-sync/Helpers)                                 | Reusable UI building blocks such as dialogs, the button bar, and shape fullscreen.                 |
| [`Shape Types`](../fragment-sync/Shape%20Types)                       | Custom tldraw shapes for widgets, documents, and video and screen streams.                         |
| [`Button Bar Components`](../fragment-sync/Button%20Bar%20Components) | Managers for models, session history, streams, repositories, the mobile interface, and Stund info. |
| [`AI Integration`](../fragment-sync/AI%20Integration)                 | The AI sidebar and chat, the agents, and SlopScript with its model connectors.                     |
| [`History Model`](../fragment-sync/History%20Model)                   | The connection to the activity session server, the session spec, the event schemas, and recorders. |
| [`Streaming`](../fragment-sync/Streaming)                             | Sharing of audio, video, and screen streams between clients.                                       |
| [`ImportMapping.wpm`](../fragment-sync/ImportMapping.wpm)             | The import map that resolves the third-party libraries from esm.sh.                                |

See [`ARCHITECTURE.md`](../fragment-sync/ARCHITECTURE.md) for a detailed description of the runtime composition, the extension points, the subsystems, and the end-to-end data flows.
