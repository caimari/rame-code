/* The advisor model (Settings → Security → Advisor model) and the names on
 * the consultation card. Everything shown comes from the host
 * (state.remote.servers.advisor and state.remote.consult); text is set with
 * textContent only. Choosing a model only asks: the host checks it against
 * the main model and the catalog, and every consultation checks again.
 * Loaded after autonomyUx.js: it wraps RAME_REMOTE.init/render so main.js
 * needs no change. */
(function () {
  'use strict';

  var ES = {
    'Advisor model': 'Modelo asesor',
    'Model the main model may consult when it is stuck': 'Modelo al que puede consultar el modelo principal cuando se atasca',
    "The main model (chosen in Models) does the work and keeps every tool. The advisor only answers in text: it never gets tools and never takes over. Only a Meta model that Meta's documentation describes as more capable than the main model can be chosen, never the main model itself; when there is none, the main model works without consultations. Every consultation keeps its card, pre-authorization or Full Access, its budget and its data limits.":
      'El modelo principal (elegido en Modelos) hace el trabajo y conserva todas las herramientas. El asesor solo responde con texto: nunca recibe herramientas ni toma el control. Solo se puede elegir un modelo de Meta que la documentación de Meta describa como más capaz que el modelo principal, nunca el propio modelo principal; si no hay ninguno, el modelo principal trabaja sin consultas. Cada consulta mantiene su tarjeta, preautorización o acceso total, su presupuesto y sus límites de datos.',
    'None: the main model works without consultations': 'Ninguno: el modelo principal trabaja sin consultas',
    'Main model now: {0} (local).': 'Modelo principal ahora: {0} (local).',
    'Main model now: Meta {0}.': 'Modelo principal ahora: Meta {0}.',
    '{0} — cannot advise: {1}': '{0} — no puede asesorar: {1}',
    '{0} — {1}': '{0} — {1}',
    'Advisor: {0}. The main model may consult it when it is stuck.': 'Asesor: {0}. El modelo principal puede consultarlo cuando se atasque.',
    'No advisor: {0}. The main model works without consultations.': 'Sin asesor: {0}. El modelo principal trabaja sin consultas.',
    'Ask {0} for advice — {1} remains in control': 'Pedir consejo a {0} — {1} conserva el control',
    "Include the end of the failing check's output (last lines; secrets removed, local folders hidden). The exact text is shown again before anything is sent.":
      'Incluir el final de la salida de la comprobación que falla (últimas líneas; sin secretos y con las carpetas locales ocultas). El texto exacto se vuelve a mostrar antes de enviar nada.',
    "Main model of this Mission: {0} (local). It does every task with RAME's tools.": 'Modelo principal de esta Misión: {0} (local). Hace cada tarea con las herramientas de RAME.',
    "Main model of this Mission: Meta {0}. It does every task with RAME's tools: in every run of this Mission, the task text, the files it reads and its tools' results go to Meta, without another card.":
      'Modelo principal de esta Misión: Meta {0}. Hace cada tarea con las herramientas de RAME: en cada ejecución de esta Misión, el texto de la tarea, los ficheros que lee y los resultados de sus herramientas van a Meta, sin otra tarjeta.',
    'Advisor for its consultations: Meta {0}.': 'Asesor para sus consultas: Meta {0}.',
    'Internal runs per task, at most (autonomous workspace)': 'Ejecuciones internas por tarea, como máximo (workspace autónomo)',
    '8 (default)': '8 (predeterminado)',
    'RAME never raises this limit. A run counts as progress only when a test that was failing now passes in a file state not reached before; otherwise, after 3 runs the Mission blocks (and, if allowed, asks the advisor).':
      'RAME nunca sube este límite. Una ejecución solo cuenta como avance cuando un test que fallaba pasa con los ficheros en un estado nuevo; si no, tras 3 ejecuciones la Misión se bloquea (y, si está permitido, consulta al asesor).',
    'No advisor for its consultations: {0}.': 'Sin asesor para sus consultas: {0}.',
  };
  var PATTERNS = [
    [/^Advisor model: (\S+)\. The local model keeps the tools and may consult it when stuck, within your permissions and budgets\.$/, 'Modelo asesor: $1. El modelo local conserva las herramientas y puede consultarlo cuando se atasque, dentro de tus permisos y presupuestos.'],
    [/^Advisor model: (\S+)\. Meta (\S+) keeps the tools and may consult it when stuck, within your permissions and budgets\.$/, 'Modelo asesor: $1. Meta $2 conserva las herramientas y puede consultarlo cuando se atasque, dentro de tus permisos y presupuestos.'],
    [/^Advisor model saved as (\S+), but it cannot advise the main model now: (.+)\.$/, 'Modelo asesor guardado: $1, pero ahora no puede asesorar al modelo principal: $2.'],
    [/^No advisor model: the main model works without consulting another model\.$/, 'Sin modelo asesor: el modelo principal trabaja sin consultar a otro modelo.'],
  ];
  if (window.RAME_I18N && typeof window.RAME_I18N.extend === 'function') {
    window.RAME_I18N.extend('es', ES);
    if (typeof window.RAME_I18N.extendPatterns === 'function') window.RAME_I18N.extendPatterns('es', PATTERNS);
  }

  var h = null;

  function post(message) {
    if (h && h.vscode) h.vscode.postMessage(message);
  }

  function el(id) {
    return document.getElementById(id);
  }
  function t(text) {
    return h ? h.t(text) : text;
  }
  function tf(text) {
    var args = Array.prototype.slice.call(arguments, 1);
    return h ? h.tf.apply(null, [text].concat(args)) : text;
  }
  function setText(id, text) {
    var node = el(id);
    if (node) node.textContent = text;
  }

  function renderAdvisor(advisor) {
    var select = el('advisorModelSelect');
    if (!advisor) return;
    setText('advisorMain', advisor.mainProvider === 'cloud' ? tf('Main model now: Meta {0}.', advisor.main) : tf('Main model now: {0} (local).', advisor.main));
    if (select && document.activeElement !== select) {
      while (select.firstChild) select.removeChild(select.firstChild);
      var none = document.createElement('option');
      none.value = '';
      none.textContent = t('None: the main model works without consultations');
      select.appendChild(none);
      var listed = false;
      (advisor.options || []).forEach(function (option) {
        var node = document.createElement('option');
        node.value = option.id;
        node.textContent = option.eligible ? (option.reason ? tf('{0} — {1}', option.id, option.reason) : option.id) : tf('{0} — cannot advise: {1}', option.id, option.reason);
        // A model that cannot advise this main model stays visible, with why, but cannot be chosen here.
        node.disabled = !option.eligible && option.id !== advisor.selected;
        if (option.id === advisor.selected) listed = true;
        select.appendChild(node);
      });
      if (advisor.selected && !listed) {
        var kept = document.createElement('option');
        kept.value = advisor.selected;
        kept.textContent = tf('{0} — cannot advise: {1}', advisor.selected, advisor.problem);
        select.appendChild(kept);
      }
      select.value = advisor.selected || '';
    }
    setText('advisorStatus', advisor.problem ? tf('No advisor: {0}. The main model works without consultations.', advisor.problem) : tf('Advisor: {0}. The main model may consult it when it is stuck.', advisor.selected));
  }

  var consultNow = null;

  function renderConsultNames(data) {
    var consult = data && data.remote ? data.remote.consult : null;
    var shown = data ? data.consult : null;
    consultNow = consult && shown ? { digest: shown.digest, files: consult.authorizedFiles || [] } : null;
    var row = el('consultOutputRow');
    var facts = el('consultFacts');
    if (!row && facts && facts.parentNode) {
      row = document.createElement('label');
      row.id = 'consultOutputRow';
      var box = document.createElement('input');
      box.type = 'checkbox';
      box.id = 'consultIncludeOutput';
      box.addEventListener('change', function () {
        if (consultNow) post({ type: 'consultIncludeFiles', digest: consultNow.digest, files: consultNow.files.slice(0, 3), output: Boolean(box.checked) });
      });
      row.appendChild(box);
      row.appendChild(document.createTextNode(' '));
      var words = document.createElement('span');
      words.id = 'consultIncludeOutputText';
      row.appendChild(words);
      facts.parentNode.insertBefore(row, facts.nextSibling);
    }
    if (row) {
      row.hidden = !consult || consult.outputAvailable !== true;
      setText('consultIncludeOutputText', t("Include the end of the failing check's output (last lines; secrets removed, local folders hidden). The exact text is shown again before anything is sent."));
      var check = el('consultIncludeOutput');
      if (check && document.activeElement !== check) check.checked = Boolean(consult && consult.outputIncluded);
    }
    if (!consult || !consult.model) return;
    setText('consult-heading', tf('Ask {0} for advice — {1} remains in control', 'Meta ' + consult.model, consult.localModel));
  }

  // The Mission authorization card: which model will do its tasks, what goes to Meta, and which advisor its consultations use.
  function renderMissionMain(advisor) {
    var row = el('missionConsultRow');
    if (!row || !row.parentNode || !advisor || !advisor.main) return;
    var line = el('missionMainModel');
    if (!line) {
      line = document.createElement('p');
      line.id = 'missionMainModel';
      line.className = 'hint';
      line.setAttribute('role', 'note');
      row.parentNode.insertBefore(line, row);
    }
    var main = advisor.mainProvider === 'cloud'
      ? tf("Main model of this Mission: Meta {0}. It does every task with RAME's tools: in every run of this Mission, the task text, the files it reads and its tools' results go to Meta, without another card.", advisor.main)
      : tf("Main model of this Mission: {0} (local). It does every task with RAME's tools.", advisor.main);
    line.textContent = main + ' ' + (advisor.problem ? tf('No advisor for its consultations: {0}.', advisor.problem) : tf('Advisor for its consultations: Meta {0}.', advisor.selected));
  }

  // The run budget per task, chosen on the authorization card (sent just before main.js sends the authorization).
  function renderMissionRuns() {
    var row = el('missionConsultRow');
    if (!row || !row.parentNode || el('missionRunsRow')) return;
    var box = document.createElement('div');
    box.id = 'missionRunsRow';
    var label = document.createElement('label');
    label.setAttribute('for', 'missionRunsPerTask');
    label.textContent = t('Internal runs per task, at most (autonomous workspace)');
    var select = document.createElement('select');
    select.id = 'missionRunsPerTask';
    for (var n = 1; n <= 8; n++) {
      var option = document.createElement('option');
      option.value = String(n);
      option.textContent = n === 8 ? t('8 (default)') : String(n);
      select.appendChild(option);
    }
    select.value = '8';
    var hint = document.createElement('p');
    hint.className = 'hint';
    hint.textContent = t('RAME never raises this limit. A run counts as progress only when a test that was failing now passes in a file state not reached before; otherwise, after 3 runs the Mission blocks (and, if allowed, asks the advisor).');
    box.appendChild(label);
    box.appendChild(select);
    box.appendChild(hint);
    row.parentNode.insertBefore(box, row);
  }

  var lastData = null;

  function render(data) {
    lastData = data;
    var servers = data && data.remote ? data.remote.servers : null;
    renderAdvisor(servers ? servers.advisor : null);
    renderMissionMain(servers ? servers.advisor : null);
    renderMissionRuns();
    renderConsultNames(data);
  }

  function init(helpers) {
    h = helpers;
    var select = el('advisorModelSelect');
    if (select) select.addEventListener('change', function () {
      post({ type: 'advisorModelSet', model: select.value });
    });
    // Capture phase: before main.js sends the authorization, the chosen run budget (only when it is not the default).
    document.addEventListener('click', function (event) {
      var start = el('missionStart');
      var runs = el('missionRunsPerTask');
      var live = lastData && lastData.missionLive;
      if (!start || event.target !== start || !runs || !live || !live.missionId) return;
      var n = Number(runs.value);
      if (n >= 1 && n <= 7) post({ type: 'missionRunsSet', missionId: live.missionId, runsPerTask: n });
    }, true);
  }

  var base = window.RAME_REMOTE;
  if (base) {
    window.RAME_REMOTE = Object.assign({}, base, {
      init: function (helpers) {
        base.init(helpers);
        init(helpers);
      },
      render: function (data) {
        base.render(data);
        render(data);
      },
    });
  }
})();
