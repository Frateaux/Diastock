import sys
import re

with open('js/app.js', 'r', encoding='utf-8') as f:
    content = f.read()

# Inject currentGiacList into routes.giacenze
content, c1 = re.subn(
    r'(const draw = \(\) => {\s*const q = \$\("#q"\)\.value\.toLowerCase\(\);)',
    r'let currentGiacList = [];\n    \1',
    content
)

content, c2 = re.subn(
    r'(const list = giac\.filter\(\(g\) => \(filtro === "tutti" \|\| g\.sotto\) && \(!q \|\| `\$\{g\.nome\} \$\{g\.categoria\} \$\{g\.barcode\}`\.toLowerCase\(\)\.includes\(q\)\)\);)',
    r'\1\n      currentGiacList = list;',
    content
)

content, c3 = re.subn(
    r'const datiExport = filtro === "sotto" \? sottoList : giac;\s*return pdf\.giacenzePdf\(\{ giacenze: datiExport, operatoreStampa: ME\.nome \}\);',
    r'return pdf.giacenzePdf({ giacenze: currentGiacList, operatoreStampa: ME.nome });',
    content
)

if c1 > 0 and c2 > 0 and c3 > 0:
    with open('js/app.js', 'w', encoding='utf-8') as f:
        f.write(content)
    print('SUCCESS')
else:
    print(f'FAILED: c1={c1}, c2={c2}, c3={c3}')
