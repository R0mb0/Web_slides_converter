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
            protocolTimeout: 120000,
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

        let targetUrl = url.split('#')[0];
        console.log(`[NAV] Going to: ${targetUrl}`);

        // Risoluzione standard
        await page.setViewport({ width: 1280, height: 720 });

        await page.goto(targetUrl, { waitUntil: 'networkidle2', timeout: 120000 });

        // FIX FOCUS: Clicchiamo sul corpo della pagina per assicurarci che riceva i comandi
        try {
            await page.click('body');
        } catch (e) { }

        console.log("[BOT] Starting Smart Slide Capture...");

        // INIEZIONE CSS: Nascondiamo l'interfaccia MA NON i pulsanti di navigazione ancora
        // (potrebbero servirci per cliccarli via JS, li nasconderemo nello screenshot)
        await page.addStyleTag({
            content: `
                .controls, .progress, .slide-number, .header, .footer, 
                .ytp-chrome-top, .ytp-chrome-bottom
                { opacity: 0 !important; } 
                /* Usiamo opacity 0 invece di display none per non rompere il layout o i click */
            `
        });

        const screenshots = [];
        let hasNext = true;
        let slideCount = 0;
        const MAX_SLIDES = 150;

        let currentHash = await page.evaluate(() => window.location.hash);

        while (hasNext && slideCount < MAX_SLIDES) {
            // Attesa stabilità visiva (aumentata a 1.5s per sicurezza)
            await new Promise(r => setTimeout(r, 1500));

            // Scatta Screenshot
            const imgBuffer = await page.screenshot({ encoding: 'base64', fullPage: false });
            screenshots.push(imgBuffer);
            slideCount++;
            console.log(`Captured slide ${slideCount} (Hash: ${currentHash})`);

            // --- NAVIGAZIONE INTELLIGENTE ---
            // Tentiamo 3 metodi per cambiare slide
            const navigationSuccess = await page.evaluate(() => {
                // Metodo 1: API Reveal.js (Il più affidabile)
                if (window.Reveal && typeof window.Reveal.next === 'function') {
                    window.Reveal.next();
                    return 'reveal-api';
                }

                // Metodo 2: Cerca e clicca pulsante "Avanti" standard
                const nextBtns = document.querySelectorAll('.navigate-right, .next, button[aria-label="Next slide"]');
                for (let btn of nextBtns) {
                    if (btn && btn.offsetParent !== null) { // Controlla se visibile/cliccabile
                        btn.click();
                        return 'click-btn';
                    }
                }

                return 'keyboard-fallback';
            });

            // Metodo 3: Tastiera (Fallback se i primi 2 falliscono o non trovano nulla)
            if (navigationSuccess === 'keyboard-fallback') {
                try {
                    await page.keyboard.press('ArrowRight');
                } catch (e) {
                    console.log("Keyboard nav failed");
                }
            }

            // Attesa post-navigazione per permettere l'aggiornamento dell'URL
            await new Promise(r => setTimeout(r, 1000));

            const newHash = await page.evaluate(() => window.location.hash);

            // CONTROLLO DI FINE: Se l'hash non cambia, siamo arrivati in fondo
            if (newHash === currentHash) {
                console.log("Hash did not change. Assuming end of presentation.");
                hasNext = false;
            } else {
                currentHash = newHash;
            }
        }

        console.log(`[BUILD] Stitched ${screenshots.length} slides. Generating PDF...`);

        const htmlContent = `
            <html>
                <body style="margin:0; padding:0; background: white;">
                    ${screenshots.map(img => `
                        <div style="width: 100%; height: 100vh; display: flex; justify-content: center; align-items: center; page-break-after: always; overflow: hidden;">
                            <img src="data:image/png;base64,${img}" style="max-width: 100%; max-height: 100%; object-fit: contain;" />
                        </div>
                    `).join('')}
                </body>
            </html>
        `;

        await page.setContent(htmlContent);

        const pdfBuffer = await page.pdf({
            printBackground: true,
            format: 'A4',
            margin: { top: '0px', bottom: '0px', left: '0px', right: '0px' }
        });

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