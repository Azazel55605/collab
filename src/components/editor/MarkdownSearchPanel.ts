import {
  closeSearchPanel,
  findNext,
  findPrevious,
  getSearchQuery,
  replaceAll,
  replaceNext,
  type search,
  SearchQuery,
  setSearchQuery,
} from '@codemirror/search';
import type { EditorView, Panel } from '@codemirror/view';

import { getSearchMatchStats } from './editorSearchUtils';

type SearchPanelFactory = NonNullable<Parameters<typeof search>[0]>['createPanel'];

function panelButton(label: string, title: string, className = '') {
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = label;
  button.title = title;
  button.className = `cm-search-panel-button ${className}`.trim();
  return button;
}

function panelToggle(label: string) {
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = label;
  button.className = 'cm-search-panel-toggle';
  button.setAttribute('aria-pressed', 'false');
  return button;
}

function buildQuery(
  searchInput: HTMLInputElement,
  replaceInput: HTMLInputElement,
  caseSensitiveToggle: HTMLButtonElement,
  regexpToggle: HTMLButtonElement,
  wholeWordToggle: HTMLButtonElement,
) {
  return new SearchQuery({
    search: searchInput.value,
    replace: replaceInput.value,
    caseSensitive: caseSensitiveToggle.getAttribute('aria-pressed') === 'true',
    regexp: regexpToggle.getAttribute('aria-pressed') === 'true',
    wholeWord: wholeWordToggle.getAttribute('aria-pressed') === 'true',
  });
}

function syncToggle(toggle: HTMLButtonElement, active: boolean) {
  toggle.setAttribute('aria-pressed', active ? 'true' : 'false');
  toggle.classList.toggle('is-active', active);
}

function syncFromQuery(
  view: EditorView,
  searchInput: HTMLInputElement,
  replaceInput: HTMLInputElement,
  caseSensitiveToggle: HTMLButtonElement,
  regexpToggle: HTMLButtonElement,
  wholeWordToggle: HTMLButtonElement,
  status: HTMLDivElement,
) {
  const query = getSearchQuery(view.state);
  if (searchInput.value !== query.search) searchInput.value = query.search;
  if (replaceInput.value !== query.replace) replaceInput.value = query.replace;
  syncToggle(caseSensitiveToggle, query.caseSensitive);
  syncToggle(regexpToggle, query.regexp);
  syncToggle(wholeWordToggle, query.wholeWord);

  if (!query.search) {
    status.textContent = 'Type to search';
    status.classList.remove('is-error');
    return;
  }

  if (!query.valid) {
    status.textContent = 'Invalid pattern';
    status.classList.add('is-error');
    return;
  }

  const stats = getSearchMatchStats(view.state, query);
  status.classList.remove('is-error');
  status.textContent =
    stats.total === 0
      ? 'No matches'
      : stats.current > 0
        ? `${stats.current} of ${stats.total}`
        : `${stats.total} matches`;
}

function dispatchQuery(
  view: EditorView,
  searchInput: HTMLInputElement,
  replaceInput: HTMLInputElement,
  caseSensitiveToggle: HTMLButtonElement,
  regexpToggle: HTMLButtonElement,
  wholeWordToggle: HTMLButtonElement,
) {
  view.dispatch({
    effects: setSearchQuery.of(
      buildQuery(searchInput, replaceInput, caseSensitiveToggle, regexpToggle, wholeWordToggle),
    ),
  });
}

