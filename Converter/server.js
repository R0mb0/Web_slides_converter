const express = require('express');
const cors = require('cors');
const path = require('path');
// Richiede 'npm install pdf-lib'
const { PDFDocument } = require('pdf-lib');

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
            protocolTimeout: 180000,
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

        // Risoluzione Desktop Standard (Cruciale per i PDF vettoriali)
        const VIEWPORT_WIDTH = 1280;
        const VIEWPORT_HEIGHT = 800;
        await page.setViewport({ width: VIEWPORT_WIDTH, height: VIEWPORT_HEIGHT });

        await page.goto(targetUrl, { waitUntil: 'networkidle2', timeout: 120000 });

        // FIX FOCUS
        try {
            await page.mouse.click(VIEWPORT_WIDTH / 2, VIEWPORT_HEIGHT / 2);
            await page.focus('body');
        } catch (e) { }

        console.log("[BOT] Detecting Framework & Preparing Vector Capture...");

        const frameworkType = await page.evaluate(() => {
            if (window.Reveal) return 'reveal';
            if (window.remark) return 'remark';
            if (window.impress) return 'impress';
            if (document.querySelector('.bespoke-parent')) return 'bespoke';
            return 'generic';
        });

        // INIEZIONE CSS: Nascondiamo l'interfaccia 
        await page.addStyleTag({
            content: `
                .controls, .progress, .slide-number, .header, .footer, 
                .ytp-chrome-top, .ytp-chrome-bottom,
                .navigate-right, .navigate-left, button[aria-label="Next slide"]
                { opacity: 0 !important; }
                
                /* Forziamo la stampa come "Screen" per non rompere il layout */
                @media print {
                    body { -webkit-print-color-adjust: exact; }
                    .reveal .slides section { visibility: inherit !important; display: inherit !important; }
                }
            `
        });

        // Array per raccogliere i buffer PDF delle singole pagine
        const pdfChunks = [];

        let hasNext = true;
        let slideCount = 0;
        const MAX_SLIDES = 100;
        let previousScreenshotBase64 = "";

        while (hasNext && slideCount < MAX_SLIDES) {
            await new Promise(r => setTimeout(r, 1500));

            // 1. SCATTO DI CONTROLLO (Immagine piccola per verificare se ci siamo mossi)
            // Usiamo ancora lo screenshot SOLO per la logica di navigazione
            const checkBuffer = await page.screenshot({ encoding: 'base64', fullPage: false, type: 'jpeg', quality: 50 });

            if (slideCount > 0 && checkBuffer === previousScreenshotBase64) {
                console.log("Visual check: Slide did not change. Stopping.");
                break;
            }
            previousScreenshotBase64 = checkBuffer;

            // 2. CATTURA VETTORIALE (PDF Reale della singola slide)
            // Invece di salvare l'immagine, stampiamo la vista corrente
            const slidePdfBuffer = await page.pdf({
                width: `${VIEWPORT_WIDTH}px`,
                height: `${VIEWPORT_HEIGHT}px`,
                printBackground: true,
                pageRanges: '1' // Stampa solo la vista corrente
            });

            pdfChunks.push(slidePdfBuffer);
            slideCount++;
            console.log(`Captured Vector PDF for slide ${slideCount}`);

            // 3. NAVIGAZIONE (Stessa logica robusta di prima)
            const navResult = await page.evaluate((type) => {
                if (type === 'reveal' && window.Reveal) {
                    if (window.Reveal.isLastSlide && window.Reveal.isLastSlide()) return 'finished';
                    window.Reveal.next();
                    return 'api';
                }
                const candidates = Array.from(document.querySelectorAll('button, a, div[role="button"], .next, .navigate-right, .arrow-right'));
                const nextBtn = candidates.find(el => {
                    const text = (el.innerText || "").toLowerCase();
                    const visible = el.offsetParent !== null;
                    return visible && (text.includes('next') || text.includes('avanti') || text.includes('→') || text.includes('>'));
                });

                if (nextBtn) {
                    nextBtn.click();
                    return 'click-text-match';
                }
                return 'fallback';
            }, frameworkType);

            if (navResult === 'finished') break;

            if (navResult === 'fallback') {
                try {
                    await page.keyboard.press('ArrowRight');
                } catch (e) { }
            }

            await new Promise(r => setTimeout(r, 1000));
        }

        console.log(`[BUILD] Merging ${pdfChunks.length} vector pages...`);

        // 4. UNIONE DEI PDF (Merge)
        // Usiamo pdf-lib per unire tutte le pagine singole in un unico file
        const mergedPdf = await PDFDocument.create();

        for (const chunk of pdfChunks) {
            const doc = await PDFDocument.load(chunk);
            const copiedPages = await mergedPdf.copyPages(doc, doc.getPageIndices());
            copiedPages.forEach((page) => mergedPdf.addPage(page));
        }

        const finalPdfBytes = await mergedPdf.save();

        console.log(`[SUCCESS] Generated Selectable PDF: ${finalPdfBytes.length} bytes`);

        res.set({
            'Content-Type': 'application/pdf',
            'Content-Length': finalPdfBytes.length,
            'Content-Disposition': 'inline; filename="slides_vector.pdf"'
        });
        res.send(Buffer.from(finalPdfBytes));

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