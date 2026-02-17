const express = require('express');
const cors = require('cors');
const path = require('path');
// 1. IMPOSTAZIONE CRITICA: Definiamo la cartella della cache PRIMA di richiedere puppeteer
// Questo costringe Puppeteer a scaricare e cercare Chrome dentro la cartella del progetto
process.env.PUPPETEER_CACHE_DIR = path.join(__dirname, '.cache');

const puppeteer = require('puppeteer');
const { execSync } = require('child_process');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// --- AUTO-FIX: Scarica Chrome nella cartella locale (.cache) ---
function ensureBrowserInstalled() {
    try {
        console.log("Checking/Installing Chrome for Puppeteer...");
        console.log(`Cache directory: ${process.env.PUPPETEER_CACHE_DIR}`);

        // Esegue il comando di installazione forzando la directory
        execSync('npx puppeteer browsers install chrome', { stdio: 'inherit' });

        console.log("Chrome installation verified.");
    } catch (error) {
        console.error("Warning: Auto-install script encountered an issue.", error);
    }
}
// Eseguiamo il controllo all'avvio
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

        let targetUrl = url;
        targetUrl = targetUrl.split('#')[0];
        if (!targetUrl.includes('print-pdf')) {
            targetUrl += (targetUrl.includes('?') ? '&' : '?') + 'print-pdf';
        }

        console.log(`[NAV] Going to: ${targetUrl}`);
        // Aumentiamo la viewport in altezza per simulare uno schermo molto lungo
        await page.setViewport({ width: 1280, height: 2000 });

        await page.goto(targetUrl, { waitUntil: 'networkidle0', timeout: 60000 });

        await page.addStyleTag({
            content: `
                /* FIX CRITICO: Sblocca l'altezza dei contenitori principali */
                html, body {
                    width: 100%;
                    height: auto !important; 
                    margin: 0; 
                    padding: 0;
                    overflow: visible !important;
                }

                /* Nasconde l'interfaccia */
                .reveal .controls, .reveal .progress, .reveal .playback, .reveal .state-background,
                .navigate-left, .navigate-right, .navigate-up, .navigate-down,
                button, .bespoke-marp-osc, nav.navigation, .navigation-bar, 
                .ytp-chrome-top, .ytp-chrome-bottom
                { display: none !important; }

                /* Forza lo sfondo bianco */
                body, .reveal { background-color: white !important; -webkit-print-color-adjust: exact; }

                /* FIX PER REVEAL.JS: Forza i contenitori delle slide a non tagliare il contenuto */
                .reveal, .reveal .slides {
                    position: static !important;
                    width: auto !important;
                    height: auto !important;
                    overflow: visible !important;
                    transform: none !important;
                }

                /* Forza ogni slide ad essere un blocco visibile */
                .reveal .slides section { 
                    display: block !important; 
                    opacity: 1 !important; 
                    visibility: visible !important;
                    position: relative !important; 
                    top: auto !important; 
                    left: auto !important; 
                    transform: none !important;
                    page-break-after: always !important;
                    height: auto !important;
                    min-height: 100vh !important; /* Ogni slide occupa almeno una pagina */
                    overflow: visible !important;
                }
                
                .reveal-viewport { overflow: visible !important; height: auto !important; }
            `
        });

        // Aumentiamo il tempo di attesa a 4 secondi per dare tempo al layout di assestarsi
        await new Promise(r => setTimeout(r, 4000));

        console.log(`[PDF] Generating PDF...`);

        const pdfBuffer = await page.pdf({
            format: 'A4',
            printBackground: true,
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