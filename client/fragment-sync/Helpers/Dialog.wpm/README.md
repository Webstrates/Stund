# Dialog

Provides a simple dialog box that can be used to display modal dialogs.


## Import

```js
import { Dialog, DialogHeader, Section } from '#Dialog .default';
```

## Usage

```jsx
<Dialog visible={visible} setVisible={setVisible}>
    <DialogHeader title="Example" icon="widgets" onClose={() => setVisible(false)} />

    <Section title="Details" color="#2196f3" collapsable>
        <p>Content goes here.</p>
    </Section>
</Dialog>
```
