const express = require('express');
const cors = require('cors');
const path = require('path');
const crypto = require('crypto');
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

// Job Store in memoria
const jobs = new Map();

// Pulizia job vecchi
setInterval(() => {
    const now = Date.now();
    for (const [id, job] of jobs.entries()) {
        if (now - job.createdAt > 3600000) jobs.delete(id);
    }
}, 3600000);

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

function logToClient(jobId, message) {
    const job = jobs.get(jobId);
    if (!job) return;
    const timestamp = new Date().toLocaleTimeString();
    const logEntry = `[${timestamp}] ${message}`;
    job.logs.push(logEntry);
    console.log(`[Job ${jobId}] ${message}`);
    if (job.clients) {
        job.clients.forEach(res => {
            res.write(`data: ${JSON.stringify({ type: 'log', message: logEntry })}\n\n`);
        });
    }
}

function finishJob(jobId, pdfBuffer) {
    const job = jobs.get(jobId);
    if (!job) return;
    job.status = 'completed';
    job.result = pdfBuffer;
    if (job.clients) {
        job.clients.forEach(res => {
            res.write(`data: ${JSON.stringify({ type: 'done', jobId: jobId })}\n\n`);
            res.end();
        });
    }
}

function failJob(jobId, errorMsg) {
    const job = jobs.get(jobId);
    if (!job) return;
    job.status = 'error';
    job.error = errorMsg;
    if (job.clients) {
        job.clients.forEach(res => {
            res.write(`data: ${JSON.stringify({ type: 'error', message: errorMsg })}\n\n`);
            res.end();
        });
    }
}

app.post('/api/start', (req, res) => {
    const { url } = req.body;
    if (!url) return res.status(400).send('URL is required');
    const jobId = crypto.randomUUID();
    jobs.set(jobId, {
        id: jobId, url: url, status: 'pending', logs: [], clients: [], result: null, createdAt: Date.now()
    });
    res.json({ jobId });
    runConversionProcess(jobId, url);
});

app.get('/api/stream/:jobId', (req, res) => {
    const { jobId } = req.params;
    const job = jobs.get(jobId);
    if (!job) return res.status(404).send('Job not found');

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    job.clients.push(res);

    job.logs.forEach(log => {
        res.write(`data: ${JSON.stringify({ type: 'log', message: log })}\n\n`);
    });

    if (job.status === 'completed') {
        res.write(`data: ${JSON.stringify({ type: 'done', jobId: jobId })}\n\n`);
        res.end();
    } else if (job.status === 'error') {
        res.write(`data: ${JSON.stringify({ type: 'error', message: job.error })}\n\n`);
        res.end();
    }

    req.on('close', () => {
        job.clients = job.clients.filter(client => client !== res);
    });
});

app.get('/api/download/:jobId', (req, res) => {
    const { jobId } = req.params;
    const job = jobs.get(jobId);
    if (!job || !job.result) return res.status(404).send('File not found');
    res.set({
        'Content-Type': 'application/pdf',
        'Content-Length': job.result.length,
        'Content-Disposition': 'attachment; filename="slides_vector.pdf"'
    });
    res.send(job.result);
});

