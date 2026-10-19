// Reload only this checkout's unpacked extension in an existing Chromium session.
import { readFile, realpath } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(path.join(root, 'extension/package.json'));
const { chromium } = require('playwright');

export async function reloadExtension(context, extensionPath, { refreshTabs = true } = {}) {
  const expectedPath = await realpath(extensionPath);
  const manifest = JSON.parse(await readFile(path.join(expectedPath, 'manifest.json'), 'utf8'));
  const manager = await context.newPage();
  try {
    await manager.goto('chrome://extensions/');
    const extensions = await manager.evaluate(() => new Promise((resolve, reject) => {
      chrome.developerPrivate.getExtensionsInfo({ includeDisabled: true, includeTerminated: true }, entries => {
        if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
        else resolve(entries.map(({ id, name, path, state }) => ({ id, name, path, state })));
      });
    }));
    const matches = [];
    for (const entry of extensions.filter(entry => entry.name === manifest.name && entry.path)) {
      const expanded = entry.path.replace(/^~(?=\/)/, homedir());
      if (await realpath(expanded).catch(() => null) === expectedPath) matches.push(entry);
    }
    if (matches.length !== 1) {
      const installed = extensions.filter(entry => entry.name === manifest.name).map(entry => entry.path).join(', ');
      throw new Error(`Load ${expectedPath} as an unpacked extension in Chromium first.${installed ? ` Currently loaded from: ${installed}.` : ''}`);
    }
    const extension = matches[0];
    if (extension.state !== 'ENABLED') throw new Error('Enable Jev in chrome://extensions before reloading it.');
    const restarted = context.waitForEvent('serviceworker', {
      predicate: worker => new URL(worker.url()).hostname === extension.id,
      timeout: 15000,
    });
    // Observe rejection immediately even if the reload callback fails first.
    void restarted.catch(() => {});
    await manager.evaluate(id => new Promise((resolve, reject) => {
      chrome.developerPrivate.reload(id, { failQuietly: true }, () => {
        if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
        else resolve();
      });
    }), extension.id);
    await restarted;
    if (refreshTabs) {
      for (const page of context.pages()) {
        const url = new URL(page.url());
        if (url.protocol === 'https:' && ['www.youtube.com', 'm.youtube.com'].includes(url.hostname)
          && url.pathname === '/watch') await page.reload({ waitUntil: 'domcontentloaded' });
      }
    }
    console.log(`Reloaded ${manifest.name} (${extension.id})${refreshTabs ? ' and refreshed YouTube watch tabs' : ''}.`);
    return extension.id;
  } finally {
    await manager.close();
  }
}

async function main() {
  let endpoint = process.env.CHROMIUM_CDP_URL;
  if (!endpoint) {
    const profile = process.env.CHROMIUM_USER_DATA_DIR || path.join(homedir(), '.config/chromium');
    const [port, socket] = (await readFile(path.join(profile, 'DevToolsActivePort'), 'utf8')).trim().split('\n');
    endpoint = `ws://127.0.0.1:${port}${socket}`;
  }
  console.log('Connecting to Chromium. Allow its remote-debugging prompt if shown.');
  const browser = await chromium.connectOverCDP(endpoint, { timeout: 120000 });
  try {
    const context = browser.contexts()[0];
    const extensionPath = path.join(root, 'extension/dist');
    await reloadExtension(context, extensionPath);
    if (process.argv.includes('--watch')) {
      const marker = path.join(extensionPath, '.build-ready');
      let lastBuild = await readFile(marker, 'utf8').catch(() => '');
      let reloading = false;
      console.log('Watching for completed builds. This debugging connection stays open; press Ctrl+C to stop.');
      const timer = setInterval(async () => {
        if (reloading) return;
        reloading = true;
        try {
          const build = await readFile(marker, 'utf8').catch(() => '');
          if (build && build !== lastBuild) {
            lastBuild = build;
            await reloadExtension(context, extensionPath);
          }
        } catch (error) { console.error(`Reload failed: ${error.message}`); }
        finally { reloading = false; }
      }, 1000);
      await new Promise(resolve => {
        process.once('SIGINT', resolve);
        process.once('SIGTERM', resolve);
        browser.once('disconnected', resolve);
      });
      clearInterval(timer);
    }
  } finally {
    // Disconnect this client; leave the user's Chromium running.
    await browser.close();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
