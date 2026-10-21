import { Download } from 'lucide-react';

function csvValue(text) {
  // Prevent spreadsheet formulas in text recognized from an untrusted document.
  const safe = /^[\s]*[=+\-@]/.test(text) ? `'${text}` : text;
  return `"${safe.replaceAll('"', '""')}"`;
}

export default function TableReview({ table, tableIndex, pageNumber, filename, onChange }) {
  function downloadCSV() {
    const rows = Array.from({ length: table.rows }, () => Array(table.columns).fill(''));
    for (const cell of table.cells) rows[cell.row][cell.column] = cell.text;
    const csv = '\uFEFF' + rows.map(row => row.map(csvValue).join(',')).join('\r\n');
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = `${filename.replace(/\.[^.]+$/, '')}-page-${pageNumber}-table-${tableIndex + 1}.csv`;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  return <section className="mt-5 rounded-xl border border-slate-300 overflow-hidden">
    <div className="p-3 bg-indigo-50 flex flex-wrap items-center justify-between gap-2">
      <h3 className="text-sm font-semibold">Table {tableIndex + 1} · {table.rows} rows × {table.columns} columns</h3>
      <button className="action-button" onClick={downloadCSV}><Download size={16} />Download CSV</button>
    </div>
    <p className="px-3 py-2 text-xs text-slate-600">Check merged cells and empty values against the original. CSV places merged text in the first cell; JSON retains cell spans.</p>
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-sm" aria-label={`Page ${pageNumber} table ${tableIndex + 1}`}>
        <tbody>{Array.from({ length: table.rows }, (_, row) => <tr key={row}>
          {table.cells.map((cell, cellIndex) => ({ cell, cellIndex })).filter(({ cell }) => cell.row === row)
            .sort((a, b) => a.cell.column - b.cell.column).map(({ cell, cellIndex }) => <td key={cellIndex}
              rowSpan={cell.row_span} colSpan={cell.column_span}
              className={`border border-slate-200 p-1 align-top ${cell.confidence != null && cell.confidence < 75 ? 'bg-amber-50' : ''}`}>
              <textarea aria-label={`Page ${pageNumber} table ${tableIndex + 1} row ${cell.row + 1} column ${cell.column + 1}`}
                value={cell.text} onChange={event => onChange(cellIndex, event.target.value)}
                placeholder="Empty — verify" spellCheck={false}
                rows={Math.min(8, Math.max(2, cell.text.split('\n').length + 1))}
                className="block w-full min-w-24 rounded p-2 bg-transparent resize-y leading-relaxed" />
            </td>)}
        </tr>)}</tbody>
      </table>
    </div>
  </section>;
}
