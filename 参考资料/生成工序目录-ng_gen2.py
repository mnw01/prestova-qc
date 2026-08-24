# -*- coding: utf-8 -*-
"""生成新的 IPQC_WS / IPQC_DEFECTS —— 按 (车间, 工序) 分组，带印尼语。"""
import zipfile, re, json, io
import xml.etree.ElementTree as ET
from collections import OrderedDict, Counter

SC = r'C:\Users\pupu\AppData\Local\Temp\claude\H-----------\9d835375-1a71-4e64-9094-42570a8a8ee9\scratchpad'
NS = '{http://schemas.openxmlformats.org/spreadsheetml/2006/main}'


def read_sheet(path, sheet='xl/worksheets/sheet1.xml'):
    z = zipfile.ZipFile(path)
    sst = []
    if 'xl/sharedStrings.xml' in z.namelist():
        with z.open('xl/sharedStrings.xml') as f:
            for _, el in ET.iterparse(f):
                if el.tag == NS + 'si':
                    sst.append(''.join(t.text or '' for t in el.iter(NS + 't')))
                    el.clear()
    rows = []
    with z.open(sheet) as f:
        for _, el in ET.iterparse(f):
            if el.tag != NS + 'row':
                continue
            d = {}
            for c in el.findall(NS + 'c'):
                t = c.get('t')
                v = c.find(NS + 'v')
                isv = c.find(NS + 'is')
                val = None
                if t == 'inlineStr' and isv is not None:
                    val = ''.join(x.text or '' for x in isv.iter(NS + 't'))
                elif v is not None:
                    val = v.text
                    if t == 's' and val is not None:
                        val = sst[int(val)]
                if val not in (None, ''):
                    d[re.match(r'([A-Za-z]+)', c.get('r')).group(1)] = str(val).strip()
            el.clear()
            rows.append(d)
    return rows


ng = [r for r in read_sheet(r'E:\OneDrive\Desktop\list NG.xlsx')[2:] if r.get('A') and r.get('C')]

freq = Counter()
for r in read_sheet(r'E:\OneDrive\Desktop\2026品质累计报告.xlsx')[1:]:
    if r.get('I'):
        freq[r['I']] += 1

ws_id, proc_id, per = OrderedDict(), OrderedDict(), OrderedDict()
for r in ng:
    ws_id.setdefault(r['A'], r.get('B', ''))
    proc_id.setdefault((r['A'], r['C']), r.get('D', ''))
    per.setdefault((r['A'], r['C']), OrderedDict())
    if r.get('E'):
        per[(r['A'], r['C'])].setdefault(r['E'], r.get('F', ''))

WS_ORDER = ['弹簧床垫车间', '海绵床垫车间']
CUR_ORDER = {'弹簧床垫车间': ['围边', '缝纫', '裥绵', '床网', '扣布', '包装'],
             '海绵床垫车间': ['缝纫', '包装', '贴合', '套装', '发泡', '裁切']}


def js(x):
    return json.dumps(x, ensure_ascii=False)


order = OrderedDict()
for w in WS_ORDER:
    ps = CUR_ORDER[w][:]
    for (a, c) in proc_id:
        if a == w and c not in ps:
            ps.append(c)
    order[w] = ps

out = []
out.append('/* 车间 / 工序 / 不良描述 —— 中文和印尼语全部照用户给的「list NG.xlsx」')
out.append('   原文，一个字没自己翻（用户明确说过：不要直接翻译，可能不准确）。')
out.append('')
out.append('   两处跟第一版不一样，都是这份表纠正过来的：')
out.append('   1. **不良描述按 (车间, 工序) 分**，不是只按工序。缝纫和包装两个车间')
out.append('      的清单其实不一样（缝纫：弹簧 108 条、海绵 74 条，各有 66 / 32 条')
out.append('      是自己独有的；包装 27 / 24 条）。第一版从统计报告里反推目录时把')
out.append('      两边合成了一份，弹簧的 QC 会看到一堆海绵才有的选项。')
out.append('   2. 工序的印尼语跟车间有关（缝纫在弹簧车间叫 Sewing Spring、在海绵车间')
out.append('      叫 Sewing Foam），所以挂在车间下面，不放进那张扁平词典。')
out.append('')
out.append('   排序仍按 2026 品质累计报告里的实际出现频次（常用的在前，手机上少滚')
out.append('   一点），报告里没出现过的按原表顺序接在后面。 */')
out.append('const IPQC_WS=[')
rows = []
for w in WS_ORDER:
    plist = ',\n            '.join('[%s,%s]' % (js(p), js(proc_id.get((w, p), ''))) for p in order[w])
    rows.append('  { zh:%s, id:%s,\n    procs:[%s] }' % (js(w), js(ws_id[w]), plist))
out.append(',\n'.join(rows))
out.append('];')
out.append('/* key 是 车间+"|"+工序 */')
out.append('const IPQC_DEFECTS={')
drows = []
for w in WS_ORDER:
    for p in order[w]:
        dd = per.get((w, p), OrderedDict())
        items = sorted(dd.items(), key=lambda kv: (-freq.get(kv[0], 0), list(dd).index(kv[0])))
        drows.append('  %s:[\n    %s]' % (
            js(w + '|' + p),
            ',\n    '.join('[%s,%s]' % (js(k), js(v)) for k, v in items)))
out.append(',\n'.join(drows))
out.append('};')

txt = '\n'.join(out)
io.open(SC + r'\ipqc_const2.js', 'w', encoding='utf-8').write(txt)
print("ipqc_const2.js  %d 字符" % len(txt))
for w in WS_ORDER:
    print(" ", w, ws_id[w], [(p, len(per.get((w, p), {}))) for p in order[w]])

# 扁平词典：车间名 + 全部不良描述（同一中文在不同工序下印尼语一致，已验证无冲突）
flat = OrderedDict()
for w in WS_ORDER:
    flat[w] = ws_id[w]
conflict = 0
for k, dd in per.items():
    for zh, idv in dd.items():
        if not idv:
            continue
        if zh in flat and flat[zh] != idv:
            conflict += 1
            print("  冲突:", zh, "|", flat[zh], "vs", idv)
        flat.setdefault(zh, idv)
print("扁平词典（车间 + 不良描述）:", len(flat), " 冲突:", conflict)
io.open(SC + r'\ng_flat.json', 'w', encoding='utf-8').write(json.dumps(flat, ensure_ascii=False, indent=0))
