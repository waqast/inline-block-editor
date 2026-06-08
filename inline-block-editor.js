/**
 * Inline Block Editor v1.0.0
 * A portable, framework-agnostic, block-based inline editor.
 * Built with native HTML5 contenteditable, ES6+ JavaScript, and CSS variables.
 *
 * @license MIT
 * @see README.md for full documentation.
 */
'use strict';

class InlineBlockEditor {

    /** @type {string} Semantic version */
    static VERSION = '1.0.0';

    /**
     * @param {string|HTMLElement} container - CSS selector or DOM element
     * @param {Object} [options={}] - Configuration options
     */
    constructor(container, options = {}) {
        this.container = typeof container === 'string' ? document.querySelector(container) : container;

        if (!this.container) {
            console.error('InlineBlockEditor: Container element not found.');
            this._destroyed = true;
            return;
        }

        // Instance identity
        this._id = this._randomId('ibe-inst');
        this._destroyed = false;
        this._initialized = false;
        this._listeners = {};  // Event emitter store
        this._handlers = {};   // DOM handler references for cleanup

        // Default configurations
        this.options = Object.assign({
            endpoint: '',
            onSave: null,          // async (html, metadata) => boolean
            onUpload: null,        // async (file) => url string
            onImageZoom: null,     // (src, alt, images) => void
            onPaste: null,         // (html, plainText) => sanitizedHtml
            confirm: null,         // async (title, msg, btnText, type) => boolean
            allowedBlocks: ['p', 'image', 'video', 'alert', 'code', 'table', 'html', 'hr'],
            isDirtyChange: null,   // (isDirty) => void
            debug: false
        }, options);

        this.isDirty = false;
        this.isPreviewMode = false;
        this.sortable = null;

        this._init();
    }

    // ─── Internal Utilities ─────────────────────────────────────────────

    /** Generate a unique ID string */
    _randomId(prefix = 'ibe') {
        return `${prefix}-${Math.random().toString(36).substring(2, 9)}`;
    }

    /** Kept for backward compatibility */
    getRandomId(prefix = 'ibe') {
        return this._randomId(prefix);
    }

    /** Log a warning (only when debug mode is enabled) */
    _warn(msg, ...args) {
        if (this.options.debug) {
            console.warn(`[IBE ${this._id}] ${msg}`, ...args);
        }
    }

    /** Log an error (always shown) */
    _error(msg, ...args) {
        console.error(`[IBE] ${msg}`, ...args);
    }

    /** Guard: return true if instance is destroyed */
    _guardDestroyed(method) {
        if (this._destroyed) {
            this._error(`Cannot call ${method}() on a destroyed editor instance.`);
            return true;
        }
        return false;
    }

    /** Escape HTML special characters for safe template interpolation */
    _escAttr(str) {
        if (!str) return '';
        return String(str)
            .replace(/&/g, '&amp;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;');
    }

    /** Scope lucide icon rendering to a specific DOM element */
    _renderIcons(element) {
        if (window.lucide) {
            try {
                if (element && element.querySelectorAll('[data-lucide]').length > 0) {
                    window.lucide.createIcons({ nodes: [element], attrs: { 'stroke-width': 2.5 } });
                } else {
                    window.lucide.createIcons({ attrs: { 'stroke-width': 2.5 } });
                }
            } catch (_) {
                // Fallback: lucide may not support nodes option in all versions
                window.lucide.createIcons({ attrs: { 'stroke-width': 2.5 } });
            }
        }
    }

    // ─── Event Emitter ──────────────────────────────────────────────────

    /**
     * Register an event listener.
     * Events: 'change', 'save', 'block:add', 'block:delete', 'block:move', 'mode:change'
     * @param {string} event
     * @param {Function} callback
     */
    on(event, callback) {
        if (typeof callback !== 'function') return this;
        if (!this._listeners[event]) this._listeners[event] = [];
        this._listeners[event].push(callback);
        return this;
    }

    /**
     * Remove an event listener.
     * @param {string} event
     * @param {Function} callback
     */
    off(event, callback) {
        if (!this._listeners[event]) return this;
        this._listeners[event] = this._listeners[event].filter(fn => fn !== callback);
        return this;
    }

    /** @private Emit an event to all registered listeners */
    _emit(event, data) {
        if (this._listeners[event]) {
            this._listeners[event].forEach(fn => {
                try { fn(data); } catch (err) { this._error('Event handler error:', err); }
            });
        }
    }

    // ─── Initialization ─────────────────────────────────────────────────

    _init() {
        if (this._initialized) {
            this._warn('Editor already initialized on this container.');
            return;
        }
        this._initialized = true;
        this.container.classList.add('ibe-container', 'is-edit-mode');
        this.container.setAttribute('data-ibe-id', this._id);

        // Migrate legacy content to blocks if needed
        this._migrateToBlocks();

        // Initialize Sortable if available globally
        if (typeof Sortable !== 'undefined') {
            this.sortable = new Sortable(this.container, {
                animation: 150,
                handle: '.ibe-block-grip',
                ghostClass: 'ibe-sortable-ghost',
                draggable: '.ibe-block',
                onEnd: () => {
                    this._reorganizeSeparators();
                    this.markDirty();
                    this._emit('block:move');
                }
            });
        }

        // Initialize existing blocks
        this.container.querySelectorAll('.ibe-block').forEach(block => {
            this._createControls(block);
            this._fixLegacyBlockStructure(block);
        });

        this._ensureTopSeparator();

        // ── Global mousedown handler (scoped to this instance) ──
        this._handlers.mouseDown = (e) => {
            if (this.isPreviewMode) return;
            // Ignore clicks inside IBE modals
            if (e.target.closest('.ibe-modal-overlay')) return;

            const block = e.target.closest('.ibe-block');
            const toolbar = e.target.closest('.ibe-toolbar');
            const menu = e.target.closest('.ibe-separator');

            const isOurBlock = block && this.container.contains(block);
            const isOurToolbar = toolbar && this.container.contains(toolbar);
            const isOurMenu = menu && this.container.contains(menu);

            if (isOurBlock && !isOurToolbar && !isOurMenu) {
                this.enterEditMode(block);
            } else if (!isOurBlock && !isOurToolbar && !isOurMenu) {
                this.container.querySelectorAll('.ibe-block.is-editing').forEach(b => this.exitEditMode(b));
            }
        };
        document.addEventListener('mousedown', this._handlers.mouseDown);

        // ── Input / dirty tracking ──
        this._handlers.input = () => { this.markDirty(); };
        this.container.addEventListener('input', this._handlers.input);

        // ── Paste sanitizer ──
        this._handlers.paste = (e) => { this._handlePaste(e); };
        this.container.addEventListener('paste', this._handlers.paste);

        // ── Keyboard shortcuts ──
        this._handlers.keydown = (e) => { this._handleKeydown(e); };
        this.container.addEventListener('keydown', this._handlers.keydown);

        // ── Beforeunload guard ──
        this._handlers.beforeunload = (e) => {
            if (this.isDirty) {
                e.preventDefault();
                e.returnValue = '';
                return '';
            }
        };
        window.addEventListener('beforeunload', this._handlers.beforeunload);

        // ── Close insertion menus on outside click ──
        this._handlers.docClick = (e) => {
            if (!e.target.closest('.ibe-separator')) {
                this.container.querySelectorAll('.ibe-insertion-menu.active').forEach(m => {
                    m.classList.remove('active');
                    if (m.parentElement) m.parentElement.classList.remove('active');
                });
            }
        };
        document.addEventListener('click', this._handlers.docClick);
    }

    // ─── Dirty State ────────────────────────────────────────────────────

    markDirty() {
        this.isDirty = true;
        if (this.options.isDirtyChange) {
            this.options.isDirtyChange(true);
        }
        this._emit('change');
    }

    clearDirty() {
        this.isDirty = false;
        if (this.options.isDirtyChange) {
            this.options.isDirtyChange(false);
        }
    }

    // ─── Paste Handling ─────────────────────────────────────────────────

    _handlePaste(e) {
        // Only intercept paste inside contenteditable areas
        const target = e.target;
        if (!target.isContentEditable && target.tagName !== 'TEXTAREA') return;
        // Don't intercept paste in raw code/html textareas
        if (target.classList.contains('ibe-code-textarea') ||
            target.classList.contains('html-editor-raw') ||
            target.classList.contains('ibe-html-textarea')) return;
        if (!target.isContentEditable) return;

        const clipboardData = e.clipboardData || window.clipboardData;
        if (!clipboardData) return;

        const html = clipboardData.getData('text/html');
        const plain = clipboardData.getData('text/plain');

        // Let user handle paste if custom handler provided
        if (this.options.onPaste) {
            e.preventDefault();
            const sanitized = this.options.onPaste(html, plain);
            document.execCommand('insertHTML', false, sanitized || this._escAttr(plain));
            return;
        }

        // Default sanitization: strip dangerous elements from pasted HTML
        if (html) {
            e.preventDefault();
            const sanitized = this._sanitizePastedHtml(html);
            document.execCommand('insertHTML', false, sanitized);
        }
        // If only plain text, let browser handle it naturally
    }

    /** Strip dangerous tags/attributes from pasted HTML */
    _sanitizePastedHtml(html) {
        const temp = document.createElement('div');
        temp.innerHTML = html;

        // Remove dangerous elements
        const dangerousTags = ['script', 'style', 'iframe', 'object', 'embed', 'form',
                               'input', 'textarea', 'select', 'button', 'link', 'meta'];
        dangerousTags.forEach(tag => {
            temp.querySelectorAll(tag).forEach(el => el.remove());
        });

        // Remove event handler attributes and dangerous attributes
        const dangerousAttrs = ['onclick', 'onload', 'onerror', 'onmouseover', 'onfocus',
                                'onblur', 'onsubmit', 'onchange', 'oninput', 'onkeydown',
                                'onkeyup', 'onkeypress', 'onmousedown', 'onmouseup'];
        temp.querySelectorAll('*').forEach(el => {
            dangerousAttrs.forEach(attr => el.removeAttribute(attr));
            // Remove style attribute to prevent injected CSS
            // Keep class names for basic formatting
            el.removeAttribute('style');
            el.removeAttribute('id');
        });

        return temp.innerHTML;
    }

    // ─── Keyboard Shortcuts ─────────────────────────────────────────────

    _handleKeydown(e) {
        const isMeta = e.metaKey || e.ctrlKey;

        // Ctrl/Cmd + S → Save
        if (isMeta && e.key === 's') {
            e.preventDefault();
            this.save();
            return;
        }

        // Escape → exit current editing block
        if (e.key === 'Escape') {
            const editingBlocks = this.container.querySelectorAll('.ibe-block.is-editing');
            if (editingBlocks.length > 0) {
                editingBlocks.forEach(b => this.exitEditMode(b));
                e.preventDefault();
            }
            return;
        }
    }

    // ─── Block Migration ────────────────────────────────────────────────

    _migrateToBlocks() {
        const children = Array.from(this.container.children);
        const hasBlocks = children.some(c => c.classList.contains('ibe-block') || c.classList.contains('article-block'));

        if (!hasBlocks) {
            const originalHtml = this.container.innerHTML.trim();
            const contentToWrap = originalHtml || '<p>Start typing here...</p>';
            this.container.innerHTML = `
                <div class="ibe-block col-12" data-type="p">
                    <div class="ibe-block-content">${contentToWrap}</div>
                </div>
            `;
        } else {
            // Standardize any old project blocks to ibe-block
            this.container.querySelectorAll('.article-block').forEach(b => {
                b.classList.remove('article-block');
                b.classList.add('ibe-block');
                const content = b.querySelector('.block-content');
                if (content) {
                    content.classList.remove('block-content');
                    content.classList.add('ibe-block-content');
                }
            });
        }
    }

