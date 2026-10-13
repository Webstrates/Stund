/**
 * Fragment Coding Harness
 *
 * Import through '#Agents .harness-helpers'. Each expert creates its harness
 * with a fixed kind: widget uses #widget-fragments, processor uses
 * #processor-fragments. Requests cannot broaden scope, and explicit IDs are
 * checked too. Existing name, state, validation, and complete-source writers
 * share this scoped lookup. Reload the application to load updated experts.
 *
 * Tools accept one request object to avoid SlopScript shifting optional
 * positional arguments. Model calls wrap it as { request: { id: '...' } }.
 * Widget tools expose listWidgetSources, searchWidgetSource, readWidgetSource,
 * editWidgetSource, and applyWidgetSourcePatch as wrappers for the generic
 * operations below, alongside validateWidgetSource and writeWidgetSource.
 * Processor tools use the corresponding ProcessorSource names, including
 * listProcessorSources, readProcessorSource, and writeProcessorSource.
 *
 * listFragments({ namePattern })
 *   Optional case-insensitive literal name filter. Returns IDs, revisions,
 *   and source line counts without executing fragments.
 *
 * searchFragments({ ids, pattern, mode, caseSensitive, contextLines })
 *   IDs default to all fragments in scope. Mode defaults to literal; regex
 *   uses JavaScript syntax without slash delimiters. Case sensitivity defaults
 *   to true; surrounding context defaults to 2 lines (maximum 10).
 *
 * readFragment({ id, ranges })
 *   Ranges refer to raw source and are inclusive, 1-based
 *   { startLine, endLine } objects. Without ranges, reading starts at line 1.
 *
 * getSource({ id }) / validateSource({ id }) / writeSource(request)
 *   Shared operations behind the experts' source tools. getSource returns the
 *   complete raw source and revision for internal callers; agents use paginated
 *   readFragment instead. validateSource checks syntax and module loading and
 *   returns structured diagnostics without writing. writeSource accepts
 *   { id, source, expectedRevision, dryRun } and uses the same commit pipeline
 *   as targeted edits and patches. Their tool schemas are shared too.
 *
 * editFragment({ id, expectedRevision, edits })
 *   Edits are { oldString, newString } replacements in the raw source.
 *   Every unique exact anchor matches the ORIGINAL snapshot, never an earlier
 *   replacement. Overlapping spans reject the entire batch. Empty newString
 *   deletes text; anchored replacements insert text. No fuzzy matching occurs.
 *
 * applyFragmentPatch({ id, expectedRevision, patches })
 *   Patches are { diff } entries against the raw source. Use strict unified
 *   diffs with original positions, exact context, correct hunk counts, and
 *   no-final-newline markers when needed. Optional headers must name source,
 *   never a filesystem path. Patches cannot create,
 *   delete, or rename fragments, and hunks are never relocated heuristically.
 *
 * Pagination and revisions
 *   Read/search excerpts contain revision, totalLines, and records
 *   { line, column, text, complete }. Copy text without displayed line numbers.
 *   Search returns at most 30 matching excerpts; read/search pages contain at
 *   most 300 line records and 24,000 source-text characters. Partial lines
 *   continue by column. For nextCursor, call the same tool with { cursor } only.
 *   Cursors stay in this harness instance, expire after five minutes, and reject
 *   changed, moved, or foreign fragments. Writers require expectedRevision from
 *   a read/list result. dryRun: true previews syntax without writing or loading.
 *
 * Widget and processor operations always use the raw fragment source. For
 * embedded processor scripts and prompts, preserve the source's string escapes
 * in oldString, newString, and diff text.
 *
 * Live writes and results
 *   Validate source syntax, named exports, statically available processor
 *   structure, and embedded JavaScript syntax in memory. Then recheck revision
 *   and membership before one fragment.raw assignment. fragment.require()
 *   subsequently checks loading and exports; it does not mount widgets or
 *   execute server scripts. Processor edits do not update running instances.
 *   Successful commits report ok: true, written: true, module-loaded validation.
 *   Candidate failures report written: false. Load failures report written: true
 *   and the committed revision for repair, with no automatic rollback.
 *   source-changed validation means a concurrent change occurred during loading:
 *   read again; excerpts describe the committed candidate, not the newer source.
 *   Atomicity covers one local fragment commit, not distributed transactions.
 *
 * Widget source tools keep their names and delegate to the shared source
 * operations using one request object. getWidgetSource remains internal;
 * validateWidgetSource takes { id }; writeWidgetSource takes
 * { id, source, expectedRevision }. validateProcessorSource also takes
 * { id }. writeProcessorSource takes structured processor fields,
 * including expectedRevision, and delegates its serialized source to
 * writeSource. Reserve complete replacements for initial creation or when
 * smaller edits and patches are not viable. Processor creation returns the
 * empty fragment's revision. Unbounded source/definition readers stay out of
 * expert tool menus.
 */

