'use strict';

/*
 * ioBroker.release-check
 * Reports new GitHub releases for adapters that were installed from GitHub.
 * Uses the public web endpoints (releases.atom with ETag) and never the GitHub REST API.
 */

const utils = require('@iobroker/adapter-core');
const {
    parseInstalledFrom,
    parseRepoInput,
    adapterNameFromRepo,
    parseAtom,
    compareVersions,
    pickLatest,
    clampInterval,
} = require('./lib/github');
const { labels } = require('./lib/labels');

const REQUEST_TIMEOUT_MS = 15000;
const PAUSE_BETWEEN_REQUESTS_MS = 1000;
const OBJECT_CHANGE_DEBOUNCE_MS = 5000;

class ReleaseCheck extends utils.Adapter {
    /**
     * @param {Partial<utils.AdapterOptions>} [options] - Adapter options
     */
    constructor(options) {
        super({
            ...options,
            name: 'release-check',
        });
        this.on('ready', this.onReady.bind(this));
        this.on('objectChange', this.onObjectChange.bind(this));
        this.on('unload', this.onUnload.bind(this));

        this.unloaded = false;
        this.running = false;
        this.rerun = false;
        this.pollTimer = undefined;
        this.debounceTimer = undefined;
        this.feedCache = new Map();
        this.results = new Map();
        this.notified = new Map();
        this.createdIds = new Set();
    }

    /**
     * Is called when databases are connected and adapter received configuration.
     */
    async onReady() {
        await this.setState('info.connection', false, true);
        await this.extendObject('adapters', {
            type: 'folder',
            common: { name: labels.adapters },
            native: {},
        });
        await this.extendObject('summary', {
            type: 'channel',
            common: { name: labels.summary },
            native: {},
        });
        await this.ensureState('summary.updatesCount', labels.updatesCount, 'number', 'value');
        await this.ensureState('summary.updateList', labels.updateList, 'string', 'json');

        await this.subscribeForeignObjectsAsync('system.adapter.*');
        await this.refresh(true);
    }

    /**
     * Schedules the next network poll (self-chaining, never overlapping).
     */
    schedulePoll() {
        if (this.unloaded) {
            return;
        }
        const minutes = clampInterval(this.config.intervalMinutes);
        this.pollTimer = this.setTimeout(
            async () => {
                await this.refresh(true);
            },
            minutes * 60 * 1000,
        );
    }

    /**
     * Re-evaluates when an adapter object changes (e.g. installed from GitHub, updated or removed).
     *
     * @param {string} id - object id
     */
    onObjectChange(id) {
        if (this.unloaded || !/^system\.adapter\.[^.]+$/.test(id)) {
            return;
        }
        this.clearTimeout(this.debounceTimer);
        this.debounceTimer = this.setTimeout(() => {
            this.refresh(false).catch(err => this.log.warn(`Refresh failed: ${err.message}`));
        }, OBJECT_CHANGE_DEBOUNCE_MS);
    }

    /**
     * Fetches missing (or, on a poll, all) feeds and writes the states.
     *
     * @param {boolean} poll - true for the scheduled poll that asks GitHub about every repository
     */
    async refresh(poll) {
        if (this.running) {
            this.rerun = true;
            return;
        }
        this.running = true;
        try {
            const targets = await this.collectTargets();
            if (poll) {
                this.log.debug(`Checking ${targets.size} repositories`);
            }
            let attempted = 0;
            let failed = 0;
            for (const target of targets.values()) {
                if (this.unloaded) {
                    return;
                }
                if (!poll && this.results.has(target.key)) {
                    continue;
                }
                if (attempted > 0) {
                    await this.delay(PAUSE_BETWEEN_REQUESTS_MS);
                }
                attempted++;
                const ok = await this.fetchLatest(target);
                if (!ok) {
                    failed++;
                }
            }
            if (this.unloaded) {
                return;
            }
            await this.evaluate(targets);
            if (attempted > 0) {
                await this.setState('info.connection', failed < attempted, true);
            } else if (poll) {
                await this.setState('info.connection', true, true);
            }
        } catch (err) {
            this.log.warn(`Check failed: ${err.message}`);
            await this.setState('info.connection', false, true);
        } finally {
            this.running = false;
            if (this.rerun && !this.unloaded) {
                this.rerun = false;
                this.refresh(false).catch(err => this.log.warn(`Refresh failed: ${err.message}`));
            }
            if (poll) {
                this.schedulePoll();
            }
        }
    }