    _fixLegacyBlockStructure(b) {
        if (b.dataset.type === 'alert') {
            const box = b.querySelector('.alert-box');
            if (box && !box.querySelector('.alert-txt')) {
                const inner = box.innerHTML;
                const iconMatch = inner.match(/<i.*?>.*?<\/i>|<svg.*?>.*?<\/svg>/);
                const iconContent = iconMatch ? iconMatch[0] : '';
                let textContent = inner.replace(iconContent, '').trim();
                if (textContent.startsWith('<div>') && textContent.endsWith('</div>')) {
                    textContent = textContent.slice(5, -6);
                }
                box.innerHTML = `${iconContent}<div class="alert-txt">${textContent}</div>`;
            }
        }
        if (b.dataset.type === 'html') {
            const container = b.querySelector('.custom-html-block');
            if (container) {
                if (!container.querySelector('.html-preview')) {
                    const currentHtml = container.innerHTML;
                    const textareaId = this._randomId('html-editor');
                    container.innerHTML = `<div class="html-preview">${currentHtml}</div><textarea id="${textareaId}" name="html_editor_raw" class="html-editor-raw no-print" style="display:none;"></textarea>`;
                } else if (!container.querySelector('.html-editor-raw')) {
                    const textareaId = this._randomId('html-editor');
                    const textarea = document.createElement('textarea');
                    textarea.id = textareaId;
                    textarea.name = 'html_editor_raw';
                    textarea.className = 'html-editor-raw no-print';
                    textarea.style.display = 'none';
                    container.appendChild(textarea);
                }
            }
        }
        if (b.dataset.type === 'code') {
            let wrapper = b.querySelector('.ibe-code-block');
            if (!wrapper) {
                const pre = b.querySelector('pre');
                if (pre) {
                    wrapper = document.createElement('div');
                    wrapper.className = 'ibe-code-block';
                    pre.parentNode.insertBefore(wrapper, pre);
                    wrapper.appendChild(pre);
                }
            }
            if (wrapper && !wrapper.querySelector('.ibe-code-textarea')) {
                const textareaId = this._randomId('code-editor');
                const textarea = document.createElement('textarea');
                textarea.id = textareaId;
                textarea.name = 'code_editor_raw';
                textarea.className = 'ibe-code-textarea no-print';
                textarea.style.display = 'none';
                wrapper.appendChild(textarea);
            }
        }
    }

    // ─── Separators ─────────────────────────────────────────────────────

    _reorganizeSeparators() {
        this.container.querySelectorAll('.ibe-separator').forEach(s => s.remove());
        this._ensureTopSeparator();
        this.container.querySelectorAll('.ibe-block').forEach(b => this._createSeparator(b));
    }

    _ensureTopSeparator() {
        if (!this.container.firstElementChild || !this.container.firstElementChild.classList.contains('ibe-separator')) {
            const topSep = this._createSeparatorHtml();
            topSep.classList.add('is-top');
            this.container.prepend(topSep);
            this._renderIcons(topSep);
        }
    }

    _createSeparatorHtml() {
        const separator = document.createElement('div');
        separator.className = 'ibe-separator no-print';

        let itemsHtml = '';
        const types = {
            p: { label: 'Text', icon: 'type' },
            h2: { label: 'H2', icon: 'heading' },
            h3: { label: 'H3', icon: 'heading-3' },
            image: { label: 'Image', icon: 'image' },
            video: { label: 'Video', icon: 'video' },
            alert: { label: 'Note', icon: 'alert-circle' },
            ul: { label: 'Bullet List', icon: 'list' },
            ol: { label: 'Numbered List', icon: 'list-ordered' },
            code: { label: 'Code', icon: 'code-2' },
            table: { label: 'Table', icon: 'table' },
            html: { label: 'HTML', icon: 'code' },
            hr: { label: 'Divider', icon: 'minus' }
        };

        this.options.allowedBlocks.forEach(t => {
            if (types[t]) {
                itemsHtml += `
                    <div class="ibe-insertion-item" data-type="${t}">
                        <i data-lucide="${types[t].icon}"></i>
                        <span>${types[t].label}</span>
                    </div>
                `;
            }
        });

        separator.innerHTML = `
            <button type="button" class="ibe-add-btn-small" title="Insert block here" aria-label="Insert block here">
                <i data-lucide="plus"></i>
            </button>
            <div class="ibe-insertion-menu no-print" role="menu">
                <div class="ibe-insertion-grid">
                    ${itemsHtml}
                </div>
            </div>
        `;

        const btn = separator.querySelector('.ibe-add-btn-small');
        const menu = separator.querySelector('.ibe-insertion-menu');

        btn.onclick = (e) => {
            e.stopPropagation();
            // Close other menus within THIS instance only
            this.container.querySelectorAll('.ibe-insertion-menu.active').forEach(m => {
                if (m !== menu) {
                    m.classList.remove('active');
                    if (m.parentElement) m.parentElement.classList.remove('active');
                }
            });
            menu.classList.toggle('active');
            separator.classList.toggle('active');
        };

        separator.querySelectorAll('.ibe-insertion-item').forEach(item => {
            item.onclick = (e) => {
                e.stopPropagation();
                const type = item.dataset.type;
                const newBlock = this._createBlockElement(type);

                if (separator.classList.contains('is-top')) {
                    separator.after(newBlock);
                } else {
                    // separator is inside a block; insert after that block
                    const parentBlock = separator.closest('.ibe-block');
                    if (parentBlock) {
                        parentBlock.after(newBlock);
                    } else {
                        separator.after(newBlock);
                    }
                }

                this._createControls(newBlock, true);
                this._createSeparator(newBlock);
                menu.classList.remove('active');
                separator.classList.remove('active');
                this.enterEditMode(newBlock);
                this.markDirty();
                this._emit('block:add', { type, block: newBlock });
            };
        });

        return separator;
    }

    _createSeparator(block) {
        if (block.querySelector(':scope > .ibe-separator')) return;
        const separator = this._createSeparatorHtml();
        block.appendChild(separator);
        this._renderIcons(separator);
    }

    // ─── Block Creation ─────────────────────────────────────────────────

    _createBlockElement(type) {
        const block = document.createElement('div');
        block.className = 'ibe-block col-12';
        block.dataset.type = type;

        let innerContent = '';
        switch (type) {
            case 'h2': innerContent = '<h2>New Heading 2</h2>'; break;
            case 'h3': innerContent = '<h3>New Heading 3</h3>'; break;
            case 'p': innerContent = '<p>Enter your detailed description here...</p>'; break;
            case 'ul': innerContent = '<ul><li>Item 1</li><li>Item 2</li></ul>'; break;
            case 'ol': innerContent = '<ol><li>Item 1</li><li>Item 2</li></ol>'; break;
            case 'image': innerContent = '<figure class="article-image"><img src="https://placehold.co/800x400?text=Insert+Image+URL" alt="Image description"><figcaption>Image description</figcaption></figure>'; break;
            case 'video': innerContent = '<div class="article-video"><div class="video-container"><iframe src="https://www.youtube.com/embed/dQw4w9WgXcQ" frameborder="0" allowfullscreen></iframe></div><figcaption>Video description</figcaption></div>'; break;
            case 'alert': innerContent = '<div class="alert-box info"><i data-lucide="info"></i><div class="alert-txt"><strong>Note:</strong> Enter information here.</div></div>'; break;
            case 'code': {
                const textareaId = this._randomId('code-editor');
                innerContent = `<div class="ibe-code-block"><pre><code class="language-javascript">console.log("Hello, world!");</code></pre><textarea id="${textareaId}" name="code_editor_raw" class="ibe-code-textarea no-print" style="display:none;"></textarea></div>`;
                break;
            }
            case 'table': {
                innerContent = `
                    <div class="ibe-table-wrapper table-responsive bordered">
                        <table class="ibe-table table">
                            <thead>
                                <tr>
                                    <th>Header 1</th>
                                    <th>Header 2</th>
                                </tr>
                            </thead>
                            <tbody>
                                <tr>
                                    <td>Cell 1</td>
                                    <td>Cell 2</td>
                                </tr>
                            </tbody>
                        </table>
                    </div>
                `;
                break;
            }
            case 'html': {
                const textareaId = this._randomId('html-editor');
                innerContent = `<div class="custom-html-block"><div class="html-preview"><p>Raw HTML Content Placeholder</p></div><textarea id="${textareaId}" name="html_editor_raw" class="html-editor-raw no-print" style="display:none;"></textarea></div>`;
                break;
            }
            case 'hr': {
                innerContent = '<hr class="ibe-hr">';
                break;
            }
        }

        block.innerHTML = `<div class="ibe-block-content">${innerContent}</div>`;
        return block;
    }

    // ─── Block Controls ─────────────────────────────────────────────────

    _createControls(block, isNew = false) {
        this._createBlockToolbar(block, isNew);
        this._createSeparator(block);
        this._ensureImageZoomButton(block);
    }

    _ensureImageZoomButton(block) {
        if (block.dataset.type === 'image') {
            const figOuter = block.querySelector('.article-image');
            if (figOuter) {
                const existingBtn = figOuter.querySelector('.ibe-img-zoom-btn');
                if (!existingBtn) {
                    const zoomBtn = document.createElement('button');
                    zoomBtn.type = 'button';
                    zoomBtn.className = 'ibe-img-zoom-btn no-print';
                    zoomBtn.title = 'Zoom Image';
                    zoomBtn.setAttribute('aria-label', 'Zoom Image');
                    zoomBtn.innerHTML = '<i data-lucide="maximize-2"></i>';
                    figOuter.appendChild(zoomBtn);
                    this._renderIcons(zoomBtn);

                    zoomBtn.onclick = (e) => {
                        e.stopPropagation();
                        const img = figOuter.querySelector('img');
                        if (img) {
                            const alt = img.getAttribute('alt') || figOuter.querySelector('figcaption')?.innerText || '';
                            const images = [{ src: img.src, alt }];
                            if (this.options.onImageZoom) {
                                this.options.onImageZoom(img.src, alt, images);
                            } else if (window.DocsUI && typeof window.DocsUI.lightbox === 'function') {
                                window.DocsUI.lightbox(img.src, alt, images);
                            }
                        }
                    };
                }
            }
        }
    }

    // ─── Modal Helpers ──────────────────────────────────────────────────

