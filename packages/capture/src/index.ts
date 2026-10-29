import { chromium } from 'playwright';
import type { Page, Browser } from 'playwright';
import type { PageFacts, UrlCaptureRequest } from '@design-index/shared';
import { createNetworkPolicy, CapturePolicyError } from './policy.js';
import { startCaptureProxy } from './proxy.js';
export { createNetworkPolicy, CapturePolicyError, isPublicAddress, normalizeLocalOrigin, parseCaptureUrl } from './policy.js';
export { startCaptureProxy } from './proxy.js';

export interface CapturedPage { title: string; finalUrl: string; fullPage: Buffer; viewport: Buffer; mobile: Buffer; facts: PageFacts }
export interface PageCapturer { capture(request: UrlCaptureRequest, approvedLocalOrigins: readonly string[], protectedPorts: readonly number[], signal: AbortSignal): Promise<CapturedPage> }

export function browserEnvironment(environment: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const allowed = ['PATH', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP', 'LOCALAPPDATA', 'APPDATA', 'USERPROFILE', 'HOME', 'DISPLAY', 'XAUTHORITY', 'LANG', 'PROGRAMFILES', 'PROGRAMFILES(X86)', 'PROGRAMDATA'];
  return Object.fromEntries(Object.entries(environment).filter((entry): entry is [string, string] => allowed.includes(entry[0].toUpperCase()) && typeof entry[1] === 'string'));
}

async function extractFacts(page: Page): Promise<PageFacts> {
  return page.evaluate(() => {
    const fonts = new Set<string>();
    const colors = new Map<string, number>();
    const animations = new Map<string, { name: string; duration: string; easing: string }>();
    const transitions = new Map<string, { property: string; duration: string; easing: string }>();
    const styles: PageFacts['styles'] = [];
    const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    const elements: Element[] = [];
    const walker = document.createTreeWalker(document.body ?? document.documentElement, NodeFilter.SHOW_ELEMENT);
    let element: Node | null = walker.currentNode;
    while (element && elements.length < 400) { elements.push(element as Element); element = walker.nextNode(); }
    for (const element of elements) {
      const rect = element.getBoundingClientRect();
      const css = getComputedStyle(element);
      if (rect.width <= 0 || rect.height <= 0 || css.display === 'none' || css.visibility === 'hidden' || Number(css.opacity) < 0.1) continue;
      if (fonts.size < 24) fonts.add(css.fontFamily.slice(0, 160));
      for (const value of [css.backgroundColor, css.color, css.borderTopColor]) {
        if (!context) break;
        context.clearRect(0, 0, 1, 1); context.fillStyle = value; context.fillRect(0, 0, 1, 1);
        const [r, g, b, a] = context.getImageData(0, 0, 1, 1).data;
        if (a! < 250) continue;
        const hex = `#${[r!, g!, b!].map((channel) => channel.toString(16).padStart(2, '0')).join('').toUpperCase()}`;
        colors.set(hex, (colors.get(hex) ?? 0) + Math.min(rect.width * rect.height, 1_000_000));
      }
      if (styles.length < 24) styles.push({ tag: element.tagName.toLowerCase(), fontFamily: css.fontFamily.slice(0, 160), fontSize: css.fontSize, fontWeight: css.fontWeight, lineHeight: css.lineHeight, padding: css.padding, gap: css.gap, borderRadius: css.borderRadius, boxShadow: css.boxShadow.slice(0, 160) });
      if (animations.size < 20 && css.animationName !== 'none') animations.set(`${css.animationName}|${css.animationDuration}`, { name: css.animationName.slice(0, 80), duration: css.animationDuration.slice(0, 80), easing: css.animationTimingFunction.slice(0, 120) });
      if (transitions.size < 20 && css.transitionDuration.split(',').some((duration) => Number.parseFloat(duration) > 0)) transitions.set(`${css.transitionProperty}|${css.transitionDuration}`, { property: css.transitionProperty.slice(0, 80), duration: css.transitionDuration.slice(0, 80), easing: css.transitionTimingFunction.slice(0, 120) });
    }
    const selected = [...colors.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
    const total = selected.reduce((sum, [, weight]) => sum + weight, 0) || 1;
    const scripts = Array.from({ length: Math.min(document.scripts.length, 100) }, (_, index) => document.scripts[index]!.src.toLowerCase().slice(0, 2048)).join(' ');
    const libraries = ['gsap', 'framer-motion', 'lenis', 'lottie'].filter((name) => scripts.includes(name));
    return { fonts: [...fonts], colors: selected.map(([hex, weight]) => ({ hex, weight: weight / total })), styles, animations: [...animations.values()], transitions: [...transitions.values()], libraries, warnings: [], truncated: document.documentElement.scrollHeight > 10_000 };
  });
}

export function createBrowserCapturer(): PageCapturer {
  return {
    async capture(request, approvedLocalOrigins, protectedPorts, outerSignal) {
      const signal = AbortSignal.any([outerSignal, AbortSignal.timeout(45_000)]);
      const policy = createNetworkPolicy(request.url, approvedLocalOrigins, protectedPorts);
      await policy.resolve(request.url, signal);
      const proxy = await startCaptureProxy(policy, signal);
      let browser: Browser | undefined;
      const abort = () => { void browser?.close().catch(() => {}); };
      signal.addEventListener('abort', abort, { once: true });
      try {
        browser = await chromium.launch({ channel: 'chrome', headless: true, chromiumSandbox: true, timeout: 15_000,
          env: browserEnvironment(), proxy: { server: proxy.server, username: proxy.username, password: proxy.password, bypass: '<-loopback>' },
          args: ['--disable-quic', '--force-webrtc-ip-handling-policy=disable_non_proxied_udp', '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1'],
        });
        if (signal.aborted) throw new CapturePolicyError('Capture was stopped.');
        const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1, serviceWorkers: 'block', acceptDownloads: false, colorScheme: request.colorScheme, permissions: [] });
        await context.route('**/*', async (route) => {
          try {
            if (!['GET', 'HEAD'].includes(route.request().method())) throw new Error('Read-only capture.');
            const value = route.request().url();
            if (!value.startsWith('data:') && !value.startsWith('blob:') && value !== 'about:blank') policy.check(value);
            await route.continue();
          } catch { await route.abort().catch(() => {}); }
        });
        await context.routeWebSocket('**/*', (socket) => socket.close());
        const page = await context.newPage();
        page.on('popup', (popup) => { void popup.close(); });
        page.on('download', (download) => { void download.cancel(); });
        const desktop = await page.goto(request.url, { waitUntil: 'domcontentloaded', timeout: 20_000 });
        if (!desktop || desktop.status() >= 400) throw new CapturePolicyError('The page returned an HTTP error or did not load.');
        await page.waitForTimeout(500);
        const facts = await extractFacts(page);
        let trimmed = false;
        while (JSON.stringify(facts).length > 18_000) {
          trimmed = true;
          if (facts.styles.length) facts.styles.pop();
          else if (facts.transitions.length) facts.transitions.pop();
          else if (facts.animations.length) facts.animations.pop();
          else break;
        }
        if (trimmed) facts.warnings.push('Captured style facts were bounded to fit the analysis input.');
        const title = (await page.title()).slice(0, 160);
        const finalUrl = page.url(); policy.check(finalUrl);
        await page.evaluate(() => document.getAnimations().forEach((animation) => animation.pause()));
        const viewport = await page.screenshot({ type: 'png', timeout: 10_000 });
        const height = await page.evaluate(() => Math.min(10_000, Math.max(1000, document.documentElement.scrollHeight)));
        const cdp = await context.newCDPSession(page);
        const shot = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, clip: { x: 0, y: 0, width: 1440, height, scale: 1 } });
        const fullPage = Buffer.from(shot.data, 'base64');
        const mobileContext = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, isMobile: true, hasTouch: true, serviceWorkers: 'block', acceptDownloads: false, colorScheme: request.colorScheme, permissions: [] });
        await mobileContext.route('**/*', async (route) => { try { if (!['GET', 'HEAD'].includes(route.request().method())) throw new Error(); policy.check(route.request().url()); await route.continue(); } catch { await route.abort().catch(() => {}); } });
        await mobileContext.routeWebSocket('**/*', (socket) => socket.close());
        const mobilePage = await mobileContext.newPage();
        mobilePage.on('popup', (popup) => { void popup.close(); });
        mobilePage.on('download', (download) => { void download.cancel(); });
        const mobileResponse = await mobilePage.goto(request.url, { waitUntil: 'domcontentloaded', timeout: 15_000 });
        if (!mobileResponse || mobileResponse.status() >= 400) throw new CapturePolicyError('The mobile view did not load.');
        await mobilePage.waitForTimeout(300);
        await mobilePage.evaluate(() => document.getAnimations().forEach((animation) => animation.pause()));
        const mobile = await mobilePage.screenshot({ type: 'png', timeout: 10_000 });
        if (fullPage.length + viewport.length + mobile.length > 30 * 1024 * 1024) throw new CapturePolicyError('Capture images exceeded the 30 MB limit.');
        if (facts.truncated) facts.warnings.push('Full-page capture was limited to 10,000 pixels in height.');
        if (proxy.stats().blocked) facts.warnings.push(`${proxy.stats().blocked} network requests were blocked by capture policy.`);
        facts.warnings.push('CSS motion is configured evidence, not proof of scroll/interaction triggers. Animations were paused for screenshots.');
        return { title, finalUrl, fullPage, viewport, mobile, facts };
      } catch (error) {
        if (error instanceof CapturePolicyError) throw error;
        throw new CapturePolicyError(signal.aborted ? 'Capture was interrupted or exceeded 45 seconds.' : 'Capture failed. Check Chrome installation, page accessibility, and capture network permissions.');
      } finally {
        signal.removeEventListener('abort', abort);
        await browser?.close().catch(() => {});
        await proxy.close();
      }
    },
  };
}
