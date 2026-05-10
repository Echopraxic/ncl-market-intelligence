// Ambient declarations for optional stealth browsing packages.
// playwright-extra wraps playwright launchers with a plugin system;
// puppeteer-extra-plugin-stealth provides bot-evasion heuristics.
// These declarations let TypeScript compile when the packages are not installed.

declare module 'playwright-extra' {
  import type { BrowserType, Browser, BrowserContext, Page } from 'playwright';

  interface PlaywrightExtraBrowserType extends BrowserType {
    use(plugin: unknown): void;
  }

  export const chromium: PlaywrightExtraBrowserType;
  export const firefox: PlaywrightExtraBrowserType;
  export const webkit: PlaywrightExtraBrowserType;
  export type { Browser, BrowserContext, Page };
}

declare module 'puppeteer-extra-plugin-stealth' {
  function StealthPlugin(): unknown;
  export default StealthPlugin;
}
