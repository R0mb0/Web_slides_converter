const express = require('express');
const cors = require('cors');
const path = require('path');
const puppeteer = require('puppeteer');
const { execSync } = require('child_process');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// --- AUTO-FIX: Garantisce che Chrome sia installato su Render ---
function ensureBrowserInstalled() {
    try {
        console.log("Verifying Chrome installation...");
        execSync('npx puppeteer browsers install chrome', { stdio: 'inherit' });
    } catch (error) {
        console.error("Warning: Auto-install skipped/failed.", error);
    }
}
ensureBrowserInstalled();
// -------------------------------------------------------------

app.post('/convert', async (req, res) => {
    const { url } = req.body;
    if (!url) return res.status(400).send('URL is required');

    let browser = null;

    try {
        console.log(`[START] Conversion requested for: ${url}`);

        browser = await puppeteer.launch({
            headless: 'new',
            protocolTimeout: 60000,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-gpu',
                '--disable-extensions',
                '--no-first-run',
                '--no-zygote',
                '--disable-accelerated-2d-canvas'
            ]
        });

        const page = await browser.newPage();

        // 1. Preparazione URL per Reveal.js
        let targetUrl = url;
        // Rimuove eventuali ancore finali (es. #/1) che confondono la stampa
        targetUrl = targetUrl.split('#')[0];
        // Aggiunge ?print-pdf
        if (!targetUrl.includes('print-pdf')) {
            targetUrl += (targetUrl.includes('?') ? '&' : '?') + 'print-pdf';
        }

        console.log(`[NAV] Going to: ${targetUrl}`);

        // 2. Impostazione Viewport (non critica per il PDF ma aiuta il caricamento)
        await page.setViewport({ width: 1280, height: 1024 });

        // 3. Navigazione
        await page.goto(targetUrl, { waitUntil: 'networkidle0', timeout: 60000 });

        // 4. INIEZIONE CSS AGGRESSIVA (Fix per vedere tutte le slide)
        await page.addStyleTag({
            content: `
                /* Nasconde l'interfaccia */
                .reveal .controls, .reveal .progress, .reveal .playback, .reveal .state-background,
                .navigate-left, .navigate-right, .navigate-up, .navigate-down,
                button, .bespoke-marp-osc, nav.navigation, .navigation-bar, 
                .ytp-chrome-top, .ytp-chrome-bottom
                { display: none !important; }

                /* Forza lo sfondo bianco */
                body, .reveal { background-color: white !important; -webkit-print-color-adjust: exact; }

                /* REVEAL.JS FIX: Forza tutte le slide ad essere visibili e verticali */
                .reveal .slides section { 
                    display: block !important; 
                    opacity: 1 !important; 
                    visibility: visible !important;
                    position: relative !important; 
                    top: auto !important; 
                    left: auto !important; 
                    transform: none !important;
                    page-break-after: always !important; /* Forza pagina nuova */
                    height: auto !important;
                    min-height: 100vh !important;
                    overflow: visible !important;
                }
                
                /* Rimuove overflow nascosti che tagliano il contenuto */
                .reveal .slides { 
                    transform: none !important; 
                    overflow: visible !important;
                    height: auto !important;
                }
                .reveal-viewport { overflow: visible !important; }
            `
        });

        // Attesa extra per assicurarsi che il layout "print" si assesti
        await new Promise(r => setTimeout(r, 2000));

        console.log(`[PDF] Generating PDF...`);

        // 5. GENERAZIONE PDF (Con il parametro magico)
        const pdfBuffer = await page.pdf({
            format: 'A4',
            printBackground: true,
            // QUESTO È IL PUNTO CHIAVE: Usa le dimensioni definite dal CSS di Reveal.js
            preferCSSPageSize: true,
            margin: { top: '0px', bottom: '0px', left: '0px', right: '0px' }
        });

        console.log(`[SUCCESS] PDF Size: ${pdfBuffer.length} bytes`);

        res.set({
            'Content-Type': 'application/pdf',
            'Content-Length': pdfBuffer.length,
            'Content-Disposition': 'inline; filename="slides.pdf"'
        });
        res.send(pdfBuffer);

    } catch (error) {
        console.error('[ERROR]', error);
        res.status(500).send('Conversion error: ' + error.message);
    } finally {
        if (browser) await browser.close();
    }
});

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});