# Stund Web Client

The web client component of Stund provides all frontend capabilities of Stund including the collabroative 2D canvas and the AI chat. It is built on top of the [Webstrates](https://www.webstrates.net/) platform and uses [tldraw](https://tldraw.dev/) to display the shared 2D canvas.


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


## Updating the Deployment

After replacing `prototypes/stund/index.html` and its assets with a new export, run the `update-deployment.sh` script. It cleans the prototype `index.html`, packages the `prototypes/stund` folder as `prototypes/stund.zip`, and creates `repository/stund.html` from the cleaned prototype.

```
./update-deployment.sh
```
