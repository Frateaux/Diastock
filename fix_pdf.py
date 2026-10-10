import sys
import re

with open('js/pdf.js', 'r', encoding='utf-8') as f:
    content = f.read()

content, c1 = re.subn(
    r'const mats = materiali\.filter\(m => m\.attivo !== false\)\.sort',
    r'const mats = materiali.sort',
    content
)

if c1 > 0:
    with open('js/pdf.js', 'w', encoding='utf-8') as f:
        f.write(content)
    print('SUCCESS')
else:
    print(f'FAILED: c1={c1}')
