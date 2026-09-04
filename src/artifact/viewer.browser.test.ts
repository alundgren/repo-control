import fastify, { type FastifyInstance } from "fastify";
import { createRequire } from "node:module";
import type { QRCode } from "jsqr";
import { PNG } from "pngjs";
import { expect, test } from "@playwright/test";

import { artifactPlugin, type ArtifactService } from "./index.js";
import type { ArtifactAppearance, ArtifactType, StoredArtifact } from "./store.js";

const require = createRequire(import.meta.url);
const jsQR = require("jsqr") as (data: Uint8ClampedArray, width: number, height: number) => QRCode | null;

const fixtureIds = {
  interaction: "a".repeat(32),
  security: "b".repeat(32),
  delayed: "c".repeat(32),
  nearlyWhite: "d".repeat(32),
  nearlyBlack: "e".repeat(32),
  mixed: "f".repeat(32),
  moving: "g".repeat(32),
  bottomRight: "h".repeat(32),
  viewportHeight: "i".repeat(32),
  fixed: "j".repeat(32),
  scrolling: "k".repeat(32),
  narrow: "l".repeat(32),
  presentation: "m".repeat(32),
  lightNeutral: "n".repeat(32),
  lightHint: "o".repeat(32),
  darkNeutral: "p".repeat(32),
  darkHint: "q".repeat(32),
  misleadingDark: "r".repeat(32),
} as const;

let app: FastifyInstance;
let origin: string;

test.beforeAll(async () => {
  const artifacts = new Map<string, StoredArtifact>([
    [fixtureIds.interaction, storedArtifact(fixtureIds.interaction, basicFixture("interaction café 雪"))],
    [fixtureIds.security, storedArtifact(fixtureIds.security, securityFixture())],
    [fixtureIds.delayed, storedArtifact(fixtureIds.delayed, delayedFixture())],
    [fixtureIds.nearlyWhite, storedArtifact(fixtureIds.nearlyWhite, visualFixture("nearly-white", "#fefdfb"))],
    [fixtureIds.nearlyBlack, storedArtifact(fixtureIds.nearlyBlack, visualFixture("nearly-black", "#090807"))],
    [fixtureIds.mixed, storedArtifact(fixtureIds.mixed, visualFixture("mixed", "linear-gradient(90deg,#fff 50%,#080808 50%)"))],
    [fixtureIds.moving, storedArtifact(fixtureIds.moving, movingFixture())],
    [fixtureIds.bottomRight, storedArtifact(fixtureIds.bottomRight, bottomRightFixture())],
    [fixtureIds.viewportHeight, storedArtifact(fixtureIds.viewportHeight, viewportHeightFixture())],
    [fixtureIds.fixed, storedArtifact(fixtureIds.fixed, fixedFixture())],
    [fixtureIds.scrolling, storedArtifact(fixtureIds.scrolling, scrollingFixture())],
    [fixtureIds.narrow, storedArtifact(fixtureIds.narrow, visualFixture("narrow", "#d8c6aa"))],
    [fixtureIds.presentation, storedArtifact(fixtureIds.presentation, presentationFixture(), "presentation")],
    [fixtureIds.lightNeutral, storedArtifact(fixtureIds.lightNeutral, visualFixture("light-neutral", "#F2EADE"))],
    [fixtureIds.lightHint, storedArtifact(fixtureIds.lightHint, visualFixture("light-hint", "#F2EADE"), "archify", "light")],
    [fixtureIds.darkNeutral, storedArtifact(fixtureIds.darkNeutral, visualFixture("dark-neutral", "#292019"))],
    [fixtureIds.darkHint, storedArtifact(fixtureIds.darkHint, visualFixture("dark-hint", "#292019"), "archify", "dark")],
    [fixtureIds.misleadingDark, storedArtifact(fixtureIds.misleadingDark, misleadingDarkFixture(), "archify", "dark")],
  ]);
  const service: ArtifactService = {
    publish() {
      throw new Error("browser fixtures do not publish");
    },
    find(id) {
      return artifacts.get(id) ?? null;
    },
    start() {},
    stop() {},
  };
  app = fastify();
  await app.register(artifactPlugin, { service });
  origin = await app.listen({ host: "127.0.0.1", port: 0 });
});

test.afterAll(async () => {
  await app.close();
});

