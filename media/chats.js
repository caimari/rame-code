/* RAME Code Chats webview script.
 * The API key is never present here: no key storage, no key fields. Thread
 * history is display-only; each send transmits only the composer text.
 * All model/user content is rendered with textContent and DOM construction,
 * never innerHTML.
 */
(function () {
  'use strict';

  var vscode = acquireVsCodeApi();

  var newThreadBtn = document.getElementById('newThread');
  var refreshBtn = document.getElementById('refreshThreads');
  var openSettingsBtn = document.getElementById('openSettings');
  var threadListEl = document.getElementById('threadList');
  var transcriptEl = document.getElementById('transcript');
  var emptyStateEl = document.getElementById('emptyState');
  var composerEl = document.getElementById('composer');
  var modeSelectEl = document.getElementById('modeSelect');
  var modelSelectEl = document.getElementById('modelSelect');
  var sendBtn = document.getElementById('send');
  var cancelBtn = document.getElementById('cancel');
  var statusEl = document.getElementById('status');
  var connectionEl = document.getElementById('connection');

  var running = false;
  var activeThreadId = null;

  function setText(el, text) {
    if (el) {
      el.textContent = text;
    }
  }

  function clearEl(el) {
    while (el && el.firstChild) {
      el.removeChild(el.firstChild);
    }
  }

  function addList(container, items) {
    var list = document.createElement('ul');
    items.forEach(function (item) {
      var li = document.createElement('li');
      li.textContent = String(item);
      list.appendChild(li);
    });
    container.appendChild(list);
  }

  function renderPlanTurn(container, plan) {
    var goalHeading = document.createElement('h4');
    goalHeading.textContent = 'Plan';
    container.appendChild(goalHeading);
    var goal = document.createElement('p');
    goal.textContent = String(plan.goal || '');
    container.appendChild(goal);
    if (Array.isArray(plan.assumptions) && plan.assumptions.length > 0) {
      var aHeading = document.createElement('h4');
      aHeading.textContent = 'Assumptions';
      container.appendChild(aHeading);
      addList(container, plan.assumptions);
    }
    if (Array.isArray(plan.steps) && plan.steps.length > 0) {
      var sHeading = document.createElement('h4');
      sHeading.textContent = 'Steps';
      container.appendChild(sHeading);
      var steps = document.createElement('ol');
      plan.steps.forEach(function (step) {
        var li = document.createElement('li');
        var title = document.createElement('p');
        title.textContent = String(step.title || '');
        li.appendChild(title);
        var criterion = document.createElement('p');
        criterion.textContent =
          'Success criterion: ' + String(step.successCriterion || '');
        li.appendChild(criterion);
        steps.appendChild(li);
      });
      container.appendChild(steps);
    }
    if (Array.isArray(plan.risks) && plan.risks.length > 0) {
      var rHeading = document.createElement('h4');
      rHeading.textContent = 'Risks';
      container.appendChild(rHeading);
      addList(container, plan.risks);
    }
  }

  function renderTurns(turns) {
    clearEl(transcriptEl);
    if (!Array.isArray(turns) || turns.length === 0) {
      if (emptyStateEl) {
        emptyStateEl.hidden = false;
      }
      return;
    }
    if (emptyStateEl) {
      emptyStateEl.hidden = true;
    }
    turns.forEach(function (turn) {
      var card = document.createElement('div');
      card.className = 'turn';
      if (turn.kind === 'user') {
        var who = document.createElement('h4');
        who.textContent = 'You';
        card.appendChild(who);
        var text = document.createElement('p');
        text.textContent = String(turn.text || '');
        card.appendChild(text);
      } else if (turn.kind === 'plan') {
        renderPlanTurn(card, turn.plan || {});
      } else if (turn.kind === 'error') {
        var err = document.createElement('p');
        err.textContent = String(turn.message || '');
        card.appendChild(err);
      } else {
        var unknown = document.createElement('p');
        unknown.textContent = 'Unsupported turn.';
        card.appendChild(unknown);
      }
      if (transcriptEl) {
        transcriptEl.appendChild(card);
      }
    });
  }

  function renderThreads(threads) {
    clearEl(threadListEl);
    if (!Array.isArray(threads) || threads.length === 0) {
      var empty = document.createElement('li');
      empty.textContent = 'No threads yet.';
      if (threadListEl) {
        threadListEl.appendChild(empty);
      }
      return;
    }
    threads.forEach(function (thread) {
      var li = document.createElement('li');
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = String(thread.title || 'Untitled');
      btn.title = String(thread.title || 'Untitled');
      if (thread.id === activeThreadId) {
        btn.setAttribute('aria-current', 'true');
      }
      btn.addEventListener('click', function () {
        vscode.postMessage({ type: 'openThread', threadId: thread.id });
      });
      li.appendChild(btn);
      if (threadListEl) {
        threadListEl.appendChild(li);
      }
    });
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
    if (sendBtn) {
      sendBtn.disabled = running;
    }
    if (cancelBtn) {
      cancelBtn.disabled = !running;
    }
    if (composerEl) {
      composerEl.disabled = running;
    }
  }

  function isStateMessage(data) {
    return (
      data !== null &&
      typeof data === 'object' &&
      !Array.isArray(data) &&
      data.type === 'state' &&
      typeof data.hasKey === 'boolean' &&
      typeof data.running === 'boolean' &&
      typeof data.status === 'string' &&
      typeof data.connection === 'string' &&
      Array.isArray(data.threads) &&
      (data.activeThreadId === null ||
        typeof data.activeThreadId === 'string') &&
      Array.isArray(data.turns)
    );
  }

  window.addEventListener('message', function (event) {
    var data = event.data;
    if (!isStateMessage(data)) {
      return;
    }
    running = data.running;
    activeThreadId = data.activeThreadId;
    setText(connectionEl, connectionText(data.connection));
    setText(statusEl, data.status);
    renderThreads(data.threads);
    renderTurns(data.turns);
    refreshControls();
  });

  if (newThreadBtn) {
    newThreadBtn.addEventListener('click', function () {
      vscode.postMessage({ type: 'newThread' });
    });
  }

  if (refreshBtn) {
    refreshBtn.addEventListener('click', function () {
      vscode.postMessage({ type: 'refreshThreads' });
    });
  }

  if (openSettingsBtn) {
    openSettingsBtn.addEventListener('click', function () {
      vscode.postMessage({ type: 'openSettings' });
    });
  }

  if (sendBtn) {
    sendBtn.addEventListener('click', function () {
      var text = composerEl ? composerEl.value : '';
      var mode = modeSelectEl ? modeSelectEl.value : 'mission';
      var model = modelSelectEl ? modelSelectEl.value : 'muse-spark-1.3';
      if (composerEl) {
        composerEl.value = '';
      }
      vscode.postMessage({ type: 'sendMessage', text: text, mode: mode, model: model });
    });
  }

  if (cancelBtn) {
    cancelBtn.addEventListener('click', function () {
      vscode.postMessage({ type: 'cancelMission' });
    });
  }

  refreshControls();

  vscode.postMessage({ type: 'ready' });
})();
