import { inspectorScript } from '../../src/apps/inspector.js';
import { previewShell } from '../../src/apps/preview-shell.js';
import { test, expect } from './fixtures.js';

// An agent turn must never move the app under the person looking at it: the new
// version waits, and taking it keeps the page and the scroll position.
test('a new version waits to be taken, and restores where the reader was', async ({ page, context, webApp }, info) => {
  const origin = webApp.origin;
  let revision = 1;
  let waiters: (() => void)[] = [];
  const held = () => new Promise<void>(resolve => { waiters.push(resolve); });
  const turn = () => { revision++; waiters.splice(0).forEach(resolve => resolve()); };
  await page.route(`${origin}/__bivy/tokens.css`, route => route.fulfill({ path: 'packages/ui/tokens.css', contentType: 'text/css' }));
  await page.route(`${origin}/__bivy/styles.css`, route => route.fulfill({ path: 'packages/web/src/styles.css', contentType: 'text/css' }));
  await page.route(`${origin}/shell`, route => route.fulfill({ contentType: 'text/html', body: previewShell('test') }));
  await page.route('http://preview.test/**', async route => {
    const url = route.request().url();
    if (url.includes('/__bivy/revision')) {
      // Emulate the gateway's long poll, or the shell would spin.
      if (Number(new URL(url).searchParams.get('after')) === revision) await held();
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ revision, path: '/' }),
        headers: { 'access-control-allow-origin': origin, 'access-control-allow-credentials': 'true' } });
    }
    if (url.includes('/__bivy/')) return route.fulfill({ status: 503 });
    return route.fulfill({ contentType: 'text/html', body: `<style>body{height:3000px;margin:0}</style><h1>Version ${revision}</h1><script>${inspectorScript(origin)}</script>` });
  });
  await context.addInitScript(({ origin }) => sessionStorage.setItem('bivy-preview', JSON.stringify({ name: 'Website preview', origin: 'http://preview.test', returnTo: origin + '/chat' })), { origin });
  await page.goto(`${origin}/shell`);
  const app = () => page.frames().find(frame => frame.url() === 'http://preview.test/')!;
  await expect(page.frameLocator('#app').getByRole('heading')).toHaveText('Version 1');
  await expect(page.locator('#update')).toBeHidden();

  await app().evaluate(() => scrollTo({ top: 500, behavior: 'instant' }));
  turn();
  await expect(page.locator('#update')).toBeVisible();
  await expect(page.locator('#stamp')).toHaveText('New version ready');
  // The whole point: still the old version, still where they were.
  await expect(page.frameLocator('#app').getByRole('heading')).toHaveText('Version 1');
  expect(await app().evaluate(() => scrollY)).toBe(500);
  await page.screenshot({ path: info.outputPath('waiting.png') });

  await page.getByRole('button', { name: 'Show new version' }).click();
  await expect(page.frameLocator('#app').getByRole('heading')).toHaveText('Version 2');
  await expect(page.locator('#update')).toBeHidden();
  await expect(page.locator('#stamp')).toBeEmpty();
  await expect.poll(() => app().evaluate(() => scrollY)).toBe(500);
});
