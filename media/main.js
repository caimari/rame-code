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

  // Interface language. English is the source; media/i18n.js holds the
  // other tables. Only interface text is translated: user, model, and file
  // content, exact approval bodies, and the host record are shown as is.
  var I18N = window.RAME_I18N || null;
  var language = 'en';

  function t(text) {
    return I18N && language !== 'en' ? I18N.translate(language, text) : text;
  }

  // Translate a template with {0}, {1}… slots; values are inserted verbatim.
  function tf(template) {
    var args = Array.prototype.slice.call(arguments, 1);
    return t(template).replace(/\{(\d+)\}/g, function (whole, index) {
      return Number(index) < args.length ? String(args[Number(index)]) : whole;
    });
  }

  // Host messages: exact text, a known pattern, else sentence by sentence.
  function tHost(text) {
    return I18N && language !== 'en' ? I18N.translateHost(language, text) : text;
  }

  // Static markup text, recorded once in English so it can be switched back
  // and forth. Text set later by the script is re-rendered instead.
  var staticElements = [];
  var staticNodes = [];
  var staticAttrs = [];

  function collectStaticText() {
    var walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    var node = walker.nextNode();
    while (node) {
      var parent = node.parentNode;
      var trimmed = node.nodeValue.trim();
      if (trimmed.length > 0 && parent && parent.nodeName !== 'SCRIPT' && parent.nodeName !== 'STYLE') {
        if (parent.childNodes.length === 1) {
          parent.setAttribute('data-i18n', trimmed);
          staticElements.push(parent);
        } else {
          staticNodes.push({ node: node, raw: node.nodeValue, en: trimmed });
        }
      }
      node = walker.nextNode();
    }
    ['title', 'aria-label', 'placeholder'].forEach(function (attr) {
      var found = document.body.querySelectorAll('[' + attr + ']');
      for (var i = 0; i < found.length; i++) {
        staticAttrs.push({ el: found[i], attr: attr, en: found[i].getAttribute(attr) });
      }
    });
  }

  function applyStaticText() {
    staticElements.forEach(function (item) {
      item.textContent = t(item.getAttribute('data-i18n'));
    });
    staticNodes.forEach(function (entry) {
      entry.node.nodeValue = entry.raw.replace(entry.en, t(entry.en));
    });
    staticAttrs.forEach(function (entry) {
      entry.el.setAttribute(entry.attr, t(entry.en));
    });
    document.documentElement.lang = language;
  }

  collectStaticText();

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
  var consultBoxEl = el('consultBox');
  var consultReasonEl = el('consultReason');
  var consultPayloadEl = el('consultPayload');
  var consultMetaEl = el('consultMeta');
  var consultApproveBtn = el('consultApprove');
  var consultDismissBtn = el('consultDismiss');
  // The exact consultation the host showed; approval echoes only its digest.
  var consultShown = null;
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
  var memoryProjectEl = el('memoryProject');
  var memoryPendingCardEl = el('memoryPendingCard');
  var memoryPendingTextEl = el('memoryPendingText');
  var memoryApproveBtn = el('memoryApprove');
  var memoryRejectBtn = el('memoryReject');
  var memoryDecisionsEl = el('memoryDecisions');
  var memoryArtifactsEl = el('memoryArtifacts');
  var memoryHistoryEl = el('memoryHistory');
  var memoryKeyEl = el('memoryKey');
  var memoryValueTypeEl = el('memoryValueType');
  var memoryValueEl = el('memoryValue');
  var memoryProposeBtn = el('memoryPropose');
  var memoryNoteEl = el('memoryNote');
  var memoryProjectPickerEl = el('memoryProjectPicker');
  var memoryProjectSelectEl = el('memoryProjectSelect');
  var memoryStatusEl = el('memoryStatus');
  var languageSelectEl = el('languageSelect');
  // The exact card the host showed; approve/reject echo only these ids.
  var memoryCard = null;
  // Set by a memory action: the next host state is its answer and is shown
  // inside Project memory, not only at the bottom of Settings.
  var memoryAwaiting = false;
  // Last answer shown there, kept in English so it follows the language.
  var memoryFeedback = null;
  var lastState = null;
  var missionSummaryEl = el('missionSummary');
  var missionTasksEl = el('missionTasks');
  var missionDecisionsEl = el('missionDecisions');
  var missionEvidenceEl = el('missionEvidence');
  var missionRunBtn = el('missionRun');
  var missionAutoStatusEl = el('missionAutoStatus');
  var missionOpenThreadBtn = el('missionOpenThread');
  var missionModeEl = el('missionMode');
  var missionConsultRowEl = el('missionConsultRow');
  var missionConsultsEl = el('missionConsults');
  var missionStartBtn = el('missionStart');
  var missionTrustedEl = el('missionTrusted');
  var missionAcceptanceCommandEl = el('missionAcceptanceCommand');
  var missionAcceptanceFilterEl = el('missionAcceptanceFilter');
  var missionAcceptanceListEl = el('missionAcceptanceList');
  var missionPauseBtn = el('missionPause');
  var missionResumeBtn = el('missionResume');
  var missionCancelBtn = el('missionCancel');
  var missionCardEl = el('missionCard');
  var missionCardHeadingEl = el('missionCardHeading');
  var missionPhaseEl = el('missionPhase');
  var missionStartNoteEl = el('missionStartNote');
  var missionFactsEl = el('missionFacts');
  var missionSetupEl = el('missionSetup');
  var missionLevelVerifiedEl = el('missionLevelVerified');
  var missionLevelStandardEl = el('missionLevelStandard');
  var missionVerifiedRowEl = el('missionVerifiedRow');
  var missionFrozenSummaryEl = el('missionFrozenSummary');
  var missionAdvancedEl = el('missionAdvancedVerification');
  var missionAdvancedListEl = el('missionAdvancedList');
  var missionStartErrorEl = el('missionStartError');
  var missionReportEl = el('missionReport');
  var missionReportFactsEl = el('missionReportFacts');
  var missionBlockedEl = el('missionBlocked');
  var missionBlockedFactsEl = el('missionBlockedFacts');
  var missionReviewBtn = el('missionReview');
  var missionReviewListEl = el('missionReviewList');
  var missionRetryOpenBtn = el('missionRetryOpen');
  var missionRetryFormEl = el('missionRetryForm');
  var missionGuidanceEl = el('missionGuidance');
  var missionRetryBtn = el('missionRetry');
  var missionRetryErrorEl = el('missionRetryError');
  var missionBlockedCancelBtn = el('missionBlockedCancel');
  var versionBadgeEl = el('versionBadge');
  var aboutFactsEl = el('aboutFacts');
  var settingsNavEl = el('settingsNav');
  // The Mission (id + revision) the view last showed.
  var missionShown = null;
  // The live Mission card of the open thread (host data), the start click
  // this view sent and is waiting for, and the start already announced.
  var missionLive = null;
  var missionStartLocal = null;
  var missionStartAnnounced = null;
  // Acceptance files the user ticked, and the candidate list last drawn.
  var acceptanceChosen = {};
  var acceptanceDrawn = '';
  var missionTimeEl = null;
  var MISSION_STATUS_LABELS = {
    active: 'active',
    waiting_approval: 'waiting for your approval',
    interrupted: 'interrupted',
    completed: 'completed',
    failed: 'failed',
    paused: 'paused',
    cancelled: 'cancelled',
    blocked: 'blocked',
  };
  // Mission phases as the view names them. "Completed — acceptance passed"
  // only when the host's own acceptance run exited 0; a created plan is
  // "Plan ready — awaiting authorization", never "Completed".
  var MISSION_PHASE_LABELS = {
    planning: 'Planning',
    plan_ready: 'Plan ready — awaiting authorization',
    authorizing: 'Authorizing',
    running: 'Running',
    waiting_approval: 'Waiting for your approval',
    paused: 'Paused',
    blocked: 'Blocked',
    completed: 'Completed — acceptance passed',
    completed_standard: 'Completed — project tests passed',
    cancelled: 'Cancelled',
    interrupted: 'Interrupted',
    failed: 'Failed',
    no_plan: 'No Mission plan was created; see the reply',
  };
  var START_LABELS = {
    idle: 'Authorize and start',
    pending: 'Authorizing…',
    started: 'Mission started',
    unconfirmed: 'RAME Code did not confirm the start. Check the Mission state before trying again.',
  };
  var START_CONFIRM_TIMEOUT_MS = 20000;
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
      return viewingDraft ? t('New thread') : t('Threads');
    }
    for (var i = 0; i < lastThreads.length; i++) {
      if (lastThreads[i] && lastThreads[i].id === id) {
        var title = String(lastThreads[i].title || '').trim();
        return title.length > 0 ? title : t('Conversation');
      }
    }
    return t('Conversation');
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
      return tf('Updated {0}', date.toLocaleString(language));
    } catch (e) {
      return '';
    }
  }

  function renderPlanTurn(container, plan) {
    var goalHeading = document.createElement('h4');
    goalHeading.textContent = t('Plan');
    container.appendChild(goalHeading);
    var goal = document.createElement('p');
    goal.textContent = String(plan.goal || '');
    container.appendChild(goal);
    if (Array.isArray(plan.assumptions) && plan.assumptions.length > 0) {
      var aHeading = document.createElement('h4');
      aHeading.textContent = t('Assumptions');
      container.appendChild(aHeading);
      addList(container, plan.assumptions);
    }
    if (Array.isArray(plan.steps) && plan.steps.length > 0) {
      var sHeading = document.createElement('h4');
      sHeading.textContent = t('Steps');
      container.appendChild(sHeading);
      var steps = document.createElement('ol');
      plan.steps.forEach(function (step) {
        var li = document.createElement('li');
        var title = document.createElement('p');
        title.textContent = String(step.title || '');
        li.appendChild(title);
        var criterion = document.createElement('p');
        criterion.textContent = tf('Success criterion: {0}', String(step.successCriterion || ''));
        li.appendChild(criterion);
        steps.appendChild(li);
      });
      container.appendChild(steps);
    }
    if (Array.isArray(plan.risks) && plan.risks.length > 0) {
      var rHeading = document.createElement('h4');
      rHeading.textContent = t('Risks');
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
      if (btn.getAttribute('data-i18n')) {
        btn.textContent = t(btn.getAttribute('data-i18n'));
      } else if (btn.dataset.origLabel) {
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
    box.setAttribute('aria-label', t('Host record, verified by RAME Code'));
    var head = document.createElement('h5');
    head.textContent = t('Host record \u2014 verified by RAME Code, not written by the model');
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

  // How a reply is shown follows the host's own record of what ran, never the
  // model's text: no tools → a plain message; reads only → a plain message
  // with the activity folded; any write, test, memory change, or cascade →
  // the result card with its record shown.
  var MODE_NAMES = { agent: 'Agent', chat: 'Chat only', mission: 'Mission' };
  var READ_ONLY_TOOLS = ['list_files', 'inspect_workspace', 'filesystem_usage', 'search_text', 'read_file', 'read_decisions'];

  function replyKind(turn) {
    var record = Array.isArray(turn.hostRecord) ? turn.hostRecord : [];
    var lines = record.filter(function (line) {
      return String(line) !== '\u2022 No tool actions ran.';
    });
    if (lines.length === 0) {
      return 'conversation';
    }
    var onlyReads = lines.every(function (line) {
      var match = /^\u2022\s*([a-z_]+)[\s\u2192]/.exec(String(line));
      return match !== null && READ_ONLY_TOOLS.indexOf(match[1]) !== -1;
    });
    return onlyReads ? 'read' : 'work';
  }

  function renderFoldedRecord(container, record) {
    var lines = Array.isArray(record) ? record : [];
    if (lines.length === 0) {
      return;
    }
    var details = document.createElement('details');
    details.className = 'host-record-folded';
    var summary = document.createElement('summary');
    summary.textContent = tf('Read-only activity verified by RAME Code ({0})', lines.length);
    details.appendChild(summary);
    renderHostRecord(details, lines);
    container.appendChild(details);
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
    var lastTurn = turns[turns.length - 1];
    if (!isRunning && lastTurn && lastTurn.kind === 'assistant' && replyKind(lastTurn) === 'work') {
      finalResultIndex = turns.length - 1;
      setText(resultBodyEl, cleanAgentResult(turns[finalResultIndex].text));
      renderHostRecord(resultHostRecordEl, turns[finalResultIndex].hostRecord);
      if (resultSectionEl) {
        resultSectionEl.hidden = false;
      }
    }
    // The mode each message was sent in; a change is shown in the thread.
    var previousMode = null;
    // A host-written Mission prompt and the reply to it are folded into one
    // "internal run" entry; the Mission's final report stays in view.
    var internalRun = null;
    var internalCount = 0;
    turns.forEach(function (turn, turnIndex) {
      if (turnIndex === finalResultIndex) {
        return;
      }
      var card = document.createElement('div');
      card.className = 'turn';
      if (turn.kind === 'user') {
        card.classList.add('turn-user');
        var who = document.createElement('h4');
        who.textContent = t('You');
        card.appendChild(who);
        var text = document.createElement('p');
        text.textContent = String(turn.text || '');
        card.appendChild(text);
        var mode = MODE_NAMES[turn.mode] ? turn.mode : null;
        if (mode !== null && previousMode !== null && mode !== previousMode) {
          var change = document.createElement('p');
          change.className = 'mode-change hint';
          change.textContent = tf('Mode changed to {0} for this message. The permission profile did not change.', t(MODE_NAMES[mode]));
          card.insertBefore(change, card.firstChild);
        }
        if (mode !== null) {
          previousMode = mode;
        }
      } else if (turn.kind === 'assistant') {
        card.classList.add('turn-assistant');
        var asst = document.createElement('h4');
        asst.textContent = t('Assistant');
        card.appendChild(asst);
        var reply = document.createElement('p');
        reply.textContent = cleanAgentResult(String(turn.text || ''));
        card.appendChild(reply);
        var kind = replyKind(turn);
        if (kind === 'read') {
          renderFoldedRecord(card, turn.hostRecord);
        } else if (kind === 'work') {
          renderHostRecord(card, turn.hostRecord);
        }
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
        errHead.textContent = isCancelled ? t('Cancelled') : (isNotice ? t('Action cancelled') : t('Run stopped'));
        card.appendChild(errHead);
        var err = document.createElement('p');
        err.textContent = tHost(errText);
        card.appendChild(err);
        if (errText.indexOf('Local model is not reachable at ') !== -1 && errText.indexOf('Start it in Settings.') !== -1) {
          var errAction = document.createElement('button');
          errAction.type = 'button';
          errAction.textContent = t('Open Settings');
          errAction.setAttribute('aria-label', t('Open Settings to start the local model'));
          errAction.addEventListener('click', function () {
            vscode.postMessage({ type: 'navigate', screen: 'settings' });
          });
          card.appendChild(errAction);
        }
      } else {
        var unknown = document.createElement('p');
        unknown.textContent = t('Unsupported turn.');
        card.appendChild(unknown);
      }
      if (!transcriptEl) {
        return;
      }
      if (turn.kind === 'user' && turn.host === true) {
        internalCount += 1;
        internalRun = document.createElement('details');
        internalRun.className = 'mission-internal-run';
        var runSummary = document.createElement('summary');
        runSummary.textContent = tf('Internal Mission run {0}', internalCount);
        internalRun.appendChild(runSummary);
        internalRun.appendChild(card);
        transcriptEl.appendChild(internalRun);
        return;
      }
      if (internalRun !== null && (turn.kind === 'assistant' || turn.kind === 'error')) {
        internalRun.appendChild(card);
        internalRun = null;
        return;
      }
      internalRun = null;
      transcriptEl.appendChild(card);
    });
  }

  function renderThreads(threads) {
    clearEl(threadListEl);
    lastThreads = Array.isArray(threads) ? threads.slice() : [];
    if (!Array.isArray(threads) || threads.length === 0) {
      var empty = document.createElement('li');
      empty.textContent = t('No threads yet.');
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
      var title = String((thread && thread.title) || t('Untitled'));
      btn.textContent = title;
      btn.title = title;
      btn.setAttribute('aria-label', tf('Open thread {0}', title));
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
      deleteBtn.title = t('Delete thread');
      deleteBtn.setAttribute('aria-label', tf('Delete thread {0}', title));
      deleteBtn.addEventListener('click', function (event) {
        event.stopPropagation();
        if (li.querySelector('.thread-confirm')) {
          return;
        }
        var confirmRow = document.createElement('div');
        confirmRow.className = 'thread-confirm';
        confirmRow.setAttribute('role', 'group');
        confirmRow.setAttribute('aria-label', tf('Confirm deletion of {0}', title));

        var question = document.createElement('span');
        question.className = 'thread-confirm-text';
        question.textContent = t('Delete this thread?');
        confirmRow.appendChild(question);

        var confirmDelete = document.createElement('button');
        confirmDelete.type = 'button';
        confirmDelete.className = 'thread-confirm-delete';
        confirmDelete.textContent = t('Delete');
        confirmDelete.setAttribute('aria-label', tf('Confirm delete {0}', title));
        confirmDelete.addEventListener('click', function (confirmEvent) {
          confirmEvent.stopPropagation();
          confirmDelete.disabled = true;
          cancelDelete.disabled = true;
          confirmDelete.textContent = t('Deleting…');
          vscode.postMessage({ type: 'deleteThread', threadId: thread.id });
        });

        var cancelDelete = document.createElement('button');
        cancelDelete.type = 'button';
        cancelDelete.className = 'thread-confirm-cancel';
        cancelDelete.textContent = t('Cancel');
        cancelDelete.setAttribute('aria-label', tf('Cancel delete {0}', title));
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
        return t('Not connected — API key required');
      case 'ready':
        return t('Key stored — live connection not yet verified');
      case 'working':
        return t('Working…');
      case 'done':
        return t('Plan ready');
      case 'verified':
        return t('Connected — verified');
      case 'cancelled':
        return t('Cancelled');
      case 'error':
        return t('Error');
      default:
        return String(connection);
    }
  }

  function formatUsage(label, usage) {
    if (!usage) {
      return t(label) + ': —';
    }
    return tf(
      '{0}: in {1} / out {2} / cached {3} / total {4}',
      t(label),
      usage.inputTokens,
      usage.outputTokens,
      usage.cachedTokens,
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
      return t('Safe auto — reads run automatically; writes and tests need approval.');
    }
    if (profile === 'workspace-full') {
      return t('Workspace full (high risk) — reads, patches, and allowlisted tests run without prompts.');
    }
    return t('Ask (safest) — every tool action needs your approval.');
  }

  function runtimeDisplayName(runtime, cloudModel) {
    if (runtime === 'local') {
      return t('Muse Glimmer — Local');
    }
    var model = typeof cloudModel === 'string' && cloudModel.length > 0 ? cloudModel : currentCloudModel;
    return tf('Meta Model API — Cloud ({0})', model);
  }

  function runtimeShortName(runtime) {
    if (runtime === 'local') {
      return t('Muse Glimmer — Local');
    }
    return t('Meta Model API — Cloud');
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
      return t('Safe auto');
    }
    if (profile === 'workspace-full') {
      return t('Workspace full');
    }
    return t('Ask');
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
    var workspace = data.agentWorkspace || t('no workspace open');
    setText(profileDescEl, profileDescription(profile) + ' ' + tf('Workspace: {0}.', workspace));
    setText(permissionChipEl, shortProfileName(profile));
    if (workspaceBadgeEl) {
      if (data.agentWorkspace) {
        workspaceBadgeEl.hidden = false;
        workspaceBadgeEl.textContent = tf('Workspace: {0}', String(data.agentWorkspace));
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
    var settled = !data.running && outcome !== 'error' ? runOutcomeLabel(data, outcome, activeThreadId) : null;
    if (runIndicatorEl) {
      runIndicatorEl.hidden = !data.running && outcome === null && settled === null;
      runIndicatorEl.setAttribute(
        'data-state',
        pending ? 'approval' : (data.running ? 'working' : settled !== null ? settled.state : (outcome || 'working'))
      );
    }
    setText(
      runIndicatorTextEl,
      pending
        ? t('Waiting for your approval')
        : data.running
          ? tHost(String(data.status || 'Working…'))
          : settled !== null
            ? t(settled.text)
            : outcome === 'error'
              ? t('Error') + ' — ' + tHost(String(data.status || 'the run stopped.'))
              : ''
    );
    if (pending) {
      setText(pendingToolEl, tf('Tool: {0}', String(pending.tool || '')));
      setText(pendingTargetsEl, tf('Targets: {0}', Array.isArray(pending.targets) ? pending.targets.join(', ') : ''));
      // The host already bounds the preview and appends an explicit
      // truncation marker; keep that marker visible. The exact action is
      // never translated: it is what the approval is bound to.
      setText(pendingBodyEl, tf('Exact action: {0}', String(pending.bodyPreview || '').slice(0, 2200)));
      setText(
        pendingMetaEl,
        tf(
          'Provider: {0} | Workspace: {1} | Thread: {2} | Digest: {3} — approval is one-use and hash-bound; the host verifies before running.',
          String(pending.provider || ''),
          String(pending.workspaceId || workspace),
          String(pending.threadId || ''),
          String(pending.digest || '').slice(0, 16)
        )
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
        renderActivityCard(t('Working…'), tHost(String(data.status || 'Running…')))
      );
    }
    if (pending && activityListEl) {
      activityListEl.appendChild(
        renderActivityCard(
          tf('Pending approval: {0}', String(pending.tool || '')),
          tf(
            'Targets: {0} | Digest: {1}',
            Array.isArray(pending.targets) ? pending.targets.join(', ') : '',
            String(pending.digest || '').slice(0, 16)
          )
        )
      );
    }
    log.forEach(function (entry) {
      var li = document.createElement('li');
      li.textContent =
        String(entry.tool || '') + ' [' + String(entry.digest || '').slice(0, 12) + '] ' +
        t(String(entry.decision || '')) + ' — ' + String(entry.result || '').slice(0, 160);
      if (actionLogEl) {
        actionLogEl.appendChild(li);
      }
      if (activityListEl) {
        activityListEl.appendChild(
          renderActivityCard(
            String(entry.tool || '') + ' — ' + t(String(entry.decision || '')),
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
        sendBtn.textContent = t('Running…');
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
        startLocalBtn.textContent = t('Starting');
      } else if (localLifecycle === 'running') {
        startLocalBtn.disabled = true;
        startLocalBtn.classList.remove('is-pending');
        startLocalBtn.classList.add('runtime-running');
        startLocalBtn.textContent = t('Running');
      } else if (startLocalBtn.dataset.origLabel) {
        startLocalBtn.classList.remove('is-pending');
        startLocalBtn.textContent = t('Start Muse Glimmer');
        startLocalBtn.dataset.origLabel = '';
        startLocalBtn.disabled = false;
      } else {
        startLocalBtn.classList.remove('is-pending');
        startLocalBtn.textContent = t('Start Muse Glimmer');
        startLocalBtn.disabled = false;
      }
    }
    if (stopLocalBtn && pendingButtons.indexOf(stopLocalBtn) === -1) {
      if (stopping) {
        stopLocalBtn.disabled = true;
        stopLocalBtn.classList.add('is-pending');
        stopLocalBtn.textContent = t('Stopping');
      } else {
        stopLocalBtn.classList.remove('is-pending');
        stopLocalBtn.textContent = t('Stop');
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
    var status =
      data.cloudCatalogSource === 'live'
        ? tf('Live catalog: {0} compatible model(s).', String(catalog.length))
        : tf('Fallback catalog: {0} compatible model(s).', String(catalog.length)) + ' ' + t('Save a key or refresh to load live models.');
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
    setText(localStatusEl, tHost(label));
    if (localStatusEl) {
      localStatusEl.setAttribute('data-state', String(local.lifecycle || 'stopped'));
    }
    var runtimeLine = '';
    if (local.lifecycle === 'running' || local.lifecycle === 'starting') {
      runtimeLine = tf(local.lifecycle === 'running' ? 'Local runtime: running — {0}' : 'Local runtime: starting — {0}', local.endpoint || '');
    } else if (data.runtime === 'local' && data.externalLocalEndpoint) {
      runtimeLine = tf('Local runtime: external endpoint — {0}', data.externalLocalEndpoint);
    }
    setText(runtimeStateEl, runtimeLine);
    // Process diagnostics are shown as the process wrote them.
    setText(diagnosticsEl, local.diagnostics || t('No diagnostics.'));
    // Bounded revision flag: fill every local field once per revision, but
    // never while the user is actively editing a local input.
    var rev = typeof data.localSettingsRev === 'number' ? data.localSettingsRev : -1;
    if (rev !== lastLocalRev && !isEditingLocal()) {
      fillLocalFields(data.localSettings);
      lastLocalRev = rev;
    }
  }

  function formatTokens(value) {
    return typeof value === 'number' ? tf('{0} tokens', String(value)) : t('unknown');
  }

  function renderGeneration(data) {
    var gen = data.generation;
    if (!gen || typeof gen !== 'object') {
      return;
    }
    generationTarget = { provider: gen.provider, model: gen.model };
    var providerLabel = gen.provider === 'local' ? t('Local') : 'Meta';
    setText(generationModelEl, tf('{0} · {1} · context {2} per request.', providerLabel, gen.model, formatTokens(gen.contextWindow)));
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
        option.textContent = t(REASONING_LABELS[level]);
        reasoningSelectEl.appendChild(option);
      });
      setSelectValue(reasoningSelectEl, gen.reasoning);
      reasoningSelectEl.disabled = reasoningSelectEl.options.length <= 1;
    }
    var hint;
    if (gen.reasoningParam) {
      hint = tf('Sent as {0}. Model default sends no level (default: {1}). Reasoning cannot be turned off for this model.', gen.reasoningParam, gen.reasoningDefault);
    } else {
      hint = tf('No verified reasoning control for this model ({0}), so only Model default is offered.', gen.source);
    }
    if (gen.reasoningUnavailable) {
      hint += ' ' + tf('Your saved level {0} does not apply here; Model default is used.', t(REASONING_LABELS[gen.reasoningUnavailable] || gen.reasoningUnavailable));
    }
    setText(reasoningHintEl, hint);
    setText(
      budgetHintEl,
      tf('Automatic: {0} for {1}, lowered to fit the free context. A manual maximum replaces it for that provider only.', formatTokens(gen.autoOutputTokens), providerLabel)
    );
    if (maxOutputLocalEl && document.activeElement !== maxOutputLocalEl) {
      maxOutputLocalEl.value = typeof gen.maxOutputTokensLocal === 'number' ? String(gen.maxOutputTokensLocal) : '';
    }
    if (maxOutputCloudEl && document.activeElement !== maxOutputCloudEl) {
      maxOutputCloudEl.value = typeof gen.maxOutputTokensCloud === 'number' ? String(gen.maxOutputTokensCloud) : '';
    }
  }

  function clearChildren(node) {
    while (node && node.firstChild) {
      node.removeChild(node.firstChild);
    }
  }

  function listItem(text, state) {
    var item = document.createElement('li');
    item.textContent = text;
    if (state) {
      item.setAttribute('data-state', state);
    }
    return item;
  }

  function formatWhen(ms) {
    return typeof ms === 'number' && ms > 0 ? new Date(ms).toISOString().slice(0, 16).replace('T', ' ') : '';
  }

  function sourceLabel(source, provider) {
    if (source === 'user') {
      return t('you');
    }
    return provider === 'cloud' ? t('Meta cloud model') : t('local model');
  }

  // How a host answer to a memory action reads: done, refused, or neutral.
  function memoryFeedbackState(text) {
    if (/^(Saved |Artifact recorded|Memory change rejected|Review the exact memory change|Project memory: )/.test(text)) {
      return 'ok';
    }
    if (/^(Not |That |Approve or reject|The value is not|Several folders|Open a folder|A Mission task is running|Project memory is being changed|Ignoring an invalid)/.test(text)) {
      return 'error';
    }
    return '';
  }

  function showMemoryStatus(text, state) {
    if (!memoryStatusEl) {
      return;
    }
    memoryStatusEl.hidden = text.length === 0;
    memoryStatusEl.textContent = text;
    memoryStatusEl.setAttribute('data-state', state);
  }

  // A memory action was sent: show progress where the user is looking.
  function awaitMemoryAnswer(label) {
    memoryAwaiting = true;
    memoryFeedback = null;
    showMemoryStatus(label, 'working');
  }

  function renderMemoryFeedback(data) {
    if (memoryAwaiting) {
      memoryAwaiting = false;
      memoryFeedback = String(data.status || '');
    }
    if (memoryFeedback !== null) {
      showMemoryStatus(tHost(memoryFeedback), memoryFeedbackState(memoryFeedback));
    }
  }

  function renderMemoryProjects(memory) {
    var folders = Array.isArray(memory.folders) ? memory.folders : [];
    if (memoryProjectPickerEl) {
      memoryProjectPickerEl.hidden = folders.length < 2;
    }
    if (!memoryProjectSelectEl || document.activeElement === memoryProjectSelectEl) {
      return;
    }
    clearChildren(memoryProjectSelectEl);
    if (!memory.selectedPath) {
      var placeholder = document.createElement('option');
      placeholder.value = '';
      placeholder.textContent = t('Choose a project…');
      placeholder.disabled = true;
      placeholder.selected = true;
      memoryProjectSelectEl.appendChild(placeholder);
    }
    folders.forEach(function (folder) {
      var option = document.createElement('option');
      option.value = folder.path;
      option.textContent = folder.name === folder.path ? folder.path : folder.name + ' — ' + folder.path;
      option.title = folder.path;
      option.selected = folder.path === memory.selectedPath;
      memoryProjectSelectEl.appendChild(option);
    });
    // A pending card is answered first; it can never move to another project.
    memoryProjectSelectEl.disabled = Boolean(memory.pending);
  }

  var ARTIFACT_LABELS = {
    current: 'current',
    stale: 'STALE',
    modified: 'changed since verified',
    missing: 'missing',
    'decision-removed': 'decision removed',
    unverified: 'not checked',
  };

  function renderMemory(data) {
    var memory = data.memory;
    if (!memory || typeof memory !== 'object') {
      return;
    }
    renderMemoryProjects(memory);
    setText(memoryProjectEl, memory.project ? tf('Project: {0}', memory.project) : t('No project selected.'));
    clearChildren(memoryDecisionsEl);
    (memory.decisions || []).forEach(function (d) {
      memoryDecisionsEl.appendChild(
        listItem(tf('{0} = {1} — v{2}, approved {3}, proposed by {4}', d.key, d.value, d.version, formatWhen(d.createdAt), sourceLabel(d.source, d.provider)))
      );
    });
    if (memoryDecisionsEl && !memoryDecisionsEl.firstChild) {
      memoryDecisionsEl.appendChild(listItem(t('No decisions yet.')));
    }
    (memory.corruptKeys || []).forEach(function (key) {
      memoryDecisionsEl.appendChild(listItem(tf('{0} — stored history failed validation; not used and not changeable.', key), 'corrupt'));
    });
    clearChildren(memoryArtifactsEl);
    (memory.artifacts || []).forEach(function (a) {
      var label = t(ARTIFACT_LABELS[a.status] || a.status);
      memoryArtifactsEl.appendChild(listItem(tf('{0} — {1} ({2} v{3}). {4}', a.path, label, a.decisionKey, a.decisionVersion, tHost(a.detail)), a.status));
    });
    if (memoryArtifactsEl && !memoryArtifactsEl.firstChild) {
      memoryArtifactsEl.appendChild(listItem(t('No verified files yet.')));
    }
    clearChildren(memoryHistoryEl);
    (memory.history || []).forEach(function (h) {
      var heading = document.createElement('h5');
      heading.textContent = h.key;
      memoryHistoryEl.appendChild(heading);
      var list = document.createElement('ol');
      (h.versions || []).forEach(function (v) {
        // The reason is the proposer's own text; only the host's fixed
        // Settings reason is translated.
        var reason = v.reason === 'Entered in Settings.' ? t(v.reason) : v.reason;
        list.appendChild(
          listItem(
            tf('v{0} = {1} — {2}, proposed by {3}', v.version, v.value === '(removed)' ? t('(removed)') : v.value, formatWhen(v.createdAt), sourceLabel(v.source, v.provider)) +
              (reason ? '. ' + reason : '')
          )
        );
      });
      memoryHistoryEl.appendChild(list);
    });
    memoryCard = memory.pending && typeof memory.pending.actionId === 'string' ? memory.pending : null;
    if (memoryPendingCardEl) {
      memoryPendingCardEl.hidden = memoryCard === null;
    }
    setText(memoryPendingTextEl, memoryCard ? tHost(memoryCard.text) : '');
    setText(memoryNoteEl, tHost(memory.note || ''));
    renderMission(memory.mission || null);
  }

  function renderMission(mission) {
    missionShown = mission && typeof mission.id === 'string' ? { id: mission.id, revision: mission.revision, threadId: mission.threadId || null } : null;
    clearChildren(missionTasksEl);
    clearChildren(missionEvidenceEl);
    if (missionOpenThreadBtn) {
      missionOpenThreadBtn.hidden = !(mission && mission.threadId);
    }
    if (!mission) {
      setText(missionSummaryEl, t('No Mission for this project. Create one with a Mission plan.'));
      setText(missionDecisionsEl, '');
      if (missionRunBtn) {
        missionRunBtn.hidden = true;
      }
      renderMissionAutonomy(null);
      return;
    }
    var status = t(MISSION_STATUS_LABELS[mission.status] || mission.status);
    setText(
      missionSummaryEl,
      tf('{0} — {1}. {2} task(s) left; {3} of {4} runs used.', mission.goal, status, String(mission.pendingCount), String(mission.runsUsed), String(mission.maxRuns)) +
        ' ' + tHost(mission.note || '')
    );
    (mission.tasks || []).forEach(function (task) {
      var marker = task.status === 'completed' ? 'done' : task.status === 'current' ? 'current' : 'pending';
      var markerText = marker === 'current' ? t('in progress') : t(marker);
      missionTasksEl.appendChild(listItem(task.title + ' — ' + markerText + (task.runs > 0 ? ' ' + tf('({0} run(s))', task.runs) : ''), marker));
    });
    var used = (mission.decisionsUsed || []).map(function (d) {
      var changed = d.currentVersion !== null && d.currentVersion !== d.version;
      return d.key + ' v' + d.version + (changed ? ' ' + tf('(now v{0})', d.currentVersion) : '');
    });
    setText(missionDecisionsEl, used.length > 0 ? tf('Decisions used: {0}.', used.join(', ')) : t('Decisions used: none.'));
    // Evidence lines are the Mission's record and are shown as stored.
    (mission.evidence || []).forEach(function (line) {
      missionEvidenceEl.appendChild(listItem(line));
    });
    if (missionRunBtn) {
      missionRunBtn.hidden = mission.canRun !== true;
      missionRunBtn.textContent = mission.resume ? tf('Resume task: {0}', mission.current || '') : tf('Run task: {0}', mission.current || '');
    }
    renderMissionAutonomy(mission.autonomy || null);
  }

  function formatElapsed(startedAt) {
    if (typeof startedAt !== 'number' || startedAt <= 0) {
      return '';
    }
    var seconds = Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
    var minutes = Math.floor(seconds / 60);
    return minutes + ':' + String(seconds % 60).padStart(2, '0');
  }

  function missionPhaseKey(live) {
    if (!live || !MISSION_PHASE_LABELS[live.phase]) {
      return null;
    }
    if (live.phase === 'completed') {
      return live.acceptance && live.acceptance.state === 'passed' ? 'completed' : 'completed_standard';
    }
    return live.phase;
  }

  // The start button follows this view's own click until the host confirms
  // it by request id; a rebuilt view (no click of its own) follows the host.
  function missionStartControl(local, live, now) {
    var host = live && live.startRequest ? live.startRequest : null;
    var mine = local !== null && host !== null && host.requestId === local.requestId;
    if (mine && host.state === 'failed') {
      return { visible: true, disabled: false, pending: false, label: START_LABELS.idle, error: host.error, started: false };
    }
    if (mine && host.state === 'started') {
      return { visible: false, disabled: true, pending: false, label: START_LABELS.started, error: '', started: true };
    }
    if ((host !== null && host.state === 'authorizing') || (live && live.phase === 'authorizing')) {
      return { visible: true, disabled: true, pending: true, label: START_LABELS.pending, error: '', started: false };
    }
    if (local !== null) {
      if (now - local.at > START_CONFIRM_TIMEOUT_MS) {
        return { visible: true, disabled: false, pending: false, label: START_LABELS.idle, error: START_LABELS.unconfirmed, started: false };
      }
      return { visible: true, disabled: true, pending: true, label: START_LABELS.pending, error: '', started: false };
    }
    return { visible: Boolean(live && live.canStart), disabled: false, pending: false, label: START_LABELS.idle, error: '', started: false };
  }

  // What the run indicator says when a run is not working. A Mission thread
  // says the Mission's phase; a finished plan request is never "Completed".
  function runOutcomeLabel(data, outcome, threadId) {
    var live = data.missionLive && data.missionLive.threadId === threadId ? data.missionLive : null;
    var key = missionPhaseKey(live);
    if (key !== null) {
      return { text: MISSION_PHASE_LABELS[key], state: live.phase };
    }
    if (outcome === 'completed') {
      return data.runKind === 'mission-plan' ? { text: MISSION_PHASE_LABELS.no_plan, state: 'error' } : { text: 'Completed', state: 'completed' };
    }
    if (outcome === 'cancelled') {
      return { text: 'Cancelled', state: 'cancelled' };
    }
    return null;
  }

  function newRequestId() {
    return 'req_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
  }

  function renderMissionAutonomy(auto) {
    var show = function (node, visible) {
      if (node) {
        node.hidden = !visible;
      }
    };
    if (!auto) {
      show(missionAutoStatusEl, false);
      show(missionConsultRowEl, false);
      return;
    }
    var parts = [];
    if (auto.grant) {
      parts.push(tf('Permission: {0}', t(auto.grant === 'autonomous-workspace' ? 'autonomous workspace' : 'supervised')));
      parts.push(tf('Model: {0}', auto.model || ''));
      parts.push(tf('Internal run {0}', auto.internalRuns + (auto.running ? 1 : 0)));
      if (auto.running && typeof auto.step === 'number') {
        parts.push(tf('Step {0}/{1}', auto.step, auto.maxSteps));
      }
      if (auto.running && auto.startedAt) {
        parts.push(tf('Elapsed {0}', formatElapsed(auto.startedAt)));
      }
      if (auto.lastProgress) {
        parts.push(tf('Last progress: {0}', auto.lastProgress));
      }
      if (auto.lastTest) {
        parts.push(tf('Last test: {0}', auto.lastTest));
      }
      parts.push(auto.escalation ? tf('Meta consultations: {0}/{1} ({2})', auto.escalation.used, auto.escalation.max, auto.escalation.model) : t('Meta consultations: none'));
      parts.push(auto.acceptance ? tf('Acceptance check: {0} (frozen: {1})', auto.acceptance.commandId, auto.acceptance.files.join(', ')) : t('No acceptance check: completion means the project and agent tests passed'));
    }
    setText(missionAutoStatusEl, parts.join(' · '));
    show(missionAutoStatusEl, parts.length > 0);
    show(missionConsultRowEl, auto.cloudEscalationAllowed === true);
  }

  function factRow(list, label, value) {
    if (!list || value === null || value === undefined || value === '') {
      return null;
    }
    var term = document.createElement('dt');
    term.textContent = label;
    var detail = document.createElement('dd');
    detail.textContent = String(value);
    list.appendChild(term);
    list.appendChild(detail);
    return detail;
  }

  function missionElapsedText(live) {
    if (!live || typeof live.startedAt !== 'number') {
      return '';
    }
    var end = typeof live.endedAt === 'number' ? live.endedAt : Date.now();
    var seconds = Math.max(0, Math.floor((end - live.startedAt) / 1000));
    return Math.floor(seconds / 60) + ':' + String(seconds % 60).padStart(2, '0');
  }

  function acceptanceText(live) {
    var acc = live.acceptance;
    if (!acc) {
      return live.grant ? t('Standard Mission: no acceptance check') : '';
    }
    if (acc.state === 'passed') {
      return tf('{0}: passed — {1}', acc.commandId, acc.summary);
    }
    if (acc.state === 'failed') {
      return tf('{0}: failed — {1}', acc.commandId, acc.summary);
    }
    if (acc.state === 'tampered') {
      return tf('{0}: its files changed — the Mission is blocked', acc.commandId);
    }
    return tf('{0}: not run yet (runs before the Mission can end)', acc.commandId);
  }

  function renderMissionFacts(live) {
    clearChildren(missionFactsEl);
    missionTimeEl = null;
    factRow(missionFactsEl, t('Goal'), live.goal);
    if (live.tasksTotal > 0) {
      factRow(missionFactsEl, t('Current task'), live.currentTask ? tf('{0} ({1} of {2} done)', live.currentTask, live.tasksDone, live.tasksTotal) : tf('{0} of {1} done', live.tasksDone, live.tasksTotal));
    }
    if (live.grant) {
      factRow(missionFactsEl, t('Permission'), tf('{0} · {1}', t(live.grant === 'autonomous-workspace' ? 'autonomous workspace' : 'supervised'), live.model || ''));
      factRow(missionFactsEl, t('Internal run'), live.internalRun > 0 ? String(live.internalRun) : t('none yet'));
      if (typeof live.step === 'number') {
        factRow(missionFactsEl, t('Step'), tf('{0}/{1}', live.step, live.maxSteps));
      }
      missionTimeEl = factRow(missionFactsEl, t('Time'), missionElapsedText(live));
      factRow(missionFactsEl, t('Last progress'), live.lastProgress || t('none yet'));
      factRow(missionFactsEl, t('Last test'), live.lastTest || t('none yet'));
      factRow(missionFactsEl, t('Acceptance'), acceptanceText(live));
    }
    // A blocked Mission says why in its red card.
    if (live.note && ['interrupted', 'paused', 'cancelled', 'failed'].indexOf(live.phase) >= 0) {
      factRow(missionFactsEl, t('Why'), tHost(live.note));
    }
  }

  function chosenAcceptanceFiles(live) {
    var candidates = live && live.setup ? live.setup.candidates : [];
    return candidates.filter(function (file) {
      return acceptanceChosen[file] === true;
    });
  }

  function renderAcceptancePicker(live) {
    var setup = live.setup;
    if (!setup || !missionAcceptanceListEl) {
      return;
    }
    if (missionAcceptanceCommandEl && document.activeElement !== missionAcceptanceCommandEl) {
      var chosen = missionAcceptanceCommandEl.value;
      clearChildren(missionAcceptanceCommandEl);
      var none = document.createElement('option');
      none.value = '';
      none.textContent = t('Choose a test script');
      missionAcceptanceCommandEl.appendChild(none);
      setup.testCommands.forEach(function (id) {
        var option = document.createElement('option');
        option.value = id;
        option.textContent = id;
        missionAcceptanceCommandEl.appendChild(option);
      });
      setSelectValue(missionAcceptanceCommandEl, chosen);
    }
    var filter = missionAcceptanceFilterEl ? String(missionAcceptanceFilterEl.value).trim().toLowerCase() : '';
    var drawn = setup.candidates.join('\n') + '\u0000' + filter + '\u0000' + language;
    if (drawn !== acceptanceDrawn && !(missionAcceptanceListEl.contains(document.activeElement))) {
      acceptanceDrawn = drawn;
      clearChildren(missionAcceptanceListEl);
      var shown = setup.candidates.filter(function (file) {
        return filter === '' || file.toLowerCase().indexOf(filter) >= 0;
      });
      if (shown.length === 0) {
        var empty = document.createElement('p');
        empty.className = 'hint';
        empty.textContent = setup.candidates.length === 0 ? t('No test files were found in this project.') : t('No file matches the filter.');
        missionAcceptanceListEl.appendChild(empty);
      }
      shown.forEach(function (file) {
        var label = document.createElement('label');
        var box = document.createElement('input');
        box.type = 'checkbox';
        box.value = file;
        box.checked = acceptanceChosen[file] === true;
        box.addEventListener('change', function () {
          acceptanceChosen[file] = box.checked;
          renderFrozenSummary(missionLive);
        });
        label.appendChild(box);
        label.appendChild(document.createTextNode(' ' + file));
        missionAcceptanceListEl.appendChild(label);
      });
    }
    renderFrozenSummary(live);
  }

  function renderFrozenSummary(live) {
    if (!live || !live.setup) {
      setText(missionFrozenSummaryEl, '');
      return;
    }
    var files = chosenAcceptanceFiles(live);
    if (files.length === 0) {
      setText(missionFrozenSummaryEl, t('Choose at least one file of the acceptance check.'));
      return;
    }
    var frozen = files.concat(['package.json']).concat(live.setup.environmentFiles.filter(function (file) {
      return files.indexOf(file) < 0;
    }));
    setText(missionFrozenSummaryEl, tf('Checked by hash when you authorize: {0}. RAME Code\'s tools will not modify node_modules (not hashed).', frozen.join(', ')));
  }

  function renderAdvancedVerification(live) {
    clearChildren(missionAdvancedListEl);
    var lines = [];
    if (live.setup) {
      lines.push(tf('Allowlisted test scripts: {0}', live.setup.testCommands.join(', ') || t('none')));
      if (live.setup.packageJsonHash) {
        lines.push(tf('package.json sha256: {0}', live.setup.packageJsonHash));
      }
      lines.push(tf('Environment files hashed in a Verified Mission: {0}', live.setup.environmentFiles.join(', ') || t('none')));
    }
    if (live.acceptance) {
      lines.push(tf('Acceptance command: {0}', live.acceptance.commandId));
      live.acceptance.files.forEach(function (file) {
        lines.push(tf('Frozen {0} sha256: {1}', file.path, file.hash));
      });
    }
    lines.forEach(function (line) {
      missionAdvancedListEl.appendChild(listItem(line));
    });
    if (missionAdvancedEl) {
      missionAdvancedEl.hidden = lines.length === 0;
    }
  }

  function renderMissionReport(live) {
    var report = live.report;
    if (missionReportEl) {
      missionReportEl.hidden = !report;
    }
    clearChildren(missionReportFactsEl);
    if (!report) {
      return;
    }
    factRow(missionReportFactsEl, t('Tasks done'), report.tasks.join('; ') || t('none'));
    factRow(missionReportFactsEl, t('Files changed'), report.files.join(', ') || t('none'));
    factRow(missionReportFactsEl, t('Tests and exit codes'), report.tests.join(' | ') || t('none'));
    factRow(missionReportFactsEl, t('Frozen acceptance'), report.acceptance || t('none (Standard Mission)'));
    factRow(missionReportFactsEl, t('Internal runs and time'), tf('{0} run(s), {1} min', report.internalRuns, report.minutes));
    factRow(missionReportFactsEl, t('Models and providers'), report.models.join('; '));
    factRow(missionReportFactsEl, t('Meta consultations'), report.metaConsultations);
  }

  // A blocked Mission gets a red card: why, how far it got, what never ran,
  // and Review / Retry with guidance / Cancel. It is never shown as completed.
  function renderMissionBlocked(live) {
    var blocked = live.phase === 'blocked' && live.blocked ? live.blocked : null;
    if (missionCardEl) {
      missionCardEl.classList.toggle('is-blocked', blocked !== null);
    }
    if (missionBlockedEl) {
      missionBlockedEl.hidden = blocked === null;
    }
    clearChildren(missionBlockedFactsEl);
    clearChildren(missionReviewListEl);
    if (blocked === null) {
      return;
    }
    factRow(missionBlockedFactsEl, t('Why'), tHost(blocked.reason));
    factRow(missionBlockedFactsEl, t('Internal runs'), String(blocked.runs));
    factRow(missionBlockedFactsEl, t('Last progress'), blocked.lastProgress || t('none'));
    factRow(missionBlockedFactsEl, t('Tests not run'), blocked.testsNotRun.length > 0 ? blocked.testsNotRun.join(', ') : t('none'));
    // The host record is shown as stored.
    (live.review || []).forEach(function (line) {
      missionReviewListEl.appendChild(listItem(line));
    });
  }

  function applyStartControl(live) {
    var control = missionStartControl(missionStartLocal, live, Date.now());
    if (missionStartBtn) {
      missionStartBtn.disabled = control.disabled;
      missionStartBtn.textContent = t(control.label);
      missionStartBtn.classList.toggle('is-pending', control.pending);
      missionStartBtn.setAttribute('aria-busy', control.pending ? 'true' : 'false');
    }
    if (missionStartErrorEl) {
      missionStartErrorEl.hidden = control.error === '';
      missionStartErrorEl.textContent = control.error === '' ? '' : tHost(control.error);
    }
    if (missionSetupEl) {
      missionSetupEl.hidden = !(live && live.missionId) || !(control.visible || control.pending || control.error !== '');
    }
    return control;
  }

  function renderMissionCard(data) {
    var live = data.missionLive && data.missionLive.threadId === activeThreadId ? data.missionLive : null;
    missionLive = live;
    if (missionCardEl) {
      missionCardEl.hidden = live === null;
    }
    if (live === null) {
      return;
    }
    var key = missionPhaseKey(live);
    setText(missionPhaseEl, key ? t(MISSION_PHASE_LABELS[key]) : '');
    if (missionPhaseEl) {
      missionPhaseEl.setAttribute('data-phase', live.phase);
    }
    renderMissionFacts(live);
    var hasMission = typeof live.missionId === 'string';
    if (missionPauseBtn) {
      missionPauseBtn.hidden = !(hasMission && live.canPause);
    }
    if (missionResumeBtn) {
      missionResumeBtn.hidden = !(hasMission && live.canResume);
    }
    if (missionCancelBtn) {
      missionCancelBtn.hidden = !(hasMission && live.canCancel && live.phase !== 'authorizing');
    }
    if (missionVerifiedRowEl) {
      missionVerifiedRowEl.hidden = !(missionLevelVerifiedEl && missionLevelVerifiedEl.checked);
    }
    renderAcceptancePicker(live);
    renderAdvancedVerification(live);
    renderMissionReport(live);
    renderMissionBlocked(live);
    if (live.phase === 'blocked') {
      // The red card has its own Retry and Cancel.
      if (missionResumeBtn) {
        missionResumeBtn.hidden = true;
      }
      if (missionCancelBtn) {
        missionCancelBtn.hidden = true;
      }
    }
    var control = applyStartControl(live);
    if (control.started && missionStartLocal !== null && missionStartAnnounced !== missionStartLocal.requestId) {
      // Confirmed by the host: say so, go to the Mission thread, focus its card.
      missionStartAnnounced = missionStartLocal.requestId;
      missionStartLocal = null;
      if (missionStartNoteEl) {
        missionStartNoteEl.hidden = false;
        missionStartNoteEl.textContent = t(START_LABELS.started);
      }
      if (data.screen !== 'chat') {
        vscode.postMessage({ type: 'navigate', screen: 'chat' });
      }
      if (missionCardHeadingEl) {
        missionCardHeadingEl.focus();
      }
    } else if (missionStartNoteEl && ['authorizing', 'running', 'waiting_approval'].indexOf(live.phase) < 0) {
      missionStartNoteEl.hidden = true;
    }
  }

  function renderAbout(data) {
    var about = data.about || { version: 'unknown', revision: 'unknown', channel: 'candidate' };
    if (versionBadgeEl) {
      versionBadgeEl.textContent = 'v' + about.version;
    }
    clearChildren(aboutFactsEl);
    factRow(aboutFactsEl, t('Public version'), about.version);
    factRow(aboutFactsEl, t('Build revision'), about.revision);
    factRow(aboutFactsEl, t('Channel'), t(about.channel === 'release' ? 'release' : 'candidate'));
  }

  function renderSettingsSummaries(data) {
    setText(el('summaryGeneral'), tf('Language: {0}', language === 'es' ? 'Español' : 'English'));
    var runtimeLine = runtimeDisplayName(data.runtime, data.cloudModel || '');
    if (data.runtime === 'local') {
      runtimeLine += ' · ' + t(data.local && data.local.lifecycle === 'running' ? 'running' : data.externalLocalEndpoint ? 'external endpoint' : 'stopped');
    } else {
      runtimeLine += ' · ' + t(data.hasKey ? 'key saved' : 'no key');
    }
    setText(el('summaryRuntime'), runtimeLine);
    var mission = data.memory && data.memory.mission ? data.memory.mission : null;
    setText(el('summaryMission'), mission ? tf('{0} — {1}', mission.goal.slice(0, 60), t(MISSION_STATUS_LABELS[mission.status] || mission.status)) : t('No Mission'));
    var memory = data.memory || {};
    setText(el('summaryMemory'), memory.project ? tf('{0} · {1} decision(s) in force', memory.project, (memory.decisions || []).length) : t('No project selected.'));
    setText(el('summarySecurity'), tf('Permission: {0} · Cloud escalation {1}', shortProfileName(data.agentProfile || 'ask'), t(data.allowCloudEscalation ? 'on' : 'off')));
    var diagnostics = data.local && data.local.diagnostics ? String(data.local.diagnostics).split('\n')[0] : '';
    setText(el('summaryAdvanced'), diagnostics ? diagnostics.slice(0, 80) : t('Output limits and diagnostics'));
    var about = data.about || { version: 'unknown', channel: 'candidate' };
    setText(el('summaryAbout'), tf('v{0} · {1}', about.version, t(about.channel === 'release' ? 'release' : 'candidate')));
  }

  function renderConsult(consult) {
    consultShown = consult && typeof consult.digest === 'string' ? consult : null;
    if (consultBoxEl) {
      consultBoxEl.hidden = consultShown === null;
    }
    setText(consultReasonEl, consultShown ? tf('Why: the local run stopped because {0}.', consultShown.reason) : '');
    // The payload is shown exactly as it would be sent, never translated.
    setText(consultPayloadEl, consultShown ? consultShown.payload : '');
    setText(
      consultMetaEl,
      consultShown ? tf('Model: Meta {0} | {1} characters | Digest: {2} — one use.', consultShown.model, consultShown.payload.length, consultShown.digest.slice(0, 16)) : ''
    );
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

  function setLanguage(next) {
    if (next === language || (next !== 'en' && !(I18N && I18N.has(next)))) {
      return false;
    }
    language = next;
    applyStaticText();
    setSelectValue(languageSelectEl, language);
    return true;
  }

  window.addEventListener('message', function (event) {
    var data = event.data;
    if (!isStateMessage(data)) {
      return;
    }
    // Host confirmation arrived: clear async pending buttons first, then
    // render the confirmed state. Success is never claimed before this.
    restorePendingButtons();
    setLanguage(data.language === 'es' ? 'es' : 'en');
    lastState = data;
    renderState(data);
  });

  function renderState(data) {
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
    setText(statusEl, tHost(data.status));
    setText(settingsStatusEl, tHost(data.status));
    setText(scopeNoticeEl, tHost(data.notice || ''));
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
    setText(runtimeStatusEl, tf('Runtime: {0}', runtimeDisplayName(data.runtime, currentCloudModel)));
    applyProviderVisibility(data.runtime);
    renderCatalog(data);
    var usageLine =
      formatUsage('Last call', data.usageLast) +
      '  |  ' +
      formatUsage('Cloud total', data.usageCloud) +
      '  |  ' +
      formatUsage('Local total', data.usageLocal) +
      t(' (Meta Billing/Usage is authoritative; no balance is shown.)');
    setText(usageEl, usageLine);
    var esc = data.escalation || { pending: false, reason: '' };
    if (escalationBox) {
      escalationBox.hidden = !esc.pending;
    }
    setText(escalationReasonEl, tHost(esc.reason || ''));
    renderConsult(data.consult || null);
    renderLocal(data);
    renderAgent(data);
    renderGeneration(data);
    renderMemory(data);
    renderMemoryFeedback(data);
    renderMissionCard(data);
    renderAbout(data);
    renderSettingsSummaries(data);
    fillSettingsForm(data);
    refreshControls(data);
  }

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
          t('The local model is not running. Start Muse Glimmer, choose Meta Model API, or configure an external OpenAI-compatible loopback server.')
        );
        return;
      }
      hideRuntimeNotice();
      if (!markPending(sendBtn, t('Running…'))) {
        return;
      }
      setText(statusEl, t('Running…'));
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

  if (consultApproveBtn) {
    consultApproveBtn.addEventListener('click', function () {
      if (consultShown && markPending(consultApproveBtn, t('Sending…'))) {
        if (consultDismissBtn) {
          consultDismissBtn.disabled = true;
          pendingButtons.push(consultDismissBtn);
        }
        vscode.postMessage({ type: 'consultApprove', digest: consultShown.digest });
      }
    });
  }

  if (consultDismissBtn) {
    consultDismissBtn.addEventListener('click', function () {
      if (consultShown && markPending(consultDismissBtn, t('Dismissing…'))) {
        vscode.postMessage({ type: 'consultDismiss' });
      }
    });
  }

  if (escalateDismissBtn) {
    escalateDismissBtn.addEventListener('click', function () {
      vscode.postMessage({ type: 'escalateDismiss' });
    });
  }

  if (saveKeyBtn) {
    saveKeyBtn.addEventListener('click', function () {
      if (!markPending(saveKeyBtn, t('Saving…'))) {
        return;
      }
      setText(settingsStatusEl, t('Saving…'));
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
      if (!markPending(saveLocalBtn, t('Saving…'))) {
        return;
      }
      setText(settingsStatusEl, t('Saving…'));
      pushSettingsAndLocal();
    });
  }

  if (useSuggestionsBtn) {
    useSuggestionsBtn.addEventListener('click', function () {
      if (!markPending(useSuggestionsBtn, t('Loading…'))) {
        return;
      }
      vscode.postMessage({ type: 'useSuggestions' });
    });
  }

  if (startLocalBtn) {
    startLocalBtn.addEventListener('click', function () {
      // Atomic start: one exact-key message carrying the visible settings.
      // Pending state stays visible; starting may take minutes.
      if (!markPending(startLocalBtn, t('Starting…'))) {
        return;
      }
      setText(localStatusEl, t('Local runtime is starting…'));
      vscode.postMessage(readLocalForm('startLocal'));
    });
  }

  if (missionRunBtn) {
    missionRunBtn.addEventListener('click', function () {
      if (missionShown && markPending(missionRunBtn, t('Starting…'))) {
        vscode.postMessage({ type: 'runMissionTask', missionId: missionShown.id, revision: missionShown.revision });
      }
    });
  }

  // Pause, resume, and cancel act on the Mission of the open card first.
  function missionMessage(type, btn) {
    var target = missionLive && typeof missionLive.missionId === 'string'
      ? { id: missionLive.missionId, revision: missionLive.revision }
      : missionShown;
    if (target && (!btn || markPending(btn, t(type === 'missionPause' ? 'Pausing…' : type === 'missionResume' ? 'Resuming…' : 'Cancelling…')))) {
      vscode.postMessage({ type: type, missionId: target.id, revision: target.revision });
    }
  }

  function showStartError(text) {
    if (missionStartErrorEl) {
      missionStartErrorEl.hidden = false;
      missionStartErrorEl.textContent = text;
    }
  }

  if (missionStartBtn) {
    missionStartBtn.addEventListener('click', function () {
      var live = missionLive;
      if (!live || typeof live.missionId !== 'string' || missionStartBtn.disabled || missionStartLocal !== null && missionStartControl(missionStartLocal, live, Date.now()).pending) {
        return;
      }
      var verified = Boolean(missionLevelVerifiedEl && missionLevelVerifiedEl.checked);
      var acceptanceCommand = verified && missionAcceptanceCommandEl ? String(missionAcceptanceCommandEl.value) : '';
      var acceptanceFiles = verified ? chosenAcceptanceFiles(live).slice(0, 20) : [];
      if (verified && (acceptanceCommand === '' || acceptanceFiles.length === 0)) {
        showStartError(t('Choose the acceptance check and at least one of its files, or choose Standard Mission.'));
        return;
      }
      var consults = missionConsultsEl && missionConsultRowEl && !missionConsultRowEl.hidden ? Number(missionConsultsEl.value) : 0;
      // Pending at once, before the host answers: the button cannot be
      // clicked again until the host confirms or reports an error.
      missionStartLocal = { requestId: newRequestId(), at: Date.now() };
      applyStartControl(live);
      vscode.postMessage({
        type: 'missionStart',
        missionId: live.missionId,
        revision: live.revision,
        mode: missionModeEl && missionModeEl.value === 'autonomous-workspace' ? 'autonomous-workspace' : 'supervised',
        maxConsultations: Number.isInteger(consults) && consults >= 0 && consults <= 5 ? consults : 0,
        trustedProject: Boolean(missionTrustedEl && missionTrustedEl.checked),
        acceptanceCommand: acceptanceCommand,
        acceptanceFiles: acceptanceFiles,
        requestId: missionStartLocal.requestId,
      });
    });
  }
  if (missionPauseBtn) {
    missionPauseBtn.addEventListener('click', function () {
      missionMessage('missionPause', missionPauseBtn);
    });
  }
  if (missionResumeBtn) {
    missionResumeBtn.addEventListener('click', function () {
      missionMessage('missionResume', missionResumeBtn);
    });
  }
  if (missionCancelBtn) {
    missionCancelBtn.addEventListener('click', function () {
      missionMessage('missionCancel', missionCancelBtn);
    });
  }
  function toggleExpanded(btn, panel) {
    if (!btn || !panel) {
      return;
    }
    panel.hidden = !panel.hidden;
    btn.setAttribute('aria-expanded', panel.hidden ? 'false' : 'true');
  }
  if (missionReviewBtn) {
    missionReviewBtn.addEventListener('click', function () {
      toggleExpanded(missionReviewBtn, missionReviewListEl);
    });
  }
  if (missionRetryOpenBtn) {
    missionRetryOpenBtn.addEventListener('click', function () {
      toggleExpanded(missionRetryOpenBtn, missionRetryFormEl);
      if (missionRetryFormEl && !missionRetryFormEl.hidden && missionGuidanceEl) {
        missionGuidanceEl.focus();
      }
    });
  }
  if (missionRetryBtn) {
    missionRetryBtn.addEventListener('click', function () {
      var guidance = missionGuidanceEl ? String(missionGuidanceEl.value).trim() : '';
      if (guidance.length === 0) {
        if (missionRetryErrorEl) {
          missionRetryErrorEl.hidden = false;
          missionRetryErrorEl.textContent = t('Write what the Agent should do differently.');
        }
        return;
      }
      if (missionRetryErrorEl) {
        missionRetryErrorEl.hidden = true;
      }
      if (missionLive && typeof missionLive.missionId === 'string' && markPending(missionRetryBtn, t('Retrying…'))) {
        vscode.postMessage({ type: 'missionRetry', missionId: missionLive.missionId, revision: missionLive.revision, guidance: guidance.slice(0, 1000) });
        if (missionGuidanceEl) {
          missionGuidanceEl.value = '';
        }
      }
    });
  }
  if (missionBlockedCancelBtn) {
    missionBlockedCancelBtn.addEventListener('click', function () {
      missionMessage('missionCancel', missionBlockedCancelBtn);
    });
  }
  [missionLevelStandardEl, missionLevelVerifiedEl].forEach(function (radio) {
    if (radio) {
      radio.addEventListener('change', function () {
        if (missionVerifiedRowEl) {
          missionVerifiedRowEl.hidden = !(missionLevelVerifiedEl && missionLevelVerifiedEl.checked);
        }
        if (missionStartErrorEl && missionStartLocal === null) {
          missionStartErrorEl.hidden = true;
        }
      });
    }
  });
  if (missionAcceptanceFilterEl) {
    missionAcceptanceFilterEl.addEventListener('input', function () {
      if (missionLive) {
        renderAcceptancePicker(missionLive);
      }
    });
  }
  if (missionOpenThreadBtn) {
    missionOpenThreadBtn.addEventListener('click', function () {
      if (missionShown && missionShown.threadId) {
        vscode.postMessage({ type: 'openThread', threadId: missionShown.threadId });
        vscode.postMessage({ type: 'navigate', screen: 'chat' });
      }
    });
  }
  // Settings navigation: open the card, bring it into view, focus its title.
  if (settingsNavEl) {
    var navButtons = settingsNavEl.querySelectorAll('button[data-card]');
    for (var ni = 0; ni < navButtons.length; ni++) {
      (function (navBtn) {
        navBtn.addEventListener('click', function () {
          var card = el(navBtn.getAttribute('data-card') || '');
          if (!card) {
            return;
          }
          card.open = true;
          for (var nj = 0; nj < navButtons.length; nj++) {
            navButtons[nj].setAttribute('aria-current', navButtons[nj] === navBtn ? 'true' : 'false');
          }
          if (typeof card.scrollIntoView === 'function') {
            card.scrollIntoView({ block: 'start' });
          }
          var summary = card.querySelector('summary');
          if (summary) {
            summary.focus();
          }
        });
      })(navButtons[ni]);
    }
  }
  // The Mission clock and the start-confirmation timeout move without a host message.
  setInterval(function () {
    if (!missionLive) {
      return;
    }
    if (missionTimeEl && typeof missionLive.startedAt === 'number' && typeof missionLive.endedAt !== 'number') {
      missionTimeEl.textContent = missionElapsedText(missionLive);
    }
    if (missionStartLocal !== null) {
      applyStartControl(missionLive);
    }
  }, 1000);

  if (memoryProposeBtn) {
    memoryProposeBtn.addEventListener('click', function () {
      var key = memoryKeyEl ? String(memoryKeyEl.value).trim() : '';
      var value = memoryValueEl ? String(memoryValueEl.value).trim() : '';
      if (key.length === 0 || value.length === 0) {
        memoryFeedback = null;
        showMemoryStatus(t('Enter a key and a value first.'), 'error');
        return;
      }
      if (!markPending(memoryProposeBtn, t('Preparing…'))) {
        return;
      }
      awaitMemoryAnswer(t('Preparing…'));
      vscode.postMessage({
        type: 'proposeDecision',
        key: key,
        valueType: memoryValueTypeEl ? memoryValueTypeEl.value : 'number',
        value: value,
      });
    });
  }

  if (memoryApproveBtn) {
    memoryApproveBtn.addEventListener('click', function () {
      if (memoryCard && markPending(memoryApproveBtn, t('Saving…'))) {
        if (memoryRejectBtn) {
          memoryRejectBtn.disabled = true;
          pendingButtons.push(memoryRejectBtn);
        }
        awaitMemoryAnswer(t('Saving…'));
        vscode.postMessage({ type: 'approveMemoryChange', actionId: memoryCard.actionId, digest: memoryCard.digest });
      }
    });
  }

  if (memoryRejectBtn) {
    memoryRejectBtn.addEventListener('click', function () {
      if (memoryCard && markPending(memoryRejectBtn, t('Rejecting…'))) {
        if (memoryApproveBtn) {
          memoryApproveBtn.disabled = true;
          pendingButtons.push(memoryApproveBtn);
        }
        awaitMemoryAnswer(t('Rejecting…'));
        vscode.postMessage({ type: 'rejectMemoryChange', actionId: memoryCard.actionId, digest: memoryCard.digest });
      }
    });
  }

  if (memoryProjectSelectEl) {
    memoryProjectSelectEl.addEventListener('change', function () {
      var chosen = memoryProjectSelectEl.value;
      if (chosen) {
        awaitMemoryAnswer(t('Loading…'));
        vscode.postMessage({ type: 'selectMemoryProject', path: chosen });
        // Hand focus back so the confirmed state can redraw the list.
        memoryProjectSelectEl.blur();
      }
    });
  }

  if (languageSelectEl) {
    languageSelectEl.addEventListener('change', function () {
      var next = languageSelectEl.value === 'es' ? 'es' : 'en';
      if (setLanguage(next) && lastState) {
        renderState(lastState);
      }
      vscode.postMessage({ type: 'setLanguage', language: next });
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
      if (!markPending(refreshModelsBtn, t('Loading models…'))) {
        return;
      }
      setText(catalogStatusEl, t('Loading models…'));
      vscode.postMessage({ type: 'refreshModels' });
    });
  }

  if (stopLocalBtn) {
    stopLocalBtn.addEventListener('click', function () {
      if (!markPending(stopLocalBtn, t('Stopping…'))) {
        return;
      }
      setText(localStatusEl, t('Stopping…'));
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
      setText(runtimeStatusEl, tf('Runtime: {0}', runtimeDisplayName(currentRuntime, currentCloudModel)));
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
        if (!markPending(pendingApproveBtn, t('Approving…'))) {
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
        if (!markPending(pendingRejectBtn, t('Rejecting…'))) {
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
