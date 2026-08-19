import { requireConnectorCapability, getConnectorAuthHeaders } from '#SlopScript .connector-factory';



// These helpers speak the OpenAI REST style against whichever connector is
// selected in the Model Manager. Backend-specific request-body params arrive
// through `config.bodyExtras` rather than being baked into the defaults below.

const DEFAULT_COMPLETION_OPTIONS = {
    temperature: 1,
    max_tokens: 8192
};

const DEFAULT_TOOL_OPTIONS = {
    tool_choice: 'auto',
    parallel_tool_calls: true
};

const DEFAULT_TTS_OPTIONS = {
    voice: 'alloy',
    response_format: 'mp3',
    speed: 1
};

const DEFAULT_IMAGE_OPTIONS = {
    n: 1,
    response_format: 'b64_json'
};



// TRANSCRIPTION STT

export const getTranscriptionSupportedMimeType = () => {
    if (typeof MediaRecorder === 'undefined' || typeof MediaRecorder.isTypeSupported !== 'function') {
        return '';
    }

    const preferredTypes = [
        'audio/webm;codecs=opus',
        'audio/webm',
        'audio/ogg;codecs=opus',
        'audio/ogg',
        'audio/mp4'
    ];

    for (const mimeType of preferredTypes) {
        if (MediaRecorder.isTypeSupported(mimeType)) {
            return mimeType;
        }
    }

    return '';
};

const getFileExtension = (mimeType) => {
    switch (mimeType) {
        case 'audio/webm':
            return 'webm';
        case 'audio/ogg':
            return 'ogg';
        case 'audio/mp4':
            return 'mp4';
        case 'audio/mpeg':
            return 'mp3';
        case 'audio/wav':
            return 'wav';
        default:
            return 'webm';
    }
};

export const transcribeAudioBlob = async (audioBlob, options = {}) => {
    if (!(audioBlob instanceof Blob) || audioBlob.size === 0) {
        throw new Error('No audio data available for transcription');
    }

    const config = requireConnectorCapability('transcription', 'Audio transcription');

    const {
        model = null,
        language = null,
        prompt = null,
        temperature = null
    } = options;

    if (typeof model !== 'string' || !model.trim()) {
        throw new Error('Transcription error: No model specified. Pass options.model, or select one in the Model Manager.');
    }

    const headers = await getConnectorAuthHeaders(config);
    const mimeType = audioBlob.type || 'audio/webm';
    const extension = getFileExtension(mimeType);
    const file = new File([audioBlob], `stt-input-${Date.now()}.${extension}`, { type: mimeType });

    const formData = new FormData();
    formData.append('file', file);
    formData.append('model', config.resolveModel(model));

    if (language) {
        formData.append('language', language);
    }
    if (prompt) {
        formData.append('prompt', prompt);
    }
    if (typeof temperature === 'number') {
        formData.append('temperature', String(temperature));
    }

    const response = await fetch(`${config.apiBase}/audio/transcriptions`, {
        method: 'POST',
        headers: headers,
        body: formData
    });

    let data = null;
    try {
        data = await response.json();
    } catch (error) {
        data = null;
    }

    if (!response.ok) {
        const errorMsg = data?.error?.message || JSON.stringify(data) || response.statusText;
        throw new Error(`Transcription error: ${errorMsg}`);
    }

    const text = data?.text;
    if (typeof text !== 'string') {
        throw new Error('Transcription error: No text returned');
    }

    return text;
};



// AUDIO RECORDING

/**
 * Record audio from the microphone, in a format `transcribeAudioBlob` accepts.
 *
 * Makes no API call, so it needs no connector and no capability check.
 *
 * @returns {Object} A handle with:
 *   - `stop()`   -> Promise<Blob> with the recording, and releases the microphone
 *   - `cancel()` -> discards the recording and releases the microphone
 *   - `state`    -> the underlying MediaRecorder state
 */