    /**
     * Create a standard modal overlay. Returns { overlay, body, close }.
     * @param {string} title - Modal title
     * @param {string} saveLabel - Save button text
     * @returns {{ overlay: HTMLElement, body: HTMLElement, close: Function, onSave: Function }}
     */
    _createModal(title, saveLabel = 'Apply') {
        const overlay = document.createElement('div');
        overlay.className = 'ibe-modal-overlay';
        overlay.setAttribute('role', 'dialog');
        overlay.setAttribute('aria-modal', 'true');
        overlay.setAttribute('aria-label', title);

        overlay.innerHTML = `
            <div class="ibe-modal">
                <div class="ibe-modal-header">
                    <h3>${this._escAttr(title)}</h3>
                    <button class="ibe-modal-close" type="button" aria-label="Close"><i data-lucide="x"></i></button>
                </div>
                <div class="ibe-modal-body"></div>
                <div class="ibe-modal-footer">
                    <button type="button" class="ibe-btn ibe-btn-ghost ibe-modal-cancel">Cancel</button>
                    <button type="button" class="ibe-btn ibe-btn-primary ibe-modal-save">${this._escAttr(saveLabel)}</button>
                </div>
            </div>
        `;

        const body = overlay.querySelector('.ibe-modal-body');
        let _resolveClose = null;

        const close = (val) => {
            overlay.classList.remove('active');
            setTimeout(() => overlay.remove(), 250);
            if (_resolveClose) _resolveClose(val);
        };

        overlay.querySelector('.ibe-modal-close').onclick = () => close(null);
        overlay.querySelector('.ibe-modal-cancel').onclick = () => close(null);

        // Close on overlay click
        overlay.addEventListener('mousedown', (e) => {
            if (e.target === overlay) close(null);
        });

        // Close on Escape
        const escHandler = (e) => {
            if (e.key === 'Escape') {
                close(null);
                document.removeEventListener('keydown', escHandler);
            }
        };
        document.addEventListener('keydown', escHandler);

        document.body.appendChild(overlay);
        this._renderIcons(overlay);
        setTimeout(() => overlay.classList.add('active'), 10);

        return {
            overlay,
            body,
            close,
            /** Register the save callback and return a promise */
            awaitResult() {
                return new Promise((resolve) => {
                    _resolveClose = resolve;
                });
            }
        };
    }

    // ─── Image Settings Modal ───────────────────────────────────────────

    async showImageSettingsModal(currentData = {}) {
        const { overlay, body, close, awaitResult } = this._createModal('Image Settings', 'Apply Settings');

        const esc = this._escAttr.bind(this);
        const isChecked = (val) => val ? 'checked' : '';
        const isSelected = (val, target) => val === target ? 'selected' : '';

        body.innerHTML = `
            <div class="ibe-form-group">
                <label>Image URL</label>
                <div style="display:flex; gap:8px;">
                    <input type="text" class="ibe-form-input ibe-img-url" value="${esc(currentData.url)}" placeholder="https://example.com/image.jpg" autofocus style="flex:1;">
                    ${this.options.onUpload ? `
                    <div class="ibe-btn ibe-btn-ghost img-upload-btn" title="Upload Image" style="position:relative; display:flex; align-items:center; justify-content:center; border: 1px solid rgba(255,255,255,0.15); height: 38px; width: 38px; padding: 0;">
                        <i data-lucide="upload-cloud"></i>
                        <input type="file" class="ibe-file-input" accept="image/*" style="opacity:0; position:absolute; inset:0; cursor:pointer; width:100%; height:100%;">
                    </div>
                    ` : ''}
                </div>
            </div>
            <div class="ibe-form-row">
                <div class="ibe-form-group">
                    <label>Caption</label>
                    <input type="text" class="ibe-form-input ibe-img-caption" value="${esc(currentData.caption)}" placeholder="Image caption under image">
                </div>
                <div class="ibe-form-group">
                    <label>Alt Text</label>
                    <input type="text" class="ibe-form-input ibe-img-alt" value="${esc(currentData.alt)}" placeholder="Alt attribute (for accessibility)">
                </div>
            </div>
            <div class="ibe-form-row">
                <div class="ibe-form-group">
                    <label>Link URL (Optional)</label>
                    <input type="text" class="ibe-form-input ibe-img-link" value="${esc(currentData.link)}" placeholder="https://example.com/target">
                </div>
                <div class="ibe-form-group">
                    <label>Link Target</label>
                    <select class="ibe-form-select ibe-img-link-target">
                        <option value="_self" ${isSelected(currentData.target, '_self')}>Same Window (_self)</option>
                        <option value="_blank" ${isSelected(currentData.target, '_blank')}>New Tab (_blank)</option>
                    </select>
                </div>
            </div>
            <div class="ibe-form-row">
                <div class="ibe-form-group">
                    <label>Height (e.g. 300px, 100%, auto)</label>
                    <input type="text" class="ibe-form-input ibe-img-height" value="${esc(currentData.height)}" placeholder="auto">
                </div>
                <div class="ibe-form-group">
                    <label>Aspect Ratio</label>
                    <select class="ibe-form-select ibe-img-aspect">
                        <option value="strict" ${isSelected(currentData.aspect, 'strict')}>Strict (480px)</option>
                        <option value="original" ${isSelected(currentData.aspect, 'original')}>Original</option>
                    </select>
                </div>
            </div>
            <div class="ibe-form-group ibe-form-checkboxes">
                <label class="ibe-checkbox-label">
                    <input type="checkbox" class="ibe-img-zoom" ${isChecked(currentData.zoom)}>
                    <span>Click to Zoom</span>
                </label>
            </div>
        `;
        this._renderIcons(overlay);

        // Handle file upload
        const fileInput = overlay.querySelector('.ibe-file-input');
        if (fileInput && this.options.onUpload) {
            fileInput.onchange = async (e) => {
                if (e.target.files && e.target.files[0]) {
                    const file = e.target.files[0];
                    try {
                        const uploadBtn = overlay.querySelector('.img-upload-btn');
                        if (uploadBtn) {
                            uploadBtn.style.opacity = '0.5';
                            uploadBtn.style.pointerEvents = 'none';
                        }

                        const uploadedUrl = await this.options.onUpload(file);

                        if (uploadBtn) {
                            uploadBtn.style.opacity = '1';
                            uploadBtn.style.pointerEvents = 'auto';
                        }

                        if (uploadedUrl) {
                            overlay.querySelector('.ibe-img-url').value = uploadedUrl;
                            this.showToast('Image uploaded successfully');
                        } else {
                            this.showToast('Upload failed');
                        }
                    } catch (err) {
                        this.showToast('Error uploading file');
                        this._error('Image upload error:', err);
                    }
                }
            };
        }

        overlay.querySelector('.ibe-modal-save').onclick = () => {
            close({
                url: overlay.querySelector('.ibe-img-url').value.trim(),
                caption: overlay.querySelector('.ibe-img-caption').value.trim(),
                alt: overlay.querySelector('.ibe-img-alt').value.trim(),
                link: overlay.querySelector('.ibe-img-link').value.trim(),
                target: overlay.querySelector('.ibe-img-link-target').value,
                height: overlay.querySelector('.ibe-img-height').value.trim(),
                aspect: overlay.querySelector('.ibe-img-aspect').value,
                zoom: overlay.querySelector('.ibe-img-zoom').checked
            });
        };

        return awaitResult();
    }

    _applyImageSettings(block, data) {
        const figOuter = block.querySelector('.article-image');
        let img = block.querySelector('img');
        let fig = block.querySelector('figcaption');
        let anchor = block.querySelector('.ibe-block-content > figure > a') || block.querySelector('.ibe-block-content a');

        if (img) {
            img.setAttribute('src', data.url);
            img.setAttribute('alt', data.alt);
            img.style.height = data.height || '';
        }

        if (fig) {
            fig.innerText = data.caption;
            fig.style.display = data.caption ? '' : 'none';
        }

        if (figOuter) {
            if (data.aspect === 'original') {
                figOuter.classList.add('aspect-original');
            } else {
                figOuter.classList.remove('aspect-original');
            }
            figOuter.setAttribute('data-zoom', data.zoom ? 'true' : 'false');
        }

        // Handle link wrapping
        const contentDiv = block.querySelector('.ibe-block-content');
        if (contentDiv && figOuter) {
            if (data.link) {
                if (!anchor) {
                    anchor = document.createElement('a');
                    if (img) {
                        img.parentNode.insertBefore(anchor, img);
                        anchor.appendChild(img);
                    }
                }
                anchor.setAttribute('href', data.link);
                anchor.setAttribute('target', data.target);
            } else {
                if (anchor) {
                    if (img) {
                        anchor.parentNode.insertBefore(img, anchor);
                    }
                    anchor.remove();
                }
            }
        }

        this._ensureImageZoomButton(block);
    }

