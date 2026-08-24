# -*- coding: utf-8 -*-
"""把词典塞进 I18N_ID。"""
import io, json, sys
sys.path.insert(0, r'C:\Users\pupu\AppData\Local\Temp\claude\H-----------\9d835375-1a71-4e64-9094-42570a8a8ee9\scratchpad')
from dict_final import D

P = r'H:\我的云端硬盘\开发\荣升检查报告\前端源文件-prestova-inspection-report.html'
s = io.open(P, encoding='utf-8', newline='').read()

lines = []
for k in sorted(D):
    lines.append('  %s: %s,' % (json.dumps(k, ensure_ascii=False), json.dumps(D[k], ensure_ascii=False)))
body = '\r\n'.join(lines)

old = '  /* 词条见下（构建脚本填充） */'
assert s.count(old) == 1
s = s.replace(old, body)
io.open(P, 'w', encoding='utf-8', newline='').write(s)
print('词条写入:', len(D))
