function getFileExtensionFromMimeType(mimeType) {
    if (typeof mimeType !== 'string' || !mimeType) {
        return null;
    }

    // Create a Map for quick lookups
    const mimeTypeMap = new Map([
        // Images
        ['image/jpeg', 'jpg'],
        ['image/png', 'png'],
        ['image/gif', 'gif'],
        ['image/webp', 'webp'],
        ['image/svg+xml', 'svg'],
        ['image/tiff', 'tif'],
        ['image/bmp', 'bmp'],
        ['image/vnd.microsoft.icon', 'ico'],

        // Audio
        ['audio/mpeg', 'mp3'],
        ['audio/wav', 'wav'],
        ['audio/ogg', 'ogg'],
        ['audio/midi', 'mid'],
        ['audio/aac', 'aac'],

        // Video
        ['video/mp4', 'mp4'],
        ['video/webm', 'webm'],
        ['video/ogg', 'ogv'],
        ['video/x-msvideo', 'avi'],
        ['video/quicktime', 'mov'],

        // Text & Documents
        ['text/plain', 'txt'],
        ['text/html', 'html'],
        ['text/css', 'css'],
        ['text/javascript', 'js'],
        ['application/json', 'json'],
        ['application/pdf', 'pdf'],
        ['application/xml', 'xml'],
        ['application/zip', 'zip'],
        ['application/gzip', 'gz'],
        ['application/vnd.rar', 'rar'],
        ['application/vnd.ms-excel', 'xls'],
        ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'xlsx'],
        ['application/msword', 'doc'],
        ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'docx'],
        ['application/vnd.ms-powerpoint', 'ppt'],
        ['application/vnd.openxmlformats-officedocument.presentationml.presentation', 'pptx']
    ]);

    // Use toLowerCase() for case-insensitive matching
    const normalizedMime = mimeType.toLowerCase().split(';')[0].trim();
    return mimeTypeMap.get(normalizedMime) || null;
}

export class WebstrateAssetStore {
    async upload(asset, file) {
        // Timestamp all files to avoid overwriting assets
        let fileName = 'tldraw-asset_' + new Date().valueOf() + '_' + file.name;

        // Ensure file has extension
        const hasExtension = /\.[a-zA-Z0-9]{1,5}$/.test(fileName);
        if (!hasExtension) {
            let extension = getFileExtensionFromMimeType(file.type);
            if (extension) {
                fileName += '.' + extension;
            } else {
                fileName += '.data';
            }
        }

        // POST the file to the Webstrate
        const formData = new FormData();
        formData.append('file', file, fileName);
        const request = new XMLHttpRequest();
        request.open('POST', window.location.pathname);
        request.send(formData);

        // Wait for the asset URL
        let result = await new Promise((resolve, reject) => {
            request.addEventListener('load', (e) => {
                resolve(JSON.parse(request.responseText));
            });
            request.addEventListener('error', (e) => {
                reject(new Error('Failed to POST asset'));
            });
        });

        return { src: './' + result.fileName };
    }

    async remove(assetIds) {
        console.log('Removing some assets... ', assetIds);
        assetIds.forEach(a => {
            console.log('remove asset', a);
            webstrate.deleteAsset(a.props.name);
        });
    }
}
