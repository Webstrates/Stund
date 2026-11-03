// The importmap script is the source of truth. Webstrates applies it directly,
// while MyWebstrates needs it copied into its own import map.
if (webstrate.importMap) {
    const importMapScript = document.querySelector('#ImportMapping script[type="importmap"]');
    if (importMapScript) {
        webstrate.importMap.content = JSON.parse(importMapScript.textContent);
    }
}
