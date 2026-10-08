import sys
with open('js/app.js', 'r', encoding='utf-8') as f:
    content = f.read()

target = """    const acts = [{ label: "Apri / Salva PDF", val: "open" }];
    if (pdf.pushAvailable()) acts.push({ label: "Stampa (AirPrint/Stampante)", val: "print" }, { label: "Condividi (WhatsApp/Email)", val: "share" });
    const sc = await actionSheet(acts);"""

replacement = """    const acts = [
      { label: "Apri / Salva PDF", val: "open" },
      { label: "Stampa (AirPrint/Stampante)", val: "print" },
      { label: "Condividi (WhatsApp/Email)", val: "share" }
    ];
    const sc = await actionSheet(acts);"""

if target in content:
    content = content.replace(target, replacement)
    with open('js/app.js', 'w', encoding='utf-8') as f:
        f.write(content)
    print('SUCCESS')
else:
    print('TARGET NOT FOUND')