    /**
     * Builds the list of repositories to watch: adapters installed from GitHub plus manual entries.
     *
     * @returns {Promise<Map<string, { key: string, owner: string, repo: string, adapterName: string, installed: string }>>} targets by adapter name
     */
    async collectTargets() {
        const targets = new Map();
        const view = await this.getObjectViewAsync('system', 'adapter', {
            startkey: 'system.adapter.',
            endkey: 'system.adapter.香',
        });
        const installedVersions = new Map();
        for (const row of view.rows) {
            const common = row.value && row.value.common;
            if (!common || !common.name) {
                continue;
            }
            installedVersions.set(common.name, common.version || '');
            if (this.config.autoDetect === false) {
                continue;
            }
            const parsed = parseInstalledFrom(common.installedFrom);
            if (parsed && !targets.has(common.name)) {
                targets.set(common.name, this.makeTarget(parsed, common.name, common.version || ''));
            }
        }
        const extraRepos = this.config.extraRepos || [];
        for (const entry of extraRepos) {
            if (!entry || entry.enabled === false) {
                continue;
            }
            const parsed = parseRepoInput(entry.repo);
            if (!parsed) {
                if (entry.repo) {
                    this.log.warn(`Ignoring invalid repository "${entry.repo}", use the form owner/repo`);
                }
                continue;
            }
            const name = adapterNameFromRepo(parsed.repo);
            if (!targets.has(name)) {
                targets.set(name, this.makeTarget(parsed, name, installedVersions.get(name) || ''));
            }
        }
        return targets;
    }

    /**
     * @param {{ owner: string, repo: string }} parsed - repository
     * @param {string} adapterName - adapter name
     * @param {string} installed - installed version
     * @returns {{ key: string, owner: string, repo: string, adapterName: string, installed: string }} target
     */
    makeTarget(parsed, adapterName, installed) {
        return {
            key: `${parsed.owner}/${parsed.repo}`.toLowerCase(),
            owner: parsed.owner,
            repo: parsed.repo,
            adapterName,
            installed,
        };
    }

