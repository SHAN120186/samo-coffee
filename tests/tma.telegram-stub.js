// Stand-in for https://telegram.org/js/telegram-web-app.js used only by the local E2E check.
// Records every bridge call in window.__tg so the script can assert on them and drive callbacks.
(function () {
  var cfg = window.__TG_CFG__;
  var log = [];
  var events = {};
  var state = { main: { visible: false, active: true, text: '', progress: false, color: '' }, back: false, closing: false, invoice: null, popup: null, links: [], haptics: [] };
  var rec = function (name, args) { log.push({ name: name, args: Array.prototype.slice.call(args || []) }); };
  var cmp = function (a, b) { var x = a.split('.').map(Number), y = b.split('.').map(Number); for (var i = 0; i < 3; i++) { var d = (x[i] || 0) - (y[i] || 0); if (d) return d; } return 0; };
  var mainCb = null, backCb = null;
  var WebApp = {
    initData: cfg.initData,
    initDataUnsafe: { user: cfg.user, start_param: cfg.startParam || '' },
    version: cfg.version || '8.0',
    platform: 'ios',
    colorScheme: cfg.scheme || 'light',
    themeParams: cfg.themeParams,
    isVersionAtLeast: function (v) { return cmp(WebApp.version, v) >= 0; },
    ready: function () { rec('ready'); },
    expand: function () { rec('expand'); },
    close: function () { rec('close'); },
    disableVerticalSwipes: function () { rec('disableVerticalSwipes'); },
    setHeaderColor: function () { rec('setHeaderColor', arguments); },
    setBackgroundColor: function () { rec('setBackgroundColor', arguments); },
    setBottomBarColor: function () { rec('setBottomBarColor', arguments); },
    enableClosingConfirmation: function () { state.closing = true; rec('enableClosingConfirmation'); },
    disableClosingConfirmation: function () { state.closing = false; rec('disableClosingConfirmation'); },
    onEvent: function (name, cb) { (events[name] = events[name] || []).push(cb); },
    MainButton: {
      setParams: function (p) { rec('MainButton.setParams', [p]); if (p.text !== undefined) state.main.text = p.text; if (p.color) state.main.color = p.color; if (p.is_active !== undefined) state.main.active = p.is_active; if (p.is_visible !== undefined) state.main.visible = p.is_visible; },
      show: function () { state.main.visible = true; }, hide: function () { state.main.visible = false; rec('MainButton.hide'); },
      onClick: function (cb) { mainCb = cb; }, offClick: function () { mainCb = null; },
      showProgress: function () { state.main.progress = true; }, hideProgress: function () { state.main.progress = false; },
    },
    BackButton: { show: function () { state.back = true; rec('BackButton.show'); }, hide: function () { state.back = false; rec('BackButton.hide'); }, onClick: function (cb) { backCb = cb; } },
    HapticFeedback: {
      impactOccurred: function (s) { state.haptics.push('impact:' + s); },
      notificationOccurred: function (s) { state.haptics.push('notify:' + s); },
      selectionChanged: function () { state.haptics.push('select'); },
    },
    showPopup: function (params, cb) { state.popup = { params: params, cb: cb }; rec('showPopup', [params]); },
    openLink: function (url) { state.links.push(url); rec('openLink', [url]); },
    openTelegramLink: function (url) { state.links.push(url); rec('openTelegramLink', [url]); },
    openInvoice: function (url, cb) { state.invoice = { url: url, cb: cb }; rec('openInvoice', [url]); },
    requestContact: function (cb) { rec('requestContact'); setTimeout(function () { cb(true, { status: 'sent', responseUnsafe: { contact: { phone_number: '998935557788', first_name: 'Камила' } } }); }, 50); },
  };
  window.Telegram = { WebApp: WebApp };
  window.__tg = {
    log: log, state: state,
    clickMain: function () { if (mainCb && state.main.visible && state.main.active) { mainCb(); return true; } return false; },
    clickBack: function () { if (backCb && state.back) { backCb(); return true; } return false; },
    resolveInvoice: function (status) { var i = state.invoice; state.invoice = null; if (i) i.cb(status); return Boolean(i); },
    answerPopup: function (id) { var p = state.popup; state.popup = null; if (p) p.cb(id); return Boolean(p); },
    setTheme: function (params, scheme) { WebApp.themeParams = params; WebApp.colorScheme = scheme; (events.themeChanged || []).forEach(function (cb) { cb(); }); },
    calls: function (name) { return log.filter(function (l) { return l.name === name; }); },
  };
})();
