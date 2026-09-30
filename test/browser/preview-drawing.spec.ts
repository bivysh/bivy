import { inspectorScript } from '../../src/apps/inspector.js';
import { previewShell } from '../../src/apps/preview-shell.js';
import { test, expect, themes } from './fixtures.js';

for (const theme of themes) test(`preview marking captures gestures (${theme})`, async ({ page, context, webApp, isMobile, browserName }, info) => {
  const origin = webApp.origin;
  await page.route(`${origin}/__bivy/tokens.css`, route => route.fulfill({ path: 'packages/ui/tokens.css', contentType: 'text/css' }));
  await page.route(`${origin}/__bivy/styles.css`, route => route.fulfill({ path: 'packages/web/src/styles.css', contentType: 'text/css' }));
  await page.route(`${origin}/shell`, route => route.fulfill({ contentType: 'text/html', body: previewShell('test').replace('<html lang="en">', `<html lang="en" data-theme="${theme}">`) }));
  await page.route(`${origin}/host`, route => route.fulfill({ contentType: 'text/html', body: `<meta name="viewport" content="width=device-width,initial-scale=1"><style>body{margin:0}iframe{border:0;width:100vw;height:100dvh}</style><iframe src="/shell"></iframe><script>addEventListener('message', e => {if(e.data.type==='annotation')window.annotation=e.data;if(e.data.type==='hello'){e.source.postMessage({source:'bivy',type:'draw',available:true},location.origin);e.source.postMessage({source:'bivy',type:'voice',available:true},location.origin)}})</script>` }));
  await page.route('http://preview.test/**', route => route.request().url().includes('/__bivy/')
    ? route.fulfill({ status: 503 })
    : route.fulfill({ contentType: 'text/html', body: `<style>body{height:3000px;background:linear-gradient(white,lightblue)}</style><h1>Preview app</h1><p>Mark here</p><div id="panel" style="position:absolute;left:210px;top:80px;width:100px;height:60px;overflow:auto"><div style="height:600px">Scrollable app panel</div></div><script>${inspectorScript(origin)}</script>` }));
  await context.addInitScript(({ origin }) => sessionStorage.setItem('bivy-preview', JSON.stringify({ name: 'Website preview', origin: 'http://preview.test', returnTo: origin + '/chat' })), { origin });
  await page.goto(`${origin}/host`);
  const shell = page.frameLocator('iframe');
  await expect(shell.getByRole('button', { name: 'Mark', exact: true })).toBeVisible();
  // Point and Draw were one intention behind two buttons; there is one now.
  await expect(shell.getByRole('button', { name: 'Point', exact: true })).toHaveCount(0);
  await expect(shell.getByRole('button', { name: 'Draw', exact: true })).toHaveCount(0);
  const checkTargets = async () => {
    for (const button of await shell.locator('#dock button:visible').all()) {
      const box = (await button.boundingBox())!;
      expect(box.width).toBeGreaterThanOrEqual(48);
      expect(box.height).toBeGreaterThanOrEqual(48);
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(page.viewportSize()!.width);
    }
  };
  await checkTargets();
  await page.screenshot({ path: info.outputPath(`controls-${theme}.png`) });
  await shell.frameLocator('#app').locator('#panel').evaluate(el => { el.scrollTop = 220; });
  await shell.getByRole('button', { name: 'Mark', exact: true }).click();
  await expect(shell.getByRole('button', { name: 'Done', exact: true })).toBeDisabled();
  await expect(shell.getByRole('toolbar', { name: 'Marking tools' })).toBeFocused();
  await checkTargets();
  const ink = shell.locator('#ink');
  await expect(ink).toBeVisible();
  const cdp = browserName === 'chromium' && isMobile ? await context.newCDPSession(page) : null;
  // A drag draws the path it takes.
  if (cdp) {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 80, y: 260 }] });
    for (let i = 1; i <= 8; i++) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: 80 + i * 12, y: 260 - i * 16 }] });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  } else {
    await page.mouse.move(80, 260); await page.mouse.down();
    await page.mouse.move(176, 132, { steps: 8 }); await page.mouse.up();
  }
  await expect(ink.locator('polyline.mark')).toHaveCount(1);
  // A tap marks the element under it, as the old Point button did.
  await page.mouse.click(60, 120);
  await expect(ink.locator('rect.mark')).toHaveCount(1);
  const app = page.frames().find(frame => frame.url() === 'http://preview.test/')!;
  expect(await app.evaluate(() => scrollY)).toBe(0);
  await expect(shell.getByRole('button', { name: 'Done', exact: true })).toBeEnabled();
  await page.screenshot({ path: info.outputPath(`marking-${theme}.png`) });
  if (cdp) {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 80, y: 360, id: 1 }, { x: 180, y: 360, id: 2 }] });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: 80, y: 260, id: 1 }, { x: 180, y: 260, id: 2 }] });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await expect.poll(() => app.evaluate(() => scrollY)).toBeGreaterThan(0);
  }
  await shell.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(ink.locator('rect.mark')).toHaveCount(0);
  await expect(ink.locator('polyline.mark')).toHaveCount(1);
  await shell.getByRole('button', { name: 'Done', exact: true }).click();
  await expect(shell.getByRole('textbox', { name: 'What should change?' })).toBeFocused();
  await expect(shell.locator('#draft-context')).toContainText('pen ');
  await expect(shell.locator('nav')).toBeHidden();
  await expect(shell.locator('#draft-details')).not.toHaveAttribute('open');
  await shell.getByRole('textbox', { name: 'What should change?' }).fill('Keep these pen marks');
  const field = (await shell.locator('#draft-text').boundingBox())!;
  const actions = (await shell.locator('#draft .panel-actions').boundingBox())!;
  expect(field.y + field.height).toBeLessThanOrEqual(actions.y);
  await page.screenshot({ path: info.outputPath(`note-${theme}.png`) });
  if (isMobile) {
    // Approximate the space left by a software keyboard without a second width matrix.
    await page.setViewportSize({ width: 390, height: 400 });
    const shortField = (await shell.locator('#draft-text').boundingBox())!;
    const shortActions = (await shell.locator('#draft .panel-actions').boundingBox())!;
    expect(shortField.y).toBeGreaterThanOrEqual(0);
    expect(shortField.y + shortField.height).toBeLessThanOrEqual(shortActions.y);
    expect(shortActions.y + shortActions.height).toBeLessThanOrEqual(400);
    await checkTargets();
    await page.screenshot({ path: info.outputPath(`note-keyboard-${theme}.png`) });
    await page.setViewportSize({ width: 390, height: 844 });
  }
  await shell.getByRole('button', { name: 'Add to chat', exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).annotation?.mark.strokes)).toMatchObject([{ tool: 'pen' }]);
  expect(await page.evaluate(() => (window as any).annotation.mark.elementScrolls)).toEqual([{ selector: '#panel', x: 0, y: 220 }]);
  expect(await page.evaluate(() => (window as any).annotation.text)).toContain('Keep these pen marks');
  await expect(ink).toBeHidden();

  // A long press in the app marks what it lands on and opens the note, with no
  // mode to enter first. A plain tap is left alone, so the app stays usable.
  await app.evaluate(() => { (window as any).taps = 0; document.body.addEventListener('click', () => { (window as any).taps++; }); });
  await shell.frameLocator('#app').getByText('Mark here').click();
  await expect.poll(() => app.evaluate(() => (window as any).taps)).toBe(1);
  await expect(shell.locator('#draft')).toBeHidden();
  const paragraph = (await shell.frameLocator('#app').getByText('Mark here').boundingBox())!;
  await page.mouse.move(paragraph.x + paragraph.width / 2, paragraph.y + paragraph.height / 2);
  await page.mouse.down();
  await expect(ink).toBeVisible();
  await page.mouse.up();
  await expect(shell.locator('#draft')).toBeVisible();
  await expect(shell.locator('#draft-context')).toContainText('Mark here');
  await expect(ink.locator('rect.mark')).toHaveCount(1);
  // Lifting where the press landed opens the note listening, as holding to
  // point and speak used to. Escape unwinds one layer at a time.
  await expect(shell.locator('#voice-status')).toContainText('Listening');
  await page.screenshot({ path: info.outputPath(`press-${theme}.png`) });
  await page.keyboard.press('Escape');
  await expect(shell.locator('#voice-status')).toBeEmpty();
  await expect(shell.locator('#draft')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(shell.locator('#draft')).toBeHidden();
  await expect(ink).toBeHidden();
});
