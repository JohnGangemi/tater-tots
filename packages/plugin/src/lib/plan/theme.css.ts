export const PLAN_THEME_CSS = `:root[data-theme="light"] {
  color-scheme: light;
  --bg: #fafafa;
  --fg: #1a1a1a;
  --muted: #555555;
  --border: #dddddd;
  --accent: #0b57d0;
}
:root[data-theme="dark"] {
  color-scheme: dark;
  --bg: #121212;
  --fg: #f2f2f2;
  --muted: #bbbbbb;
  --border: #333333;
  --accent: #8ab4f8;
}
:root[data-theme="system"] {
  color-scheme: light;
  --bg: #fafafa;
  --fg: #1a1a1a;
  --muted: #555555;
  --border: #dddddd;
  --accent: #0b57d0;
}
@media (prefers-color-scheme: dark) {
  :root[data-theme="system"] {
    color-scheme: dark;
    --bg: #121212;
    --fg: #f2f2f2;
    --muted: #bbbbbb;
    --border: #333333;
    --accent: #8ab4f8;
  }
}
html { background: var(--bg); color: var(--fg); }
body {
  margin: 0 auto;
  max-width: 52rem;
  padding: 1.5rem 1rem 3rem;
  font-family: system-ui, sans-serif;
  line-height: 1.5;
}
h1, h2, h3 { line-height: 1.25; }
h1 { font-size: 1.75rem; }
h2 { font-size: 1.25rem; margin-top: 2rem; }
h3 { font-size: 1.05rem; }
section { border-top: 1px solid var(--border); padding-top: 0.5rem; }
.muted { color: var(--muted); }
code {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 0.9em;
}
.theme-controls { display: flex; gap: 0.5rem; margin: 0.75rem 0 1.25rem; }
.theme-controls button {
  background: var(--bg);
  color: var(--fg);
  border: 1px solid var(--border);
  border-radius: 0.25rem;
  padding: 0.25rem 0.6rem;
  cursor: pointer;
}
.theme-controls button:focus { outline: 2px solid var(--accent); }
footer { margin-top: 2.5rem; color: var(--muted); font-size: 0.9rem; }
`;
