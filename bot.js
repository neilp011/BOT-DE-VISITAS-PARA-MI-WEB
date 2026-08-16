const { chromium } = require('playwright');

const BASE_URL = process.env.BASE_URL || 'https://gringo200081.blogspot.com/?m=1';

async function run() {
  const browser = await chromium.launch();
  const context = await browser.newContext();
  const page = await context.newPage();
  const results = [];

  console.log(`Abriendo ${BASE_URL}`);
  await page.goto(BASE_URL, { waitUntil: 'networkidle' });
  console.log('Título de la página:', await page.title());

  const links = await page.$$eval('a[href]', as => as.map(a => a.href));
  const uniqueLinks = [...new Set(links)].filter(l => l.startsWith('http'));

  console.log(`Encontrados ${uniqueLinks.length} links para probar`);

  for (const link of uniqueLinks) {
    try {
      const response = await page.request.get(link, { timeout: 10000 });
      const status = response.status();
      const ok = status >= 200 && status < 400;
      console.log(`${ok ? 'OK' : 'ERROR'} (${status}) - ${link}`);
      results.push({ link, status, ok });
    } catch (err) {
      console.log(`ERROR (sin respuesta) - ${link} - ${err.message}`);
      results.push({ link, status: null, ok: false });
    }
  }

  console.log('\n=== RESUMEN ===');
  const rotos = results.filter(r => !r.ok);
  console.log(`Total: ${results.length} | OK: ${results.length - rotos.length} | Rotos: ${rotos.length}`);
  if (rotos.length > 0) {
    console.log('\nLinks rotos:');
    rotos.forEach(r => console.log(`- ${r.link} (${r.status ?? 'sin respuesta'})`));
  }

  await browser.close();
  if (rotos.length > 0) process.exit(1);
}

run();
