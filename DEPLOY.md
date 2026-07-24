# Deploying the WATI cleaner on a VPS

## Project layout

```
wati_cleanup/
├── frontend/            static assets (legacy standalone HTML)
├── backend/
│   ├── python/          app.py + wati_cleanup.py — the CSV cleaning logic
│   │                    and htmx UI, listens on 127.0.0.1:8000
│   └── node/            Express front door + Mongoose/MongoDB,
│                        listens on 3000, proxies everything to the
│                        Python backend
└── deploy/              systemd units + Nginx config
```

Request flow: **Internet → Nginx (80/443) → Express (3000) → Python (8000)**.
The Python process does the actual CSV work and never needs a public port.
The Node layer is where new project features (auth, extra APIs, MongoDB
persistence) get added going forward, without touching the Python code.

State in the Python app is per-browser (cookie session), kept in memory, and
evicted after 2h idle. Because state is in-process memory, run it as a
**single process** (do not scale to multiple workers, or a user's session
could land on a worker that doesn't have it).

Requirements on the server: `python3` ≥ 3.8 (stdlib only, no pip installs),
Node.js ≥ 18, and MongoDB running locally (or a `MONGODB_URI` pointing at one).

---

## 1. Copy the code to the server

```bash
# from your machine
scp -r frontend backend deploy user@YOUR_SERVER:/tmp/wati/

# on the server
sudo mkdir -p /opt/wati_cleanup
sudo cp -r /tmp/wati/frontend /tmp/wati/backend /opt/wati_cleanup/
sudo chown -R www-data:www-data /opt/wati_cleanup
```

## 2. Install Node dependencies

```bash
cd /opt/wati_cleanup/backend/node
sudo -u www-data npm install --omit=dev
```

## 3. Run both processes as services (systemd)

```bash
sudo cp /tmp/wati/deploy/wati.service /etc/systemd/system/wati.service
sudo cp /tmp/wati/deploy/wati-node.service /etc/systemd/system/wati-node.service
# edit either file if your paths / user / MONGODB_URI differ:
#   sudo nano /etc/systemd/system/wati.service
#   sudo nano /etc/systemd/system/wati-node.service
sudo systemctl daemon-reload
sudo systemctl enable --now wati
sudo systemctl enable --now wati-node
sudo systemctl status wati wati-node       # both should be "active (running)"
curl -s http://127.0.0.1:8000/health       # -> ok            (Python, internal)
curl -s http://127.0.0.1:3000/node-health  # -> {"ok":true,...} (Node front door)
```

Logs: `journalctl -u wati -f` and `journalctl -u wati-node -f`

## 4. Put Nginx in front

```bash
sudo apt install -y nginx
sudo cp /tmp/wati/deploy/nginx-wati.conf /etc/nginx/sites-available/wati
sudo nano /etc/nginx/sites-available/wati    # set your server_name (domain)
sudo ln -s /etc/nginx/sites-available/wati /etc/nginx/sites-enabled/wati
sudo nginx -t && sudo systemctl reload nginx
```

Now `http://YOUR_DOMAIN/` serves the app, routed through Express to Python.

## 5. HTTPS (recommended)

Point your domain's DNS A-record at the server, then:

```bash
sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d wati.example.com
```

Certbot rewrites the Nginx config for TLS and sets up auto-renewal.

## 6. Updating later

```bash
sudo cp -r new/backend/python/* /opt/wati_cleanup/backend/python/
sudo cp -r new/backend/node/* /opt/wati_cleanup/backend/node/
cd /opt/wati_cleanup/backend/node && sudo -u www-data npm install --omit=dev
sudo systemctl restart wati wati-node
```

---

## Notes / hardening

- **Access control**: the app has no login — anyone who reaches the URL can use it.
  If it should be private, add HTTP Basic Auth at the Nginx layer:
  ```bash
  sudo apt install -y apache2-utils
  sudo htpasswd -c /etc/nginx/.wati_htpasswd youruser
  ```
  then inside the `location / {}` block add:
  ```
  auth_basic "WATI cleaner";
  auth_basic_user_file /etc/nginx/.wati_htpasswd;
  ```
  `sudo nginx -t && sudo systemctl reload nginx`

- **Firewall**: only expose 80/443. Ports 8000 (Python) and 3000 (Node) stay
  on localhost.
  ```bash
  sudo ufw allow 'Nginx Full' && sudo ufw enable
  ```

- **MongoDB**: install and run it locally, or point `MONGODB_URI` (in
  `wati-node.service`) at a managed instance (e.g. MongoDB Atlas).

- **Tailwind CDN**: the page loads Tailwind from the Play CDN (fine for an internal
  tool). If you want zero external requests, we can inline a prebuilt CSS instead.

- **Single process only for Python** — see the note at the top about
  in-memory sessions. The Node layer can be scaled independently since it
  holds no per-browser state itself.
