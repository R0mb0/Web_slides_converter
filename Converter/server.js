const express = require('express');
const cors = require('cors');
const path = require('path');
const puppeteer = require('puppeteer');
// Aggiungiamo 'child_process' per poter eseguire comandi di installazione se necessario
const { execSync } = require('child_process');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// --- AUTO-FIX PER RENDER ---
// Poiché abbiamo usato --ignore-scripts locale, il browser potrebbe mancare.
// Questa funzione forza il download di Chrome all'avvio del server se necessario.
function ensureBrowserInstalled() {
    try {
        console.log("Verifying Chrome installation for Puppeteer...");
        // Esegue il comando di installazione ufficiale di Puppeteer
        // Questo scaricherà la versione corretta di Chrome nella cache
        execSync('npx puppeteer browsers install chrome', { stdio: 'inherit' });
        console.log("Chrome verification/installation complete.");
    } catch (error) {
        console.error("Warning: Failed to auto-install Chrome via script.", error);
    }
}

// Eseguiamo il controllo prima di avviare il server
ensureBrowserInstalled();
// ---------------------------

app.post('/convert', async (req, res) => {
    const { url } = req.body;
    if (!url) return res.status(400).send('URL is required');

    let browser = null;

    try {
        console.log('Launching browser for:', url);

        // Configurazione OTTIMIZZATA per Render.com (Free Tier)
        browser = await puppeteer.launch({
            headless: 'new',
            protocolTimeout: 60000,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage', // Fondamentale per la memoria
                '--disable-gpu',           // Disabilita GPU
                '--disable-extensions',
                '--no-first-run',
                '--no-zygote',
                '--disable-accelerated-2d-canvas'
            ]
        });

        const page = await browser.newPage();

        let targetUrl = url;
        // Aggiunge il parametro per la stampa di Reveal.js se manca
        if (!url.includes('print-pdf')) {
             targetUrl += (url.includes('?') ? '&' : '?') + 'print-pdf';
        }

        // Imposta viewport Full HD
        await page.setViewport({ width: 1920, height: 1080 });
        
        // Timeout 60s
        await page.goto(targetUrl, { waitUntil: 'networkidle2', timeout: 60000 });

        // Iniezione CSS per pulire la pagina
        await page.addStyleTag({
            content: `
                .reveal .controls, .reveal .progress, .reveal .playback, .reveal .state-background,
                .navigate-left, .navigate-right, .navigate-up, .navigate-down,
                button[aria-label="Next slide"], button[aria-label="Previous slide"],
                .bespoke-marp-osc, nav.navigation, .navigation-bar,
                .ytp-chrome-top, .ytp-chrome-bottom
                { display: none !important; }
                body { background-color: white !important; -webkit-print-color-adjust: exact; }
                .reveal .slides section { display: block !important; position: relative !important; top: auto !important; left: auto !important; transform: none !important; }
            `
        });

        const pdfBuffer = await page.pdf({
            format: 'A4',
            printBackground: true,
            margin: { top: '10px', bottom: '10px', left: '10px', right: '10px' }
        });

        res.set({
            'Content-Type': 'application/pdf',
            'Content-Length': pdfBuffer.length,
            'Content-Disposition': 'inline; filename="slides.pdf"'
        });
        res.send(pdfBuffer);

    } catch (error) {
        console.error('Error during conversion:', error);
        res.status(500).send('Conversion error: ' + error.message);
    } finally {
        if (browser) await browser.close();
    }
});

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});