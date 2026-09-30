import { inspectorScript } from '../../src/apps/inspector.js';
import { previewShell } from '../../src/apps/preview-shell.js';
import { test, expect, themes } from './fixtures.js';

for (const theme of themes) test(`public preview sends annotations as notes without voice (${theme})`, async ({ page, context, webApp }, info) => {
  const origin = webApp.origin;
  const submissions: any[] = [];
  let fail = true, screenshot = true;
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  await page.route(`${origin}/__bivy/tokens.css`, route => route.fulfill({ path: 'packages/ui/tokens.css', contentType: 'text/css' }));
  await page.route(`${origin}/__bivy/styles.css`, route => route.fulfill({ path: 'packages/web/src/styles.css', contentType: 'text/css' }));
  await page.route(`${origin}/shell`, route => route.fulfill({ contentType: 'text/html', body: previewShell('test').replace('<html lang="en">', `<html lang="en" data-theme="${theme}">`) }));
  await page.route('http://preview.test/**', async route => {
    if (route.request().url().endsWith('/__bivy/notes')) {
      submissions.push(route.request().postDataJSON());
      await pending;
      return route.fulfill({ status: fail ? 429 : 200, contentType: 'application/json', body: JSON.stringify({ screenshot }) });
    }
    if (route.request().url().includes('/__bivy/')) return route.fulfill({ status: 503 });
    return route.fulfill({ contentType: 'text/html', body: `<h1>Review this app</h1><button>Buy a ticket</button><script>${inspectorScript(origin, true)}</script>` });
  });
  await context.addInitScript(() => sessionStorage.setItem('bivy-preview', JSON.stringify({ name: 'Public website preview', origin: 'http://preview.test', reviewer: true, badge: true })));
  await page.goto(`${origin}/shell`);
  await expect(page.getByRole('button', { name: 'Mark', exact: true })).toBeEnabled();
  // "Made with Bivy" sits under the app, and the floating tools stay clear of it.
  const badge = page.getByRole('link', { name: /Made with Bivy/ });
  await expect(badge).toHaveAttribute('href', 'https://bivy.sh/?ref=preview');
  const [bar, tools, stage] = await Promise.all([badge.boundingBox(), page.locator('#dock nav').boundingBox(), page.locator('#stage').boundingBox()]);
  expect(tools!.y + tools!.height).toBeLessThanOrEqual(bar!.y);
  expect(stage!.y + stage!.height).toBeLessThanOrEqual(bar!.y);
  await expect(page.locator('#back')).toBeHidden();
  await expect(page.locator('#mic')).toBeHidden();
  await expect(page.locator('#compare-btn')).toBeHidden();
  await expect(page.locator('#update')).toBeHidden();
  await page.screenshot({ path: info.outputPath(`public-controls-${theme}.png`) });
  await page.getByRole('button', { name: 'Mark', exact: true }).click();
  for (let i = 0; i < 2; i++) {
    await page.mouse.move(30, 30 + i * 30); await page.mouse.down();
    await page.mouse.move(210, 150 + i * 30, { steps: 8 }); await page.mouse.up();
  }
  await expect(page.locator('#ink polyline.mark')).toHaveCount(2);
  await page.screenshot({ path: info.outputPath(`public-marks-${theme}.png`) });
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  const note = page.getByRole('textbox', { name: 'What should change?' });
  await expect(note).toBeFocused();
  await expect(page.locator('#mic')).toBeHidden();
  await page.getByRole('button', { name: 'Send note', exact: true }).click();
  await expect(page.locator('#note-status')).toContainText('Write a note');
  expect(submissions).toHaveLength(0);
  await note.fill('Make the title and button easier to read');
  await page.screenshot({ path: info.outputPath(`public-draft-${theme}.png`) });
  await page.getByRole('button', { name: 'Send note', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Sending…', exact: true })).toBeDisabled();
  await expect(note).toBeDisabled();
  release();
  await expect(page.locator('#note-status')).toContainText('wait a moment');
  await expect(note).toHaveValue('Make the title and button easier to read');
  expect(submissions[0].mark.strokes.map((stroke: any) => stroke.tool)).toEqual(['pen', 'pen']);
  fail = false;
  await page.getByRole('button', { name: 'Send note', exact: true }).click();
  await expect(page.locator('#draft')).toBeHidden();
  await expect(page.locator('#status')).toContainText('picture sent');
  await expect(page.locator('#ink')).toBeHidden();
  await expect(page.getByRole('button', { name: 'Mark', exact: true })).toBeFocused();
  // A long press on the button is the whole gesture: it marks it and opens the note.
  const buy = (await page.frameLocator('#app').getByRole('button', { name: 'Buy a ticket' }).boundingBox())!;
  await page.mouse.move(buy.x + buy.width / 2, buy.y + buy.height / 2);
  await page.mouse.down();
  await expect(page.locator('#ink')).toBeVisible();
  await page.mouse.up();
  await expect(note).toBeFocused();
  screenshot = false;
  await note.fill('Use a clearer label');
  await page.getByRole('button', { name: 'Send note', exact: true }).click();
  await expect(page.locator('#draft')).toBeHidden();
  expect(submissions.at(-1).mark.strokes[0].tool).toBe('box');
  expect(submissions.at(-1).context).toContain('Buy a ticket');
  expect(submissions.at(-1).selector).toBe('button');
  await expect(page.locator('#status')).toContainText('without a picture');
  await page.screenshot({ path: info.outputPath(`public-sent-${theme}.png`) });
});
