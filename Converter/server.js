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

        // 1. NAVIGAZIONE (Modalità Normale)
        // NON usiamo ?print-pdf. Vogliamo vedere il sito esattamente come un utente.
        let targetUrl = url.split('#')[0];

        console.log(`[NAV] Going to: ${targetUrl}`);

        // Impostiamo una risoluzione standard da Laptop (1280x720) per avere slide ben proporzionate
        await page.setViewport({ width: 1280, height: 720 });

        // Navigazione
        await page.goto(targetUrl, { waitUntil: 'networkidle2', timeout: 120000 });

        // 2. NASCONDI INTERFACCIA (Pulsanti, Frecce)
        // Iniettiamo CSS per pulire la visuale PRIMA di iniziare a scattare foto
        await page.addStyleTag({
            content: `
                button, .controls, .navigation, .progress, .slide-number, 
                .header, .footer, nav, .navigate-right, .navigate-left,
                .ytp-chrome-top, .ytp-chrome-bottom
                { display: none !important; }
            `
        });

        console.log("[BOT] Starting Slide Capture Sequence...");

        const screenshots = [];
        let hasNext = true;
        let slideCount = 0;
        const MAX_SLIDES = 100; // Limite di sicurezza per evitare loop infiniti

        // Memorizziamo l'hash (es. #/1) o l'URL per capire se la slide è cambiata
        let currentHash = await page.evaluate(() => window.location.hash);

        // 3. LOOP DI CATTURA (Naviga -> Scatta -> Ripeti)
        while (hasNext && slideCount < MAX_SLIDES) {
            // Aspettiamo che le animazioni finiscano
            await new Promise(r => setTimeout(r, 1000));

            // Scatta Screenshot (in memoria, formato base64)
            const imgBuffer = await page.screenshot({ encoding: 'base64', fullPage: false });
            screenshots.push(imgBuffer);
            slideCount++;
            console.log(`Captured slide ${slideCount}`);

            // Tenta di andare alla prossima slide
            // Usiamo 'Space' che è lo standard universale per "Next Slide" (gestisce anche slide verticali)
            // Se Space non va, prova ArrowRight come fallback
            try {
                await page.focus('body'); // Assicura che la pagina abbia il focus
                await page.keyboard.press('Space');
            } catch (e) {
                await page.keyboard.press('ArrowRight');
            }

            // Attesa transizione
            await new Promise(r => setTimeout(r, 1000));

            // Controlliamo se siamo andati avanti
            const newHash = await page.evaluate(() => window.location.hash);

            // Se l'URL non cambia, siamo alla fine
            if (newHash === currentHash && slideCount > 1) {
                console.log("Navigation stopped. End of presentation reached.");
                hasNext = false;
            } else {
                currentHash = newHash;
            }
        }

        console.log(`[BUILD] Stitched ${screenshots.length} slides. Generating PDF...`);

        // 4. GENERAZIONE PDF "INCOLLATO"
        // Creiamo una nuova pagina HTML vuota e ci "incolliamo" dentro tutte le foto scattate
        // una sotto l'altra.
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

        // Carichiamo questo nuovo contenuto nella pagina
        await page.setContent(htmlContent);

        // Stampiamo il tutto
        const pdfBuffer = await page.pdf({
            printBackground: true,
            format: 'A4', // Ora usiamo A4 perché stiamo stampando immagini standard
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