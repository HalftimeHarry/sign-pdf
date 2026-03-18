import { PDFDocument, rgb } from 'pdf-lib';

export interface SignatureItem {
	pageIndex: number;
	// position as fraction of PDF page (0–1)
	x: number;
	y: number;
	width: number;
	height: number;
	dataUrl: string;
}

export interface TextItem {
	pageIndex: number;
	// position as fraction of PDF page (0–1)
	x: number;
	y: number;
	text: string;
	fontSize: number;
}

/**
 * Embeds signature images and free-form text into a PDF.
 * Coordinates are fractions of each page's dimensions (0–1).
 */
export async function signPdf(
	pdfBytes: ArrayBuffer,
	signatures: SignatureItem[],
	texts: TextItem[]
): Promise<Uint8Array> {
	const pdfDoc = await PDFDocument.load(pdfBytes);
	const pages = pdfDoc.getPages();

	for (const sig of signatures) {
		const page = pages[sig.pageIndex];
		if (!page) continue;
		const { width: pw, height: ph } = page.getSize();

		const base64 = sig.dataUrl.split(',')[1];
		const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
		const img = await pdfDoc.embedPng(bytes);

		const w = sig.width * pw;
		const h = sig.height * ph;
		// pdf-lib origin is bottom-left; overlay coords are top-left
		const x = sig.x * pw;
		const y = ph - sig.y * ph - h;

		page.drawImage(img, { x, y, width: w, height: h });
	}

	for (const t of texts) {
		if (!t.text.trim()) continue;
		const page = pages[t.pageIndex];
		if (!page) continue;
		const { width: pw, height: ph } = page.getSize();

		const x = t.x * pw;
		// pdf-lib draws text from the baseline (bottom of most letters).
		// The overlay positions the box by its top-left corner.
		// Offset down by the font ascent (~0.8 of size) to align baseline
		// with where the top of the text box sits on screen.
		const y = ph - t.y * ph - t.fontSize * 0.8;
		page.drawText(t.text, { x, y, size: t.fontSize, color: rgb(0, 0, 0) });
	}

	return pdfDoc.save();
}

export function downloadPdf(bytes: Uint8Array, filename: string): void {
	const blob = new Blob([bytes.buffer as ArrayBuffer], { type: 'application/pdf' });
	const url = URL.createObjectURL(blob);
	const a = document.createElement('a');
	a.href = url;
	a.download = filename;
	a.click();
	URL.revokeObjectURL(url);
}
