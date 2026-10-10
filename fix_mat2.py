import sys
import re

with open('js/app.js', 'r', encoding='utf-8') as f:
    content = f.read()

# 1. Inject currentList into routes.materiali
content, c1 = re.subn(
    r'(const draw = \(\) => {\s*const ql = \(\$\("#q"\)\?\.value \|\| ""\)\.toLowerCase\(\);)',
    r'let currentList = [];\n    \1',
    content
)

content, c2 = re.subn(
    r'(const list = baseList\.filter\(\(m\) => !ql \|\| `\$\{m\.nome\} \$\{m\.categoria\} \$\{m\.barcode\}`\.toLowerCase\(\)\.includes\(ql\)\);)',
    r'\1\n      currentList = list;',
    content
)

content, c3 = re.subn(
    r'pdf\.materialiPdf\(\{ materiali: mats, operatoreStampa: ME\.nome \}\)',
    r'pdf.materialiPdf({ materiali: currentList, operatoreStampa: ME.nome })',
    content
)

if c1 > 0 and c2 > 0 and c3 > 0:
    with open('js/app.js', 'w', encoding='utf-8') as f:
        f.write(content)
    print('SUCCESS')
else:
    print(f'FAILED: c1={c1}, c2={c2}, c3={c3}')
