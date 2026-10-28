# Developer tools and current feature coverage

## Laravel Artisan panel

Laravel projects only show the **Artisan** action. The app identifies Laravel from its `artisan` file and Laravel bootstrap or Composer manifest. It runs migrations, database seeding, cache clearing, and a queue worker from the site root using that site's selected PHP executable. Output streams into the panel. The queue worker can be stopped there; one-shot commands stop after five minutes, and a runaway command is terminated if its output exceeds 512 KiB.

The main process accepts only the four named action IDs. It resolves the registered site's directory, verifies that it is a Laravel project, and starts PHP with an argument array (no shell). Add new commands to `src/laravelManager.js`'s `COMMANDS` map only when their behavior and runtime limits are understood.

## Adding Laravel projects

Choose **Laravel Project (Composer install)** in Add Site. The app checks the selected folder before enabling the action. An empty folder is populated with the current `laravel/laravel` project using Composer; an existing Laravel project with no `vendor/autoload.php` gets `composer install`. A non-empty folder without Laravel is rejected without changing its contents. Composer output is shown in the dialog, and the site is registered only after Laravel and its Composer dependencies are verified. If Composer is missing from `PATH`, the app downloads the official stable PHAR and verifies its SHA-256 checksum before running it. Installation requires PHP and an internet connection. For empty folders, Composer installs into a temporary sibling directory and moves the completed project into place so an interrupted download does not leave a partial project in the selected folder.

## Laravel Vite/HMR through NGINX

When a running Laravel site has a local Vite `public/hot` file, the app detects its loopback URL and port, updates the Laravel hot-file URL to the site's `.test` domain, and generates NGINX proxy locations for Vite modules, resources, and the HMR WebSocket. A lightweight poll notices Vite starting, stopping, or changing ports and reloads the site proxy only when that state changes. The app stores the original hot-file URL and restores it during clean shutdown. This requires the app-managed NGINX reverse proxy; direct PHP ports do not provide this domain-based routing.

## Tray controls

Right-click the tray icon for individual Start/Stop actions for NGINX, the database server, and the PHP runtime; Start All / Stop All; a submenu of running site domains; and a shortcut to the in-app Server Logs panel. The tray refreshes service and site status when its context menu is opened.

## Local proxy bypass

Electron's embedded browser is configured to bypass the operating system proxy for loopback, `.test`, and `.localhost` hosts. The Settings page also has a **Fix local proxy bypass** action for Chrome and other Windows applications. After confirmation, it adds local address patterns and the registered site domains to the current user's Windows `ProxyOverride` registry value while preserving existing entries. Proxy bypass lists affect system-proxy mode; V2Ray TUN/transparent routing needs a direct route in that client's routing rules. Running sites also have a **Direct :port** action that opens the PHP listener via loopback.

For NekoBox TUN, Settings can copy `domain:<site-domain>` rules for all registered sites. Add those lines to the active NekoBox route profile's **Direct** rules, save the profile, then reconnect TUN. NekoBox does not expose a supported external API for another app to change its active route profile.

## Per-site PHP and NGINX FastCGI

Site settings now include a **PHP Request Handler** option. The compatible built-in server remains the default. Selecting **NGINX FastCGI** starts a dedicated `php-cgi.exe` worker for that site's chosen PHP binary, assigns it a free loopback port, and generates an NGINX document-root/PHP FastCGI virtual host. The selected Windows PHP package must include `php-cgi.exe` beside `php.exe`; the application reports a clear error if it does not. The ordinary site listener remains available for direct-port access and public sharing.

## Mailpit-compatible local inbox

The app's embedded inbox captures SMTP directly on the configured local port and presents messages inside the Mail panel. The server handles SMTP commands split across network packets, multipart message bodies, dot-stuffing, message-size limits, and common client capability negotiation. It does not require Docker or a separate Mailpit process; legacy MailCatcher settings continue to work.

## Public tunnels

The Share action can use `auto`, `cloudflare`, or `ngrok`. Ngrok requires its CLI and an authtoken; install `ngrok.exe` on PATH or place it in `%APPDATA%\c-script-localhost\bin`. The token may be entered for that launch or supplied through `NGROK_AUTHTOKEN`; it is passed to the child process environment and is not written to the app settings file. Auto mode retains the existing SSH/Cloudflare fallback behavior.

## Trusted local HTTPS

The NGINX settings panel has an explicit **Create trusted certificate** action. It uses mkcert to install a current-user local CA and issue the `.test` wildcard certificate. Since `mkcert -install` changes the user's trust store, the UI asks for confirmation before invoking it. Install `mkcert.exe` on PATH first. The existing self-signed certificate generation remains the fallback for automatic local HTTPS when mkcert has not been set up.

## Live daemon logs

Server Logs now tails appended lines from the app-managed NGINX error/access logs, MariaDB/MySQL error logs, and per-site PHP error logs. PHP servers are started with error logging directed to `%APPDATA%\c-script-localhost\logs\php`; the UI receives new entries live. File rotation/truncation is detected, and newly created log files are discovered while the panel is running. Existing process and service events remain in the same log view.

## Remaining integration scope

The existing command palette, dark/light themes, dashboard indicators, database viewer, Laravel-only Artisan panel, automatic Laravel Vite HMR proxying, port detection, tray controls, local proxy bypass, and Cloudflare/SSH tunneling remain available. Mail and database panels are embedded renderer views rather than bundled third-party web applications. Downloading/bundling optional third-party binaries (mkcert and ngrok) remains separate follow-up work. Cloudflare Tunnel uses `cloudflared` when available; Ngrok requires the user's own executable and account token.
