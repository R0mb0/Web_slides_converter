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
    const { url, startSlide, batchSize, absoluteMaxSteps } = req.body;

    if (!url) return res.status(400).send('URL required');

    const start = startSlide || 0;
    const limit = batchSize || 10;
    const globalMaxLimit = absoluteMaxSteps ? parseInt(absoluteMaxSteps) : 500;

    const batchLogs = [];

    console.log(`[BATCH] Request: Steps ${start} to ${start + limit} for ${url}. Max Limit: ${globalMaxLimit}`);

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
        } catch (e) { }

        await page.waitForFunction(() => window.Reveal !== undefined || document.body !== null, { timeout: 5000 }).catch(() => { });

        // --- FAST-FORWARD MIGLIORATO ---
        if (start > 0) {
            batchLogs.push(`Restoring state: Fast-forwarding ${start} steps...`);
            await page.evaluate(async (targetSteps) => {
                for (let i = 0; i < targetSteps; i++) {
                    if (window.Reveal) {
                        window.Reveal.next();
                    } else {
                        const nextBtn = document.querySelector('.navigate-right, .next');
                        if (nextBtn) nextBtn.click();
                        else document.dispatchEvent(new KeyboardEvent('keydown', { 'key': 'ArrowRight' }));
                    }
                    // FIX: Diamo al motore Javascript della pagina il tempo di registrare il frammento
                    await new Promise(res => setTimeout(res, 50));
                }
            }, start);

            await new Promise(r => setTimeout(r, 2000));
        }

        // --- FIX CRITICO PER I FRAMMENTI/ANIMAZIONI NEI PDF ---
        await page.addStyleTag({
            content: `
                .controls, .progress, .slide-number, .header, .footer, 
                .ytp-chrome-top, .ytp-chrome-bottom,
                .navigate-right, .navigate-left, button[aria-label="Next slide"],
                .reveal-viewport { border: none !important; box-shadow: none !important; }
                body { cursor: none !important; }
                ::-webkit-scrollbar { display: none; }

                /* BLOCCO DELLA MODALITÀ STAMPA NATIVA DI REVEAL.JS */
                /* Impedisce a Chrome di mostrare tutto il testo nascosto durante la generazione del PDF */
                @media print {
                    .reveal .slides section .fragment:not(.visible) {
                        opacity: 0 !important;
                        visibility: hidden !important;
                        display: none !important;
                    }
                    .reveal .slides section .fragment.visible {
                        opacity: 1 !important;
                        visibility: visible !important;
                        display: inherit !important;
                    }
                }
            `
        });

        const pdfChunks = [];
        let currentCount = 0;
        let hasNext = true;
        let previousScreenshotBase64 = "";
        let reachedEnd = false;

        while (currentCount < limit && hasNext) {
            if ((start + currentCount) >= globalMaxLimit) {
                batchLogs.push(`Manual safety limit reached (${globalMaxLimit} steps). Stopping.`);
                reachedEnd = true;
                break;
            }

            // Aumentato leggermente il tempo per dare modo alle animazioni CSS di finire il "fade-in"
            await new Promise(r => setTimeout(r, 1800));

            const slidePdf = await page.pdf({
                width: `${VIEWPORT_WIDTH}px`,
                height: `${VIEWPORT_HEIGHT}px`,
                printBackground: true,
                pageRanges: '1'
            });

            pdfChunks.push(slidePdf);
            currentCount++;
            batchLogs.push(`Captured Step #${start + currentCount}`);

            const navResult = await page.evaluate(() => {
                if (window.Reveal) {
                    const before = window.Reveal.getIndices();
                    window.Reveal.next();
                    const after = window.Reveal.getIndices();

                    if (before.h === after.h && before.v === after.v && before.f === after.f) {
                        return 'reveal_finished';
                    }
                    if (after.h < before.h && after.h === 0) {
                        return 'reveal_looped';
                    }
                    return 'continue';
                }

                const nextBtn = document.querySelector('.navigate-right, .next, button[aria-label="Next slide"]');
                if (nextBtn) {
                    if (nextBtn.disabled || nextBtn.classList.contains('disabled')) return 'generic_finished';
                    nextBtn.click();
                    return 'continue';
                }

                return 'fallback';
            });

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

            if (navResult === 'fallback') {
                try { await page.keyboard.press('ArrowRight'); } catch (e) { }
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

        const mergedPdf = await PDFDocument.create();
        for (const chunk of pdfChunks) {
            const doc = await PDFDocument.load(chunk);
            const copiedPages = await mergedPdf.copyPages(doc, doc.getPageIndices());
            copiedPages.forEach((page) => mergedPdf.addPage(page));
        }

        let base64Pdf = "";
        if (pdfChunks.length > 0) {
            const batchPdfBytes = await mergedPdf.save();
            base64Pdf = Buffer.from(batchPdfBytes).toString('base64');
        }

        res.json({
            success: true,
            chunk: base64Pdf,
            count: pdfChunks.length,
            isFinished: reachedEnd,
            nextIndex: start + currentCount,
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