test("opens, pins, and closes Share without exposing hidden controls", async ({ page }) => {
  await page.goto(viewUrl(fixtureIds.interaction));
  const tab = page.locator("[data-share-tab]");
  const panel = page.locator("[data-share-panel]");

  await expect(panel).toBeHidden();
  expect(await page.locator("body").ariaSnapshot()).not.toContain("Copy link");
  const closedBox = await tab.boundingBox();
  expect(closedBox).not.toBeNull();
  expect(closedBox).toEqual({ x: 1208, y: 686, width: 72, height: 28 });

  await tab.hover();
  await expect(panel).toBeVisible();
  const openBox = await panel.boundingBox();
  expect(openBox).not.toBeNull();
  expect(openBox!.y + openBox!.height).toBeLessThan(closedBox!.y);
  await page.mouse.move(20, 200);
  await expect(panel).toBeHidden();

  await tab.focus();
  await expect(panel).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(panel).toBeHidden();
  await expect(tab).toBeFocused();

  await tab.evaluate((element: HTMLButtonElement) => element.blur());
  await tab.focus();
  await page.locator("[data-copy-link]").focus();
  await page.locator("[data-share-dismiss]").click({ position: { x: 10, y: 200 } });
  await expect(panel).toBeHidden();
  await expect(tab).toBeFocused();

  await tab.click();
  await page.mouse.move(20, 200);
  await expect(panel).toBeVisible();
  const dismiss = page.locator("[data-share-dismiss]");
  expect(await dismiss.evaluate((element: HTMLElement) => ({ ariaHidden: element.getAttribute("aria-hidden"), tabIndex: element.tabIndex }))).toEqual({ ariaHidden: "true", tabIndex: -1 });
  await page.locator("[data-copy-link]").focus();
  await dismiss.click({ position: { x: 10, y: 200 } });
  await expect(panel).toBeHidden();
  await expect(tab).toBeFocused();

  await tab.click();
  await page.locator("[data-share-close]").click();
  await expect(panel).toBeHidden();
  await expect(tab).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(page.locator("[data-share-close]")).not.toBeFocused();
  await expect(page.locator("[data-copy-link]")).not.toBeFocused();
});

test("reconstructs the stored UTF-8 bytes in the browser", async ({ page }) => {
  await page.addInitScript(() => {
    const createObjectUrl = URL.createObjectURL.bind(URL);
    URL.createObjectURL = (blob: Blob) => {
      void blob.arrayBuffer().then((buffer) => {
        (globalThis as typeof globalThis & { reconstructedBytes?: number[] }).reconstructedBytes = [...new Uint8Array(buffer)];
      });
      return createObjectUrl(blob);
    };
  });
  await page.goto(viewUrl(fixtureIds.interaction));
  const expected = [...Buffer.from(basicFixture("interaction café 雪"))];
  await expect.poll(() => page.evaluate(() => (globalThis as typeof globalThis & { reconstructedBytes?: number[] }).reconstructedBytes)).toEqual(expected);
});

test("a tap pins Share open", async ({ browser }) => {
  const context = await browser.newContext({ hasTouch: true, viewport: { width: 390, height: 700 } });
  const page = await context.newPage();
  await page.goto(viewUrl(fixtureIds.interaction));
  await page.locator("[data-share-tab]").tap();
  await expect(page.locator("[data-share-panel]")).toBeVisible();
  await page.touchscreen.tap(12, 180);
  await expect(page.locator("[data-share-panel]")).toBeHidden();
  await context.close();
});

test("copies the canonical link and provides a selected fallback", async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: async (value: string) => { (globalThis as typeof globalThis & { copied?: string }).copied = value; } },
    });
  });
  const canonicalUrl = viewUrl(fixtureIds.interaction);
  await page.goto(canonicalUrl);
  await page.locator("[data-share-tab]").click();
  await page.locator("[data-copy-link]").click();
  await expect(page.locator("[data-share-status]")).toHaveText("Link copied.");
  expect(await page.evaluate(() => (globalThis as typeof globalThis & { copied?: string }).copied)).toBe(canonicalUrl);

  await page.evaluate(() => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: async () => { throw new Error("denied"); } },
    });
  });
  await page.locator("[data-copy-link]").click();
  const fallback = page.locator("[data-share-fallback]");
  await expect(page.locator("[data-share-status]")).toHaveText("Copy unavailable. Select the link below.");
  await expect(fallback).toBeVisible();
  await expect(fallback).toHaveValue(canonicalUrl);
  expect(await fallback.evaluate((element: HTMLInputElement) => element.selectionStart === 0 && element.selectionEnd === element.value.length)).toBe(true);
});

