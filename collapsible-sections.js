const EXCLUDED_SELECTOR = [
  '.modal-overlay',
  '.modal-panel',
  '.catalog-panel',
  '.toast',
  '.drop-zone',
  '.app-collapsible__body',
  '.app-collapsible__header',
  '.app-collapsible__toggle',
  '.app-collapsible-toolbar',
  '#appRoot',
  '#app',
  'header',
  'footer',
  'nav',
  'main',
  'aside',
  'form',
  'table',
  'thead',
  'tbody',
  'tfoot',
  'tr',
  'ul',
  'ol',
].join(', ');

const HEADING_SELECTOR = ':scope > h1, :scope > h2, :scope > h3, :scope > h4, :scope > h5, :scope > h6, :scope > [data-collapsible-heading]';
const PANEL_SELECTOR = '.catalog-panel, .module-hub-modal';
const PERSISTED_STATE = new Map();

let observer = null;
let scanScheduled = false;
let handlersBound = false;
let fullScanQueued = false;
const queuedScanRoots = new Set();

function t(key, fallback, values = {}) {
  const translated = window.miniappI18n?.t?.(key, values);
  return translated && translated !== key ? translated : fallback;
}

function getHeading(container) {
  if (!(container instanceof HTMLElement)) return null;
  return container.querySelector(HEADING_SELECTOR);
}

function getMeaningfulNodes(container) {
  return Array.from(container.childNodes).filter((node) => {
    if (node instanceof HTMLElement) return true;
    return String(node.textContent || '').trim();
  });
}

function isExcludedContainer(container) {
  if (!(container instanceof HTMLElement)) return true;
  if (container.matches(EXCLUDED_SELECTOR)) return true;
  if (container.dataset.collapsible === 'off') return true;
  if (container.dataset.collapsibleReady === '1') return true;
  if (container.querySelector(':scope > .app-collapsible__header')) return true;
  if (container.closest('.app-collapsible__body')) return true;
  if (container.closest('[data-collapsible="off"]')) return true;
  return false;
}

function isAutoCandidate(container) {
  if (!(container instanceof HTMLElement)) return false;
  if (isExcludedContainer(container)) return false;

  const tag = container.tagName;
  const explicit = tag === 'SECTION' || container.dataset.collapsible === 'on';
  const autoTagAllowed = tag === 'DIV' || tag === 'ARTICLE';
  if (!explicit && !autoTagAllowed) return false;

  const heading = getHeading(container);
  if (!heading) return false;

  const contentNodes = getMeaningfulNodes(container);
  if (contentNodes.length < 2) return false;

  const directElementChildren = Array.from(container.children);
  if (tag !== 'SECTION' && container.dataset.collapsible !== 'on') {
    if (directElementChildren.length < 2) return false;
    const contentElementCount = directElementChildren.filter((child) => child !== heading).length;
    if (contentElementCount === 0) return false;
  }

  return true;
}

function getContainerKey(container, heading) {
  const owner = container.closest('[id]');
  const title = container.dataset.collapseKey
    || heading?.dataset?.collapseKey
    || heading?.textContent?.trim()
    || 'section';
  const ownerId = owner?.id || 'global';
  return `${ownerId}:${title}`;
}

function readExpandedState(container, heading) {
  const key = getContainerKey(container, heading);
  if (PERSISTED_STATE.has(key)) return PERSISTED_STATE.get(key);
  return container.dataset.collapsedDefault === 'false';
}

function writeExpandedState(container, heading, expanded) {
  const key = getContainerKey(container, heading);
  PERSISTED_STATE.set(key, expanded);
}

function setExpanded(container, body, button, heading, expanded) {
  const headingTitle = heading?.textContent?.trim() || t('ui.section', 'Раздел');
  const label = expanded
    ? t('ui.collapse', 'Свернуть')
    : t('ui.expand', 'Развернуть');

  container.dataset.collapsed = expanded ? 'false' : 'true';
  body.hidden = !expanded;
  button.dataset.expanded = expanded ? 'true' : 'false';
  button.setAttribute('aria-expanded', String(expanded));

  const labelEl = button.querySelector('.app-collapsible__label');
  if (labelEl) labelEl.textContent = label;

  const iconEl = button.querySelector('.app-collapsible__icon');
  if (iconEl) iconEl.textContent = expanded ? '▾' : '▸';

  button.setAttribute('aria-label', `${label} блок «${headingTitle}»`);
  writeExpandedState(container, heading, expanded);
  container.dispatchEvent(new CustomEvent('app-collapsible-change', {
    bubbles: true,
    detail: { expanded },
  }));
}

