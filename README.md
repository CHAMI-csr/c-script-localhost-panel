# ⚡ C-Script LocalHost Panel

<p align="center">
  <img src="assets/icon.png" alt="C-Script LocalHost Panel Logo" width="110" height="110" style="border-radius: 22px; box-shadow: 0 10px 30px rgba(0,0,0,0.3);">
</p>

<p align="center">
  <strong>Modern, High-Performance Local Development Environment for PHP, NGINX & MySQL on Windows</strong><br>
  <em>A fast, lightweight, all-in-one local development environment for Windows.</em>
</p>

<p align="center">
  <a href="https://github.com/CHAMI-csr"><img src="https://img.shields.io/badge/Developer-Chamika%20Sandeepa-7c6af7.svg?style=for-the-badge&logo=github" alt="Developer"></a>
  <img src="https://img.shields.io/badge/Platform-Windows%2010%20%7C%2011-0078d4.svg?style=for-the-badge&logo=windows" alt="Platform">
  <img src="https://img.shields.io/badge/Electron-44.4.5-47848F.svg?style=for-the-badge&logo=electron" alt="Electron">
  <img src="https://img.shields.io/badge/Node.js-v26.8-339933.svg?style=for-the-badge&logo=node.js" alt="Node">
  <img src="https://img.shields.io/badge/License-MIT-green.svg?style=for-the-badge" alt="License">
</p>

---

## 🌟 Overview

**C-Script LocalHost Panel** is an all-in-one local web development suite designed specifically for Windows developers, with a self-managed PHP, NGINX, and MySQL stack.

No more configuring ports manually, no more wrestling with broken virtual hosts, and no more losing your PHP or MySQL runtimes when other software is uninstalled.

---

## ✨ Key Features

### 🐘 Multi-Version PHP Engine
* **Instant 1-Click Switcher:** Switch between PHP 8.1, 8.2, 8.3, 8.4, and 8.5 with a single click.
* **Pre-configured Extensions:** Ships with essential extensions enabled out of the box (`curl`, `mysqli`, `pdo_mysql`, `mbstring`, `openssl`, `gd`, `zip`, `fileinfo`, `exif`).
* **Optimized Limits:** Ready for modern frameworks (Laravel, Symfony, WordPress) with `128M` upload and `512M` memory limits.
* **1-Click Official Downloader:** Download official PHP binaries from `windows.php.net` directly through the app.

### 🌐 Standalone NGINX Web Server
* **Zero Port Clutter:** Access all your local projects via clean, custom `.test` domains (e.g., `http://myproject.test`) without typing `:8000` or `:3000`.
* **Automated Reverse Proxy:** NGINX handles traffic automatically and routes requests directly to the corresponding PHP-FPM / CLI server.
* **Automatic Virtual Host Generation:** Drop a folder into your sites directory and a customized NGINX vhost is created automatically.

### 🔒 Automated Local Wildcard SSL (HTTPS)
* **Pre-configured Wildcard Certificates:** Full local HTTPS support for `*.test` domains.
* **Zero Browser Warnings:** Modern secure HTTPS browsing right on `localhost`.

### 🗄️ MySQL & MariaDB Database Studio
* **Native & Portable Support:** Seamlessly detects existing Windows MySQL services (e.g. `MySQL80` on port 3306) OR offers a 1-click portable MariaDB 11.4 LTS standalone setup.
* **Built-in Database Studio:** Create, drop, and inspect databases and tables directly within the panel.
* **Live Query Editor:** Run raw SQL queries with syntax highlighting and instant JSON/CSV export.
* **Visual ER Diagram Generator:** Auto-generates interactive Entity-Relationship diagrams from your database schema with relationship foreign keys.
* **Laravel Migration Generator:** Export any database table directly into Laravel 11 migration code.

### 🚀 Instant Public Share to Web (Cloudflare Tunnel)
* **Zero Port-Forwarding:** Share your local project with clients or test on mobile devices in 3 seconds.
* **Free & Secure:** Powered by Cloudflare Tunnel (`trycloudflare.com`) with zero account or token configuration needed.

