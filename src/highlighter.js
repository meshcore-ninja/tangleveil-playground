import { createHighlighterCore } from 'shiki/core';
import { createJavaScriptRegexEngine } from 'shiki/engine/javascript';

const THEME = 'github-dark-default';
const CACHE_LIMIT = 500;

let highlighterPromise;
const htmlCache = new Map();

function getHighlighter() {
  highlighterPromise ??= createHighlighterCore({
    themes: [import('@shikijs/themes/github-dark-default')],
    langs: [import('@shikijs/langs/json')],
    engine: createJavaScriptRegexEngine(),
  });

  return highlighterPromise;
}

export async function highlightJson(code) {
  const cached = htmlCache.get(code);
  if (cached) return cached;

  const highlighter = await getHighlighter();
  const html = highlighter.codeToHtml(code, {
    lang: 'json',
    theme: THEME,
  });

  htmlCache.set(code, html);
  if (htmlCache.size > CACHE_LIMIT) {
    htmlCache.delete(htmlCache.keys().next().value);
  }

  return html;
}
