<script lang="ts">
	import SignaturePad from 'signature_pad';
	import { signPdf, downloadPdf } from '$lib/signer';
	import type { SignatureItem, TextItem } from '$lib/signer';

	// ── Step state ────────────────────────────────────────────────────────────
	let step: 'upload' | 'sign' | 'edit' | 'done' = $state('upload');
	let error: string | null = $state(null);
	let isSaving = $state(false);

	// ── PDF ───────────────────────────────────────────────────────────────────
	let pdfFile: File | null = $state(null);
	let pdfBytes: ArrayBuffer | null = $state(null);

	// ── Signature draw ────────────────────────────────────────────────────────
	// Two sub-steps: draw full signature, then draw initials
	let signSubStep: 'full' | 'initials' = $state('full');
	let sigPad: SignaturePad | null = null;
	let signatureDataUrl: string | null = $state(null);
	let initialsDataUrl: string | null = $state(null);

	function signaturePadAction(node: HTMLCanvasElement) {
		function init() {
			sigPad?.off();
			const ratio = window.devicePixelRatio || 1;
			node.width = node.offsetWidth * ratio;
			node.height = node.offsetHeight * ratio;
			node.getContext('2d')?.scale(ratio, ratio);
			sigPad = new SignaturePad(node, { penColor: '#1a1a2e', backgroundColor: 'rgba(0,0,0,0)' });
		}
		const raf = requestAnimationFrame(init);
		return { destroy() { cancelAnimationFrame(raf); sigPad?.off(); } };
	}

	function confirmSignature() {
		if (!sigPad || sigPad.isEmpty()) { error = 'Please draw your signature first.'; return; }
		error = null;
		if (signSubStep === 'full') {
			signatureDataUrl = sigPad.toDataURL('image/png');
			signSubStep = 'initials';
			// pad will re-mount via {#key} below — clear handled by action
		} else {
			initialsDataUrl = sigPad.toDataURL('image/png');
			step = 'edit';
		}
	}

	function skipInitials() {
		initialsDataUrl = null;
		step = 'edit';
	}

	// ── PDF page state ────────────────────────────────────────────────────────
	let currentPage = $state(1);   // 1-based for display
	let totalPages = $state(1);
	let canvasW = $state(0);
	let canvasH = $state(0);
	let isRendering = $state(false);

	// Must be $state so $effect re-runs when it resolves from null
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	let pdfDoc: any = $state(null);

	async function loadPdfDoc() {
		if (!pdfBytes) return;
		const pdfjsLib = await import('pdfjs-dist');
		pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
			'pdfjs-dist/build/pdf.worker.mjs',
			import.meta.url
		).href;
		pdfDoc = await pdfjsLib.getDocument({ data: pdfBytes.slice(0) }).promise;
		totalPages = pdfDoc.numPages;
	}

	async function renderPage(node: HTMLCanvasElement, pageNum: number) {
		if (!pdfDoc) return;
		isRendering = true;
		try {
			const page = await pdfDoc.getPage(pageNum);
			// Render at device pixel ratio for crisp text, but keep CSS size = PDF points
			const ratio = window.devicePixelRatio || 1;
			const viewport = page.getViewport({ scale: ratio });

			node.width = viewport.width;
			node.height = viewport.height;
			// CSS size stays at 1-to-1 PDF points so the document looks natural
			node.style.width = `${viewport.width / ratio}px`;
			node.style.height = `${viewport.height / ratio}px`;
			canvasW = viewport.width / ratio;
			canvasH = viewport.height / ratio;

			const ctx = node.getContext('2d')!;
			ctx.clearRect(0, 0, node.width, node.height);
			await page.render({ canvas: node, viewport }).promise;
		} finally {
			isRendering = false;
		}
	}

	// The canvas element — set by the action, read by the top-level $effect
	let pdfCanvasNode: HTMLCanvasElement | null = $state(null);

	// Action: captures the node and loads the doc — both are $state so $effect reacts
	function pdfCanvasAction(node: HTMLCanvasElement) {
		pdfCanvasNode = node;
		loadPdfDoc(); // sets pdfDoc ($state) when done, which triggers $effect below
		return {
			destroy() { pdfCanvasNode = null; }
		};
	}

	// Renders whenever the canvas node, the loaded doc, or the current page changes.
	// All three are $state so Svelte tracks them as dependencies automatically.
	$effect(() => {
		if (pdfCanvasNode && pdfDoc && currentPage) {
			renderPage(pdfCanvasNode, currentPage);
		}
	});

	function goToPage(n: number) {
		if (n < 1 || n > totalPages || isRendering) return;
		currentPage = n;
	}

	// ── Overlay items (each carries its pageIndex) ────────────────────────────
	interface SigOverlay { id: number; type: 'full' | 'initials'; pageIndex: number; x: number; y: number; w: number; h: number; }
	interface TextOverlay { id: number; pageIndex: number; x: number; y: number; text: string; editing: boolean; }

	let sigItems: SigOverlay[] = $state([]);
	let textItems: TextOverlay[] = $state([]);
	let nextId = 0;

	// Only show items for the current page
	let visibleSigs = $derived(sigItems.filter(s => s.pageIndex === currentPage - 1));
	let visibleTexts = $derived(textItems.filter(t => t.pageIndex === currentPage - 1));

	function addSignature(type: 'full' | 'initials') {
		const dataUrl = type === 'full' ? signatureDataUrl : initialsDataUrl;
		if (!dataUrl) return;
		// Initials are smaller by default
		const w = type === 'full' ? canvasW * 0.28 : canvasW * 0.10;
		const h = type === 'full' ? canvasH * 0.08 : canvasH * 0.06;
		sigItems = [...sigItems, {
			id: nextId++,
			type,
			pageIndex: currentPage - 1,
			x: canvasW * 0.55, y: canvasH * 0.75,
			w, h
		}];
	}

	function removeSig(id: number) { sigItems = sigItems.filter(s => s.id !== id); }

	function handleCanvasClick(e: MouseEvent) {
		if ((e.target as HTMLElement).closest('.overlay-item')) return;
		const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
		const x = e.clientX - rect.left;
		const y = e.clientY - rect.top;
		const id = nextId++;
		textItems = [...textItems, { id, pageIndex: currentPage - 1, x, y, text: '', editing: true }];
		setTimeout(() => {
			(document.getElementById(`ti-${id}`) as HTMLInputElement | null)?.focus();
		}, 30);
	}

	function removeText(id: number) { textItems = textItems.filter(t => t.id !== id); }

	function blurText(id: number) {
		textItems = textItems
			.map(t => t.id === id ? { ...t, editing: false } : t)
			.filter(t => t.id === id ? t.text.trim() !== '' : true);
	}

	function focusText(id: number) {
		textItems = textItems.map(t => t.id === id ? { ...t, editing: true } : t);
		setTimeout(() => {
			(document.getElementById(`ti-${id}`) as HTMLInputElement | null)?.focus();
		}, 30);
	}

	// ── Drag action ───────────────────────────────────────────────────────────
	type DragParams = { getPos: () => { x: number; y: number }; setPos: (x: number, y: number) => void };

	function draggable(node: HTMLElement, params: DragParams) {
		let startMX = 0, startMY = 0, startX = 0, startY = 0;
		function down(e: MouseEvent) {
			if ((e.target as HTMLElement).closest('input,button,textarea,.resize-handle,.text-display')) return;
			e.preventDefault();
			const p = params.getPos();
			startMX = e.clientX; startMY = e.clientY;
			startX = p.x; startY = p.y;
			window.addEventListener('mousemove', move);
			window.addEventListener('mouseup', up);
		}
		function move(e: MouseEvent) { params.setPos(startX + e.clientX - startMX, startY + e.clientY - startMY); }
		function up() { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); }
		node.addEventListener('mousedown', down);
		return {
			update(p: DragParams) { params = p; },
			destroy() { node.removeEventListener('mousedown', down); }
		};
	}

	// ── Resize action ─────────────────────────────────────────────────────────
	type ResizeParams = { getSig: () => SigOverlay; setSig: (p: Partial<SigOverlay>) => void };

	function resizable(node: HTMLElement, params: ResizeParams) {
		function down(e: MouseEvent) {
			e.preventDefault(); e.stopPropagation();
			const startX = e.clientX, startY = e.clientY;
			const { w, h } = params.getSig();
			function move(e: MouseEvent) {
				params.setSig({ w: Math.max(40, w + e.clientX - startX), h: Math.max(20, h + e.clientY - startY) });
			}
			function up() { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); }
			window.addEventListener('mousemove', move);
			window.addEventListener('mouseup', up);
		}
		node.addEventListener('mousedown', down);
		return {
			update(p: ResizeParams) { params = p; },
			destroy() { node.removeEventListener('mousedown', down); }
		};
	}

	// ── Save ──────────────────────────────────────────────────────────────────
	async function handleSave() {
		if (!pdfBytes) return;
		isSaving = true; error = null;
		try {
			const signatures: SignatureItem[] = sigItems.map(s => ({
				pageIndex: s.pageIndex,
				dataUrl: s.type === 'full' ? signatureDataUrl! : initialsDataUrl!,
				x: s.x / canvasW, y: s.y / canvasH,
				width: s.w / canvasW, height: s.h / canvasH
			}));
			const texts: TextItem[] = textItems
				.filter(t => t.text.trim())
				.map(t => ({
					pageIndex: t.pageIndex,
					x: t.x / canvasW, y: t.y / canvasH,
					text: t.text, fontSize: 12
				}));

			const signed = await signPdf(pdfBytes, signatures, texts);
			const base = pdfFile?.name.replace(/\.pdf$/i, '') ?? 'document';
			downloadPdf(signed, `${base}-signed.pdf`);
			step = 'done';
		} catch (e) {
			error = `Failed: ${e instanceof Error ? e.message : String(e)}`;
		} finally {
			isSaving = false;
		}
	}

	function reset() {
		pdfFile = null; pdfBytes = null;
		signatureDataUrl = null; initialsDataUrl = null;
		sigItems = []; textItems = []; sigPad?.clear();
		pdfDoc = null; currentPage = 1; totalPages = 1;
		signSubStep = 'full';
		step = 'upload'; error = null;
	}

	// ── PDF upload ────────────────────────────────────────────────────────────
	async function loadPdf(file: File) {
		pdfFile = file;
		pdfBytes = await file.arrayBuffer();
		step = 'sign';
	}
	function handlePdfInput(e: Event) {
		const f = (e.target as HTMLInputElement).files?.[0];
		if (f) loadPdf(f);
	}
	function handleDrop(e: DragEvent) {
		e.preventDefault();
		const f = e.dataTransfer?.files[0];
		if (f?.type === 'application/pdf') loadPdf(f);
	}

	// Annotation counts per page for the page nav badges
	function annotationsOnPage(pageIndex: number) {
		return sigItems.filter(s => s.pageIndex === pageIndex).length
			+ textItems.filter(t => t.pageIndex === pageIndex).length;
	}