// --- MOTORE DI CONVERSIONE AGGIORNATO ---
async function runConversionProcess(jobId, url) {
    let browser = null;
    logToClient(jobId, `Starting conversion for: ${url}`);

    try {
        logToClient(jobId, "Launching Chrome...");
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

        // Pulisce l'URL
        let targetUrl = url.split('#')[0].split('?')[0];
        logToClient(jobId, `Navigating to: ${targetUrl}`);

        const VIEWPORT_WIDTH = 1280;
        const VIEWPORT_HEIGHT = 800;
        await page.setViewport({ width: VIEWPORT_WIDTH, height: VIEWPORT_HEIGHT });

        await page.goto(targetUrl, { waitUntil: 'networkidle2', timeout: 120000 });

        logToClient(jobId, "Page loaded. Configuring environment...");

        // Forza modalità schermo per evitare layout di stampa rotti
        await page.emulateMediaType('screen');

        // Fix Focus
        try {
            await page.mouse.click(VIEWPORT_WIDTH / 2, VIEWPORT_HEIGHT / 2);
            await page.focus('body');
        } catch (e) { }

        logToClient(jobId, "Detecting Framework...");

        const frameworkType = await page.evaluate(() => {
            if (window.Reveal) return 'reveal';
            if (window.remark) return 'remark';
            if (window.impress) return 'impress';
            if (document.querySelector('.bespoke-parent')) return 'bespoke';
            return 'generic';
        });

        logToClient(jobId, `Framework detected: ${frameworkType.toUpperCase()}`);

        // --- FIX SPECIALE PER REVEAL.JS (Lesson3 fix) ---
        // Disabilitiamo i frammenti per evitare di bloccarci su animazioni intermedie
        if (frameworkType === 'reveal') {
            logToClient(jobId, "Applying Reveal.js optimizations (Disabling fragments)...");
            await page.evaluate(() => {
                if (window.Reveal) {
                    // Configura Reveal per mostrare tutto subito
                    window.Reveal.configure({ fragments: false, overview: false, center: true });
                }
            });
        }

        // CSS Injection
        await page.addStyleTag({
            content: `
                .controls, .progress, .slide-number, .header, .footer, 
                .ytp-chrome-top, .ytp-chrome-bottom,
                .navigate-right, .navigate-left, button[aria-label="Next slide"],
                .reveal-viewport { border: none !important; box-shadow: none !important; }
                /* Nascondi cursori e barre */
                body { cursor: none !important; }
                ::-webkit-scrollbar { display: none; }
            `
        });

        const pdfChunks = [];
        let hasNext = true;
        let slideCount = 0;
        const MAX_SLIDES = 200; // Aumentato limite slide
        let previousScreenshotBase64 = "";

        logToClient(jobId, "Starting Vector Capture...");

        while (hasNext && slideCount < MAX_SLIDES) {
            // Attesa ridotta a 1s perché senza frammenti è più veloce
            await new Promise(r => setTimeout(r, 1000));

            // Scatto di controllo
            const checkBuffer = await page.screenshot({ encoding: 'base64', fullPage: false, type: 'jpeg', quality: 40 });

            if (slideCount > 0 && checkBuffer === previousScreenshotBase64) {
                logToClient(jobId, "Visual check: Slide unchanged. End reached.");
                break;
            }
            previousScreenshotBase64 = checkBuffer;

            // Cattura PDF Vettoriale (con timeout di sicurezza)
            try {
                const slidePdfBuffer = await page.pdf({
                    width: `${VIEWPORT_WIDTH}px`,
                    height: `${VIEWPORT_HEIGHT}px`,
                    printBackground: true,
                    pageRanges: '1',
                    timeout: 30000 // Se una slide ci mette più di 30s a generarsi, fallisce solo lei
                });
                pdfChunks.push(slidePdfBuffer);
                slideCount++;

                // Logga ogni singola slide per feedback continuo
                logToClient(jobId, `Captured Slide #${slideCount}`);

            } catch (pdfError) {
                logToClient(jobId, `Warning: Failed to capture slide #${slideCount + 1}, skipping...`);
            }

            // Navigazione
            const navResult = await page.evaluate((type) => {
                if ((type === 'reveal' || window.Reveal) && window.Reveal) {
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

            if (navResult === 'finished') {
                logToClient(jobId, "Framework reported end of slides.");
                break;
            }

            if (navResult === 'fallback') {
                try {
                    await page.keyboard.press('ArrowRight');
                } catch (e) { }
            }
        }

        logToClient(jobId, `Merging ${pdfChunks.length} pages...`);

        const mergedPdf = await PDFDocument.create();
        for (const chunk of pdfChunks) {
            const doc = await PDFDocument.load(chunk);
            const copiedPages = await mergedPdf.copyPages(doc, doc.getPageIndices());
            copiedPages.forEach((page) => mergedPdf.addPage(page));
        }

        const finalPdfBytes = await mergedPdf.save();

        logToClient(jobId, "Success! Sending PDF...");
        finishJob(jobId, Buffer.from(finalPdfBytes));

    } catch (error) {
        console.error('[ERROR]', error);
        logToClient(jobId, `ERROR: ${error.message}`);
        failJob(jobId, error.message);
    } finally {
        if (browser) await browser.close();
    }
}

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});