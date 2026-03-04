/**
 * Gera docs/cronos-eula.pdf a partir de docs/cronos-eula.html
 * Uso: node scripts/gerar-eula-pdf.js
 */
require('dotenv').config();
const puppeteer = require('puppeteer-core');
const path = require('path');
const fs = require('fs');

const CHROMIUM_PATH = process.env.CHROMIUM_PATH
  || '/root/.cache/ms-playwright/chromium-1194/chrome-linux/chrome';

const HTML_PATH = path.join(__dirname, '../docs/cronos-eula.html');
const PDF_PATH  = path.join(__dirname, '../docs/cronos-eula.pdf');

(async () => {
  if (!fs.existsSync(HTML_PATH)) {
    console.error('❌ Arquivo não encontrado:', HTML_PATH);
    process.exit(1);
  }

  console.log('🔄 Abrindo Chromium para gerar PDF...');
  const browser = await puppeteer.launch({
    executablePath: CHROMIUM_PATH,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });

  const page = await browser.newPage();
  await page.goto(`file://${HTML_PATH}`, { waitUntil: 'networkidle0' });

  await page.pdf({
    path: PDF_PATH,
    format: 'A4',
    printBackground: true,
    margin: { top: '20mm', bottom: '20mm', left: '15mm', right: '15mm' },
  });

  await browser.close();
  console.log('✅ PDF gerado em:', PDF_PATH);
})();
