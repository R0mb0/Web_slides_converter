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
    
    const start = startSlide || 0;
    const limit = batchSize || 10;
    const batchLogs = []; // Array per raccogliere i log da inviare al client

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
        
        // Rilevamento Framework
        const frameworkType = await page.evaluate(() => {
            if (window.Reveal) return 'reveal';
            if (window.remark) return 'remark';
            return 'generic';
        });

        // --- ANTI-LOOP CHECK ---
        // Se è Reveal.js, chiediamo quante slide ci sono in totale.
        // Se il client chiede la slide 100 ma ce ne sono solo 46, fermiamo tutto.
        let totalSlidesKnown = null;
        if (frameworkType === 'reveal') {
            totalSlidesKnown = await page.evaluate(() => {
                try {
                    return window.Reveal.getTotalSlides();
                } catch(e) { return null; }
            });
            
            if (totalSlidesKnown !== null) {
                console.log(`[INFO] Total slides detected: ${totalSlidesKnown}`);
                if (start >= totalSlidesKnown) {
                    // Siamo già oltre la fine, ferma il processo
                    return res.json({
                        success: true,
                        chunk: "", // Niente PDF
                        count: 0,
                        isFinished: true,
                        nextIndex: start,
                        logs: ["End of presentation reached (Index limit)."]
                    });
                }
            }
        }

        // Saltiamo alla slide di partenza
        await page.evaluate(async (type, targetIndex) => {
            if (type === 'reveal' && window.Reveal) {
                window.Reveal.slide(targetIndex);
            }
        }, frameworkType, start);

        if (frameworkType !== 'reveal' && start > 0) {
            for(let i=0; i<start; i++) {
                await page.keyboard.press('ArrowRight');
            }
        }

        // Iniezione CSS
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
            // Controllo Limite Totale (Anti-Loop)
            if (totalSlidesKnown !== null && (start + currentCount) >= totalSlidesKnown) {
                batchLogs.push(`Reached last slide (${totalSlidesKnown}). Stopping.`);
                reachedEnd = true;
                break;
            }

            await new Promise(r => setTimeout(r, 1500));

            const checkBuffer = await page.screenshot({ encoding: 'base64', fullPage: false, type: 'jpeg', quality: 40 });
            if (currentCount > 0 && checkBuffer === previousScreenshotBase64) {
                batchLogs.push("Visual check: Slide didn't change. End reached.");
                reachedEnd = true;
                break;
            }
            previousScreenshotBase64 = checkBuffer;

            const slidePdf = await page.pdf({
                width: `${VIEWPORT_WIDTH}px`,
                height: `${VIEWPORT_HEIGHT}px`,
                printBackground: true,
                pageRanges: '1'
            });
            
            pdfChunks.push(slidePdf);
            currentCount++;
            
            // Aggiungiamo il log per questa slide
            batchLogs.push(`Captured Slide #${start + currentCount}`);

            const navResult = await page.evaluate((type) => {
                if ((type === 'reveal' || window.Reveal) && window.Reveal) {
                    if (window.Reveal.isLastSlide && window.Reveal.isLastSlide()) return 'finished';
                    window.Reveal.next();
                    return 'api';
                }
                const nextBtn = document.querySelector('.navigate-right, .next, button[aria-label="Next slide"]');
                if (nextBtn) { nextBtn.click(); return 'click'; }
                return 'fallback';
            }, frameworkType);

            if (navResult === 'finished') {
                batchLogs.push("Framework reported end.");
                reachedEnd = true;
                break;
            }
            if (navResult === 'fallback') {
                try { await page.keyboard.press('ArrowRight'); } catch (e) {}
            }
        }

        console.log(`[BATCH] Captured ${pdfChunks.length} slides.`);

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
            nextIndex: start + currentCount,
            logs: batchLogs // Inviamo i log al frontend
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