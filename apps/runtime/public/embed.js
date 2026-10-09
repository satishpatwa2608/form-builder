/*
 * Form Builder embed. Put a form on any page:
 *
 *   <script src="https://forms.example.com/embed.js" data-org="ORG" data-code="FORM_CODE"></script>
 *
 * or, with the script loaded once anywhere on the page:
 *
 *   <form-builder-form org="ORG" code="FORM_CODE" lang="hi"></form-builder-form>
 *
 * The form runs in a frame on our address, so the page around it cannot read
 * what is typed and the form cannot touch the page. It grows to its own
 * height, and tells the page when it has been submitted:
 *
 *   element.addEventListener('submitted', (e) => console.log(e.detail.submissionId))
 */
(function () {
  'use strict';
  if (window.customElements.get('form-builder-form')) return;

  var script = document.currentScript;
  // Where the forms live: the address this script was loaded from.
  var home = script && script.src ? new URL(script.src).origin : window.location.origin;
  var ORG = /^[A-Za-z0-9-]{1,64}$/;
  var CODE = /^[A-Z0-9_]{1,100}$/;

  class FormBuilderForm extends HTMLElement {
    static get observedAttributes() {
      return ['org', 'code', 'lang', 'origin'];
    }

    constructor() {
      super();
      this._frame = null;
      this._onMessage = this._onMessage.bind(this);
    }

    connectedCallback() {
      window.addEventListener('message', this._onMessage);
      this._render();
    }

    disconnectedCallback() {
      window.removeEventListener('message', this._onMessage);
    }

    attributeChangedCallback() {
      if (this.isConnected) this._render();
    }

    /** The address forms are served from: this script's own, unless `origin` says otherwise. */
    _home() {
      try {
        var given = this.getAttribute('origin');
        return given ? new URL(given).origin : home;
      } catch {
        return home;
      }
    }

    _render() {
      var org = this.getAttribute('org') || '';
      var code = this.getAttribute('code') || '';
      var lang = this.getAttribute('lang') || '';
      if (!this.style.display) this.style.display = 'block';
      // On a customer's own form address the organisation is known from the host name.
      if ((org && !ORG.test(org)) || !CODE.test(code)) {
        this.textContent = '';
        this._frame = null;
        return;
      }
      var url = new URL(this._home() + (org ? '/f/' + org + '/' + code : '/' + code));
      url.searchParams.set('embed', '1');
      if (/^[A-Za-z-]{2,12}$/.test(lang)) url.searchParams.set('lang', lang);
      if (this._frame && this._frame.src === url.toString()) return;
      var frame = document.createElement('iframe');
      frame.src = url.toString();
      frame.title = this.getAttribute('title') || 'Form';
      frame.loading = 'lazy';
      frame.setAttribute('referrerpolicy', 'strict-origin-when-cross-origin');
      frame.style.cssText = 'display:block;width:100%;border:0;height:480px';
      this.textContent = '';
      this.appendChild(frame);
      this._frame = frame;
    }

    _onMessage(event) {
      // Only our own frame, speaking from our own address, is listened to.
      if (!this._frame || event.source !== this._frame.contentWindow || event.origin !== this._home()) return;
      var data = event.data;
      if (!data || typeof data !== 'object') return;
      if (data.type === 'form-builder:resize' && typeof data.height === 'number' && data.height > 0 && data.height < 100000) {
        this._frame.style.height = Math.ceil(data.height) + 'px';
      } else if (data.type === 'form-builder:submitted') {
        this.dispatchEvent(new CustomEvent('submitted', { detail: { code: this.getAttribute('code'), submissionId: String(data.submissionId || '') }, bubbles: true }));
      }
    }
  }

  window.customElements.define('form-builder-form', FormBuilderForm);

  // The one-line form: a script tag that carries the form's details puts the form where the tag is.
  if (script && script.dataset && script.dataset.code) {
    var el = document.createElement('form-builder-form');
    if (script.dataset.org) el.setAttribute('org', script.dataset.org);
    el.setAttribute('code', script.dataset.code);
    if (script.dataset.lang) el.setAttribute('lang', script.dataset.lang);
    if (script.parentNode) script.parentNode.insertBefore(el, script.nextSibling);
  }
})();
