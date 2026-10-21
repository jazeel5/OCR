import { useState } from 'react';
import { FileText, CheckCircle, Copy, Download } from 'lucide-react';
import TableReview from './TableReview';

const ENGINE_NAMES = { 'pdf-text': 'Embedded PDF text', tesseract: 'Tesseract', google: 'Google Cloud Vision' };

export default function ReviewScreen({ fileUrl, fileType, filename, ocrData, onReset }) {
  const [pages, setPages] = useState(() => ocrData.page_results.map(page => ({ ...page })));
  const [message, setMessage] = useState('');
  const edited = pages.some((page, i) => page.text !== ocrData.page_results[i].text ||
    JSON.stringify(page.tables || []) !== JSON.stringify(ocrData.page_results[i].tables || []));
  const text = pages.map(page => page.text).join('\n\n');

  function editCell(pageIndex, tableIndex, cellIndex, value) {
    setPages(current => current.map((page, i) => i !== pageIndex ? page : { ...page,
      tables: page.tables.map((table, j) => j !== tableIndex ? table : { ...table,
        cells: table.cells.map((cell, k) => k !== cellIndex ? cell : { ...cell, text: value }),
      }),
    }));
  }

  async function copyText() {
    try { await navigator.clipboard.writeText(text); setMessage('Text copied.'); }
    catch { setMessage('Copy is unavailable. Select the text or download it instead.'); }
  }

  function download(json = false) {
    const data = json ? JSON.stringify({ ...ocrData, filename, text, page_results: pages, edited,
      confidence_note: 'Confidence describes the original OCR output, before manual edits. Embedded PDF text has no OCR confidence.' }, null, 2) : text;
    const url = URL.createObjectURL(new Blob([data], { type: json ? 'application/json' : 'text/plain;charset=utf-8' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = `${filename.replace(/\.[^.]+$/, '') || 'document'}.${json ? 'json' : 'txt'}`;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    setMessage('Download started.');
  }

  return (
    <main className="w-full max-w-7xl mx-auto p-4 md:p-6 flex-1">
      <div className="flex flex-wrap justify-between items-center gap-4 mb-6">
        <div><h1 className="text-3xl font-bold text-slate-800">Review extraction</h1><p className="text-sm text-slate-500 mt-2 break-all">{filename} · {ocrData.pages} {ocrData.pages === 1 ? 'page' : 'pages'}</p></div>
        <button onClick={onReset} className="px-4 py-2 bg-slate-200 hover:bg-slate-300 rounded-lg font-medium">Process another document</button>
      </div>
      {ocrData.warnings?.length > 0 && <div role="status" className="mb-5 p-4 rounded-xl border border-amber-200 bg-amber-50 text-amber-900 text-sm">{ocrData.warnings.map(warning => <p key={warning}>{warning}</p>)}</div>}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <section className="bg-white rounded-2xl overflow-hidden border border-slate-200 flex flex-col">
          <h2 className="p-4 bg-slate-100 border-b border-slate-200 flex items-center gap-2 font-semibold"><FileText className="text-indigo-500" size={20} />Original document</h2>
          <div className="h-[55vh] lg:h-[70vh] min-h-80 bg-slate-100 p-3">
            {fileType === 'application/pdf' ? <iframe src={fileUrl} className="w-full h-full rounded-xl border border-slate-200 bg-white" title="Original PDF document" />
              : fileType === 'image/tiff' ? <div className="flex h-full items-center justify-center text-center text-slate-600 p-8">Your browser may not display TIFF files. Open the original document using the link below.</div>
                : <img src={fileUrl} className="w-full h-full object-contain rounded-xl" alt={`Original document: ${filename}`} />}
          </div>
          <a href={fileUrl} target="_blank" rel="noreferrer" className="p-4 text-sm text-indigo-700 underline">Open original document</a>
        </section>
        <section className="bg-white rounded-2xl overflow-hidden border border-slate-200 flex flex-col">
          <div className="p-4 bg-slate-100 border-b border-slate-200 flex flex-wrap gap-2 items-center justify-between">
            <h2 className="flex items-center gap-2 font-semibold"><CheckCircle className="text-indigo-500" size={20} />Extracted text{edited ? ' (edited)' : ''}</h2>
            {ocrData.confidence != null && <span className={`text-xs font-medium px-3 py-1 rounded-full ${ocrData.confidence < 75 ? 'bg-amber-100 text-amber-800' : 'bg-emerald-100 text-emerald-800'}`}>OCR confidence: {Math.round(ocrData.confidence)}%</span>}
          </div>
          <div className="flex flex-wrap gap-2 p-3 border-b border-slate-200">
            <button onClick={copyText} className="action-button"><Copy size={16} />Copy text</button>
            <button onClick={() => download()} className="action-button"><Download size={16} />Text</button>
            <button onClick={() => download(true)} className="action-button"><Download size={16} />JSON</button>
            <span className="text-sm text-slate-600 self-center" role="status">{message}</span>
          </div>
          <div className="p-4 space-y-5 max-h-[70vh] overflow-y-auto">
            <p className="text-xs text-slate-500">Text is editable. Confidence measures the original OCR output, not correctness or your edits. Embedded PDF text has no OCR confidence.</p>
            {pages.some(page => page.tables?.length) && <p className="text-xs text-slate-500">Document text and table cells are separate editable versions. Text edits appear in TXT; table edits appear in CSV. JSON includes both.</p>}
            {pages.map((page, index) => <div key={page.page}>
              <label htmlFor={`page-${page.page}`} className="block text-sm font-medium mb-2">Page {page.page} · {ENGINE_NAMES[page.engine] || page.engine}{page.confidence != null ? ` · ${Math.round(page.confidence)}% confidence` : ''}</label>
              {page.review_notes?.map(note => <p key={note} className="mb-2 text-xs text-amber-800">{note}</p>)}
              <textarea id={`page-${page.page}`} value={page.text} rows={Math.min(22, Math.max(8, page.text.split('\n').length + 2))}
                spellCheck={false} placeholder="No text detected on this page. You can enter text here."
                className="w-full p-4 border border-slate-300 rounded-xl font-mono text-sm leading-relaxed text-slate-700 resize-y"
                onChange={event => setPages(current => current.map((item, i) => i === index ? { ...item, text: event.target.value } : item))} />
              {page.tables?.map((table, tableIndex) => <TableReview key={tableIndex} table={table}
                tableIndex={tableIndex} pageNumber={page.page} filename={filename}
                onChange={(cellIndex, value) => editCell(index, tableIndex, cellIndex, value)} />)}
            </div>)}
          </div>
        </section>
      </div>
    </main>
  );
}