test("renders a decodable QR at 128 CSS pixels and downloads from the existing route", async ({ page }) => {
  const canonicalUrl = viewUrl(fixtureIds.interaction);
  await page.goto(canonicalUrl);
  await page.locator("[data-share-tab]").click();
  const qr = page.locator("[data-share-qr]");
  await expect(qr).toHaveCSS("width", "128px");
  await expect(qr).toHaveCSS("height", "128px");
  const image = PNG.sync.read(await qr.screenshot());
  const decoded = jsQR(new Uint8ClampedArray(image.data), image.width, image.height);
  expect(decoded?.data).toBe(canonicalUrl);

  const downloadPromise = page.waitForEvent("download");
  await page.locator("[data-download-link]").click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe(`artifact-${fixtureIds.interaction}.html`);
});

test("keeps the artifact isolated while allowing self-contained browser behavior", async ({ page }) => {
  const attemptedRequests: string[] = [];
  page.on("request", (request) => {
    if (request.url().includes("blocked.example.test")) attemptedRequests.push(request.url());
  });
  const viewerUrl = viewUrl(fixtureIds.security);
  await page.goto(viewerUrl);
  const artifact = page.frameLocator("[data-artifact-frame]");
  await expect(artifact.locator("body")).toHaveAttribute("data-inline-script", "ran");
  await expect(artifact.locator("body")).toHaveAttribute("data-fetch", "blocked");
  await expect(artifact.locator("body")).toHaveAttribute("data-top-navigation", "blocked");
  await expect(artifact.locator("body")).toHaveAttribute("data-popup", "blocked");
  await expect(artifact.locator("body")).toHaveAttribute("data-parent-access", "blocked");
  await expect(artifact.locator("body")).toHaveAttribute("data-form-attempted", "true");
  await expect(artifact.locator("body")).toHaveAttribute("data-worker", "allowed");
  await expect(artifact.locator("[data-inline-style]")).toHaveCSS("color", "rgb(18, 52, 86)");
  await expect(artifact.locator("[data-data-image]")).toHaveJSProperty("complete", true);
  await expect(artifact.locator("[data-blob-image]")).toHaveJSProperty("naturalWidth", 1);
  expect(await artifact.locator("[data-media]").evaluate((element: HTMLAudioElement) => element.currentSrc.startsWith("data:audio/wav"))).toBe(true);
  expect(await page.locator("[data-artifact-frame]").evaluate((element: HTMLIFrameElement) => [...element.sandbox].sort())).toEqual(["allow-downloads", "allow-scripts"]);
  await expect(artifact.frameLocator("[data-blob-frame]").locator("body")).toHaveAttribute("data-script", "ran");
  await expect(artifact.frameLocator("[data-blob-frame]").locator("body")).toHaveAttribute("data-fetch", "blocked");
  await expect(artifact.frameLocator("[data-blob-frame]").locator("body")).toHaveAttribute("data-top-navigation", "blocked");
  expect(page.url()).toBe(viewerUrl);
  expect(attemptedRequests).toEqual([]);

  const frames = page.frames().filter((frame) => frame.url().startsWith("blob:"));
  expect(frames.length).toBeGreaterThanOrEqual(2);
  for (const frame of frames) {
    expect(await frame.evaluate(() => {
      try {
        localStorage.setItem("sandbox-check", "failed");
        return false;
      } catch {
        return true;
      }
    })).toBe(true);
  }
});

test("keeps the object URL alive for delayed artifact behavior", async ({ page }) => {
  await page.goto(viewUrl(fixtureIds.delayed));
  await expect(page.frameLocator("[data-artifact-frame]").locator("body")).toHaveAttribute("data-delayed", "complete");
});

