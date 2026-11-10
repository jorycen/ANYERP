const XLSX = require('xlsx');

function sendExcel(ctx, rows, headers, fileName, sheetName = '数据', options = {}) {
  const workbook = XLSX.utils.book_new();
  const worksheet = XLSX.utils.json_to_sheet(rows, { header: headers });
  if (options.columnWidths) worksheet['!cols'] = headers.map(header => ({ wch: options.columnWidths[header] || 20 }));
  if (options.autoFilter && worksheet['!ref']) worksheet['!autofilter'] = { ref: worksheet['!ref'] };
  const textColumns = new Set(options.textHeaders || []);
  headers.forEach((header, columnIndex) => {
    if (!textColumns.has(header)) return;
    for (let rowIndex = 1; rowIndex <= rows.length; rowIndex += 1) {
      const address = XLSX.utils.encode_cell({ r: rowIndex, c: columnIndex });
      worksheet[address] = worksheet[address] || { t: 's', v: '' };
      worksheet[address].t = 's';
      worksheet[address].z = '@';
    }
  });
  XLSX.utils.book_append_sheet(workbook, worksheet, sheetName);

  for (const extra of options.sheets || []) {
    const sheet = XLSX.utils.json_to_sheet(extra.rows || []);
    if (extra.columnWidths) sheet['!cols'] = extra.columnWidths.map(wch => ({ wch }));
    XLSX.utils.book_append_sheet(workbook, sheet, extra.name);
  }
  const buffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
  const encodedFileName = encodeURIComponent(fileName);

  ctx.set('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  ctx.set('Content-Disposition', `attachment; filename*=UTF-8''${encodedFileName}`);
  ctx.body = buffer;
}

module.exports = { sendExcel };