function enhanceContainer(container) {
  if (!isAutoCandidate(container)) return;

  const heading = getHeading(container);
  if (!heading) return;

  const childNodes = getMeaningfulNodes(container);
  if (childNodes.length < 2) return;

  const header = document.createElement('div');
  header.className = 'app-collapsible__header';

  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = 'app-collapsible__toggle';
  toggle.dataset.collapsibleAction = 'toggle-one';
  toggle.innerHTML = [
    '<span class="app-collapsible__icon" aria-hidden="true">▸</span>',
    `<span class="app-collapsible__label">${t('ui.expand', 'Развернуть')}</span>`,
  ].join('');

  const body = document.createElement('div');
  body.className = 'app-collapsible__body';

  container.classList.add('app-collapsible');
  container.dataset.collapsibleReady = '1';

  header.appendChild(heading);
  header.appendChild(toggle);

  container.appendChild(header);
  container.appendChild(body);

  childNodes.forEach((node) => {
    if (node === header || node === body || node === heading) return;
    body.appendChild(node);
  });

  const expanded = readExpandedState(container, heading);
  setExpanded(container, body, toggle, heading, expanded);
}

function getPanelsForRoot(root) {
  const panels = new Set();

  if (root instanceof Document) {
    root.querySelectorAll(PANEL_SELECTOR).forEach((panel) => panels.add(panel));
    return Array.from(panels);
  }

  if (!(root instanceof HTMLElement)) return [];

  if (root.matches(PANEL_SELECTOR)) panels.add(root);
  const host = root.closest(PANEL_SELECTOR);
  if (host) panels.add(host);
  root.querySelectorAll(PANEL_SELECTOR).forEach((panel) => panels.add(panel));

  return Array.from(panels);
}

function scanContainers(root = document) {
  if (!(root instanceof Document || root instanceof HTMLElement)) return;

  const scopes = root instanceof Document
    ? getPanelsForRoot(root)
    : [root];

  const candidates = [];
  scopes.forEach((scope) => {
    if (!(scope instanceof HTMLElement)) return;
    if (scope.matches('section, div, article')) candidates.push(scope);
    scope.querySelectorAll('section, div, article').forEach((node) => candidates.push(node));
  });

  candidates.forEach(enhanceContainer);
}

function findPanelHost(node) {
  if (!(node instanceof HTMLElement)) return null;
  return node.closest(PANEL_SELECTOR);
}

function getPanelCollapsibles(panel) {
  if (!(panel instanceof HTMLElement)) return [];
  return Array.from(panel.querySelectorAll('.app-collapsible[data-collapsible-ready="1"]'));
}

function getContainerParts(container) {
  if (!(container instanceof HTMLElement)) return null;
  const body = container.querySelector(':scope > .app-collapsible__body');
  const button = container.querySelector(':scope > .app-collapsible__header .app-collapsible__toggle');
  const heading = container.querySelector(':scope > .app-collapsible__header > h1, :scope > .app-collapsible__header > h2, :scope > .app-collapsible__header > h3, :scope > .app-collapsible__header > h4, :scope > .app-collapsible__header > h5, :scope > .app-collapsible__header > h6, :scope > .app-collapsible__header > [data-collapsible-heading]');
  if (!(body instanceof HTMLElement) || !(button instanceof HTMLButtonElement)) return null;
  return { body, button, heading };
}

function setCollapsiblesExpanded(panel, expanded) {
  const containers = getPanelCollapsibles(panel);
  containers.forEach((container) => {
    const parts = getContainerParts(container);
    if (!parts) return;
    setExpanded(container, parts.body, parts.button, parts.heading, expanded);
  });
  refreshPanelToolbar(panel);
}

function createToolbar() {
  const toolbar = document.createElement('div');
  toolbar.className = 'app-collapsible-toolbar';
  toolbar.dataset.collapsible = 'off';

  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'app-collapsible-toolbar__btn';
  button.dataset.role = 'toggle-all';
  button.dataset.collapsibleAction = 'toggle-all';

  toolbar.appendChild(button);
  return toolbar;
}

function getToolbarInsertReference(panel) {
  if (!(panel instanceof HTMLElement)) return null;
  const firstElement = Array.from(panel.children).find((child) => !child.classList.contains('app-collapsible-toolbar'));
  return firstElement ? firstElement.nextSibling : null;
}

