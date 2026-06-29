<script>
  import { highlightJson } from './highlighter.js';

  let { code, enabled = true } = $props();
  let html = $state('');
  let loading = $state(false);

  $effect(() => {
    const currentCode = code;
    const shouldHighlight = enabled;
    let cancelled = false;

    html = '';
    loading = false;

    if (!shouldHighlight) return;

    loading = true;
    highlightJson(currentCode)
      .then((result) => {
        if (!cancelled) html = result;
      })
      .catch(() => {
        if (!cancelled) html = '';
      })
      .finally(() => {
        if (!cancelled) loading = false;
      });

    return () => {
      cancelled = true;
    };
  });
</script>

{#if enabled && html}
  <div class="highlighted-json">{@html html}</div>
{:else}
  <pre class:highlight-loading={enabled && loading}>{code}</pre>
{/if}
