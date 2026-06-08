# Inline Block Editor (IBE) v1.0.0

A portable, framework-agnostic, block-based inline HTML editor built with native HTML5 `contenteditable`, ES6+ JavaScript, and CSS custom properties.

---

## Features

| Feature | Description |
|---------|-------------|
| **Block Architecture** | Paragraph, headings, images, video embeds, alerts, lists, code blocks, tables, raw HTML, and horizontal dividers. |
| **Drag-and-Drop** | Reorder blocks with fluid drag-and-drop via SortableJS integration (optional). |
| **Floating Toolbars** | Context-sensitive formatting toolbars that adapt to each block type. |
| **CSS Isolated** | All styles are prefixed with `.ibe-` to prevent host CSS collisions. |
| **Paste Sanitization** | Strips dangerous HTML (scripts, iframes, event handlers) on paste. |
| **Keyboard Shortcuts** | `Ctrl/Cmd+S` to save, `Escape` to exit edit mode. |
| **Event System** | Subscribe to `change`, `save`, `block:add`, `block:delete`, `block:move`, `mode:change`. |
| **Multi-Instance** | Multiple editors on the same page without interference. |
| **UMD Module** | Works as a browser global, CommonJS module, or AMD module. |

---

## Installation

### 1. Editor Assets

```html
<!-- Editor Stylesheet -->
<link rel="stylesheet" href="lib/inline-block-editor/inline-block-editor.css">

<!-- Editor Core Script -->
<script src="lib/inline-block-editor/inline-block-editor.js"></script>
```

### 2. External Libraries (CDN)

```html
<!-- Lucide Icons (Required for toolbars) -->
<script src="https://unpkg.com/lucide@latest"></script>

<!-- SortableJS (Optional – for drag-and-drop block sorting) -->
<script src="https://cdnjs.cloudflare.com/ajax/libs/Sortable/1.15.0/Sortable.min.js"></script>

<!-- Highlight.js (Optional – for code block syntax highlighting) -->
<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.8.0/styles/github-dark.min.css">
<script src="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.8.0/highlight.min.js"></script>
```

> **Note**: Only Lucide is required. SortableJS enables drag-and-drop; Highlight.js enables syntax highlighting in code blocks. Both degrade gracefully if absent.

---

## Getting Started

### 1. Define the HTML Container

```html
<div id="editor-container">
    <h2>Welcome to the Inline Block Editor</h2>
    <p>Click anywhere in this paragraph to edit its text inline.</p>
</div>

<div class="editor-controls">
    <button id="btn-preview">Toggle Preview Mode</button>
    <button id="btn-save">Save Content</button>
</div>
```

### 2. Initialize the Editor

```javascript
document.addEventListener('DOMContentLoaded', () => {
    const container = document.getElementById('editor-container');

    const editor = new InlineBlockEditor(container, {
        // Async save handler
        onSave: async (html, metadata) => {
            try {
                const response = await fetch('/api/save-page', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ html, id: metadata.pageId })
                });
                const data = await response.json();
                return data.success; // Return true to indicate success
            } catch (err) {
                console.error('Save failed:', err);
                return false;
            }
        },

        // Async image upload handler
        onUpload: async (file) => {
            const formData = new FormData();
            formData.append('image', file);
            try {
                const response = await fetch('/api/upload', {
                    method: 'POST',
                    body: formData
                });
                const data = await response.json();
                return data.url; // Return the URL of the uploaded image
            } catch (err) {
                console.error('Upload failed:', err);
                return '';
            }
        },

        // Custom confirm dialog
        confirm: async (title, message, btnText, type) => {
            return window.confirm(`${title}\n\n${message}`);
        },

        // Track unsaved changes
        isDirtyChange: (isDirty) => {
            console.log(isDirty ? 'Unsaved changes!' : 'Editor is clean.');
        }
    });

    // Save button
    document.getElementById('btn-save').addEventListener('click', async () => {
        await editor.save({ pageId: 101 });
    });

    // Preview toggle
    let isPreview = false;
    document.getElementById('btn-preview').addEventListener('click', () => {
        isPreview = !isPreview;
        editor.setPreviewMode(isPreview);
    });
});
```

---

## Options API Reference

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `endpoint` | `String` | `""` | URL for standard POST form submissions if `onSave` is not defined. |
| `onSave` | `Function` | `null` | Async save callback: `async (html, metadata) => Boolean` |
| `onUpload` | `Function` | `null` | Async upload callback: `async (file) => String` (return public URL) |
| `onImageZoom` | `Function` | `null` | Image zoom callback: `(src, alt, images) => void` |
| `onPaste` | `Function` | `null` | Custom paste processor: `(html, plainText) => sanitizedHtml` |
| `confirm` | `Function` | `null` | Async confirm dialog: `async (title, msg, btnText, type) => Boolean` |
| `allowedBlocks` | `Array` | `['p','image','video','alert','code','table','html','hr']` | Enabled block types in insertion menu. |
| `isDirtyChange` | `Function` | `null` | Callback when dirty state changes: `(isDirty) => void` |
| `debug` | `Boolean` | `false` | Enable debug logging to console. |

---

## Methods API

### `getContent()` / `getHTML()`

Returns clean HTML output with all editor artifacts removed.

```javascript
const html = editor.getContent();
```

### `setHTML(html)`

Replaces editor content with new HTML and re-initializes all blocks.

```javascript
editor.setHTML('<p>New content loaded.</p>');
```

### `save(metadata = {})`

Triggers the save pipeline, calling `onSave` or posting to `endpoint`.

```javascript
await editor.save({ articleId: 45 });
```

### `setPreviewMode(preview)` / `enable()` / `disable()`

Toggle between edit and preview modes.