### 📬 Local SMTP Mail Catcher
* **Built-in Test Inbox:** Catches all outgoing emails from PHP `mail()` and SMTP on port `1025`.
* **Live Email Viewer:** Inspect HTML templates, plain text, headers, and attachments without spamming real inboxes.

### 🔍 Port & Service Manager
* **Live Port Scanner:** Inspect which processes are occupying ports `80`, `443`, `3306`, etc.
* **1-Click Conflict Killer:** Safely kill conflicting processes blocking your web server or database.

### 🎨 Developer Experience (DX)
* **Command Palette (`Ctrl + K`):** Quick jump to any panel, action, or setting instantly.
* **Multiple Themes:** Dark, Dracula, Nord, and Monokai themes.
* **Embedded Web View:** Test and preview your sites without leaving the app.

---

## 📦 All-in-One Offline Architecture

Unlike other panels that require downloading components over the internet after installation, **C-Script LocalHost Panel** comes pre-bundled with an **All-in-One Offline Stack**:

```text
C:\Users\<Your-Username>\AppData\Roaming\c-script-localhost\
  ├── php\
  │   └── php84\            (PHP 8.4 runtime, php.ini, extensions)
  ├── nginx\
  │   ├── conf\vhosts\      (Automated virtual host configs)
  │   ├── logs\             (Server access and error logs)
  │   └── nginx.exe         (NGINX web server)
  ├── mysql\
  │   ├── data\             (Databases & storage engine)
  │   ├── bin\mysqld.exe    (MySQL / MariaDB database server)
  │   └── my.ini            (Dynamic user configuration)
  ├── ssl\                  (Wildcard *.test SSL certificates)
  └── bin\                  (Cloudflare Tunnel binary)
```

> **Why `%APPDATA%\c-script-localhost`?**
> Standard Windows permissions allow PHP, NGINX, and MySQL to create logs, virtual hosts, and database tables without constantly requiring Administrator UAC elevation prompts.

---

## 🚀 Installation

### Option 1: Download Pre-built Executable (Recommended)
1. Go to the [Releases](https://github.com/CHAMI-csr) section on GitHub.
2. Download **`C-Script LocalHost Panel Setup 1.1.0.exe`** (Standard Installer) or **`C-Script LocalHost Panel 1.1.0.exe`** (Portable).
3. Run the installer — PHP, NGINX, and MySQL will be initialized automatically in seconds.

### Option 2: Build From Source

#### Prerequisites
* [Node.js](https://nodejs.org/) (v18 or higher recommended)
* [Git](https://git-scm.com/)

```bash
# 1. Clone the repository
git clone https://github.com/CHAMI-csr/c-script-localhost-panel.git

# 2. Enter project folder
cd c-script-localhost-panel

# 3. Install dependencies
npm install

# 4. Start in development mode
npm start
```

---

## 🔨 Packaging into `.exe` (Production Build)

To build the standalone Windows installer and portable executable:

```bash
npm run dist
```

The compiled binaries will be output to the `dist/` directory:
* `dist/C-Script LocalHost Panel Setup 1.1.0.exe` (NSIS Installer)
* `dist/C-Script LocalHost Panel 1.1.0.exe` (Portable Single Executable)

---

## 🛠️ Tech Stack

| Technology | Purpose |
| :--- | :--- |
| **Electron 44** | Native desktop cross-platform framework |
| **Node.js** | Core service orchestration & file management |
| **PHP 8.x** | FastCGI / CLI execution runtime |
| **NGINX 1.26** | Reverse proxy, static file server & SSL terminator |
| **MySQL / MariaDB** | Relational database management system |
| **Cloudflare Tunnel** | Public internet sharing without port forwarding |
| **MySQL2** | Pure JavaScript native MySQL client for Electron |
| **Vanilla JS & CSS3** | Ultra-responsive, zero-framework lightweight UI |

---

## 👨‍💻 Developer & Author

* **Lead Developer:** **Chamika Sandeepa**
* **GitHub:** [@CHAMI-csr](https://github.com/CHAMI-csr)

---

## 📄 License

This project is licensed under the **MIT License** — feel free to use, modify, and distribute it for personal and commercial projects.
