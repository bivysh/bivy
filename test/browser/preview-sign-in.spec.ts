// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from './fixtures.js';

for (const method of ['email', 'github'] as const) {
  test(`separately hosted browser ${method} sign-in completes in the original window`, async ({ page, webApp }) => {
    const html = await webApp.transformIndexHtml('/preview-sign-in', `<html><body><div id="root"></div><script type="module">
      import React from 'react';
      import { createRoot } from 'react-dom/client';
      import { SetupNotice } from '/src/components/SetupNotice.tsx';
      import { clientConfiguration, parseClientConfiguration } from '/src/client-config.ts';
      import { controller } from '/src/store/useStore.ts';
      Object.assign(clientConfiguration, parseClientConfiguration(JSON.stringify({platform:'browser',signInFlow:'device'})));
      controller.local.cp = location.origin;
      controller.completeSignIn = async token => { window.completed = token; };
      createRoot(document.getElementById('root')).render(React.createElement(SetupNotice));
    </script></body></html>`);
    await page.route(`${webApp.origin}/preview-sign-in`, route => route.fulfill({ contentType: 'text/html', body: html }));
    await page.route('**/auth/owner/status', route => route.fulfill({ json: { enabled: false, github: true, email: true } }));
    await page.route('**/auth/device/start', route => route.fulfill({ json: { deviceId: 'test', deviceSecret: 'test-only', expiresInMs: 60000, intervalMs: 100 } }));
    await page.route('**/auth/device/github/start', route => route.fulfill({ json: { deviceId: 'test', deviceSecret: 'test-only', authorizeUrl: 'https://signin.example.invalid/authorize', expiresInMs: 60000, intervalMs: 100 } }));
    let approved = false;
    await page.route('**/auth/device/poll', route => route.fulfill({ json: approved ? { status: 'complete', token: 'test-only-token' } : { status: 'pending' } }));
    await page.goto(`${webApp.origin}/preview-sign-in`);
    if (method === 'email') {
      await page.getByRole('textbox', { name: /email/i }).fill('preview@example.invalid');
      await page.getByRole('button', { name: 'Continue with email' }).click();
      await expect(page.getByText(/signed in here automatically/)).toBeVisible();
    } else {
      await page.getByRole('button', { name: 'Continue with GitHub' }).click();
      await expect(page.getByRole('button', { name: /cancel/i })).toBeVisible();
    }
    approved = true;
    await expect.poll(() => page.evaluate(() => (window as any).completed)).toBe('test-only-token');
    expect(page.url()).toBe(`${webApp.origin}/preview-sign-in`);
  });
}