export const recordAudio = async () => {
    if (!navigator.mediaDevices?.getUserMedia) {
        throw new Error('Audio recording is not supported in this browser.');
    }
    if (typeof MediaRecorder === 'undefined') {
        throw new Error('MediaRecorder is not available in this browser.');
    }

    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });

    // Releasing the tracks is what turns off the browser's recording indicator.
    // Every exit path below has to go through here, including errors.
    let released = false;
    const releaseMicrophone = () => {
        if (released) {
            return;
        }
        released = true;
        stream.getTracks().forEach((track) => track.stop());
    };

    let recorder = null;
    try {
        const mimeType = getTranscriptionSupportedMimeType();
        recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
    } catch (error) {
        releaseMicrophone();
        throw error;
    }

    const chunks = [];
    recorder.ondataavailable = (event) => {
        if (event.data && event.data.size > 0) {
            chunks.push(event.data);
        }
    };

    const recordingFinished = new Promise((resolve, reject) => {
        recorder.onstop = () => {
            const chunkMimeType = recorder.mimeType || chunks[0]?.type || 'audio/webm';
            resolve(new Blob(chunks, { type: chunkMimeType }));
        };
        recorder.onerror = (event) => {
            releaseMicrophone();
            reject(new Error(`Audio recording failed: ${event?.error?.message || 'unknown error'}`));
        };
    });

    recorder.start();

    return {
        get state() {
            return recorder.state;
        },

        stop: async () => {
            if (recorder.state !== 'inactive') {
                recorder.stop();
            }
            try {
                return await recordingFinished;
            } finally {
                releaseMicrophone();
            }
        },

        cancel: () => {
            if (recorder.state !== 'inactive') {
                recorder.stop();
            }
            releaseMicrophone();
        }
    };
};



// TEXT TO SPEECH (TTS)

const AUDIO_MIME_TYPE_BY_FORMAT = {
    mp3: 'audio/mpeg',
    wav: 'audio/wav',
    opus: 'audio/opus',
    aac: 'audio/aac',
    flac: 'audio/flac',
    pcm: 'audio/pcm'
};

const normalizeTTSResponseFormat = (responseFormat) => {
    if (typeof responseFormat !== 'string' || !responseFormat.trim()) {
        return DEFAULT_TTS_OPTIONS.response_format;
    }

    return responseFormat.trim().toLowerCase();
};

const getTTSAudioMimeType = (responseFormat, fallbackMimeType = '') => {
    const normalizedFallback = typeof fallbackMimeType === 'string'
        ? fallbackMimeType.split(';')[0].trim()
        : '';
    if (normalizedFallback.startsWith('audio/')) {
        return normalizedFallback;
    }

    const normalizedResponseFormat = normalizeTTSResponseFormat(responseFormat);
    return AUDIO_MIME_TYPE_BY_FORMAT[normalizedResponseFormat] || 'audio/mpeg';
};

const normalizeBase64Audio = (audioValue) => {
    if (typeof audioValue !== 'string') {
        return '';
    }

    const trimmedValue = audioValue.trim();
    if (!trimmedValue) {
        return '';
    }

    if (trimmedValue.startsWith('data:')) {
        const [, base64Part = ''] = trimmedValue.split(',', 2);
        return base64Part.replace(/\s+/g, '');
    }

    return trimmedValue.replace(/\s+/g, '');
};

const parseTokenHeader = (headers, name) => {
    if (!headers || typeof headers.get !== 'function') {
        return null;
    }

    const headerValue = headers.get(name);
    if (headerValue === null || headerValue === undefined || headerValue === '') {
        return null;
    }

    const parsedValue = Number(headerValue);
    if (!Number.isFinite(parsedValue) || parsedValue < 0) {
        return null;
    }

    return parsedValue;
};

const parseTTSUsageFromHeaders = (headers) => {
    const promptTokens = parseTokenHeader(headers, 'x-litellm-prompt-tokens') ?? parseTokenHeader(headers, 'x-prompt-tokens');
    const completionTokens = parseTokenHeader(headers, 'x-litellm-completion-tokens') ?? parseTokenHeader(headers, 'x-completion-tokens');
    const totalTokens = parseTokenHeader(headers, 'x-litellm-total-tokens') ?? parseTokenHeader(headers, 'x-total-tokens');

    if (promptTokens === null && completionTokens === null && totalTokens === null) {
        return null;
    }

    return {
        prompt_tokens: promptTokens ?? 0,
        completion_tokens: completionTokens ?? 0,
        total_tokens: totalTokens ?? ((promptTokens ?? 0) + (completionTokens ?? 0))
    };
};

const readErrorResponse = async (response, prefix = 'TTS error') => {
    try {
        const data = await response.json();
        const errorMsg = data?.error?.message || JSON.stringify(data) || response.statusText;
        return `${prefix}: ${errorMsg}`;
    } catch (error) {
        const fallbackText = await response.text();
        return `${prefix}: ${fallbackText || response.statusText}`;
    }
};

