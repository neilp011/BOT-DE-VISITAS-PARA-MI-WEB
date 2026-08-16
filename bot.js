const { chromium } = require('playwright');

// ==================== CONFIGURACIÓN ====================
const BASE_URL = process.env.BASE_URL;
if (!BASE_URL) {
  console.error('Falta la variable de entorno BASE_URL (la URL de inicio a rastrear).');
  process.exit(1);
}

const MAX_DEPTH = parseInt(process.env.MAX_DEPTH || '2', 10);
const EXTRA_WAIT_MS = parseInt(process.env.EXTRA_WAIT_MS || '5000', 10);

const ALLOWED_DOMAINS = (process.env.ALLOWED_DOMAINS || new URL(BASE_URL).hostname)
  .split(',')
  .map(d => d.trim().toLowerCase())
  .filter(Boolean);

const CLICK_TEXT_PATTERNS = [
  /haz\s*click\s*aqu[ií]/i,
  /haz\s*clic\s*aqu[ií]/i,
  /click\s*aqu[ií]/i,
];

function isAllowedDomain(url) {
  try {
    const hostname = new URL(url).hostname.toLowerCase();
    return ALLOWED_DOMAINS.some(d => hostname === d || hostname.endsWith('.' + d));
  } catch {
    return false;
  }
}

function cleanUrl(url) {
  return url.split('#')[0];
}

async function run() {
  const browser = await chromium.launch();
  const context = await browser.newContext();

  const visited = new Set();
  const results = [];
  const queue = [{ url: BASE_URL, depth: 0 }];

  console.log(`Dominios permitidos para navegar/clickear: ${ALLOWED_DOMAINS.join(', ')}`);
  console.log(`Profundidad máxima: ${MAX_DEPTH}\n`);

  while (queue.length > 0) {
    const { url, depth } = queue.shift();
    const target = cleanUrl(url);
    if (visited.has(target)) continue;
    visited.add(target);

    const page = await context.newPage();
    const consoleErrors = [];
    page.on('console', msg => {
      if (msg.type() === 'error') consoleErrors.push(msg.text());
    });
    page.on('pageerror', err => consoleErrors.push(err.message));

    const record = {
      url: target, depth, status: null, ok: false, title: null,
      consoleErrors: [], brokenImages: [], clicked: [],
    };

    try {
      const response = await page.goto(target, { waitUntil: 'networkidle', timeout: 15000 });
      record.status = response ? response.status() : null;
      record.ok = record.status >= 200 && record.status < 400;
      record.title = await page.title();

      console.log(`${record.ok ? 'OK' : 'ERROR'} (${record.status}) [nivel ${depth}] - ${target} - "${record.title}"`);

      if (EXTRA_WAIT_MS > 0) {
        await page.waitForTimeout(EXTRA_WAIT_MS);
      }

      record.brokenImages = await page.$$eval('img', imgs =>
        imgs.filter(img => !img.complete || img.naturalWidth === 0).map(img => img.src)
      );
      if (record.brokenImages.length > 0) {
        console.log(`  ⚠ ${record.brokenImages.length} imagen(es) rota(s)`);
      }

      const clickables = await page.$$('a, button');
      for (const el of clickables) {
        const text = (await el.innerText().catch(() => '')).trim();
        if (!CLICK_TEXT_PATTERNS.some(rx => rx.test(text))) continue;

        console.log(`  → Clic en elemento "${text}"`);
        const before = page.url();

        try {
          await Promise.all([
            page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {}),
            el.click({ timeout: 5000 }),
          ]);
          const after = page.url();
          record.clicked.push({ text, before, after, ok: true });

          if (after !== before && isAllowedDomain(after) && !visited.has(cleanUrl(after))) {
            queue.push({ url: after, depth: depth + 1 });
          }

          if (after !== before) {
            await page.goto(target, { waitUntil: 'networkidle', timeout: 15000 }).catch(() => {});
          }
        } catch (err) {
          console.log(`    ✗ Error al clickear: ${err.message}`);
          record.clicked.push({ text, before, ok: false, error: err.message });
        }
      }

      if (depth < MAX_DEPTH) {
        const links = await page.$$eval('a[href]', as => as.map(a => a.href));
        for (const link of [...new Set(links)]) {
          if (visited.has(cleanUrl(link))) continue;

          if (isAllowedDomain(link)) {
            queue.push({ url: link, depth: depth + 1 });
          } else {
            try {
              const resp = await page.request.get(link, { timeout: 10000 });
              const st = resp.status();
              console.log(`  [externo] ${st >= 200 && st < 400 ? 'OK' : 'ERROR'} (${st}) - ${link}`);
            } catch (err) {
              console.log(`  [externo] ERROR (sin respuesta) - ${link} - ${err.message}`);
            }
          }
        }
      }
    } catch (err) {
      console.log(`ERROR (sin respuesta) [nivel ${depth}] - ${target} - ${err.message}`);
    }

    record.consoleErrors = consoleErrors;
    if (consoleErrors.length > 0) {
      console.log(`  ⚠ ${consoleErrors.length} error(es) de consola`);
    }

    results.push(record);
    await page.close();
  }

  console.log('\n=== RESUMEN ===');
  const rotos = results.filter(r => !r.ok);
  const conProblemas = results.filter(r => r.consoleErrors.length > 0 || r.brokenImages.length > 0);
  const totalClicks = results.reduce((sum, r) => sum + r.clicked.length, 0);
  const clicksFallidos = results.reduce((sum, r) => sum + r.clicked.filter(c => !c.ok).length, 0);

  console.log(`Páginas visitadas: ${results.length}`);
  console.log(`OK: ${results.length - rotos.length} | Rotas: ${rotos.length}`);
  console.log(`Elementos "haz click aquí" probados: ${totalClicks} | Fallidos: ${clicksFallidos}`);

  if (rotos.length > 0) {
    console.log('\nPáginas con error:');
    rotos.forEach(r => console.log(`- ${r.url} (${r.status ?? 'sin respuesta'})`));
  }

  if (conProblemas.length > 0) {
    console.log('\nPáginas con problemas (consola / imágenes):');
    conProblemas.forEach(r => {
      if (r.consoleErrors.length) console.log(`- ${r.url}: ${r.consoleErrors.length} error(es) de consola`);
      if (r.brokenImages.length) console.log(`- ${r.url}: ${r.brokenImages.length} imagen(es) rota(s)`);
    });
  }

  if (clicksFallidos > 0) {
    console.log('\nClics fallidos:');
    results.forEach(r => {
      r.clicked.filter(c => !c.ok).forEach(c => console.log(`- "${c.text}" en ${r.url}: ${c.error}`));
    });
  }

  await browser.close();
  if (rotos.length > 0 || clicksFallidos > 0) process.exit(1);
}

run();
