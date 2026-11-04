# Stund Web Client

The web client of [Stund](../README.md) provides all frontend capabilities of Stund including the collaborative 2D canvas and the AI chat. It is built on top of the [Webstrates](https://www.webstrates.net/) platform and uses [tldraw](https://tldraw.dev/) to display the shared 2D canvas. All history features, such as recording, transcription, and the activity history, require a running activity session [server](../server/README.md).


## Use

Stund can run on any Webstrates server. To setup your own Webstrates server see the [Webstrates documentation](https://webstrates.github.io/gettingstarted/installation.html).

To create an instance of Stund use the prototype ZIP file using the [HTTP API](https://webstrates.github.io/userguide/http-api.html) of Webstrates. The following link creates a copy on the public [demo.webstrates.net](https://demo.webstrates.net/) server:

> https://demo.webstrates.net/new?prototypeUrl=https://github.com/Webstrates/Stund/raw/main/client/prototypes/stund.zip

To create a copy on your own server replace the server address with your server:

```
https://your-webstrates-server.com/new?prototypeUrl=https://github.com/Webstrates/Stund/raw/main/client/prototypes/stund.zip
```

To overcome potential CORS issues, you can use a CDN:

```
https://your-webstrates-server.com/new?prototypeUrl=https://cdn.jsdelivr.net/gh/Webstrates/Stund@main/client/prototypes/stund.zip
```


## Folder Structure

| Path                                           | Description                                                                               |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------- |
| [`docs`](docs)                                 | Documentation of the software stack and the code architecture.                            |
| [`fragment-sync`](fragment-sync)               | The synchronized code fragments of Stund as plain files for easier access and versioning. |
| [`licenses`](licenses)                         | License texts of embedded third-party components (see Third-Party Components below).      |
| [`prototypes`](prototypes)                     | The prototype (`stund.zip` and its unpacked `stund` folder) to create instances of Stund. |
| [`repository`](repository)                     | The WPM repository with the Stund packages, generated from the prototype.                 |
| [`update-deployment.sh`](update-deployment.sh) | Script to update the prototype ZIP and the repository after a new export (see below).     |


## Updating the Deployment

After replacing `prototypes/stund/index.html` and its assets with a new export, run the `update-deployment.sh` script. It cleans the prototype `index.html`, packages the `prototypes/stund` folder as `prototypes/stund.zip`, and creates `repository/stund.html` from the cleaned prototype.

```
./update-deployment.sh
```


## Third-Party Components

The client loads its libraries (e.g., React and tldraw) at run time from CDNs via the import map in [`ImportMapping.wpm`](fragment-sync/ImportMapping.wpm). They are not distributed with the client and keep their own licenses.

[tldraw](https://tldraw.dev/) is not open source: its [license](https://github.com/tldraw/tldraw/blob/main/LICENSE.md) requires a license key for production use. Paste your key into `tldrawLicenseKey` in [`Canvas View.jsx`](<fragment-sync/Core/App.wpm/Canvas View/Canvas View.jsx>).

The client is released under the MIT License as part of Stund — see [LICENSE](../LICENSE) in the repository root, which also lists the embedded components that are licensed under the Apache License 2.0 (full text in [licenses/Apache-2.0.txt](licenses/Apache-2.0.txt)).