test("fills changing viewports without viewer scrollbars or artifact layout changes", async ({ page }) => {
  for (const id of Object.values(fixtureIds).slice(3)) {
    await page.goto(viewUrl(id));
    expect(await viewerMeasurements(page)).toEqual({
      frame: { x: 0, y: 0, width: 1280, height: 720 },
      scrollWidth: 1280,
      scrollHeight: 720,
    });
  }

  await page.setViewportSize({ width: 360, height: 640 });
  await page.goto(viewUrl(fixtureIds.narrow));
  expect(await viewerMeasurements(page)).toEqual({
    frame: { x: 0, y: 0, width: 360, height: 640 },
    scrollWidth: 360,
    scrollHeight: 640,
  });
  await page.locator("[data-share-tab]").click();
  expect((await page.locator("[data-share-panel]").boundingBox())!.width).toBeLessThanOrEqual(344);

  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto(viewUrl(fixtureIds.bottomRight));
  const before = await viewerMeasurements(page);
  await page.locator("[data-share-tab]").click();
  await expect(page.locator("[data-share-panel]")).toBeVisible();
  await page.locator("[data-share-close]").click();
  expect(await viewerMeasurements(page)).toEqual(before);
  await expect(page.frameLocator("[data-artifact-frame]").locator("[data-important-corner]")).toHaveText("Important");
});

test("uses no motion when reduced motion is requested", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto(viewUrl(fixtureIds.interaction));
  await page.locator("[data-share-tab]").click();
  expect(await page.locator("[data-share-panel]").evaluate((element) => {
    const style = getComputedStyle(element);
    return { animation: style.animationDuration, transition: style.transitionDuration };
  })).toEqual({ animation: "0s", transition: "0s" });
});

test("uses the low-contrast Share tab treatment for each appearance hint", async ({ page }) => {
  const neutralLight = await shareTabColors(page, fixtureIds.lightNeutral);
  const hintedLight = await shareTabColors(page, fixtureIds.lightHint);
  const neutralDark = await shareTabColors(page, fixtureIds.darkNeutral);
  const hintedDark = await shareTabColors(page, fixtureIds.darkHint);

  expect(neutralLight).toMatchObject({
    fill: "rgba(0, 0, 0, 0)",
    text: "rgba(96, 73, 57, 0.58)",
    innerBoundary: "rgba(96, 73, 57, 0.28)",
    outerBoundary: "none",
  });
  expect(hintedLight).toEqual(neutralLight);
  expect(neutralDark).toEqual(neutralLight);
  expect(hintedDark).toMatchObject({
    fill: "rgba(0, 0, 0, 0)",
    text: "rgba(193, 175, 154, 0.58)",
    innerBoundary: "rgba(249, 246, 240, 0.28)",
    outerBoundary: "none",
  });

  for (const id of [fixtureIds.lightNeutral, fixtureIds.lightHint, fixtureIds.darkNeutral, fixtureIds.darkHint]) {
    await page.goto(viewUrl(id));
    await expect(page).toHaveScreenshot(`share-tab-${id[0]}.png`, { clip: { x: 1158, y: 666, width: 122, height: 54 } });
  }
});

test("keeps the dark-hint treatment when nearby artifact content is light", async ({ page }) => {
  await page.goto(viewUrl(fixtureIds.misleadingDark));
  const treatment = await shareTabColors(page, fixtureIds.misleadingDark);
  expect(treatment).toMatchObject({
    fill: "rgba(0, 0, 0, 0)",
    text: "rgba(193, 175, 154, 0.58)",
    innerBoundary: "rgba(249, 246, 240, 0.28)",
    outerBoundary: "none",
  });
  await expect(page).toHaveScreenshot("share-tab-dark-over-light-block.png", {
    clip: { x: 1158, y: 666, width: 122, height: 54 },
  });
});

async function viewerMeasurements(page: import("@playwright/test").Page) {
  return page.evaluate(() => {
    const frame = document.querySelector("[data-artifact-frame]")!.getBoundingClientRect();
    return {
      frame: { x: frame.x, y: frame.y, width: frame.width, height: frame.height },
      scrollWidth: document.documentElement.scrollWidth,
      scrollHeight: document.documentElement.scrollHeight,
    };
  });
}

function viewUrl(id: string) {
  return `${origin}/public/${id}/view`;
}

function storedArtifact(
  id: string,
  content: string,
  type: ArtifactType = "archify",
  appearance: ArtifactAppearance | null = null,
): StoredArtifact {
  return {
    id,
    type,
    content: Buffer.from(content),
    appearance,
    createdAt: "2026-09-01T00:00:00.000Z",
    deleteAfter: "2026-10-01T00:00:00.000Z",
  };
}

