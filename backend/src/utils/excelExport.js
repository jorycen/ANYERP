const XLSX = require('xlsx');

function sendExcel(ctx, rows, headers, fileName, sheetName = '数据') {
  const workbook = XLSX.utils.book_new();
  const worksheet = XLSX.utils.json_to_sheet(rows, { header: headers });
  XLSX.utils.book_append_sheet(workbook, worksheet, sheetName);

  const buffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
  const encodedFileName = encodeURIComponent(fileName);

  ctx.set('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  ctx.set('Content-Disposition', `attachment; filename*=UTF-8''${encodedFileName}`);
  ctx.body = buffer;
}

module.exports = { sendExcel };
