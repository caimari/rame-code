/* RAME Code single-view webview script.
 * The API key is never stored here: no localStorage, no sessionStorage, no
 * cookies. The key field is cleared immediately after Save is clicked, and
 * the view only ever receives a boolean hasKey flag from the host.
 * All model/user/host content is rendered with textContent and DOM
 * construction, never innerHTML. Internal Chat <-> Settings navigation
 * toggles sections inside this one document; no second VS Code view exists.
 */
(function () {
  'use strict';

  var vscode = acquireVsCodeApi();

  function el(id) {
    return document.getElementById(id);
  }

  var chatScreen = el('chatScreen');
  var settingsScreen = el('settingsScreen');
  var homeSectionEl = el('homeSection');
  var conversationSectionEl = el('conversationSection');
  var conversationBarEl = el('conversationBar');
  var backToListBtn = el('backToList');
  var threadTitleEl = el('threadTitle');
  var newThreadBtn = el('newThread');
  var refreshBtn = el('refresh');
  var openSettingsBtn = el('openSettings');
  var backBtn = el('backToChat');
  var threadListEl = el('threadList');
  var runIndicatorEl = el('runIndicator');
  var runIndicatorTextEl = el('runIndicatorText');
  var transcriptEl = el('transcript');
  var emptyStateEl = el('emptyState');
  var permissionBtnEl = el('permissionBtn');
  var permissionMenuEl = el('permissionMenu');
  var attachBtnEl = el('attachBtn');
  var composerEl = el('composer');
  var modeSelectEl = el('modeSelect');
  var runtimeSelectEl = el('runtimeSelect');
  var runtimeStatusEl = el('runtimeStatus');
  var sendBtn = el('send');
  var cancelBtn = el('cancel');
  var statusEl = el('status');
  var usageEl = el('usage');
  var connectionEl = el('connection');
  var runtimeStateEl = el('runtimeState');
  var scopeNoticeEl = el('scopeNotice');
  var escalationBox = el('escalationBox');
  var escalationReasonEl = el('escalationReason');
  var escalateApproveBtn = el('escalateApprove');
  var escalateDismissBtn = el('escalateDismiss');
  var profileSelectEl = el('profileSelect');
  var profileDescEl = el('profileDesc');
  var permissionChipEl = el('permissionChip');
  var workspaceBadgeEl = el('workspaceBadge');
  var activityListEl = el('activityList');
  var resultSectionEl = el('resultSection');
  var resultBodyEl = el('resultBody');
  var resultHostRecordEl = el('resultHostRecord');
  var agentSectionEl = el('agentSection');
  var agentWarningEl = el('agentWarning');
  var permissionWarningEl = el('permissionWarning');
  var runtimeNoticeEl = el('runtimeNotice');
  var runtimeNoticeTextEl = el('runtimeNoticeText');
  var runtimeNoticeSettingsBtn = el('runtimeNoticeSettings');
  var agentBox = el('agentBox');
  var pendingToolEl = el('pendingTool');
  var pendingTargetsEl = el('pendingTargets');
  var pendingBodyEl = el('pendingBody');
  var pendingMetaEl = el('pendingMeta');
  var pendingApproveBtn = el('pendingApprove');
  var pendingRejectBtn = el('pendingReject');
  var actionLogEl = el('actionLog');
  var pendingActionRef = null;
  var pendingButtons = [];

  var settingsConnectionEl = el('settingsConnection');
  var apiKeyEl = el('apiKey');
  var saveKeyBtn = el('saveKey');
  var clearKeyBtn = el('clearKey');
  var cloudSectionEl = el('cloudSection');
  var localSectionEl = el('localSection');
  var escalationSectionEl = el('escalationSection');
  var cloudModelSelectEl = el('cloudModelSelect');
  var refreshModelsBtn = el('refreshModels');
  var catalogStatusEl = el('catalogStatus');
  var exePathEl = el('exePath');
  var modelPathEl = el('modelPath');
  var projectorPathEl = el('projectorPath');
  var draftPathEl = el('draftPath');
  var localModelIdEl = el('localModelId');
  var contextSizeEl = el('contextSize');
  var localPortEl = el('localPort');
  var idleTimeoutEl = el('idleTimeout');
  var externalEndpointEl = el('externalEndpoint');
  var useSuggestionsBtn = el('useSuggestions');
  var saveLocalBtn = el('saveLocal');
  var startLocalBtn = el('startLocal');
  var stopLocalBtn = el('stopLocal');
  var selectExternalBtn = el('selectExternal');
  var clearExternalBtn = el('clearExternal');
  var allowEscalationEl = el('allowEscalation');
  var localStatusEl = el('localStatus');
  var diagnosticsEl = el('diagnostics');
  var settingsStatusEl = el('settingsStatus');
  var generationModelEl = el('generationModel');
  var reasoningSelectEl = el('reasoningSelect');
  var reasoningHintEl = el('reasoningHint');
  var budgetHintEl = el('budgetHint');
  var maxOutputLocalEl = el('maxOutputLocal');
  var maxOutputCloudEl = el('maxOutputCloud');
  var saveMaxOutputBtn = el('saveMaxOutput');
  var REASONING_LABELS = { default: 'Model default', minimal: 'Minimal', low: 'Low', medium: 'Medium', high: 'High', xhigh: 'XHigh', max: 'Max' };
  // Provider/model the reasoning selector currently describes.
  var generationTarget = { provider: 'cloud', model: '' };

  var running = false;
  var activeThreadId = null;
  var hasKey = false;
  var lastLocalRev = -1;
  var currentRuntime = 'cloud';
  var currentMode = 'agent';
  var currentCloudModel = 'muse-spark-1.3';
  var viewingDraft = false;
  var lastThreads = [];
  var localReady = false;

  // Restore only the composer draft across reloads; never key material.
  var savedDraft = (vscode.getState() || {}).composerDraft;
  if (typeof savedDraft === 'string' && composerEl) {
    composerEl.value = savedDraft;
  }

  function setText(node, text) {
    if (node) {
      node.textContent = text;
    }
  }

  function hideRuntimeNotice() {
    if (runtimeNoticeEl) {
      runtimeNoticeEl.hidden = true;
    }
    setText(runtimeNoticeTextEl, '');
  }

  function showRuntimeNotice(message) {
    setText(runtimeNoticeTextEl, message);
    if (runtimeNoticeEl) {
      runtimeNoticeEl.hidden = false;
    }
  }

  function clearEl(node) {
    while (node && node.firstChild) {
      node.removeChild(node.firstChild);
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

  function showScreen(screen) {
    var toSettings = screen === 'settings';
    if (chatScreen) {
      chatScreen.hidden = toSettings;
    }
    if (settingsScreen) {
      settingsScreen.hidden = !toSettings;
    }
    if (!toSettings) {
      renderHomeVsConversation();
    }
  }

  function threadTitleFor(id) {
    if (!id) {
      return viewingDraft ? 'New thread' : 'Threads';
    }
    for (var i = 0; i < lastThreads.length; i++) {
      if (lastThreads[i] && lastThreads[i].id === id) {
        var title = String(lastThreads[i].title || '').trim();
        return title.length > 0 ? title : 'Conversation';
      }
    }
    return 'Conversation';
  }

  function renderHomeVsConversation() {
    var inConversation = activeThreadId !== null || viewingDraft;
    if (homeSectionEl) {
      homeSectionEl.hidden = inConversation;
    }
    if (conversationSectionEl) {
      conversationSectionEl.hidden = !inConversation;
    }
    if (threadTitleEl) {
      threadTitleEl.textContent = threadTitleFor(activeThreadId);
      threadTitleEl.title = threadTitleFor(activeThreadId);
    }
  }

  function formatThreadMeta(thread) {
    if (!thread || typeof thread.updatedAt !== 'number' || !isFinite(thread.updatedAt) || thread.updatedAt <= 0) {
      return '';
    }
    try {
      var date = new Date(thread.updatedAt);
      if (isNaN(date.getTime())) {
        return '';
      }
      return 'Updated ' + date.toLocaleString();
    } catch (e) {
      return '';
    }
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

  function markPending(btn, label) {
    if (!btn || btn.disabled) {
      return false;
    }
    if (!btn.dataset.origLabel) {
      btn.dataset.origLabel = btn.textContent;
    }
    btn.disabled = true;
    btn.classList.add('is-pending');
    btn.textContent = label;
    if (pendingButtons.indexOf(btn) === -1) {
      pendingButtons.push(btn);
    }
    return true;
  }

  function restorePendingButtons() {
    pendingButtons.forEach(function (btn) {
      btn.classList.remove('is-pending');
      if (btn.dataset.origLabel) {
        btn.textContent = btn.dataset.origLabel;
      }
      // A host state message completes the async click cycle. Re-enable the
      // control here; refreshControls() may subsequently disable it again if
      // the confirmed host state requires that. Without this reset, approving
      // one Agent tool left the same Approve button disabled for the next
      // independent, hash-bound action while Reject remained available.
      btn.disabled = false;
      btn.dataset.origLabel = '';
    });
    pendingButtons = [];
  }

  function cleanAgentResult(text) {
    return String(text || '').replace(/^(?:Agent \([^)]*\):\s*)+/, '');
  }

  // The host record is a separate field written by RAME Code itself; it is
  // never parsed out of model text, so the model cannot render one.
  function renderHostRecord(container, record) {
    if (!container || !Array.isArray(record) || record.length === 0) {
      return;
    }
    var box = document.createElement('div');
    box.className = 'host-record';
    box.setAttribute('role', 'group');
    box.setAttribute('aria-label', 'Host record, verified by RAME Code');
    var head = document.createElement('h5');
    head.textContent = 'Host record \u2014 verified by RAME Code, not written by the model';
    box.appendChild(head);
    var list = document.createElement('ul');
    record.forEach(function (line) {
      var item = document.createElement('li');
      item.textContent = String(line).replace(/^\u2022\s*/, '');
      list.appendChild(item);
    });
    box.appendChild(list);
    container.appendChild(box);
  }

  function renderTurns(turns, isRunning) {
    clearEl(transcriptEl);
    if (resultSectionEl) {
      resultSectionEl.hidden = true;
    }
    setText(resultBodyEl, '');
    clearEl(resultHostRecordEl);
    if (!Array.isArray(turns) || turns.length === 0) {
      if (emptyStateEl) {
        emptyStateEl.hidden = false;
      }
      return;
    }
    if (emptyStateEl) {
      emptyStateEl.hidden = true;
    }
    var finalResultIndex = -1;
    if (!isRunning && turns.length > 0 && turns[turns.length - 1] && turns[turns.length - 1].kind === 'assistant') {
      finalResultIndex = turns.length - 1;
      setText(resultBodyEl, cleanAgentResult(turns[finalResultIndex].text));
      renderHostRecord(resultHostRecordEl, turns[finalResultIndex].hostRecord);
      if (resultSectionEl) {
        resultSectionEl.hidden = false;
      }
    }
    turns.forEach(function (turn, turnIndex) {
      if (turnIndex === finalResultIndex) {
        return;
      }
      var card = document.createElement('div');
      card.className = 'turn';
      if (turn.kind === 'user') {
        card.classList.add('turn-user');
        var who = document.createElement('h4');
        who.textContent = 'You';
        card.appendChild(who);
        var text = document.createElement('p');
        text.textContent = String(turn.text || '');
        card.appendChild(text);
      } else if (turn.kind === 'assistant') {
        card.classList.add('turn-assistant');
        var asst = document.createElement('h4');
        asst.textContent = 'Assistant';
        card.appendChild(asst);
        var reply = document.createElement('p');
        reply.textContent = String(turn.text || '');
        card.appendChild(reply);
        renderHostRecord(card, turn.hostRecord);
      } else if (turn.kind === 'plan') {
        card.classList.add('turn-plan');
        renderPlanTurn(card, turn.plan || {});
      } else if (turn.kind === 'error') {
        var errText = String(turn.message || 'Request failed.');
        var isCancelled = errText === 'Request cancelled.';
        var isNotice =
          isCancelled ||
          errText.indexOf('Action rejected by user.') !== -1 ||
          errText.indexOf('Agent action rejected. Nothing ran.') !== -1 ||
          errText.indexOf('No changes were made.') !== -1;
        card.classList.add(isNotice ? 'turn-notice' : 'turn-error');
        var errHead = document.createElement('h4');
        errHead.textContent = isCancelled ? 'Cancelled' : (isNotice ? 'Action cancelled' : 'Run stopped');
        card.appendChild(errHead);
        var err = document.createElement('p');
        err.textContent = errText;
        card.appendChild(err);
        if (errText.indexOf('Local model is not reachable at ') !== -1 && errText.indexOf('Start it in Settings.') !== -1) {
          var errAction = document.createElement('button');
          errAction.type = 'button';
          errAction.textContent = 'Open Settings';
          errAction.setAttribute('aria-label', 'Open Settings to start the local model');
          errAction.addEventListener('click', function () {
            vscode.postMessage({ type: 'navigate', screen: 'settings' });
          });
          card.appendChild(errAction);
        }
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
    lastThreads = Array.isArray(threads) ? threads.slice() : [];
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
      var row = document.createElement('div');
      row.className = 'thread-row';
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'thread-open';
      var title = String((thread && thread.title) || 'Untitled');
      btn.textContent = title;
      btn.title = title;
      btn.setAttribute('aria-label', 'Open thread ' + title);
      if (thread && thread.id === activeThreadId) {
        btn.setAttribute('aria-current', 'true');
      }
      btn.addEventListener('click', function () {
        viewingDraft = false;
        vscode.postMessage({ type: 'openThread', threadId: thread.id });
      });
      row.appendChild(btn);
      var deleteBtn = document.createElement('button');
      deleteBtn.type = 'button';
      deleteBtn.className = 'thread-delete';
      deleteBtn.textContent = '\u00d7';
      deleteBtn.title = 'Delete thread';
      deleteBtn.setAttribute('aria-label', 'Delete thread ' + title);
      deleteBtn.addEventListener('click', function (event) {
        event.stopPropagation();
        if (li.querySelector('.thread-confirm')) {
          return;
        }
        var confirmRow = document.createElement('div');
        confirmRow.className = 'thread-confirm';
        confirmRow.setAttribute('role', 'group');
        confirmRow.setAttribute('aria-label', 'Confirm deletion of ' + title);

        var question = document.createElement('span');
        question.className = 'thread-confirm-text';
        question.textContent = 'Delete this thread?';
        confirmRow.appendChild(question);

        var confirmDelete = document.createElement('button');
        confirmDelete.type = 'button';
        confirmDelete.className = 'thread-confirm-delete';
        confirmDelete.textContent = 'Delete';
        confirmDelete.setAttribute('aria-label', 'Confirm delete ' + title);
        confirmDelete.addEventListener('click', function (confirmEvent) {
          confirmEvent.stopPropagation();
          confirmDelete.disabled = true;
          cancelDelete.disabled = true;
          confirmDelete.textContent = 'Deleting…';
          vscode.postMessage({ type: 'deleteThread', threadId: thread.id });
        });

        var cancelDelete = document.createElement('button');
        cancelDelete.type = 'button';
        cancelDelete.className = 'thread-confirm-cancel';
        cancelDelete.textContent = 'Cancel';
        cancelDelete.setAttribute('aria-label', 'Cancel delete ' + title);
        cancelDelete.addEventListener('click', function (cancelEvent) {
          cancelEvent.stopPropagation();
          confirmRow.remove();
          deleteBtn.focus();
        });
        confirmRow.addEventListener('keydown', function (keyEvent) {
          if (keyEvent.key === 'Escape') {
            keyEvent.preventDefault();
            confirmRow.remove();
            deleteBtn.focus();
          }
        });

        confirmRow.appendChild(confirmDelete);
        confirmRow.appendChild(cancelDelete);
        li.appendChild(confirmRow);
        confirmDelete.focus();
      });
      row.appendChild(deleteBtn);
      li.appendChild(row);
      var meta = formatThreadMeta(thread);
      if (meta) {
        var metaEl = document.createElement('span');
        metaEl.className = 'thread-meta';
        metaEl.textContent = meta;
        li.appendChild(metaEl);
      }
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
      case 'verified':
        return 'Connected — verified';
      case 'cancelled':
        return 'Cancelled';
      case 'error':
        return 'Error';
      default:
        return String(connection);
    }
  }

  function formatUsage(label, usage) {
    if (!usage) {
      return label + ': —';
    }
    return (
      label +
      ': in ' +
      usage.inputTokens +
      ' / out ' +
      usage.outputTokens +
      ' / cached ' +
      usage.cachedTokens +
      ' / total ' +
      usage.totalTokens
    );
  }

  function setSelectValue(select, value) {
    if (!select) {
      return;
    }
    var known = false;
    for (var i = 0; i < select.options.length; i++) {
      if (select.options[i].value === value) {
        known = true;
        break;
      }
    }
    if (known) {
      select.value = value;
    }
  }

  function profileDescription(profile) {
    if (profile === 'safe-auto') {
      return 'Safe auto — reads run automatically; writes and tests need approval.';
    }
    if (profile === 'workspace-full') {
      return 'Workspace full (high risk) — reads, patches, and allowlisted tests run without prompts.';
    }
    return 'Ask (safest) — every tool action needs your approval.';
  }

  function runtimeDisplayName(runtime, cloudModel) {
    if (runtime === 'local') {
      return 'Muse Glimmer — Local';
    }
    var model = typeof cloudModel === 'string' && cloudModel.length > 0 ? cloudModel : currentCloudModel;
    return 'Meta Model API — Cloud (' + model + ')';
  }

  function runtimeShortName(runtime) {
    if (runtime === 'local') {
      return 'Muse Glimmer — Local';
    }
    return 'Meta Model API — Cloud';
  }

  function refreshAgentVisibility() {
    var inAgent = currentMode === 'agent';
    // Legacy agentSection stays hidden as an internal sync-only control; the
    // visible permission UI is permissionBtn/permissionMenu only.
    if (agentSectionEl) {
      agentSectionEl.hidden = true;
      agentSectionEl.setAttribute('aria-hidden', 'true');
    }
    var profile = profileSelectEl ? profileSelectEl.value : 'ask';
    if (agentWarningEl) {
      agentWarningEl.hidden = !(inAgent && profile === 'workspace-full');
    }
    if (permissionWarningEl) {
      permissionWarningEl.hidden = !(inAgent && profile === 'workspace-full');
    }
    if (permissionBtnEl) {
      permissionBtnEl.hidden = !inAgent;
    }
    syncPermissionMenu(profile);
  }

  function syncPermissionMenu(profile) {
    if (!permissionMenuEl) {
      return;
    }
    var buttons = permissionMenuEl.querySelectorAll('button[data-profile]');
    for (var i = 0; i < buttons.length; i++) {
      var btn = buttons[i];
      var selected = btn.getAttribute('data-profile') === profile;
      btn.setAttribute('aria-checked', selected ? 'true' : 'false');
    }
  }

  function closePermissionMenu() {
    if (permissionMenuEl) {
      permissionMenuEl.hidden = true;
    }
    if (permissionBtnEl) {
      permissionBtnEl.setAttribute('aria-expanded', 'false');
    }
  }

  function openPermissionMenu() {
    if (permissionMenuEl) {
      permissionMenuEl.hidden = false;
    }
    if (permissionBtnEl) {
      permissionBtnEl.setAttribute('aria-expanded', 'true');
    }
  }

  function selectProfile(profile) {
    setSelectValue(profileSelectEl, profile);
    refreshAgentVisibility();
    setText(permissionChipEl, shortProfileName(profile));
    vscode.postMessage({ type: 'setAgentProfile', profile: profile });
  }

  function shortProfileName(profile) {
    if (profile === 'safe-auto') {
      return 'Safe auto';
    }
    if (profile === 'workspace-full') {
      return 'Workspace full';
    }
    return 'Ask';
  }

  function renderActivityCard(head, sub) {
    var card = document.createElement('div');
    card.className = 'activity-card';
    var headEl = document.createElement('div');
    headEl.className = 'activity-head';
    headEl.textContent = head;
    card.appendChild(headEl);
    if (sub) {
      var subEl = document.createElement('div');
      subEl.className = 'activity-sub';
      subEl.textContent = sub;
      card.appendChild(subEl);
    }
    return card;
  }

  function renderAgent(data) {
    var profile = typeof data.agentProfile === 'string' ? data.agentProfile : 'ask';
    setSelectValue(profileSelectEl, profile);
    refreshAgentVisibility();
    var workspace = data.agentWorkspace || 'no workspace open';
    setText(profileDescEl, profileDescription(profile) + ' Workspace: ' + workspace + '.');
    setText(permissionChipEl, shortProfileName(profile));
    if (workspaceBadgeEl) {
      if (data.agentWorkspace) {
        workspaceBadgeEl.hidden = false;
        workspaceBadgeEl.textContent = 'Workspace: ' + String(data.agentWorkspace);
        workspaceBadgeEl.title = String(data.agentWorkspace);
      } else {
        workspaceBadgeEl.hidden = true;
        workspaceBadgeEl.textContent = '';
        workspaceBadgeEl.removeAttribute('title');
      }
    }
    var pending = data.agentPending || null;
    pendingActionRef = pending;
    if (agentBox) {
      agentBox.hidden = !pending;
    }
    // A finished run's outcome is shown only in the thread that ran it, so
    // an older thread never looks Completed/Cancelled by someone else's run.
    var runHere = typeof data.runThreadId === 'string' && data.runThreadId === activeThreadId;
    var outcome = null;
    if (!data.running && runHere) {
      if (data.connection === 'verified') {
        outcome = 'completed';
      } else if (data.connection === 'cancelled') {
        outcome = 'cancelled';
      } else if (data.connection === 'error') {
        outcome = 'error';
      }
    }
    if (runIndicatorEl) {
      runIndicatorEl.hidden = !data.running && outcome === null;
      runIndicatorEl.setAttribute(
        'data-state',
        pending ? 'approval' : (data.running ? 'working' : (outcome || 'working'))
      );
    }
    setText(
      runIndicatorTextEl,
      pending
        ? 'Waiting for your approval'
        : data.running
          ? String(data.status || 'Working…')
          : outcome === 'completed'
            ? 'Completed'
            : outcome === 'cancelled'
              ? 'Cancelled'
              : outcome === 'error'
                ? 'Error — ' + String(data.status || 'the run stopped.')
                : ''
    );
    if (pending) {
      setText(pendingToolEl, 'Tool: ' + String(pending.tool || ''));
      setText(pendingTargetsEl, 'Targets: ' + (Array.isArray(pending.targets) ? pending.targets.join(', ') : ''));
      // The host already bounds the preview and appends an explicit
      // truncation marker; keep that marker visible.
      setText(pendingBodyEl, 'Exact action: ' + String(pending.bodyPreview || '').slice(0, 2200));
      setText(
        pendingMetaEl,
        'Provider: ' + String(pending.provider || '') +
          ' | Workspace: ' + String(pending.workspaceId || workspace) +
          ' | Thread: ' + String(pending.threadId || '') +
          ' | Digest: ' + String(pending.digest || '').slice(0, 16) +
          ' — approval is one-use and hash-bound; the host verifies before running.'
      );
    } else {
      setText(pendingToolEl, '');
      setText(pendingTargetsEl, '');
      setText(pendingBodyEl, '');
      setText(pendingMetaEl, '');
    }
    clearEl(actionLogEl);
    if (activityListEl) {
      clearEl(activityListEl);
    }
    var log = Array.isArray(data.agentLog) ? data.agentLog.slice(-20) : [];
    if (data.running && runHere && activityListEl) {
      activityListEl.appendChild(
        renderActivityCard('Working…', String(data.status || 'Running…'))
      );
    }
    if (pending && activityListEl) {
      activityListEl.appendChild(
        renderActivityCard(
          'Pending approval: ' + String(pending.tool || ''),
          'Targets: ' + (Array.isArray(pending.targets) ? pending.targets.join(', ') : '') +
            ' | Digest: ' + String(pending.digest || '').slice(0, 16)
        )
      );
    }
    log.forEach(function (entry) {
      var li = document.createElement('li');
      li.textContent =
        String(entry.tool || '') + ' [' + String(entry.digest || '').slice(0, 12) + '] ' +
        String(entry.decision || '') + ' — ' + String(entry.result || '').slice(0, 160);
      if (actionLogEl) {
        actionLogEl.appendChild(li);
      }
      if (activityListEl) {
        activityListEl.appendChild(
          renderActivityCard(
            String(entry.tool || '') + ' — ' + String(entry.decision || ''),
            String(entry.result || '').slice(0, 300)
          )
        );
      }
    });
  }

  function refreshControls(data) {
    var localLifecycle = data && data.local ? data.local.lifecycle : null;
    var localOwned = Boolean(data && data.local && data.local.owned);
    var starting = localLifecycle === 'starting';
    var stopping = localLifecycle === 'stopping';
    if (sendBtn && pendingButtons.indexOf(sendBtn) === -1) {
      sendBtn.disabled = running;
      if (running && !sendBtn.dataset.origLabel) {
        sendBtn.dataset.origLabel = sendBtn.textContent;
      }
      if (running) {
        sendBtn.textContent = 'Running…';
      } else if (sendBtn.dataset.origLabel) {
        sendBtn.textContent = sendBtn.dataset.origLabel;
        sendBtn.dataset.origLabel = '';
      }
    }
    if (cancelBtn) {
      cancelBtn.hidden = !running;
      cancelBtn.disabled = !running;
    }
    if (sendBtn) {
      sendBtn.hidden = running;
    }
    if (composerEl) {
      composerEl.disabled = running;
    }
    if (permissionBtnEl) {
      permissionBtnEl.disabled = running;
    }
    if (clearKeyBtn && pendingButtons.indexOf(clearKeyBtn) === -1) {
      clearKeyBtn.disabled = !hasKey;
    }
    if (startLocalBtn && pendingButtons.indexOf(startLocalBtn) === -1) {
      startLocalBtn.classList.remove('runtime-running');
      if (starting) {
        startLocalBtn.disabled = true;
        startLocalBtn.classList.add('is-pending');
        startLocalBtn.textContent = 'Starting';
      } else if (localLifecycle === 'running') {
        startLocalBtn.disabled = true;
        startLocalBtn.classList.remove('is-pending');
        startLocalBtn.classList.add('runtime-running');
        startLocalBtn.textContent = 'Running';
      } else if (startLocalBtn.dataset.origLabel) {
        startLocalBtn.classList.remove('is-pending');
        startLocalBtn.textContent = startLocalBtn.dataset.origLabel;
        startLocalBtn.dataset.origLabel = '';
        startLocalBtn.disabled = false;
      } else {
        startLocalBtn.classList.remove('is-pending');
        startLocalBtn.textContent = 'Start Muse Glimmer';
        startLocalBtn.disabled = false;
      }
    }
    if (stopLocalBtn && pendingButtons.indexOf(stopLocalBtn) === -1) {
      if (stopping) {
        stopLocalBtn.disabled = true;
        stopLocalBtn.classList.add('is-pending');
        stopLocalBtn.textContent = 'Stopping';
      } else {
        stopLocalBtn.classList.remove('is-pending');
        stopLocalBtn.textContent = 'Stop';
        stopLocalBtn.dataset.origLabel = '';
        stopLocalBtn.disabled = !localOwned || (localLifecycle !== 'running' && localLifecycle !== 'starting');
      }
    }
  }

  function isStateMessage(data) {
    return (
      data !== null &&
      typeof data === 'object' &&
      !Array.isArray(data) &&
      data.type === 'state' &&
      (data.screen === 'chat' || data.screen === 'settings') &&
      typeof data.hasKey === 'boolean' &&
      typeof data.running === 'boolean' &&
      typeof data.status === 'string' &&
      typeof data.connection === 'string' &&
      typeof data.runtime === 'string' &&
      (data.runtime === 'cloud' || data.runtime === 'local') &&
      Array.isArray(data.threads) &&
      (data.activeThreadId === null ||
        typeof data.activeThreadId === 'string') &&
      Array.isArray(data.turns)
    );
  }

  function localInputs() {
    return [exePathEl, modelPathEl, projectorPathEl, draftPathEl, localModelIdEl, contextSizeEl, localPortEl, idleTimeoutEl];
  }

  function isEditingLocal() {
    var active = document.activeElement;
    if (!active) {
      return false;
    }
    return localInputs().indexOf(active) !== -1;
  }

  function fillLocalFields(settings) {
    if (!settings || typeof settings !== 'object') {
      return;
    }
    if (exePathEl) {
      exePathEl.value = typeof settings.executablePath === 'string' ? settings.executablePath : '';
    }
    if (modelPathEl) {
      modelPathEl.value = typeof settings.modelPath === 'string' ? settings.modelPath : '';
    }
    if (projectorPathEl) {
      projectorPathEl.value = typeof settings.projectorPath === 'string' ? settings.projectorPath : '';
    }
    if (draftPathEl) {
      draftPathEl.value = typeof settings.draftModelPath === 'string' ? settings.draftModelPath : '';
    }
    if (localModelIdEl) {
      localModelIdEl.value = typeof settings.modelId === 'string' ? settings.modelId : '';
    }
    if (contextSizeEl && typeof settings.contextSize === 'number') {
      contextSizeEl.value = String(settings.contextSize);
    }
    if (localPortEl && typeof settings.port === 'number') {
      localPortEl.value = String(settings.port);
    }
    if (idleTimeoutEl && typeof settings.idleTimeoutSec === 'number') {
      idleTimeoutEl.value = String(settings.idleTimeoutSec);
    }
  }

  function applyProviderVisibility(runtime) {
    var isCloud = runtime !== 'local';
    if (cloudSectionEl) {
      cloudSectionEl.hidden = !isCloud;
    }
    if (localSectionEl) {
      localSectionEl.hidden = isCloud;
    }
    // Escalation (local -> cloud) is only relevant for the Local provider.
    if (escalationSectionEl) {
      escalationSectionEl.hidden = isCloud;
    }
  }

  function renderCatalog(data) {
    if (!cloudModelSelectEl) {
      return;
    }
    var catalog = Array.isArray(data.cloudCatalog) ? data.cloudCatalog : [];
    var selected = typeof data.cloudModel === 'string' ? data.cloudModel : currentCloudModel;
    currentCloudModel = selected;
    while (cloudModelSelectEl.firstChild) {
      cloudModelSelectEl.removeChild(cloudModelSelectEl.firstChild);
    }
    catalog.forEach(function (entry) {
      if (!entry || typeof entry.id !== 'string') {
        return;
      }
      var option = document.createElement('option');
      option.value = entry.id;
      option.textContent = typeof entry.label === 'string' ? entry.label : entry.id;
      if (entry.id === selected) {
        option.selected = true;
      }
      cloudModelSelectEl.appendChild(option);
    });
    if (cloudModelSelectEl.options.length > 0 && cloudModelSelectEl.value !== selected) {
      setSelectValue(cloudModelSelectEl, selected);
    }
    var source = data.cloudCatalogSource === 'live' ? 'Live' : 'Fallback';
    var status = source + ' catalog: ' + String(catalog.length) + ' compatible model(s).';
    if (data.cloudCatalogSource !== 'live') {
      status += ' Save a key or refresh to load live models.';
    }
    setText(catalogStatusEl, status);
  }

  function renderLocal(data) {
    var local = data.local || { lifecycle: 'stopped', owned: false, endpoint: null, diagnostics: '' };
    var label = 'Local runtime is stopped.';
    if (local.lifecycle === 'starting') {
      label = 'Local runtime is starting…';
    } else if (local.lifecycle === 'running') {
      label = 'Local runtime is running on ' + (local.endpoint || 'loopback') + (local.owned ? ' (owned by RAME Code).' : ' (external, not owned).');
    } else if (local.lifecycle === 'stopping') {
      label = 'Local runtime is stopping…';
    } else if (data.externalLocalEndpoint) {
      label = 'External endpoint selected: ' + data.externalLocalEndpoint + ' (not owned).';
    }
    setText(localStatusEl, label);
    if (localStatusEl) {
      localStatusEl.setAttribute('data-state', String(local.lifecycle || 'stopped'));
    }
    var runtimeLine = '';
    if (local.lifecycle === 'running' || local.lifecycle === 'starting') {
      runtimeLine = 'Local runtime: ' + local.lifecycle + ' — ' + (local.endpoint || '');
    } else if (data.runtime === 'local' && data.externalLocalEndpoint) {
      runtimeLine = 'Local runtime: external endpoint — ' + data.externalLocalEndpoint;
    }
    setText(runtimeStateEl, runtimeLine);
    setText(diagnosticsEl, local.diagnostics || 'No diagnostics.');
    // Bounded revision flag: fill every local field once per revision, but
    // never while the user is actively editing a local input.
    var rev = typeof data.localSettingsRev === 'number' ? data.localSettingsRev : -1;
    if (rev !== lastLocalRev && !isEditingLocal()) {
      fillLocalFields(data.localSettings);
      lastLocalRev = rev;
    }
  }

  function formatTokens(value) {
    return typeof value === 'number' ? String(value) + ' tokens' : 'unknown';
  }

  function renderGeneration(data) {
    var gen = data.generation;
    if (!gen || typeof gen !== 'object') {
      return;
    }
    generationTarget = { provider: gen.provider, model: gen.model };
    var providerLabel = gen.provider === 'local' ? 'Local' : 'Meta';
    setText(
      generationModelEl,
      providerLabel + ' · ' + gen.model + ' · context ' + formatTokens(gen.contextWindow) + ' per request.'
    );
    if (reasoningSelectEl && document.activeElement !== reasoningSelectEl) {
      // Only the levels this exact provider/model accepts are offered.
      while (reasoningSelectEl.firstChild) {
        reasoningSelectEl.removeChild(reasoningSelectEl.firstChild);
      }
      var options = Array.isArray(gen.reasoningOptions) ? gen.reasoningOptions : ['default'];
      options.forEach(function (level) {
        if (!Object.prototype.hasOwnProperty.call(REASONING_LABELS, level)) {
          return;
        }
        var option = document.createElement('option');
        option.value = level;
        option.textContent = REASONING_LABELS[level];
        reasoningSelectEl.appendChild(option);
      });
      setSelectValue(reasoningSelectEl, gen.reasoning);
      reasoningSelectEl.disabled = reasoningSelectEl.options.length <= 1;
    }
    var hint;
    if (gen.reasoningParam) {
      hint = 'Sent as ' + gen.reasoningParam + '. Model default sends no level (default: ' + gen.reasoningDefault + '). Reasoning cannot be turned off for this model.';
    } else {
      hint = 'No verified reasoning control for this model (' + gen.source + '), so only Model default is offered.';
    }
    if (gen.reasoningUnavailable) {
      hint += ' Your saved level ' + (REASONING_LABELS[gen.reasoningUnavailable] || gen.reasoningUnavailable) + ' does not apply here; Model default is used.';
    }
    setText(reasoningHintEl, hint);
    setText(
      budgetHintEl,
      'Automatic: ' + formatTokens(gen.autoOutputTokens) + ' for ' + providerLabel + ', lowered to fit the free context. A manual maximum replaces it for that provider only.'
    );
    if (maxOutputLocalEl && document.activeElement !== maxOutputLocalEl) {
      maxOutputLocalEl.value = typeof gen.maxOutputTokensLocal === 'number' ? String(gen.maxOutputTokensLocal) : '';
    }
    if (maxOutputCloudEl && document.activeElement !== maxOutputCloudEl) {
      maxOutputCloudEl.value = typeof gen.maxOutputTokensCloud === 'number' ? String(gen.maxOutputTokensCloud) : '';
    }
  }

  function readMaxOutput(input) {
    var raw = input ? String(input.value).trim() : '';
    if (raw.length === 0) {
      return null;
    }
    var value = Number(raw);
    // Invalid numbers go to the host as-is so it can refuse them with a message.
    return Number.isInteger(value) ? value : -1;
  }

  function fillSettingsForm(data) {
    if (allowEscalationEl) {
      allowEscalationEl.checked = data.allowCloudEscalation === true;
    }
    if (
      externalEndpointEl &&
      document.activeElement !== externalEndpointEl &&
      typeof data.externalLocalEndpoint === 'string'
    ) {
      externalEndpointEl.value = data.externalLocalEndpoint;
    }
  }

  window.addEventListener('message', function (event) {
    var data = event.data;
    if (!isStateMessage(data)) {
      return;
    }
    // Host confirmation arrived: clear async pending buttons first, then
    // render the confirmed state. Success is never claimed before this.
    restorePendingButtons();
    running = data.running;
    activeThreadId = data.activeThreadId;
    if (activeThreadId !== null) {
      viewingDraft = false;
    }
    hasKey = data.hasKey;
    renderThreads(data.threads);
    renderHomeVsConversation();
    showScreen(data.screen);
    setText(connectionEl, connectionText(data.connection));
    setText(settingsConnectionEl, connectionText(data.connection));
    setText(statusEl, data.status);
    setText(settingsStatusEl, data.status);
    setText(scopeNoticeEl, data.notice || '');
    renderTurns(data.turns, data.running);
    renderHomeVsConversation();
    currentRuntime = data.runtime;
    localReady = Boolean(
      data.local && data.local.lifecycle === 'running' && data.local.endpoint
    ) || Boolean(data.externalLocalEndpoint);
    currentMode = data.mode;
    if (typeof data.cloudModel === 'string') {
      currentCloudModel = data.cloudModel;
    }
    setSelectValue(runtimeSelectEl, data.runtime);
    setSelectValue(modeSelectEl, data.mode);
    setText(runtimeStatusEl, 'Runtime: ' + runtimeDisplayName(data.runtime, currentCloudModel));
    applyProviderVisibility(data.runtime);
    renderCatalog(data);
    var usageLine =
      formatUsage('Last call', data.usageLast) +
      '  |  ' +
      formatUsage('Cloud total', data.usageCloud) +
      '  |  ' +
      formatUsage('Local total', data.usageLocal) +
      ' (Meta Billing/Usage is authoritative; no balance is shown.)';
    setText(usageEl, usageLine);
    var esc = data.escalation || { pending: false, reason: '' };
    if (escalationBox) {
      escalationBox.hidden = !esc.pending;
    }
    setText(escalationReasonEl, esc.reason || '');
    renderLocal(data);
    renderAgent(data);
    renderGeneration(data);
    fillSettingsForm(data);
    refreshControls(data);
  });

  if (newThreadBtn) {
    newThreadBtn.addEventListener('click', function () {
      viewingDraft = true;
      if (composerEl) {
        composerEl.value = '';
        vscode.setState({ composerDraft: '' });
      }
      if (modeSelectEl) {
        modeSelectEl.value = 'agent';
        currentMode = 'agent';
        refreshAgentVisibility();
      }
      renderHomeVsConversation();
      vscode.postMessage({ type: 'newThread' });
    });
  }

  if (backToListBtn) {
    backToListBtn.addEventListener('click', function () {
      viewingDraft = false;
      closePermissionMenu();
      renderHomeVsConversation();
      vscode.postMessage({ type: 'backToList' });
    });
  }

  if (runtimeStatusEl) {
    runtimeStatusEl.addEventListener('click', function () {
      vscode.postMessage({ type: 'navigate', screen: 'settings' });
    });
  }

  if (runtimeNoticeSettingsBtn) {
    runtimeNoticeSettingsBtn.addEventListener('click', function () {
      vscode.postMessage({ type: 'navigate', screen: 'settings' });
    });
  }

  if (permissionBtnEl) {
    permissionBtnEl.addEventListener('click', function () {
      if (permissionMenuEl && permissionMenuEl.hidden) {
        openPermissionMenu();
      } else {
        closePermissionMenu();
      }
    });
  }

  if (permissionMenuEl) {
    var permButtons = permissionMenuEl.querySelectorAll('button[data-profile]');
    for (var pi = 0; pi < permButtons.length; pi++) {
      (function (permBtn) {
        permBtn.addEventListener('click', function () {
          var profile = permBtn.getAttribute('data-profile') || 'ask';
          closePermissionMenu();
          selectProfile(profile);
          if (permissionBtnEl) {
            permissionBtnEl.focus();
          }
        });
      })(permButtons[pi]);
    }
    document.addEventListener('keydown', function (event) {
      if (event.key === 'Escape') {
        closePermissionMenu();
      }
    });
    document.addEventListener('click', function (event) {
      if (!permissionMenuEl || permissionMenuEl.hidden) {
        return;
      }
      var target = event.target;
      if (target === permissionMenuEl || permissionMenuEl.contains(target)) {
        return;
      }
      if (target === permissionBtnEl || (permissionBtnEl && permissionBtnEl.contains(target))) {
        return;
      }
      closePermissionMenu();
    });
  }

  if (refreshBtn) {
    refreshBtn.addEventListener('click', function () {
      vscode.postMessage({ type: 'refresh' });
    });
  }

  if (openSettingsBtn) {
    openSettingsBtn.addEventListener('click', function () {
      vscode.postMessage({ type: 'navigate', screen: 'settings' });
    });
  }

  if (backBtn) {
    backBtn.addEventListener('click', function () {
      vscode.postMessage({ type: 'navigate', screen: 'chat' });
    });
  }

  function currentRuntimeId() {
    if (runtimeSelectEl && (runtimeSelectEl.value === 'local' || runtimeSelectEl.value === 'cloud')) {
      return runtimeSelectEl.value;
    }
    return currentRuntime;
  }

  if (sendBtn) {
    sendBtn.addEventListener('click', function () {
      if (running || sendBtn.disabled) {
        return;
      }
      var text = composerEl ? composerEl.value : '';
      var mode = modeSelectEl ? modeSelectEl.value : 'agent';
      if (currentRuntimeId() === 'local' && !localReady) {
        showRuntimeNotice(
          'The local model is not running. Start Muse Glimmer, choose Meta Model API, or configure an external OpenAI-compatible loopback server.'
        );
        return;
      }
      hideRuntimeNotice();
      if (!markPending(sendBtn, 'Running…')) {
        return;
      }
      setText(statusEl, 'Running…');
      if (composerEl) {
        composerEl.value = '';
        vscode.setState({ composerDraft: '' });
      }
      vscode.postMessage({ type: 'sendMessage', text: text, mode: mode, runtime: currentRuntimeId() });
    });
  }

  if (cancelBtn) {
    cancelBtn.addEventListener('click', function () {
      vscode.postMessage({ type: 'cancel' });
    });
  }

  if (escalateApproveBtn) {
    escalateApproveBtn.addEventListener('click', function () {
      vscode.postMessage({ type: 'escalateApprove' });
    });
  }

  if (escalateDismissBtn) {
    escalateDismissBtn.addEventListener('click', function () {
      vscode.postMessage({ type: 'escalateDismiss' });
    });
  }

  if (saveKeyBtn) {
    saveKeyBtn.addEventListener('click', function () {
      if (!markPending(saveKeyBtn, 'Saving…')) {
        return;
      }
      setText(settingsStatusEl, 'Saving…');
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

  function readLocalForm(type) {
    return {
      type: type || 'updateLocalSettings',
      executablePath: exePathEl ? exePathEl.value : '',
      modelPath: modelPathEl ? modelPathEl.value : '',
      projectorPath: projectorPathEl ? projectorPathEl.value : '',
      draftModelPath: draftPathEl ? draftPathEl.value : '',
      modelId: localModelIdEl ? localModelIdEl.value : '',
      contextSize: contextSizeEl ? Number(contextSizeEl.value) : NaN,
      port: localPortEl ? Number(localPortEl.value) : NaN,
      idleTimeoutSec: idleTimeoutEl ? Number(idleTimeoutEl.value) : NaN,
    };
  }

  function pushSettings() {
    vscode.postMessage({
      type: 'updateSettings',
      runtime: currentRuntimeId(),
      mode: modeSelectEl ? modeSelectEl.value : 'agent',
      allowCloudEscalation: allowEscalationEl ? allowEscalationEl.checked === true : false,
    });
  }

  function pushSettingsAndLocal() {
    pushSettings();
    vscode.postMessage(readLocalForm());
  }

  if (saveLocalBtn) {
    saveLocalBtn.addEventListener('click', function () {
      if (!markPending(saveLocalBtn, 'Saving…')) {
        return;
      }
      setText(settingsStatusEl, 'Saving…');
      pushSettingsAndLocal();
    });
  }

  if (useSuggestionsBtn) {
    useSuggestionsBtn.addEventListener('click', function () {
      if (!markPending(useSuggestionsBtn, 'Loading…')) {
        return;
      }
      vscode.postMessage({ type: 'useSuggestions' });
    });
  }

  if (startLocalBtn) {
    startLocalBtn.addEventListener('click', function () {
      // Atomic start: one exact-key message carrying the visible settings.
      // Pending state stays visible; starting may take minutes.
      if (!markPending(startLocalBtn, 'Starting…')) {
        return;
      }
      setText(localStatusEl, 'Local runtime is starting…');
      vscode.postMessage(readLocalForm('startLocal'));
    });
  }

  if (reasoningSelectEl) {
    reasoningSelectEl.addEventListener('change', function () {
      vscode.postMessage({
        type: 'setReasoning',
        provider: generationTarget.provider,
        model: generationTarget.model,
        level: reasoningSelectEl.value,
      });
    });
  }

  if (saveMaxOutputBtn) {
    saveMaxOutputBtn.addEventListener('click', function () {
      // One atomic message: either both maximums are saved or neither is.
      vscode.postMessage({
        type: 'setMaxOutputTokens',
        local: readMaxOutput(maxOutputLocalEl),
        cloud: readMaxOutput(maxOutputCloudEl),
      });
    });
  }

  if (cloudModelSelectEl) {
    cloudModelSelectEl.addEventListener('change', function () {
      vscode.postMessage({ type: 'selectCloudModel', model: cloudModelSelectEl.value });
    });
  }

  if (refreshModelsBtn) {
    refreshModelsBtn.addEventListener('click', function () {
      if (!markPending(refreshModelsBtn, 'Loading models…')) {
        return;
      }
      setText(catalogStatusEl, 'Loading models…');
      vscode.postMessage({ type: 'refreshModels' });
    });
  }

  if (stopLocalBtn) {
    stopLocalBtn.addEventListener('click', function () {
      if (!markPending(stopLocalBtn, 'Stopping…')) {
        return;
      }
      setText(localStatusEl, 'Stopping…');
      vscode.postMessage({ type: 'stopLocal' });
    });
  }

  if (selectExternalBtn) {
    selectExternalBtn.addEventListener('click', function () {
      vscode.postMessage({ type: 'selectExternalEndpoint', endpoint: externalEndpointEl ? externalEndpointEl.value : '' });
    });
  }

  if (clearExternalBtn) {
    clearExternalBtn.addEventListener('click', function () {
      if (externalEndpointEl) {
        externalEndpointEl.value = '';
      }
      vscode.postMessage({ type: 'clearExternalEndpoint' });
    });
  }

  if (allowEscalationEl) {
    allowEscalationEl.addEventListener('change', function () {
      pushSettings();
    });
  }

  if (runtimeSelectEl) {
    runtimeSelectEl.addEventListener('change', function () {
      hideRuntimeNotice();
      currentRuntime = currentRuntimeId();
      setText(runtimeStatusEl, 'Runtime: ' + runtimeDisplayName(currentRuntime, currentCloudModel));
      applyProviderVisibility(currentRuntime);
      pushSettings();
    });
  }

  if (modeSelectEl) {
    modeSelectEl.addEventListener('change', function () {
      currentMode = modeSelectEl.value;
      refreshAgentVisibility();
    });
  }

  if (composerEl) {
    composerEl.addEventListener('input', function () {
      vscode.setState({ composerDraft: composerEl.value });
    });
  }

  if (profileSelectEl) {
    profileSelectEl.addEventListener('change', function () {
      var profile = profileSelectEl.value;
      refreshAgentVisibility();
      setText(permissionChipEl, shortProfileName(profile));
      vscode.postMessage({ type: 'setAgentProfile', profile: profile });
    });
  }

  if (pendingApproveBtn) {
    pendingApproveBtn.addEventListener('click', function () {
      if (pendingActionRef) {
        if (!markPending(pendingApproveBtn, 'Approving…')) {
          return;
        }
        vscode.postMessage({
          type: 'approveAgentAction',
          actionId: pendingActionRef.actionId,
          digest: pendingActionRef.digest,
        });
      }
    });
  }

  if (pendingRejectBtn) {
    pendingRejectBtn.addEventListener('click', function () {
      if (pendingActionRef) {
        if (!markPending(pendingRejectBtn, 'Rejecting…')) {
          return;
        }
        vscode.postMessage({
          type: 'rejectAgentAction',
          actionId: pendingActionRef.actionId,
          digest: pendingActionRef.digest,
        });
      }
    });
  }

  refreshAgentVisibility();
  refreshControls();
  renderHomeVsConversation();
  closePermissionMenu();

  // Signal readiness only after the message listener and controls exist,
  // so the host can (re)send initial state without it being missed.
  vscode.postMessage({ type: 'ready' });
})();