    _rgbToHex(rgb, fallback = '#cbd5e1') {
        if (!rgb) return fallback;
        if (rgb.startsWith('#')) return rgb;
        const match = rgb.match(/^rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*\d+(?:\.\d+)?)?\)$/);
        if (!match) return fallback;
        const r = parseInt(match[1]).toString(16).padStart(2, '0');
        const g = parseInt(match[2]).toString(16).padStart(2, '0');
        const b = parseInt(match[3]).toString(16).padStart(2, '0');
        return `#${r}${g}${b}`;
    }

    async showBorderSettingsModal(currentData = {}) {
        const { overlay, body, close, awaitResult } = this._createModal('Border Settings', 'Apply Border');

        const esc = this._escAttr.bind(this);
        const isSelected = (val, target) => val === target ? 'selected' : '';

        // Standardize padding input presets vs custom input
        const presetPaddings = ['0px', '12px', '16px', '24px', '36px'];
        let currentPadding = currentData.padding || '0px';
        let customPaddingVal = '';
        let isCustomPadding = false;

        if (currentPadding && !presetPaddings.includes(currentPadding)) {
            isCustomPadding = true;
            customPaddingVal = currentPadding;
            currentPadding = 'custom';
        }

        body.innerHTML = `
            <div class="ibe-border-preview-container">
                <div class="ibe-border-preview-box">
                    Border & Padding Preview
                </div>
            </div>
            <div class="ibe-form-row">
                <div class="ibe-form-group">
                    <label>Border Style</label>
                    <select class="ibe-form-select ibe-border-style">
                        <option value="none" ${isSelected(currentData.borderStyle, 'none')}>None</option>
                        <option value="solid" ${isSelected(currentData.borderStyle, 'solid')}>Solid</option>
                        <option value="dashed" ${isSelected(currentData.borderStyle, 'dashed')}>Dashed</option>
                        <option value="dotted" ${isSelected(currentData.borderStyle, 'dotted')}>Dotted</option>
                        <option value="double" ${isSelected(currentData.borderStyle, 'double')}>Double</option>
                    </select>
                </div>
                <div class="ibe-form-group">
                    <label>Border Width</label>
                    <select class="ibe-form-select ibe-border-width">
                        <option value="1px" ${isSelected(currentData.borderWidth, '1px')}>1px</option>
                        <option value="2px" ${isSelected(currentData.borderWidth, '2px')}>2px</option>
                        <option value="3px" ${isSelected(currentData.borderWidth, '3px')}>3px</option>
                        <option value="4px" ${isSelected(currentData.borderWidth, '4px')}>4px</option>
                        <option value="5px" ${isSelected(currentData.borderWidth, '5px')}>5px</option>
                    </select>
                </div>
            </div>
            <div class="ibe-form-row">
                <div class="ibe-form-group">
                    <label>Border Color</label>
                    <input type="color" class="ibe-form-input ibe-border-color" value="${currentData.borderColor || '#cbd5e1'}">
                </div>
                <div class="ibe-form-group">
                    <label>Rounded Border</label>
                    <select class="ibe-form-select ibe-border-radius">
                        <option value="0px" ${isSelected(currentData.borderRadius, '0px')}>None (0)</option>
                        <option value="4px" ${isSelected(currentData.borderRadius, '4px')}>Small (4px)</option>
                        <option value="8px" ${isSelected(currentData.borderRadius, '8px')}>Medium (8px)</option>
                        <option value="12px" ${isSelected(currentData.borderRadius, '12px')}>Large (12px)</option>
                        <option value="16px" ${isSelected(currentData.borderRadius, '16px')}>X-Large (16px)</option>
                        <option value="50%" ${isSelected(currentData.borderRadius, '50%')}>Round (50%)</option>
                    </select>
                </div>
            </div>
            <div class="ibe-form-group">
                <label>Block Wrapper Padding</label>
                <select class="ibe-form-select ibe-border-padding-select">
                    <option value="0px" ${isSelected(currentPadding, '0px')}>None (0)</option>
                    <option value="12px" ${isSelected(currentPadding, '12px')}>Small (12px)</option>
                    <option value="16px" ${isSelected(currentPadding, '16px')}>Standard (16px)</option>
                    <option value="24px" ${isSelected(currentPadding, '24px')}>Medium (24px)</option>
                    <option value="36px" ${isSelected(currentPadding, '36px')}>Large (36px)</option>
                    <option value="custom" ${isCustomPadding ? 'selected' : ''}>Custom Padding...</option>
                </select>
            </div>
            <div class="ibe-form-group ibe-custom-padding-group" style="${isCustomPadding ? '' : 'display:none;'}">
                <label>Custom Padding Value</label>
                <input type="text" class="ibe-form-input ibe-border-padding-custom" value="${esc(customPaddingVal)}" placeholder="e.g. 10px 20px, 1.5rem">
            </div>
        `;
        this._renderIcons(overlay);

        const styleSelect = overlay.querySelector('.ibe-border-style');
        const widthSelect = overlay.querySelector('.ibe-border-width');
        const colorInput = overlay.querySelector('.ibe-border-color');
        const radiusSelect = overlay.querySelector('.ibe-border-radius');
        const padSelect = overlay.querySelector('.ibe-border-padding-select');
        const customPaddingInput = overlay.querySelector('.ibe-border-padding-custom');
        const customGroup = overlay.querySelector('.ibe-custom-padding-group');
        const previewBox = overlay.querySelector('.ibe-border-preview-box');

        const updatePreview = () => {
            const style = styleSelect.value;
            const width = widthSelect.value;
            const color = colorInput.value;
            const radius = radiusSelect.value;
            
            let padding = padSelect.value;
            if (padding === 'custom') {
                padding = customPaddingInput.value.trim() || '0px';
            }

            if (style === 'none') {
                previewBox.style.border = 'none';
                previewBox.style.borderRadius = '0px';
                previewBox.style.padding = padding;
            } else {
                previewBox.style.border = `${width} ${style} ${color}`;
                previewBox.style.borderRadius = radius;
                previewBox.style.padding = padding;
            }
        };

        // Bind event listeners to update live preview
        styleSelect.onchange = updatePreview;
        widthSelect.onchange = updatePreview;
        colorInput.oninput = updatePreview;
        radiusSelect.onchange = updatePreview;
        padSelect.onchange = () => {
            if (padSelect.value === 'custom') {
                customGroup.style.display = '';
            } else {
                customGroup.style.display = 'none';
            }
            updatePreview();
        };
        customPaddingInput.oninput = updatePreview;

        // Initialize preview
        updatePreview();

        overlay.querySelector('.ibe-modal-save').onclick = () => {
            const style = styleSelect.value;
            const width = widthSelect.value;
            const color = colorInput.value;
            const radius = radiusSelect.value;
            
            let padding = padSelect.value;
            if (padding === 'custom') {
                padding = customPaddingInput.value.trim();
            }

            close({
                borderStyle: style,
                borderWidth: width,
                borderColor: color,
                borderRadius: radius,
                padding: padding
            });
        };

        return awaitResult();
    }

    _applyBorderSettings(block, data) {
        if (data.borderStyle === 'none') {
            block.style.border = '';
            block.style.borderRadius = '';
            block.style.padding = '';
        } else {
            block.style.border = `${data.borderWidth} ${data.borderStyle} ${data.borderColor}`;
            block.style.borderRadius = data.borderRadius;
            block.style.padding = data.padding;
        }
        this.markDirty();
    }

    // ─── Link Modal ─────────────────────────────────────────────────────

    async showLinkModal(currentData = {}) {
        const { overlay, body, close, awaitResult } = this._createModal('Link Settings', 'Apply Link');

        const esc = this._escAttr.bind(this);
        const isChecked = (val) => val ? 'checked' : '';
        const isSelected = (val, target) => val === target ? 'selected' : '';

        body.innerHTML = `
            <div class="ibe-form-group">
                <label>URL / Destination</label>
                <input type="text" class="ibe-form-input ibe-link-url" value="${esc(currentData.url)}" placeholder="https://example.com" autofocus>
            </div>
            <div class="ibe-form-group">
                <label>Link Text</label>
                <input type="text" class="ibe-form-input ibe-link-text" value="${esc(currentData.text)}" placeholder="Display text">
            </div>
            <div class="ibe-form-row">
                <div class="ibe-form-group">
                    <label>Open In</label>
                    <select class="ibe-form-select ibe-link-target">
                        <option value="_self" ${isSelected(currentData.target, '_self')}>Same Window (_self)</option>
                        <option value="_blank" ${isSelected(currentData.target, '_blank')}>New Tab (_blank)</option>
                        <option value="_parent" ${isSelected(currentData.target, '_parent')}>Parent Frame (_parent)</option>
                        <option value="_top" ${isSelected(currentData.target, '_top')}>Full Body (_top)</option>
                    </select>
                </div>
                <div class="ibe-form-group">
                    <label>Relationship (rel)</label>
                    <input type="text" class="ibe-form-input ibe-link-rel" value="${esc(currentData.rel)}" placeholder="e.g. nofollow, noopener">
                </div>
            </div>
            <div class="ibe-form-row">
                <div class="ibe-form-group">
                    <label>Link Color</label>
                    <input type="color" class="ibe-form-input ibe-link-color" value="${currentData.color || '#3b82f6'}">
                </div>
                <div class="ibe-form-group">
                    <label>Underline Style</label>
                    <select class="ibe-form-select ibe-link-underline">
                        <option value="solid" ${isSelected(currentData.underline, 'solid')}>Solid Underline</option>
                        <option value="dotted" ${isSelected(currentData.underline, 'dotted')}>Dotted Underline</option>
                        <option value="dashed" ${isSelected(currentData.underline, 'dashed')}>Dashed Underline</option>
                        <option value="none" ${isSelected(currentData.underline, 'none')}>No Underline</option>
                    </select>
                </div>
            </div>
            <div class="ibe-form-group ibe-form-checkboxes">
                <label class="ibe-checkbox-label">
                    <input type="checkbox" class="ibe-link-bold" ${isChecked(currentData.bold)}>
                    <span>Bold Text</span>
                </label>
                <label class="ibe-checkbox-label">
                    <input type="checkbox" class="ibe-link-italic" ${isChecked(currentData.italic)}>
                    <span>Italic Text</span>
                </label>
            </div>
            <div class="ibe-form-group">
                <label>Custom CSS Classes</label>
                <input type="text" class="ibe-form-input ibe-link-classes" value="${esc(currentData.customClass)}" placeholder="e.g. btn btn-primary">
            </div>
        `;
        this._renderIcons(overlay);

        overlay.querySelector('.ibe-modal-save').onclick = () => {
            close({
                url: overlay.querySelector('.ibe-link-url').value.trim(),
                text: overlay.querySelector('.ibe-link-text').value.trim(),
                target: overlay.querySelector('.ibe-link-target').value,
                rel: overlay.querySelector('.ibe-link-rel').value.trim(),
                color: overlay.querySelector('.ibe-link-color').value,
                underline: overlay.querySelector('.ibe-link-underline').value,
                bold: overlay.querySelector('.ibe-link-bold').checked,
                italic: overlay.querySelector('.ibe-link-italic').checked,
                customClass: overlay.querySelector('.ibe-link-classes').value.trim()
            });
        };

        return awaitResult();
    }

    // ─── Confirm Dialog ─────────────────────────────────────────────────

    async triggerConfirm(title, message, btnText = 'Delete', type = 'danger') {
        if (this.options.confirm) {
            return await this.options.confirm(title, message, btnText, type);
        }
        if (window.DocsUI && typeof window.DocsUI.confirm === 'function') {
            return await window.DocsUI.confirm(title, message, btnText, type);
        }
        return window.confirm(`${title}\n\n${message}`);
    }

    // ─── Block Toolbar ──────────────────────────────────────────────────

    _createBlockToolbar(block, isNew = false) {
        if (block.querySelector('.ibe-toolbar')) return;

        const toolbar = document.createElement('div');
        toolbar.className = 'ibe-toolbar no-print';
        toolbar.setAttribute('role', 'toolbar');
        toolbar.setAttribute('aria-label', 'Block editing tools');
        const type = block.dataset.type || 'p';
        const colSize = [...block.classList].find(c => c.startsWith('col-'))?.split('-')[1] || '12';

        // Left Side: Grip
        let toolsHtml = `<div class="ibe-toolbar-group"><div class="ibe-block-grip" aria-label="Drag to reorder"><i data-lucide="grip-vertical"></i></div></div>`;

        // Center: Type-specific formatting tools
        let centerHtml = '';
        if (['p', 'h2', 'h3', 'ul', 'ol', 'alert', 'table'].includes(type)) {
            centerHtml = `
                <div class="ibe-toolbar-group">
                    <button type="button" class="ibe-toolbar-btn" data-cmd="undo" title="Undo" aria-label="Undo"><i data-lucide="undo"></i></button>
                    <button type="button" class="ibe-toolbar-btn" data-cmd="redo" title="Redo" aria-label="Redo"><i data-lucide="redo"></i></button>
                    <span class="ibe-toolbar-divider"></span>
                    <button type="button" class="ibe-toolbar-btn" data-cmd="formatBlock" data-val="p" title="Paragraph" aria-label="Paragraph"><i data-lucide="type"></i></button>
                    <button type="button" class="ibe-toolbar-btn" data-cmd="formatBlock" data-val="h2" title="Heading 2" aria-label="Heading 2"><i data-lucide="heading-2"></i></button>
                    <button type="button" class="ibe-toolbar-btn" data-cmd="formatBlock" data-val="h3" title="Heading 3" aria-label="Heading 3"><i data-lucide="heading-3"></i></button>
                    <button type="button" class="ibe-toolbar-btn" data-cmd="insertUnorderedList" title="Bullet List" aria-label="Bullet List"><i data-lucide="list"></i></button>
                    <button type="button" class="ibe-toolbar-btn" data-cmd="insertOrderedList" title="Numbered List" aria-label="Numbered List"><i data-lucide="list-ordered"></i></button>
                    <span class="ibe-toolbar-divider"></span>
                    <button type="button" class="ibe-toolbar-btn" data-cmd="bold" title="Bold" aria-label="Bold"><i data-lucide="bold"></i></button>
                    <button type="button" class="ibe-toolbar-btn" data-cmd="italic" title="Italic" aria-label="Italic"><i data-lucide="italic"></i></button>
                    <button type="button" class="ibe-toolbar-btn" data-cmd="underline" title="Underline" aria-label="Underline"><i data-lucide="underline"></i></button>
                    <button type="button" class="ibe-toolbar-btn ibe-link-btn" title="Insert/Edit Link" aria-label="Insert/Edit Link"><i data-lucide="link"></i></button>
                    <div class="ibe-toolbar-btn ibe-color-picker-wrap" title="Text Color" aria-label="Text Color">
                        <i data-lucide="palette"></i>
                        <input type="color" class="ibe-color-picker" value="#475569" tabindex="-1">
                    </div>
                </div>
            `;
            if (type === 'alert' || type === 'table') {
                centerHtml += `<span class="ibe-toolbar-divider"></span>`;
            }
        }

        if (type === 'alert') {
            centerHtml += `
                <div class="ibe-toolbar-group">
                    <button type="button" class="ibe-toolbar-btn set-alert-type" data-alert-type="info" title="Info" aria-label="Info alert"><i data-lucide="info"></i></button>
                    <button type="button" class="ibe-toolbar-btn set-alert-type" data-alert-type="success" title="Success" aria-label="Success alert" style="color:#22c55e"><i data-lucide="check-circle"></i></button>
                    <button type="button" class="ibe-toolbar-btn set-alert-type" data-alert-type="warning" title="Warning" aria-label="Warning alert" style="color:#f59e0b"><i data-lucide="alert-triangle"></i></button>
                    <button type="button" class="ibe-toolbar-btn set-alert-type" data-alert-type="danger" title="Danger" aria-label="Danger alert" style="color:#ef4444"><i data-lucide="alert-octagon"></i></button>
                </div>
            `;
        } else if (type === 'image') {
            centerHtml = `
                <div class="ibe-toolbar-group">
                    <button type="button" class="ibe-toolbar-btn open-img-settings" title="Image Settings" aria-label="Image Settings"><i data-lucide="sliders"></i></button>
                </div>
            `;
        } else if (type === 'video') {
            const iframe = block.querySelector('iframe');
            const fig = block.querySelector('figcaption');
            const vidUrlId = this._randomId('vid-url');
            const vidCapId = this._randomId('vid-caption');
            centerHtml = `
                <div class="ibe-toolbar-group">
                    <input type="text" id="${vidUrlId}" name="vid_url_val" class="ibe-toolbar-input vid-url-val" placeholder="Embed URL (YouTube/Vimeo)" value="${this._escAttr(iframe ? iframe.getAttribute('src') : '')}" style="width: 220px;">
                    <input type="text" id="${vidCapId}" name="vid_caption_val" class="ibe-toolbar-input vid-caption-val" placeholder="Caption" value="${this._escAttr(fig ? fig.innerText : '')}" style="width: 120px;">
                    <button type="button" class="ibe-toolbar-btn apply-vid-all" title="Apply" aria-label="Apply video settings"><i data-lucide="check"></i></button>
                </div>
            `;
        } else if (type === 'code') {
            const codeEl = block.querySelector('code');
            let currentLang = 'javascript';
            if (codeEl) {
                for (const cls of codeEl.classList) {
                    if (cls.startsWith('language-')) {
                        currentLang = cls.replace('language-', '');
                        break;
                    }
                }
            }
            const codeLangId = this._randomId('code-lang');
            centerHtml = `
                <div class="ibe-toolbar-group">
                    <select id="${codeLangId}" name="code_lang_select" class="ibe-toolbar-input ibe-toolbar-select code-lang-select" title="Language">
                        <option value="javascript" ${currentLang === 'javascript' ? 'selected' : ''}>JavaScript</option>
                        <option value="html" ${currentLang === 'html' ? 'selected' : ''}>HTML</option>
                        <option value="css" ${currentLang === 'css' ? 'selected' : ''}>CSS</option>
                        <option value="php" ${currentLang === 'php' ? 'selected' : ''}>PHP</option>
                        <option value="python" ${currentLang === 'python' ? 'selected' : ''}>Python</option>
                        <option value="java" ${currentLang === 'java' ? 'selected' : ''}>Java</option>
                        <option value="cpp" ${currentLang === 'cpp' ? 'selected' : ''}>C++</option>
                        <option value="sql" ${currentLang === 'sql' ? 'selected' : ''}>SQL</option>
                        <option value="bash" ${currentLang === 'bash' ? 'selected' : ''}>Bash</option>
                        <option value="json" ${currentLang === 'json' ? 'selected' : ''}>JSON</option>
                    </select>
                    <button type="button" class="ibe-toolbar-btn toggle-code-editor" title="Toggle Edit Code" aria-label="Toggle code editor"><i data-lucide="edit-3"></i></button>
                </div>
            `;
        } else if (type === 'table') {
            const wrapper = block.querySelector('.ibe-table-wrapper');
            const isBordered = wrapper?.classList.contains('bordered') || false;
            const isStriped = wrapper?.classList.contains('striped') || false;

            centerHtml = `
                <div class="ibe-toolbar-group">
                    <button type="button" class="ibe-toolbar-btn add-table-row" title="Add Row" aria-label="Add table row"><i data-lucide="plus"></i></button>
                    <button type="button" class="ibe-toolbar-btn delete-table-row" title="Delete Row" aria-label="Delete table row"><i data-lucide="minus"></i></button>
                    <button type="button" class="ibe-toolbar-btn add-table-col" title="Add Column" aria-label="Add table column"><i data-lucide="plus-circle"></i></button>
                    <button type="button" class="ibe-toolbar-btn delete-table-col" title="Delete Column" aria-label="Delete table column"><i data-lucide="minus-circle"></i></button>
                    <span class="ibe-toolbar-divider"></span>
                    <button type="button" class="ibe-toolbar-btn toggle-table-bordered ${isBordered ? 'active' : ''}" title="Bordered Table" aria-label="Toggle bordered table"><i data-lucide="grid"></i></button>
                    <button type="button" class="ibe-toolbar-btn toggle-table-striped ${isStriped ? 'active' : ''}" title="Striped Rows" aria-label="Toggle striped rows"><i data-lucide="rows"></i></button>
                </div>
            `;
        } else if (type === 'hr') {
            const hr = block.querySelector('hr.ibe-hr');
            let currentStyle = 'solid';
            if (hr) {
                if (hr.classList.contains('ibe-hr-dashed')) currentStyle = 'dashed';
                else if (hr.classList.contains('ibe-hr-dotted')) currentStyle = 'dotted';
                else if (hr.classList.contains('ibe-hr-double')) currentStyle = 'double';
            }
            let currentWidth = 'full';
            if (hr) {
                if (hr.classList.contains('ibe-hr-medium')) currentWidth = 'medium';
                else if (hr.classList.contains('ibe-hr-short')) currentWidth = 'short';
            }
            const hrStyleId = this._randomId('hr-style');
            const hrWidthId = this._randomId('hr-width');
            centerHtml = `
                <div class="ibe-toolbar-group">
                    <select id="${hrStyleId}" name="hr_style_select" class="ibe-toolbar-input ibe-toolbar-select hr-style-select" title="Line Style">
                        <option value="solid" ${currentStyle === 'solid' ? 'selected' : ''}>Solid</option>
                        <option value="dashed" ${currentStyle === 'dashed' ? 'selected' : ''}>Dashed</option>
                        <option value="dotted" ${currentStyle === 'dotted' ? 'selected' : ''}>Dotted</option>
                        <option value="double" ${currentStyle === 'double' ? 'selected' : ''}>Double</option>
                    </select>
                    <select id="${hrWidthId}" name="hr_width_select" class="ibe-toolbar-input ibe-toolbar-select hr-width-select" title="Line Width">
                        <option value="full" ${currentWidth === 'full' ? 'selected' : ''}>Full Width</option>
                        <option value="medium" ${currentWidth === 'medium' ? 'selected' : ''}>Medium (50%)</option>
                        <option value="short" ${currentWidth === 'short' ? 'selected' : ''}>Short (25%)</option>
                    </select>
                </div>
            `;
        } else if (type === 'html') {
            centerHtml = '';
        }

        const alignCenter = block.classList.contains('block-align-center');
        const alignRight = block.classList.contains('block-align-right');
        const alignLeft = !alignCenter && !alignRight;
        const colSizeId = this._randomId('col-size');

        // Right Side: Layout & Delete
        let rightHtml = `
            <div class="ibe-toolbar-group">
                <div class="ibe-align-dropdown" title="Align Block">
                    <div class="ibe-align-dropdown-options">
                        <button type="button" class="ibe-toolbar-btn align-block-btn ${alignLeft ? 'active' : ''}" data-align="left" title="Align Left" aria-label="Align left"><i data-lucide="align-left"></i></button>
                        <button type="button" class="ibe-toolbar-btn align-block-btn ${alignCenter ? 'active' : ''}" data-align="center" title="Align Center" aria-label="Align center"><i data-lucide="align-center"></i></button>
                        <button type="button" class="ibe-toolbar-btn align-block-btn ${alignRight ? 'active' : ''}" data-align="right" title="Align Right" aria-label="Align right"><i data-lucide="align-right"></i></button>
                    </div>
                </div>
                <span class="ibe-toolbar-divider"></span>
                <select id="${colSizeId}" name="col_size_select" class="ibe-toolbar-input ibe-toolbar-select col-size-select" title="Block Width">
                    <option value="3" ${colSize == 3 ? 'selected' : ''}>1/4</option>
                    <option value="4" ${colSize == 4 ? 'selected' : ''}>1/3</option>
                    <option value="6" ${colSize == 6 ? 'selected' : ''}>1/2</option>
                    <option value="8" ${colSize == 8 ? 'selected' : ''}>2/3</option>
                    <option value="9" ${colSize == 9 ? 'selected' : ''}>3/4</option>
                    <option value="12" ${colSize == 12 ? 'selected' : ''}>1/1</option>
                </select>
                <span class="ibe-toolbar-divider"></span>
                <button type="button" class="ibe-toolbar-btn toggle-block-html" title="Toggle HTML View" aria-label="Toggle HTML view"><i data-lucide="code"></i></button>
                <span class="ibe-toolbar-divider"></span>
                <div class="ibe-more-dropdown" title="More Options">
                    <button type="button" class="ibe-toolbar-btn ibe-more-btn" aria-label="More options"><i data-lucide="more-vertical"></i></button>
                    <div class="ibe-more-options">
                        <button type="button" class="ibe-toolbar-btn ibe-more-dummy" aria-label="More options" style="pointer-events: none;"><i data-lucide="more-vertical"></i></button>
                        <button type="button" class="ibe-toolbar-btn duplicate-block" title="Duplicate Block" aria-label="Duplicate block"><i data-lucide="copy"></i></button>
                        <button type="button" class="ibe-toolbar-btn open-border-settings" title="Border Settings" aria-label="Border settings"><i data-lucide="square"></i></button>
                        ${['p', 'h2', 'h3', 'ul', 'ol', 'alert', 'table'].includes(type) ? '<button type="button" class="ibe-toolbar-btn reset-text-format" title="Clear Formatting" aria-label="Clear formatting"><i data-lucide="eraser"></i></button>' : ''}
                        <button type="button" class="ibe-toolbar-btn delete-block" title="Delete Block" aria-label="Delete block" style="color:#ef4444"><i data-lucide="trash-2"></i></button>
                    </div>
                </div>
            </div>
        `;

        toolbar.innerHTML = toolsHtml + centerHtml + rightHtml;
        block.appendChild(toolbar);
        this._renderIcons(toolbar);

        // ── Bind formatting actions ──
        toolbar.querySelectorAll('.ibe-toolbar-btn[data-cmd]').forEach(btn => {
            btn.onmousedown = (e) => {
                e.preventDefault();
                const cmd = btn.dataset.cmd;
                const val = btn.dataset.val || null;
                document.execCommand(cmd, false, val);
                this.markDirty();
            };
        });

        // ── Link Button ──
        const linkBtn = toolbar.querySelector('.ibe-link-btn');
        if (linkBtn) {
            linkBtn.onmousedown = async (e) => {
                e.preventDefault();
                const selection = window.getSelection();
                let savedRange = null;
                if (selection.rangeCount > 0) {
                    savedRange = selection.getRangeAt(0).cloneRange();
                }

                let parentElement = savedRange ? savedRange.commonAncestorContainer : null;
                if (parentElement && parentElement.nodeType === Node.TEXT_NODE) {
                    parentElement = parentElement.parentNode;
                }

                const linkEl = parentElement ? parentElement.closest('a') : null;
                const currentData = {
                    url: linkEl ? linkEl.getAttribute('href') : '',
                    text: linkEl ? linkEl.textContent : (savedRange ? savedRange.toString() : ''),
                    target: linkEl ? (linkEl.getAttribute('target') || '_self') : '_self',
                    rel: linkEl ? (linkEl.getAttribute('rel') || '') : '',
                    underline: linkEl ? (linkEl.style.textDecorationStyle || (linkEl.style.textDecorationLine === 'none' ? 'none' : 'solid')) : 'solid',
                    bold: linkEl ? (linkEl.style.fontWeight === 'bold' || linkEl.style.fontWeight === '700') : false,
                    italic: linkEl ? (linkEl.style.fontStyle === 'italic') : false,
                    color: linkEl ? (linkEl.style.color || '') : '',
                    customClass: linkEl ? (linkEl.className || '') : ''
                };

                const result = await this.showLinkModal(currentData);
                if (!result) return;

                const applyLinkAttrs = (a, data) => {
                    a.setAttribute('href', data.url);
                    if (data.target && data.target !== '_self') {
                        a.setAttribute('target', data.target);
                    } else {
                        a.removeAttribute('target');
                    }
                    if (data.rel) {
                        a.setAttribute('rel', data.rel);
                    } else {
                        a.removeAttribute('rel');
                    }
                    if (data.color) {
                        a.style.color = data.color;
                    }
                    if (data.underline === 'none') {
                        a.style.textDecorationLine = 'none';
                    } else {
                        a.style.textDecorationLine = 'underline';
                        a.style.textDecorationStyle = data.underline || 'solid';
                    }
                    a.style.fontWeight = data.bold ? 'bold' : '';
                    a.style.fontStyle = data.italic ? 'italic' : '';
                    if (data.customClass) {
                        a.className = data.customClass;
                    } else {
                        a.removeAttribute('class');
                    }
                };

                // Focus contenteditable, then restore selection
                const contentEditableEl = block.querySelector('[contenteditable="true"]');
                if (contentEditableEl) {
                    contentEditableEl.focus();
                }
                if (savedRange) {
                    const sel = window.getSelection();
                    sel.removeAllRanges();
                    sel.addRange(savedRange);
                }

                if (result.url.trim() === '') {
                    // Remove link
                    if (linkEl) {
                        const parent = linkEl.parentNode;
                        while (linkEl.firstChild) {
                            parent.insertBefore(linkEl.firstChild, linkEl);
                        }
                        parent.removeChild(linkEl);
                    }
                    this.markDirty();
                } else if (linkEl) {
                    // Update existing link
                    applyLinkAttrs(linkEl, result);
                    if (result.text) {
                        linkEl.textContent = result.text;
                    }
                    this.markDirty();
                } else {
                    // Create new link
                    const a = document.createElement('a');
                    applyLinkAttrs(a, result);

                    if (savedRange && !savedRange.collapsed) {
                        const fragment = savedRange.extractContents();
                        a.appendChild(fragment);
                        savedRange.insertNode(a);
                    } else {
                        a.textContent = result.text || result.url;
                        if (savedRange) {
                            savedRange.insertNode(a);
                        } else if (contentEditableEl) {
                            contentEditableEl.appendChild(a);
                        }
                    }
                    this.markDirty();
                }
            };
        }

        // ── Color Picker ──
        const colorPicker = toolbar.querySelector('.ibe-color-picker');
        if (colorPicker) {
            colorPicker.oninput = (e) => {
                document.execCommand('styleWithCSS', false, true);
                document.execCommand('foreColor', false, e.target.value);
            };
            colorPicker.onchange = () => {
                this.markDirty();
            };
        }

        // ── Clear Formatting ──
        const resetFormatBtn = toolbar.querySelector('.reset-text-format');
        if (resetFormatBtn) {
            resetFormatBtn.onmousedown = async (e) => {
                e.preventDefault();
                const content = block.querySelector('.ibe-block-content');
                if (content) {
                    const confirmed = await this.triggerConfirm('Clear Block Formatting', 'Are you sure you want to remove all formatting from this block?', 'Clear Formatting', 'warning');
                    if (!confirmed) return;

                    const cleanNode = (node) => {
                        if (node.nodeType === Node.TEXT_NODE) return;
                        const children = Array.from(node.childNodes);
                        children.forEach(cleanNode);

                        if (node.nodeType === Node.ELEMENT_NODE) {
                            const inlineFormattingTags = ['SPAN', 'STRONG', 'B', 'EM', 'I', 'U', 'FONT', 'MARK'];
                            if (inlineFormattingTags.includes(node.tagName)) {
                                const parent = node.parentNode;
                                if (parent) {
                                    while (node.firstChild) {
                                        parent.insertBefore(node.firstChild, node);
                                    }
                                    parent.removeChild(node);
                                }
                            } else {
                                const allowedAttrs = {
                                    'A': ['href', 'target', 'title'],
                                    'IMG': ['src', 'alt', 'title', 'class'],
                                    'IFRAME': ['src', 'frameborder', 'allowfullscreen']
                                };
                                const allowed = allowedAttrs[node.tagName] || [];
                                const attrs = Array.from(node.attributes);
                                attrs.forEach(attr => {
                                    if (!allowed.includes(attr.name)) {
                                        node.removeAttribute(attr.name);
                                    }
                                });
                            }
                        }
                    };

                    cleanNode(content);
                    this.markDirty();
                }
            };
        }

        // ── Alert Type Buttons ──
        toolbar.querySelectorAll('.set-alert-type').forEach(btn => {
            btn.onclick = (e) => {
                e.stopPropagation();
                const box = block.querySelector('.alert-box');
                if (!box) return;
                const icon = box.querySelector('i, svg');
                const atype = btn.dataset.alertType;
                box.className = `alert-box ${atype}`;

                let iconName = 'info';
                if (atype === 'success') iconName = 'check-circle';
                if (atype === 'warning') iconName = 'alert-triangle';
                if (atype === 'danger') iconName = 'alert-octagon';

                if (icon) {
                    icon.setAttribute('data-lucide', iconName);
                    this._renderIcons(box);
                }
                this.markDirty();
            };
        });

        // ── Image Settings Button ──
        const openImgSettingsBtn = toolbar.querySelector('.open-img-settings');
        if (openImgSettingsBtn) {
            openImgSettingsBtn.onclick = async (e) => {
                e.stopPropagation();

                const figOuter = block.querySelector('.article-image');
                const img = block.querySelector('img');
                const fig = block.querySelector('figcaption');
                const anchor = block.querySelector('.ibe-block-content > figure > a') || block.querySelector('.ibe-block-content a');

                const currentData = {
                    url: img ? img.getAttribute('src') : '',
                    alt: img ? img.getAttribute('alt') || '' : '',
                    caption: (fig && fig.style.display !== 'none') ? fig.innerText : '',
                    link: anchor ? anchor.getAttribute('href') : '',
                    target: anchor ? (anchor.getAttribute('target') || '_self') : '_self',
                    height: img ? img.style.height || img.getAttribute('height') || '' : '',
                    aspect: (figOuter && figOuter.classList.contains('aspect-original')) ? 'original' : 'strict',
                    zoom: (figOuter && figOuter.getAttribute('data-zoom') === 'false') ? false : true
                };

                const result = await this.showImageSettingsModal(currentData);
                if (!result) return;

                this._applyImageSettings(block, result);
                this.markDirty();
            };
        }

        // ── Video Apply Button ──
        const applyVidBtn = toolbar.querySelector('.apply-vid-all');
        if (applyVidBtn) {
            applyVidBtn.onclick = (e) => {
                e.stopPropagation();
                const iframe = block.querySelector('iframe');
                const fig = block.querySelector('figcaption');
                let url = toolbar.querySelector('.vid-url-val').value;

                if (url.includes('youtube.com/watch?v=')) {
                    url = url.replace('watch?v=', 'embed/');
                } else if (url.includes('youtu.be/')) {
                    url = url.replace('youtu.be/', 'youtube.com/embed/');
                } else if (url.includes('vimeo.com/') && !url.includes('player.vimeo.com')) {
                    url = url.replace('vimeo.com/', 'player.vimeo.com/video/');
                }

                if (iframe) iframe.setAttribute('src', url);
                if (fig) fig.innerText = toolbar.querySelector('.vid-caption-val').value;
                this.exitEditMode(block);
                this.markDirty();
            };
        }

        // ── Divider Block Handlers ──
        const hrStyleSelect = toolbar.querySelector('.hr-style-select');
        if (hrStyleSelect) {
            hrStyleSelect.onchange = (e) => {
                const hr = block.querySelector('hr.ibe-hr');
                if (hr) {
                    hr.classList.remove('ibe-hr-solid', 'ibe-hr-dashed', 'ibe-hr-dotted', 'ibe-hr-double');
                    hr.classList.add(`ibe-hr-${e.target.value}`);
                    this.markDirty();
                }
            };
        }

        const hrWidthSelect = toolbar.querySelector('.hr-width-select');
        if (hrWidthSelect) {
            hrWidthSelect.onchange = (e) => {
                const hr = block.querySelector('hr.ibe-hr');
                if (hr) {
                    hr.classList.remove('ibe-hr-full', 'ibe-hr-medium', 'ibe-hr-short');
                    hr.classList.add(`ibe-hr-${e.target.value}`);
                    this.markDirty();
                }
            };
        }

        // ── Code Block Handlers ──
        const langSelect = toolbar.querySelector('.code-lang-select');
        if (langSelect) {
            langSelect.onchange = (e) => {
                const codeEl = block.querySelector('code');
                if (codeEl) {
                    codeEl.className = '';
                    codeEl.classList.add(`language-${e.target.value}`);
                    if (window.hljs) {
                        codeEl.removeAttribute('data-highlighted');
                        window.hljs.highlightElement(codeEl);
                    }
                    this.markDirty();
                }
            };
        }

        const toggleCodeBtn = toolbar.querySelector('.toggle-code-editor');
        if (toggleCodeBtn) {
            toggleCodeBtn.onclick = (e) => {
                e.stopPropagation();
                const codeEl = block.querySelector('code');
                const preview = block.querySelector('pre');
                let textarea = block.querySelector('.ibe-code-textarea');
                if (!textarea) {
                    const wrapper = block.querySelector('.ibe-code-block');
                    if (wrapper) {
                        const textareaId = this._randomId('code-editor');
                        textarea = document.createElement('textarea');
                        textarea.id = textareaId;
                        textarea.name = 'code_editor_raw';
                        textarea.className = 'ibe-code-textarea no-print';
                        textarea.style.display = 'none';
                        wrapper.appendChild(textarea);
                    }
                }
                if (!textarea) return;

                if (textarea.style.display === 'none') {
                    textarea.value = codeEl ? codeEl.textContent : '';
                    textarea.style.display = 'block';
                    if (preview) preview.style.display = 'none';
                    textarea.focus();
                    toggleCodeBtn.innerHTML = '<i data-lucide="eye"></i>';
                } else {
                    if (codeEl) {
                        codeEl.textContent = textarea.value;
                        if (window.hljs) {
                            codeEl.removeAttribute('data-highlighted');
                            window.hljs.highlightElement(codeEl);
                        }
                    }
                    textarea.style.display = 'none';
                    if (preview) preview.style.display = 'block';
                    toggleCodeBtn.innerHTML = '<i data-lucide="edit-3"></i>';
                    this.markDirty();
                }
                this._renderIcons(toggleCodeBtn);
            };
        }

        // ── Table Handlers ──
        const addRowBtn = toolbar.querySelector('.add-table-row');
        if (addRowBtn) {
            addRowBtn.onclick = (e) => {
                e.stopPropagation();
                const table = block.querySelector('table');
                if (table) {
                    const tbody = table.querySelector('tbody') || table;
                    const lastRow = tbody.querySelector('tr:last-child') || table.querySelector('tr:last-child');
                    const numCols = lastRow ? lastRow.cells.length : 2;

                    const newRow = document.createElement('tr');
                    for (let i = 0; i < numCols; i++) {
                        const cell = document.createElement('td');
                        cell.innerHTML = 'Cell';
                        cell.contentEditable = "true";
                        newRow.appendChild(cell);
                    }
                    tbody.appendChild(newRow);
                    this.markDirty();
                }
            };
        }

        const deleteRowBtn = toolbar.querySelector('.delete-table-row');
        if (deleteRowBtn) {
            deleteRowBtn.onclick = (e) => {
                e.stopPropagation();
                const table = block.querySelector('table');
                if (table) {
                    const rows = table.querySelectorAll('tbody tr');
                    if (rows.length > 0) {
                        rows[rows.length - 1].remove();
                        this.markDirty();
                    }
                }
            };
        }

        const addColBtn = toolbar.querySelector('.add-table-col');
        if (addColBtn) {
            addColBtn.onclick = (e) => {
                e.stopPropagation();
                const table = block.querySelector('table');
                if (table) {
                    const trs = table.querySelectorAll('tr');
                    trs.forEach((tr) => {
                        const isHeader = tr.querySelector('th') !== null;
                        const cell = document.createElement(isHeader ? 'th' : 'td');
                        cell.innerHTML = isHeader ? 'Header' : 'Cell';
                        cell.contentEditable = "true";
                        tr.appendChild(cell);
                    });
                    this.markDirty();
                }
            };
        }

        const deleteColBtn = toolbar.querySelector('.delete-table-col');
        if (deleteColBtn) {
            deleteColBtn.onclick = (e) => {
                e.stopPropagation();
                const table = block.querySelector('table');
                if (table) {
                    const trs = table.querySelectorAll('tr');
                    if (trs.length > 0 && trs[0].cells.length > 1) {
                        trs.forEach(tr => {
                            if (tr.cells.length > 0) {
                                tr.cells[tr.cells.length - 1].remove();
                            }
                        });
                        this.markDirty();
                    }
                }
            };
        }

        const toggleBorderedBtn = toolbar.querySelector('.toggle-table-bordered');
        if (toggleBorderedBtn) {
            toggleBorderedBtn.onclick = (e) => {
                e.stopPropagation();
                const wrapper = block.querySelector('.ibe-table-wrapper');
                if (wrapper) {
                    wrapper.classList.toggle('bordered');
                    toggleBorderedBtn.classList.toggle('active');
                    this.markDirty();
                }
            };
        }

        const toggleStripedBtn = toolbar.querySelector('.toggle-table-striped');
        if (toggleStripedBtn) {
            toggleStripedBtn.onclick = (e) => {
                e.stopPropagation();
                const wrapper = block.querySelector('.ibe-table-wrapper');
                if (wrapper) {
                    wrapper.classList.toggle('striped');
                    toggleStripedBtn.classList.toggle('active');
                    this.markDirty();
                }
            };
        }

        // ── Alignment Buttons ──
        toolbar.querySelectorAll('.align-block-btn').forEach(btn => {
            btn.onclick = (e) => {
                e.stopPropagation();
                const align = btn.dataset.align;
                const alignClass = `block-align-${align}`;

                block.classList.remove('block-align-left', 'block-align-center', 'block-align-right');
                toolbar.querySelectorAll('.align-block-btn').forEach(b => b.classList.remove('active'));

                block.classList.add(alignClass);
                btn.classList.add('active');

                this.markDirty();
            };
        });

        // ── Column Size Select ──
        const colSizeSelect = toolbar.querySelector('.col-size-select');
        if (colSizeSelect) {
            colSizeSelect.onchange = (e) => {
                block.classList.forEach(cls => {
                    if (cls.startsWith('col-')) block.classList.remove(cls);
                });
                block.classList.add(`col-${e.target.value}`);
                this.markDirty();
            };
        }

        // ── Delete Block ──
        const deleteBtn = toolbar.querySelector('.delete-block');
        if (deleteBtn) {
            deleteBtn.onclick = async (e) => {
                e.stopPropagation();
                const confirmed = await this.triggerConfirm('Delete Block', 'Are you sure you want to permanently delete this block?', 'Delete Now', 'danger');
                if (confirmed) {
                    const sep = block.nextElementSibling;
                    if (sep && sep.classList.contains('ibe-separator')) sep.remove();
                    block.remove();
                    this.markDirty();
                    this._emit('block:delete', { type });
                }
            };
        }

        // ── Duplicate Block ──
        const duplicateBtn = toolbar.querySelector('.duplicate-block');
        if (duplicateBtn) {
            duplicateBtn.onclick = (e) => {
                e.stopPropagation();
                this.duplicateBlock(block);
            };
        }

        // ── Border Settings ──
        const borderSettingsBtn = toolbar.querySelector('.open-border-settings');
        if (borderSettingsBtn) {
            borderSettingsBtn.onclick = async (e) => {
                e.stopPropagation();
                
                const currentData = {
                    borderStyle: block.style.borderStyle || 'solid',
                    borderWidth: block.style.borderWidth || '1px',
                    borderColor: this._rgbToHex(block.style.borderColor, '#cbd5e1'),
                    borderRadius: block.style.borderRadius || '8px',
                    padding: block.style.padding || '16px'
                };

                const result = await this.showBorderSettingsModal(currentData);
                if (!result) return;

                this._applyBorderSettings(block, result);
            };
        }

        // ── Toggle Block HTML View ──
        const toggleBlockHtmlBtn = toolbar.querySelector('.toggle-block-html');
        if (toggleBlockHtmlBtn) {
            toggleBlockHtmlBtn.onclick = (e) => {
                if (e) e.stopPropagation();
                const blockType = block.dataset.type;
                const innerContent = blockType === 'alert' ? block.querySelector('.alert-txt') : block.querySelector('.ibe-block-content');
                if (!innerContent) return;

                let htmlTextarea = block.querySelector('.ibe-html-textarea');
                if (!htmlTextarea) {
                    htmlTextarea = document.createElement('textarea');
                    htmlTextarea.id = this._randomId('block-html');
                    htmlTextarea.name = 'ibe_html_textarea';
                    htmlTextarea.className = 'ibe-html-textarea no-print';
                    htmlTextarea.style.display = 'none';
                    block.appendChild(htmlTextarea);
                }

                if (htmlTextarea.style.display === 'none') {
                    let targetContainer = innerContent;
                    if (blockType === 'html') {
                        targetContainer = block.querySelector('.html-preview') || innerContent;
                    }
                    htmlTextarea.value = targetContainer.innerHTML;
                    htmlTextarea.style.display = 'block';
                    innerContent.style.display = 'none';
                    htmlTextarea.focus();
                    toggleBlockHtmlBtn.innerHTML = '<i data-lucide="eye"></i>';
                } else {
                    let targetContainer = innerContent;
                    if (blockType === 'html') {
                        targetContainer = block.querySelector('.html-preview') || innerContent;
                    }
                    targetContainer.innerHTML = htmlTextarea.value;
                    htmlTextarea.style.display = 'none';
                    innerContent.style.display = 'block';
                    toggleBlockHtmlBtn.innerHTML = '<i data-lucide="code"></i>';
                    this.markDirty();
                }
                this._renderIcons(toggleBlockHtmlBtn);
            };

            if (type === 'html' && isNew) {
                toggleBlockHtmlBtn.onclick();
            }
        }
    }

    /**
     * Duplicate an existing block and insert it below.
     * @param {HTMLElement} block The block element to duplicate
     */
    duplicateBlock(block) {
        if (this._guardDestroyed('duplicateBlock')) return;

        const wasEditing = block.classList.contains('is-editing');
        if (wasEditing) {
            this.exitEditMode(block);
        }

        // Clone the block node
        const clone = block.cloneNode(true);

        // Remove all editor UI artifacts from clone
        clone.querySelectorAll('.ibe-toolbar, .ibe-separator, .html-editor-raw, .ibe-html-textarea, .ibe-code-textarea, .ibe-img-zoom-btn').forEach(el => el.remove());
        clone.classList.remove('is-editing');

        // Reset contenteditable states
        const content = clone.querySelector('.ibe-block-content');
        if (content) {
            content.removeAttribute('contenteditable');
            if (content.style.display === 'none') content.style.display = '';
        }
        const txt = clone.querySelector('.alert-txt');
        if (txt) {
            txt.removeAttribute('contenteditable');
        }
        const preview = clone.querySelector('.html-preview');
        if (preview && preview.style.display === 'none') preview.style.display = 'block';

        const codePre = clone.querySelector('.ibe-code-block pre');
        if (codePre && codePre.style.display === 'none') codePre.style.display = '';

        clone.querySelectorAll('th, td').forEach(cell => {
            cell.removeAttribute('contenteditable');
        });

        // Insert clone after the original block's following separator
        const nextSep = block.nextElementSibling;
        if (nextSep && nextSep.classList.contains('ibe-separator')) {
            nextSep.after(clone);
        } else {
            block.after(clone);
        }

        // Initialize editor features on the clone
        this._createControls(clone, true);
        this._createSeparator(clone);

        if (wasEditing) {
            this.enterEditMode(block);
        }

        this.markDirty();
        const type = clone.dataset.type;
        this._emit('block:add', { type, block: clone });
        this.showToast('Block duplicated.');
    }

    // ─── Edit Mode Management ───────────────────────────────────────────

    enterEditMode(block) {
        if (this._guardDestroyed('enterEditMode')) return;
        if (this.isPreviewMode) return;
        if (block.classList.contains('is-editing')) return;
        this.container.querySelectorAll('.ibe-block.is-editing').forEach(b => this.exitEditMode(b));

        block.classList.add('is-editing');
        const type = block.dataset.type;
        const content = block.querySelector('.ibe-block-content');

        if (type === 'alert') {
            const txt = block.querySelector('.alert-txt');
            if (txt) {
                txt.contentEditable = "true";
                txt.focus();
            }
        } else if (['p', 'h2', 'h3', 'ul', 'ol'].includes(type)) {
            if (content) {
                content.contentEditable = "true";
                content.focus();
            }
        } else if (type === 'code') {
            const preview = block.querySelector('pre');
            const codeEl = block.querySelector('code');
            const textarea = block.querySelector('.ibe-code-textarea');
            const toggleBtn = block.querySelector('.toggle-code-editor');
            if (textarea && textarea.style.display === 'none') {
                textarea.value = codeEl ? codeEl.textContent : '';
                textarea.style.display = 'block';
                if (preview) preview.style.display = 'none';
                textarea.focus();
                if (toggleBtn) toggleBtn.innerHTML = '<i data-lucide="eye"></i>';
                this._renderIcons(toggleBtn);
            }
        } else if (type === 'table') {
            block.querySelectorAll('th, td').forEach(cell => {
                cell.contentEditable = "true";
            });
        } else if (type === 'html') {
            const preview = block.querySelector('.html-preview');
            const textarea = block.querySelector('.html-editor-raw');
            if (textarea && textarea.style.display === 'none') {
                textarea.value = preview ? preview.innerHTML : '';
                textarea.style.display = 'block';
                if (preview) preview.style.display = 'none';
                textarea.focus();
            }
        }
    }

    exitEditMode(block) {
        if (!block.classList.contains('is-editing')) return;
        block.classList.remove('is-editing');
        const type = block.dataset.type;
        const content = block.querySelector('.ibe-block-content');

        if (type === 'alert') {
            const txt = block.querySelector('.alert-txt');
            if (txt) txt.contentEditable = "false";
        } else if (['p', 'h2', 'h3', 'ul', 'ol'].includes(type)) {
            if (content) content.contentEditable = "false";
        } else if (type === 'code') {
            const preview = block.querySelector('pre');
            const codeEl = block.querySelector('code');
            const textarea = block.querySelector('.ibe-code-textarea');
            const toggleBtn = block.querySelector('.toggle-code-editor');
            if (textarea && textarea.style.display !== 'none') {
                if (codeEl) {
                    codeEl.textContent = textarea.value;
                    if (window.hljs) {
                        codeEl.removeAttribute('data-highlighted');
                        window.hljs.highlightElement(codeEl);
                    }
                }
                textarea.style.display = 'none';
                if (preview) preview.style.display = 'block';
                if (toggleBtn) toggleBtn.innerHTML = '<i data-lucide="edit-3"></i>';
                this._renderIcons(toggleBtn);
            }
        } else if (type === 'table') {
            block.querySelectorAll('th, td').forEach(cell => {
                cell.removeAttribute('contenteditable');
            });
        } else if (type === 'html') {
            const preview = block.querySelector('.html-preview');
            const textarea = block.querySelector('.html-editor-raw');
            if (textarea && textarea.style.display !== 'none') {
                if (preview) {
                    preview.innerHTML = textarea.value;
                }
                textarea.style.display = 'none';
                if (preview) preview.style.display = 'block';
                this.markDirty();
            }
        }

        // Handle any open HTML code view textarea
        const htmlTextarea = block.querySelector('.ibe-html-textarea');
        if (htmlTextarea && htmlTextarea.style.display !== 'none') {
            const innerContent = type === 'alert' ? block.querySelector('.alert-txt') : block.querySelector('.ibe-block-content');
            if (innerContent) {
                let targetContainer = innerContent;
                if (type === 'html') {
                    targetContainer = block.querySelector('.html-preview') || innerContent;
                }
                if (targetContainer) {
                    targetContainer.innerHTML = htmlTextarea.value;
                }
                innerContent.style.display = '';
            }
            htmlTextarea.style.display = 'none';
            const htmlBtn = block.querySelector('.toggle-block-html');
            if (htmlBtn) {
                htmlBtn.innerHTML = '<i data-lucide="code"></i>';
                this._renderIcons(htmlBtn);
            }
        }
    }

    // ─── Public API ─────────────────────────────────────────────────────

    /**
     * Reset editor to a single empty paragraph block.
     */
    clear() {
        if (this._guardDestroyed('clear')) return;
        this.container.innerHTML = '';
        this._migrateToBlocks();
        this.container.querySelectorAll('.ibe-block').forEach(b => {
            this._createControls(b);
        });
        this._reorganizeSeparators();
        this.markDirty();
    }

    /**
     * Get clean HTML output (no editor artifacts).
     * @returns {string} Clean HTML string
     */
    getContent() {
        if (this._guardDestroyed('getContent')) return '';

        // Exit all editing blocks first
        this.container.querySelectorAll('.ibe-block.is-editing').forEach(b => this.exitEditMode(b));

        const temp = this.container.cloneNode(true);

        // Remove all editor UI elements
        temp.querySelectorAll('.ibe-toolbar, .ibe-separator, .html-editor-raw, .ibe-html-textarea, .ibe-code-textarea, .ibe-img-zoom-btn').forEach(el => el.remove());

        temp.querySelectorAll('.ibe-block').forEach(b => {
            b.classList.remove('is-editing');
            b.classList.remove('article-block');
            b.classList.add('ibe-block');

            const c = b.querySelector('.ibe-block-content');
            if (c) {
                c.removeAttribute('contenteditable');
                c.classList.remove('block-content');
                if (c.style.display === 'none') c.style.display = '';
            }
            const txt = b.querySelector('.alert-txt');
            if (txt) txt.removeAttribute('contenteditable');
            const preview = b.querySelector('.html-preview');
            if (preview && preview.style.display === 'none') preview.style.display = 'block';

            const codePre = b.querySelector('.ibe-code-block pre');
            if (codePre && codePre.style.display === 'none') codePre.style.display = '';

            b.querySelectorAll('th, td').forEach(cell => {
                cell.removeAttribute('contenteditable');
            });

            // Remove any remaining contenteditable attributes
            b.querySelectorAll('[contenteditable]').forEach(el => {
                el.removeAttribute('contenteditable');
            });
        });

        // Remove the instance data attribute from the clone
        temp.removeAttribute('data-ibe-id');

        return temp.innerHTML;
    }

    /** Alias for getContent() */
    getHTML() {
        return this.getContent();
    }

    /**
     * Replace editor content with new HTML.
     * @param {string} html - HTML content to load
     */
    setHTML(html) {
        if (this._guardDestroyed('setHTML')) return;
        this.container.querySelectorAll('.ibe-block.is-editing').forEach(b => this.exitEditMode(b));
        this.container.innerHTML = html;
        this._migrateToBlocks();
        this.container.querySelectorAll('.ibe-block').forEach(b => {
            this._createControls(b);
            this._fixLegacyBlockStructure(b);
        });
        this._reorganizeSeparators();
        this.clearDirty();
    }

    /**
     * Save editor content.
     * @param {Object} [metadata={}] - Additional metadata to pass to save handler
     * @returns {Promise<boolean>}
     */
    async save(metadata = {}) {
        if (this._guardDestroyed('save')) return false;

        const html = this.getContent();

        if (this.options.onSave) {
            try {
                const success = await this.options.onSave(html, metadata);
                if (success) {
                    this.clearDirty();
                    this.showToast('Article saved successfully');
                    this._emit('save', { html, metadata, success: true });
                    return true;
                }
            } catch (err) {
                this._error('Save handler error:', err);
            }
        } else if (this.options.endpoint) {
            const formData = new FormData();
            formData.append('action', 'save_article');
            formData.append('content', html);
            for (const [key, value] of Object.entries(metadata)) {
                formData.append(key, value);
            }

            try {
                const response = await fetch(this.options.endpoint, {
                    method: 'POST',
                    body: formData
                });
                const res = await response.json();
                if (res.success) {
                    this.clearDirty();
                    this.showToast('Article saved successfully');
                    this._emit('save', { html, metadata, success: true });
                    return true;
                }
            } catch (err) {
                this._error('Endpoint save error:', err);
            }
        }

        this.showToast('Failed to save article');
        this._emit('save', { html, metadata, success: false });
        return false;
    }

    /** Show a toast notification */
    showToast(message) {
        const toast = document.createElement('div');
        toast.className = 'ibe-toast';
        toast.textContent = message;
        document.body.appendChild(toast);
        // Force reflow for animation
        toast.offsetHeight; // eslint-disable-line no-unused-expressions
        toast.classList.add('ibe-toast-visible');
        setTimeout(() => {
            toast.classList.remove('ibe-toast-visible');
            setTimeout(() => toast.remove(), 300);
        }, 2500);
    }

    /**
     * Toggle edit/preview mode.
     * @param {boolean} preview - true for preview/read-only mode
     */
    setPreviewMode(preview) {
        if (this._guardDestroyed('setPreviewMode')) return;
        this.isPreviewMode = !!preview;
        if (this.isPreviewMode) {
            this.container.classList.remove('is-edit-mode');
            this.container.querySelectorAll('.ibe-block.is-editing').forEach(b => this.exitEditMode(b));
            if (this.sortable) {
                this.sortable.option('disabled', true);
            }
        } else {
            this.container.classList.add('is-edit-mode');
            if (this.sortable) {
                this.sortable.option('disabled', false);
            }
        }
        this._emit('mode:change', { preview: this.isPreviewMode });
    }

    /** Enable editing (alias for setPreviewMode(false)) */
    enable() {
        this.setPreviewMode(false);
    }

    /** Disable editing (alias for setPreviewMode(true)) */
    disable() {
        this.setPreviewMode(true);
    }

    /** @returns {boolean} Whether the editor is in edit mode */
    isEnabled() {
        return !this.isPreviewMode && !this._destroyed;
    }

    /**
     * Destroy the editor instance and clean up all resources.
     */
    destroy() {
        if (this._destroyed) return;
        this._destroyed = true;
        this._initialized = false;

        // Remove all DOM event listeners
        if (this._handlers.mouseDown) {
            document.removeEventListener('mousedown', this._handlers.mouseDown);
        }
        if (this._handlers.input) {
            this.container.removeEventListener('input', this._handlers.input);
        }
        if (this._handlers.paste) {
            this.container.removeEventListener('paste', this._handlers.paste);
        }
        if (this._handlers.keydown) {
            this.container.removeEventListener('keydown', this._handlers.keydown);
        }
        if (this._handlers.beforeunload) {
            window.removeEventListener('beforeunload', this._handlers.beforeunload);
        }
        if (this._handlers.docClick) {
            document.removeEventListener('click', this._handlers.docClick);
        }

        // Destroy Sortable
        if (this.sortable) {
            this.sortable.destroy();
            this.sortable = null;
        }

        // Remove editor UI elements
        this.container.classList.remove('ibe-container', 'is-edit-mode');
        this.container.removeAttribute('data-ibe-id');
        this.container.querySelectorAll('.ibe-toolbar, .ibe-separator, .html-editor-raw, .ibe-code-textarea, .ibe-img-zoom-btn, .ibe-html-textarea').forEach(el => el.remove());

        // Clean up block state
        this.container.querySelectorAll('.ibe-block').forEach(b => {
            b.classList.remove('is-editing');
            const c = b.querySelector('.ibe-block-content');
            if (c) c.removeAttribute('contenteditable');
            const txt = b.querySelector('.alert-txt');
            if (txt) txt.removeAttribute('contenteditable');
            b.querySelectorAll('th, td').forEach(cell => {
                cell.removeAttribute('contenteditable');
            });
            const pre = b.querySelector('.ibe-code-block pre');
            if (pre && pre.style.display === 'none') pre.style.display = '';
        });

        // Clear event listeners
        this._listeners = {};
        this._handlers = {};
    }
}

// ─── Module Export (UMD) ────────────────────────────────────────────────
(function (root, factory) {
    const IBE = factory();
    if (typeof module !== 'undefined' && typeof module.exports !== 'undefined') {
        module.exports = IBE;
    } else if (typeof define === 'function' && define.amd) {
        define([], () => IBE);
    }
    // Always attach to window for browser usage
    if (typeof window !== 'undefined') {
        window.InlineBlockEditor = IBE;
    }
}(typeof self !== 'undefined' ? self : this, function () {
    return InlineBlockEditor;
}));
