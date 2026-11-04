/* Composer auto-sizing, keyboard send, and respectful conversation follow. */
(function () {
  'use strict';

  function init(composer, send, scroller, threadList, newThread) {
    if (!composer || !send || !scroller) {
      return;
    }
    var following = true;
    var frame = 0;
    var maxHeight = 180;

    function resize() {
      composer.style.height = 'auto';
      var wanted = Math.max(64, Math.min(composer.scrollHeight, maxHeight));
      composer.style.height = wanted + 'px';
      composer.style.overflowY = composer.scrollHeight > maxHeight ? 'auto' : 'hidden';
    }

    function nearEnd() {
      return scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight <= 48;
    }

    function followSoon() {
      if (!following) {
        return;
      }
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(function () {
        scroller.scrollTop = scroller.scrollHeight;
      });
    }

    composer.addEventListener('input', resize);
    composer.addEventListener('keydown', function (event) {
      if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
        event.preventDefault();
        if (!send.disabled && !send.hidden) {
          send.click();
        }
      }
    });
    send.addEventListener('click', function () { setTimeout(resize, 0); });
    scroller.addEventListener('scroll', function () { following = nearEnd(); }, { passive: true });
    new MutationObserver(followSoon).observe(scroller, { childList: true, subtree: true, characterData: true });

    function resetFollow() {
      following = true;
      followSoon();
    }
    if (threadList) {
      threadList.addEventListener('click', resetFollow, true);
    }
    if (newThread) {
      newThread.addEventListener('click', resetFollow, true);
    }
    resize();
    followSoon();
  }

  window.RAME_COMPOSER_UX = { init: init };
})();
