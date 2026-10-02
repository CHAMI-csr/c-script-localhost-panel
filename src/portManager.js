/**
 * PortManager - Scans active listening ports and terminates processes holding ports
 */

const { exec } = require('child_process');
const util = require('util');
const execPromise = util.promisify(exec);

class PortManager {
  /**
   * Scan for all active TCP listening ports and the processes owning them
   */
  async getListeningPorts() {
    try {
      if (process.platform === 'win32') {
        return await this._scanWindowsPorts();
      } else {
        return await this._scanUnixPorts();
      }
    } catch (err) {
      console.error('[PortManager] Scan error:', err);
      return [];
    }
  }

  /**
   * Windows implementation using netstat and tasklist / Get-Process
   */
  async _scanWindowsPorts() {
    // 1. Get netstat listening ports
    const { stdout: netstatOut } = await execPromise('netstat -ano -p tcp');
    const lines = netstatOut.split(/\r?\n/);
    const portMap = new Map(); // key: port, val: { port, address, pid, proto: 'TCP' }

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('TCP') || !trimmed.includes('LISTENING')) continue;

      const parts = trimmed.split(/\s+/);
      // Format: TCP  [Local Address]  [Foreign Address]  LISTENING  [PID]
      if (parts.length >= 5) {
        const localAddr = parts[1];
        const state = parts[3];
        const pidStr = parts[4];
        if (state !== 'LISTENING') continue;

        const colonIdx = localAddr.lastIndexOf(':');
        if (colonIdx === -1) continue;

        const port = parseInt(localAddr.slice(colonIdx + 1), 10);
        const pid = parseInt(pidStr, 10);

        if (!isNaN(port) && !isNaN(pid) && port > 0) {
          if (!portMap.has(port)) {
            portMap.set(port, {
              port,
              address: localAddr.slice(0, colonIdx) || '0.0.0.0',
              pid,
              protocol: 'TCP'
            });
          }
        }
      }
    }

    if (portMap.size === 0) return [];

    // 2. Resolve process names using tasklist
    const pids = [...new Set([...portMap.values()].map(item => item.pid))];
    const procNames = await this._resolveWindowsProcessNames(pids);

    // 3. Assemble and sort
    const result = [];
    for (const item of portMap.values()) {
      const pInfo = procNames.get(item.pid) || { processName: 'Unknown', path: '' };
      result.push({
        port: item.port,
        address: item.address,
        pid: item.pid,
        protocol: item.protocol,
        processName: pInfo.processName,
        processPath: pInfo.path,
        isSystem: item.pid === 0 || item.pid === 4 || pInfo.processName.toLowerCase() === 'system'
      });
    }

    result.sort((a, b) => a.port - b.port);
    return result;
  }

  async _resolveWindowsProcessNames(pids) {
    const map = new Map();
    try {
      const { stdout } = await execPromise('tasklist /FO CSV /NH');
      const lines = stdout.split(/\r?\n/);
      for (const line of lines) {
        if (!line.trim()) continue;
        // Format: "Image Name","PID","Session Name","Session#","Mem Usage"
        const cols = line.split('","').map(c => c.replace(/^"|"$/g, ''));
        if (cols.length >= 2) {
          const name = cols[0];
          const pid = parseInt(cols[1], 10);
          if (!isNaN(pid)) {
            map.set(pid, { processName: name, path: '' });
          }
        }
      }
    } catch (e) {
      console.warn('[PortManager] tasklist resolution error:', e.message);
    }
    return map;
  }

  async _scanUnixPorts() {
    try {
      const { stdout } = await execPromise('lsof -iTCP -sTCP:LISTEN -P -n');
      const lines = stdout.split(/\r?\n/);
      const result = [];
      for (let i = 1; i < lines.length; i++) {
        const parts = lines[i].trim().split(/\s+/);
        if (parts.length >= 9) {
          const command = parts[0];
          const pid = parseInt(parts[1], 10);
          const name = parts[8];
          const port = parseInt(name.split(':').pop(), 10);
          if (!isNaN(port) && !isNaN(pid)) {
            result.push({
              port,
              address: '0.0.0.0',
              pid,
              protocol: 'TCP',
              processName: command,
              processPath: '',
              isSystem: pid <= 1
            });
          }
        }
      }
      return result.sort((a, b) => a.port - b.port);
    } catch (e) {
      return [];
    }
  }

  /**
   * Terminate process holding a specific port
   */
  async killPort(port) {
    const portNum = parseInt(port, 10);
    if (isNaN(portNum) || portNum <= 0 || portNum > 65535) {
      return { success: false, error: 'Invalid port number' };
    }

    const currentList = await this.getListeningPorts();
    const entry = currentList.find(p => p.port === portNum);

    if (!entry) {
      return { success: false, error: `Port ${portNum} is not currently in use.` };
    }

    if (entry.isSystem || entry.pid <= 4) {
      return { success: false, error: `Cannot terminate PID ${entry.pid} (${entry.processName}) - System protected process.` };
    }

    return await this.killPid(entry.pid, entry.processName, portNum);
  }

  /**
   * Terminate a specific PID
   */
  async killPid(pid, processName = '', port = null) {
    const pidNum = parseInt(pid, 10);
    if (isNaN(pidNum) || pidNum <= 4) {
      return { success: false, error: 'Invalid or protected process ID' };
    }

    try {
      if (process.platform === 'win32') {
        await execPromise(`taskkill /F /T /PID ${pidNum}`);
      } else {
        await execPromise(`kill -9 ${pidNum}`);
      }

      // Small delay to verify
      await new Promise(r => setTimeout(r, 400));
      return {
        success: true,
        message: `Process "${processName || pidNum}" (PID ${pidNum})${port ? ` on port :${port}` : ''} was terminated successfully.`
      };
    } catch (err) {
      // If taskkill fails due to permissions, try elevated powershell
      if (process.platform === 'win32') {
        try {
          const psCmd = `powershell -NoProfile -ExecutionPolicy Bypass -Command "Start-Process powershell -Verb RunAs -Wait -ArgumentList '-NoProfile','-WindowStyle','Hidden','-Command','Stop-Process -Id ${pidNum} -Force'"` ;
          await execPromise(psCmd);
          return {
            success: true,
            message: `Elevated termination sent for process (PID ${pidNum}).`
          };
        } catch (elevatedErr) {
          return {
            success: false,
            error: `Failed to terminate process ${pidNum}: ${err.message || elevatedErr.message}`
          };
        }
      }
      return { success: false, error: err.message };
    }
  }
}

module.exports = PortManager;
