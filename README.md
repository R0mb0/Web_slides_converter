<div align="center">

# 🌐 Web slides converter 📚

[![Codacy Badge](https://app.codacy.com/project/badge/Grade/5205e2528e2a401eb712cce92c3e181a)](https://app.codacy.com/gh/R0mb0/Web_slides_converter/dashboard?utm_source=gh&utm_medium=referral&utm_content=&utm_campaign=Badge_grade)
[![Maintenance](https://img.shields.io/badge/Maintained%3F-yes-green.svg)](https://github.com/R0mb0/Web_slides_converter)
[![Open Source Love svg3](https://badges.frapsoft.com/os/v3/open-source.svg?v=103)](https://github.com/R0mb0/Web_slides_converter)
[![MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/license/mit)
[![Donate](https://img.shields.io/badge/PayPal-Donate%20to%20Author-blue.svg)](http://paypal.me/R0mb0)

</div>

<p align="center">
  Paste the link to any HTML presentation (Reveal.js, Quarto, Marp, Sli.dev, etc.) to generate a clean, fully-paged PDF ;). Built with Node.js, Puppeteer, and PDF-lib.
</p>

<div align="center">
  
##  [👉 Click here to test the page! 👈](https://web-slides-converter.onrender.com/)
  
[![001.png](https://github.com/R0mb0/Web_slides_converter/blob/main/Readme_imgs/001.png?raw=true)](https://web-slides-converter.onrender.com/)
[![002.png](https://github.com/R0mb0/Web_slides_converter/blob/main/Readme_imgs/002.png?raw=true)](https://web-slides-converter.onrender.com/)
[![003.png](https://github.com/R0mb0/Web_slides_converter/blob/main/Readme_imgs/003.png?raw=true)](https://web-slides-converter.onrender.com/)

</div>


## 📄 Links to test the page

- [https://urbinolloyd.github.io/Informatica-Lesson-1/](https://urbinolloyd.github.io/Informatica-Lesson-1/)
- [https://fabiogiglietto.github.io/genai-media-course/slides/week1-mon-introduction.html#/title-slide](https://fabiogiglietto.github.io/genai-media-course/slides/week1-mon-introduction.html#/title-slide)

<hr>

<h2>🚀 Features</h2>
<ul>
    <li><strong>Universal Compatibility</strong>: Works out-of-the-box with Reveal.js, Quarto, Marp, Sli.dev, and custom HTML presentations.</li>
    <li><strong>Smart Animation &amp; Fragment Detection</strong>: Captures step-by-step CSS animations and lists accurately, preserving the original reading flow.</li>
    <li><strong>Safe-Batch Technology &trade;</strong>: Processes heavy presentations in chunks. Say goodbye to server timeouts or memory crashes!</li>
    <li><strong>Manual Safety Limit</strong>: Built-in anti-loop mechanism. Set a max page limit to force completion on tricky or infinitely looping presentations.</li>
    <li><strong>High-Quality Vector Export</strong>: Preserves text crispness and formatting without relying on blurry screenshots.</li>
    <li><strong>Modern UI</strong>: Fast, responsive, and adaptive Dark/Light mode interface powered by TailwindCSS.</li>
</ul>

<h2>🛠️ How it works</h2>
<ol>
    <li><strong>Paste the URL</strong> of your web-based slide deck.</li>
    <li><strong>Set a Safety Limit</strong> (e.g., 100 slides) to prevent infinite loops.</li>
    <li>The <strong>Puppeteer Backend</strong> opens a headless Chromium browser and navigates the presentation slide by slide, triggering the 'Next' events natively.</li>
    <li>It blocks native print overrides, forcing the browser to take a vector PDF snapshot of <em>every single fragment and animation state</em>.</li>
    <li>The process runs in <strong>batches</strong>, sending chunks back to your browser to prevent serverless timeouts (e.g., on Vercel).</li>
    <li>The <strong>Frontend uses PDF-lib</strong> to merge all chunks locally into a single, cohesive PDF file ready for download.</li>
</ol>

<h2>🏆 What makes it special?</h2>
<ul>
    <li><strong>Overcomes Vercel Limits</strong>: Standard Puppeteer scripts timeout after 10-60 seconds on serverless platforms. This tool's chunking architecture allows it to process hundreds of slides flawlessly.</li>
    <li><strong>Respects Fragments</strong>: Standard "Print to PDF" features in browsers often break Quarto/Reveal.js fragments (bullet points that appear one by one), showing them all at once or not at all. This tool captures them precisely as the author intended.</li>
</ul>

<h2>💡 Why use this tool?</h2>
<ul>
    <li><strong>Offline Archiving</strong>: Convert dynamic web lectures, webinars, or conference talks into standard PDFs for offline study.</li>
    <li><strong>Printing</strong>: Easily print web presentations without messing up the CSS layouts.</li>
    <li><strong>Sharing</strong>: Share slide decks with people who don't have internet access or prefer standard document formats.</li>
</ul>

<h2>⚡ Getting Started</h2>

<h3>Online</h3>
<p>Simply visit the <a href="https://web-slides-converter.onrender.com/">Live Demo</a>.</p>

<h3>Local Installation</h3>
<p>To run this tool on your own machine (requires Node.js):</p>
<ol>
    <li><strong>Clone this repository</strong>.</li>
    <li>Install dependencies:
        <pre><code>npm install</code></pre>
    </li>
    <li>Start the server:
        <pre><code>npm start</code></pre>
    </li>
    <li>Open <code>http://localhost:3000</code> in your browser.</li>
</ol>

<h2>✨ Limitations &amp; Notes</h2>
<ul>
    <li><strong>Interactive Elements</strong>: Embedded videos (YouTube, Vimeo) or interactive 3D WebGL elements will be captured as static images at the moment the slide is reached.</li>
    <li><strong>AcroJS / PDF Animations</strong>: The output is a standard static PDF. CSS/JS animations are preserved as sequential pages, not as interactive PDF scripts, ensuring 100% compatibility across all PDF readers.</li>
</ul>

<h2>🙏 Credits &amp; Inspiration</h2>
<ul>
    <li><a href="https://pptr.dev/">Puppeteer</a> for headless browser automation.</li>
    <li><a href="https://pdf-lib.js.org/">PDF-lib</a> for client-side PDF manipulation and merging.</li>
    <li><a href="https://tailwindcss.com/">TailwindCSS</a> for the styling.</li>
</ul>
