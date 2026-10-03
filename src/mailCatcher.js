/**
 * MailCatcher - Lightweight Built-in SMTP Server for Local Mail Testing
 * Listens on port 1025 (standard SMTP port) and captures test emails from PHP mail() / Laravel
 * Supports MIME decoding, Multipart (HTML & Text), Quoted-Printable, and Base64.
 */

const net = require('net');
const { EventEmitter } = require('events');

function decodeQuotedPrintable(str) {
  if (!str) return '';
  return str
    .replace(/=\r?\n/g, '')
    .replace(/=([0-9A-Fa-f]{2})/g, (match, hex) => String.fromCharCode(parseInt(hex, 16)));
}

function decodeMimeHeader(str) {
  if (!str) return '';
  return str.replace(/=\?([^?]+)\?([BQbq])\?([^?]+)\?=/g, (match, charset, enc, content) => {
    try {
      if (enc.toUpperCase() === 'B') {
        return Buffer.from(content, 'base64').toString('utf8');
      } else if (enc.toUpperCase() === 'Q') {
        return decodeQuotedPrintable(content.replace(/_/g, ' '));
      }
    } catch (e) {}
    return match;
  });
}

class MailCatcher extends EventEmitter {
  constructor(port = 1025) {
    super();
    this.port = port;
    this.server = null;
    this.emails = [];
    this.maxEmails = 100;
    this.running = false;
  }

  start() {
    if (this.running) return Promise.resolve({ success: true, port: this.port });

    return new Promise((resolve) => {
      this.server = net.createServer((socket) => {
        let state = 'INIT';
        let currentEmail = {
          id: `email_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`,
          receivedAt: new Date().toISOString(),
          date: new Date().toISOString(),
          from: '',
          to: [],
          raw: '',
          subject: '',
          body: '',
          text: '',
          html: ''
        };

        socket.write('220 C-Script LocalHost Panel MailCatcher Ready\r\n');

        let dataBuffer = '';

        socket.on('data', (chunk) => {
          const text = chunk.toString();

          if (state === 'DATA') {
            dataBuffer += text;
            if (dataBuffer.includes('\r\n.\r\n') || dataBuffer.endsWith('\r\n.')) {
              currentEmail.raw = dataBuffer;
              this._parseEmail(currentEmail);
              this._addEmail(currentEmail);
              this.emit('email', currentEmail);
              state = 'COMMAND';
              dataBuffer = '';
              socket.write('250 OK: Message received\r\n');
            }
            return;
          }

          const lines = text.split('\r\n');
          for (const line of lines) {
            const cmd = line.trim().toUpperCase();
            if (!cmd) continue;

            if (cmd.startsWith('HELO') || cmd.startsWith('EHLO')) {
              socket.write('250 Hello localhost\r\n');
            } else if (cmd.startsWith('MAIL FROM:')) {
              currentEmail.from = line.substring(10).trim().replace(/[<>]/g, '');
              socket.write('250 Sender OK\r\n');
            } else if (cmd.startsWith('RCPT TO:')) {
              currentEmail.to.push(line.substring(8).trim().replace(/[<>]/g, ''));
              socket.write('250 Recipient OK\r\n');
            } else if (cmd === 'DATA') {
              state = 'DATA';
              socket.write('354 Start mail input; end with <CRLF>.<CRLF>\r\n');
            } else if (cmd === 'QUIT') {
              socket.write('221 Bye\r\n');
              socket.end();
            } else if (cmd === 'RSET') {
              currentEmail = {
                id: `email_${Date.now()}`,
                receivedAt: new Date().toISOString(),
                date: new Date().toISOString(),
                from: '',
                to: [],
                raw: '',
                subject: '',
                body: '',
                text: '',
                html: ''
              };
              socket.write('250 Reset OK\r\n');
            } else if (cmd === 'NOOP') {
              socket.write('250 OK\r\n');
            } else {
              socket.write('250 OK\r\n');
            }
          }
        });

        socket.on('error', () => {});
      });

      this.server.once('error', (err) => {
        this.running = false;
        resolve({ success: false, error: err.message });
      });

      this.server.listen(this.port, '127.0.0.1', () => {
        this.running = true;
        resolve({ success: true, port: this.port });
      });
    });
  }

