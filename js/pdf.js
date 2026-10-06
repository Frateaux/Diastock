// Generazione PDF riepilogativi (offline, jsPDF + autotable)
const fmtDT = (s) => s ? new Date(s).toLocaleString("it-IT", { dateStyle: "short", timeStyle: "short" }) : "";
const ESITI = { scansionato: "Scansionato", manuale: "Manuale", non_necessario: "Non necessario" };

function header(doc, titolo, sotto) {
  doc.setFillColor(14, 116, 144);
  doc.rect(0, 0, 210, 22, "F");
  doc.setTextColor(255); doc.setFontSize(16); doc.setFont("helvetica", "bold");
  doc.text("Diastock", 14, 10);
  doc.setFontSize(10); doc.setFont("helvetica", "normal");
  doc.text("Magazzino Emodialisi", 14, 16);
  doc.setTextColor(20); doc.setFontSize(14); doc.setFont("helvetica", "bold");
  doc.text(titolo, 14, 32);
  doc.setFontSize(10); doc.setFont("helvetica", "normal");
  sotto.forEach((t, i) => doc.text(t, 14, 39 + i * 5));
  return 39 + sotto.length * 5 + 2;
}

function footer(doc, operatore) {
  const n = doc.getNumberOfPages();
  for (let i = 1; i <= n; i++) {
    doc.setPage(i); doc.setFontSize(8); doc.setTextColor(120);
    doc.text(`Generato il ${fmtDT(new Date().toISOString())} da ${operatore}`, 14, 290);
    doc.text(`Pagina ${i} di ${n}`, 196, 290, { align: "right" });
  }
}

export function inventarioPdf({ inv, righe, materiali, operatoreStampa }) {
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ unit: "mm", format: "a4" });
  const mat = new Map(materiali.map((m) => [m.id, m]));
  const num = inv.numero ? `n. ${inv.numero}` : "(numero provvisorio – in attesa di sincronizzazione)";
  let y = header(doc, `Inventario ${num}`, [
    `Operatore: ${inv.operatore_nome || ""}`,
    `Iniziato: ${fmtDT(inv.iniziato_at)}   –   Chiuso: ${fmtDT(inv.chiuso_at)}`,
    inv.note ? `Note: ${inv.note}` : "",
  ].filter(Boolean));

  const rows = righe.map((r) => ({ r, m: mat.get(r.materiale_id) || { nome: "?", barcode: "", scorta_minima: 0 } }))
    .sort((a, b) => (a.m.categoria || "").localeCompare(b.m.categoria || "") || a.m.nome.localeCompare(b.m.nome));

  const sotto = rows.filter(({ r, m }) => r.esito !== "non_necessario" && m.scorta_minima > 0 && r.scatole < m.scorta_minima);
  const nn = rows.filter(({ r }) => r.esito === "non_necessario");

  doc.setFontSize(10);
  doc.text(`Materiali rilevati: ${rows.length - nn.length}   Non necessari: ${nn.length}   Sotto scorta: ${sotto.length}`, 14, y + 2);

  doc.autoTable({
    startY: y + 6,
    head: [["Materiale", "Categoria", "Barcode", "Scatole", "Pz/sc", "Tot. pz", "Min (sc)", "Esito"]],
    body: rows.map(({ r, m }) => [
      m.nome, m.categoria || "", m.barcode,
      r.esito === "non_necessario" ? "–" : r.scatole,
      r.pezzi_per_scatola,
      r.esito === "non_necessario" ? "–" : r.scatole * r.pezzi_per_scatola,
      m.scorta_minima || "",
      ESITI[r.esito] + (r.motivo ? ` (${r.motivo})` : ""),
    ]),
    styles: { fontSize: 8, cellPadding: 1.6 },
    headStyles: { fillColor: [14, 116, 144] },
    columnStyles: { 3: { halign: "right" }, 4: { halign: "right" }, 5: { halign: "right" }, 6: { halign: "right" } },
    didParseCell: (d) => {
      if (d.section !== "body") return;
      const { r, m } = rows[d.row.index];
      if (r.esito === "non_necessario") d.cell.styles.textColor = [140, 140, 140];
      else if (m.scorta_minima > 0 && r.scatole < m.scorta_minima) {
        d.cell.styles.fillColor = [254, 226, 226]; d.cell.styles.textColor = [153, 27, 27];
      }
    },
  });

  if (sotto.length) {
    doc.autoTable({
      startY: doc.lastAutoTable.finalY + 8,
      head: [["Sotto scorta minima", "Giacenza (sc)", "Minimo (sc)", "Mancano (sc)"]],
      body: sotto.map(({ r, m }) => [m.nome, r.scatole, m.scorta_minima, m.scorta_minima - r.scatole]),
      styles: { fontSize: 9 }, headStyles: { fillColor: [185, 28, 28] },
    });
  }
  footer(doc, operatoreStampa);
  return { doc, filename: `Diastock_inventario_${inv.numero || "bozza"}.pdf` };
}

export function giacenzePdf({ giacenze, operatoreStampa }) {
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ unit: "mm", format: "a4" });
  const y = header(doc, "Giacenze attuali", [`Situazione al ${fmtDT(new Date().toISOString())}`]);
  doc.autoTable({
    startY: y + 2,
    head: [["Materiale", "Categoria", "Scatole", "Tot. pz", "Min (sc)", "Ultima rilevazione"]],
    body: giacenze.map((g) => [g.nome, g.categoria || "", g.scatole ?? "–", g.totale ?? "–",
      g.scorta_minima || "", g.rilevato_il ? `${fmtDT(g.rilevato_il)} (inv. ${g.inventario_numero || "bozza"})` : "mai"]),
    styles: { fontSize: 8, cellPadding: 1.6 },
    headStyles: { fillColor: [14, 116, 144] },
    didParseCell: (d) => {
      if (d.section === "body" && giacenze[d.row.index].sotto) {
        d.cell.styles.fillColor = [254, 226, 226]; d.cell.styles.textColor = [153, 27, 27];
      }
    },
  });
  footer(doc, operatoreStampa);
  return { doc, filename: `Diastock_giacenze_${new Date().toISOString().slice(0, 10)}.pdf` };
}

// --- azioni sul PDF ---
const isIOS = () => /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);

export async function openPdf({ doc, filename = "Diastock_documento.pdf" }) {
  const blob = doc.output("blob");
  const url = URL.createObjectURL(blob);
  
  if (isIOS()) {
    // Su iOS Safari spesso i blob in new window vengono bloccati o non mostrati:
    // proviamo ad aprire o condividere direttamente
    const w = window.open(url, "_blank");
    if (!w) {
      await sharePdf({ doc, filename });
    }
  } else {
    const w = window.open(url, "_blank");
    if (!w) location.href = url;
  }
}

export async function printPdf({ doc, filename = "Diastock_stampa.pdf" }) {
  if (isIOS()) {
    // Su iOS Safari non esiste window.print() su PDF embeddato:
    // il modo ufficiale Apple per stampare con AirPrint è il foglio di condivisione di sistema
    await sharePdf({ doc, filename });
  } else {
    doc.autoPrint();
    const url = doc.output("bloburl");
    const w = window.open(url, "_blank");
    if (!w) location.href = url;
  }
}

export async function sharePdf({ doc, filename }) {
  const blob = doc.output("blob");
  const file = new File([blob], filename, { type: "application/pdf" });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ files: [file], title: filename }); return; }
    catch (e) { if (e.name === "AbortError") return; }
  }
  doc.save(filename);
}
