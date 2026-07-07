<p align="center">
    <a href="https://demo.webstrates.net/new?prototypeUrl=https://github.com/Webstrates/Stund/raw/main/prototypes/stund.zip" title="Create a new Stund Workspace">
        <img src="./docs/logo.svg" width="128" />
    </a>
</p>

<h1 align="center">Stund</h1>
<h3 align="center">Activity-Enriched Collaborative Workspaces Mediated by Artificial Intelligence</h3>
<br/>

## About

Stund is an activity-enriched collaborative workspace mediated by artificial intelligence. It builds on the Webstrates platform including [Webstrates](https://www.webstrates.net/) and [Codestrates](https://codestrates.projects.cavi.au.dk/). It uses [tldraw](https://tldraw.dev/) to display the shared 2D canvas.


## Use

Stund can run on any Webstrates server. To setup your own Webstrates server see the [Webstrates documentation](https://webstrates.github.io/gettingstarted/installation.html).

To create an instance of Stund use the prototype ZIP file using the [HTTP API](https://webstrates.github.io/userguide/http-api.html) of Webstrates. The following link creates a copy on the public [demo.webstrates.net](https://demo.webstrates.net/) server:

> https://demo.webstrates.net/new?prototypeUrl=https://github.com/Webstrates/Stund/raw/main/prototypes/stund.zip

To create a copy on your own server replace the server address with your server:

```
https://your-webstrates-server.com/new?prototypeUrl=https://github.com/Webstrates/Stund/raw/main/prototypes/stund.zip
```

To overcome potential CORS issues, you can use a CDN:

```
https://your-webstrates-server.com/new?prototypeUrl=https://cdn.jsdelivr.net/gh/Webstrates/Stund@main/prototypes/stund.zip
```


## Documentation

Find the documentation in the [docs](docs) folder.


## Research Paper

> Marcel Borowski, Janus Bager Kristensen, Payod Panda, Sean Rintel, Niklas Elmqvist, Jens Emil Grønbœk, and Clemens N. Klokmose. 2026. Stund: Activity-Enriched Collaborative Workspaces Mediated by Artificial Intelligence. In *Proceedings of the 39th Annual ACM Symposium on User Interface Software and Technology (UIST ’26)*. ACM. https://doi.org/10.1145/xxxxxxx.xxxxxxx.

```bibtex
@article{Stund2026,
    author    = {Borowski, Marcel and Kristensen, Janus Bager and Panda, Payod and Rintel, Sean and Elmqvist, Niklas and Grønbœk, Jens Emil and Klokmose, Clemens N.},
    title     = {Stund: Activity-Enriched Collaborative Workspaces Mediated by Artificial Intelligence},
    year      = {2026},
    journal   = {Proceedings of the 39th Annual ACM Symposium on User Interface Software and Technology},
    publisher = {Association for Computing Machinery},
    doi       = {10.1145/xxxxxxx.xxxxxxx},
}
```
