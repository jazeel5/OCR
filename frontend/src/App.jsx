import { useState, useRef, useEffect } from 'react';
import { UploadCloud, Layers, ScanText, Loader, ShieldCheck, Cloud } from 'lucide-react';
import ReviewScreen from './components/ReviewScreen';
import OcrSettings from './components/OcrSettings';

const API_BASE = (import.meta.env.VITE_API_BASE_URL || '').replace(/\/$/, '');
const FILE_TYPES = { pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', tif: 'image/tiff', tiff: 'image/tiff' };

function App() {
  const [isDragging, setIsDragging] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const [result, setResult] = useState(null);
  const [fileUrl, setFileUrl] = useState(null);
  const [fileType, setFileType] = useState('');
  const [error, setError] = useState('');
  const [health, setHealth] = useState(null);
  const [healthError, setHealthError] = useState('');
  const [healthAttempt, setHealthAttempt] = useState(0);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const desktop = Boolean(window.ocrDesktop);
  const inputRef = useRef(null);
  const uploadRef = useRef(null);

  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    const timer = setTimeout(() => controller.abort(), 8000);
    fetch(`${API_BASE}/api/health`, { signal: controller.signal })
      .then(async response => {
        const data = await response.json();
        if (active && data.provider) setHealth(data);
        if (!response.ok || data.status !== 'ready') throw new Error(data.error || 'OCR service is not ready.');
        if (active) { setHealth(data); setHealthError(''); }
      })
      .catch(err => {
        if (!active) return;
        if (!controller.signal.aborted) setHealthError(err.message || 'Cannot connect to the service.');
        else setHealthError('Connection timed out. Check that both services are running.');
      })
      .finally(() => clearTimeout(timer));
    return () => { active = false; clearTimeout(timer); controller.abort(); };
  }, [healthAttempt]);

  useEffect(() => () => { if (fileUrl) URL.revokeObjectURL(fileUrl); }, [fileUrl]);
  useEffect(() => () => uploadRef.current?.abort(), []);
  useEffect(() => {
    if (!isUploading) return;
    const started = Date.now();
    const interval = setInterval(() => setElapsedSeconds(Math.floor((Date.now() - started) / 1000)), 1000);
    return () => clearInterval(interval);
  }, [isUploading]);

  async function handleUpload(originalFile) {
    if (uploadRef.current) return;
    setError('');
    if (health?.status !== 'ready') { setError('Configure the OCR service before uploading.'); return; }
    const extension = originalFile.name.split('.').pop().toLowerCase();
    const type = originalFile.type || FILE_TYPES[extension];
    if (!Object.values(FILE_TYPES).includes(type)) {
      setError('Choose a PDF, PNG, JPEG, WebP, or TIFF file.'); return;
    }
    if (!originalFile.size || originalFile.size > health.max_upload_bytes) {
      setError(`Choose a non-empty file up to ${Math.floor(health.max_upload_bytes / 1024 / 1024)} MB.`); return;
    }
    const file = originalFile.type ? originalFile : new File([originalFile], originalFile.name, { type });
    const controller = new AbortController();
    uploadRef.current = controller;
    setIsUploading(true);
    setElapsedSeconds(0);
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, 190000);
    const form = new FormData();
    form.append('file', file);
    try {
      const response = await fetch(`${API_BASE}/api/upload`, { method: 'POST', body: form, signal: controller.signal });
      const data = await response.json().catch(() => { throw new Error('The server returned an invalid response.'); });
      if (!response.ok) throw new Error(data.error || 'The document could not be processed.');
      if (!data.success || typeof data.data?.text !== 'string' || !Array.isArray(data.data?.page_results)) {
        throw new Error('The server returned incomplete OCR results.');
      }
      setFileUrl(URL.createObjectURL(file));
      setFileType(type);
      setResult(data);
    } catch (err) {
      setError(controller.signal.aborted
        ? (timedOut ? 'Processing took too long. Try a smaller document.' : 'Upload cancelled. Processing already started on the server may finish.')
        : err.message || 'Upload failed. Check your connection and try again.');
    } finally {
      clearTimeout(timer);
      uploadRef.current = null;
      setIsUploading(false);
    }
  }

  function onDrop(event) {
    event.preventDefault();
    setIsDragging(false);
    if (isUploading) return;
    if (event.dataTransfer.files.length !== 1) { setError('Upload one document at a time.'); return; }
    handleUpload(event.dataTransfer.files[0]);
  }

  function reset() {
    setResult(null);
    setFileUrl(null);
    setError('');
  }

  const cloud = health?.processing_location === 'google-cloud';
  return (
    <div className="min-h-screen bg-slate-50 flex flex-col font-sans text-slate-900">
      <header className="border-b border-slate-200 bg-white p-4">
        <div className="max-w-7xl mx-auto flex flex-wrap gap-3 items-center justify-between">
          <div className="flex items-center gap-2 text-indigo-600 font-bold text-xl tracking-tight">
            <ScanText size={28} aria-hidden="true" /><span>OCR Nexus</span>
          </div>
          <span className="text-sm text-slate-600 flex items-center gap-2" role="status">
            {health ? <>{cloud ? <Cloud size={17} /> : <ShieldCheck size={17} />}{cloud ? 'Google Cloud Vision' : 'Local Tesseract'}</> : 'Connecting to OCR service…'}
          </span>
          {desktop && <button type="button" disabled={isUploading} onClick={() => setSettingsOpen(true)} className="text-sm px-4 py-2 rounded-lg border border-indigo-200 text-indigo-700 disabled:opacity-50">OCR settings</button>}
        </div>
      </header>
      {result ? <ReviewScreen fileUrl={fileUrl} fileType={fileType} filename={result.filename} ocrData={result.data} onReset={reset} /> : (
        <main className="flex-1 max-w-5xl mx-auto w-full px-6 py-16 flex flex-col justify-center items-center">
          <div className="text-center mb-10">
            <h1 className="text-4xl md:text-6xl font-extrabold text-slate-800 mb-6 tracking-tight">
              Turn documents into <span className="text-indigo-600">editable text</span>
            </h1>
            <p className="text-lg text-slate-600 max-w-2xl mx-auto leading-relaxed">
              Extract text and ruled tables from PDFs, scans, and photos. Review them alongside your document, make corrections, and download the result.
            </p>
          </div>
          {desktop && (!cloud || health?.status !== 'ready') && <div className="w-full max-w-3xl mb-5 rounded-xl border border-indigo-200 bg-indigo-50 p-5">
            <p className="font-semibold text-indigo-900">Use Google Cloud Vision</p>
            <p className="text-sm text-indigo-900 mt-1">Connect your Google Cloud project to recognize printed and handwritten text. Internet and Google billing are required.</p>
            <button type="button" disabled={isUploading} onClick={() => setSettingsOpen(true)} className="mt-3 text-sm font-semibold text-indigo-700 underline disabled:opacity-50">Set up Google OCR</button>
          </div>}
          {healthError && <div className="w-full max-w-3xl mb-5 rounded-xl border border-amber-200 bg-amber-50 p-4 text-amber-900" role="alert">
            {healthError}<button className="ml-3 underline font-semibold" onClick={() => setHealthAttempt(n => n + 1)}>Retry connection</button>
          </div>}
          <div className="w-full max-w-3xl">
            <div
              className={`relative p-8 md:p-16 text-center rounded-2xl border-2 border-dashed bg-white transition-colors ${isDragging ? 'border-indigo-500 bg-indigo-50' : 'border-slate-300'}`}
              onDragOver={event => { event.preventDefault(); if (!isUploading) setIsDragging(true); }}
              onDragLeave={event => { if (!event.currentTarget.contains(event.relatedTarget)) setIsDragging(false); }}
              onDrop={onDrop}
              aria-busy={isUploading}
            >
              <input ref={inputRef} type="file" className="hidden" accept=".pdf,.png,.jpg,.jpeg,.webp,.tif,.tiff" disabled={isUploading || health?.status !== 'ready'}
                aria-label="Choose document"
                onChange={event => { const file = event.target.files?.[0]; event.target.value = ''; if (file) handleUpload(file); }} />
              <div className="flex flex-col items-center gap-5">
                {isUploading ? <>
                  <Loader className="w-14 h-14 text-indigo-500 animate-spin" aria-hidden="true" />
                  <div role="status"><p className="text-xl font-semibold">Extracting your document…</p><p className="text-slate-500 mt-2">{cloud ? 'Google Cloud Vision' : 'Local OCR'} · {elapsedSeconds}s elapsed</p><p className="text-sm text-slate-500 mt-1">{cloud ? 'Keep your internet connection active.' : 'Larger documents take longer to recognize.'}</p></div>
                  <button className="px-5 py-2 rounded-lg border border-slate-300 hover:bg-slate-100" onClick={() => uploadRef.current?.abort()}>Cancel</button>
                </> : <>
                  <div className="p-5 bg-indigo-50 rounded-full"><UploadCloud className="w-14 h-14 text-indigo-500" aria-hidden="true" /></div>
                  <p className="text-2xl font-semibold text-slate-700">Drop your document here</p>
                  <button className="px-6 py-3 bg-indigo-600 text-white rounded-xl font-semibold hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed" disabled={health?.status !== 'ready'} onClick={() => inputRef.current?.click()}>Choose a document</button>
                  <p className="text-sm text-slate-500">PDF, PNG, JPEG, WebP, TIFF · {Math.floor((health?.max_upload_bytes || 10485760) / 1024 / 1024)} MB maximum{health && ` · Up to ${health.max_pages} pages`}</p>
                </>}
              </div>
            </div>
            {error && <p role="alert" className="mt-4 p-4 rounded-xl bg-red-50 border border-red-200 text-red-800">{error}</p>}
            <p className="text-center text-sm text-slate-500 mt-4">{health ? cloud
              ? 'Pages requiring OCR are sent to Google Cloud Vision for text recognition.'
              : desktop ? 'Documents are processed on this PC using local OCR.' : 'Documents are processed on this server using local OCR.' : 'Processing details will appear when the service connects.'}</p>
            <p className="text-center text-xs text-slate-500 mt-2">For small print, use the original PDF or a sharp, full-resolution photo with all four page corners visible. Handwritten entries need review.</p>
          </div>
          <div className="mt-14 grid grid-cols-1 md:grid-cols-3 gap-6 w-full text-center">
            {[{ icon: <Layers size={24} />, title: 'Text and table rows', description: 'Keeps page boundaries and extracts tables with visible ruling lines.' },
              { icon: <ScanText size={24} />, title: 'PDFs and scanned images', description: 'Reads embedded PDF text directly and uses OCR for scanned pages.' },
              { icon: <ShieldCheck size={24} />, title: 'Review before you use', description: 'Edit text and cells, then export TXT, CSV, or JSON.' }].map(({ icon, title, description }) => (
              <div key={title} className="p-6 rounded-2xl bg-white border border-slate-200 flex flex-col items-center gap-3">
                <span className="text-indigo-500" aria-hidden="true">{icon}</span><h2 className="font-semibold">{title}</h2><p className="text-sm text-slate-500">{description}</p>
              </div>
            ))}
          </div>
        </main>
      )}
      {settingsOpen && <OcrSettings onClose={() => setSettingsOpen(false)} hasEdits={Boolean(result)} />}
      <footer className="mt-auto py-6 text-center text-slate-500 text-sm border-t border-slate-200">OCR Nexus · Review extracted text for accuracy.</footer>
    </div>
  );
}

export default App;
