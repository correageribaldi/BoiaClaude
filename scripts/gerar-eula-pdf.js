/**
 * Gera docs/cronos-eula.pdf a partir de docs/cronos-eula.html
 * Uso: node scripts/gerar-eula-pdf.js
 */
require('dotenv').config();
const path = require('path');
const fs = require('fs');

const CHROMIUM_PATH = process.env.CHROMIUM_PATH
  || '/usr/bin/google-chrome-stable';

const HTML_PATH = path.join(__dirname, '../docs/cronos-eula.html');
const PDF_PATH  = path.join(__dirname, '../docs/cronos-eula.pdf');

(async () => {
  if (!fs.existsSync(HTML_PATH)) {
    console.error('❌ Arquivo não encontrado:', HTML_PATH);
    process.exit(1);
  }

  // Tenta usar puppeteer (dependência do whatsapp-web.js)
  let puppeteer;
  try {
    puppeteer = require('puppeteer');
  } catch {
    try {
      puppeteer = require('puppeteer-core');
    } catch {
      console.error('❌ puppeteer não encontrado. Tente: npm install puppeteer');
      process.exit(1);
    }
  }

  console.log('🔄 Gerando PDF...');
  const browser = await puppeteer.launch({
    executablePath: CHROMIUM_PATH,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu'],
  });

  const page = await browser.newPage();

  // Lê o HTML e injeta diretamente (evita problema com file:// no headless)
  const htmlContent = fs.readFileSync(HTML_PATH, 'utf-8');
  await page.setContent(htmlContent, { waitUntil: 'networkidle0' });

  await page.pdf({
    path: PDF_PATH,
    format: 'A4',
    printBackground: true,
    margin: { top: '20mm', bottom: '20mm', left: '15mm', right: '15mm' },
  });

  await browser.close();
  console.log('✅ PDF gerado em:', PDF_PATH);
})();
