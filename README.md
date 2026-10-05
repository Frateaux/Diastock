# Diastock 🩺📦

**Diastock** è una Progressive Web App (PWA) progettata per la gestione e l'inventario del magazzino emodialisi, operante in modalità **offline-first** (ideale per magazzini situati nei piani interrati privi di connettività internet).

---

## 🌟 Funzionalità Principali

1. **Funzionamento Offline-First**:
   - Tutte le anagrafiche, gli inventari e le operazioni sono memorizzati localmente sul dispositivo (IndexedDB).
   - Le modifiche vengono registrate in una coda di sincronizzazione (*outbox*).
   - Al ripristino della connettività internet, i dati vengono sincronizzati automaticamente su **Supabase**, assegnando numeri progressivi ufficiali agli inventari e inviando le notifiche.

2. **Scansione Barcode**:
   - Lettura con fotocamera dello smartphone (Android e iPhone) di codici a barre alfanumerici (Code 128, EAN, Code 39, ecc.).
   - Supporto anche per digitazione manuale o lettori laser/Bluetooth.
   - Al primo rilevamento di una nuova scatola, l'app richiede la configurazione iniziale (nome, pezzi per scatola, categoria).
   - Possibilità di incremento automatico (+1 scatola a ogni scansione) oppure richiesta puntuale del numero di scatole.

3. **Inventario e Controllo Rigoroso**:
   - Conteggio per scatole intere.
   - Alla chiusura dell'inventario, il sistema verifica la presenza di **materiali in archivio non ancora rilevati**:
     - Scansiona la scatola
     - Inserisci a mano la giacenza
     - Segna "Non necessario" per quel solo inventario (con motivo opzionale)

4. **Tracciabilità e Ruoli**:
   - Ogni registrazione, inventario o modifica è associata all'operatore che l'ha effettuata, con orario e ID del dispositivo.
   - **Operatore**: esegue inventari, censisce materiali, visualizza giacenze e stampa PDF.
   - **Master (Coordinatore)**: definisce le **scorte minime** per ogni materiale, riceve alert dedicati sotto-scorta e gestisce/abilita i profili degli altri operatori.

5. **Notifiche e PDF**:
   - Notifiche in-app su inventari completati (con numero, data e nome operatore) e alert materiali sotto scorta minima.
   - Generazione offline ed esportazione/stampa/condivisione di PDF riepilogativi (sia per inventario sia per giacenze totali).
   - Supporto a notifiche Web Push (Edge Function inclusa per Supabase).

---

## 🚀 Guida di Configurazione Rapida

### 1. Database Supabase
1. Crea un progetto su [Supabase](https://supabase.com).
2. Vai su **SQL Editor** > **New Query**, incolla ed esegui il contenuto del file [`supabase/schema.sql`](supabase/schema.sql).
3. Dopo la registrazione del primo account (il coordinatore), esegui nel SQL Editor:
   ```sql
   update public.profiles
   set ruolo = 'master', attivo = true
   where email = 'tua_email@esempio.it';
   ```

### 2. Configurazione Frontend
Apri il file [`config.js`](config.js) e inserisci l'URL e la Anon Key del tuo progetto Supabase:
```javascript
window.DIASTOCK_CONFIG = {
  SUPABASE_URL: "https://xyzcompany.supabase.co",
  SUPABASE_ANON_KEY: "eyJhbGciOi...",
  VAPID_PUBLIC_KEY: "" // Opzionale per Push Notification Web
};
```
*(Se lasciati vuoti, l'app funziona comunque in **modalità locale standalone** per prove e demo senza cloud)*.

### 3. Pubblicazione su GitHub Pages
1. Crea un repository GitHub chiamato `Diastock`.
2. Inizializza git e carica i file:
   ```bash
   git init
   git add .
   git commit -m "Initial commit Diastock"
   git branch -M main
   git remote add origin https://github.com/<TUO_UTENTE>/Diastock.git
   git push -u origin main
   ```
3. Vai nelle impostazioni del repository su GitHub: **Settings** > **Pages** > sotto **Build and deployment** seleziona come sorgente il branch `main` e la cartella `/ (root)`.
4. Apri l'indirizzo generato da GitHub Pages sul tuo smartphone (Chrome su Android o Safari su iPhone) e seleziona **"Aggiungi alla schermata Home"** per installare l'app PWA a schermo intero.

---

## 📁 Struttura del Progetto

```
Diastock/
├── index.html            # Shell applicativa SPA e PWA
├── style.css             # UI ottimizzata per mobile e tablet
├── manifest.json         # Configurazione PWA installabile
├── sw.js                 # Service Worker (offline cache e Web Push)
├── config.js             # Parametri di connessione Supabase
├── js/
│   ├── app.js            # Router, logica inventario, viste e dialoghi
│   ├── db.js             # Gestione IndexedDB e coda outbox offline
│   ├── cloud.js          # Sincronizzazione atomica, auth e audit
│   ├── scanner.js        # Modulo fotocamera e scansione barcode
│   └── pdf.js            # Generazione e stampa PDF offline
├── lib/
│   ├── supabase.js       # Supabase JS SDK (offline-safe bundle)
│   ├── html5-qrcode.min.js # Riconoscimento barcode 1D/2D
│   ├── jspdf.umd.min.js  # Motore PDF client-side
│   └── jspdf.plugin.autotable.min.js
└── supabase/
    ├── schema.sql        # Tabelle Postgres, RLS, Trigger e RPC atomiche
    └── functions/
        └── send-push/    # Edge Function per notifiche push Web VAPID
```
