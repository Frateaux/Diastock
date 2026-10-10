import sys
import re

with open('js/app.js', 'r', encoding='utf-8') as f:
    content = f.read()

content, c1 = re.subn(
    r'<div class="row">\s*<button class="btn primary grow" id="addMat">.*?</button>\s*<button class="btn ghost" id="printMat".*?</button>\s*</div>',
    r'''<button class="btn primary block" id="addMat">＋ Nuovo materiale</button>
      <div class="row pdfbar">
        <button class="btn" id="pOpen">📄 Apri PDF</button>
        <button class="btn" id="pPrint">🖨 Stampa</button>
        <button class="btn" id="pShare">📤 Condividi</button>
      </div>''',
    content,
    flags=re.DOTALL
)

content, c2 = re.subn(
    r'\$\("#printMat"\) && \(\$\("#printMat"\)\.onclick = async \(\) => \{.*?\n    \}\);',
    r'''const makePdf = () => pdf.materialiPdf({ materiali: currentList, operatoreStampa: ME.nome });
    $("#pOpen") && ($("#pOpen").onclick = () => { pdf.openPdf(makePdf()); });
    $("#pPrint") && ($("#pPrint").onclick = () => { pdf.printPdf(makePdf()); });
    $("#pShare") && ($("#pShare").onclick = () => { pdf.sharePdf(makePdf()); });''',
    content,
    flags=re.DOTALL
)

if c1 > 0 and c2 > 0:
    with open('js/app.js', 'w', encoding='utf-8') as f:
        f.write(content)
    print('SUCCESS')
else:
    print(f'FAILED: c1={c1}, c2={c2}')
