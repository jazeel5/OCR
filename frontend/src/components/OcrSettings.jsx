import { useEffect, useRef, useState } from 'react';

export default function OcrSettings({ onClose, hasEdits }) {
  const dialog = useRef(null);
  const [settings, setSettings] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [selectedFile, setSelectedFile] = useState('');
  useEffect(() => {
    dialog.current.showModal();
    let active = true;
    window.ocrDesktop.getSettings().then(value => {
      if (!active) return;
      if (value.error) setError(value.error);
      else setSettings(value);
    }).catch(() => { if (active) setError('Unable to load OCR settings. Reopen the app and try again.'); });
    return () => { active = false; };
  }, []);

  async function chooseCredentials() {
    setBusy(true); setError('');
    try {
      const result = await window.ocrDesktop.chooseGoogleCredentials();
      if (result.error) throw new Error(result.error);
      if (!result.cancelled) {
        setSelectedFile(result.filename);
        setSettings(current => ({ ...current, credentialConfigured: true, projectId: result.projectId }));
      }
    } catch (err) { setError(err.message); }
    finally { setBusy(false); }
  }

  async function save() {
    setBusy(true); setError('');
    try {
      const result = await window.ocrDesktop.saveSettings({ provider: settings.provider,
        localLanguage: settings.localLanguage, cloudLanguage: settings.cloudLanguage });
      if (result.error) throw new Error(result.error);
      const restart = await window.ocrDesktop.restart();
      if (restart.error) throw new Error(restart.error);
    } catch (err) { setError(err.message); setBusy(false); }
  }

  return <dialog ref={dialog} aria-labelledby="ocr-settings-title" onCancel={event => { event.preventDefault(); if (!busy) onClose(); }}
    className="m-auto w-[calc(100%-2rem)] max-w-xl max-h-[90vh] open:flex open:flex-col overflow-hidden rounded-2xl border border-slate-200 p-6 shadow-xl backdrop:bg-slate-900/40">
    <h2 id="ocr-settings-title" className="text-2xl font-bold text-slate-800">OCR settings</h2>
    <p className="text-sm text-slate-600 mt-2">Choose how your documents are recognized.</p>
    {settings && <div className="space-y-5 mt-5 min-h-0 overflow-y-auto pr-1">
      <label className="block text-sm font-semibold">Recognition service
        <select className="block w-full mt-2 border border-slate-300 rounded-lg p-3" value={settings.provider} disabled={busy}
          onChange={event => setSettings({ ...settings, provider: event.target.value })}>
          <option value="google">Google Cloud Vision</option><option value="tesseract">Local OCR (offline)</option>
        </select>
      </label>
      {settings.provider === 'google' ? <>
        <p className="text-sm text-slate-600">Printed and handwritten text recognition from Google. Pages needing OCR are sent to Google Cloud. Internet, an enabled Cloud Vision API, and billing are required; usage may incur charges.</p>
        <ol className="list-decimal pl-5 text-sm text-slate-600 space-y-2">
          <li>Create a Google Cloud project, enable billing, and enable the Cloud Vision API.</li>
          <li>Create a service account in that project and download its JSON key from the Keys tab.</li>
          <li>Select that file below. Save and restart, then upload your document.</li>
        </ol>
        <button type="button" className="text-indigo-700 underline text-sm" onClick={async () => {
          try { const result = await window.ocrDesktop.openSetupGuide(); if (result.error) setError(result.error); }
          catch { setError('Unable to open the setup guide. See the project README for instructions.'); }
        }}>Open Google setup guide</button>
        <div className="p-4 rounded-xl bg-slate-50 border border-slate-200 space-y-2">
          <button type="button" disabled={busy} onClick={chooseCredentials} className="px-4 py-2 rounded-lg border border-indigo-300 text-indigo-700 disabled:opacity-50">Select credentials JSON</button>
          <p className="text-sm break-all" role="status">{selectedFile ? `${selectedFile} selected` : settings.credentialConfigured ? 'Credentials saved on this PC.' : 'No credentials selected.'}</p>
          {settings.projectId && <p className="text-sm text-slate-600">Project: {settings.projectId}</p>}
          <p className="text-xs text-slate-500">The key stays in this Windows user’s app settings folder. API access is checked when you process a document. Never commit the key to GitHub.</p>
        </div>
        <label className="block text-sm font-semibold">Document language
          <select className="block w-full mt-2 border border-slate-300 rounded-lg p-3" value={settings.cloudLanguage} disabled={busy}
            onChange={event => setSettings({ ...settings, cloudLanguage: event.target.value })}>
            <option value="">Detect automatically</option><option value="en">English</option><option value="kn">Kannada</option><option value="en,kn">English and Kannada</option>
          </select>
        </label>
      </> : <>
        <p className="text-sm text-slate-600">Uses the bundled Tesseract engine on your PC. No internet or Google account is required. Intended for printed text; review handwriting manually.</p>
        <label className="block text-sm font-semibold">Document language
          <select className="block w-full mt-2 border border-slate-300 rounded-lg p-3" value={settings.localLanguage} disabled={busy}
            onChange={event => setSettings({ ...settings, localLanguage: event.target.value })}>
            <option value="eng">English</option><option value="eng+kan">English and Kannada</option><option value="kan">Kannada</option>
          </select>
        </label>
      </>}
      {hasEdits && <p className="text-sm text-amber-800">Export your document and table edits before restarting. Close settings to return to your document.</p>}
    </div>}
    {error && <p role="alert" className="shrink-0 text-sm text-red-700 mt-4">{error}</p>}
    <div className="shrink-0 flex justify-end flex-wrap gap-3 mt-6">
      <button type="button" disabled={busy} onClick={onClose} className="px-4 py-2 rounded-lg border border-slate-300 disabled:opacity-50">Close settings</button>
      <button type="button" onClick={save} disabled={busy || !settings || (settings.provider === 'google' && !settings.credentialConfigured)}
        className="px-4 py-2 rounded-lg bg-indigo-600 text-white disabled:opacity-50">{busy ? 'Please wait…' : 'Save and restart'}</button>
    </div>
  </dialog>;
}