function documentFixture(body: string, styles = "") {
  return `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0}${styles}</style></head><body>${body}</body></html>`;
}

function basicFixture(name: string) {
  return documentFixture(`<main data-fixture="${name}">${name}</main>`);
}

function visualFixture(name: string, background: string) {
  return documentFixture(`<main data-fixture="${name}">${name}</main>`, `body{min-height:100vh;background:${background}}`);
}

function misleadingDarkFixture() {
  return documentFixture(
    '<main data-fixture="misleading-dark"><div></div></main>',
    "body{min-height:100vh;background:#292019}div{position:fixed;right:0;bottom:0;width:128px;height:64px;background:#F2EADE}",
  );
}

async function shareTabColors(page: import("@playwright/test").Page, id: string) {
  await page.goto(viewUrl(id));
  return page.locator("[data-share-tab]").evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      fill: style.backgroundColor,
      text: style.color,
      innerBoundary: style.borderTopColor,
      outerBoundary: style.boxShadow,
    };
  });
}

function movingFixture() {
  return documentFixture('<div data-fixture="moving"></div>', 'div{position:fixed;width:40px;height:40px;background:#765;animation:move 1s infinite alternate}@keyframes move{to{transform:translate(200px,100px)}}');
}

function bottomRightFixture() {
  return documentFixture('<strong data-important-corner>Important</strong>', 'strong{position:fixed;right:0;bottom:0;padding:20px;background:#913;color:white}');
}

function viewportHeightFixture() {
  return documentFixture('<main data-fixture="viewport-height">100vh</main>', 'main{height:100vh;background:#bdc}');
}

function fixedFixture() {
  return documentFixture('<main data-fixture="fixed">Fixed</main>', 'main{position:fixed;inset:12px;background:#cdb}');
}

function scrollingFixture() {
  return documentFixture('<main data-fixture="scrolling">Scroll</main>', 'body{height:240vh;background:linear-gradient(#cab,#abc)}');
}

function presentationFixture() {
  return documentFixture('<section data-fixture="presentation">Slide</section>', 'section{position:fixed;inset:0;display:grid;place-items:center;font-size:8vw;background:#223;color:#eed}');
}

function delayedFixture() {
  return documentFixture('<script>setTimeout(() => document.body.dataset.delayed = "complete", 250)</script>');
}

function securityFixture() {
  return documentFixture(`
    <div data-inline-style>Styled</div>
    <img data-data-image alt="" src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==">
    <img data-blob-image alt="">
    <audio data-media src="data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA="></audio>
    <iframe data-blob-frame></iframe>
    <iframe src="https://blocked.example.test/frame"></iframe>
    <object data="https://blocked.example.test/object"></object>
    <form action="https://blocked.example.test/form" method="post"><button>Submit</button></form>
    <script>
      document.body.dataset.inlineScript = 'ran';
      fetch('https://blocked.example.test/fetch').catch(() => document.body.dataset.fetch = 'blocked');
      try { top.location.href = 'https://blocked.example.test/top'; } catch { document.body.dataset.topNavigation = 'blocked'; }
      try { parent.document.body.dataset.compromised = 'true'; } catch { document.body.dataset.parentAccess = 'blocked'; }
      const popup = open('https://blocked.example.test/popup');
      document.body.dataset.popup = popup === null ? 'blocked' : 'unexpected';
      document.querySelector('form').requestSubmit();
      document.body.dataset.formAttempted = 'true';
      document.querySelector('[data-blob-image]').src = URL.createObjectURL(new Blob(['<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>'], { type: 'image/svg+xml' }));
      const workerUrl = URL.createObjectURL(new Blob(["postMessage('allowed')"], { type: 'text/javascript' }));
      const worker = new Worker(workerUrl);
      worker.onmessage = event => document.body.dataset.worker = event.data;
      const nested = document.querySelector('[data-blob-frame]');
      const nestedSource = '<!doctype html><body><scr' + 'ipt>document.body.dataset.script="ran";fetch("https://blocked.example.test/nested-fetch").catch(()=>document.body.dataset.fetch="blocked");try{top.location.href="https://blocked.example.test/nested-top"}catch{document.body.dataset.topNavigation="blocked"}</scr' + 'ipt>';
      nested.src = URL.createObjectURL(new Blob([nestedSource], { type: 'text/html' }));
    </script>
  `, '[data-inline-style]{color:#123456}');
}
