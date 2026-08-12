import * as vscode from 'vscode';

/** Everything shared across the three webviews: nonce, codicon font wiring, escaping. */

export function getNonce(): string {
  let text = '';
  const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) text += possible.charAt(Math.floor(Math.random() * possible.length));
  return text;
}

export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * URI to the folder containing codicon.css + codicon.ttf, for a <link> tag.
 * Relative url(...) inside the CSS resolves against this same folder.
 *
 * These two files are vendored into media/codicons/ (copied from
 * @vscode/codicons/dist) rather than read from node_modules at runtime:
 * `vsce package` doesn't bundle node_modules by default once it detects a
 * bundler (esbuild) in devDependencies, so anything only reachable via a
 * node_modules path silently goes missing from the packaged .vsix. To
 * refresh after bumping the @vscode/codicons devDependency:
 *   cp node_modules/@vscode/codicons/dist/codicon.{css,ttf} media/codicons/
 */
export function codiconsDirUri(webview: vscode.Webview, extensionUri: vscode.Uri): vscode.Uri {
  return webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'codicons'));
}

export function localResourceRoots(extensionUri: vscode.Uri): vscode.Uri[] {
  return [extensionUri, vscode.Uri.joinPath(extensionUri, 'media', 'codicons')];
}

export function cspFor(webview: vscode.Webview, nonce: string): string {
  return [
    `default-src 'none'`,
    `img-src ${webview.cspSource} data:`,
    `style-src ${webview.cspSource} 'unsafe-inline'`,
    `font-src ${webview.cspSource}`,
    `script-src 'nonce-${nonce}'`,
  ].join('; ');
}

