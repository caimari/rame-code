/* RAME Code webview script.
 * The API key is never stored here: no localStorage, no sessionStorage, no
 * cookies. The key field is cleared immediately after Save is clicked, and
 * the panel only ever receives a boolean hasKey flag from the host.
 */
(function () {
  'use strict';

  var vscode = acquireVsCodeApi();

  var connectionEl = document.getElementById('connection');
  var apiKeyEl = document.getElementById('apiKey');
  var saveKeyBtn = document.getElementById('saveKey');
  var clearKeyBtn = document.getElementById('clearKey');
  var missionEl = document.getElementById('mission');
  var startBtn = document.getElementById('start');
  var cancelBtn = document.getElementById('cancel');
  var statusEl = document.getElementById('status');
  var planEl = document.getElementById('plan');

  var running = false;
  var hasKey = false;

  // Restore only the mission-goal draft across reloads; never key material.
  var savedDraft = (vscode.getState() || {}).missionDraft;
  if (typeof savedDraft === 'string' && missionEl) {
    missionEl.value = savedDraft;
  }

  function setText(el, text) {
    if (el) {
      el.textContent = text;
    }
  }

  function clearPlan(message) {
    while (planEl.firstChild) {
      planEl.removeChild(planEl.firstChild);
    }
    var hint = document.createElement('p');
    hint.className = 'hint';
    hint.textContent = message;
    planEl.appendChild(hint);
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

  function renderPlan(plan) {
    while (planEl.firstChild) {
      planEl.removeChild(planEl.firstChild);
    }
    if (!plan || typeof plan !== 'object') {
      clearPlan('No plan yet.');
      return;
    }
    var goalHeading = document.createElement('h3');
    goalHeading.textContent = 'Goal';
    planEl.appendChild(goalHeading);
    var goal = document.createElement('p');
    goal.textContent = String(plan.goal || '');
    planEl.appendChild(goal);

    if (Array.isArray(plan.assumptions) && plan.assumptions.length > 0) {
      var assumptionsHeading = document.createElement('h3');
      assumptionsHeading.textContent = 'Assumptions';
      planEl.appendChild(assumptionsHeading);
      addList(planEl, plan.assumptions);
    }

    if (Array.isArray(plan.steps) && plan.steps.length > 0) {
      var stepsHeading = document.createElement('h3');
      stepsHeading.textContent = 'Steps';
      planEl.appendChild(stepsHeading);
      var steps = document.createElement('ol');
      plan.steps.forEach(function (step) {
        var li = document.createElement('li');
        var title = document.createElement('p');
        title.textContent = String(step.title || '');
        li.appendChild(title);
        var criterion = document.createElement('p');
        criterion.textContent = 'Success criterion: ' + String(step.successCriterion || '');
        li.appendChild(criterion);
        steps.appendChild(li);
      });
      planEl.appendChild(steps);
    }

    if (Array.isArray(plan.risks) && plan.risks.length > 0) {
      var risksHeading = document.createElement('h3');
      risksHeading.textContent = 'Risks';
      planEl.appendChild(risksHeading);
      addList(planEl, plan.risks);
    }
  }

  function refreshControls() {
    if (startBtn) {
      startBtn.disabled = running;
    }
    if (cancelBtn) {
      cancelBtn.disabled = !running;
    }
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
      typeof data.running === 'boolean' &&
      typeof data.status === 'string' &&
      typeof data.connection === 'string'
    );
  }

  window.addEventListener('message', function (event) {
    var data = event.data;
    if (!isStateMessage(data)) {
      return;
    }
    hasKey = data.hasKey;
    running = data.running;
    setText(connectionEl, connectionText(data.connection));
    setText(statusEl, data.status);
    if (typeof data.error === 'string' && data.error.length > 0) {
      clearPlan('Error: ' + data.error);
    } else if (data.plan) {
      renderPlan(data.plan);
    } else if (!running) {
      clearPlan('No plan yet.');
    }
    refreshControls();
  });

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

  if (saveKeyBtn) {
    saveKeyBtn.addEventListener('click', function () {
      var value = apiKeyEl ? apiKeyEl.value : '';
      // Drop the secret from the panel immediately after sending it.
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

  if (startBtn) {
    startBtn.addEventListener('click', function () {
      var goal = missionEl ? missionEl.value : '';
      vscode.postMessage({ type: 'startMission', goal: goal });
    });
  }

  if (cancelBtn) {
    cancelBtn.addEventListener('click', function () {
      vscode.postMessage({ type: 'cancelMission' });
    });
  }

  if (missionEl) {
    missionEl.addEventListener('input', function () {
      vscode.setState({ missionDraft: missionEl.value });
    });
  }

  refreshControls();

  // Signal readiness only after the message listener and controls exist,
  // so the host can (re)send initial state without it being missed.
  vscode.postMessage({ type: 'ready' });
})();