function refreshPanelToolbar(panel) {
  if (!(panel instanceof HTMLElement)) return;

  const collapsibles = getPanelCollapsibles(panel);
  let toolbar = panel.querySelector(':scope > .app-collapsible-toolbar');

  if (collapsibles.length === 0) {
    toolbar?.remove();
    return;
  }

  if (!toolbar) {
    toolbar = createToolbar();
    panel.insertBefore(toolbar, getToolbarInsertReference(panel));
  }

  const button = toolbar.querySelector('[data-role="toggle-all"]');
  if (!(button instanceof HTMLButtonElement)) return;

  const allExpanded = collapsibles.every((container) => container.dataset.collapsed === 'false');
  button.textContent = allExpanded
    ? t('ui.collapseAll', 'Свернуть все')
    : t('ui.expandAll', 'Развернуть все');
  button.dataset.allExpanded = allExpanded ? 'true' : 'false';
  button.setAttribute('aria-label', button.textContent);
}

function scanPanels(root = document) {
  if (!(root instanceof Document || root instanceof HTMLElement)) return;
  const panels = getPanelsForRoot(root);
  panels.forEach(refreshPanelToolbar);
}

function handleToggleOne(button) {
  const container = button.closest('.app-collapsible');
  if (!(container instanceof HTMLElement)) return;
  const parts = getContainerParts(container);
  if (!parts) return;
  const nextExpanded = button.getAttribute('aria-expanded') !== 'true';
  setExpanded(container, parts.body, parts.button, parts.heading, nextExpanded);
}

function handleToggleAll(button) {
  const panel = button.closest(PANEL_SELECTOR);
  if (!(panel instanceof HTMLElement)) return;
  const allExpanded = getPanelCollapsibles(panel).every((container) => container.dataset.collapsed === 'false');
  setCollapsiblesExpanded(panel, !allExpanded);
}

function bindDelegatedHandlers() {
  if (handlersBound) return;
  handlersBound = true;

  document.addEventListener('click', (event) => {
    const actionEl = event.target instanceof Element
      ? event.target.closest('[data-collapsible-action]')
      : null;
    if (!(actionEl instanceof HTMLButtonElement)) return;

    if (actionEl.dataset.collapsibleAction === 'toggle-one') {
      handleToggleOne(actionEl);
      return;
    }

    if (actionEl.dataset.collapsibleAction === 'toggle-all') {
      handleToggleAll(actionEl);
    }
  });
}

function scheduleScan(root = document) {
  if (root instanceof Document) {
    fullScanQueued = true;
    queuedScanRoots.clear();
  } else if (root instanceof HTMLElement && !fullScanQueued) {
    queuedScanRoots.add(root);
  }

  if (scanScheduled) return;
  scanScheduled = true;
  requestAnimationFrame(() => {
    scanScheduled = false;

    if (fullScanQueued || queuedScanRoots.size === 0) {
      scanContainers(document);
      scanPanels(document);
    } else {
      Array.from(queuedScanRoots).forEach((scanRoot) => {
        scanContainers(scanRoot);
        scanPanels(scanRoot);
      });
    }

    fullScanQueued = false;
    queuedScanRoots.clear();
  });
}

export function initCollapsibleSections() {
  bindDelegatedHandlers();

  if (observer) {
    scheduleScan(document);
    return;
  }

  scanContainers(document);
  scanPanels(document);

  document.addEventListener('app-collapsible-change', (event) => {
    const panel = findPanelHost(event.target);
    if (panel) refreshPanelToolbar(panel);
  });

  observer = new MutationObserver((mutations) => {
    const rootsToScan = new Set();

    for (const mutation of mutations) {
      if (mutation.type !== 'childList') continue;
      if (mutation.addedNodes.length === 0 && mutation.removedNodes.length === 0) continue;

      if (mutation.target instanceof HTMLElement) {
        rootsToScan.add(mutation.target);
      }

      mutation.addedNodes.forEach((node) => {
        if (node instanceof HTMLElement) rootsToScan.add(node);
      });

      mutation.removedNodes.forEach((node) => {
        if (node instanceof HTMLElement && node.parentElement) rootsToScan.add(node.parentElement);
      });
    }

    if (rootsToScan.size === 0) return;
    rootsToScan.forEach((root) => scheduleScan(root));
  });

  observer.observe(document.body, {
    childList: true,
    subtree: true,
  });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => initCollapsibleSections(), { once: true });
} else {
  initCollapsibleSections();
}
