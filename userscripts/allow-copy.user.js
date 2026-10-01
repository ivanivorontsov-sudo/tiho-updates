// ==UserScript==
// @name         Разрешить выделение и копирование
// @namespace    tiho.examples
// @version      1.0
// @description  Пример userscript: снимает запреты на выделение текста, копирование и контекстное меню.
// @author       Тихо
// @match        *://*/*
// @run-at       document-end
// @grant        GM_addStyle
// ==/UserScript==

(function () {
  'use strict';
  GM_addStyle('*{-webkit-user-select:text!important;user-select:text!important}');
  for (const ev of ['copy', 'cut', 'contextmenu', 'selectstart', 'dragstart']) {
    document.addEventListener(ev, (e) => e.stopPropagation(), true);
  }
  document.oncopy = document.oncontextmenu = document.onselectstart = null;
})();