const MAX_CHARACTERS = 24000;
const MAX_LINES = 300;
const MAX_MATCHES = 30;
const CURSOR_LIFETIME_MS = 5 * 60 * 1000;
const UNKNOWN = Symbol('Unresolved static value');
const PROCESSOR_TYPES = ['ScriptProcessor', 'AIPromptProcessor', 'AIVisionProcessor'];

function fail(message) {
    throw new Error(message);
}

function isRecord(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function checkRequest(request, allowed) {
    if (!isRecord(request)) {
        fail('request must be a JSON object, not a string, array, or null. Do not JSON.stringify the request.');
    }
    if (Object.prototype.hasOwnProperty.call(request, 'request')) {
        fail('request is nested twice. Put id, expectedRevision, edits, and other operation fields directly inside the single request object.');
    }
    const unknown = Object.keys(request).filter(key => !allowed.includes(key));
    if (unknown.length) {
        fail(`Unknown request fields: ${unknown.join(', ')}. Scope is fixed by the expert.`);
    }
}

function integer(value, label, minimum = 1) {
    if (!Number.isInteger(value) || value < minimum) {
        fail(`${label} must be an integer >= ${minimum}.`);
    }
    return value;
}

function nonEmptyString(value, label) {
    if (typeof value !== 'string' || !value.trim()) {
        fail(`${label} must be a non-empty string.`);
    }
    return value;
}

export async function getSourceRevision(source) {
    // Preserve every UTF-16 code unit, including lone surrogates that UTF-8
    // TextEncoder would otherwise collapse into the same replacement character.
    const bytes = new Uint8Array(source.length * 2);
    for (let index = 0; index < source.length; index++) {
        const codeUnit = source.charCodeAt(index);
        bytes[index * 2] = codeUnit & 255;
        bytes[index * 2 + 1] = codeUnit >>> 8;
    }
    const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
    return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

export function indexSource(source) {
    const starts = [0];
    for (let index = 0; index < source.length; index++) {
        if (source[index] === '\n') {
            starts.push(index + 1);
        }
    }
    return {
        source,
        starts,
        line(number) {
            let end = number < starts.length ? starts[number] - 1 : source.length;
            if (source[end - 1] === '\r') {
                end--;
            }
            return source.slice(starts[number - 1], end);
        },
        lineAt(offset) {
            let low = 0;
            let high = starts.length;
            while (low + 1 < high) {
                const middle = Math.floor((low + high) / 2);
                if (starts[middle] <= offset) {
                    low = middle;
                } else {
                    high = middle;
                }
            }
            return low + 1;
        }
    };
}

function parseSource(source, babel, script = false) {
    if (!babel || typeof babel.transform !== 'function') {
        fail('Babel is unavailable. Syntax validation cannot run; nothing was written.');
    }
    return babel.transform(source, {
        presets: script ? [] : ['react'],
        sourceType: script ? 'script' : 'module',
        ast: true,
        code: false
    }).ast.program;
}

function getAstContext(program) {
    const bindings = new Map();
    const exports = new Map();
    for (const statement of program.body) {
        const declaration = statement.type === 'ExportNamedDeclaration' ? statement.declaration : statement;
        if (declaration?.type === 'VariableDeclaration') {
            for (const item of declaration.declarations) {
                if (item.id.type === 'Identifier') {
                    if (declaration.kind === 'const') {
                        bindings.set(item.id.name, item.init);
                    }
                    if (statement.type === 'ExportNamedDeclaration') {
                        exports.set(item.id.name, item.init);
                    }
                }
            }
        } else if (declaration?.id && statement.type === 'ExportNamedDeclaration') {
            exports.set(declaration.id.name, declaration);
        }
        if (statement.type === 'ExportNamedDeclaration') {
            for (const specifier of statement.specifiers || []) {
                exports.set(specifier.exported.name || specifier.exported.value,
                    statement.source ? null : specifier.local);
            }
        }
    }
    function resolve(node, seen = new Set()) {
        if (node?.type !== 'Identifier') {
            return node;
        }
        if (seen.has(node.name) || !bindings.has(node.name)) {
            return null;
        }
        return resolve(bindings.get(node.name), new Set([...seen, node.name]));
    }
    function value(node, depth = 0) {
        if (depth > 100) {
            return UNKNOWN;
        }
        node = resolve(node);
        if (!node) {
            return UNKNOWN;
        }
        if (['StringLiteral', 'NumericLiteral', 'BooleanLiteral'].includes(node.type)) {
            return node.value;
        }
        if (node.type === 'NullLiteral') {
            return null;
        }
        if (node.type === 'TemplateLiteral' && node.expressions.length === 0) {
            return node.quasis[0].value.cooked ?? UNKNOWN;
        }
        if (node.type === 'UnaryExpression' && ['-', '+'].includes(node.operator)) {
            const operand = value(node.argument, depth + 1);
            return typeof operand === 'number' ? (node.operator === '-' ? -operand : operand) : UNKNOWN;
        }
        if (node.type === 'ArrayExpression') {
            return node.elements.map(item => value(item, depth + 1));
        }
        if (node.type === 'ObjectExpression') {
            const result = Object.create(null);
            for (const property of node.properties) {
                if (property.type !== 'ObjectProperty' || property.computed) {
                    return UNKNOWN;
                }
                const key = property.key.name ?? property.key.value;
                result[key] = value(property.value, depth + 1);
            }
            return result;
        }
        return UNKNOWN;
    }
    return { exports, value };
}

export function validateProcessorDefinitionShape(definition, babel, partial = false) {
    const unknown = value => partial && value === UNKNOWN;
    if (unknown(definition)) {
        return;
    }
    if (!isRecord(definition)) {
        fail('The processor export must be an object.');
    }
    if (!unknown(definition.type) && !PROCESSOR_TYPES.includes(definition.type)) {
        fail('Unsupported processor type.');
    }
    if (!unknown(definition.name)) {
        nonEmptyString(definition.name, 'processor.name');
    }
    if (unknown(definition.options)) {
        return;
    }
    if (!isRecord(definition.options)) {
        fail('processor.options must be an object.');
    }
    for (const key of ['inputs', 'outputs', 'schemas']) {
        if (!unknown(definition.options[key]) && !isRecord(definition.options[key])) {
            fail(`processor.options.${key} must be an object.`);
        }
    }
    const field = definition.type === 'ScriptProcessor' ? 'script'
        : ['AIPromptProcessor', 'AIVisionProcessor'].includes(definition.type) ? 'prompt' : null;
    if (field && !unknown(definition.options[field])) {
        nonEmptyString(definition.options[field], `processor.options.${field}`);
        if (field === 'script') {
            parseSource(definition.options.script, babel, true);
        }
    }
}

function validateCandidate(source, kind, babel) {
    nonEmptyString(source, 'Source');
    const context = getAstContext(parseSource(source, babel));
    const exportName = kind === 'widget' ? 'Widget' : 'processor';
    if (!context.exports.has(exportName)) {
        fail(`Source must have a named ${exportName} export.`);
    }
    if (kind === 'processor') {
        validateProcessorDefinitionShape(context.value(context.exports.get('processor')), babel, true);
    }
}

export function resolveReplacements(source, edits) {
    const index = indexSource(source);
    return edits.map((edit, editIndex) => {
        nonEmptyString(edit.oldString, `Edit ${editIndex + 1} oldString`);
        if (typeof edit.newString !== 'string' || edit.oldString === edit.newString) {
            fail(`Edit ${editIndex + 1}: newString must be different source text (empty is allowed for deletion).`);
        }
        const matches = [];
        let position = source.indexOf(edit.oldString);
        while (position !== -1 && matches.length < 5) {
            matches.push(position);
            position = source.indexOf(edit.oldString, position + 1);
        }
        if (matches.length !== 1) {
            const locations = matches.map(offset => index.lineAt(offset));
            fail(`Edit ${editIndex + 1}: oldString ${matches.length ? `is ambiguous (lines ${locations.join(', ')})` : 'was not found'}. All edits match the original snapshot. ${matches.length ? 'Include more surrounding text.' : 'Read the relevant lines and copy exact source text without line numbers.'}`);
        }
        return { start: matches[0], end: matches[0] + edit.oldString.length, text: edit.newString };
    });
}

export function applyResolvedEdits(source, changes) {
    const sorted = [...changes].sort((a, b) => a.start - b.start || a.end - b.end);
    for (let index = 0; index < sorted.length; index++) {
        const change = sorted[index];
        if (change.start < 0 || change.end < change.start || change.end > source.length) {
            fail('Invalid source span.');
        }
        const previous = sorted[index - 1];
        if (previous && (change.start < previous.end || change.start === previous.start)) {
            fail('Edits overlap in the original snapshot. Combine them into one replacement.');
        }
    }
    let candidate = source;
    for (const change of [...sorted].reverse()) {
        candidate = candidate.slice(0, change.start) + change.text + candidate.slice(change.end);
    }
    let delta = 0;
    const ranges = sorted.map(change => {
        const start = change.start + delta;
        delta += change.text.length - (change.end - change.start);
        return { start, end: start + change.text.length };
    });
    return { source: candidate, ranges };
}

/** Strict unified diffs use original line positions; no fuzzy relocation. */
export function resolveUnifiedDiff(source, diff) {
    nonEmptyString(diff, 'diff');
    const rows = diff.replace(/\r\n/g, '\n').split('\n');
    if (rows[rows.length - 1] === '') {
        rows.pop();
    }
    let cursor = 0;
    if (rows[0]?.startsWith('--- ')) {
        if (rows[0] !== '--- source' || rows[1] !== '+++ source') {
            fail('Patch headers must be --- source and +++ source; fragment creation, deletion, and filesystem paths are not supported.');
        }
        cursor = 2;
    }
    const indexed = indexSource(source);
    // The final empty display line is not a physical line in a unified diff.
    const physicalLines = source.length ? indexed.starts.length - (source.endsWith('\n') ? 1 : 0) : 0;
    const records = [];
    const newline = source.includes('\r\n') ? '\r\n' : '\n';
    let oldEnd = 0;
    let lineDelta = 0;
    while (cursor < rows.length) {
        const header = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?:.*)$/.exec(rows[cursor++]);
        if (!header) {
            fail('Expected a unified diff hunk header: @@ -oldStart,oldCount +newStart,newCount @@.');
        }
        const oldStart = Number(header[1]);
        const oldCount = header[2] === undefined ? 1 : Number(header[2]);
        const newStart = Number(header[3]);
        const newCount = header[4] === undefined ? 1 : Number(header[4]);
        const first = oldCount === 0 ? oldStart : oldStart - 1;
        const nextFirst = newCount === 0 ? newStart : newStart - 1;
        if (first < oldEnd || first < 0 || first + oldCount > physicalLines || nextFirst !== first + lineDelta) {
            fail('Patch hunk positions are out of range, overlapping, or inconsistent with earlier hunks.');
        }
        const oldRows = [];
        const newRows = [];
        let previous = null;
        while (cursor < rows.length && !rows[cursor].startsWith('@@ ')) {
            const row = rows[cursor++];
            if (row === '\\ No newline at end of file') {
                if (!previous || previous.noNewline) {
                    fail('Misplaced no-newline marker.');
                }
                previous.noNewline = true;
                continue;
            }
            if (![' ', '-', '+'].includes(row[0])) {
                fail('Invalid patch line or multiple-file patch. Prefix hunk lines with space, - or +.');
            }
            previous = { text: row.slice(1), noNewline: false };
            if (row[0] !== '+') {
                oldRows.push(previous);
            }
            if (row[0] !== '-') {
                newRows.push(previous);
            }
        }
        if (oldRows.length !== oldCount || newRows.length !== newCount) {
            fail('Patch hunk line counts do not match its header.');
        }
        const start = first < indexed.starts.length ? indexed.starts[first] : source.length;
        const endLine = first + oldCount;
        const end = endLine < indexed.starts.length ? indexed.starts[endLine] : source.length;
        const oldText = oldRows.map((row, index) => {
            const lineNumber = first + index + 1;
            const lineStart = indexed.starts[lineNumber - 1];
            const lineEnd = lineNumber < indexed.starts.length ? indexed.starts[lineNumber] : source.length;
            const actual = source.slice(lineStart, lineEnd);
            const suffix = actual.endsWith('\r\n') ? '\r\n' : actual.endsWith('\n') ? '\n' : '';
            if (row.noNewline !== (suffix === '')) {
                fail(`Patch newline marker does not match original line ${lineNumber}.`);
            }
            row.suffix = suffix;
            return row.text + suffix;
        }).join('');
        if (source.slice(start, end) !== oldText) {
            fail(`Patch context or removed text does not match original lines starting at ${first + 1}.`);
        }
        if (newRows.some((row, index) => row.noNewline && index !== newRows.length - 1)) {
            fail('No-newline marker must describe the final line.');
        }
        if (newRows.some(row => row.noNewline) && end !== source.length) {
            fail('A no-newline marker can only be used at the end of the source.');
        }
        if (oldCount === 0 && start === source.length && source && !source.endsWith('\n') && newCount > 0) {
            fail('To append after a line without a newline, include and replace that line in the hunk.');
        }
        const text = newRows.map(row => row.text + (row.noNewline ? '' : row.suffix ?? newline)).join('');
        records.push({ start, end, text });
        oldEnd = first + oldCount;
        lineDelta += newCount - oldCount;
    }
    if (!records.length) {
        fail('Patch must contain at least one hunk.');
    }
    return records;
}

function createDomAdapter(kind) {
    const selector = kind === 'widget' ? '#widget-fragments' : '#processor-fragments';
    function getContainer() {
        const container = document.querySelector(selector);
        if (!container) {
            fail(`Missing ${kind} fragment container.`);
        }
        return container;
    }
    return {
        babel: () => globalThis.Babel,
        list: () => Array.from(getContainer().querySelectorAll('code-fragment')).map(element => element.id).filter(Boolean).sort(),
        resolve(id) {
            nonEmptyString(id, 'id');
            const container = getContainer();
            const fragment = Fragment.one(`${selector} code-fragment#${CSS.escape(id)}`);
            if (!fragment || !container.contains(fragment.element) || !fragment.element.isConnected) {
                fail(`No ${kind} fragment with ID "${id}" exists in this expert's scope.`);
            }
            if (fragment.element.getAttribute('data-type') !== 'text/javascript+babel') {
                fail('Only text/javascript+babel fragments are supported.');
            }
            return fragment;
        },
        name: fragment => fragment.element.getAttribute('name') || `Untitled ${kind === 'widget' ? 'Widget' : 'Processor'}`
    };
}

function excerptRecord(snapshot, first, last, matchLine) {
    return { snapshot, first, last, matchLine, indexed: snapshot.indexed };
}

function renderPage(records, position = { record: 0, line: null, column: 0 }, maxRecords = Infinity) {
    let recordIndex = position.record;
    let line = position.line;
    let column = position.column;
    let characters = MAX_CHARACTERS;
    let lineBudget = MAX_LINES;
    const excerpts = [];
    while (recordIndex < records.length && excerpts.length < maxRecords && lineBudget > 0 && characters > 0) {
        const record = records[recordIndex];
        line = line ?? record.first;
        const lines = [];
        while (line <= record.last && lineBudget > 0 && characters > 0) {
            const fullText = record.indexed.line(line);
            const text = fullText.slice(column, column + characters);
            const complete = column === 0 && text.length === fullText.length;
            lines.push({ line, column: column + 1, text, complete });
            characters -= Math.max(1, text.length);
            lineBudget--;
            column += text.length;
            if (column < fullText.length) {
                break;
            }
            line++;
            column = 0;
        }
        excerpts.push({
            id: record.snapshot.id,
            name: record.snapshot.name,
            revision: record.snapshot.revision,
            totalLines: record.indexed.starts.length,
            ...(record.matchLine === undefined ? {} : { matchLine: record.matchLine }),
            lines
        });
        if (line > record.last) {
            recordIndex++;
            line = null;
        } else {
            break;
        }
    }
    return { excerpts, position: { record: recordIndex, line, column }, truncated: recordIndex < records.length };
}

export function createFragmentHarness(kind, adapter = null) {
    if (!['widget', 'processor'].includes(kind)) {
        fail('Harness kind must be widget or processor.');
    }
    adapter = adapter || createDomAdapter(kind);
    const cursors = new Map();

    function saveCursor(operation, state) {
        const now = Date.now();
        for (const [key, cursor] of cursors) {
            if (now - cursor.created > CURSOR_LIFETIME_MS) {
                cursors.delete(key);
            }
        }
        while (cursors.size >= 64) {
            cursors.delete(cursors.keys().next().value);
        }
        const key = globalThis.crypto.randomUUID();
        cursors.set(key, { operation, state, created: now });
        return key;
    }

    function resumeCursor(operation, request) {
        checkRequest(request, ['cursor']);
        const cursor = cursors.get(request.cursor);
        if (!cursor || cursor.operation !== operation || Date.now() - cursor.created > CURSOR_LIFETIME_MS) {
            fail('Cursor is invalid, expired, or belongs to another expert/tool. Repeat the original request.');
        }
        for (const snapshot of cursor.state.snapshots) {
            if (adapter.resolve(snapshot.id) !== snapshot.fragment || snapshot.fragment.raw !== snapshot.source || adapter.name(snapshot.fragment) !== snapshot.name) {
                fail('Cursor is stale because a fragment changed. Repeat the original request.');
            }
        }
        if (cursor.state.listIds && JSON.stringify(adapter.list()) !== JSON.stringify(cursor.state.listIds)) {
            fail('Cursor is stale because the fragment list changed. Repeat the original request.');
        }
        return cursor.state;
    }

    async function capture(id) {
        const fragment = adapter.resolve(id);
        const source = fragment.raw;
        if (typeof source !== 'string') {
            fail('Fragment source must be a string.');
        }
        return { id, fragment, source, name: adapter.name(fragment),
            indexed: indexSource(source), revision: await getSourceRevision(source) };
    }

    function respondWithPage(operation, state, maxRecords) {
        const page = renderPage(state.records, state.position, maxRecords);
        return {
            ok: true,
            written: false,
            excerpts: page.excerpts,
            ...(state.totalMatches === undefined ? {} : { totalMatches: state.totalMatches }),
            truncated: page.truncated,
            nextCursor: page.truncated ? saveCursor(operation, { ...state, position: page.position }) : null
        };
    }

    async function listFragments(request) {
        let state;
        if (request.cursor !== undefined) {
            state = resumeCursor('list', request);
        } else {
            checkRequest(request, ['namePattern']);
            if (request.namePattern !== undefined) {
                nonEmptyString(request.namePattern, 'namePattern');
            }
            const listIds = adapter.list();
            const snapshots = await Promise.all(listIds.map(capture));
            state = {
                listIds,
                snapshots,
                entries: snapshots.filter(snapshot => !request.namePattern || snapshot.name.toLowerCase().includes(request.namePattern.toLowerCase())).map(snapshot => ({
                    id: snapshot.id,
                    kind,
                    name: snapshot.name,
                    type: 'text/javascript+babel',
                    revision: snapshot.revision,
                    totalLines: snapshot.indexed.starts.length
                })),
                offset: 0
            };
        }
        const fragments = [];
        let characters = MAX_CHARACTERS;
        let offset = state.offset;
        while (offset < state.entries.length && fragments.length < MAX_MATCHES) {
            const entry = state.entries[offset];
            const size = JSON.stringify(entry).length;
            if (size > characters) {
                if (!fragments.length) {
                    fail('Fragment metadata exceeds the response limit. Shorten its name.');
                }
                break;
            }
            characters -= size;
            fragments.push(entry);
            offset++;
        }
        const truncated = offset < state.entries.length;
        return { ok: true, written: false, fragments, totalFragments: state.entries.length, truncated,
            nextCursor: truncated ? saveCursor('list', { ...state, offset }) : null };
    }

    async function readFragment(request) {
        if (request.cursor !== undefined) {
            return respondWithPage('read', resumeCursor('read', request));
        }
        checkRequest(request, ['id', 'ranges']);
        const snapshot = await capture(request.id);
        const ranges = request.ranges ?? [{ startLine: 1, endLine: snapshot.indexed.starts.length }];
        if (!Array.isArray(ranges) || !ranges.length) {
            fail('ranges must be a non-empty array.');
        }
        const records = ranges.map(range => {
            checkRequest(range, ['startLine', 'endLine']);
            const first = integer(range.startLine, 'startLine');
            const last = integer(range.endLine, 'endLine');
            if (first > last || first > snapshot.indexed.starts.length) {
                fail(`Invalid line range. Source has ${snapshot.indexed.starts.length} lines.`);
            }
            return excerptRecord(snapshot, first, Math.min(last, snapshot.indexed.starts.length));
        });
        return respondWithPage('read', { snapshots: [snapshot], records });
    }

    async function searchFragments(request) {
        if (request.cursor !== undefined) {
            return respondWithPage('search', resumeCursor('search', request), MAX_MATCHES);
        }
        checkRequest(request, ['ids', 'pattern', 'mode', 'caseSensitive', 'contextLines']);
        nonEmptyString(request.pattern, 'pattern');
        const mode = request.mode ?? 'literal';
        if (!['literal', 'regex'].includes(mode)) {
            fail('mode must be literal or regex.');
        }
        if (request.caseSensitive !== undefined && typeof request.caseSensitive !== 'boolean') {
            fail('caseSensitive must be a boolean.');
        }
        const sensitive = request.caseSensitive ?? true;
        const regex = mode === 'regex' ? new RegExp(request.pattern, sensitive ? '' : 'i') : null;
        const pattern = sensitive ? request.pattern : request.pattern.toLowerCase();
        const context = integer(request.contextLines ?? 2, 'contextLines', 0);
        if (context > 10) {
            fail('contextLines must be <= 10. Read a wider source range for more context.');
        }
        const listIds = request.ids === undefined ? adapter.list() : null;
        const ids = request.ids ?? listIds;
        if (!Array.isArray(ids) || (request.ids !== undefined && !ids.length)) {
            fail('ids must be a non-empty array when provided.');
        }
        const snapshots = await Promise.all(Array.from(new Set(ids)).map(capture));
        const records = [];
        for (const snapshot of snapshots) {
            for (let line = 1; line <= snapshot.indexed.starts.length; line++) {
                const text = snapshot.indexed.line(line);
                if (regex ? regex.test(text) : (sensitive ? text : text.toLowerCase()).includes(pattern)) {
                    records.push(excerptRecord(snapshot, Math.max(1, line - context), Math.min(snapshot.indexed.starts.length, line + context), line));
                }
            }
        }
        return respondWithPage('search', { snapshots, listIds, records, totalMatches: records.length }, MAX_MATCHES);
    }

    function planChanges(snapshot, entries, patch) {
        if (!Array.isArray(entries) || !entries.length) {
            fail(`${patch ? 'patches' : 'edits'} must be a non-empty array.`);
        }
        for (const entry of entries) {
            checkRequest(entry, patch ? ['diff'] : ['oldString', 'newString']);
        }
        const changes = patch ? entries.flatMap(entry => resolveUnifiedDiff(snapshot.source, entry.diff))
            : resolveReplacements(snapshot.source, entries);
        return applyResolvedEdits(snapshot.source, changes);
    }

    async function getSource(request) {
        checkRequest(request, ['id']);
        const snapshot = await capture(request.id);
        return { ok: true, written: false, id: snapshot.id, revision: snapshot.revision, source: snapshot.source };
    }

    async function validateLoadedSource(snapshot, result) {
        try {
            const exportsObject = await snapshot.fragment.require();
            if (kind === 'widget') {
                if (typeof exportsObject?.Widget !== 'function') {
                    fail('The Widget export must be a function.');
                }
            } else {
                validateProcessorDefinitionShape(exportsObject?.processor, adapter.babel());
            }
            result.validation = 'module-loaded';
        } catch (error) {
            result.ok = false;
            result.validation = 'load-failed';
            const prefix = result.written ? 'Source was written, but the fragment failed to load' : 'Existing source failed to load';
            result.diagnostics = [`${prefix}: ${String(error.message || error).slice(0, 2000)}. Repair the source with an edit or patch.`];
        }
        let current = null;
        try {
            current = adapter.resolve(snapshot.id);
        } catch (error) {
            result.diagnostics = [...(result.diagnostics || []), error.message];
        }
        if (current !== snapshot.fragment || snapshot.fragment.raw !== snapshot.source) {
            result.ok = false;
            result.validation = 'source-changed';
            result.revision = current ? await getSourceRevision(current.raw) : null;
            result.diagnostics = [...(result.diagnostics || []), 'Source changed during module validation. This result describes the inspected revision, not the current source. Read it again.'];
        }
        return result;
    }

    async function validateSource(request) {
        checkRequest(request, ['id']);
        const snapshot = await capture(request.id);
        const result = { ok: true, written: false, id: snapshot.id, revision: snapshot.revision,
            validatedRevision: snapshot.revision, validation: 'syntax-checked' };
        try {
            validateCandidate(snapshot.source, kind, adapter.babel());
        } catch (error) {
            return { ...result, ok: false, validation: 'syntax-check-failed',
                diagnostics: [`Existing source failed validation: ${String(error.message || error).slice(0, 2000)}`] };
        }
        if (adapter.resolve(snapshot.id) !== snapshot.fragment || snapshot.fragment.raw !== snapshot.source) {
            fail('Source changed during syntax validation. Read the current source and validate again.');
        }
        return validateLoadedSource(snapshot, result);
    }

    async function commit(snapshot, candidate, request) {
        if (request.expectedRevision !== snapshot.revision) {
            fail('Source revision is stale or missing. Nothing was written. Read the current source and retry.');
        }
        if (request.dryRun !== undefined && typeof request.dryRun !== 'boolean') {
            fail('dryRun must be a boolean.');
        }
        if (candidate.source === snapshot.source) {
            fail('The candidate makes no change. Nothing was written.');
        }
        validateCandidate(candidate.source, kind, adapter.babel());
        const committedRevision = await getSourceRevision(candidate.source);
        const sourceIndex = indexSource(candidate.source);
        const nextSnapshot = { ...snapshot, source: candidate.source, revision: committedRevision, indexed: sourceIndex };
        const records = [];
        for (const range of candidate.ranges) {
            const first = sourceIndex.lineAt(range.start);
            const last = sourceIndex.lineAt(Math.max(range.start, range.end - 1));
            records.push(excerptRecord(nextSnapshot, Math.max(1, first - 3), Math.min(sourceIndex.starts.length, last + 3)));
        }
        const report = renderPage(records);
        if (adapter.resolve(snapshot.id) !== snapshot.fragment || snapshot.fragment.raw !== snapshot.source) {
            fail('The fragment changed or moved during validation. Nothing was written. Read it again.');
        }
        const result = { ok: true, id: snapshot.id, written: false, revision: snapshot.revision,
            candidateRevision: committedRevision, validation: 'syntax-checked', excerpts: report.excerpts, truncated: report.truncated };
        if (request.dryRun) {
            return result;
        }
        snapshot.fragment.raw = candidate.source;
        result.written = true;
        result.revision = committedRevision;
        result.committedRevision = committedRevision;
        return validateLoadedSource(nextSnapshot, result);
    }

    async function editFragment(request) {
        checkRequest(request, ['id', 'expectedRevision', 'edits', 'dryRun']);
        const snapshot = await capture(request.id);
        if (request.expectedRevision !== snapshot.revision) {
            fail('Source revision is stale or missing. Read the current source and retry.');
        }
        const candidate = planChanges(snapshot, request.edits, false);
        return commit(snapshot, candidate, request);
    }

    async function applyFragmentPatch(request) {
        checkRequest(request, ['id', 'expectedRevision', 'patches', 'dryRun']);
        const snapshot = await capture(request.id);
        if (request.expectedRevision !== snapshot.revision) {
            fail('Source revision is stale or missing. Read the current source and retry.');
        }
        const candidate = planChanges(snapshot, request.patches, true);
        return commit(snapshot, candidate, request);
    }

    async function writeSource(request) {
        checkRequest(request, ['id', 'expectedRevision', 'source', 'dryRun']);
        const snapshot = await capture(request.id);
        if (typeof request.source !== 'string') {
            fail('source must be a string.');
        }
        return commit(snapshot, { source: request.source, ranges: [{ start: 0, end: request.source.length }] }, request);
    }

    function protect(method) {
        return async (request = {}) => {
            try {
                if (!isRecord(request)) {
                    const receivedType = request === null ? 'null' : Array.isArray(request) ? 'array' : typeof request;
                    const schema = harnessToolSchemas[method.name];
                    const example = schema.parameters.properties.request.examples[0];
                    fail(`Invalid request: received ${receivedType}; expected a JSON object. ` +
                        'Send tool arguments with exactly one request wrapper. Do not JSON.stringify or quote the request object. ' +
                        `Example tool arguments: ${JSON.stringify({ request: example })}. ` +
                        'Replace example values with the actual fragment ID, revision, and operation fields, then resend the complete request.');
                }
                return await method(request);
            } catch (error) {
                return { ok: false, written: false, diagnostics: [`Nothing was written: ${String(error.message || error).slice(0, 2000)}`] };
            }
        };
    }
    return Object.freeze({
        getFragment: id => adapter.resolve(id),
        listFragments: protect(listFragments),
        searchFragments: protect(searchFragments),
        readFragment: protect(readFragment),
        getSource: protect(getSource),
        validateSource: protect(validateSource),
        editFragment: protect(editFragment),
        applyFragmentPatch: protect(applyFragmentPatch),
        writeSource: protect(writeSource),
        replaceSource: protect(writeSource)
    });
}

const string = { type: 'string' };
const cursor = { type: 'string', description: 'Continuation token. When supplied, pass only cursor in the request.' };
const range = { type: 'object', properties: { startLine: { type: 'integer', minimum: 1 }, endLine: { type: 'integer', minimum: 1 } },
    required: ['startLine', 'endLine'], additionalProperties: false };

function toolSchema(description, properties, required = [], example = {}) {
    return {
        description: `${description} Send arguments as {"request": {...}}; request must be a JSON object, never a JSON-encoded string. Example tool arguments: ${JSON.stringify({ request: example })}`,
        parameters: { type: 'object', properties: {
            request: {
                type: 'object',
                description: 'The request fields as a JSON object. Do not stringify this object or add another request wrapper inside it.',
                properties, required, additionalProperties: false, examples: [example]
            }
        }, required: ['request'], additionalProperties: false },
        returns: { type: 'object' }
    };
}

export const harnessToolSchemas = {
    listFragments: toolSchema('Lists only this expert\'s local fragments with IDs, revisions, and source line counts; no code is executed.', {
        namePattern: { ...string, description: 'Optional case-insensitive literal name filter.' }, cursor
    }),
    searchFragments: toolSchema('Searches only this expert\'s local fragments, returning numbered context and paginated matches.', {
        ids: { type: 'array', items: string, minItems: 1 },
        pattern: string,
        mode: { type: 'string', enum: ['literal', 'regex'], description: 'Defaults to literal; regex uses JavaScript syntax without / delimiters.' },
        caseSensitive: { type: 'boolean', description: 'Defaults to true.' },
        contextLines: { type: 'integer', minimum: 0, maximum: 10, description: 'Defaults to 2.' },
        cursor
    }, [], { ids: ['<fragment-id>'], pattern: '<text to find>' }),
    readFragment: toolSchema('Reads source ranges, at most 300 lines and 24000 text characters per page; default starts at line 1.', {
        id: string, ranges: { type: 'array', items: range, minItems: 1 }, cursor
    }, [], { id: '<fragment-id>' }),
    getSource: toolSchema('Returns complete raw source and its revision for internal callers; prefer paginated source reads for agent use.', {
        id: string
    }, ['id'], { id: '<fragment-id>' }),
    validateSource: toolSchema('Checks existing source syntax, exports, and module loading without writing; returns revision and structured diagnostics.', {
        id: string
    }, ['id'], { id: '<fragment-id>' }),
    writeSource: toolSchema('Writes complete source only for creation or when smaller edits and patches are not viable; requires an expected revision and validates automatically.', {
        id: string, source: string, expectedRevision: string,
        dryRun: { type: 'boolean', description: 'Optional syntax-only preview; defaults to false.' }
    }, ['id', 'source', 'expectedRevision'], {
        id: '<fragment-id>', source: '<complete source>', expectedRevision: '<revision from read/list>'
    }),
    editFragment: toolSchema('Atomically replaces unique exact matches against one original snapshot, validates before writing, and reports final excerpts.', {
        id: string, expectedRevision: string,
        edits: { type: 'array', minItems: 1, items: {
            type: 'object', properties: { oldString: string, newString: string },
            required: ['oldString', 'newString'], additionalProperties: false
        } }, dryRun: { type: 'boolean', description: 'Optional syntax-only preview; defaults to false.' }
    }, ['id', 'expectedRevision', 'edits'], {
        id: '<fragment-id>', expectedRevision: '<revision from read/list>',
        edits: [{ oldString: '<exact existing source text>', newString: '<replacement source text>' }]
    }),
    applyFragmentPatch: toolSchema('Atomically applies strict unified diff hunks to the raw source; optional headers must name source rather than filesystem paths.', {
        id: string, expectedRevision: string,
        patches: { type: 'array', minItems: 1, items: {
            type: 'object', properties: { diff: string }, required: ['diff'], additionalProperties: false
        } }, dryRun: { type: 'boolean', description: 'Optional syntax-only preview; defaults to false.' }
    }, ['id', 'expectedRevision', 'patches'], {
        id: '<fragment-id>', expectedRevision: '<revision from read/list>',
        patches: [{ diff: '@@ -1 +1 @@\n-old line\n+new line\n' }]
    })
};
