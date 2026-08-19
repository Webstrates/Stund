# Core Helpers

## Global Events

`useGlobalEvents` provides lightweight app-wide publish/subscribe messaging between React components.

- Provider: wrap your app with `GlobalEventProvider` (already done in `Code/Core/App.wpm/App.jsx`)
- Hook return value: `{ triggerEvent, subscribeEvent }`
- `triggerEvent(eventName, data)`: emit an event
- `subscribeEvent(eventName, callback)`: listen to an event, returns `unsubscribe`

### Minimal usage:

```jsx
import { useEffect } from 'react';
import { useGlobalEvents } from '#CoreHelpers .global-events';

function Example() {
    const { triggerEvent, subscribeEvent } = useGlobalEvents();

    useEffect(() => {
        if (!subscribeEvent) return;
        const unsubscribe = subscribeEvent('my-event', (payload) => {
            console.log('event payload:', payload);
        });
        return unsubscribe;
    }, [subscribeEvent]);

    return (
        <button onClick={() => triggerEvent('my-event', { ok: true })}>
            Emit
        </button>
    );
}
```


## Persisted State Hooks

The app provides 4 persistence hooks with React `[value, setValue]` APIs.

- `useDOMState(key, initialValue, storeId = 'default')`
- `useCookieState(key, initialValue)`
- `useWebstrateCookieState(key, initialValue)`
- `useFragmentState(fragmentSelector, initialValue)`

### `useDOMState`

- Stores state in DOM under a `dom-store` node (`Map`, arrays, and primitive/object values supported)
- Syncs updates across components through DOM mutations and across multiple clients
- Use `useTransientDOMState` for non-persistent DOM state, which is not shared across clients and not persisted on reload

### `useCookieState`

- Stores JSON-serializable state in browser cookies
- Scoped to current `location.pathname`
- Uses global events internally to sync same-key updates between components

### `useWebstrateCookieState`

- Persists to `webstrate.user.cookies.anywhere` when logged in, this is shared across clients and documents
- Falls back to browser cookies when user is anonymous/not logged in

### `useFragmentState`

- Stores the entire state value as the content of a single JSON fragment
- The `fragmentSelector` identifies which JSON fragment to use (e.g. `'#my-config'`); each fragment holds one value
- Syncs across components via global events and across clients via Webstrates OT (`registerOnFragmentChangedHandler`)
- Also provides imperative helpers: `getFragmentState(selector)`, `setFragmentState(value, selector)`

### Minimal usage

```jsx
import { useDOMState, useTransientDOMState } from '#CoreHelpers .dom-store';
import { useCookieState } from '#CoreHelpers .cookie-store';
import { useWebstrateCookieState } from '#CoreHelpers .webstrate-cookie-store';
import { useFragmentState } from '#CoreHelpers .fragment-store';

function ExampleState() {
    const [layout, setLayout] = useDOMState('layout-state', { zoom: 1 });
    const [serverUrl, setServerUrl] = useCookieState('server-url', 'http://192.168.42.1:6401/');
    const [profile, setProfile] = useWebstrateCookieState('profile', { theme: 'light' });
    const [config, setConfig] = useFragmentState('#my-settings', { mode: 'default' });

    return (
        <button
            onClick={() => {
                setLayout(prev => ({ ...prev, zoom: (prev.zoom || 1) + 0.1 }));
                setServerUrl('http://192.168.42.1:6401/');
                setProfile(prev => ({ ...prev, theme: 'dark' }));
                setConfig({ mode: 'advanced' });
            }}
        >
            Update State
        </button>
    );
}
```


## Dynamic Components

The app provides utilities for dynamically loading and rendering React components from fragments.

- `useDynamicModules(selector)`: Hook that returns an array of modules from fragments
- `DynamicComponents({ selector })`: Component that renders dynamic components from fragments

### `useDynamicModules`

- Queries fragments matching the selector and loads their exported modules
- Returns an array of `Main` exports from each fragment
- Automatically updates when fragments are added, removed, or changed
- Handles hot-reloading of fragment code

### `DynamicComponents`

- Renders components dynamically from fragments matching the selector
- Each fragment's `Main` export is rendered as a separate component
- Automatically adds/removes components when fragments are added/removed
- Includes error boundaries to prevent individual component failures from crashing the app
- Hot-reloads components when fragment code changes

### Minimal usage

```jsx
import { useDynamicModules, DynamicComponents } from '#CoreHelpers .dynamic-components';

// Using the hook to get modules
function ExampleWithHook() {
    const modules = useDynamicModules('fragment[data-type="plugin"]');

    return (
        <div>
            <h2>Loaded {modules.length} plugins</h2>
            {modules.map((Module, index) => (
                <Module key={index} />
            ))}
        </div>
    );
}

// Using the component directly
function ExampleWithComponent() {
    return (
        <div>
            <h2>Dynamic Plugins</h2>
            <DynamicComponents selector='fragment[data-type="plugin"]' />
        </div>
    );
}
```