</script>

<main>
	<header>
		<h1>Sign PDF</h1>
		<p class="subtitle">Draw · Place · Type · Download</p>
	</header>

	{#if error}
		<div class="error">{error}</div>
	{/if}

	<!-- Step 1: Upload -->
	{#if step === 'upload'}
		<section class="card upload-zone" aria-label="PDF upload"
			ondragover={(e) => e.preventDefault()} ondrop={handleDrop}>
			<div class="upload-icon">📄</div>
			<p>Drag & drop a PDF here, or</p>
			<label class="btn btn-primary">
				Choose PDF
				<input type="file" accept="application/pdf" onchange={handlePdfInput} hidden />
			</label>
		</section>

	<!-- Step 2: Draw signature + initials -->
	{:else if step === 'sign'}
		<section class="card">
			<div class="sign-progress">
				<div class="sign-progress-step" class:active={signSubStep === 'full'} class:done={signatureDataUrl !== null}>
					<span class="step-badge">{signatureDataUrl ? '✓' : '1'}</span>
					Full signature
				</div>
				<div class="sign-progress-divider"></div>
				<div class="sign-progress-step" class:active={signSubStep === 'initials'}>
					<span class="step-badge">2</span>
					Initials
				</div>
			</div>

			{#if signSubStep === 'full'}
				<h2>Draw your full signature</h2>
				<p class="hint">Sign as you would on a legal document</p>
			{:else}
				<h2>Draw your initials</h2>
				<p class="hint">Short form used for initialling individual pages</p>
			{/if}

			{#key signSubStep}
				<div class="canvas-wrapper">
					<canvas use:signaturePadAction></canvas>
				</div>
			{/key}

			<div class="actions">
				<button class="btn btn-ghost" onclick={() => sigPad?.clear()}>Clear</button>
				{#if signSubStep === 'initials'}
					<button class="btn btn-ghost" onclick={skipInitials}>Skip initials</button>
				{/if}
				<button class="btn btn-primary" onclick={confirmSignature}>
					{signSubStep === 'full' ? 'Next: Draw initials →' : 'Next: Edit document →'}
				</button>
			</div>
		</section>

	<!-- Step 3: Overlay editor -->
	{:else if step === 'edit'}
		<section class="card editor-card">

			<!-- Toolbar -->
			<div class="editor-toolbar">
				<div class="toolbar-left">
					<button class="btn btn-outline" onclick={() => addSignature('full')}>+ Signature</button>
					{#if initialsDataUrl}
						<button class="btn btn-outline" onclick={() => addSignature('initials')}>+ Initials</button>
					{/if}
					<span class="hint-inline">Click document to add text</span>
				</div>
				<button class="btn btn-primary" onclick={handleSave} disabled={isSaving}>
					{isSaving ? 'Saving…' : '⬇ Download signed PDF'}
				</button>
			</div>

			<!-- Page navigation -->
			{#if totalPages > 1}
				<div class="page-nav">
					<button class="page-btn" onclick={() => goToPage(currentPage - 1)} disabled={currentPage === 1 || isRendering}>
						‹ Prev
					</button>
					<div class="page-pills">
						{#each Array.from({ length: totalPages }, (_, i) => i + 1) as p}
							<button
								class="page-pill"
								class:active={p === currentPage}
								onclick={() => goToPage(p)}
								disabled={isRendering}
							>
								{p}
								{#if annotationsOnPage(p - 1) > 0}
									<span class="page-dot"></span>
								{/if}
							</button>
						{/each}
					</div>
					<button class="page-btn" onclick={() => goToPage(currentPage + 1)} disabled={currentPage === totalPages || isRendering}>
						Next ›
					</button>
				</div>
			{/if}

			<!-- PDF canvas + overlays -->
			<div class="editor-wrap">
				<div
					class="pdf-stage"
					role="presentation"
					onclick={handleCanvasClick}
					style="width:{canvasW || '100%'}; height:{canvasH ? canvasH + 'px' : 'auto'};"
				>
					{#if isRendering}
						<div class="render-overlay">Rendering page {currentPage}…</div>
					{/if}

					<canvas use:pdfCanvasAction class="pdf-canvas"></canvas>

					<!-- Signature overlays for current page -->
					{#each visibleSigs as sig (sig.id)}
						<div
							class="overlay-item sig-item"
							style="left:{sig.x}px; top:{sig.y}px; width:{sig.w}px; height:{sig.h}px;"
							use:draggable={{
								getPos: () => ({ x: sig.x, y: sig.y }),
								setPos: (x, y) => { sigItems = sigItems.map(s => s.id === sig.id ? { ...s, x, y } : s); }
							}}
						>
							<img src={sig.type === 'full' ? signatureDataUrl : initialsDataUrl} alt={sig.type} draggable="false" />
							<button class="item-delete" onclick={() => removeSig(sig.id)} title="Remove">×</button>
							<div
								class="resize-handle"
								use:resizable={{
									getSig: () => sigItems.find(s => s.id === sig.id)!,
									setSig: (patch) => { sigItems = sigItems.map(s => s.id === sig.id ? { ...s, ...patch } : s); }
								}}
							></div>
						</div>
					{/each}

					<!-- Text overlays for current page -->
					{#each visibleTexts as t (t.id)}
						<div
							class="overlay-item text-item"
							class:editing={t.editing}
							style="left:{t.x}px; top:{t.y}px;"
						>
							<!-- Drag handle — only this bar initiates drag -->
							<div
								class="text-drag-handle"
								use:draggable={{
									getPos: () => ({ x: t.x, y: t.y }),
									setPos: (x, y) => { textItems = textItems.map(i => i.id === t.id ? { ...i, x, y } : i); }
								}}
							>⠿</div>

							{#if t.editing}
								<input
									id="ti-{t.id}"
									type="text"
									bind:value={t.text}
									onblur={() => blurText(t.id)}
									onkeydown={(e) => { if (e.key === 'Enter' || e.key === 'Escape') blurText(t.id); }}
									placeholder="Type here…"
								/>
							{:else}
								<span
									class="text-display"
									role="button"
									tabindex="0"
									ondblclick={(e) => { e.stopPropagation(); focusText(t.id); }}
									onkeydown={(e) => { if (e.key === 'Enter') focusText(t.id); }}
								>{t.text}</span>
							{/if}
							<button class="item-delete" onclick={() => removeText(t.id)} title="Remove">×</button>
						</div>
					{/each}
				</div>
			</div>

			<p class="editor-hint">
				Drag items to reposition · Resize signature with the ◢ handle · Click document to add text · Annotations are saved per page
			</p>
		</section>

	<!-- Step 4: Done -->
	{:else if step === 'done'}
		<section class="card done">
			<div class="done-icon">✅</div>
			<h2>Signed PDF downloaded!</h2>
			<p>Check your downloads folder.</p>
			<button class="btn btn-primary" onclick={reset}>Sign another document</button>
		</section>
	{/if}
</main>

<style>
	:global(*, *::before, *::after) { box-sizing: border-box; margin: 0; padding: 0; }
	:global(body) {
		font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
		background: #f0f4f8; color: #1a1a2e; min-height: 100vh;
	}

	main { max-width: 900px; margin: 0 auto; padding: 2rem 1rem; }
	header { text-align: center; margin-bottom: 2rem; }
	h1 { font-size: 2rem; font-weight: 700; }
	.subtitle { color: #64748b; margin-top: 0.25rem; }

	.card {
		background: white; border-radius: 12px; padding: 2rem;
		box-shadow: 0 1px 3px rgba(0,0,0,.08), 0 4px 16px rgba(0,0,0,.06);
	}

	.upload-zone {
		display: flex; flex-direction: column; align-items: center;
		gap: 1rem; padding: 3rem 2rem;
		border: 2px dashed #cbd5e1; cursor: pointer; transition: border-color .2s;
	}
	.upload-zone:hover { border-color: #6366f1; }
	.upload-icon { font-size: 3rem; }
	.upload-zone p { color: #64748b; }

	.step-badge {
		display: inline-flex; align-items: center; justify-content: center;
		width: 28px; height: 28px; border-radius: 50%;
		background: #6366f1; color: white; font-size: .85rem; font-weight: 700;
	}
	h2 { font-size: 1.25rem; font-weight: 600; }
	.hint { color: #64748b; font-size: .9rem; margin-bottom: 1rem; }

	/* Sign progress */
	.sign-progress {
		display: flex; align-items: center; gap: .5rem;
		margin-bottom: 1.5rem;
	}
	.sign-progress-step {
		display: flex; align-items: center; gap: .5rem;
		font-size: .9rem; font-weight: 500; color: #94a3b8;
	}
	.sign-progress-step.active { color: #1a1a2e; }
	.sign-progress-step.done { color: #22c55e; }
	.sign-progress-step.done .step-badge { background: #22c55e; }
	.sign-progress-divider { flex: 1; height: 1.5px; background: #e2e8f0; min-width: 2rem; }

	.canvas-wrapper {
		border: 1.5px solid #e2e8f0; border-radius: 8px;
		background: #fafafa; overflow: hidden; margin-bottom: 1rem;
	}
	canvas { display: block; width: 100%; height: 180px; cursor: crosshair; touch-action: none; }

	/* Editor */
	.editor-card { padding: 1.25rem; }

	.editor-toolbar {
		display: flex; align-items: center; justify-content: space-between;
		gap: 1rem; flex-wrap: wrap; margin-bottom: 1rem;
	}
	.toolbar-left { display: flex; align-items: center; gap: 1rem; flex-wrap: wrap; }
	.hint-inline { color: #64748b; font-size: .85rem; }

	/* Page navigation */
	.page-nav {
		display: flex; align-items: center; justify-content: center;
		gap: .5rem; margin-bottom: 1rem; flex-wrap: wrap;
	}
	.page-btn {
		padding: .35rem .75rem; border-radius: 6px; border: 1.5px solid #e2e8f0;
		background: white; color: #475569; font-size: .85rem; font-weight: 600;
		cursor: pointer; transition: background .15s;
	}
	.page-btn:hover:not(:disabled) { background: #f1f5f9; }
	.page-btn:disabled { opacity: .4; cursor: not-allowed; }

	.page-pills { display: flex; gap: .35rem; flex-wrap: wrap; }
	.page-pill {
		position: relative;
		min-width: 32px; height: 32px; padding: 0 .5rem;
		border-radius: 6px; border: 1.5px solid #e2e8f0;
		background: white; color: #475569; font-size: .85rem; font-weight: 600;
		cursor: pointer; transition: background .15s, border-color .15s;
		display: flex; align-items: center; justify-content: center;
	}
	.page-pill:hover:not(:disabled) { background: #f1f5f9; }
	.page-pill.active { background: #6366f1; color: white; border-color: #6366f1; }
	.page-pill:disabled { opacity: .4; cursor: not-allowed; }
	.page-dot {
		position: absolute; top: 3px; right: 3px;
		width: 6px; height: 6px; border-radius: 50%;
		background: #f59e0b;
	}
	.page-pill.active .page-dot { background: white; }

	.editor-wrap {
		overflow: auto;
		border: 1.5px solid #e2e8f0;
		border-radius: 8px;
		background: #f8fafc;
		max-height: 80vh;
	}

	.pdf-stage { position: relative; display: inline-block; cursor: crosshair; }
	.pdf-canvas { display: block; }

	.render-overlay {
		position: absolute; inset: 0; z-index: 20;
		display: flex; align-items: center; justify-content: center;
		background: rgba(248,250,252,.75);
		font-size: .9rem; color: #64748b; font-weight: 500;
	}

	/* Overlay items */
	.overlay-item { position: absolute; cursor: grab; user-select: none; }
	.overlay-item:active { cursor: grabbing; }

	.sig-item { border: 1.5px dashed #6366f1; border-radius: 4px; }
	.sig-item img { width: 100%; height: 100%; object-fit: contain; display: block; pointer-events: none; }

	.text-item { min-width: 80px; border: 1.5px dashed transparent; border-radius: 4px; }
	.text-item:hover, .text-item.editing { border-color: #6366f1; }

	.text-drag-handle {
		display: none;
		align-items: center; justify-content: center;
		height: 16px; width: 100%; min-width: 80px;
		background: #6366f1; color: white;
		font-size: 10px; letter-spacing: 2px;
		cursor: grab; border-radius: 3px 3px 0 0;
		user-select: none;
	}
	.text-drag-handle:active { cursor: grabbing; }
	.text-item:hover .text-drag-handle,
	.text-item.editing .text-drag-handle { display: flex; }

	.text-item input {
		border: none; outline: none; background: transparent;
		font-size: 12px; font-family: Helvetica, Arial, sans-serif; color: #1a1a2e;
		width: 100%; min-width: 120px; padding: 0 4px; cursor: text;
		display: block; line-height: 1;
	}
	.text-display {
		font-size: 12px; font-family: Helvetica, Arial, sans-serif; color: #1a1a2e;
		padding: 0 4px; display: block; white-space: nowrap; cursor: text; line-height: 1;
	}

	.item-delete {
		position: absolute; top: -10px; right: -10px;
		width: 20px; height: 20px; border-radius: 50%;
		background: #ef4444; color: white; border: none;
		font-size: 14px; line-height: 1; cursor: pointer;
		display: flex; align-items: center; justify-content: center;
		opacity: 0; transition: opacity .15s; z-index: 10;
	}
	.overlay-item:hover .item-delete { opacity: 1; }

	.resize-handle {
		position: absolute; bottom: -1px; right: -1px;
		width: 14px; height: 14px; background: #6366f1;
		border-radius: 2px 0 4px 0; cursor: se-resize;
		clip-path: polygon(100% 0, 100% 100%, 0 100%);
	}

	.editor-hint { margin-top: .75rem; font-size: .8rem; color: #94a3b8; text-align: center; }

	.actions { display: flex; gap: .75rem; justify-content: flex-end; flex-wrap: wrap; }
	.btn {
		padding: .6rem 1.25rem; border-radius: 8px;
		font-size: .95rem; font-weight: 600; cursor: pointer;
		border: none; transition: background .15s, opacity .15s;
	}
	.btn-primary { background: #6366f1; color: white; }
	.btn-primary:hover:not(:disabled) { background: #4f46e5; }
	.btn-primary:disabled { opacity: .6; cursor: not-allowed; }
	.btn-ghost { background: transparent; color: #64748b; border: 1.5px solid #e2e8f0; }
	.btn-ghost:hover { background: #f1f5f9; }
	.btn-outline { background: white; color: #6366f1; border: 1.5px solid #6366f1; }
	.btn-outline:hover { background: #eef2ff; }

	.done {
		text-align: center; padding: 3rem 2rem;
		display: flex; flex-direction: column; align-items: center; gap: 1rem;
	}
	.done-icon { font-size: 3rem; }
	.done p { color: #64748b; }

	.error {
		background: #fef2f2; border: 1px solid #fecaca; color: #dc2626;
		border-radius: 8px; padding: .75rem 1rem; margin-bottom: 1rem; font-size: .9rem;
	}
</style>
