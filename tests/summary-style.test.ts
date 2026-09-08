import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("summary controls share one height and chart colors are distinct and comfortable", async () => {
  const dashboard = await readFile(new URL("../app/dashboard.tsx", import.meta.url), "utf8");
  const css = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");
  assert.match(css, /\.summary-numbers > span \{[^}]*min-height: 68px/);
  assert.match(css, /\.sort-control \{[^}]*min-height: 68px/);
  assert.match(css, /\.summary-side \{[^}]*align-items: stretch/);
  assert.match(dashboard, /const USAGE_COLORS = \["#8b7cf6", "#20b8d4", "#f2b84b"/);
  const palette = dashboard.match(/const USAGE_COLORS = \[(.*?)\]/)?.[1] || "";
  assert.doesNotMatch(palette, /#(?:000(?:000)?|f43f5e|ef4444|dc2626)/i);
});

test("account cards keep stacked quota rows while reducing unused vertical space", async () => {
  const css = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");
  assert.match(css, /\.account-card \{[^}]*padding: 24px/s);
  assert.match(css, /\.dual-quota-block \{ display: grid; gap: 10px; \}/);
  assert.doesNotMatch(css, /\.dual-quota-block \{[^}]*grid-template-columns/s);
  assert.match(css, /\.quota-meter \{[^}]*padding: 12px 15px 11px/s);
  assert.match(css, /\.card-actions \{[^}]*padding-top: 14px/s);
});

test("visual polish keeps motion purposeful and accessible", async () => {
  const dashboard = await readFile(new URL("../app/dashboard.tsx", import.meta.url), "utf8");
  const css = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");
  assert.match(dashboard, /dashboard-skeleton/);
  assert.match(dashboard, /headerScrolled/);
  assert.match(dashboard, /recentlySwitchedAccountId/);
  assert.match(dashboard, /className="trend-cursor"/);
  assert.match(dashboard, /modelHoverIndex/);
  assert.match(css, /\.app-header\.scrolled/);
  assert.match(css, /@keyframes trend-draw/);
  assert.match(css, /@keyframes skeleton-shimmer/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
});