/** Shared design tokens + base layout rules used by all Ariadne webviews. */
export const SHARED_STYLE = `
  :root {
    color-scheme: light dark;
    --r-sm: 3px;
    --r-badge: 2px;
    --mono: var(--vscode-editor-font-family, ui-monospace, "SF Mono", Menlo, Consolas, monospace);
  }
  * { box-sizing: border-box; }
  body {
    font-family: var(--vscode-font-family, system-ui, -apple-system, "Segoe UI", sans-serif);
    font-size: var(--vscode-font-size, 13px);
    color: var(--vscode-foreground);
    background: var(--vscode-editor-background);
    margin: 0;
    -webkit-font-smoothing: antialiased;
  }
  .codicon { font-size: 14px; vertical-align: middle; }
  .mono { font-family: var(--mono); }

  /* Type color mapping — categorical, fixed order, never reused for status */
  .type-functional     { --type-color: var(--vscode-charts-blue, #3987e5); }
  .type-non-functional { --type-color: var(--vscode-charts-purple, #9085e9); }
  .type-business        { --type-color: var(--vscode-charts-orange, #d95926); }
  .type-technical        { --type-color: var(--vscode-charts-yellow, #c98500); }

  /* Status color mapping — reserved, never reused for the type chips above */
  .status-good     { --status-color: var(--vscode-testing-iconPassed, var(--vscode-charts-green, #2ea043)); }
  .status-warning  { --status-color: var(--vscode-charts-yellow, #d29933); }
  .status-critical { --status-color: var(--vscode-testing-iconFailed, var(--vscode-charts-red, #f14c4c)); }
  .status-neutral  { --status-color: var(--vscode-descriptionForeground, #8b8b8b); }

  ::selection { background: var(--vscode-editor-selectionBackground); }
  a { color: var(--vscode-textLink-foreground); cursor: pointer; text-decoration: none; }
  a:hover { color: var(--vscode-textLink-activeForeground); text-decoration: underline; }

  button {
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
    border: none;
    padding: 5px 10px;
    border-radius: var(--r-sm);
    cursor: pointer;
    font-size: 12px;
    font-family: inherit;
    display: inline-flex;
    align-items: center;
    gap: 5px;
    white-space: nowrap;
  }
  button:hover { background: var(--vscode-button-hoverBackground); }
  button:active { transform: translateY(0.5px); }
  button:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 1px; }
  button:disabled { opacity: 0.45; cursor: not-allowed; }
  button.secondary {
    background: transparent;
    color: var(--vscode-foreground);
    border: 1px solid var(--vscode-widget-border, rgba(128,128,128,0.35));
  }
  button.secondary:hover { background: var(--vscode-toolbar-hoverBackground); }
  button.ghost {
    background: transparent;
    color: var(--vscode-descriptionForeground);
    border: none;
    padding: 3px 6px;
  }
  button.ghost:hover { background: var(--vscode-toolbar-hoverBackground); color: var(--vscode-foreground); }
  button.danger:hover { background: var(--vscode-inputValidation-errorBackground); color: var(--vscode-errorForeground); }
  button.danger.confirming, button.danger.confirming:hover {
    background: var(--vscode-inputValidation-errorBackground);
    color: var(--vscode-errorForeground);
    border: 1px solid var(--vscode-inputValidation-errorBorder, transparent);
  }
  button.icon-only { padding: 4px; }

  textarea, input[type="text"] {
    background: var(--vscode-input-background);
    color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-input-border, transparent);
    border-radius: var(--r-sm);
    font-family: inherit;
    font-size: 12.5px;
    padding: 6px 8px;
  }
  textarea:focus, input[type="text"]:focus, select:focus {
    outline: none;
    border-color: var(--vscode-focusBorder);
  }
  select {
    background: var(--vscode-dropdown-background);
    color: var(--vscode-dropdown-foreground);
    border: 1px solid var(--vscode-dropdown-border, transparent);
    padding: 4px 6px;
    font-size: 12px;
    border-radius: var(--r-sm);
    font-family: inherit;
  }

  /* Rectangular status/type badges — deliberately not pill-shaped. */
  .chip {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    font-size: 10px;
    font-weight: 600;
    font-family: var(--mono);
    padding: 2px 6px;
    border-radius: var(--r-badge);
    text-transform: uppercase;
    letter-spacing: 0.04em;
    line-height: 1.5;
    white-space: nowrap;
    border: 1px solid transparent;
  }
  .chip.type-chip {
    color: var(--type-color);
    background: color-mix(in srgb, var(--type-color) 10%, transparent);
    border-color: color-mix(in srgb, var(--type-color) 35%, transparent);
  }
  .chip.status-chip {
    color: var(--status-color);
    background: color-mix(in srgb, var(--status-color) 10%, transparent);
    border-color: color-mix(in srgb, var(--status-color) 35%, transparent);
  }
  .chip .codicon { font-size: 10.5px; }

  /*
   * Left-edge accent bar — the recurring "object type" cue. Pair with a
   * .type-* or .status-* class (already used by .chip above) on the same
   * element to feed --type-color/--status-color into the border.
   * Compound selectors (not bare .accent-bar) so specificity beats each
   * panel's own .card/.feed-row border shorthand regardless of source order.
   */
  .card.accent-bar, .feed-row.accent-bar, .finding-row.accent-bar, .gnode.accent-bar {
    border-left-width: 3px;
    border-left-style: solid;
    border-left-color: var(--type-color, var(--status-color, var(--vscode-widget-border, transparent)));
  }
  /* Higher specificity than any panel's .card:hover { border-color: ... } shorthand,
     so the accent color survives hover instead of flipping to the focus border. */
  .card.accent-bar:hover, .feed-row.accent-bar:hover, .finding-row.accent-bar:hover, .gnode.accent-bar:hover {
    border-left-color: var(--type-color, var(--status-color, var(--vscode-widget-border, transparent)));
  }

  /* Shared "editor tab" page chrome — dashboard, spec health, traceability graph */
  .page { max-width: 900px; margin: 0 auto; padding: 32px 40px 60px; }
  .page-header, header.page-header { margin-bottom: 20px; }
  .eyebrow {
    display: flex; align-items: center; gap: 6px;
    font-size: 10.5px; text-transform: uppercase; letter-spacing: 0.07em;
    color: var(--vscode-charts-blue, #3987e5); font-weight: 600; margin-bottom: 6px;
    font-family: var(--mono);
  }
  .page-header h1, header.page-header h1 {
    font-size: 20px; margin: 0 0 4px; font-weight: 600;
    display: flex; align-items: center; gap: 10px;
  }
  .page-header h1 .codicon, header.page-header h1 .codicon { font-size: 19px; color: var(--vscode-charts-blue, #3987e5); }
  .subtitle { opacity: 0.6; font-size: 12px; }
  .page h2 {
    font-size: 11px; text-transform: uppercase; letter-spacing: 0.06em; opacity: 0.75;
    margin: 0 0 10px; display: flex; align-items: center; gap: 7px; font-weight: 600;
    font-family: var(--mono);
  }
  .page h2 .codicon { font-size: 13px; font-family: initial; }

  .empty-state {
    display: flex;
    flex-direction: column;
    align-items: center;
    text-align: center;
    padding: 28px 16px;
    gap: 6px;
    color: var(--vscode-descriptionForeground);
  }
  .empty-state .codicon { font-size: 22px; opacity: 0.55; margin-bottom: 4px; }
  .empty-state .empty-title { font-size: 12.5px; font-weight: 600; color: var(--vscode-foreground); }
  .empty-state .empty-desc { font-size: 11.5px; max-width: 280px; line-height: 1.5; }

  ::-webkit-scrollbar { width: 10px; height: 10px; }
  ::-webkit-scrollbar-thumb { background: var(--vscode-scrollbarSlider-background); border-radius: 5px; }
  ::-webkit-scrollbar-thumb:hover { background: var(--vscode-scrollbarSlider-hoverBackground); }
`;
