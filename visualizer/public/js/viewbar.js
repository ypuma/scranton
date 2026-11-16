// The view bar on the right edge: the two views of a chat, the side panels, the setup dialogs and Settings.
// Chat, Dashboard, Agents and Accounts already have their controls and their rules (who may open what, what a
// pipeline chat calls its second view): each bar button presses the control it stands for and shows its state,
// so there is one place that decides. The side panels and Settings are wired by their own modules.
const $ = (id) => document.getElementById(id);

// mirrors: [bar button, the control it presses, extra elements whose hidden state hides it too]
function mirror(bar, target, also, after) {
  const sync = () => {
    bar.hidden = target.hidden || also.some((x) => x.hidden);
    const pressed = target.getAttribute('aria-pressed');
    if (pressed !== null) bar.setAttribute('aria-pressed', pressed);
    after?.();
  };
  bar.addEventListener('click', () => target.click());
  if (typeof MutationObserver === 'function') {
    const watch = new MutationObserver(sync);
    for (const node of [target, ...also]) watch.observe(node, { attributes: true, childList: true, characterData: true, subtree: true });
  }
  sync();
  return sync;
}

export function createViewBar() {
  const thread = $('thread');
  const toggle = $('view-mode-toggle');
  const dash = $('view-mode-dash');
  mirror($('bar-chat'), $('view-mode-chat'), [thread, toggle]);
  // a pipeline chat calls its second view Details
  mirror($('bar-dash'), dash, [thread, toggle], () => {
    const label = dash.textContent.trim() || 'Dashboard';
    $('bar-dash-label').textContent = label;
    $('bar-dash').title = label;
  });
  mirror($('bar-agents'), $('agents-open'), [$('run-actions')]);
  const accounts = $('accounts-open');
  mirror($('bar-accounts'), accounts, [$('run-actions')], () => {
    const bar = $('bar-accounts');
    if (accounts.dataset.login) bar.dataset.login = accounts.dataset.login;
    else delete bar.dataset.login;
    $('bar-accounts-mark').textContent = $('accounts-mark').textContent;
  });
}
