
const { chromium } = require('playwright');

const BASE_URL = process.env.BASE_URL || 'https://tu-sitio.com';
const WAIT_ON_REDIRECT_MS = parseInt(process.env.WAIT_MS || '15000', 10);
const MAX_INTERACTIONS_EN_REDIRECT = 5;

async function run() {
  const browser = await chromium.launch();
  const context = await browser.newContext();
  const page = await context.newPage();
  const results = [];

  console.log(`Abriendo ${BASE_URL}`);
  await page.goto(BASE_URL, { waitUntil: 'networkidle' });

  const originalUrl = page.url();
  const baseOrigin = new URL(originalUrl).origin;
  const links = await page.$$eval('a[href]', as => as.map(a => a.href));
  const uniqueLinks = [...new Set(links)].filter(l => l.startsWith('http'));

  console.log(`Encontrados ${uniqueLinks.length} links para probar`);

  for (const link of uniqueLinks) {
    console.log(`\nProbando: ${link}`);
    try {
      await page.goto(originalUrl, { waitUntil: 'networkidle' });
      const [popup] = await Promise.all([
        context.waitForEvent('page', { timeout: 3000 }).catch(() => null),
        page.click(`a[href="${link}"], a[href="${link.replace(baseOrigin, '')}"]`).catch(() => null),
      ]);
      const targetPage = popup || page;
      await targetPage.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
      const currentOrigin = new URL(targetPage.url()).origin;

      if (currentOrigin !== baseOrigin) {
        console.log(`  -> Redirigido a otra web: ${targetPage.url()}`);
        console.log(`  -> Esperando ${WAIT_ON_REDIRECT_MS / 1000}s e interactuando...`);
        await targetPage.waitForTimeout(WAIT_ON_REDIRECT_MS);
        const clickables = await targetPage.$$('button, a[href]');
        for (const el of clickables.slice(0, MAX_INTERACTIONS_EN_REDIRECT)) {
          await el.click({ timeout: 2000 }).catch(() => {});
          await targetPage.waitForTimeout(1000);
        }
      }

      results.push({ link, status: 'ok', finalUrl: targetPage.url() });
      if (popup) await popup.close().catch(() => {});
    } catch (err) {
      console.log(`  -> Error: ${err.message}`);
      results.push({ link, status: 'error', error: err.message });
    }
  }

  console.log('\n=== RESUMEN ===');
  results.forEach(r => console.log(`${r.status.toUpperCase()} - ${r.link}`));
  await browser.close();

  const fallidos = results.filter(r => r.status === 'error');
  if (fallidos.length > 0) process.exit(1);
}

run();
