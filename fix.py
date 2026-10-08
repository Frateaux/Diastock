import sys
with open('js/app.js', 'r', encoding='utf-8') as f:
    content = f.read()

target = """<a class="line link" href="#impostazioni"><div class="info"><b>⚙ Impostazioni e backup</b></div></a>
  </div>"""

replacement = """<a class="line link" href="#impostazioni"><div class="info"><b>⚙ Impostazioni e backup</b></div></a>
  </div>
  <button class="btn block ghost" id="forceUpdateApp" style="margin-top: 12px; color: #0284c7;">🔄 Forza aggiornamento App</button>"""

target2 = """<p class="muted center">Diastock v1.0 · ${esc(ME.nome)}</p>`;
};"""

replacement2 = """<p class="muted center">Diastock v1.0 · ${esc(ME.nome)}</p>`;

  const btn = document.querySelector("#forceUpdateApp");
  if (btn) {
    btn.onclick = async () => {
      try {
        if ('serviceWorker' in navigator) {
          const regs = await navigator.serviceWorker.getRegistrations();
          for (const r of regs) await r.unregister();
        }
        window.location.reload(true);
      } catch (e) {
        window.location.reload();
      }
    };
  }
};"""

if target in content and target2 in content:
    content = content.replace(target, replacement)
    content = content.replace(target2, replacement2)
    with open('js/app.js', 'w', encoding='utf-8') as f:
        f.write(content)
    print('SUCCESS')
else:
    print('TARGET NOT FOUND')
