'use strict';

/**
 * Pure helpers without any ioBroker dependency (unit-testable).
 */

/**
 * Extracts owner and repository from the value ioBroker stores in common.installedFrom
 * when an adapter was installed from GitHub. Returns null for npm or other sources.
 *
 * Supported shapes: "https://github.com/o/r/tarball/main", "git+https://github.com/o/r.git#tag",
 * "git+ssh://git@github.com/o/r.git", "github:o/r", "o/r".
 *
 * @param {unknown} installedFrom - value of common.installedFrom
 * @returns {{ owner: string, repo: string } | null} the repository or null
 */
function parseInstalledFrom(installedFrom) {
    if (typeof installedFrom !== 'string') {
        return null;
    }
    const value = installedFrom.trim();
    let match = value.match(/github\.com[/:]([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?(?:[/#?@].*)?$/i);
    if (!match) {
        match = value.match(/^(?:github:)?([A-Za-z0-9_-]+)\/([A-Za-z0-9_.-]+?)(?:#.*)?$/);
    }
    if (!match) {
        return null;
    }
    return { owner: match[1], repo: match[2] };
}

/**
 * Parses a user-entered repository ("owner/repo" or a GitHub URL).
 *
 * @param {unknown} input - text from the configuration
 * @returns {{ owner: string, repo: string } | null} the repository or null
 */
function parseRepoInput(input) {
    if (typeof input !== 'string') {
        return null;
    }
    return parseInstalledFrom(input);
}

/**
 * Derives the adapter name (without "ioBroker." prefix, lower case) from a repository name.
 *
 * @param {string} repo - repository name
 * @returns {string} adapter name
 */
function adapterNameFromRepo(repo) {
    return repo.replace(/^iobroker\./i, '').toLowerCase();
}

/**
 * Parses a GitHub releases.atom / tags.atom feed.
 *
 * @param {string} xml - feed body
 * @returns {{ tag: string, title: string, updated: string, url: string, notes: string }[]} entries, newest first
 */
function parseAtom(xml) {
    const entries = [];
    for (const block of xml.match(/<entry>[\s\S]*?<\/entry>/g) || []) {
        const href = (block.match(/<link[^>]*rel="alternate"[^>]*href="([^"]+)"/) || [])[1];
        const tagPart = href && href.split('/releases/tag/')[1];
        if (!tagPart) {
            continue;
        }
        let tag = tagPart;
        try {
            tag = decodeURIComponent(tagPart);
        } catch {
            // keep raw value
        }
        const content = (block.match(/<content[^>]*>([\s\S]*?)<\/content>/) || [])[1] || '';
        entries.push({
            tag,
            title: decodeEntities((block.match(/<title>([\s\S]*?)<\/title>/) || [])[1] || tag).trim(),
            updated: (block.match(/<updated>([^<]+)<\/updated>/) || [])[1] || '',
            url: href,
            notes: htmlToText(content),
        });
    }
    return entries;
}

/**
 * @param {string} text - text with HTML entities
 * @returns {string} decoded text
 */
function decodeEntities(text) {
    return text
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;|&#x27;/g, "'")
        .replace(/&amp;/g, '&');
}

/**
 * Converts the entity-encoded HTML of a feed entry to short plain text.
 *
 * @param {string} encoded - entity-encoded HTML
 * @param {number} [maxLength] - maximum length of the result
 * @returns {string} plain text
 */
function htmlToText(encoded, maxLength = 1000) {
    const text = decodeEntities(
        decodeEntities(encoded)
            .replace(/<(br|\/p|\/li|\/h\d)\s*\/?>/gi, '\n')
            .replace(/<li[^>]*>/gi, '- ')
            .replace(/<[^>]+>/g, ''),
    )
        .replace(/[ \t]+/g, ' ')
        .replace(/\n\s*\n+/g, '\n')
        .trim();
    return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}

/**
 * Splits a tag or version like "v1.2.3-beta.1" into its numeric parts and prerelease flag.
 *
 * @param {string} value - tag or version
 * @returns {{ nums: number[], pre: string } | null} parsed version or null if not version-like
 */
function parseVersion(value) {
    const match = String(value)
        .trim()
        .match(/^[vV]?(\d+)\.(\d+)\.(\d+)(?:[-+]([0-9A-Za-z.-]+))?/);
    if (!match) {
        return null;
    }
    return { nums: [Number(match[1]), Number(match[2]), Number(match[3])], pre: match[4] || '' };
}

/**
 * Compares two versions. Prereleases sort below the same release version.
 *
 * @param {string} a - first version
 * @param {string} b - second version
 * @returns {number} negative, 0 or positive; NaN if one of them is not version-like
 */
function compareVersions(a, b) {
    const va = parseVersion(a);
    const vb = parseVersion(b);
    if (!va || !vb) {
        return NaN;
    }
    for (let i = 0; i < 3; i++) {
        if (va.nums[i] !== vb.nums[i]) {
            return va.nums[i] - vb.nums[i];
        }
    }
    if (va.pre === vb.pre) {
        return 0;
    }
    if (!va.pre) {
        return 1;
    }
    if (!vb.pre) {
        return -1;
    }
    return va.pre < vb.pre ? -1 : 1;
}

/**
 * Picks the newest version-like entry of a feed.
 *
 * @param {{ tag: string }[]} entries - parsed feed entries
 * @param {boolean} includePrereleases - whether prerelease tags are acceptable
 * @returns {object | null} the entry or null
 */
function pickLatest(entries, includePrereleases) {
    let best = null;
    for (const entry of entries) {
        const parsed = parseVersion(entry.tag);
        if (!parsed || (parsed.pre && !includePrereleases)) {
            continue;
        }
        if (!best || compareVersions(entry.tag, best.tag) > 0) {
            best = entry;
        }
    }
    return best;
}

/**
 * Keeps a poll interval inside its allowed range.
 *
 * @param {unknown} minutes - configured value
 * @returns {number} minutes between 60 and 1440
 */
function clampInterval(minutes) {
    const value = Number(minutes);
    return Math.min(1440, Math.max(60, Number.isFinite(value) ? Math.round(value) : 360));
}

module.exports = {
    parseInstalledFrom,
    parseRepoInput,
    adapterNameFromRepo,
    parseAtom,
    htmlToText,
    compareVersions,
    pickLatest,
    clampInterval,
};
