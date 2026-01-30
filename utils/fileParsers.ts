import * as pdfjsLib from 'pdfjs-dist';
import JSZip from 'jszip';

// Fix for PDF.js worker configuration
const pdfjs: any = pdfjsLib;
if (pdfjs.GlobalWorkerOptions) {
  pdfjs.GlobalWorkerOptions.workerSrc = 'https://esm.sh/pdfjs-dist@3.11.174/build/pdf.worker.min.js';
} else if (pdfjs.default && pdfjs.default.GlobalWorkerOptions) {
  pdfjs.default.GlobalWorkerOptions.workerSrc = 'https://esm.sh/pdfjs-dist@3.11.174/build/pdf.worker.min.js';
}

/**
 * Main entry point to parse supported files
 */
export async function parseFile(file: File): Promise<string> {
  const extension = file.name.split('.').pop()?.toLowerCase();

  switch (extension) {
    case 'pdf':
      return await parsePdf(file);
    case 'epub':
      return await parseEpub(file);
    case 'txt':
    case 'md':
      return await parseText(file);
    default:
      throw new Error(`Unsupported file type: .${extension}`);
  }
}

async function parseText(file: File): Promise<string> {
  return await file.text();
}

async function parsePdf(file: File): Promise<string> {
  const arrayBuffer = await file.arrayBuffer();
  const loadingTask = pdfjsLib.getDocument({ data: arrayBuffer });
  const pdf = await loadingTask.promise;
  
  let fullText = '';
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const textContent = await page.getTextContent();
    const pageText = textContent.items
      .map((item: any) => (item as any).str)
      .join(' ');
    fullText += pageText + '\n\n';
  }
  return fullText;
}

/**
 * Improved ePub parser with Fallback Strategy
 */
async function parseEpub(file: File): Promise<string> {
  const zip = await JSZip.loadAsync(file);
  let fullText = '';
  const parser = new DOMParser();

  // Strategy A: Standard OPF Parsing
  try {
    const containerXml = await zip.file("META-INF/container.xml")?.async("string");
    if (!containerXml) throw new Error("Missing container.xml");

    const containerDoc = parser.parseFromString(containerXml, "text/xml");
    const rootfiles = containerDoc.getElementsByTagName("rootfile");
    if (rootfiles.length === 0) throw new Error("No rootfile found");

    const opfPath = rootfiles[0].getAttribute("full-path");
    if (!opfPath) throw new Error("No OPF path");

    const opfContent = await zip.file(opfPath)?.async("string");
    if (!opfContent) throw new Error("Missing OPF file");

    const opfDoc = parser.parseFromString(opfContent, "text/xml");
    const manifestItems = Array.from(opfDoc.getElementsByTagName("item"));
    const manifest = new Map<string, string>();
    manifestItems.forEach(item => {
      const id = item.getAttribute("id");
      const href = item.getAttribute("href");
      if (id && href) manifest.set(id, href);
    });

    const spineItems = Array.from(opfDoc.getElementsByTagName("itemref"));
    const opfDir = opfPath.includes('/') ? opfPath.substring(0, opfPath.lastIndexOf('/') + 1) : '';

    for (const itemref of spineItems) {
      const idref = itemref.getAttribute("idref");
      if (!idref) continue;
      const href = manifest.get(idref);
      if (!href) continue;

      const cleanHref = href.startsWith('/') ? href.substring(1) : href;
      // Handle potential URL encoded chars in paths
      const fileRelPath = decodeURIComponent(opfDir + cleanHref);
      
      const file = zip.file(fileRelPath);
      if (file) {
        const content = await file.async("string");
        fullText += extractTextFromHtml(content, parser) + "\n\n";
      }
    }
  } catch (err) {
    console.warn("Standard ePub parsing failed, trying brute-force...", err);
    fullText = ""; // Reset
  }

  // Strategy B: Brute Force (if Strategy A failed or returned empty)
  if (!fullText.trim()) {
    const htmlFiles: string[] = [];
    zip.forEach((relativePath, zipEntry) => {
      if (relativePath.match(/\.(xhtml|html|htm)$/i) && !relativePath.includes('__MACOSX')) {
        htmlFiles.push(relativePath);
      }
    });

    // Sort files naturally (e.g., chapter1, chapter2, chapter10)
    htmlFiles.sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }));

    for (const path of htmlFiles) {
      const content = await zip.file(path)?.async("string");
      if (content) {
        fullText += extractTextFromHtml(content, parser) + "\n\n";
      }
    }
  }

  if (!fullText.trim()) {
    throw new Error("Could not extract text from this ePub.");
  }

  return fullText;
}

function extractTextFromHtml(htmlContent: string, parser: DOMParser): string {
  // Strip XML declaration if present to prevent parser errors
  const cleanHtml = htmlContent.replace(/^<\?xml.*?\?>/, '');
  const doc = parser.parseFromString(cleanHtml, "text/html");
  
  // Remove non-content elements
  doc.querySelectorAll('script, style, head, title, nav, footer').forEach(el => el.remove());
  
  const body = doc.body;
  if (!body) return "";

  // Replace block tags with newlines to preserve structure
  const blockTags = ['p', 'div', 'br', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'li'];
  blockTags.forEach(tag => {
    doc.querySelectorAll(tag).forEach(el => {
      el.after(doc.createTextNode('\n'));
    });
  });

  return (body.textContent || "").trim();
}