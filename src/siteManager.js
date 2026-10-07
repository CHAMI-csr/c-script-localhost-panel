/**
 * SiteManager - Manages site configurations with JSON persistence
 */
const fs = require('fs');
const path = require('path');

class SiteManager {
  constructor(sitesFile) {
    this.sitesFile = sitesFile;
    this.sites = this._load();
  }

  /** Load sites from disk */
  _load() {
    try {
      if (fs.existsSync(this.sitesFile)) {
        const data = JSON.parse(fs.readFileSync(this.sitesFile, 'utf8'));
        return Array.isArray(data) ? data : [];
      }
    } catch (e) {
      console.error('Failed to load sites:', e.message);
    }
    return [];
  }

  /** Save sites to disk */
  _save() {
    try {
      fs.writeFileSync(this.sitesFile, JSON.stringify(this.sites, null, 2));
    } catch (e) {
      console.error('Failed to save sites:', e.message);
    }
  }

  /** Generate a unique site ID */
  _generateId() {
    return `site_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }

  /** Get all sites */
  getSites() {
    return this.sites.map(site => ({ autoindex: site.autoindex !== false, ...site }));
  }

  /** Get a single site by ID */
  getSite(id) {
    const site = this.sites.find(s => s.id === id);
    if (!site) return null;
    return { autoindex: site.autoindex !== false, ...site };
  }

  /** Add a new site */
  addSite(siteData) {
    const site = {
      id: this._generateId(),
      name: siteData.name || path.basename(siteData.root) || 'My Site',
      root: siteData.root,
      // Persist the explicitly selected PHP router/entry file.
      entryFile: siteData.entryFile || null,
      autoindex: siteData.autoindex !== undefined ? !!siteData.autoindex : true,
      port: siteData.port ? parseInt(siteData.port) : null,
      php: siteData.php || null,
      description: siteData.description || '',
      createdAt: new Date().toISOString(),
      status: 'stopped'
    };

    this.sites.push(site);
    this._save();
    return { success: true, site };
  }

  /** Remove a site by ID */
  removeSite(id) {
    const index = this.sites.findIndex(s => s.id === id);
    if (index === -1) return { success: false, error: 'Site not found' };

    this.sites.splice(index, 1);
    this._save();
    return { success: true };
  }

  /** Update site properties */
  updateSite(id, updates) {
    const index = this.sites.findIndex(s => s.id === id);
    if (index === -1) return { success: false, error: 'Site not found' };

    this.sites[index] = { ...this.sites[index], ...updates };
    this._save();
    return { success: true, site: this.sites[index] };
  }

  /** Check if a site name already exists */
  nameExists(name, excludeId = null) {
    return this.sites.some(s => s.name === name && s.id !== excludeId);
  }

  /** Get count of sites */
  get count() {
    return this.sites.length;
  }
}

module.exports = SiteManager;
