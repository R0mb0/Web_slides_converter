const express = require('express');
const cors = require('cors');
const path = require('path');
// Importante: definiamo la cache PRIMA di richiedere puppeteer
process.env.PUPPETEER_CACHE_DIR = path.join(__dirname, '.cache');

const puppeteer = require('puppeteer');
const { execSync } = require('child_process');
const { PDFDocument } = require('pdf-lib');

const app = express();
const PORT = process.env.PORT || 3000;

// Aumentiamo il limite del body per sicurezza
app.use(express.json({ limit: '50mb' }));
app.use(cors());
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

// --- ENDPOINT UNICO: Processa un Batch (Blocco) di slide ---
// Non salviamo più stato sul server per evitare crash di memoria.
// Il client ci dice: "Dammi le slide dalla X alla Y".
app.post('/api/convert-batch', async (req, res) => {
    const { url, startSlide, batchSize } = req.body;
    
    if (!url) return res.status(400).send('URL required');
    
    // Default: parti da 0 e prendi 20 slide
    const start = startSlide || 0;
    const limit = batchSize || 20;

    console.log(`[BATCH] Request: Slides ${start} to ${start + limit} for ${url}`);

    let browser = null;

    try {
        browser = await puppeteer.launch({
            headless: 'new',
            protocolTimeout: 180000, 
            args: [
                '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
                '--disable-gpu', '--disable-extensions', '--no-first-run', '--no-zygote',
                '--disable-accelerated-2d-canvas'
            ]
        });

        const page = await browser.newPage();
        
        // Pulizia URL
        let targetUrl = url.split('#')[0].split('?')[0]; 
        
        // Risoluzione Standard
        const VIEWPORT_WIDTH = 1280;
        const VIEWPORT_HEIGHT = 800;
        await page.setViewport({ width: VIEWPORT_WIDTH, height: VIEWPORT_HEIGHT });

        // Navigazione
        await page.goto(targetUrl, { waitUntil: 'networkidle2', timeout: 120000 });
        
        // Modalità Schermo (per evitare bug di stampa Quarto)
        await page.emulateMediaType('screen');

        // Fix Focus
        try { 
            await page.mouse.click(VIEWPORT_WIDTH / 2, VIEWPORT_HEIGHT / 2);
            await page.focus('body');
        } catch (e) {}

        // 1. SALTARI ALLE SLIDE GIA' FATTE
        // Se dobbiamo partire dalla slide 50, navighiamo velocemente fino a lì
        console.log(`[BATCH] Fast-forwarding to slide ${start}...`);
        
        // Rilevamento Framework
        const frameworkType = await page.evaluate(() => {
            if (window.Reveal) return 'reveal';
            if (window.remark) return 'remark';
            return 'generic';
        });

        // Logica di salto iniziale
        await page.evaluate(async (type, targetIndex) => {
            if (type === 'reveal' && window.Reveal) {
                // Reveal.js permette di saltare direttamente
                window.Reveal.slide(targetIndex);
            } else {
                // Per altri framework, dobbiamo premere "Next" N volte velocemente
                // (Meno efficiente ma necessario per framework generici)
                // Nota: Per Reveal usiamo l'API che è istantanea
            }
        }, frameworkType, start);

        // Se non è Reveal, dobbiamo simulare i click per arrivare al punto giusto
        // (Limitato per evitare timeout, ma Reveal è il 99% dei casi)
        if (frameworkType !== 'reveal' && start > 0) {
            for(let i=0; i<start; i++) {
                await page.keyboard.press('ArrowRight');
            }
        }

        // Iniezione CSS per pulizia
        await page.addStyleTag({
            content: `
                .controls, .progress, .slide-number, .header, .footer, 
                .ytp-chrome-top, .ytp-chrome-bottom,
                .navigate-right, .navigate-left, button[aria-label="Next slide"],
                .reveal-viewport { border: none !important; box-shadow: none !important; }
                body { cursor: none !important; }
                ::-webkit-scrollbar { display: none; }
            `
        });

        const pdfChunks = [];
        let currentCount = 0;
        let hasNext = true;
        let previousScreenshotBase64 = "";
        let reachedEnd = false;

        // CATTURA DEL BATCH
        while (currentCount < limit && hasNext) {
            // Attesa stabilizzazione
            await new Promise(r => setTimeout(r, 1500));

            // Check Visivo
            const checkBuffer = await page.screenshot({ encoding: 'base64', fullPage: false, type: 'jpeg', quality: 40 });
            if (currentCount > 0 && checkBuffer === previousScreenshotBase64) {
                console.log("[BATCH] Visual check: End reached.");
                reachedEnd = true;
                break;
            }
            previousScreenshotBase64 = checkBuffer;

            // Cattura Vettoriale
            const slidePdf = await page.pdf({
                width: `${VIEWPORT_WIDTH}px`,
                height: `${VIEWPORT_HEIGHT}px`,
                printBackground: true,
                pageRanges: '1'
            });
            
            pdfChunks.push(slidePdf);
            currentCount++;

            // Navigazione
            const navResult = await page.evaluate((type) => {
                if ((type === 'reveal' || window.Reveal) && window.Reveal) {
                    if (window.Reveal.isLastSlide && window.Reveal.isLastSlide()) return 'finished';
                    window.Reveal.next();
                    return 'api';
                }
                // Fallback bottoni
                const nextBtn = document.querySelector('.navigate-right, .next, button[aria-label="Next slide"]');
                if (nextBtn) {
                    nextBtn.click();
                    return 'click';
                }
                return 'fallback';
            }, frameworkType);

            if (navResult === 'finished') {
                reachedEnd = true;
                break;
            }
            if (navResult === 'fallback') {
                try { await page.keyboard.press('ArrowRight'); } catch (e) {}
            }
        }

        console.log(`[BATCH] Captured ${pdfChunks.length} slides. Merging batch...`);

        // Uniamo questo piccolo batch in un unico PDF
        const mergedPdf = await PDFDocument.create();
        for (const chunk of pdfChunks) {
            const doc = await PDFDocument.load(chunk);
            const copiedPages = await mergedPdf.copyPages(doc, doc.getPageIndices());
            copiedPages.forEach((page) => mergedPdf.addPage(page));
        }
        
        const batchPdfBytes = await mergedPdf.save();
        const base64Pdf = Buffer.from(batchPdfBytes).toString('base64');

        // Rispondiamo al client
        res.json({
            success: true,
            chunk: base64Pdf, // Il PDF di questo blocco
            count: pdfChunks.length,
            isFinished: reachedEnd, // Dice al client se deve fermarsi o chiedere ancora
            nextIndex: start + currentCount
        });

    } catch (error) {
        console.error('[BATCH ERROR]', error);
        res.status(500).json({ success: false, error: error.message });
    } finally {
        if (browser) await browser.close();
        // Browser chiuso = RAM liberata completamente per il prossimo batch!
    }
});

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});