import sys
import re

with open('js/pdf.js', 'r', encoding='utf-8') as f:
    content = f.read()

content, c1 = re.subn(
    r'const mats = materiali\.sort\(\(a, b\) => \(a\.categoria \|\| ""\)\.localeCompare\(b\.categoria \|\| ""\) \|\| a\.nome\.localeCompare\(b\.nome\)\);',
    r'const mats = [...materiali].sort((a, b) => (a.categoria || "").localeCompare(b.categoria || "") || (a.nome || "").localeCompare(b.nome || ""));',
    content
)

if c1 > 0:
    with open('js/pdf.js', 'w', encoding='utf-8') as f:
        f.write(content)
    print('SUCCESS')
else:
    print('TARGET NOT FOUND')