export const createMarkdownSearchPanel: SearchPanelFactory = (view) => {
  const dom = document.createElement('div');
  dom.className = 'cm-search-panel';

  const searchRow = document.createElement('div');
  searchRow.className = 'cm-search-panel-row';

  const searchField = document.createElement('label');
  searchField.className = 'cm-search-panel-field cm-search-panel-field-search';
  const searchLabel = document.createElement('span');
  searchLabel.className = 'cm-search-panel-label';
  searchLabel.textContent = 'Find';
  const searchInput = document.createElement('input');
  searchInput.type = 'text';
  searchInput.placeholder = 'Search in note…';
  searchInput.className = 'cm-search-panel-input';
  searchInput.setAttribute('main-field', 'true');
  searchField.append(searchLabel, searchInput);

  const status = document.createElement('div');
  status.className = 'cm-search-panel-status';

  const prevButton = panelButton('Prev', 'Previous match');
  const nextButton = panelButton('Next', 'Next match', 'is-primary');
  const closeButton = panelButton('Close', 'Close search');

  searchRow.append(searchField, status, prevButton, nextButton, closeButton);

  const replaceRow = document.createElement('div');
  replaceRow.className = 'cm-search-panel-row';

  const replaceField = document.createElement('label');
  replaceField.className = 'cm-search-panel-field';
  const replaceLabel = document.createElement('span');
  replaceLabel.className = 'cm-search-panel-label';
  replaceLabel.textContent = 'Replace';
  const replaceInput = document.createElement('input');
  replaceInput.type = 'text';
  replaceInput.placeholder = 'Replacement text…';
  replaceInput.className = 'cm-search-panel-input';
  replaceField.append(replaceLabel, replaceInput);

  const caseSensitiveToggle = panelToggle('Match case');
  const wholeWordToggle = panelToggle('Whole word');
  const regexpToggle = panelToggle('Regex');
  const replaceButton = panelButton('Replace', 'Replace current match');
  const replaceAllButton = panelButton('Replace all', 'Replace all matches');

  replaceRow.append(
    replaceField,
    caseSensitiveToggle,
    wholeWordToggle,
    regexpToggle,
    replaceButton,
    replaceAllButton,
  );

  dom.append(searchRow, replaceRow);

  const applyQuery = () => {
    dispatchQuery(
      view,
      searchInput,
      replaceInput,
      caseSensitiveToggle,
      regexpToggle,
      wholeWordToggle,
    );
    syncFromQuery(
      view,
      searchInput,
      replaceInput,
      caseSensitiveToggle,
      regexpToggle,
      wholeWordToggle,
      status,
    );
  };

  const runCommand = (command: (target: EditorView) => boolean) => {
    command(view);
    syncFromQuery(
      view,
      searchInput,
      replaceInput,
      caseSensitiveToggle,
      regexpToggle,
      wholeWordToggle,
      status,
    );
  };

  searchInput.addEventListener('input', applyQuery);
  replaceInput.addEventListener('input', applyQuery);

  for (const toggle of [caseSensitiveToggle, wholeWordToggle, regexpToggle]) {
    toggle.addEventListener('click', () => {
      syncToggle(toggle, toggle.getAttribute('aria-pressed') !== 'true');
      applyQuery();
      searchInput.focus();
    });
  }

  prevButton.addEventListener('click', () => runCommand(findPrevious));
  nextButton.addEventListener('click', () => runCommand(findNext));
  replaceButton.addEventListener('click', () => runCommand(replaceNext));
  replaceAllButton.addEventListener('click', () => runCommand(replaceAll));
  closeButton.addEventListener('click', () => {
    closeSearchPanel(view);
    view.focus();
  });

  searchInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      runCommand(event.shiftKey ? findPrevious : findNext);
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      closeSearchPanel(view);
      view.focus();
    }
  });

  replaceInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      runCommand(event.shiftKey ? replaceAll : replaceNext);
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      closeSearchPanel(view);
      view.focus();
    }
  });

  syncFromQuery(
    view,
    searchInput,
    replaceInput,
    caseSensitiveToggle,
    regexpToggle,
    wholeWordToggle,
    status,
  );

  return {
    dom,
    top: true,
    mount() {
      searchInput.focus();
      searchInput.select();
    },
    update(update) {
      if (
        update.docChanged ||
        update.selectionSet ||
        update.transactions.some((tr) => tr.effects.some((effect) => effect.is(setSearchQuery)))
      ) {
        syncFromQuery(
          update.view,
          searchInput,
          replaceInput,
          caseSensitiveToggle,
          regexpToggle,
          wholeWordToggle,
          status,
        );
      }
    },
  } satisfies Panel;
};