    /**
     * Downloads one Atom feed, honouring the cached ETag.
     *
     * @param {string} url - feed URL
     * @returns {Promise<object[] | null>} entries, or null if the repository does not exist or is private
     */
    async fetchFeed(url) {
        const headers = {
            'User-Agent': `ioBroker.release-check/${this.version || '0'}`,
            Accept: 'application/atom+xml',
        };
        const cached = this.feedCache.get(url);
        if (cached && cached.etag) {
            headers['If-None-Match'] = cached.etag;
        }
        const res = await fetch(url, { headers, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
        if (res.status === 304 && cached) {
            return cached.entries;
        }
        if (res.status === 404) {
            return null;
        }
        if (!res.ok) {
            throw new Error(`HTTP ${res.status}`);
        }
        const entries = parseAtom(await res.text());
        this.feedCache.set(url, { etag: res.headers.get('etag'), entries });
        return entries;
    }

    /**
     * Determines the latest version of a repository (releases first, tags as fallback).
     *
     * @param {{ key: string, owner: string, repo: string }} target - repository
     * @returns {Promise<boolean>} true if GitHub could be queried
     */
    async fetchLatest(target) {
        const base = `https://github.com/${target.owner}/${target.repo}`;
        const includePre = !!this.config.includePrereleases;
        try {
            let entries = await this.fetchFeed(`${base}/releases.atom`);
            if (entries === null) {
                this.log.warn(
                    `Repository ${target.owner}/${target.repo} was not found or is private. Only public repositories are supported.`,
                );
                this.results.set(target.key, { latest: null, error: 'not found', checked: Date.now() });
                return true;
            }
            let latest = pickLatest(entries, includePre);
            if (!latest) {
                entries = (await this.fetchFeed(`${base}/tags.atom`)) || [];
                latest = pickLatest(entries, includePre);
            }
            if (!latest) {
                this.log.debug(`No version-like release or tag found for ${target.owner}/${target.repo}`);
            }
            this.results.set(target.key, { latest, error: '', checked: Date.now() });
            return true;
        } catch (err) {
            this.log.warn(
                `Could not check ${target.owner}/${target.repo}: ${err.message}. Will retry at the next interval.`,
            );
            const previous = this.results.get(target.key);
            this.results.set(target.key, {
                latest: previous ? previous.latest : null,
                error: err.message,
                checked: previous ? previous.checked : 0,
            });
            return false;
        }
    }

    /**
     * Creates a state with a multilingual name, the object is only written once.
     *
     * @param {string} id - state id
     * @param {ioBroker.StringOrTranslated} name - name in all languages
     * @param {'string' | 'number' | 'boolean'} type - value type
     * @param {string} role - state role
     */
    async ensureState(id, name, type, role) {
        if (this.createdIds.has(id)) {
            return;
        }
        this.createdIds.add(id);
        await this.extendObject(id, {
            type: 'state',
            common: { name, type, role, read: true, write: false },
            native: {},
        });
    }

    /**
     * Writes the states for every target and removes channels of adapters that are no longer watched.
     *
     * @param {Map<string, { key: string, owner: string, repo: string, adapterName: string, installed: string }>} targets - watched repositories
     */
    async evaluate(targets) {
        const updates = [];
        for (const target of targets.values()) {
            const result = this.results.get(target.key);
            if (!result) {
                continue;
            }
            const id = `adapters.${target.adapterName.replace(/[^a-zA-Z0-9_-]/g, '_')}`;
            const latest = result.latest;
            const available = !!latest && !!target.installed && compareVersions(latest.tag, target.installed) > 0;
            const repoUrl = `https://github.com/${target.owner}/${target.repo}`;

            await this.extendObject(id, { type: 'channel', common: { name: target.adapterName }, native: {} });
            const states = [
                ['repository', labels.repository, 'string', 'text.url', repoUrl],
                ['installedVersion', labels.installedVersion, 'string', 'text', target.installed],
                ['latestVersion', labels.latestVersion, 'string', 'text', latest ? latest.tag.replace(/^v/i, '') : ''],
                ['updateAvailable', labels.updateAvailable, 'boolean', 'indicator.maintenance', available],
                ['releaseNotes', labels.releaseNotes, 'string', 'text', latest ? latest.notes : ''],
                ['releaseUrl', labels.releaseUrl, 'string', 'text.url', latest ? latest.url : ''],
                [
                    'readmeUrl',
                    labels.readmeUrl,
                    'string',
                    'text.url',
                    latest ? `${repoUrl}/blob/${encodeURIComponent(latest.tag)}/README.md` : `${repoUrl}#readme`,
                ],
                ['lastCheck', labels.lastCheck, 'number', 'value.time', result.checked],
            ];
            for (const [name, label, type, role, value] of states) {
                await this.ensureState(`${id}.${name}`, label, type, role);
                await this.setStateChanged(`${id}.${name}`, { val: value, ack: true });
            }

            if (available) {
                updates.push({
                    adapter: target.adapterName,
                    installed: target.installed,
                    latest: latest.tag.replace(/^v/i, ''),
                    releaseUrl: latest.url,
                    readmeUrl: `${repoUrl}/blob/${encodeURIComponent(latest.tag)}/README.md`,
                });
                if (this.notified.get(target.key) !== latest.tag) {
                    this.notified.set(target.key, latest.tag);
                    this.log.info(
                        `Update available for ${target.adapterName}: ${target.installed} -> ${latest.tag.replace(/^v/i, '')} (${latest.url})`,
                    );
                }
            }
        }

        await this.setStateChanged('summary.updatesCount', { val: updates.length, ack: true });
        await this.setStateChanged('summary.updateList', { val: JSON.stringify(updates), ack: true });

        const wanted = new Set([...targets.values()].map(t => t.adapterName.replace(/[^a-zA-Z0-9_-]/g, '_')));
        const existing = await this.getObjectViewAsync('system', 'channel', {
            startkey: `${this.namespace}.adapters.`,
            endkey: `${this.namespace}.adapters.香`,
        });
        for (const row of existing.rows) {
            const name = row.id.slice(`${this.namespace}.adapters.`.length);
            if (!name.includes('.') && !wanted.has(name)) {
                await this.delObjectAsync(`adapters.${name}`, { recursive: true });
            }
        }
    }

    /**
     * Is called when adapter shuts down - callback has to be called under any circumstances!
     *
     * @param {() => void} callback - Callback function
     */
    onUnload(callback) {
        try {
            this.unloaded = true;
            this.clearTimeout(this.pollTimer);
            this.clearTimeout(this.debounceTimer);
            callback();
        } catch (error) {
            this.log.error(`Error during unloading: ${error.message}`);
            callback();
        }
    }
}

if (require.main !== module) {
    // Export the constructor in compact mode
    /**
     * @param {Partial<utils.AdapterOptions>} [options] - Adapter options
     */
    module.exports = options => new ReleaseCheck(options);
} else {
    // otherwise start the instance directly
    new ReleaseCheck();
}
