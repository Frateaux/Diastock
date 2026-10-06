const CACHE_NAME = "diastock-v7";
const ASSETS = [
  "./",
  "./index.html",
  "./style.css",
  "./manifest.json",
  "./config.js",
  "./js/app.js",
  "./js/db.js",
  "./js/cloud.js",
  "./js/scanner.js",
  "./js/pdf.js",
  "./lib/supabase.js",
  "./lib/html5-qrcode.min.js",
  "./lib/jspdf.umd.min.js",
  "./lib/jspdf.plugin.autotable.min.js",
  "./icons/favicon-32.png",
  "./icons/icon-180.png",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/icon-maskable-512.png"
];

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  // Ignora le chiamate API Supabase dal caching del Service Worker (gestite dal DB locale)
  if (e.request.url.includes("supabase.co") || e.request.method !== "GET") {
    return;
  }

  e.respondWith(
    caches.match(e.request).then((cached) => {
      if (cached) return cached;
      return fetch(e.request).then((res) => {
        if (!res || res.status !== 200 || res.type !== "basic") {
          return res;
        }
        const clone = res.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(e.request, clone));
        return res;
      }).catch(() => {
        if (e.request.destination === "document") {
          return caches.match("./index.html");
        }
      });
    })
  );
});

self.addEventListener("push", (e) => {
  let data = { title: "Diastock", body: "Nuovo aggiornamento", url: "./#notifiche" };
  try {
    if (e.data) {
      data = Object.assign(data, e.data.json());
    }
  } catch (err) {
    if (e.data) data.body = e.data.text();
  }

  const opts = {
    body: data.body,
    icon: "icons/icon-192.png",
    badge: "icons/favicon-32.png",
    tag: data.tag || "diastock-alert",
    data: { url: data.url || "./#notifiche" }
  };

  e.waitUntil(self.registration.showNotification(data.title, opts));
});

self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const urlToOpen = e.notification.data?.url || "./#notifiche";

  e.waitUntil(
    clients.matchAll({ type: "window", includeUncontrolled: true }).then((windowClients) => {
      for (const client of windowClients) {
        if ("focus" in client) {
          client.postMessage({ url: urlToOpen });
          return client.focus();
        }
      }
      if (clients.openWindow) {
        return clients.openWindow(urlToOpen);
      }
    })
  );
});
