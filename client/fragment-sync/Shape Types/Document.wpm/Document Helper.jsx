const DOCUMENT_FRAGMENT_CONTAINER_SELECTOR = '#document-fragments';
const DEFAULT_DOCUMENT_NAME = 'New Document';
const DEFAULT_DOCUMENT_CONTENT = '# New Document\n\nStart writing here...';



const ensureDocumentFragmentContainer = () => {
    let container = document.querySelector(DOCUMENT_FRAGMENT_CONTAINER_SELECTOR);
    if (container) return container;

    container = document.createElement('code-folder');
    container.id = 'document-fragments';
    container.setAttribute('name', 'Document Fragments');
    document.body.appendChild(container);

    if (window.WPMv2?.stripProtection) {
        window.WPMv2.stripProtection(container);
    }

    return container;
};

const getDocumentFragmentById = (fragmentId) => {
    if (typeof fragmentId !== 'string' || fragmentId.trim() === '') {
        return null;
    }

    return Fragment.one('#' + fragmentId.trim());
};

export const createDocumentFragment = (name = DEFAULT_DOCUMENT_NAME, textContent = DEFAULT_DOCUMENT_CONTENT) => {
    const container = ensureDocumentFragmentContainer();
    const fragment = Fragment.create('text/markdown');
    const fragmentId = `document-fragment-${crypto.randomUUID()}`;

    fragment.element.id = fragmentId;
    fragment.element.setAttribute('name', typeof name === 'string' && name.trim() ? name.trim() : DEFAULT_DOCUMENT_NAME);
    fragment.raw = typeof textContent === 'string' ? textContent : String(textContent ?? '');
    container.appendChild(fragment.element);

    if (window.WPMv2?.stripProtection) {
        window.WPMv2.stripProtection(fragment.element);
    }

    return fragmentId;
};

export const getDocumentFragmentTextByFragmentId = (fragmentId) => {
    const fragment = getDocumentFragmentById(fragmentId);
    if (!fragment) {
        return null;
    }

    return typeof fragment.raw === 'string' ? fragment.raw : '';
};

export const setDocumentFragmentTextByFragmentId = (fragmentId, textContent) => {
    const fragment = getDocumentFragmentById(fragmentId);
    if (!fragment) {
        return false;
    }

    fragment.raw = typeof textContent === 'string' ? textContent : String(textContent ?? '');
    return true;
};

export const getDocumentFragmentNameByFragmentId = (fragmentId) => {
    const fragment = getDocumentFragmentById(fragmentId);
    if (!fragment) {
        return null;
    }

    const name = fragment.element?.getAttribute('name');
    if (typeof name !== 'string') {
        return '';
    }

    return name;
};

export const setDocumentFragmentNameByFragmentId = (fragmentId, name) => {
    const fragment = getDocumentFragmentById(fragmentId);
    if (!fragment || !fragment.element) {
        return false;
    }

    const normalizedName = typeof name === 'string' ? name : String(name ?? '');
    fragment.element.setAttribute('name', normalizedName);
    return true;
};
