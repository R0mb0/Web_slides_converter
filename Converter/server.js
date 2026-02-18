const express = require('express');
const cors = require('cors');
const path = require('path');
const crypto = require('crypto'); // Per generare ID univoci per ogni conversione
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

// --- JOB STORE IN MEMORIA ---
// Qui salviamo temporaneamente lo stato delle conversioni
const jobs = new Map();

// Pulisce i job vecchi ogni ora per liberare memoria
setInterval(() => {
    const now = Date.now();
    for (const [id, job] of jobs.entries()) {
        if (now - job.createdAt > 3600000) { // 1 ora
            jobs.delete(id);
        }
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

// Funzione Helper per inviare Log ai client connessi
function logToClient(jobId, message) {
    const job = jobs.get(jobId);
    if (!job) return;

    // Aggiungi alla storia dei log
    const timestamp = new Date().toLocaleTimeString();
    const logEntry = `[${timestamp}] ${message}`;
    job.logs.push(logEntry);
    console.log(`[Job ${jobId}] ${message}`);

    // Invia a tutti i client in ascolto (SSE)
    if (job.clients) {
        job.clients.forEach(res => {
            res.write(`data: ${JSON.stringify({ type: 'log', message: logEntry })}\n\n`);
        });
    }
}

// Funzione Helper per notificare il completamento
function finishJob(jobId, pdfBuffer) {
    const job = jobs.get(jobId);
    if (!job) return;

    job.status = 'completed';
    job.result = pdfBuffer;

    if (job.clients) {
        job.clients.forEach(res => {
            res.write(`data: ${JSON.stringify({ type: 'done', jobId: jobId })}\n\n`);
            res.end(); // Chiude la connessione
        });
    }
}

// Funzione Helper per notificare errore
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

// --- ENDPOINT 1: Inizia il lavoro (Start) ---
app.post('/api/start', (req, res) => {
    const { url } = req.body;
    if (!url) return res.status(400).send('URL is required');

    const jobId = crypto.randomUUID();

    // Inizializza il job
    jobs.set(jobId, {
        id: jobId,
        url: url,
        status: 'pending',
        logs: [],
        clients: [], // Qui salveremo le connessioni SSE
        result: null,
        createdAt: Date.now()
    });

    // Risponde subito con l'ID, non aspetta la fine
    res.json({ jobId });

    // Fa partire il processo in background
    runConversionProcess(jobId, url);
});

// --- ENDPOINT 2: Stream degli eventi (Logs) ---
app.get('/api/stream/:jobId', (req, res) => {
    const { jobId } = req.params;
    const job = jobs.get(jobId);

    if (!job) return res.status(404).send('Job not found');

    // Setup Server-Sent Events (SSE)
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    // Aggiungi questo client alla lista degli ascoltatori
    job.clients.push(res);

    // Invia subito i log passati (per chi si connette dopo o riconnette)
    job.logs.forEach(log => {
        res.write(`data: ${JSON.stringify({ type: 'log', message: log })}\n\n`);
    });

    // Se il job è già finito/fallito prima che il client si connettesse
    if (job.status === 'completed') {
        res.write(`data: ${JSON.stringify({ type: 'done', jobId: jobId })}\n\n`);
        res.end();
    } else if (job.status === 'error') {
        res.write(`data: ${JSON.stringify({ type: 'error', message: job.error })}\n\n`);
        res.end();
    }

    // Rimuovi client quando si disconnette
    req.on('close', () => {
        job.clients = job.clients.filter(client => client !== res);
    });
});

// --- ENDPOINT 3: Scarica il PDF finale ---
app.get('/api/download/:jobId', (req, res) => {
    const { jobId } = req.params;
    const job = jobs.get(jobId);

    if (!job || !job.result) {
        return res.status(404).send('File not found or processing not finished');
    }

    res.set({
        'Content-Type': 'application/pdf',
        'Content-Length': job.result.length,
        'Content-Disposition': 'attachment; filename="slides_vector.pdf"'
    });
    res.send(job.result);
});


// --- MOTORE DI CONVERSIONE (Processo Background) ---
async function runConversionProcess(jobId, url) {
    let browser = null;
    logToClient(jobId, `Starting conversion process for: ${url}`);

    try {
        logToClient(jobId, "Launching Headless Chrome...");
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
        let targetUrl = url.split('#')[0].split('?')[0];

        logToClient(jobId, `Navigating to: ${targetUrl}`);

        const VIEWPORT_WIDTH = 1280;
        const VIEWPORT_HEIGHT = 800;
        await page.setViewport({ width: VIEWPORT_WIDTH, height: VIEWPORT_HEIGHT });

        await page.goto(targetUrl, { waitUntil: 'networkidle2', timeout: 120000 });
        logToClient(jobId, "Page loaded. Initializing setup...");

        await page.emulateMediaType('screen');

        try {
            await page.mouse.click(VIEWPORT_WIDTH / 2, VIEWPORT_HEIGHT / 2);
            await page.focus('body');
        } catch (e) { }

        logToClient(jobId, "Detecting Presentation Framework...");

        const frameworkType = await page.evaluate(() => {
            if (window.Reveal) return 'reveal';
            if (window.remark) return 'remark';
            if (window.impress) return 'impress';
            if (document.querySelector('.bespoke-parent')) return 'bespoke';
            return 'generic';
        });

        logToClient(jobId, `Framework detected: ${frameworkType.toUpperCase()}`);

        await page.addStyleTag({
            content: `
                .controls, .progress, .slide-number, .header, .footer, 
                .ytp-chrome-top, .ytp-chrome-bottom,
                .navigate-right, .navigate-left, button[aria-label="Next slide"],
                .reveal-viewport { border: none !important; box-shadow: none !important; }
            `
        });

        const pdfChunks = [];
        let hasNext = true;
        let slideCount = 0;
        const MAX_SLIDES = 150;
        let previousScreenshotBase64 = "";

        logToClient(jobId, "Starting slide capture sequence...");

        while (hasNext && slideCount < MAX_SLIDES) {
            await new Promise(r => setTimeout(r, 1500));

            const checkBuffer = await page.screenshot({ encoding: 'base64', fullPage: false, type: 'jpeg', quality: 50 });

            if (slideCount > 0 && checkBuffer === previousScreenshotBase64) {
                logToClient(jobId, "Visual check: Slide did not change. End of presentation reached.");
                break;
            }
            previousScreenshotBase64 = checkBuffer;

            // Cattura PDF
            const slidePdfBuffer = await page.pdf({
                width: `${VIEWPORT_WIDTH}px`,
                height: `${VIEWPORT_HEIGHT}px`,
                printBackground: true,
                pageRanges: '1'
            });

            pdfChunks.push(slidePdfBuffer);
            slideCount++;

            // Logghiamo solo ogni tanto per non intasare, o ogni slide se preferisci
            logToClient(jobId, `Captured Slide #${slideCount}`);

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
                logToClient(jobId, "Framework API reported end of slides.");
                break;
            }

            if (navResult === 'fallback') {
                try {
                    await page.keyboard.press('ArrowRight');
                } catch (e) { }
            }

            await new Promise(r => setTimeout(r, 1000));
        }

        logToClient(jobId, `Merging ${pdfChunks.length} vector pages into final PDF...`);

        const mergedPdf = await PDFDocument.create();
        for (const chunk of pdfChunks) {
            const doc = await PDFDocument.load(chunk);
            const copiedPages = await mergedPdf.copyPages(doc, doc.getPageIndices());
            copiedPages.forEach((page) => mergedPdf.addPage(page));
        }

        const finalPdfBytes = await mergedPdf.save();

        logToClient(jobId, "PDF Generation Complete! Sending file...");
        finishJob(jobId, Buffer.from(finalPdfBytes));

    } catch (error) {
        console.error('[ERROR]', error);
        logToClient(jobId, `CRITICAL ERROR: ${error.message}`);
        failJob(jobId, error.message);
    } finally {
        if (browser) await browser.close();
    }
}

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});