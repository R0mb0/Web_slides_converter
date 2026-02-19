const express = require('express');
const cors = require('cors');
const path = require('path');
process.env.PUPPETEER_CACHE_DIR = path.join(__dirname, '.cache');

const puppeteer = require('puppeteer');
const { execSync } = require('child_process');
const { PDFDocument } = require('pdf-lib');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '50mb' }));
app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));

function ensureBrowserInstalled() {
    try {
        console.log("Checking Chrome installation...");
        execSync('npx puppeteer browsers install chrome', { stdio: 'inherit' });
    } catch (error) {
        console.error("Warning: Auto-install skipped.", error);
    }
}
ensureBrowserInstalled();

app.post('/api/convert-batch', async (req, res) => {
    const { url, startSlide, batchSize } = req.body;
    
    if (!url) return res.status(400).send('URL required');
    
    // startSlide ora rappresenta i "passi (o clic su Avanti)" totali effettuati
    const start = startSlide || 0;
    const limit = batchSize || 10;
    const batchLogs = [];

    console.log(`[BATCH] Request: Steps ${start} to ${start + limit} for ${url}`);

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
        let targetUrl = url.split('#')[0].split('?')[0]; 
        
        const VIEWPORT_WIDTH = 1280;
        const VIEWPORT_HEIGHT = 800;
        await page.setViewport({ width: VIEWPORT_WIDTH, height: VIEWPORT_HEIGHT });

        await page.goto(targetUrl, { waitUntil: 'networkidle2', timeout: 120000 });
        await page.emulateMediaType('screen');

        try { 
            await page.mouse.click(VIEWPORT_WIDTH / 2, VIEWPORT_HEIGHT / 2);
            await page.focus('body');
        } catch (e) {}

        // Attendiamo che Reveal.js sia inizializzato (utile per presentazioni pesanti come Quarto)
        await page.waitForFunction(() => window.Reveal !== undefined || document.body !== null, { timeout: 5000 }).catch(() => {});

        // --- IL VERO FIX: FAST-FORWARD ---
        // Simula la pressione del tasto avanti per ripristinare esattamente i frammenti
        if (start > 0) {
            batchLogs.push(`Restoring state: Fast-forwarding ${start} steps...`);
            await page.evaluate(async (targetSteps) => {
                for(let i=0; i < targetSteps; i++) {
                    if (window.Reveal) {
                        window.Reveal.next();
                    } else {
                        // Per presentazioni non-Reveal
                        const nextBtn = document.querySelector('.navigate-right, .next');
                        if (nextBtn) nextBtn.click();
                        else document.dispatchEvent(new KeyboardEvent('keydown', {'key': 'ArrowRight'}));
                    }
                }
            }, start);
            
            // Diamo tempo alle animazioni del fast-forward di stabilizzarsi prima di scattare le foto
            await new Promise(r => setTimeout(r, 2000));
        }

        // Iniezione CSS per nascondere controlli e barre
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

        while (currentCount < limit && hasNext) {
            await new Promise(r => setTimeout(r, 1500)); // Attesa caricamento elementi visivi

            // Cattura la pagina corrente
            const slidePdf = await page.pdf({
                width: `${VIEWPORT_WIDTH}px`,
                height: `${VIEWPORT_HEIGHT}px`,
                printBackground: true,
                pageRanges: '1'
            });
            
            pdfChunks.push(slidePdf);
            currentCount++;
            batchLogs.push(`Captured Step #${start + currentCount}`);

            // Avanzamento e Controllo Fine Presentazione (Matematico)
            const navResult = await page.evaluate(() => {
                if (window.Reveal) {
                    const before = window.Reveal.getIndices();
                    window.Reveal.next();
                    const after = window.Reveal.getIndices();

                    // Se le coordinate (h, v, f) NON sono cambiate, non c'è più nulla da mostrare.
                    if (before.h === after.h && before.v === after.v && before.f === after.f) {
                        return 'reveal_finished';
                    }
                    // Se la slide orizzontale (h) è tornata indietro a 0, la presentazione è in Loop ed è finita.
                    if (after.h < before.h && after.h === 0) {
                        return 'reveal_looped';
                    }
                    return 'continue';
                }

                // Fallback per framework sconosciuti
                const nextBtn = document.querySelector('.navigate-right, .next, button[aria-label="Next slide"]');
                if (nextBtn) { 
                    if (nextBtn.disabled || nextBtn.classList.contains('disabled')) return 'generic_finished';
                    nextBtn.click(); 
                    return 'continue'; 
                }
                
                return 'fallback';
            });

            // Gestione dei risultati del blocco evaluate
            if (navResult === 'reveal_finished' || navResult === 'generic_finished') {
                batchLogs.push("End of presentation mathematically confirmed.");
                reachedEnd = true;
                break;
            }
            if (navResult === 'reveal_looped') {
                batchLogs.push("Presentation looped back to start. Stopping.");
                reachedEnd = true;
                break;
            }

            // Check visivo di sicurezza solo per il fallback totale
            if (navResult === 'fallback') {
                try { await page.keyboard.press('ArrowRight'); } catch (e) {}
                const checkBuffer = await page.screenshot({ encoding: 'base64', type: 'jpeg', quality: 10 });
                if (currentCount > 1 && checkBuffer === previousScreenshotBase64) {
                    batchLogs.push("Visual check: Slide didn't change. End reached.");
                    reachedEnd = true;
                    break;
                }
                previousScreenshotBase64 = checkBuffer;
            }
        }

        console.log(`[BATCH] Captured ${pdfChunks.length} steps.`);

        // Unione temporanea dei chunk di questo batch
        const mergedPdf = await PDFDocument.create();
        for (const chunk of pdfChunks) {
            const doc = await PDFDocument.load(chunk);
            const copiedPages = await mergedPdf.copyPages(doc, doc.getPageIndices());
            copiedPages.forEach((page) => mergedPdf.addPage(page));
        }
        
        const batchPdfBytes = await mergedPdf.save();
        const base64Pdf = Buffer.from(batchPdfBytes).toString('base64');

        res.json({
            success: true,
            chunk: base64Pdf,
            count: pdfChunks.length,
            isFinished: reachedEnd,
            nextIndex: start + currentCount, // Salva l'esatto numero di passi completati
            logs: batchLogs
        });

    } catch (error) {
        console.error('[BATCH ERROR]', error);
        res.status(500).json({ success: false, error: error.message });
    } finally {
        if (browser) await browser.close();
    }
});

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});