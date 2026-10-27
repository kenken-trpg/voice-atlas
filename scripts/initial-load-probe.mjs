import { chromium, devices } from '@playwright/test';
const browser = await chromium.launch();
for (const mode of ['desktop', 'mobile']) {
  const data = [];
  for (let i = 0; i < 7; i++) {
    const context = await browser.newContext(mode === 'mobile' ? { ...devices['iPhone 13'] } : {});
    const page = await context.newPage();
    const cdp = await context.newCDPSession(page);
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: mode === 'mobile' ? 4 : 1 });
    await page.route('**/api/**', (route) => route.fulfill({ status: 503, json: {} }));
    await page.goto('http://127.0.0.1:3212/', { waitUntil: 'load' });
    await page.getByRole('button', { name: '凛と、落ち着いて' }).waitFor();
    await page.waitForFunction(
      () => performance.getEntriesByName('first-contentful-paint').length > 0,
    );
    const value = await page.evaluate(() => ({
      paint: performance.getEntriesByName('first-contentful-paint')[0]?.startTime,
      dom: performance.getEntriesByType('navigation')[0].domContentLoadedEventEnd,
      load: performance.getEntriesByType('navigation')[0].loadEventEnd,
      resources: performance
        .getEntriesByType('resource')
        .filter((x) => x.name.includes('/assets/'))
        .map((x) => ({ name: x.name.split('/').pop(), bytes: x.encodedBodySize })),
    }));
    data.push(value);
    await context.close();
  }
  const median = (key) => data.map((x) => x[key]).sort((a, b) => a - b)[3];
  console.log(
    JSON.stringify({
      mode,
      runs: 7,
      fcp: median('paint'),
      dom: median('dom'),
      load: median('load'),
      assets: data[0].resources,
      samples: data.map(({ paint, dom, load }) => ({ paint, dom, load })),
    }),
  );
}
await browser.close();