```javascript
editor.setPreviewMode(true);  // Preview mode
editor.enable();               // Edit mode
editor.disable();              // Preview mode
```

### `isEnabled()`

Returns `true` if the editor is in edit mode.

```javascript
if (editor.isEnabled()) { /* editing */ }
```

### `clear()`

Removes all blocks and creates a single empty paragraph.

```javascript
editor.clear();
```

### `duplicateBlock(block)`

Duplicates the given block element and inserts it directly below, complete with regenerated IDs and initialized controls.

```javascript
const block = container.querySelector('.ibe-block');
editor.duplicateBlock(block);
```

### `destroy()`

Unbinds all event listeners, destroys Sortable, removes editor UI, and cleans up. Safe to call multiple times.

```javascript
editor.destroy();
```

### `showToast(message)`

Displays a brief toast notification.

```javascript
editor.showToast('Changes saved!');
```

### `triggerConfirm(title, message, btnText, type)`

Shows a confirmation dialog using the configured `confirm` callback.

```javascript
const ok = await editor.triggerConfirm('Delete?', 'This cannot be undone.', 'Delete', 'danger');
```

---

## Events

Register event listeners with `on()` and remove with `off()`:

```javascript
editor.on('change', () => console.log('Content changed'));
editor.on('save', (data) => console.log('Saved:', data.success));
editor.on('block:add', (data) => console.log('Added block type:', data.type));
editor.on('block:delete', (data) => console.log('Deleted:', data.type));
editor.on('block:move', () => console.log('Block reordered'));
editor.on('mode:change', (data) => console.log('Preview:', data.preview));

// Remove a specific listener
editor.off('change', myCallback);
```

---

## Block Reference

Every block is wrapped in this structure:

```html
<div class="ibe-block col-12" data-type="p">
    <div class="ibe-block-content">
        <p>Paragraph text content...</p>
    </div>
</div>
```

### Available Block Types (`data-type`)

| Type | Description |
|------|-------------|
| `p` | Standard paragraph text. |
| `h2` / `h3` | Document headings. |
| `ul` / `ol` | Unordered and ordered lists. |
| `image` | `<figure>` with `<img>`, optional `<figcaption>`, link wrapping, and aspect ratio setting. |
| `video` | Responsive iframe container (YouTube/Vimeo) with optional `<figcaption>`. |
| `alert` | Alert boxes (`.alert-box.info`, `.success`, `.warning`, `.danger`). |
| `code` | Code block with syntax highlighting and language selector. |
| `table` | Table with bordered/striped styling, add/remove rows and columns. |
| `html` | Raw HTML block with toggle between edit and rendered view. |
| `hr` | Divider block with line styles (solid, dashed, dotted, double) and widths (full, medium, short). |

---

## Styling & Customization

Override the editor's visual theme using CSS custom properties:

```css
.ibe-container {
    --ibe-toolbar-bg: #1e1b4b;            /* Toolbar background */
    --ibe-toolbar-border: rgba(255, 255, 255, 0.1);
    --ibe-toolbar-text: #f8fafc;
    --ibe-accent: #8b5cf6;                 /* Accent / primary color */
    --ibe-accent-hover: #7c3aed;
    --ibe-danger: #ef4444;
    --ibe-modal-bg: #1e1b4b;               /* Modal background */
    --ibe-input-bg: #312e81;               /* Input backgrounds */
    --ibe-input-border: rgba(255, 255, 255, 0.15);
    --ibe-block-outline: rgba(139, 92, 246, 0.3);
    --ibe-block-outline-hover: rgba(139, 92, 246, 0.6);
    --ibe-block-outline-active: #8b5cf6;
    --ibe-separator-color: #8b5cf6;
    --ibe-toast-bg: #1e1b4b;
    --ibe-font-mono: 'JetBrains Mono', monospace;
}
```

See the full list of CSS custom properties in `inline-block-editor.css`.

---

## Lifecycle & Multi-Instance

### Destroy & Reinitialize

```javascript
editor.destroy();
const editor2 = new InlineBlockEditor(container, options);
```

### Multiple Editors

```javascript
const editor1 = new InlineBlockEditor('#editor-1', opts);
const editor2 = new InlineBlockEditor('#editor-2', opts);
// Each instance is fully independent
```

---

## Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| `Ctrl/Cmd + S` | Save editor content |
| `Escape` | Exit current block edit mode |
| `Ctrl/Cmd + B` | Bold (native contenteditable) |
| `Ctrl/Cmd + I` | Italic (native contenteditable) |
| `Ctrl/Cmd + U` | Underline (native contenteditable) |
| `Ctrl/Cmd + Z` | Undo (native contenteditable) |
| `Ctrl/Cmd + Shift + Z` | Redo (native contenteditable) |

---

## Security

- **Paste sanitization**: All pasted HTML is stripped of `<script>`, `<iframe>`, `<style>`, `<object>`, `<embed>`, `<form>`, and event handler attributes (`onclick`, `onload`, etc.).
- **Template escaping**: All user-provided values interpolated into modal HTML are escaped to prevent XSS.
- **Custom paste handler**: Use the `onPaste` option for full control over paste processing.

---

## Browser Support

| Browser | Support |
|---------|---------|
| Chrome | ✅ Latest |
| Firefox | ✅ Latest |
| Safari | ✅ Latest |
| Edge | ✅ Latest |
| IE 11 | ❌ Not supported |

> **Note**: The editor relies on `document.execCommand` for inline formatting, which is deprecated but remains the only cross-browser approach for `contenteditable` formatting. Modern browsers continue to support it.

---

## Version

```javascript
console.log(InlineBlockEditor.VERSION); // "1.0.0"
```

---

## License

MIT
