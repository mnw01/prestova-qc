# 直接解 docx 的 XML（docx = zip + XML），不用 python-docx。
# 关心的是排版：页面尺寸/页边距、表格的列宽、合并、每格文字和字号。
import zipfile, sys, re
import xml.etree.ElementTree as ET

W = '{http://schemas.openxmlformats.org/wordprocessingml/2006/main}'
path = sys.argv[1]
z = zipfile.ZipFile(path)
doc = ET.fromstring(z.read('word/document.xml'))

def tag(e): return e.tag.replace(W, 'w:')
def text_of(e):
    return ''.join(t.text or '' for t in e.iter(W+'t'))

def para_info(p):
    txt = text_of(p)
    pr = p.find(W+'pPr')
    jc = pr.find(W+'jc').get(W+'val') if pr is not None and pr.find(W+'jc') is not None else ''
    sz = ''
    for r in p.iter(W+'rPr'):
        s = r.find(W+'sz')
        if s is not None: sz = str(int(s.get(W+'val'))/2)          # half-points → pt
    b = any(r.find(W+'b') is not None for r in p.iter(W+'rPr'))
    return txt, jc, sz, b

sect = doc.find('.//'+W+'sectPr')
if sect is not None:
    pg = sect.find(W+'pgSz'); mar = sect.find(W+'pgMar')
    tw = lambda v: round(int(v)/1440*25.4, 1)                      # twips → mm
    print('页面 %s x %s mm' % (tw(pg.get(W+'w')), tw(pg.get(W+'h'))))
    print('页边距 上%s 下%s 左%s 右%s mm' % (
        tw(mar.get(W+'top')), tw(mar.get(W+'bottom')),
        tw(mar.get(W+'left')), tw(mar.get(W+'right'))))
print()

body = doc.find(W+'body')
ti = 0
for el in body:
    t = tag(el)
    if t == 'w:p':
        txt, jc, sz, b = para_info(el)
        if txt.strip():
            print('段落 [%s%s%s] %s' % (jc or 'left', ' '+sz+'pt' if sz else '', ' B' if b else '', txt))
    elif t == 'w:tbl':
        ti += 1
        grid = el.find(W+'tblGrid')
        cols = [round(int(g.get(W+'w'))/1440*25.4, 1) for g in grid.findall(W+'gridCol')]
        print('\n=== 表 %d ===  %d 列，列宽(mm): %s  合计 %.1f' %
              (ti, len(cols), cols, sum(cols)))
        for ri, row in enumerate(el.findall(W+'tr'), 1):
            cells = []
            for c in row.findall(W+'tc'):
                pr = c.find(W+'tcPr')
                span = pr.find(W+'gridSpan') if pr is not None else None
                vm = pr.find(W+'vMerge') if pr is not None else None
                mark = ''
                if span is not None: mark += '×%s' % span.get(W+'val')
                if vm is not None: mark += '^' if vm.get(W+'val') == 'restart' else '|'
                txts = [text_of(p) for p in c.findall(W+'p')]
                cells.append((''.join(txts).strip() or '·') + mark)
            print('  r%-2d %s' % (ri, ' | '.join(cells)))
        print()
