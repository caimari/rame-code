/* Exclusive Settings-card navigation for the unified RAME Code webview. */
(function () {
  'use strict';

  var rootNode = null;

  function activate(cardId) {
    if (!rootNode || typeof cardId !== 'string') {
      return false;
    }
    var buttons = rootNode.querySelectorAll('button[data-card]');
    var cards = document.querySelectorAll('#settingsScreen .settings-card');
    var card = document.getElementById(cardId);
    if (!card || !card.classList.contains('settings-card')) {
      return false;
    }
    for (var index = 0; index < cards.length; index++) {
      cards[index].hidden = cards[index] !== card;
      cards[index].open = cards[index] === card;
    }
    for (var item = 0; item < buttons.length; item++) {
      buttons[item].setAttribute(
        'aria-current',
        buttons[item].getAttribute('data-card') === cardId ? 'true' : 'false'
      );
    }
    var summary = card.querySelector('summary');
    if (summary) {
      summary.focus();
    }
    return true;
  }

  function init(root) {
    if (!root) {
      return;
    }
    rootNode = root;
    var buttons = root.querySelectorAll('button[data-card]');
    for (var index = 0; index < buttons.length; index++) {
      (function (button) {
        button.addEventListener('click', function () {
          activate(button.getAttribute('data-card') || '');
        });
      })(buttons[index]);
    }
    if (buttons.length > 0) {
      buttons[0].setAttribute('aria-current', 'true');
    }
  }

  window.RAME_SETTINGS_TABS = { init: init, activate: activate };
})();
