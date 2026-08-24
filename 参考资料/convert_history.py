# 把「实验室检测记录表2026.xlsx」的月度流水转成实验室板块能导入的批次记录。
# 一批 = 同一批号的 上/中/下 三行；日期优先从批号前 6 位解，解不出就用工作表所在月份。
# 原表的「判定」只作为对照存进 xlsVerdict，不当作人工改判——否则历史会被旧的宽松判定
# 冻住，看板就看不出该不该调标准了。
import openpyxl, re, json, sys
from collections import Counter

SRC = r'X:\实验室检测记录表2026.xlsx'
OUT = r'H:\我的云端硬盘\开发\荣升检查报告\参考资料\实验室历史数据-2026.json'
SHEETS = ['01月','02月','03月','04月','05月','06月','07月']
# 月表列：品名B 批号C | 密度E 硬度G 回弹I 抗压K 压缩O | 疲劳厚度Q 疲劳抗压S | 判定T
COLS = {'den':5, 'hard':7, 'reb':9, 'ifd':11, 'cs':15}
POS = ['上','中','下']

def num(v):
    if v is None: return ''
    if isinstance(v,(int,float)): return round(float(v),4)
    s = str(v).strip()
    if s in ('','-','—'): return ''
    try: return round(float(s),4)
    except ValueError: return ''

wb = openpyxl.load_workbook(SRC, data_only=True)
batches, stats = {}, Counter()

# 各品号的 40%抗压标准（「标准」页 I 列），用来把疲劳的绝对 N 换算成百分比
IFD_STD = {}
_sw = wb['标准']
for _r in range(4, 30):
    _k = _sw.cell(_r, 1).value
    if _k:
        try: IFD_STD[str(_k).strip()] = float(_sw.cell(_r, 9).value)
        except (TypeError, ValueError): pass

for sheet in SHEETS:
    ws = wb[sheet]
    for r in range(5, 672):
        model = ws.cell(r,2).value
        raw   = ws.cell(r,3).value
        if not model or not raw: continue
        model = str(model).strip()
        raw   = str(raw).strip()
        if model in ('工序','实验员','实验室'): continue

        m = re.match(r'^(\d{6})(\d{2})?([A-Za-z]\d+)?([上中下])?$', raw)
        if m:
            ymd, seq, line, pos = m.group(1), m.group(2) or '', m.group(3) or '', m.group(4)
            key = ymd + seq + line
        else:
            # 供应商批号 / 客供样这类不规则的：整串当批号，去掉尾部的 上中下
            pos = raw[-1] if raw[-1] in POS else None
            key = raw[:-1] if pos else raw
            key = key.rstrip('-')
            ymd, seq, line = '', '', ''
            stats['批号不规则'] += 1
        if pos is None:
            pos = POS[stats['无位置行'] % 3]; stats['无位置行'] += 1

        bid = sheet + '|' + key + '|' + model
        b = batches.get(bid)
        if not b:
            if ymd:
                dd, mm, yy = ymd[4:6], ymd[2:4], '20'+ymd[0:2]
            else:                                   # 退回工作表月份的 1 号
                dd, mm, yy = '01', sheet[:2], '2026'
            b = batches[bid] = {'m':model, 'b':key, 'ymd':ymd, 'seq':seq, 'line':line,
                                'd':'%s/%s/%s'%(dd,mm,yy),
                                'v':{k:['','',''] for k in COLS}, 'f':None, 'xls':['','','']}
            stats['批次'] += 1
        i = POS.index(pos)
        for k,c in COLS.items():
            v = num(ws.cell(r,c).value)
            if v != '': b['v'][k][i] = v
        # 厚度减少(Q) 本来就是百分比；抗压硬度减少(S) 旧表记的是绝对值 N
        # （范围 6~96，随各品号抗压标准缩放，S/标准 中位数 35.3%，正好压在 35% 上），
        # 而报告印的是百分比 —— 按 S ÷ 抗压标准 换算成百分比再存。
        fh, fi = num(ws.cell(r,17).value), num(ws.cell(r,19).value)
        if fi != '' and model in IFD_STD and IFD_STD[model]:
            fi = round(fi / IFD_STD[model] * 100, 2)
            stats['疲劳 N→% 换算'] += 1
        elif fi != '':
            fi = ''                                  # 无标准品号换算不了，宁可不存
            stats['疲劳无标准丢弃'] += 1
        if fh != '' or fi != '':
            b['f'] = {'at':i, 'h':fh, 'i':fi}
            stats['带疲劳测试的批'] += 1
        t = ws.cell(r,20).value
        if t in ('合格','不合格'): b['xls'][i] = t
        stats['行'] += 1

recs = sorted(batches.values(), key=lambda b:(b['d'][6:], b['d'][3:5], b['d'][:2], b['b']))
json.dump({'v':1, 'src':'实验室检测记录表2026.xlsx', 'n':len(recs), 'recs':recs},
          open(OUT,'w',encoding='utf-8'), ensure_ascii=False, separators=(',',':'))

print('写出:', OUT)
for k,v in sorted(stats.items()): print('  %-14s %d' % (k,v))
print('  日期范围      %s ~ %s' % (recs[0]['d'], recs[-1]['d']))
print('  品号数        %d' % len(set(b['m'] for b in recs)))