export const textToSpeech = async (text, options = {}) => {
    const normalizedText = typeof text === 'string' ? text.trim() : '';
    if (!normalizedText) {
        throw new Error('TTS error: Input text must be a non-empty string');
    }

    const config = requireConnectorCapability('speech', 'Text-to-speech');

    const {
        model = null,
        voice = DEFAULT_TTS_OPTIONS.voice,
        response_format: responseFormatFromOption = DEFAULT_TTS_OPTIONS.response_format,
        responseFormat = responseFormatFromOption,
        speed = DEFAULT_TTS_OPTIONS.speed,
        instructions = null,
        ...requestOptions
    } = options;

    if (typeof model !== 'string' || !model.trim()) {
        throw new Error('TTS error: No model specified. Pass options.model, or select one in the Model Manager.');
    }

    const normalizedResponseFormat = normalizeTTSResponseFormat(responseFormat);
    const requestBody = Object.assign({}, requestOptions, {
        model: config.resolveModel(model),
        input: normalizedText,
        voice: voice,
        response_format: normalizedResponseFormat,
        speed: typeof speed === 'number' && Number.isFinite(speed) ? speed : DEFAULT_TTS_OPTIONS.speed
    });

    if (typeof instructions === 'string' && instructions.trim()) {
        requestBody.instructions = instructions.trim();
    }

    const headers = await getConnectorAuthHeaders(config);
    const response = await fetch(`${config.apiBase}/audio/speech`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            ...headers
        },
        body: JSON.stringify(requestBody)
    });

    if (!response.ok) {
        throw new Error(await readErrorResponse(response));
    }

    const responseContentType = response.headers.get('content-type') || '';
    const contentTypeIsJson = responseContentType.includes('application/json');

    if (contentTypeIsJson) {
        const data = await response.json();
        const base64Audio = normalizeBase64Audio(
            data?.audio || data?.audio_base64 || data?.data?.[0]?.b64_json || data?.data?.b64_json || ''
        );
        if (!base64Audio) {
            throw new Error('TTS error: No audio data returned');
        }

        let binaryString = '';
        try {
            binaryString = atob(base64Audio);
        } catch (error) {
            throw new Error('TTS error: Invalid base64 audio payload');
        }

        const bytes = new Uint8Array(binaryString.length);
        for (let i = 0; i < binaryString.length; i++) {
            bytes[i] = binaryString.charCodeAt(i);
        }

        const mimeType = getTTSAudioMimeType(normalizedResponseFormat, data?.mime_type || '');
        const audioBlob = new Blob([bytes], { type: mimeType });
        const audioUrl = URL.createObjectURL(audioBlob);

        return {
            audioBlob: audioBlob,
            audioUrl: audioUrl,
            mimeType: mimeType,
            usage: data?.usage || null,
            model: model,
            voice: voice,
            text: normalizedText,
            response_format: normalizedResponseFormat,
            revokeAudioUrl: () => {
                URL.revokeObjectURL(audioUrl);
            }
        };
    }

    const audioBuffer = await response.arrayBuffer();
    if (!audioBuffer || audioBuffer.byteLength < 1) {
        throw new Error('TTS error: Empty audio response');
    }

    const mimeType = getTTSAudioMimeType(normalizedResponseFormat, responseContentType);
    const audioBlob = new Blob([audioBuffer], { type: mimeType });
    const audioUrl = URL.createObjectURL(audioBlob);

    return {
        audioBlob: audioBlob,
        audioUrl: audioUrl,
        mimeType: mimeType,
        usage: parseTTSUsageFromHeaders(response.headers),
        model: model,
        voice: voice,
        text: normalizedText,
        response_format: normalizedResponseFormat,
        revokeAudioUrl: () => {
            URL.revokeObjectURL(audioUrl);
        }
    };
};

export const speakText = async (text, options = {}) => {
    const {
        autoPlay = true,
        ...ttsOptions
    } = options;

    const ttsResult = await textToSpeech(text, ttsOptions);
    const audio = new Audio(ttsResult.audioUrl);
    audio.preload = 'auto';

    const play = async () => {
        await audio.play();
        return audio;
    };

    const stop = () => {
        audio.pause();
        audio.currentTime = 0;
    };

    const destroy = () => {
        audio.pause();
        audio.removeAttribute('src');
        audio.load();
        ttsResult.revokeAudioUrl();
    };

    if (autoPlay) {
        await play();
    }

    return {
        ...ttsResult,
        audio: audio,
        play: play,
        stop: stop,
        destroy: destroy
    };
};



// CHAT COMPLETION

