# AgentEra Transparent In-App Mark Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the opaque tile and fixed black circle from the renderer-only AgentEra mark so it blends with both light and dark application themes.

**Architecture:** Keep every operating-system/package icon unchanged and edit only the renderer asset consumed by in-app brand surfaces. Enforce the boundary with PNG color-type and CSS regression tests, then visually verify the running desktop in both supported theme polarities.

**Tech Stack:** PNG RGBA asset, React 19, CSS, Vitest 4, Electron 39, electron-vite 5.

## Global Constraints

- Only `src/renderer/src/assets/iconv2.png` becomes transparent.
- `assets/agentera-icon.png`, `build/icon.icns`, `build/icon.ico`, `build/icon.png`, and `resources/icon.png` remain byte-for-byte unchanged.
- Preserve the existing blue-purple AgentEra artwork and its proportions.
- Preserve the empty-state dimensions, centering, spacing, text, interactions, and theme behavior.
- Do not alter third-party provider or service icons.
- Do not push or publish the branch.

---

### Task 1: Lock the transparent renderer-mark contract

**Files:**

- Modify: `tests/agentera-icon-assets.test.ts`
- Modify: `tests/agentera-composed-surfaces.test.ts`

**Interfaces:**

- Consumes: PNG IHDR color type at byte offset 25 and the `.chat-empty-icon` rule in `src/renderer/src/assets/main.css`.
- Produces: regression gates that require RGBA transparency for the renderer mark and reject the fixed black empty-state background.

- [ ] **Step 1: Add the failing PNG alpha test**

Add this helper to `tests/agentera-icon-assets.test.ts`:

```ts
function pngHasAlpha(path: string): boolean {
  const colorType = readAsset(path).readUInt8(25);
  return colorType === 4 || colorType === 6;
}
```

Add this assertion after the renderer PNG size assertion:

```ts
expect(pngHasAlpha("src/renderer/src/assets/iconv2.png")).toBe(true);
```

Keep the existing source-icon SHA-256 assertion and every package-icon format/size assertion unchanged.

- [ ] **Step 2: Add the failing CSS background test**

In `tests/agentera-composed-surfaces.test.ts`, add:

```ts
it("keeps the empty-state AgentEra mark transparent", () => {
  const styles = read("src/renderer/src/assets/main.css");
  const emptyIconRule = styles.match(/\.chat-empty-icon\s*\{([^}]*)\}/)?.[1];

  expect(emptyIconRule).toBeDefined();
  expect(emptyIconRule).not.toMatch(/background\s*:\s*#000/i);
});
```

- [ ] **Step 3: Run the tests to verify RED**

Run:

```bash
npx vitest run tests/agentera-icon-assets.test.ts tests/agentera-composed-surfaces.test.ts
```

Expected: two failures—`iconv2.png` has PNG color type `2` without alpha, and `.chat-empty-icon` still contains `background: #000`.

- [ ] **Step 4: Commit the failing contract**

```bash
git add tests/agentera-icon-assets.test.ts tests/agentera-composed-surfaces.test.ts
git commit -m "test: require transparent AgentEra renderer mark"
```

### Task 2: Produce and verify the adaptive in-app mark

**Files:**

- Modify: `src/renderer/src/assets/iconv2.png`
- Modify: `src/renderer/src/assets/main.css`
- Verify: `assets/agentera-icon.png`
- Verify: `build/icon.icns`
- Verify: `build/icon.ico`
- Verify: `build/icon.png`
- Verify: `resources/icon.png`

**Interfaces:**

- Consumes: the existing 512×512 renderer artwork and the approved blue-purple AgentEra visual identity.
- Produces: a 512×512 RGBA renderer mark with transparent background; `.chat-empty-icon` retains its 80×80 layout box with no forced fill.

- [ ] **Step 1: Generate the transparent renderer asset**

Use the image-editing tool with `src/renderer/src/assets/iconv2.png` as the reference and this exact intent:

```text
Preserve the existing blue-purple AgentEra symbol exactly. Remove the entire white/light-gray background tile and its drop shadow, leaving true transparent RGBA pixels around the mark. Keep the symbol centered, sharp, and proportionally unchanged; scale the extracted mark to use the canvas efficiently without clipping. Output a square 512×512 PNG with no text and no replacement background.
```

Replace only `src/renderer/src/assets/iconv2.png`. Confirm with `sips` that it is 512×512 and has an alpha channel.

- [ ] **Step 2: Remove the fixed black empty-state fill**

Change the rule in `src/renderer/src/assets/main.css` to:

```css
.chat-empty-icon {
  width: 80px;
  height: 80px;
  display: flex;
  align-items: center;
  justify-content: center;
  margin-bottom: 4px;
}
```

Keep `.chat-empty-logo` dimensions and every surrounding empty-state style unchanged.

- [ ] **Step 3: Verify the focused contract is GREEN**

Run:

```bash
npx vitest run tests/agentera-icon-assets.test.ts tests/agentera-composed-surfaces.test.ts
```

Expected: both files pass with zero failures.

- [ ] **Step 4: Verify package icons were not changed**

Run:

```bash
git diff --exit-code HEAD -- assets/agentera-icon.png build/icon.icns build/icon.ico build/icon.png resources/icon.png
```

Expected: no output and exit code 0.

- [ ] **Step 5: Run complete code verification**

Run:

```bash
npm run typecheck
npm test -- --maxWorkers=1
npm run build
npx --yes lat.md check
git diff --check
```

Expected: type checking, all Vitest files, production code build, LAT, and whitespace checks exit 0.

- [ ] **Step 6: Commit the implementation**

```bash
git add src/renderer/src/assets/iconv2.png src/renderer/src/assets/main.css
git commit -m "fix: make AgentEra in-app mark theme adaptive"
```

- [ ] **Step 7: Restart and visually verify both themes**

Keep using the existing isolated launch state and Runtime-download bypass:

```bash
HERMES_HOME=/Users/zizimutou/Desktop/aera/.hermes-dev-bypass \
HERMES_DESKTOP_USER_DATA_DIR=/Users/zizimutou/Desktop/aera/.agentera-studio-brand-check \
npm run dev
```

Using Computer Use, verify the central empty-state mark has no opaque black circle or white tile in both Light and Dark themes, the mark remains crisp and centered, and the desktop stays running for user review.