  stop() {
    return new Promise((resolve) => {
      if (!this.server || !this.running) return resolve({ success: true });
      this.server.close(() => {
        this.running = false;
        this.server = null;
        resolve({ success: true });
      });
    });
  }

  getStatus() {
    return {
      running: this.running,
      port: this.port,
      emailCount: this.emails.length
    };
  }

  getEmails() {
    return [...this.emails];
  }

  getEmail(id) {
    return this.emails.find(e => e.id === id) || null;
  }

  clearEmails() {
    this.emails = [];
    return { success: true };
  }

  _addEmail(email) {
    this.emails.unshift(email);
    if (this.emails.length > this.maxEmails) {
      this.emails.pop();
    }
  }

  _parseEmail(email) {
    const raw = email.raw;
    const headerEnd = raw.indexOf('\r\n\r\n');
    let headers = '';
    let body = raw;

    if (headerEnd !== -1) {
      headers = raw.substring(0, headerEnd);
      body = raw.substring(headerEnd + 4);
    }

    const subjectMatch = headers.match(/^Subject:\s*(.*)$/im);
    if (subjectMatch) {
      email.subject = decodeMimeHeader(subjectMatch[1].trim());
    } else {
      email.subject = '(No Subject)';
    }

    const fromMatch = headers.match(/^From:\s*(.*)$/im);
    if (fromMatch && !email.from) {
      email.from = decodeMimeHeader(fromMatch[1].trim().replace(/[<>]/g, ''));
    }

    const toMatch = headers.match(/^To:\s*(.*)$/im);
    if (toMatch && email.to.length === 0) {
      email.to = [decodeMimeHeader(toMatch[1].trim().replace(/[<>]/g, ''))];
    }

    const dateMatch = headers.match(/^Date:\s*(.*)$/im);
    if (dateMatch) {
      email.date = new Date(dateMatch[1].trim()).toISOString();
    }

    // Clean terminating period from SMTP DATA
    body = body.replace(/\r\n\.\r\n$/, '').replace(/\r\n\.$/, '');

    // Check for multipart MIME boundary
    const boundaryMatch = headers.match(/boundary=["']?([^"';\r\n]+)["']?/i);
    if (boundaryMatch) {
      const boundary = boundaryMatch[1];
      const parts = body.split(new RegExp(`--${boundary.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&')}`));
      for (const part of parts) {
        if (!part || part.trim() === '' || part.trim() === '--') continue;
        const partHeaderEnd = part.indexOf('\r\n\r\n');
        if (partHeaderEnd !== -1) {
          const partHeaders = part.substring(0, partHeaderEnd);
          let partBody = part.substring(partHeaderEnd + 4).trim();
          const isHtml = /content-type:\s*text\/html/i.test(partHeaders);
          const isBase64 = /content-transfer-encoding:\s*base64/i.test(partHeaders);
          const isQP = /content-transfer-encoding:\s*quoted-printable/i.test(partHeaders);

          if (isBase64) {
            try { partBody = Buffer.from(partBody.replace(/\s+/g, ''), 'base64').toString('utf8'); } catch (e) {}
          } else if (isQP) {
            partBody = decodeQuotedPrintable(partBody);
          }

          if (isHtml) {
            email.html = partBody;
          } else if (!email.body) {
            email.body = partBody;
            email.text = partBody;
          }
        }
      }
    } else {
      const isHtml = /content-type:\s*text\/html/i.test(headers);
      const isBase64 = /content-transfer-encoding:\s*base64/i.test(headers);
      const isQP = /content-transfer-encoding:\s*quoted-printable/i.test(headers);

      if (isBase64) {
        try { body = Buffer.from(body.replace(/\s+/g, ''), 'base64').toString('utf8'); } catch (e) {}
      } else if (isQP) {
        body = decodeQuotedPrintable(body);
      }

      if (isHtml) {
        email.html = body;
      }
      email.body = body;
      email.text = body;
    }
  }
}

module.exports = MailCatcher;
