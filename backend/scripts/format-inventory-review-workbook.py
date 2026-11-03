"""Style the generated review workbook with stdlib OOXML; no business calculations."""
import json
import sys
from pathlib import Path
from zipfile import ZipFile, ZIP_DEFLATED
from xml.etree import ElementTree as ET

directory = Path(sys.argv[1])
book = directory / '库存核实回填表.xlsx'
config = json.loads((directory / 'format.json').read_text(encoding='utf-8'))
ns = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'
ET.register_namespace('', ns)
def tag(name): return '{' + ns + '}' + name
def child(parent, name, attrs=None): return ET.SubElement(parent, tag(name), attrs or {})
def letter(index):
    result = ''
    while index:
        index, remainder = divmod(index - 1, 26)
        result = chr(65 + remainder) + result
    return result

with ZipFile(book) as archive:
    files = {name: archive.read(name) for name in archive.namelist()}
styles = ET.fromstring(files['xl/styles.xml'])
fills = styles.find(tag('fills'))
def fill(color):
    index = len(fills)
    element = child(fills, 'fill')
    pattern = child(element, 'patternFill', {'patternType': 'solid'})
    child(pattern, 'fgColor', {'rgb': color})
    child(pattern, 'bgColor', {'indexed': '64'})
    return index
grey = fill('FFF1F5F9')
yellow = fill('FFFFF2CC')
blue = fill('FF17365D')
fills.set('count', str(len(fills)))
fonts = styles.find(tag('fonts'))
white_font = len(fonts)
font = child(fonts, 'font')
child(font, 'sz', {'val': '11'})
child(font, 'color', {'rgb': 'FFFFFFFF'})
child(font, 'name', {'val': 'Microsoft YaHei'})
child(font, 'b')
fonts.set('count', str(len(fonts)))
xfs = styles.find(tag('cellXfs'))
def style(fill_id, locked=True, font_id=0):
    index = len(xfs)
    xf = child(xfs, 'xf', {'numFmtId': '0', 'fontId': str(font_id), 'fillId': str(fill_id), 'borderId': '0', 'xfId': '0', 'applyFill': '1', 'applyAlignment': '1', 'applyProtection': '1'})
    child(xf, 'alignment', {'vertical': 'center', 'wrapText': '1'})
    child(xf, 'protection', {'locked': '1' if locked else '0'})
    return index
original_style = style(grey)
editable_style = style(yellow, locked=False)
header_style = style(blue, font_id=white_font)
xfs.set('count', str(len(xfs)))
files['xl/styles.xml'] = ET.tostring(styles, encoding='utf-8', xml_declaration=True)
workbook = ET.fromstring(files['xl/workbook.xml'])
for index, definition in enumerate(config['sheets'], 1):
    name = 'xl/worksheets/sheet%d.xml' % index
    root = ET.fromstring(files[name])
    headers = definition['headers']
    editable = {letter(i + 1) for i, value in enumerate(headers) if value in definition['editable']}
    data = root.find(tag('sheetData'))
    for row in data:
        row_number = int(row.get('r'))
        row.set('ht', '32' if row_number == 1 else '42')
        if definition['name'] == '填写说明' and row_number > 1:
            row.set('ht', '64')
        row.set('customHeight', '1')
        for cell in row:
            column = ''.join(c for c in cell.get('r', '') if c.isalpha())
            cell.set('s', str(header_style if row_number == 1 else editable_style if column in editable else original_style))
    views = root.find(tag('sheetViews'))
    if views is None:
        views = ET.Element(tag('sheetViews'))
        insert_at = 0
        for i, element in enumerate(root):
            if element.tag in (tag('sheetPr'), tag('dimension')):
                insert_at = i + 1
        root.insert(insert_at, views)
    if definition['name'] == '填写说明':
        columns = root.find(tag('cols'))
        if columns is not None:
            for i, column in enumerate(columns): column.set('width', '24' if i == 0 else '120')
    for view in list(views): views.remove(view)
    view = child(views, 'sheetView', {'workbookViewId': '0', 'zoomScale': '85'})
    child(view, 'pane', {'ySplit': '1', 'topLeftCell': 'A2', 'activePane': 'bottomLeft', 'state': 'frozen'})
    child(view, 'selection', {'pane': 'bottomLeft', 'activeCell': 'A2', 'sqref': 'A2'})
    # Do not protect editing sheets: users may sort and copy batch rows. Grey/yellow
    # is a visual contract; the later write-back validates original values and IDs.
    validations = ET.Element(tag('dataValidations'))
    last_row = definition['rows'] + 1
    for header, kind in definition.get('validation', {}).items():
        if last_row < 2: continue
        column = letter(headers.index(header) + 1)
        attrs = {'sqref': f'{column}2:{column}{last_row}', 'allowBlank': '1', 'showInputMessage': '1', 'showErrorMessage': '1', 'errorTitle': '请按要求填写', 'error': '请使用下拉选项或有效数值，未知请留空。'}
        if kind in ('decimal', 'rate', 'integer'):
            attrs.update(type='custom')
            address = column + '2'
            formula = f'AND(ISNUMBER({address}),{address}>=0,ROUND({address},2)={address})'
            if kind == 'rate': formula = f'AND(ISNUMBER({address}),{address}>=0,{address}<=100,ROUND({address},2)={address})'
            if kind == 'integer': formula = f'AND(ISNUMBER({address}),{address}>0,INT({address})={address})'
        else:
            attrs.update(type='list', errorStyle='stop')
            formula = '"' + kind + '"'
        validation = child(validations, 'dataValidation', attrs)
        child(validation, 'formula1').text = formula
    if len(validations):
        validations.set('count', str(len(validations)))
        # Insert before ignoredErrors/pageMargins if present, preserving sheet order.
        insert_at = len(root)
        for i, element in enumerate(root):
            if element.tag in (tag('ignoredErrors'), tag('pageMargins'), tag('pageSetup')):
                insert_at = i
                break
        root.insert(insert_at, validations)
    files[name] = ET.tostring(root, encoding='utf-8', xml_declaration=True)
    if definition['name'] == '_校验信息':
        workbook.find(tag('sheets'))[index - 1].set('state', 'veryHidden')
files['xl/workbook.xml'] = ET.tostring(workbook, encoding='utf-8', xml_declaration=True)
temporary = book.with_suffix('.formatting.tmp')
with ZipFile(temporary, 'w', ZIP_DEFLATED) as archive:
    for name, data in files.items(): archive.writestr(name, data)
temporary.replace(book)
with ZipFile(book) as archive:
    assert archive.testzip() is None
    for name in archive.namelist():
        if name.endswith('.xml'): ET.fromstring(archive.read(name))
print(str(book))
