import sys
import re

with open('js/app.js', 'r', encoding='utf-8') as f:
    content = f.read()

target = """      <div class="row">
        <button class="btn primary grow" id="addMat">＋ Nuovo materiale</button>
        <button class="btn ghost" id="printMat" title="Stampa elenco materiali in uso">🖨 Stampa elenco</button>
      </div>"""

replacement = """      <button class="btn primary block" id="addMat">＋ Nuovo materiale</button>
      <div class="row pdfbar">
        <button class="btn" id="pOpen">📄 Apri PDF</button>
        <button class="btn" id="pPrint">🖨 Stampa</button>
        <button class="btn" id="pShare">📤 Condividi</button>
      </div>"""

target2 = """    $("#printMat") && ($("#printMat").onclick = async () => {
      const { doc, filename } = pdf.materialiPdf({ materiali: currentList, operatoreStampa: ME.nome });
      const acts = [
        { label: "Apri / Salva PDF", val: "open" },
        { label: "Stampa (AirPrint/Stampante)", val: "print" },
        { label: "Condividi (WhatsApp/Email)", val: "share" }
      ];
      const sc = await actionSheet(acts);
      if (sc === "open") await pdf.openPdf({ doc, filename });
      if (sc === "print") await pdf.printPdf({ doc, filename });
      if (sc === "share") await pdf.sharePdf({ doc, filename });
    });"""

replacement2 = """    const makePdf = () => pdf.materialiPdf({ materiali: currentList, operatoreStampa: ME.nome });
    $("#pOpen") && ($("#pOpen").onclick = () => { pdf.openPdf(makePdf()); });
    $("#pPrint") && ($("#pPrint").onclick = () => { pdf.printPdf(makePdf()); });
    $("#pShare") && ($("#pShare").onclick = () => { pdf.sharePdf(makePdf()); });"""

if target in content and target2 in content:
    content = content.replace(target, replacement)
    content = content.replace(target2, replacement2)
    with open('js/app.js', 'w', encoding='utf-8') as f:
        f.write(content)
    print('SUCCESS')
else:
    print('TARGET NOT FOUND')
