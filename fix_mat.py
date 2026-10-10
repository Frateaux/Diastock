import sys
with open('js/app.js', 'r', encoding='utf-8') as f:
    content = f.read()

target = """    const draw = () => {
      const ql = ($("#q")?.value || "").toLowerCase();
      const baseList = filtro === "attivi" ? attivi : filtro === "dismessi" ? dismessi : mats;
      const list = baseList.filter((m) => !ql || `${m.nome} ${m.categoria} ${m.barcode}`.toLowerCase().includes(ql));"""

replacement = """    let currentList = mats;
    const draw = () => {
      const ql = ($("#q")?.value || "").toLowerCase();
      const baseList = filtro === "attivi" ? attivi : filtro === "dismessi" ? dismessi : mats;
      const list = baseList.filter((m) => !ql || `${m.nome} ${m.categoria} ${m.barcode}`.toLowerCase().includes(ql));
      currentList = list;"""

target2 = """  $("#printMat") && ($("#printMat").onclick = async () => {
    const { doc, filename } = pdf.materialiPdf({ materiali: mats, operatoreStampa: ME.nome });"""

replacement2 = """  $("#printMat") && ($("#printMat").onclick = async () => {
    const { doc, filename } = pdf.materialiPdf({ materiali: currentList, operatoreStampa: ME.nome });"""

if target in content and target2 in content:
    content = content.replace(target, replacement)
    content = content.replace(target2, replacement2)
    with open('js/app.js', 'w', encoding='utf-8') as f:
        f.write(content)
    print('SUCCESS')
else:
    print('TARGET NOT FOUND')