export const chatCompletion = async (messages, model, tools = {}, requestOptions = {}) => {
    const config = requireConnectorCapability('chatCompletion', 'Chat completion');

    const body = Object.assign({}, DEFAULT_COMPLETION_OPTIONS, requestOptions, config.bodyExtras, {
        messages: messages,
        model: config.resolveModel(model)
    });

    if (tools && tools.length > 0) {
        body.tools = tools;
        Object.assign(body, DEFAULT_TOOL_OPTIONS);
    }

    const headers = await getConnectorAuthHeaders(config);

    const response = await fetch(`${config.apiBase}/chat/completions`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            ...headers
        },
        body: JSON.stringify(body)
    });

    const data = await response.json();
    if (!response.ok) {
        const errorMsg = data?.error?.message || JSON.stringify(data);
        throw new Error(`Completion error: ${errorMsg}`);
    }

    const choice = data.choices?.[0];
    if (!choice) {
        throw new Error('Completion error: No response choice returned');
    }

    const message = choice.message;

    return {
        content: message.content || '',
        tool_calls: message.tool_calls || null,
        finish_reason: choice.finish_reason,
        usage: data.usage || null
    };
};



// WEB SEARCH

export const webSearch = async (query, requestOptions = {}) => {
    if (typeof query !== 'string' || !query.trim()) {
        throw new Error('Search error: Query must be a non-empty string');
    }

    const config = requireConnectorCapability('webSearch', 'Web search');
    const headers = await getConnectorAuthHeaders(config);

    const response = await fetch(`${config.apiBase}/search/tavily-search`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            ...headers
        },
        body: JSON.stringify({
            ...requestOptions,
            query: query.trim()
        })
    });

    const data = await response.json();
    if (!response.ok) {
        const errorMsg = data?.error?.message || JSON.stringify(data);
        throw new Error(`Search error: ${errorMsg}`);
    }

    return data;
};

export const chatCompletionWithSearch = async (messages, model, tools = [], requestOptions = {}) => {
    // Checked up front so an unsupported connector reports the missing feature
    // as search rather than as a chat-completion failure.
    requireConnectorCapability('webSearch', 'Web search');

    const searchMcpTool = {
        type: 'mcp',
        server_label: 'tavily',
        server_url: 'litellm_proxy/mcp/tavily',
        require_approval: 'never',
        allowed_tools: [
            'tavily_search',
            'tavily_extract',
            'tavily_crawl',
            'tavily_map',
            'tavily_research'
        ]
    };

    const mergedTools = [];
    if (Array.isArray(tools) && tools.length > 0) {
        mergedTools.push(...tools);
    }
    mergedTools.push(searchMcpTool);

    return await chatCompletion(messages, model, mergedTools, requestOptions);
};



// IMAGE GENERATION

export const generateImage = async (prompt, model, width = 1024, height = 1024, requestOptions = {}) => {
    const config = requireConnectorCapability('imageGeneration', 'Image generation');
    const headers = await getConnectorAuthHeaders(config);

    const response = await fetch(`${config.apiBase}/images/generations`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            ...headers
        },
        body: JSON.stringify(Object.assign({}, DEFAULT_IMAGE_OPTIONS, requestOptions, config.bodyExtras, {
            model: config.resolveModel(model),
            prompt: prompt,
            size: `${width}x${height}`
        }))
    });

    const data = await response.json();
    if (!response.ok) {
        const errorMsg = data?.error?.message || JSON.stringify(data);
        throw new Error(`Image generation error: ${errorMsg}`);
    }

    const b64Json = data.data?.[0]?.b64_json;
    if (!b64Json) {
        throw new Error('Image generation error: No image data returned');
    }

    const binaryString = atob(b64Json);
    const bytes = new Uint8Array(binaryString.length);
    for (let i = 0; i < binaryString.length; i++) {
        bytes[i] = binaryString.charCodeAt(i);
    }
    const blob = new Blob([bytes], { type: 'image/png' });

    const fileName = `generated_image_${Date.now()}.png`;
    const formData = new FormData();
    formData.append('file', blob, fileName);

    const uploadResponse = await new Promise((resolve, reject) => {
        const request = new XMLHttpRequest();
        request.open('POST', window.location.pathname);
        request.addEventListener('load', () => {
            resolve(JSON.parse(request.responseText));
        });
        request.addEventListener('error', () => {
            reject(new Error('Failed to upload generated image'));
        });
        request.send(formData);
    });

    return {
        imageUrl: `./${uploadResponse.fileName}`,
        usage: data.usage || null
    };
};

export const generateImageAsset = async (prompt, model, width = 1024, height = 1024, requestOptions = {}) => {

    const editor = window.tldrawEditor;
    const { imageUrl, usage } = await generateImage(prompt, model, width, height, requestOptions);

    const assetId = `asset:generated_${Date.now()}`;

    editor.createAssets([{
        id: assetId,
        type: 'image',
        typeName: 'asset',
        props: {
            name: prompt.substring(0, 50),
            src: imageUrl,
            w: width,
            h: height,
            mimeType: 'image/png',
            isAnimated: false
        },
        meta: {}
    }]);

    return {
        assetId: assetId,
        usage: usage
    };
};
