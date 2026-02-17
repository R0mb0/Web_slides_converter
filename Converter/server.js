const express = require('express');
const cors = require('cors');
const path = require('path');
// 1. IMPOSTAZIONE CRITICA: Definiamo la cartella della cache
process.env.PUPPETEER_CACHE_DIR = path.join(__dirname, '.cache');

const puppeteer = require('puppeteer');
const { execSync } = require('child_process');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// --- AUTO-FIX: Scarica Chrome se manca ---
function ensureBrowserInstalled() {
    try {
        console.log("Checking Chrome installation...");
        execSync('npx puppeteer browsers install chrome', { stdio: 'inherit' });
    } catch (error) {
        console.error("Warning: Auto-install skipped.", error);
    }
}
ensureBrowserInstalled();

app.post('/convert', async (req, res) => {
    const { url } = req.body;
    if (!url) return res.status(400).send('URL is required');

    let browser = null;

    try {
        console.log(`[START] Conversion requested for: ${url}`);

        browser = await puppeteer.launch({
            headless: 'new',
            protocolTimeout: 120000, // 2 minuti di tempo massimo per connessioni lente
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

        // 1. Preparazione URL
        // Rimuoviamo qualsiasi ancora e aggiungiamo print-pdf
        let targetUrl = url.split('#')[0];
        if (!targetUrl.includes('print-pdf')) {
            targetUrl += (targetUrl.includes('?') ? '&' : '?') + 'print-pdf';
        }

        console.log(`[NAV] Going to: ${targetUrl}`);

        // 2. Viewport Standard per Presentazioni
        // Usiamo una risoluzione tipica da laptop per evitare layout mobile
        await page.setViewport({ width: 1280, height: 800 });

        // 3. Navigazione con attesa di rete
        // Aumentiamo il timeout a 2 minuti per sicurezza
        await page.goto(targetUrl, { waitUntil: 'networkidle0', timeout: 120000 });

        // 4. ATTESA INTELLIGENTE (La chiave per risolvere il problema)
        // Invece di aspettare secondi a caso, aspettiamo che Reveal.js abbia creato le pagine PDF.
        // Reveal.js aggiunge la classe 'pdf-page' o imposta un'altezza elevata al body.
        console.log("[WAIT] Waiting for Reveal.js to layout PDF pages...");

        try {
            await page.waitForFunction(() => {
                // Controlla se l'altezza del documento è significativamente più grande della finestra
                // Questo indica che le slide sono state "srotolate" verticalmente
                return document.body.scrollHeight > window.innerHeight * 2;
            }, { timeout: 15000 }); // Aspetta max 15 secondi che il layout cambi
        } catch (e) {
            console.log("Warning: Layout check timed out, proceeding anyway...");
        }

        // 5. INIEZIONE CSS DI SICUREZZA
        // Forza lo sfondo bianco e nasconde i controlli, ma NON tocca il layout (ci pensa Reveal)
        await page.addStyleTag({
            content: `
                .reveal .controls, .reveal .progress, .reveal .playback, .reveal .state-background,
                .navigate-left, .navigate-right, .navigate-up, .navigate-down,
                .bespoke-marp-osc, nav.navigation, .navigation-bar,
                .ytp-chrome-top, .ytp-chrome-bottom, .header, .footer
                { display: none !important; }

                body, .reveal { background-color: white !important; }
                
                /* Forza la visibilità per sicurezza */
                .reveal .slides section { visibility: visible !important; opacity: 1 !important; display: block !important; }
            `
        });

        // Breve pausa finale per assicurarsi che font e immagini siano renderizzati
        await new Promise(r => setTimeout(r, 3000));

        console.log(`[PDF] Generating PDF...`);

        const pdfBuffer = await page.pdf({
            printBackground: true,
            preferCSSPageSize: true, // Rispetta i page-break del sito
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