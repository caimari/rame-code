/* RAME Code Settings webview script.
 * The API key is never stored here: no localStorage, no sessionStorage, no
 * cookies. The key field is cleared immediately after Save is clicked, and
 * the view only ever receives a boolean hasKey flag from the host.
 * All host content is rendered with textContent, never innerHTML.
 */
(function () {
  'use strict';

  var vscode = acquireVsCodeApi();

  var connectionEl = document.getElementById('connection');
  var apiKeyEl = document.getElementById('apiKey');
  var saveKeyBtn = document.getElementById('saveKey');
  var clearKeyBtn = document.getElementById('clearKey');
  var statusEl = document.getElementById('status');

  var hasKey = false;

  function setText(el, text) {
    if (el) {
      el.textContent = text;
    }
  }

  function connectionText(connection) {
    switch (connection) {
      case 'missing-key':
        return 'Not connected — API key required';
      case 'ready':
        return 'Key stored — live connection not yet verified';
      case 'working':
        return 'Working…';
      case 'done':
        return 'Plan ready';
      case 'cancelled':
        return 'Cancelled';
      case 'error':
        return 'Error';
      default:
        return String(connection);
    }
  }

  function refreshControls() {
    if (clearKeyBtn) {
      clearKeyBtn.disabled = !hasKey;
    }
  }

  function isStateMessage(data) {
    return (
      data !== null &&
      typeof data === 'object' &&
      !Array.isArray(data) &&
      data.type === 'state' &&
      typeof data.hasKey === 'boolean' &&
      typeof data.connection === 'string' &&
      typeof data.status === 'string'
    );
  }

  window.addEventListener('message', function (event) {
    var data = event.data;
    if (!isStateMessage(data)) {
      return;
    }
    hasKey = data.hasKey;
    setText(connectionEl, connectionText(data.connection));
    setText(statusEl, data.status);
    refreshControls();
  });

  if (saveKeyBtn) {
    saveKeyBtn.addEventListener('click', function () {
      var value = apiKeyEl ? apiKeyEl.value : '';
      // Drop the secret from the view immediately after sending it.
      if (apiKeyEl) {
        apiKeyEl.value = '';
      }
      vscode.postMessage({ type: 'saveKey', apiKey: value });
    });
  }

  if (clearKeyBtn) {
    clearKeyBtn.addEventListener('click', function () {
      if (apiKeyEl) {
        apiKeyEl.value = '';
      }
      vscode.postMessage({ type: 'clearKey' });
    });
  }

  refreshControls();

  // Signal readiness only after the message listener and controls exist,
  // so the host can (re)send initial state without it being missed.
  vscode.postMessage({ type: 'ready' });
})();
